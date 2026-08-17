/**
 * Client-local types.
 *
 * Anything the backend also knows about is re-exported from `@translate/shared`
 * rather than redeclared here — duplicating those interfaces is how a client
 * and server drift apart until a field silently means two different things.
 */

export type {
  ConnectionState,
  LanguageOption,
  QuotaSnapshot,
  ServerMessage,
  ClientMessage,
  SessionState,
  SessionEvent,
  TranscriptEntry,
} from '@translate/shared';

import type { TranscriptEntry } from '@translate/shared';

export type ApiErrorKind =
  | 'no_match'
  | 'auth_failure'
  | 'bad_request'
  | 'quota_exceeded'
  | 'internal_quota_exceeded'
  | 'transient'
  | 'unknown'
  | 'network';

export interface ApiErrorShape {
  kind: ApiErrorKind;
  provider: string;
  message: string;
  retryable: boolean;
  haltProvider?: boolean;
}

/** Response of `GET /api/config` — client-only, so it stays here. */
export interface AppConfigResponse {
  languages: import('@translate/shared').LanguageOption[];
  defaults: { source: string; target: string };
  limits: {
    sessionSeconds: number;
    dailySeconds: number;
    monthlySeconds: number;
    maxCharsPerTranslation: number;
    maxAudioBytes: number;
  };
  providers: Record<string, { name: string; mode: 'real' | 'mock'; model?: string }>;
  usage: {
    daily: { audioSeconds: number };
    monthly: { audioSeconds: number };
  };
}

/** UI phases for the mic orb. Drives which animation timeline is live. */
export type MicState = 'idle' | 'listening' | 'processing' | 'speaking' | 'blocked';

/**
 * A settled exchange in the transcript list.
 *
 * Extends the shared entry with the fields only the UI cares about.
 */
export interface ConversationEntry extends Omit<TranscriptEntry, 'segmentId'> {
  id: string;
  kind: 'translation' | 'notice';
  audioSeconds: number;
  noticeText?: string;
  noticeTone?: 'neutral' | 'warning' | 'error';
}
