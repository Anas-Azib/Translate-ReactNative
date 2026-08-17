import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../lib/config.js';
import type { Clock } from '../lib/clock.js';
import { systemClock } from '../lib/clock.js';
import { PipelineError } from '../lib/errors.js';
import type { SessionEndReason, SessionQuotaSnapshot, UsageTotals } from '../types/index.js';
import { UsageStore } from './store.js';

export type QuotaRejectReason =
  | 'session_limit'
  | 'daily_limit'
  | 'monthly_limit'
  | 'global_daily_limit'
  | 'global_translate_char_limit'
  | 'global_tts_char_limit'
  | 'concurrent_user_limit'
  | 'concurrent_global_limit'
  | 'text_too_long'
  | 'audio_too_large'
  | 'session_ended'
  | 'unknown_session';

export interface QuotaDecision {
  allowed: boolean;
  reason?: QuotaRejectReason;
  message?: string;
  /** Seconds of audio this call may still consume. */
  remainingSessionSeconds?: number;
  remainingDailySeconds?: number;
}

export interface Session {
  id: string;
  userId: string;
  startedAt: number;
  lastActivityAt: number;
  secondsUsed: number;
  segments: number;
  ended: boolean;
  endedReason?: SessionEndReason;
}

const REJECT_MESSAGES: Record<QuotaRejectReason, string> = {
  session_limit: 'This session reached its time limit. Tap start to begin a new one.',
  daily_limit: "You've used all of today's translation time. It resets tomorrow.",
  monthly_limit: "You've used all of this month's translation time.",
  global_daily_limit: 'The app is at its daily capacity. Please try again later.',
  global_translate_char_limit: 'Service limit was reached. Please try again later.',
  global_tts_char_limit: 'Service limit was reached. Please try again later.',
  concurrent_user_limit: 'You already have a translation session running on another device.',
  concurrent_global_limit: 'The app is busy right now. Please try again in a minute.',
  text_too_long: 'That was too long to translate at once. Try shorter sentences.',
  audio_too_large: 'That recording was too large. Try a shorter recording.',
  session_ended: 'This session has ended. Tap start to begin a new one.',
  unknown_session: 'This session is no longer active. Tap start to begin a new one.',
};

/**
 * Enforces every limit in the plan document's "Cost constraints" and "Design"
 * sections (p.4–5):
 *
 *            Usage Control
 *   ┌─────────────┼─────────────┐
 *   Daily limit  Session limit  Global limit
 *   └─────────────┼─────────────┘
 *             ALLOWED?
 *
 * Requests are authorised *before* any upstream call, so a rejection costs
 * nothing at Azure or Google.
 */
export class QuotaManager {
  readonly #config: AppConfig['quota'];
  readonly #clock: Clock;
  readonly #store: UsageStore;
  readonly #sessions = new Map<string, Session>();

  constructor(options: { quota: AppConfig['quota']; clock?: Clock; store?: UsageStore }) {
    this.#config = options.quota;
    this.#clock = options.clock ?? systemClock;
    this.#store = options.store ?? new UsageStore();
  }

  get store(): UsageStore {
    return this.#store;
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  /**
   * Opens a session, or refuses if any ceiling is already reached. The user must
   * call this explicitly after a limit stop — sessions never auto-renew.
   */
  startSession(userId: string): { session: Session; snapshot: SessionQuotaSnapshot } {
    const now = this.#clock.now();
    this.reapIdle(now);

    const daily = this.#store.get(UsageStore.userDay(userId, now));
    if (daily.audioSeconds >= this.#config.dailySeconds) {
      throw this.#reject('daily_limit');
    }
    const monthly = this.#store.get(UsageStore.userMonth(userId, now));
    if (monthly.audioSeconds >= this.#config.monthlySeconds) {
      throw this.#reject('monthly_limit');
    }
    const globalDaily = this.#store.get(UsageStore.globalDay(now));
    if (globalDaily.audioSeconds >= this.#config.globalDailySeconds) {
      throw this.#reject('global_daily_limit');
    }
    if (this.activeSessionsFor(userId) >= this.#config.maxConcurrentPerUser) {
      throw this.#reject('concurrent_user_limit');
    }
    if (this.activeSessions() >= this.#config.maxConcurrentGlobal) {
      throw this.#reject('concurrent_global_limit');
    }

    const session: Session = {
      id: randomUUID(),
      userId,
      startedAt: now,
      lastActivityAt: now,
      secondsUsed: 0,
      segments: 0,
      ended: false,
    };
    this.#sessions.set(session.id, session);
    return { session, snapshot: this.snapshot(session.id) };
  }

  endSession(sessionId: string, reason: SessionEndReason = 'user_stopped'): Session | undefined {
    const session = this.#sessions.get(sessionId);
    if (!session || session.ended) return session;
    session.ended = true;
    session.endedReason = reason;
    session.lastActivityAt = this.#clock.now();
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId);
  }

