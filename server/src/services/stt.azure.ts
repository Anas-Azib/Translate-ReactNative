import type { SttProvider, SttResult } from '../types/index.js';
import { PipelineError, classifyAzureFailure, classifyNetworkError } from '../lib/errors.js';

/**
 * Azure Cognitive Services — Speech to Text.
 *
 * Plan doc, p.2: "Azure only does STT". Free tier is 5 audio hours/month, so the
 * QuotaManager gates every call before we get here.
 *
 * Uses the REST "short audio" endpoint rather than the browser SDK on purpose:
 * the plan's data flow is Phone → Backend → Speech API, and routing audio
 * through the backend is what keeps the subscription key off the device.
 */
export class AzureSttProvider implements SttProvider {
  readonly name = 'azure-stt' as const;
  readonly mode = 'real' as const;

  readonly #key: string;
  readonly #region: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: { key: string; region: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    if (!options.key) throw new Error('AzureSttProvider requires a subscription key');
    this.#key = options.key;
    this.#region = options.region;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  get endpoint(): string {
    return `https://${this.#region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`;
  }

  async recognize(input: {
    audio: Buffer;
    mimeType: string;
    languageCode: string;
    durationSeconds: number;
  }): Promise<SttResult> {
    const url = `${this.endpoint}?language=${encodeURIComponent(input.languageCode)}&format=detailed&profanity=raw`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': this.#key,
          'Content-Type': contentTypeFor(input.mimeType),
          Accept: 'application/json',
        },
        body: new Uint8Array(input.audio),
        signal: controller.signal,
      });
    } catch (err) {
      throw new PipelineError(classifyNetworkError(err), this.name, 'request failed');
    } finally {
      clearTimeout(timer);
    }

    const body = await safeJson(response);
    const failure = classifyAzureFailure(response.status, body);

    if (failure === 'no_match') {
      return { text: '', confidence: 0, status: 'no_match', durationSeconds: input.durationSeconds };
    }
    if (failure) {
      throw new PipelineError(failure, this.name, `HTTP ${response.status}`);
    }

    const best = body?.NBest?.[0];
    const text: string = best?.Display ?? body?.DisplayText ?? '';
    if (!text.trim()) {
      return { text: '', confidence: 0, status: 'no_match', durationSeconds: input.durationSeconds };
    }

    return {
      text,
      confidence: typeof best?.Confidence === 'number' ? best.Confidence : 0.85,
      status: 'recognized',
      // Azure reports ticks (100 ns units); prefer it over the client's claim.
      durationSeconds:
        typeof body?.Duration === 'number' ? body.Duration / 10_000_000 : input.durationSeconds,
    };
  }
}

/**
 * Offline STT used when no Azure key is configured, in tests, and in the demo
 * build. Deterministic: the same audio always yields the same transcript, which
 * is what makes the integration tests meaningful.
 */
export class MockSttProvider implements SttProvider {
  readonly name = 'azure-stt' as const;
  readonly mode = 'mock' as const;

  /** Phrases a first-time user is most likely to try, per language. */
  static readonly PHRASES: Record<string, string[]> = {
    ar: ['مرحبا، كيف حالك؟', 'أين أقرب مستشفى؟', 'أحتاج إلى مساعدة من فضلك', 'كم يكلف هذا؟', 'شكرا جزيلا لك'],
    en: ['Hello, how are you?', 'Where is the nearest hospital?', 'I need some help please', 'How much does this cost?', 'Thank you very much'],
    fr: ['Bonjour, comment allez-vous ?', "Où est l'hôpital le plus proche ?", "J'ai besoin d'aide s'il vous plaît"],
    es: ['Hola, ¿cómo estás?', '¿Dónde está el hospital más cercano?', 'Necesito ayuda por favor'],
  };

  async recognize(input: {
    audio: Buffer;
    mimeType: string;
    languageCode: string;
    durationSeconds: number;
  }): Promise<SttResult> {
    // Mirror the real provider: too little audio is silence, not speech.
    if (input.audio.byteLength <= 512 || input.durationSeconds < 0.35) {
      return { text: '', confidence: 0, status: 'no_match', durationSeconds: input.durationSeconds };
    }

    const base = input.languageCode.split('-')[0] ?? 'en';
    const phrases = MockSttProvider.PHRASES[base] ?? MockSttProvider.PHRASES.en!;
    // Deterministic pick driven by the audio itself.
    const index = checksum(input.audio) % phrases.length;
    return {
      text: phrases[index]!,
      confidence: 0.92,
      status: 'recognized',
      durationSeconds: input.durationSeconds,
    };
  }
}

function contentTypeFor(mimeType: string): string {
  // Azure's short-audio endpoint needs an explicit codec descriptor.
  if (/ogg|opus/i.test(mimeType)) return 'audio/ogg; codecs=opus';
  if (/webm/i.test(mimeType)) return 'audio/webm; codecs=opus';
  if (/mp3|mpeg/i.test(mimeType)) return 'audio/mpeg';
  return 'audio/wav; codecs=audio/pcm; samplerate=16000';
}

async function safeJson(response: Response): Promise<any | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function checksum(buffer: Buffer): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) sum = (sum + buffer[i]!) % 100_003;
  return sum;
}
