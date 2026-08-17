import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../lib/config.js';
import type { Clock } from '../lib/clock.js';
import { systemClock } from '../lib/clock.js';
import { TtlCache } from '../lib/cache.js';
import { EphemeralVault } from '../lib/crypto.js';
import { PipelineError } from '../lib/errors.js';
import { findLanguage } from '../lib/languages.js';
import type { Providers, SessionQuotaSnapshot, TranscriptSegment, TtsResult } from '../types/index.js';
import type { QuotaManager } from '../usage/quotaManager.js';
import { ProviderCircuit } from './circuit.js';
import { clampToLimit, isProcessableAudio, shouldTranslate, ttsCacheKey } from './segmenter.js';
import type { SegmentSkipReason } from './segmenter.js';

export interface TranslateSegmentInput {
  sessionId: string;
  audio: Buffer;
  mimeType: string;
  durationSeconds: number;
  sourceLang: string;
  targetLang: string;
  /** Last text we already translated in this session, for de-duplication. */
  previousText?: string;
  /** When false, the caller only wants text (saves TTS characters). */
  speak?: boolean;
}

export type SegmentOutcome =
  | { status: 'recognized'; segment: TranscriptSegment; quota: SessionQuotaSnapshot }
  | { status: 'no_speech'; message: string; quota: SessionQuotaSnapshot }
  | {
      status: 'skipped';
      reason: SegmentSkipReason;
      sourceText: string;
      message: string;
      quota: SessionQuotaSnapshot;
    };

const SKIP_MESSAGES: Record<SegmentSkipReason, string> = {
  empty: 'No speech recognized',
  too_short: "That was too short to translate — try a full sentence.",
  too_few_words: "That was too short to translate — try a full sentence.",
  low_confidence: "I didn't catch that clearly. Try again a bit closer to the mic.",
  filler_only: 'No speech recognized',
  duplicate_of_previous: 'Same as the last phrase — nothing new to translate.',
};

/**
 * Orchestrates the plan document's flow (p.1):
 *
 *   Audio capture → Speech recognition → Source text → Translation
 *   → Translated text → Text-to-speech → Translated voice
 *
 * Every stage is gated by the QuotaManager first and the ProviderCircuit
 * second, so a rejected request never reaches Azure or Google.
 */
export class TranslationPipeline {
  readonly #providers: Providers;
  readonly #quota: QuotaManager;
  readonly #config: AppConfig;
  readonly #clock: Clock;
  readonly #vault: EphemeralVault;
  readonly #ttsCache: TtlCache<{ audioBase64: string; mimeType: string }>;
  readonly circuit: ProviderCircuit;

  constructor(options: {
    providers: Providers;
    quota: QuotaManager;
    config: AppConfig;
    clock?: Clock;
    circuit?: ProviderCircuit;
    ttsCache?: TtlCache<{ audioBase64: string; mimeType: string }>;
  }) {
    this.#providers = options.providers;
    this.#quota = options.quota;
    this.#config = options.config;
    this.#clock = options.clock ?? systemClock;
    this.#vault = new EphemeralVault(options.config.payloadEncryptionKey);
    this.circuit = options.circuit ?? new ProviderCircuit({ clock: this.#clock });
    this.#ttsCache =
      options.ttsCache ??
      new TtlCache<{ audioBase64: string; mimeType: string }>({
        maxEntries: 300,
        ttlMs: 60 * 60 * 1000,
        clock: this.#clock,
      });
  }

  get ttsCacheStats() {
    return this.#ttsCache.stats;
  }

  /** Number of encrypted buffers still held. Should be 0 between requests. */
  get pendingAudioBuffers(): number {
    return this.#vault.size;
  }

  async translateSegment(input: TranslateSegmentInput): Promise<SegmentOutcome> {
    const source = findLanguage(input.sourceLang);
    const target = findLanguage(input.targetLang);
    if (!source || !target) {
      throw new PipelineError('bad_request', 'backend', 'unsupported language');
    }

    // ── Usage control, before anything is sent upstream (plan doc p.5).
    this.#quota.assertAudio({
      sessionId: input.sessionId,
      audioSeconds: input.durationSeconds,
      audioBytes: input.audio.byteLength,
    });

    // ── Silence gate: "Do not continuously send silent audio to Google."
    if (!isProcessableAudio(input.durationSeconds, input.audio.byteLength)) {
      return {
        status: 'no_speech',
        message: 'No speech recognized',
        quota: this.#quota.snapshot(input.sessionId),
      };
    }

    // ── "The data should be encrypted, temporarily processed, then deleted."
    const handle = this.#vault.store(input.audio);

    try {
      const stt = await this.#recognize(handle, input, source.speechCode);

      // STT time is billed whether or not words came back — Azure charges for
      // the audio it processed, so the counter must reflect that.
      const quota = this.#quota.commitAudio(input.sessionId, stt.durationSeconds);

      if (stt.status === 'no_match') {
        return { status: 'no_speech', message: 'No speech recognized', quota };
      }

      // ── "Translate meaningful finalized segments instead" of every partial.
      const gate = shouldTranslate(stt.text, stt.confidence, input.previousText, {
        maxChars: this.#config.quota.maxCharsPerTranslation,
      });
      if (!gate.translate) {
        return {
          status: 'skipped',
          reason: gate.reason!,
          sourceText: gate.normalized,
          message: SKIP_MESSAGES[gate.reason!],
          quota,
        };
      }

      const sourceText = clampToLimit(gate.normalized, this.#config.quota.maxCharsPerTranslation);

      // ── Translation. `inFlight` because the audio for this segment was
      // already authorised and billed above; committing it may have just ended
      // the session, and the user should still get the sentence they finished.
      this.#quota.assertTranslation({ sessionId: input.sessionId, text: sourceText, inFlight: true });
      this.circuit.assertAvailable('google-translate');
      const translation = await this.#run('google-translate', () =>
        this.#providers.translate.translate({
          text: sourceText,
          sourceLang: source.translateCode,
          targetLang: target.translateCode,
        }),
      );
      this.#quota.commitTranslation(input.sessionId, translation.billedChars);

