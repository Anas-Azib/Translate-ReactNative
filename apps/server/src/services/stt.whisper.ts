import type { SttProvider, SttResult } from '../types/index.js';
import { PipelineError } from '../lib/errors.js';
import { AudioDecodeError, decodeForWhisper, peakWindowRms } from '../lib/audio.js';

/**
 * Speech-to-text with Whisper, running locally.
 *
 * No API key, no per-request cost, and audio never leaves the machine. What it
 * costs instead is CPU and memory, so the model is loaded once and shared.
 */

export type WhisperModel =
  | 'onnx-community/whisper-tiny'
  | 'onnx-community/whisper-base'
  | 'onnx-community/whisper-small'
  | (string & {});

export interface WhisperOptions {
  model?: WhisperModel;
  /** Quantisation. `q8` is ~4× smaller and ~2× faster than `fp32`, with no
   *  meaningful accuracy loss for speech at these model sizes. */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
  /** Below this peak level the clip is treated as silence and never inferred. */
  silenceThreshold?: number;
  /** Injectable for tests, so the suite never downloads a model. */
  pipelineFactory?: () => Promise<TranscribeFn>;
}

export type TranscribeFn = (
  audio: Float32Array,
  options: { language?: string; task: 'transcribe' },
) => Promise<{ text: string }>;

/**
 * Phrases Whisper emits when handed silence or noise.
 *
 * This is not defensive padding — it is a measured behaviour of the model. Fed
 * pure digital silence, whisper-base returns " you". Fed faint noise, it returns
 * " you" again. Whisper was trained on subtitle corpora and falls back to their
 * most common filler when there is nothing to hear, so without this guard the
 * app would translate and speak a phantom word every time the user paused.
 *
 * The energy gate below is the primary defence; this list catches what slips
 * through when there is genuine background noise.
 */
const HALLUCINATIONS = new Set([
  'you',
  'thank you',
  'thank you.',
  'thanks for watching',
  'thanks for watching!',
  'thank you for watching',
  'bye',
  'bye.',
  'okay',
  'ok',
  '.',
  '...',
  'oh',
  'hmm',
  'the',
  'so',
  'i',
  'yeah',
  'please subscribe',
  'subtitles by the amara.org community',
  'amara.org',
  'شكرا',
  'شكرا لكم',
  'اشتركوا في القناة',
]);

export function isLikelyHallucination(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?،؟"'`]+$/g, '')
    .replace(/\s+/g, ' ');
  if (normalized.length === 0) return true;
  if (HALLUCINATIONS.has(normalized)) return true;
  // Musical-note markers are Whisper's way of saying "this was not speech".
  if (/^[\s♪♫\-–—.]*$/.test(normalized)) return true;
  return false;
}

/** Loads the model once per process; concurrent callers share one load. */
class ModelLoader {
  #promise: Promise<TranscribeFn> | null = null;

  constructor(
    private readonly factory: () => Promise<TranscribeFn>,
  ) {}

  load(): Promise<TranscribeFn> {
    // Deliberately cached as a promise, not an awaited value: two requests
    // arriving during a cold start must share one download, not trigger two.
    this.#promise ??= this.factory().catch((err) => {
      // Do not cache a failure — a transient download problem should be
      // retryable on the next request.
      this.#promise = null;
      throw err;
    });
    return this.#promise;
  }

  get loaded(): boolean {
    return this.#promise !== null;
  }
}

export class WhisperSttProvider implements SttProvider {
  readonly name = 'whisper-stt' as const;
  readonly mode = 'real' as const;
  readonly model: string;

  readonly #loader: ModelLoader;
  readonly #silenceThreshold: number;

