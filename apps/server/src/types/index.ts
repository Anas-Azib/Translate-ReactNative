/**
 * Shared domain types for the Auto Transliteration backend.
 *
 * The pipeline follows the plan document's data flow (p.3), with the providers
 * swapped for zero-cost local/free equivalents:
 *
 *   Phone → Backend → Whisper (local) → MyMemory → Backend → Phone
 *                                                  ↓
 *                                       speech synthesis on the device
 *
 * Text-to-speech no longer appears here at all: the browser's own
 * `speechSynthesis` engine speaks the translation, so no audio is generated,
 * cached, billed, or transferred.
 */

export type ProviderMode = 'real' | 'mock';

/** Which service a failure came from. */
export type ProviderName = 'whisper-stt' | 'mymemory-translate';

/**
 * Failure taxonomy from the plan document (p.2–3). Every provider maps its
 * native error shape onto one of these, and each has a fixed retry policy.
 */
export type FailureKind =
  /** No recognisable speech in the audio. */
  | 'no_match'
  /** Credentials rejected. Never retried: retrying cannot fix a bad key. */
  | 'auth_failure'
  /** Malformed request. "STOP — Don't retry unchanged request." */
  | 'bad_request'
  /** Provider-side quota/billing ceiling. "STOP API requests. Do NOT retry." */
  | 'quota_exceeded'
  /** Our own usage-control layer refused before any upstream call was made. */
  | 'internal_quota_exceeded'
  /** Transient (5xx / network / model cold start). The only retryable kind. */
  | 'transient'
  /** Anything we could not classify. Treated as non-retryable. */
  | 'unknown';

export interface FailurePolicy {
  /** Whether the caller may retry the *same* request. */
  retryable: boolean;
  /** Whether all further calls to this provider must stop for this session. */
  haltProvider: boolean;
  /** HTTP status the client should see. */
  httpStatus: number;
  /** Copy shown to a non-technical user. */
  userMessage: string;
}

export interface SessionQuotaSnapshot {
  sessionId: string;
  userId: string;
  /** Seconds of audio consumed by this session so far. */
  sessionSecondsUsed: number;
  /** Hard stop for this session (plan doc: "Automatically stop translation after the configured session limit"). */
  sessionSecondsLimit: number;
  dailySecondsUsed: number;
  dailySecondsLimit: number;
  monthlySecondsUsed: number;
  monthlySecondsLimit: number;
  /** True once the session hit its ceiling; the user must explicitly start a new one. */
  sessionEnded: boolean;
  endedReason?: SessionEndReason;
}

export type SessionEndReason =
  | 'session_limit'
  | 'daily_limit'
  | 'monthly_limit'
  | 'global_limit'
  | 'user_stopped'
  | 'expired';

export interface UsageTotals {
  audioSeconds: number;
  translatedChars: number;
  sttRequests: number;
  translateRequests: number;
}

export interface LanguageOption {
  /**
   * BCP-47 tag. Used as the app's language identity, and passed to the
   * browser's `speechSynthesis` to pick a voice.
   */
  speechCode: string;
  /**
   * ISO-639-1 code. Serves double duty: MyMemory's `langpair`, and Whisper's
   * `language` hint (which accepts ISO codes as well as English names).
   */
  translateCode: string;
  labelEn: string;
  labelNative: string;
  flag: string;
  rtl: boolean;
}

export interface TranscriptSegment {
  id: string;
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  /** Recognition confidence 0–1. */
  confidence: number;
  /**
   * MyMemory match score 0–1, when reported. MyMemory is a translation
   * *memory*, so a low score means a loose fuzzy hit rather than a real
   * translation — worth flagging instead of presenting with false confidence.
   */
  matchQuality?: number;
  audioSeconds: number;
  createdAt: number;
}

export interface SttResult {
  text: string;
  confidence: number;
  status: 'recognized' | 'no_match';
  durationSeconds: number;
}

export interface TranslateResult {
  text: string;
  detectedSourceLang?: string;
  billedChars: number;
  matchQuality?: number;
}

export interface SttProvider {
  readonly name: ProviderName;
  readonly mode: ProviderMode;
  recognize(input: {
    audio: Buffer;
    mimeType: string;
    languageCode: string;
    durationSeconds: number;
  }): Promise<SttResult>;
  /** Optional pre-load so the first request does not pay the cold start. */
  warmup?(): Promise<void>;
}

export interface TranslateProvider {
  readonly name: ProviderName;
  readonly mode: ProviderMode;
  translate(input: {
    text: string;
    sourceLang: string;
    targetLang: string;
  }): Promise<TranslateResult>;
}

export interface Providers {
  stt: SttProvider;
  translate: TranslateProvider;
}
