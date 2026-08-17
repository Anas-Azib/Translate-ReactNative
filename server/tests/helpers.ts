import type { AppConfig } from '../src/lib/config.js';
import { loadConfig } from '../src/lib/config.js';
import { FakeClock } from '../src/lib/clock.js';
import type {
  Providers,
  SttProvider,
  SttResult,
  TranslateProvider,
  TranslateResult,
  TtsProvider,
  TtsResult,
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
      globalMonthlyTranslatedChars: 5_000,
      globalMonthlyTtsChars: 5_000,
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

/** Programmable STT that records its calls. */
export class ScriptedStt implements SttProvider {
  readonly name = 'azure-stt' as const;
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
  readonly name = 'google-translate' as const;
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

export class ScriptedTts implements TtsProvider {
  readonly name = 'google-tts' as const;
  readonly mode = 'mock' as const;
  readonly calls: Array<{ text: string; languageCode: string }> = [];

  #queue: Array<TtsResult | Error> = [];

  queue(...results: Array<TtsResult | Error>): this {
    this.#queue.push(...results);
    return this;
  }

  async synthesize(input: { text: string; languageCode: string; voiceName: string }): Promise<TtsResult> {
    this.calls.push({ text: input.text, languageCode: input.languageCode });
    const next = this.#queue.shift();
    if (next instanceof Error) throw next;
    return {
      audioBase64: Buffer.from(`audio:${input.text}`).toString('base64'),
      mimeType: 'audio/mpeg',
      billedChars: input.text.length,
      cached: false,
    };
  }
}

export function scriptedProviders(): Providers & {
  stt: ScriptedStt;
  translate: ScriptedTranslate;
  tts: ScriptedTts;
} {
  return { stt: new ScriptedStt(), translate: new ScriptedTranslate(), tts: new ScriptedTts() };
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
