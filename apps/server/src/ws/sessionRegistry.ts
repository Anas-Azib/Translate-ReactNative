import { randomUUID } from 'node:crypto';
import type { SessionState } from '@translate/shared';
import { applyEvent } from '@translate/shared';
import type { Clock } from '../lib/clock.js';
import { systemClock } from '../lib/clock.js';
import type { QuotaManager } from '../usage/quotaManager.js';

/**
 * Tracks which connection owns which session.
 *
 * ── The bug this exists to fix ──────────────────────────────────────────────
 *
 * Previously a session was a row in the QuotaManager and nothing more. The only
 * thing that ever removed it was a 120-second idle reaper polled every 30 s, so
 * any client that vanished without calling `/stop` — a closed tab, a refresh, a
 * crash, a dropped network, or simply an error thrown on the stop path — left a
 * record behind. `startSession` then saw `activeSessionsFor(user) >= 1` and
 * refused with "You already have a translation session running on another
 * device", locking the user out for up to two and a half minutes.
 *
 * Two changes make that impossible now:
 *
 *  1. **The connection is the session's lifetime.** A session is owned by one
 *     socket. When that socket closes — cleanly, abruptly, or by heartbeat
 *     timeout — the session is released immediately. There is no window in
 *     which a dead client holds a live slot.
 *
 *  2. **Ownership transfers instead of blocking.** If the same device opens a
 *     new connection and asks to start, the older session is *superseded*: the
 *     previous owner is told why and closed, and the slot is handed over. The
 *     concurrency limit still applies across different users, which is what it
 *     was actually for — it was never meant to stop a user restarting their own
 *     microphone.
 */

export interface OwnedSession {
  sessionId: string;
  userId: string;
  connectionId: string;
  state: SessionState;
  startedAt: number;
  sourceLang: string;
  targetLang: string;
  /** Last transcript we translated, for server-side de-duplication. */
  previousText?: string;
}

export interface SupersedeResult {
  supersededConnectionIds: string[];
  releasedSessionIds: string[];
}

export class SessionRegistry {
  readonly #quota: QuotaManager;
  readonly #clock: Clock;

  /** connectionId → session. One connection owns at most one session. */
  readonly #byConnection = new Map<string, OwnedSession>();
  /** userId → connectionId, so a takeover can find the previous owner in O(1). */
  readonly #ownerByUser = new Map<string, string>();

  constructor(options: { quota: QuotaManager; clock?: Clock }) {
    this.#quota = options.quota;
    this.#clock = options.clock ?? systemClock;
  }

  get size(): number {
    return this.#byConnection.size;
  }

  get(connectionId: string): OwnedSession | undefined {
    return this.#byConnection.get(connectionId);
  }

  ownerOf(userId: string): string | undefined {
    return this.#ownerByUser.get(userId);
  }

  /**
   * Releases any session this user currently owns so a new one can start.
   *
   * Called before every start. This is the single line that makes a stale
   * session unable to block a new one.
   */
  supersede(userId: string, exceptConnectionId?: string): SupersedeResult {
    const result: SupersedeResult = { supersededConnectionIds: [], releasedSessionIds: [] };
    const ownerId = this.#ownerByUser.get(userId);
    if (!ownerId || ownerId === exceptConnectionId) return result;

    const existing = this.#byConnection.get(ownerId);
    if (existing) {
      this.#quota.endSession(existing.sessionId, 'user_stopped');
      this.#byConnection.delete(ownerId);
      result.supersededConnectionIds.push(ownerId);
      result.releasedSessionIds.push(existing.sessionId);
    }
    this.#ownerByUser.delete(userId);
    return result;
  }

  /**
   * Opens a session for a connection.
   *
   * Any prior session for this user is superseded first, so the only failures
   * left are the ones that genuinely should fail: the user's own daily and
   * monthly budgets, and the app-wide concurrency and capacity ceilings.
   */
  start(input: {
    connectionId: string;
    userId: string;
    sourceLang: string;
    targetLang: string;
  }): { session: OwnedSession; superseded: SupersedeResult } {
    // Re-entrancy guard: a duplicate start on the same connection returns the
    // session it already owns rather than opening a second one.
    const existing = this.#byConnection.get(input.connectionId);
    if (existing) {
      return { session: existing, superseded: { supersededConnectionIds: [], releasedSessionIds: [] } };
    }

    const superseded = this.supersede(input.userId, input.connectionId);
    const { session } = this.#quota.startSession(input.userId);

    const owned: OwnedSession = {
      sessionId: session.id,
      userId: input.userId,
      connectionId: input.connectionId,
      state: 'active',
      startedAt: this.#clock.now(),
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
    };

    this.#byConnection.set(input.connectionId, owned);
    this.#ownerByUser.set(input.userId, input.connectionId);

    return { session: owned, superseded };
  }

  /** Advances a session through the shared state machine. */
  transition(connectionId: string, event: Parameters<typeof applyEvent>[1]): OwnedSession | undefined {
    const session = this.#byConnection.get(connectionId);
    if (!session) return undefined;
    session.state = applyEvent(session.state, event);
    this.#quota.touch(session.sessionId);
    return session;
  }

  setLanguages(connectionId: string, sourceLang: string, targetLang: string): void {
    const session = this.#byConnection.get(connectionId);
    if (!session) return;
    session.sourceLang = sourceLang;
    session.targetLang = targetLang;
    // Changing language starts a new train of thought, so the de-duplication
    // baseline must not carry over from the old pair.
    delete session.previousText;
  }

  setPreviousText(connectionId: string, text: string): void {
    const session = this.#byConnection.get(connectionId);
    if (session) session.previousText = text;
  }

  /**
   * Ends the session a connection owns. Idempotent, and safe to call from a
   * close handler that may fire after an explicit stop.
   */
  release(connectionId: string, reason: 'user_stopped' | 'expired' | 'session_limit'): OwnedSession | undefined {
    const session = this.#byConnection.get(connectionId);
    if (!session) return undefined;

    this.#quota.endSession(session.sessionId, reason);
    this.#byConnection.delete(connectionId);
    // Only clear ownership if this connection still holds it: a newer
    // connection may already have taken over, and it must keep the slot.
    if (this.#ownerByUser.get(session.userId) === connectionId) {
      this.#ownerByUser.delete(session.userId);
    }
    return session;
  }

  /** Every open session — used by graceful shutdown. */
  all(): OwnedSession[] {
    return [...this.#byConnection.values()];
  }

  releaseAll(reason: 'user_stopped' | 'expired' = 'expired'): number {
    let count = 0;
    for (const connectionId of [...this.#byConnection.keys()]) {
      if (this.release(connectionId, reason)) count += 1;
    }
    return count;
  }

  static newConnectionId(): string {
    return randomUUID();
  }
}
