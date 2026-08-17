import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type {
  ClientMessage,
  ClientSegmentHeader,
  ServerMessage,
  SessionChangeReason,
  SessionState,
} from '@translate/shared';
import {
  CLOSE_CODES,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  parseMessage,
} from '@translate/shared';
import type { AppConfig } from '../lib/config.js';
import { PipelineError } from '../lib/errors.js';
import { isSupported } from '../lib/languages.js';
import type { TranslationPipeline } from '../services/pipeline.js';
import type { QuotaManager } from '../usage/quotaManager.js';
import type { SessionRegistry } from './sessionRegistry.js';
import { stableHash } from '../lib/crypto.js';

export interface ConnectionDeps {
  socket: WebSocket;
  registry: SessionRegistry;
  pipeline: TranslationPipeline;
  quota: QuotaManager;
  config: AppConfig;
  /** Notifies the hub so it can close a superseded peer. */
  onSupersede: (connectionIds: string[]) => void;
  /** Lets the hub drop its reference when this connection dies. */
  onClosed: (connectionId: string) => void;
}

/**
 * One client connection.
 *
 * Everything is scoped to this object: the session, the pending audio header,
 * the heartbeat timer. When `dispose()` runs, all of it goes — which is what
 * guarantees a disconnect cannot leave anything behind.
 */
export class Connection {
  readonly id = randomUUID();

  readonly #socket: WebSocket;
  readonly #deps: ConnectionDeps;

  #userId: string | null = null;
  /** Header of the segment whose binary frame we are waiting for. */
  #pendingSegment: ClientSegmentHeader | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #lastPongAt = Date.now();
  #disposed = false;
  /** Serialises segment processing so two uploads cannot interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ConnectionDeps) {
    this.#deps = deps;
    this.#socket = deps.socket;

    this.#socket.on('message', this.#onMessage);
    this.#socket.on('close', this.#onClose);
    this.#socket.on('error', this.#onError);
    this.#socket.on('pong', this.#onPong);

    this.#startHeartbeat();
    this.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION, connectionId: this.id });
  }

  get userId(): string | null {
    return this.#userId;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  send(message: ServerMessage): void {
    // OPEN === 1. Writing to a closing socket throws; silence is correct here.
    if (this.#disposed || this.#socket.readyState !== 1) return;
    try {
      this.#socket.send(JSON.stringify(message));
    } catch {
      // The socket died between the check and the write. The close handler
      // will clean up.
    }
  }

  /** Closes this connection because a newer one took the session. */
  supersede(sessionId: string): void {
    this.send({ type: 'session.superseded', sessionId });
    this.close(CLOSE_CODES.SUPERSEDED, 'superseded by a newer connection');
  }

  close(code: number, reason: string): void {
    try {
      this.#socket.close(code, reason);
    } catch {
      // Already gone.
    }
    // Do not wait for the close event: release the session now so the slot is
    // free the instant we decide the connection is over.
    this.dispose();
  }

  /**
   * Tears everything down. Idempotent, because it is reachable from an explicit
   * close, the socket's own close event, an error, and shutdown.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.#pendingSegment = null;

    // The session dies with the connection. This is the whole fix.
    this.#deps.registry.release(this.id, 'user_stopped');

    this.#socket.off('message', this.#onMessage);
    this.#socket.off('close', this.#onClose);
    this.#socket.off('error', this.#onError);
    this.#socket.off('pong', this.#onPong);

    this.#deps.onClosed(this.id);
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────

  /**
   * A TCP connection can die without either side being told — a phone losing
   * signal, a NAT timeout, a laptop lid closing. The socket stays "open"
   * forever from our side. Ping/pong is the only way to notice, and without it
   * a half-open connection would hold a session slot indefinitely, which is the
   * original bug wearing a different hat.
   */
  #startHeartbeat(): void {
    this.#lastPongAt = Date.now();
    this.#heartbeat = setInterval(() => {
      if (this.#disposed) return;

      if (Date.now() - this.#lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        this.close(CLOSE_CODES.HEARTBEAT_TIMEOUT, 'heartbeat timeout');
        return;
      }

      try {
        this.#socket.ping();
        this.send({ type: 'ping', at: Date.now() });
      } catch {
        this.close(CLOSE_CODES.HEARTBEAT_TIMEOUT, 'ping failed');
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Never hold the process open for a heartbeat.
    this.#heartbeat.unref?.();
  }

  #onPong = (): void => {
    this.#lastPongAt = Date.now();
  };

  // ── Socket events ───────────────────────────────────────────────────────

