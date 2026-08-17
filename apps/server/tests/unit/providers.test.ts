import { describe, expect, it } from 'vitest';
import { MockSttProvider, WhisperSttProvider, isLikelyHallucination } from '../../src/services/stt.whisper.js';
import type { TranscribeFn } from '../../src/services/stt.whisper.js';
import {
  MYMEMORY_MAX_QUERY_CHARS,
  MockTranslateProvider,
  MyMemoryTranslateProvider,
  decodeEntities,
} from '../../src/services/translate.mymemory.js';
import { createProviders } from '../../src/services/providerFactory.js';
import { PipelineError } from '../../src/lib/errors.js';
import { loadConfig } from '../../src/lib/config.js';
import { silentWav, stubFetch, wavFixture, wrapWav } from '../helpers.js';

/** Builds a Whisper provider whose "model" is a stub — no download, no ONNX. */
function whisperWith(transcribe: TranscribeFn, options: { silenceThreshold?: number } = {}) {
  return new WhisperSttProvider({
    pipelineFactory: async () => transcribe,
    ...(options.silenceThreshold !== undefined ? { silenceThreshold: options.silenceThreshold } : {}),
  });
}

const speech = { mimeType: 'audio/wav', languageCode: 'ar', durationSeconds: 1.5 };

describe('WhisperSttProvider', () => {
  it('decodes WAV and returns the transcript', async () => {
    const provider = whisperWith(async () => ({ text: '  أين أقرب مستشفى؟  ' }));

    const result = await provider.recognize({ audio: wavFixture(), ...speech });

    expect(result.status).toBe('recognized');
    expect(result.text).toBe('أين أقرب مستشفى؟');
  });

  it('passes the ISO language code as the Whisper hint', async () => {
    const seen: Array<{ language?: string; task: string }> = [];
    const provider = whisperWith(async (_audio, opts) => {
      seen.push(opts);
      return { text: 'hello' };
    });

    await provider.recognize({ audio: wavFixture(), ...speech, languageCode: 'ar-SA' });

    // Whisper wants "ar", not the full BCP-47 tag.
    expect(seen[0]).toEqual({ language: 'ar', task: 'transcribe' });
  });

  it('hands Whisper 16 kHz mono float samples', async () => {
    let received: Float32Array | null = null;
    const provider = whisperWith(async (audio) => {
      received = audio;
      return { text: 'hello' };
    });

    await provider.recognize({ audio: wavFixture({ seconds: 2 }), ...speech });

    expect(received).toBeInstanceOf(Float32Array);
    expect(received!.length).toBeCloseTo(32_000, -2); // 2s × 16 kHz
  });

  it('resamples audio that arrives at the wrong rate', async () => {
    let received: Float32Array | null = null;
    const provider = whisperWith(async (audio) => {
      received = audio;
      return { text: 'hello' };
    });

    // 48 kHz in, 16 kHz out.
    await provider.recognize({ audio: wavFixture({ seconds: 1, sampleRate: 48_000 }), ...speech });

    expect(received!.length).toBeCloseTo(16_000, -2);
  });

  describe('silence handling', () => {
    /**
     * These two tests exist because of a measured behaviour, not a theory:
     * handed pure digital silence, whisper-base returns " you". Without the
     * energy gate the app would translate and speak a phantom word every time
     * the user paused.
     */
    it('never runs inference on silence', async () => {
      const transcribe = vi.fn(async () => ({ text: 'you' }));
      const provider = whisperWith(transcribe);

      const result = await provider.recognize({ audio: silentWav(), ...speech });

      expect(result.status).toBe('no_match');
      expect(transcribe).not.toHaveBeenCalled();
    });

    it('rejects a hallucinated word that survives the energy gate', async () => {
      // Real audio energy, but the model produced its silence filler anyway.
      const provider = whisperWith(async () => ({ text: ' you' }));

      const result = await provider.recognize({ audio: wavFixture(), ...speech });

      expect(result.status).toBe('no_match');
      expect(result.text).toBe('');
    });

    it('still transcribes very quiet but real speech', async () => {
      const provider = whisperWith(async () => ({ text: 'hello there' }), { silenceThreshold: 0.001 });

      const result = await provider.recognize({ audio: wavFixture({ amplitude: 0.02 }), ...speech });

      expect(result.status).toBe('recognized');
    });
  });

  describe('failures', () => {
    it('reports a non-WAV payload as a bad request', async () => {
      const provider = whisperWith(async () => ({ text: 'hello' }));

      await expect(
        provider.recognize({ audio: Buffer.from('this is not audio at all'), ...speech }),
      ).rejects.toMatchObject({ kind: 'bad_request', provider: 'whisper-stt' });
    });

    it('reports a model load failure as transient, so it can be retried', async () => {
      const provider = new WhisperSttProvider({
        pipelineFactory: async () => {
          throw new Error('failed to fetch model weights');
        },
      });

      await expect(provider.recognize({ audio: wavFixture(), ...speech })).rejects.toMatchObject({
        kind: 'transient',
      });
    });

    it('does not cache a failed load — the next request retries', async () => {
      let attempts = 0;
      const provider = new WhisperSttProvider({
        pipelineFactory: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('network blip');
          return async () => ({ text: 'recovered' });
        },
      });

      await expect(provider.recognize({ audio: wavFixture(), ...speech })).rejects.toBeInstanceOf(PipelineError);
      const result = await provider.recognize({ audio: wavFixture(), ...speech });

      expect(result.text).toBe('recovered');
      expect(attempts).toBe(2);
    });

    it('loads the model once for concurrent requests', async () => {
      let loads = 0;
      const provider = new WhisperSttProvider({
        pipelineFactory: async () => {
          loads += 1;
          await new Promise((r) => setTimeout(r, 10));
          return async () => ({ text: 'hello' });
        },
      });

      await Promise.all([
        provider.recognize({ audio: wavFixture(), ...speech }),
        provider.recognize({ audio: wavFixture(), ...speech }),
        provider.recognize({ audio: wavFixture(), ...speech }),
      ]);

      expect(loads).toBe(1);
    });

    it('wraps an inference error without leaking internals', async () => {
      const provider = whisperWith(async () => {
        throw new Error('onnxruntime tensor shape mismatch at node 47');
      });

      const error = (await provider.recognize({ audio: wavFixture(), ...speech }).catch((e: unknown) => e)) as PipelineError;

      expect(error.kind).toBe('unknown');
      expect(error.toResponse().error.message).not.toContain('onnxruntime');
    });
  });

  it('reports whether the model has been warmed', async () => {
    const provider = whisperWith(async () => ({ text: 'hello' }));
    expect(provider.warmed).toBe(false);

    await provider.warmup();

    expect(provider.warmed).toBe(true);
  });
});

