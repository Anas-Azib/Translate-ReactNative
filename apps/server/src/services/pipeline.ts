import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../lib/config.js';
import type { Clock } from '../lib/clock.js';
import { systemClock } from '../lib/clock.js';
import { EphemeralVault } from '../lib/crypto.js';
import { PipelineError } from '../lib/errors.js';
import { findLanguage } from '../lib/languages.js';
import type { Providers, SessionQuotaSnapshot, TranscriptSegment } from '../types/index.js';
import type { QuotaManager } from '../usage/quotaManager.js';
import { ProviderCircuit } from './circuit.js';
import { clampToLimit, isProcessableAudio, shouldTranslate } from './segmenter.js';
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
  /**
   * Called the moment recognition succeeds, before translation is requested.
   *
   * This is what lets the client animate the source text while the translation
   * is still in flight — the two stages become independent instead of the user
   * waiting for the whole pipeline before seeing anything.
   */
  onTranscript?: (text: string, confidence: number) => void;
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
  too_short: 'That was too short to translate — try a full sentence.',
  too_few_words: 'That was too short to translate — try a full sentence.',
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
 * The last stage now happens on the device: the client speaks the translated
 * text with the browser's own `speechSynthesis` engine. That removes an entire
 * network round trip, the audio payload in the response, and the synthesis
 * cache and character budget that used to guard it — the server's job ends at
 * producing text.
 *
 * Every stage is gated by the QuotaManager first and the ProviderCircuit
 * second, so a rejected request never reaches a provider.
 */
export class TranslationPipeline {
  readonly #providers: Providers;
  readonly #quota: QuotaManager;
  readonly #config: AppConfig;
  readonly #clock: Clock;
  readonly #vault: EphemeralVault;
  readonly circuit: ProviderCircuit;

  constructor(options: {
    providers: Providers;
    quota: QuotaManager;
    config: AppConfig;
    clock?: Clock;
    circuit?: ProviderCircuit;
  }) {
    this.#providers = options.providers;
    this.#quota = options.quota;
    this.#config = options.config;
    this.#clock = options.clock ?? systemClock;
    this.#vault = new EphemeralVault(options.config.payloadEncryptionKey);
    this.circuit = options.circuit ?? new ProviderCircuit({ clock: this.#clock });
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

    // ── Usage control, before anything is processed (plan doc p.5).
    this.#quota.assertAudio({
      sessionId: input.sessionId,
      audioSeconds: input.durationSeconds,
      audioBytes: input.audio.byteLength,
    });

    // ── Silence gate. Whisper is local so silence costs no money, but it does
    // cost CPU — and, left unchecked, it makes the model hallucinate words.
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
      const stt = await this.#recognize(handle, input, source.translateCode);

      // Recognition time is recorded whether or not words came back: the CPU
      // was spent either way, and the session budget is what bounds it.
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

      // Stage one is complete: hand the recognised text to the caller now.
      // Wrapped because a listener throwing must not fail the translation.
      try {
        input.onTranscript?.(sourceText, stt.confidence);
      } catch {
        // A broken listener is the listener's problem.
      }

      // ── Translation. `inFlight` because the audio for this segment was
      // already authorised and recorded above; committing it may have just
      // ended the session, and the user should still get the sentence they
      // finished saying.
      this.#quota.assertTranslation({ sessionId: input.sessionId, text: sourceText, inFlight: true });
      this.circuit.assertAvailable('mymemory-translate');
      const translation = await this.#run('mymemory-translate', () =>
        this.#providers.translate.translate({
          text: sourceText,
          sourceLang: source.translateCode,
          targetLang: target.translateCode,
        }),
      );
      this.#quota.commitTranslation(input.sessionId, translation.billedChars);

      const segment: TranscriptSegment = {
        id: randomUUID(),
        sourceText,
        translatedText: translation.text,
        sourceLang: source.speechCode,
        targetLang: target.speechCode,
        confidence: stt.confidence,
        ...(translation.matchQuality !== undefined ? { matchQuality: translation.matchQuality } : {}),
        audioSeconds: round1(stt.durationSeconds),
        createdAt: this.#clock.now(),
      };

      return { status: 'recognized', segment, quota };
    } finally {
      // Deleted on every path, including thrown errors.
      this.#vault.release(handle);
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  async #recognize(handle: string, input: TranslateSegmentInput, languageCode: string) {
    this.circuit.assertAvailable('whisper-stt');
    // Decrypt only for the moment the recogniser needs the bytes.
    const promise = this.#vault.use(handle, (plaintext) =>
      this.#providers.stt.recognize({
        // Copy: the vault shreds `plaintext` as soon as this callback returns.
        audio: Buffer.from(plaintext),
        mimeType: input.mimeType,
        languageCode,
        durationSeconds: input.durationSeconds,
      }),
    );
    return this.#run('whisper-stt', () => promise);
  }

  /** Normalises any thrown value into a PipelineError and trips the circuit. */
  async #run<T>(provider: 'whisper-stt' | 'mymemory-translate', fn: () => Promise<T>): Promise<T> {
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
