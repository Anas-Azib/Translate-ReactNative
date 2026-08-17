import type { AppConfig } from '../src/lib/config.js';
import { loadConfig } from '../src/lib/config.js';
import { FakeClock } from '../src/lib/clock.js';
import type {
  Providers,
  SttProvider,
  SttResult,
  TranslateProvider,
  TranslateResult,
} from '../src/types/index.js';

/** Base config for tests: small limits so ceilings are reachable in a few calls. */
export function testConfig(overrides: Partial<AppConfig['quota']> = {}): AppConfig {
  const config = loadConfig({
    NODE_ENV: 'test',
    PROVIDER_MODE: 'mock',
    AB_SALT: 'test-salt',
    PAYLOAD_ENCRYPTION_KEY: 'a'.repeat(64),
  } as NodeJS.ProcessEnv);

  return {
    ...config,
    quota: {
      ...config.quota,
      dailySeconds: 60,
      monthlySeconds: 600,
      sessionSeconds: 20,
      maxConcurrentPerUser: 1,
      maxConcurrentGlobal: 3,
      globalDailySeconds: 300,
      maxCharsPerTranslation: 100,
      maxAudioBytes: 500_000,
      globalDailyTranslatedChars: 5_000,
      sessionIdleTimeoutSeconds: 60,
      ...overrides,
    },
  };
}

export { FakeClock };

/** Audio that comfortably passes the server's silence floor. */
export function fakeAudio(bytes = 4096): Buffer {
  const buffer = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 1) buffer[i] = (i * 7) % 251;
  return buffer;
}

/**
 * A real 16 kHz mono WAV containing a speech-like tone. Needed wherever the
 * code under test actually decodes the audio rather than just measuring it.
 */
export function wavFixture(options: { seconds?: number; amplitude?: number; sampleRate?: number } = {}): Buffer {
  const sampleRate = options.sampleRate ?? 16_000;
  const seconds = options.seconds ?? 1.5;
  const amplitude = options.amplitude ?? 0.35;
  const frames = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(frames * 2);

  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    // Syllable-rate modulation so the clip reads as speech to an energy gate.
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.5 * t);
    const sample = (Math.sin(2 * Math.PI * 190 * t) * 0.7 + Math.sin(2 * Math.PI * 380 * t) * 0.3) * envelope;
    data.writeInt16LE(Math.round(sample * amplitude * 32_767), i * 2);
  }

  return wrapWav(data, sampleRate);
}

/** Digital silence in a valid WAV container. */
export function silentWav(seconds = 1.5, sampleRate = 16_000): Buffer {
  return wrapWav(Buffer.alloc(Math.floor(sampleRate * seconds) * 2), sampleRate);
}

export function wrapWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2 * channels, 28);
  header.writeUInt16LE(2 * channels, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Programmable STT that records its calls. */
export class ScriptedStt implements SttProvider {
  readonly name = 'whisper-stt' as const;
  readonly mode = 'mock' as const;
  readonly calls: Array<{ languageCode: string; bytes: number }> = [];

  #queue: Array<SttResult | Error> = [];
  #fallback: SttResult = { text: 'hello world', confidence: 0.9, status: 'recognized', durationSeconds: 2 };

  constructor(fallback?: Partial<SttResult>) {
    if (fallback) this.#fallback = { ...this.#fallback, ...fallback };
  }

  queue(...results: Array<SttResult | Error>): this {
    this.#queue.push(...results);
    return this;
  }

  async recognize(input: { audio: Buffer; languageCode: string; durationSeconds: number }): Promise<SttResult> {
    this.calls.push({ languageCode: input.languageCode, bytes: input.audio.byteLength });
    const next = this.#queue.shift();
    if (next instanceof Error) throw next;
    return next ?? { ...this.#fallback, durationSeconds: input.durationSeconds };
  }
}

export class ScriptedTranslate implements TranslateProvider {
  readonly name = 'mymemory-translate' as const;
  readonly mode = 'mock' as const;
  readonly calls: Array<{ text: string; sourceLang: string; targetLang: string }> = [];

  #queue: Array<TranslateResult | Error> = [];

  queue(...results: Array<TranslateResult | Error>): this {
    this.#queue.push(...results);
    return this;
  }

  async translate(input: { text: string; sourceLang: string; targetLang: string }): Promise<TranslateResult> {
    this.calls.push(input);
    const next = this.#queue.shift();
    if (next instanceof Error) throw next;
    return next ?? { text: `[${input.targetLang}] ${input.text}`, billedChars: input.text.length };
  }
}

export function scriptedProviders(): Providers & {
  stt: ScriptedStt;
  translate: ScriptedTranslate;
} {
  return { stt: new ScriptedStt(), translate: new ScriptedTranslate() };
}

/** Minimal `fetch` double for provider unit tests. */
export function stubFetch(
  responses: Array<{ status: number; body?: unknown; throws?: Error }>,
): typeof fetch & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;

  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error('stubFetch: no response configured');
    if (next.throws) throw next.throws;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body ?? null,
    } as Response;
  }) as unknown as typeof fetch & { calls: typeof calls };

  (impl as any).calls = calls;
  return impl;
}