describe('isLikelyHallucination', () => {
  it.each(['you', ' You ', 'Thank you.', 'Thanks for watching!', 'Amara.org', '♪♪', '...', 'شكرا'])(
    'rejects %j',
    (text) => {
      expect(isLikelyHallucination(text)).toBe(true);
    },
  );

  it.each(['Where is the hospital?', 'أين أقرب مستشفى؟', 'I need help', 'thank you for the directions'])(
    'accepts %j',
    (text) => {
      expect(isLikelyHallucination(text)).toBe(false);
    },
  );

  it('treats empty text as a hallucination rather than a transcript', () => {
    expect(isLikelyHallucination('   ')).toBe(true);
  });
});

describe('MyMemoryTranslateProvider', () => {
  const ok = (text: string, extra: Record<string, unknown> = {}) => ({
    responseStatus: 200,
    responseData: { translatedText: text, match: 1 },
    ...extra,
  });

  it('builds the documented GET request', async () => {
    const fetchImpl = stubFetch([{ status: 200, body: ok('مرحبا بالعالم') }]);
    const provider = new MyMemoryTranslateProvider({ fetchImpl });

    const result = await provider.translate({ text: 'Hello world', sourceLang: 'en', targetLang: 'ar' });

    const url = new URL(fetchImpl.calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.mymemory.translated.net/get');
    expect(url.searchParams.get('q')).toBe('Hello world');
    expect(url.searchParams.get('langpair')).toBe('en|ar');
    expect(result.text).toBe('مرحبا بالعالم');
    expect(result.billedChars).toBe('Hello world'.length);
  });

  it('adds the contact address when configured, to raise the daily allowance', async () => {
    const fetchImpl = stubFetch([{ status: 200, body: ok('مرحبا') }]);
    const provider = new MyMemoryTranslateProvider({ fetchImpl, email: 'me@example.com' });

    await provider.translate({ text: 'hi', sourceLang: 'en', targetLang: 'ar' });

    expect(new URL(fetchImpl.calls[0]!.url).searchParams.get('de')).toBe('me@example.com');
  });

  it('omits the address when none is set', async () => {
    const fetchImpl = stubFetch([{ status: 200, body: ok('مرحبا') }]);
    await new MyMemoryTranslateProvider({ fetchImpl }).translate({
      text: 'hi',
      sourceLang: 'en',
      targetLang: 'ar',
    });

    expect(new URL(fetchImpl.calls[0]!.url).searchParams.has('de')).toBe(false);
  });

  it('skips the network when both languages match', async () => {
    // MyMemory answers 403 "PLEASE SELECT TWO DISTINCT LANGUAGES" for this.
    const fetchImpl = stubFetch([{ status: 200, body: ok('x') }]);
    const provider = new MyMemoryTranslateProvider({ fetchImpl });

    const result = await provider.translate({ text: 'same', sourceLang: 'en', targetLang: 'en' });

    expect(result.text).toBe('same');
    expect(result.billedChars).toBe(0);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('reports the match score so a fuzzy hit can be flagged', async () => {
    const fetchImpl = stubFetch([
      { status: 200, body: { responseStatus: 200, responseData: { translatedText: 'roughly this', match: 0.42 } } },
    ]);
    const provider = new MyMemoryTranslateProvider({ fetchImpl });

    const result = await provider.translate({ text: 'hello', sourceLang: 'en', targetLang: 'ar' });

    expect(result.matchQuality).toBeCloseTo(0.42);
  });

  it('decodes HTML entities in the response', async () => {
    const fetchImpl = stubFetch([{ status: 200, body: ok('It&#39;s 5 &amp; 6') }]);
    const provider = new MyMemoryTranslateProvider({ fetchImpl });

    expect((await provider.translate({ text: 'x', sourceLang: 'en', targetLang: 'ar' })).text).toBe("It's 5 & 6");
  });

  /**
   * Captured from the live API: asking for "hello" in Arabic returned
   * `U+FEFC U+FEEB U+FE8D` — Arabic Presentation Forms rather than ordinary
   * letters. They render with broken joining and, since the browser now speaks
   * the translation, are mispronounced or skipped by speech synthesis.
   */
  it('normalises Arabic presentation forms back to standard letters', async () => {
    const presentationForms = 'ﻼﻫﺍ';
    const fetchImpl = stubFetch([{ status: 200, body: ok(presentationForms) }]);
    const provider = new MyMemoryTranslateProvider({ fetchImpl });

    const result = await provider.translate({ text: 'hello', sourceLang: 'en', targetLang: 'ar' });

    expect(result.text).toBe('لاها');
    // No codepoint may remain in the presentation-forms blocks.
    expect(/[ﭐ-﻿]/.test(result.text)).toBe(false);
  });

  it('leaves correctly-encoded Arabic untouched', async () => {
    const proper = 'أين أقرب مستشفى؟';
    const fetchImpl = stubFetch([{ status: 200, body: ok(proper) }]);

    const result = await new MyMemoryTranslateProvider({ fetchImpl }).translate({
      text: 'x',
      sourceLang: 'en',
      targetLang: 'ar',
    });

    expect(result.text).toBe(proper);
  });

  it('leaves Latin text untouched', async () => {
    const fetchImpl = stubFetch([{ status: 200, body: ok('Where is the nearest hospital?') }]);

    const result = await new MyMemoryTranslateProvider({ fetchImpl }).translate({
      text: 'x',
      sourceLang: 'ar',
      targetLang: 'en',
    });

    expect(result.text).toBe('Where is the nearest hospital?');
  });

  describe('failures that arrive as HTTP 200', () => {
    /**
     * Verified against the live API: MyMemory answers errors with HTTP 200 and
     * puts the real outcome in `responseStatus` — while echoing the error text
     * into `translatedText`. Trusting either field naively means showing the
     * user an error banner as their translation and reading it aloud.
     */
    it('rejects an over-length query locally, before spending a request', async () => {
      const fetchImpl = stubFetch([{ status: 200, body: ok('x') }]);
      const provider = new MyMemoryTranslateProvider({ fetchImpl });

      await expect(
        provider.translate({ text: 'x'.repeat(MYMEMORY_MAX_QUERY_CHARS + 1), sourceLang: 'en', targetLang: 'ar' }),
      ).rejects.toMatchObject({ kind: 'bad_request' });
      expect(fetchImpl.calls).toHaveLength(0);
    });

    it('never returns the length-limit banner as a translation', async () => {
      const banner = 'QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS';
      const fetchImpl = stubFetch([
        {
          status: 200,
          body: { responseStatus: 403, responseDetails: banner, responseData: { translatedText: banner } },
        },
      ]);
      const provider = new MyMemoryTranslateProvider({ fetchImpl });

      await expect(
        provider.translate({ text: 'hello', sourceLang: 'en', targetLang: 'ar' }),
      ).rejects.toMatchObject({ kind: 'bad_request' });
    });

    it('maps an invalid language pair to a bad request', async () => {
      const fetchImpl = stubFetch([
        {
          status: 200,
          body: { responseStatus: 403, responseDetails: "'ZZZ' IS AN INVALID TARGET LANGUAGE" },
        },
      ]);

      await expect(
        new MyMemoryTranslateProvider({ fetchImpl }).translate({ text: 'hi', sourceLang: 'en', targetLang: 'ar' }),
      ).rejects.toMatchObject({ kind: 'bad_request' });
    });

    it('maps the daily allowance warning to a quota stop', async () => {
      const fetchImpl = stubFetch([
        {
          status: 200,
          body: {
            responseStatus: 200,
            quotaFinished: true,
            responseData: {
              translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.',
            },
          },
        },
      ]);

      await expect(
        new MyMemoryTranslateProvider({ fetchImpl }).translate({ text: 'hi', sourceLang: 'en', targetLang: 'ar' }),
      ).rejects.toMatchObject({ kind: 'quota_exceeded' });
    });

    it('treats a 5xx as transient', async () => {
      const fetchImpl = stubFetch([{ status: 502, body: null }]);

      await expect(
        new MyMemoryTranslateProvider({ fetchImpl }).translate({ text: 'hi', sourceLang: 'en', targetLang: 'ar' }),
      ).rejects.toMatchObject({ kind: 'transient' });
    });

    it('treats a network failure as transient', async () => {
      const fetchImpl = stubFetch([{ status: 0, throws: new Error('fetch failed') }]);

      await expect(
        new MyMemoryTranslateProvider({ fetchImpl }).translate({ text: 'hi', sourceLang: 'en', targetLang: 'ar' }),
      ).rejects.toMatchObject({ kind: 'transient' });
    });

    it('throws rather than returning an empty translation', async () => {
      const fetchImpl = stubFetch([{ status: 200, body: { responseStatus: 200, responseData: {} } }]);

      await expect(
        new MyMemoryTranslateProvider({ fetchImpl }).translate({ text: 'hi', sourceLang: 'en', targetLang: 'ar' }),
      ).rejects.toBeInstanceOf(PipelineError);
    });
  });
});

describe('decodeEntities', () => {
  it('decodes &amp; last so "&amp;lt;" does not become "<"', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('mock providers', () => {
  it('MockStt returns no_match for silence-sized buffers', async () => {
    const result = await new MockSttProvider().recognize({
      audio: Buffer.alloc(64),
      mimeType: 'audio/wav',
      languageCode: 'ar',
      durationSeconds: 1,
    });

    expect(result.status).toBe('no_match');
  });

  it('MockStt is deterministic for the same audio', async () => {
    const provider = new MockSttProvider();
    const input = { audio: wavFixture(), mimeType: 'audio/wav', languageCode: 'ar', durationSeconds: 2 };

    const a = await provider.recognize(input);
    const b = await provider.recognize({ ...input, audio: wavFixture() });

    expect(a.text).toBe(b.text);
    expect(a.status).toBe('recognized');
  });

  it('MockTranslate uses its phrase book for known utterances', async () => {
    const result = await new MockTranslateProvider().translate({
      text: 'مرحبا، كيف حالك؟',
      sourceLang: 'ar',
      targetLang: 'en',
    });

    expect(result.text).toBe('Hello, how are you?');
  });
});

describe('createProviders', () => {
  it('defaults to the real providers — neither needs a credential', () => {
    const providers = createProviders(loadConfig({ PROVIDER_MODE: 'auto' } as NodeJS.ProcessEnv));

    expect(providers.stt.mode).toBe('real');
    expect(providers.stt.name).toBe('whisper-stt');
    expect(providers.translate.mode).toBe('real');
    expect(providers.translate.name).toBe('mymemory-translate');
  });

  it('honours PROVIDER_MODE=mock for offline work and tests', () => {
    const providers = createProviders(loadConfig({ PROVIDER_MODE: 'mock' } as NodeJS.ProcessEnv));

    expect(providers.stt.mode).toBe('mock');
    expect(providers.translate.mode).toBe('mock');
  });

  it('passes the configured Whisper model through', () => {
    const providers = createProviders(
      loadConfig({ PROVIDER_MODE: 'real', WHISPER_MODEL: 'onnx-community/whisper-tiny' } as NodeJS.ProcessEnv),
    );

    expect((providers.stt as WhisperSttProvider).model).toBe('onnx-community/whisper-tiny');
  });
});

describe('WAV fixtures', () => {
  it('wrapWav produces a parseable RIFF/WAVE header', () => {
    const wav = wrapWav(Buffer.alloc(320), 16_000);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
  });
});
