/**
 * Shared domain types for the Auto Transliteration backend.
 *
 * The pipeline follows the plan document's data flow (p.3):
 *   Phone → Backend → Speech API → Translation API → TTS API → Backend → Phone
 */

export type ProviderMode = 'real' | 'mock';

/** Which upstream service a failure came from. */
export type ProviderName = 'azure-stt' | 'google-translate' | 'google-tts';

/**
 * Failure taxonomy from the plan document (p.2–3). Every provider maps its
 * native error shape onto one of these, and each has a fixed retry policy.
 */
export type FailureKind =
  /** Azure returned NoMatch — audio contained no recognisable speech. */
  | 'no_match'
  /** Credentials rejected. Never retried: retrying cannot fix a bad key. */
  | 'auth_failure'
  /** Malformed request. "STOP — Don't retry unchanged request." */
  | 'bad_request'
  /** Provider-side quota/billing ceiling. "STOP API requests. Do NOT retry." */
  | 'quota_exceeded'
  /** Our own usage-control layer refused before any upstream call was made. */
  | 'internal_quota_exceeded'
  /** Transient (5xx / network). The only kind that may be retried. */
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
  /** Copy shown to a non-technical user, verbatim from the plan doc where given. */
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
  ttsChars: number;
  sttRequests: number;
  translateRequests: number;
  ttsRequests: number;
}

export interface LanguageOption {
  /** BCP-47 tag used for speech recognition, e.g. "ar-SA". */
  speechCode: string;
  /** ISO-639-1 code used by Google Translation, e.g. "ar". */
  translateCode: string;
  /** Google TTS voice locale, e.g. "ar-XA". */
  ttsCode: string;
  /** Preferred Google Standard voice (cheapest tier). */
  ttsVoice: string;
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
  /** Recognition confidence 0–1 as reported by the STT provider. */
  confidence: number;
  /** Base64 audio/mp3 of the translated text; null when TTS was skipped. */
  audioBase64: string | null;
  /** True when TTS was served from cache rather than re-synthesised. */
  ttsCached: boolean;
  audioSeconds: number;
  createdAt: number;
}

export interface SttResult {
  text: string;
  confidence: number;
  /** Azure's RecognitionStatus equivalent. */
  status: 'recognized' | 'no_match';
  durationSeconds: number;
}

export interface TranslateResult {
  text: string;
  detectedSourceLang?: string;
  billedChars: number;
}

export interface TtsResult {
  audioBase64: string;
  mimeType: string;
  billedChars: number;
  cached: boolean;
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

export interface TtsProvider {
  readonly name: ProviderName;
  readonly mode: ProviderMode;
  synthesize(input: {
    text: string;
    languageCode: string;
    voiceName: string;
  }): Promise<TtsResult>;
}

export interface Providers {
  stt: SttProvider;
  translate: TranslateProvider;
  tts: TtsProvider;
}