  constructor(options: WhisperOptions = {}) {
    this.model = options.model ?? 'onnx-community/whisper-base';
    this.#silenceThreshold = options.silenceThreshold ?? 0.006;

    const dtype = options.dtype ?? 'q8';
    this.#loader = new ModelLoader(
      options.pipelineFactory ??
        (async () => {
          // Imported lazily so the module graph — and the test suite — does not
          // pull in onnxruntime unless real transcription is actually wanted.
          const { pipeline } = await import('@huggingface/transformers');
          const transcriber = await pipeline('automatic-speech-recognition', this.model, { dtype });
          return (audio, opts) =>
            transcriber(audio, opts) as Promise<{ text: string }>;
        }),
    );
  }

  get warmed(): boolean {
    return this.#loader.loaded;
  }

  /** Pre-loads the model so the first user request is not the one that waits. */
  async warmup(): Promise<void> {
    await this.#loader.load();
  }

  async recognize(input: {
    audio: Buffer;
    mimeType: string;
    languageCode: string;
    durationSeconds: number;
  }): Promise<SttResult> {
    let decoded;
    try {
      decoded = decodeForWhisper(input.audio);
    } catch (err) {
      if (err instanceof AudioDecodeError) {
        throw new PipelineError('bad_request', this.name, err.message);
      }
      throw new PipelineError('unknown', this.name, describe(err));
    }

    const duration = decoded.durationSeconds || input.durationSeconds;

    // Energy gate before inference. Cheaper than running the model, and it is
    // what stops Whisper from inventing words out of a silent room.
    const level = peakWindowRms(decoded.samples, decoded.sampleRate);
    if (level < this.#silenceThreshold) {
      return { text: '', confidence: 0, status: 'no_match', durationSeconds: duration };
    }

    let transcriber: TranscribeFn;
    try {
      transcriber = await this.#loader.load();
    } catch (err) {
      // A cold start failure is usually the model download — worth retrying.
      throw new PipelineError('transient', this.name, `model load failed: ${describe(err)}`);
    }

    let text: string;
    try {
      // Whisper accepts an ISO-639-1 code or the English language name; the
      // code is what our language table already carries.
      const result = await transcriber(decoded.samples, {
        language: input.languageCode.split('-')[0],
        task: 'transcribe',
      });
      text = (result?.text ?? '').trim();
    } catch (err) {
      throw new PipelineError('unknown', this.name, describe(err));
    }

    if (isLikelyHallucination(text)) {
      return { text: '', confidence: 0, status: 'no_match', durationSeconds: duration };
    }

    return {
      text,
      // Whisper exposes no per-token probability through this interface. The
      // energy gate and hallucination filter have already done the rejecting,
      // so anything reaching here is reported as confident and the downstream
      // segmenter judges it on content instead.
      confidence: 0.9,
      status: 'recognized',
      durationSeconds: duration,
    };
  }
}

/**
 * Offline STT for tests and for anyone who does not want to download a model.
 * Deterministic: the same audio always yields the same transcript.
 */
export class MockSttProvider implements SttProvider {
  readonly name = 'whisper-stt' as const;
  readonly mode = 'mock' as const;

  static readonly PHRASES: Record<string, string[]> = {
    ar: ['مرحبا، كيف حالك؟', 'أين أقرب مستشفى؟', 'أحتاج إلى مساعدة من فضلك', 'كم يكلف هذا؟', 'شكرا جزيلا لك'],
    en: [
      'Hello, how are you?',
      'Where is the nearest hospital?',
      'I need some help please',
      'How much does this cost?',
      'Thank you very much',
    ],
    fr: ['Bonjour, comment allez-vous ?', "Où est l'hôpital le plus proche ?", "J'ai besoin d'aide s'il vous plaît"],
    es: ['Hola, ¿cómo estás?', '¿Dónde está el hospital más cercano?', 'Necesito ayuda por favor'],
  };

  async recognize(input: {
    audio: Buffer;
    mimeType: string;
    languageCode: string;
    durationSeconds: number;
  }): Promise<SttResult> {
    if (input.audio.byteLength <= 512 || input.durationSeconds < 0.35) {
      return { text: '', confidence: 0, status: 'no_match', durationSeconds: input.durationSeconds };
    }

    const base = input.languageCode.split('-')[0] ?? 'en';
    const phrases = MockSttProvider.PHRASES[base] ?? MockSttProvider.PHRASES.en!;
    const index = checksum(input.audio) % phrases.length;

    return {
      text: phrases[index]!,
      confidence: 0.92,
      status: 'recognized',
      durationSeconds: input.durationSeconds,
    };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checksum(buffer: Buffer): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) sum = (sum + buffer[i]!) % 100_003;
  return sum;
}