  #onClose = (): void => {
    this.dispose();
  };

  #onError = (): void => {
    this.dispose();
  };

  #onMessage = (data: unknown, isBinary: boolean): void => {
    if (this.#disposed) return;

    if (isBinary) {
      this.#handleBinary(toBuffer(data));
      return;
    }

    const message = parseMessage<ClientMessage>(String(data));
    if (!message) return;

    // Every control frame counts as liveness, not just pongs — a client that is
    // actively uploading is obviously alive.
    this.#lastPongAt = Date.now();
    this.#handleControl(message);
  };

  // ── Control frames ──────────────────────────────────────────────────────

  #handleControl(message: ClientMessage): void {
    switch (message.type) {
      case 'hello': {
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          this.close(CLOSE_CODES.PROTOCOL_MISMATCH, 'unsupported protocol version');
          return;
        }
        // The raw device id is hashed and never stored, matching the HTTP
        // identity middleware.
        this.#userId = stableHash(this.#deps.config.ab.salt, message.deviceId).slice(0, 32);
        return;
      }

      case 'session.start':
        this.#handleStart(message.sourceLang, message.targetLang);
        return;

      case 'session.pause': {
        const session = this.#deps.registry.transition(this.id, 'PAUSE');
        if (session) this.#emitState(session.state, 'user');
        return;
      }

      case 'session.resume': {
        const session = this.#deps.registry.transition(this.id, 'RESUME');
        if (session) this.#emitState(session.state, 'user');
        return;
      }

      case 'session.stop':
        this.#handleStop();
        return;

      case 'session.languages': {
        if (!isSupported(message.sourceLang) || !isSupported(message.targetLang)) return;
        this.#deps.registry.setLanguages(this.id, message.sourceLang, message.targetLang);
        return;
      }

      case 'segment.header': {
        if (message.byteLength > this.#deps.config.quota.maxAudioBytes) {
          this.#sendError('bad_request', 'That recording was too large.', false, false, message.segmentId);
          return;
        }
        this.#pendingSegment = message;
        return;
      }

      case 'pong':
        this.#lastPongAt = Date.now();
        return;

      default:
        return;
    }
  }

  #handleStart(sourceLang: string, targetLang: string): void {
    if (!this.#userId) {
      this.#sendError('bad_request', 'Connection is not identified yet.', false, false);
      return;
    }
    if (!isSupported(sourceLang) || !isSupported(targetLang)) {
      this.#sendError('bad_request', 'That language pair is not supported.', false, false);
      return;
    }

    // Idempotent: a second start on a connection that already owns a session is
    // a no-op that simply re-reports state. This is what makes rapid tapping
    // safe — three taps cannot become three sessions.
    const already = this.#deps.registry.get(this.id);
    if (already) {
      this.#emitState(already.state, 'user');
      return;
    }

    try {
      const { session, superseded } = this.#deps.registry.start({
        connectionId: this.id,
        userId: this.#userId,
        sourceLang,
        targetLang,
      });

      // Tell the hub to close whichever connection just lost the slot.
      if (superseded.supersededConnectionIds.length > 0) {
        this.#deps.onSupersede(superseded.supersededConnectionIds);
      }

      this.#emitState(session.state, 'user');
    } catch (err) {
      const error = err instanceof PipelineError ? err : new PipelineError('unknown', 'backend');
      // A refusal here is a genuine budget or capacity limit — never a stale
      // session, because those were superseded a moment ago.
      this.#sendError(error.kind, error.policy.userMessage, error.policy.retryable, true);
      this.#emitState('idle', reasonFor(error));
    }
  }

  #handleStop(): void {
    const session = this.#deps.registry.get(this.id);
    if (!session) {
      // Stopping something that is already stopped is normal, not an error.
      this.#emitState('idle', 'user');
      return;
    }
    this.#deps.registry.release(this.id, 'user_stopped');
    this.#emitState('idle', 'user');
  }

  // ── Audio ───────────────────────────────────────────────────────────────

  #handleBinary(audio: Buffer): void {
    const header = this.#pendingSegment;
    this.#pendingSegment = null;

    if (!header) return; // binary with no preceding header — ignore
    const session = this.#deps.registry.get(this.id);
    if (!session) return;
    // Audio arriving while paused is dropped rather than queued: the user asked
    // for silence, and processing it later would bill time they did not intend.
    if (session.state !== 'active') return;

    // Serialised so two segments cannot interleave their quota commits.
    this.#queue = this.#queue.then(() => this.#processSegment(header, audio, session.sessionId));
  }

  async #processSegment(header: ClientSegmentHeader, audio: Buffer, sessionId: string): Promise<void> {
    if (this.#disposed) return;
    const session = this.#deps.registry.get(this.id);
    // The session may have been stopped or superseded while this was queued.
    if (!session || session.sessionId !== sessionId) return;

    try {
      const outcome = await this.#deps.pipeline.translateSegment({
        sessionId,
        audio,
        mimeType: 'audio/wav',
        durationSeconds: header.durationSeconds,
        sourceLang: session.sourceLang,
        targetLang: session.targetLang,
        ...(session.previousText !== undefined ? { previousText: session.previousText } : {}),
        // Two-stage delivery: the transcript is pushed the moment recognition
        // finishes, so the source text starts animating while the translation
        // is still in flight.
        onTranscript: (text, confidence) => {
          this.send({
            type: 'transcript',
            segmentId: header.segmentId,
            text,
            lang: session.sourceLang,
            isFinal: true,
            confidence,
          });
        },
      });

      if (this.#disposed) return;

      if (outcome.status === 'recognized') {
        this.#deps.registry.setPreviousText(this.id, outcome.segment.sourceText);
        this.send({
          type: 'translation',
          segmentId: header.segmentId,
          text: outcome.segment.translatedText,
          lang: session.targetLang,
          isFinal: true,
          ...(outcome.segment.matchQuality !== undefined
            ? { matchQuality: outcome.segment.matchQuality }
            : {}),
        });
      } else {
        this.send({
          type: 'segment.skipped',
          segmentId: header.segmentId,
          reason: outcome.status === 'no_speech' ? 'no_speech' : outcome.reason,
          message: outcome.message,
        });
      }

      this.send({ type: 'quota', quota: toQuotaSnapshot(outcome.quota) });

      if (outcome.quota.sessionEnded) {
        this.#deps.registry.release(this.id, 'session_limit');
        this.#emitState('idle', (outcome.quota.endedReason as SessionChangeReason) ?? 'session_limit');
      }
    } catch (err) {
      if (this.#disposed) return;
      const error = err instanceof PipelineError ? err : new PipelineError('unknown', 'backend');
      const fatal = error.policy.haltProvider || error.kind === 'internal_quota_exceeded';

      this.#sendError(error.kind, error.policy.userMessage, error.policy.retryable, fatal, header.segmentId);

      if (fatal) {
        this.#deps.registry.release(this.id, 'user_stopped');
        this.#emitState('idle', reasonFor(error));
      }
    }
  }

  // ── Emitters ────────────────────────────────────────────────────────────

  #emitState(state: SessionState, reason: SessionChangeReason): void {
    const session = this.#deps.registry.get(this.id);
    let quota = null;
    if (session) {
      try {
        quota = toQuotaSnapshot(this.#deps.quota.snapshot(session.sessionId));
      } catch {
        quota = null;
      }
    }
    this.send({
      type: 'session.state',
      state,
      sessionId: session?.sessionId ?? null,
      quota,
      reason,
    });
  }

  #sendError(kind: string, message: string, retryable: boolean, fatal: boolean, segmentId?: string): void {
    this.send({
      type: 'error',
      kind,
      message,
      retryable,
      fatal,
      ...(segmentId ? { segmentId } : {}),
    });
  }
}

