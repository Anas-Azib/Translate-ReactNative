/** Client-side mirrors of the API contract in `server/src/types`. */

export interface LanguageOption {
  speechCode: string;
  translateCode: string;
  ttsCode: string;
  ttsVoice: string;
  labelEn: string;
  labelNative: string;
  flag: string;
  rtl: boolean;
}

export interface QuotaSnapshot {
  sessionId: string;
  userId: string;
  sessionSecondsUsed: number;
  sessionSecondsLimit: number;
  dailySecondsUsed: number;
  dailySecondsLimit: number;
  monthlySecondsUsed: number;
  monthlySecondsLimit: number;
  sessionEnded: boolean;
  endedReason?: string;
}

export interface TranscriptSegment {
  id: string;
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  confidence: number;
  audioBase64: string | null;
  ttsCached: boolean;
  audioSeconds: number;
  createdAt: number;
}

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

export type SegmentOutcome =
  | { status: 'recognized'; segment: TranscriptSegment; quota: QuotaSnapshot }
  | { status: 'no_speech'; message: string; quota: QuotaSnapshot }
  | { status: 'skipped'; reason: string; sourceText: string; message: string; quota: QuotaSnapshot };

export interface AppConfigResponse {
  languages: LanguageOption[];
  defaults: { source: string; target: string };
  limits: {
    sessionSeconds: number;
    dailySeconds: number;
    monthlySeconds: number;
    maxCharsPerTranslation: number;
    maxAudioBytes: number;
  };
  providers: Record<string, { name: string; mode: 'real' | 'mock' }>;
  usage: {
    daily: { audioSeconds: number };
    monthly: { audioSeconds: number };
  };
}

/** UI phases. Drives which animation timeline is live. */
export type MicState = 'idle' | 'listening' | 'processing' | 'speaking' | 'blocked';

export interface ConversationEntry extends TranscriptSegment {
  /** Locally generated entries (errors, notices) render as system bubbles. */
  kind: 'translation' | 'notice';
  noticeText?: string;
  noticeTone?: 'neutral' | 'warning' | 'error';
}
