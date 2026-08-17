import type { TtsProvider, TtsResult } from '../types/index.js';
import { PipelineError, classifyGoogleFailure, classifyNetworkError } from '../lib/errors.js';

/**
 * Google Cloud Text-to-Speech.
 *
 * Plan doc, p.3: "Standard 4 million characters for free" — so we only ever ask
 * for Standard voices (see `lib/languages.ts`). Caching happens one layer up in
 * `pipeline.ts`; this class is a thin, cache-unaware transport.
 */
export class GoogleTtsProvider implements TtsProvider {
  readonly name = 'google-tts' as const;
  readonly mode = 'real' as const;

  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    if (!options.apiKey) throw new Error('GoogleTtsProvider requires an API key');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 12_000;
  }

  async synthesize(input: {
    text: string;
    languageCode: string;
    voiceName: string;
  }): Promise<TtsResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(this.#apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: { text: input.text },
            voice: { languageCode: input.languageCode, name: input.voiceName },
            audioConfig: {
              audioEncoding: 'MP3',
              speakingRate: 1.0,
              pitch: 0,
              // Small boost: phones get used in noisy places.
              effectsProfileId: ['handset-class-device'],
            },
          }),
          signal: controller.signal,
        },
      );
    } catch (err) {
      throw new PipelineError(classifyNetworkError(err), this.name, 'request failed');
    } finally {
      clearTimeout(timer);
    }

    const body = await safeJson(response);
    if (!response.ok) {
      throw new PipelineError(classifyGoogleFailure(response.status, body), this.name, `HTTP ${response.status}`);
    }
    if (!body?.audioContent) {
      throw new PipelineError('unknown', this.name, 'empty audio payload');
    }

    return {
      audioBase64: body.audioContent,
      mimeType: 'audio/mpeg',
      billedChars: input.text.length,
      cached: false,
    };
  }
}

/**
 * Offline TTS. Synthesises a real, playable WAV tone envelope so the client's
 * audio path (decode → play → waveform animation) can be exercised end to end
 * without a Google key.
 */
export class MockTtsProvider implements TtsProvider {
  readonly name = 'google-tts' as const;
  readonly mode = 'mock' as const;

  async synthesize(input: {
    text: string;
    languageCode: string;
    voiceName: string;
  }): Promise<TtsResult> {
    const seconds = Math.min(6, Math.max(0.6, input.text.length * 0.06));
    return {
      audioBase64: renderToneWav(seconds, input.text).toString('base64'),
      mimeType: 'audio/wav',
      billedChars: input.text.length,
      cached: false,
    };
  }
}

/**
 * Builds a 16-bit mono WAV whose pitch contour is derived from the text, so
 * different phrases sound different. Not speech — a stand-in with the right
 * shape for the UI to animate against.
 */
export function renderToneWav(seconds: number, seedText: string): Buffer {
  const sampleRate = 16_000;
  const frames = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(frames * 2);

  let seed = 0;
  for (let i = 0; i < seedText.length; i += 1) seed = (seed * 31 + seedText.charCodeAt(i)) % 997;
  const baseFreq = 150 + (seed % 120);

  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    // Syllable-rate amplitude modulation gives the waveform a speech-like look.
    const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.2 * t);
    const envelope = Math.min(1, t * 8) * Math.min(1, (seconds - t) * 8) * syllable;
    const vibrato = Math.sin(2 * Math.PI * 5 * t) * 6;
    const sample =
      Math.sin(2 * Math.PI * (baseFreq + vibrato) * t) * 0.6 +
      Math.sin(2 * Math.PI * (baseFreq * 2 + vibrato) * t) * 0.25;
    data.writeInt16LE(Math.round(sample * envelope * 12_000), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

async function safeJson(response: Response): Promise<any | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