function reasonFor(error: PipelineError): SessionChangeReason {
  if (error.kind === 'internal_quota_exceeded') {
    const detail = error.detail ?? '';
    if (detail.includes('daily')) return 'daily_limit';
    if (detail.includes('monthly')) return 'monthly_limit';
    if (detail.includes('global') || detail.includes('concurrent')) return 'global_limit';
    return 'session_limit';
  }
  return 'error';
}

function toQuotaSnapshot(snapshot: {
  sessionId: string;
  sessionSecondsUsed: number;
  sessionSecondsLimit: number;
  dailySecondsUsed: number;
  dailySecondsLimit: number;
  monthlySecondsUsed: number;
  monthlySecondsLimit: number;
  sessionEnded: boolean;
  endedReason?: string;
}) {
  return {
    sessionId: snapshot.sessionId,
    sessionSecondsUsed: snapshot.sessionSecondsUsed,
    sessionSecondsLimit: snapshot.sessionSecondsLimit,
    dailySecondsUsed: snapshot.dailySecondsUsed,
    dailySecondsLimit: snapshot.dailySecondsLimit,
    monthlySecondsUsed: snapshot.monthlySecondsUsed,
    monthlySecondsLimit: snapshot.monthlySecondsLimit,
    sessionEnded: snapshot.sessionEnded,
    ...(snapshot.endedReason ? { endedReason: snapshot.endedReason } : {}),
  };
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.alloc(0);
}
