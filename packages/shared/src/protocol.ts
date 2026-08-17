import type { SessionState } from './sessionState.js';

/**
 * The WebSocket protocol.
 *
 * One socket owns exactly one session. That is the core of the design: the
 * connection *is* the liveness signal, so a dropped client is detected by the
 * socket closing rather than by a timer noticing minutes later.
 *
 * Control frames are JSON; audio is sent as raw binary. Mixing the two on one
 * connection is what lets a disconnect clean up both at once.
 */

export const PROTOCOL_VERSION = 1;

// ── Client → server ───────────────────────────────────────────────────────

export interface ClientHello {
  type: 'hello';
  protocolVersion: number;
  deviceId: string;
}

export interface ClientStart {
  type: 'session.start';
  sourceLang: string;
  targetLang: string;
  /**
   * Ask the server to close any existing session for this device and hand the
   * slot to this connection. Set by the client when the user deliberately taps
   * start — see `session.superseded`.
   */
  takeover?: boolean;
}

export interface ClientPause {
  type: 'session.pause';
}

export interface ClientResume {
  type: 'session.resume';
}

export interface ClientStop {
  type: 'session.stop';
}

/** Announces the audio segment carried by the *next* binary frame. */
export interface ClientSegmentHeader {
  type: 'segment.header';
  segmentId: string;
  durationSeconds: number;
  byteLength: number;
}

export interface ClientLanguageChange {
  type: 'session.languages';
  sourceLang: string;
  targetLang: string;
}

export interface ClientPong {
  type: 'pong';
  at: number;
}

export type ClientMessage =
  | ClientHello
  | ClientStart
  | ClientPause
  | ClientResume
  | ClientStop
  | ClientSegmentHeader
  | ClientLanguageChange
  | ClientPong;

// ── Server → client ───────────────────────────────────────────────────────

export interface ServerReady {
  type: 'ready';
  protocolVersion: number;
  /** Server-assigned connection id, useful in logs and for takeover reporting. */
  connectionId: string;
}

export interface ServerSessionState {
  type: 'session.state';
  state: SessionState;
  sessionId: string | null;
  quota: QuotaSnapshot | null;
  /** Why the state changed, when it was not the client's own request. */
  reason?: SessionChangeReason;
}

export type SessionChangeReason =
  | 'user'
  | 'session_limit'
  | 'daily_limit'
  | 'monthly_limit'
  | 'global_limit'
  | 'superseded'
  | 'expired'
  | 'error';

/**
 * A superseded session: the same device opened a newer connection and took the
 * slot. The old client is told explicitly rather than being left to guess why
 * its session stopped working.
 */
export interface ServerSuperseded {
  type: 'session.superseded';
  sessionId: string;
}

/**
 * Stage one of a segment: what the user said.
 *
 * Sent as soon as recognition finishes, *before* translation is requested, so
 * the source text can start animating while the translation is still in
 * flight. `isFinal` exists so a future streaming recogniser can emit growing
 * prefixes without any protocol change; the current batch recogniser always
 * sends `true`.
 */
export interface ServerTranscript {
  type: 'transcript';
  segmentId: string;
  text: string;
  lang: string;
  isFinal: boolean;
  confidence: number;
}

/** Stage two: the translation of a previously-sent transcript. */
export interface ServerTranslation {
  type: 'translation';
  segmentId: string;
  text: string;
  lang: string;
  isFinal: boolean;
  /** MyMemory match score 0–1; low means a loose fuzzy hit. */
  matchQuality?: number;
}

/** A segment that produced nothing worth showing (silence, filler, duplicate). */
export interface ServerSegmentSkipped {
  type: 'segment.skipped';
  segmentId: string;
  reason: string;
  message: string;
}

export interface ServerQuota {
  type: 'quota';
  quota: QuotaSnapshot;
}

export interface ServerError {
  type: 'error';
  kind: string;
  message: string;
  retryable: boolean;
  /** True when the session ended as a result. */
  fatal: boolean;
  segmentId?: string;
}

export interface ServerPing {
  type: 'ping';
  at: number;
}

export type ServerMessage =
  | ServerReady
  | ServerSessionState
  | ServerSuperseded
  | ServerTranscript
  | ServerTranslation
  | ServerSegmentSkipped
  | ServerQuota
  | ServerError
  | ServerPing;

// ── Shared payloads ───────────────────────────────────────────────────────

export interface QuotaSnapshot {
  sessionId: string;
  sessionSecondsUsed: number;
  sessionSecondsLimit: number;
  dailySecondsUsed: number;
  dailySecondsLimit: number;
  monthlySecondsUsed: number;
  monthlySecondsLimit: number;
  sessionEnded: boolean;
  endedReason?: string;
}

export interface LanguageOption {
  speechCode: string;
  translateCode: string;
  labelEn: string;
  labelNative: string;
  flag: string;
  rtl: boolean;
}

/** One completed exchange, assembled on the client from the two stages. */
export interface TranscriptEntry {
  segmentId: string;
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  confidence: number;
  matchQuality?: number;
  createdAt: number;
}

// ── Guards ────────────────────────────────────────────────────────────────

export function isClientMessage(value: unknown): value is ClientMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

export function isServerMessage(value: unknown): value is ServerMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** Parses a JSON control frame, returning null rather than throwing. */
export function parseMessage<T>(raw: string): T | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : null;
  } catch {
    return null;
  }
}

// ── Connection lifecycle ──────────────────────────────────────────────────

export const CONNECTION_STATES = [
  'connecting',
  'connected',
  'disconnecting',
  'disconnected',
  'error',
] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** Heartbeat period. Half-open sockets are otherwise invisible to both ends. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Missed-pong budget before the server drops the connection as dead. */
export const HEARTBEAT_TIMEOUT_MS = 40_000;

/** Application-level close codes, above the reserved WebSocket range. */
export const CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  /** This device opened a newer connection. */
  SUPERSEDED: 4001,
  PROTOCOL_MISMATCH: 4002,
  HEARTBEAT_TIMEOUT: 4003,
  SERVER_SHUTDOWN: 4004,
} as const;