      // ── Text-to-speech (cached; skipped entirely when the caller opts out).
      let tts: TtsResult | null = null;
      if (input.speak !== false && translation.text.trim().length > 0) {
        tts = await this.#synthesize(
          input.sessionId,
          translation.text,
          target.ttsCode,
          target.ttsVoice,
          true,
        );
      }

      const segment: TranscriptSegment = {
        id: randomUUID(),
        sourceText,
        translatedText: translation.text,
        sourceLang: source.speechCode,
        targetLang: target.speechCode,
        confidence: stt.confidence,
        audioBase64: tts?.audioBase64 ?? null,
        ttsCached: tts?.cached ?? false,
        audioSeconds: round1(stt.durationSeconds),
        createdAt: this.#clock.now(),
      };

      return { status: 'recognized', segment, quota };
    } finally {
      // Deleted on every path, including thrown errors.
      this.#vault.release(handle);
    }
  }

  /**
   * Standalone TTS for the "play again" button and for re-speaking an edited
   * phrase. Goes through the same cache, so tapping replay costs nothing.
   */
  async speak(input: {
    sessionId: string;
    text: string;
    targetLang: string;
  }): Promise<{ audioBase64: string; mimeType: string; cached: boolean }> {
    const target = findLanguage(input.targetLang);
    if (!target) throw new PipelineError('bad_request', 'backend', 'unsupported language');

    const result = await this.#synthesize(
      input.sessionId,
      input.text,
      target.ttsCode,
      target.ttsVoice,
    );
    return { audioBase64: result.audioBase64, mimeType: result.mimeType, cached: result.cached };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  async #recognize(handle: string, input: TranslateSegmentInput, speechCode: string) {
    this.circuit.assertAvailable('azure-stt');
    // Decrypt only for the moment the provider needs the bytes.
    const promise = this.#vault.use(handle, (plaintext) =>
      this.#providers.stt.recognize({
        // Copy: the vault shreds `plaintext` as soon as this callback returns.
        audio: Buffer.from(plaintext),
        mimeType: input.mimeType,
        languageCode: speechCode,
        durationSeconds: input.durationSeconds,
      }),
    );
    return this.#run('azure-stt', () => promise);
  }

  /**
   * Cache-first synthesis.
   *
   * Plan doc p.4: "Do not regenerate TTS unnecessarily. Only synthesize speech
   * when the translated text has actually changed/finalized." A cache hit is
   * also not billed, so it never touches the character counter.
   */
  async #synthesize(
    sessionId: string,
    text: string,
    languageCode: string,
    voiceName: string,
    inFlight = false,
  ): Promise<TtsResult> {
    const trimmed = clampToLimit(text.trim(), this.#config.quota.maxCharsPerTranslation);
    const key = ttsCacheKey(trimmed, languageCode, voiceName);

    const hit = this.#ttsCache.get(key);
    if (hit) {
      return { ...hit, billedChars: 0, cached: true };
    }

    this.#quota.assertTts({ sessionId, text: trimmed, inFlight });
    this.circuit.assertAvailable('google-tts');

    const result = await this.#run('google-tts', () =>
      this.#providers.tts.synthesize({ text: trimmed, languageCode, voiceName }),
    );

    this.#ttsCache.set(key, { audioBase64: result.audioBase64, mimeType: result.mimeType });
    this.#quota.commitTts(sessionId, result.billedChars);
    return result;
  }

  /** Normalises any thrown value into a PipelineError and trips the circuit. */
  async #run<T>(provider: 'azure-stt' | 'google-translate' | 'google-tts', fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const error =
        err instanceof PipelineError ? err : new PipelineError('unknown', provider, describe(err));
      this.circuit.record(error);
      throw error;
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