  activeSessions(): number {
    return [...this.#sessions.values()].filter((s) => !s.ended).length;
  }

  activeSessionsFor(userId: string): number {
    return [...this.#sessions.values()].filter((s) => !s.ended && s.userId === userId).length;
  }

  /**
   * Closes sessions whose client went away. Without this a crashed tab would
   * hold a concurrency slot forever and lock the user out.
   */
  reapIdle(now = this.#clock.now()): number {
    const timeoutMs = this.#config.sessionIdleTimeoutSeconds * 1000;
    let reaped = 0;
    for (const session of this.#sessions.values()) {
      if (!session.ended && now - session.lastActivityAt > timeoutMs) {
        session.ended = true;
        session.endedReason = 'expired';
        reaped += 1;
      }
    }
    return reaped;
  }

  touch(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session) session.lastActivityAt = this.#clock.now();
  }

  // ── Authorisation ───────────────────────────────────────────────────────

  /**
   * Gate for an incoming audio segment. Checks the session, per-user daily and
   * monthly, global daily, and the per-request byte cap.
   */
  checkAudio(input: {
    sessionId: string;
    audioSeconds: number;
    audioBytes: number;
  }): QuotaDecision {
    const session = this.#sessions.get(input.sessionId);
    if (!session) return this.#deny('unknown_session');
    if (session.ended) return this.#deny('session_ended');

    if (input.audioBytes > this.#config.maxAudioBytes) return this.#deny('audio_too_large');

    const now = this.#clock.now();
    const remainingSession = this.#config.sessionSeconds - session.secondsUsed;
    if (remainingSession <= 0) return this.#deny('session_limit');

    const daily = this.#store.get(UsageStore.userDay(session.userId, now));
    const remainingDaily = this.#config.dailySeconds - daily.audioSeconds;
    if (remainingDaily <= 0) return this.#deny('daily_limit');

    const monthly = this.#store.get(UsageStore.userMonth(session.userId, now));
    if (this.#config.monthlySeconds - monthly.audioSeconds <= 0) return this.#deny('monthly_limit');

    const globalDaily = this.#store.get(UsageStore.globalDay(now));
    if (this.#config.globalDailySeconds - globalDaily.audioSeconds <= 0) {
      return this.#deny('global_daily_limit');
    }

    return {
      allowed: true,
      remainingSessionSeconds: remainingSession,
      remainingDailySeconds: remainingDaily,
    };
  }

  /**
   * Gate for a translation call. Enforces "Limit maximum text size per
   * translation request" and the app-wide monthly character ceiling that keeps
   * us inside Google's 500k free tier.
   *
   * `inFlight` marks a call that belongs to a segment whose audio was already
   * authorised and billed. Such a call is allowed to finish even if committing
   * that audio just ended the session — otherwise the last thing the user said
   * before the cutoff would be recognised, charged for, and then thrown away.
   * The character ceilings still apply; only the session-ended check is waived.
   */
  checkTranslation(input: { sessionId: string; text: string; inFlight?: boolean }): QuotaDecision {
    const session = this.#sessions.get(input.sessionId);
    if (!session) return this.#deny('unknown_session');
    if (session.ended && !input.inFlight) return this.#deny('session_ended');

    if (input.text.length > this.#config.maxCharsPerTranslation) return this.#deny('text_too_long');

    const globalMonth = this.#store.get(UsageStore.globalMonth(this.#clock.now()));
    if (globalMonth.translatedChars + input.text.length > this.#config.globalMonthlyTranslatedChars) {
      return this.#deny('global_translate_char_limit');
    }
    return { allowed: true };
  }

  /** Gate for a TTS call against the app-wide monthly character ceiling. */
  checkTts(input: { sessionId: string; text: string; inFlight?: boolean }): QuotaDecision {
    const session = this.#sessions.get(input.sessionId);
    if (!session) return this.#deny('unknown_session');
    if (session.ended && !input.inFlight) return this.#deny('session_ended');

    if (input.text.length > this.#config.maxCharsPerTranslation) return this.#deny('text_too_long');

    const globalMonth = this.#store.get(UsageStore.globalMonth(this.#clock.now()));
    if (globalMonth.ttsChars + input.text.length > this.#config.globalMonthlyTtsChars) {
      return this.#deny('global_tts_char_limit');
    }
    return { allowed: true };
  }

  /** Throwing variants for route handlers. */
  assertAudio(input: { sessionId: string; audioSeconds: number; audioBytes: number }): void {
    const decision = this.checkAudio(input);
    if (!decision.allowed) throw this.#reject(decision.reason!);
  }
  assertTranslation(input: { sessionId: string; text: string; inFlight?: boolean }): void {
    const decision = this.checkTranslation(input);
    if (!decision.allowed) throw this.#reject(decision.reason!);
  }
  assertTts(input: { sessionId: string; text: string; inFlight?: boolean }): void {
    const decision = this.checkTts(input);
    if (!decision.allowed) throw this.#reject(decision.reason!);
  }

  // ── Commit ──────────────────────────────────────────────────────────────

  /**
   * Records audio actually processed and auto-stops the session once it crosses
   * a ceiling ("Automatically stop translation after the configured session
   * limit", plan doc p.4).
   */
  commitAudio(sessionId: string, audioSeconds: number): SessionQuotaSnapshot {
    const session = this.#requireSession(sessionId);
    const now = this.#clock.now();
    const seconds = Math.max(0, audioSeconds);

    session.secondsUsed += seconds;
    session.segments += 1;
    session.lastActivityAt = now;

    const delta = { audioSeconds: seconds, sttRequests: 1 };
    this.#store.increment(UsageStore.userDay(session.userId, now), delta);
    this.#store.increment(UsageStore.userMonth(session.userId, now), delta);
    this.#store.increment(UsageStore.globalDay(now), delta);
    this.#store.increment(UsageStore.globalMonth(now), delta);

    const daily = this.#store.get(UsageStore.userDay(session.userId, now));
    const monthly = this.#store.get(UsageStore.userMonth(session.userId, now));

    if (session.secondsUsed >= this.#config.sessionSeconds) {
      this.endSession(sessionId, 'session_limit');
    } else if (daily.audioSeconds >= this.#config.dailySeconds) {
      this.endSession(sessionId, 'daily_limit');
    } else if (monthly.audioSeconds >= this.#config.monthlySeconds) {
      this.endSession(sessionId, 'monthly_limit');
    } else if (this.#store.get(UsageStore.globalDay(now)).audioSeconds >= this.#config.globalDailySeconds) {
      this.endSession(sessionId, 'global_limit');
    }

    return this.snapshot(sessionId);
  }

  commitTranslation(sessionId: string, billedChars: number): void {
    const session = this.#requireSession(sessionId);
    const now = this.#clock.now();
    const delta = { translatedChars: Math.max(0, billedChars), translateRequests: 1 };
    this.#store.increment(UsageStore.userDay(session.userId, now), delta);
    this.#store.increment(UsageStore.userMonth(session.userId, now), delta);
    this.#store.increment(UsageStore.globalDay(now), delta);
    this.#store.increment(UsageStore.globalMonth(now), delta);
  }

  commitTts(sessionId: string, billedChars: number): void {
    const session = this.#requireSession(sessionId);
    const now = this.#clock.now();
    const delta = { ttsChars: Math.max(0, billedChars), ttsRequests: 1 };
    this.#store.increment(UsageStore.userDay(session.userId, now), delta);
    this.#store.increment(UsageStore.userMonth(session.userId, now), delta);
    this.#store.increment(UsageStore.globalDay(now), delta);
    this.#store.increment(UsageStore.globalMonth(now), delta);
  }

  // ── Reporting ───────────────────────────────────────────────────────────

  snapshot(sessionId: string): SessionQuotaSnapshot {
    const session = this.#requireSession(sessionId);
    const now = this.#clock.now();
    const daily = this.#store.get(UsageStore.userDay(session.userId, now));
    const monthly = this.#store.get(UsageStore.userMonth(session.userId, now));
    return {
      sessionId: session.id,
      userId: session.userId,
      sessionSecondsUsed: round1(session.secondsUsed),
      sessionSecondsLimit: this.#config.sessionSeconds,
      dailySecondsUsed: round1(daily.audioSeconds),
      dailySecondsLimit: this.#config.dailySeconds,
      monthlySecondsUsed: round1(monthly.audioSeconds),
      monthlySecondsLimit: this.#config.monthlySeconds,
      sessionEnded: session.ended,
      ...(session.endedReason ? { endedReason: session.endedReason } : {}),
    };
  }

  /** Read-only view used by the client to render the quota ring before starting. */
  userUsage(userId: string): { daily: UsageTotals; monthly: UsageTotals; limits: AppConfig['quota'] } {
    const now = this.#clock.now();
    return {
      daily: this.#store.get(UsageStore.userDay(userId, now)),
      monthly: this.#store.get(UsageStore.userMonth(userId, now)),
      limits: this.#config,
    };
  }

  globalUsage(): { daily: UsageTotals; monthly: UsageTotals; activeSessions: number } {
    const now = this.#clock.now();
    return {
      daily: this.#store.get(UsageStore.globalDay(now)),
      monthly: this.#store.get(UsageStore.globalMonth(now)),
      activeSessions: this.activeSessions(),
    };
  }

  reset(): void {
    this.#sessions.clear();
    this.#store.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  #requireSession(sessionId: string): Session {
    const session = this.#sessions.get(sessionId);
    if (!session) throw this.#reject('unknown_session');
    return session;
  }

  #deny(reason: QuotaRejectReason): QuotaDecision {
    return { allowed: false, reason, message: REJECT_MESSAGES[reason] };
  }

  #reject(reason: QuotaRejectReason): PipelineError {
    return new PipelineError('internal_quota_exceeded', 'backend', reason);
  }
}

export function quotaMessage(reason: QuotaRejectReason): string {
  return REJECT_MESSAGES[reason];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
