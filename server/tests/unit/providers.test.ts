import { describe, expect, it } from 'vitest';
import { AzureSttProvider, MockSttProvider } from '../../src/services/stt.azure.js';
import {
  GoogleTranslateProvider,
  MockTranslateProvider,
  decodeEntities,
} from '../../src/services/translate.google.js';
import { GoogleTtsProvider, MockTtsProvider, renderToneWav } from '../../src/services/tts.google.js';
import { createProviders } from '../../src/services/providerFactory.js';
import { PipelineError } from '../../src/lib/errors.js';
import { loadConfig } from '../../src/lib/config.js';
import { fakeAudio, stubFetch } from '../helpers.js';

describe('AzureSttProvider', () => {
  const base = { audio: fakeAudio(), mimeType: 'audio/webm', languageCode: 'ar-SA', durationSeconds: 2 };

  it('sends the subscription key in the header and never in the URL', async () => {
    const fetchImpl = stubFetch([
      { status: 200, body: { RecognitionStatus: 'Success', NBest: [{ Display: 'مرحبا', Confidence: 0.94 }] } },
    ]);
    const provider = new AzureSttProvider({ key: 'secret-key', region: 'westeurope', fetchImpl });

    await provider.recognize(base);

    const call = fetchImpl.calls[0]!;
    expect(call.url).not.toContain('secret-key');
    expect((call.init?.headers as Record<string, string>)['Ocp-Apim-Subscription-Key']).toBe('secret-key');
    expect(call.url).toContain('language=ar-SA');
  });

  it('returns the best transcript with its confidence', async () => {
    const fetchImpl = stubFetch([
      {
        status: 200,
        body: {
          RecognitionStatus: 'Success',
          NBest: [{ Display: 'Where is the hospital?', Confidence: 0.88 }],
          Duration: 25_000_000, // ticks → 2.5s
        },
      },
    ]);
    const provider = new AzureSttProvider({ key: 'k', region: 'r', fetchImpl });

    const result = await provider.recognize(base);

    expect(result.text).toBe('Where is the hospital?');
    expect(result.confidence).toBeCloseTo(0.88);
    // Azure's own duration wins over the client's claim — it is what gets billed.
    expect(result.durationSeconds).toBe(2.5);
  });

  it('maps NoMatch to a no_speech result rather than throwing', async () => {
    const fetchImpl = stubFetch([{ status: 200, body: { RecognitionStatus: 'NoMatch' } }]);
    const provider = new AzureSttProvider({ key: 'k', region: 'r', fetchImpl });

    const result = await provider.recognize(base);

    expect(result.status).toBe('no_match');
    expect(result.text).toBe('');
  });

  it('treats an empty transcript on a 200 as no speech', async () => {
    const fetchImpl = stubFetch([{ status: 200, body: { RecognitionStatus: 'Success', DisplayText: '   ' } }]);
    const provider = new AzureSttProvider({ key: 'k', region: 'r', fetchImpl });

    expect((await provider.recognize(base)).status).toBe('no_match');
  });

  it.each([
    [401, 'auth_failure'],
    [429, 'quota_exceeded'],
    [400, 'bad_request'],
    [503, 'transient'],
  ])('throws a classified PipelineError for HTTP %i', async (status, kind) => {
    const fetchImpl = stubFetch([{ status, body: {} }]);
    const provider = new AzureSttProvider({ key: 'k', region: 'r', fetchImpl });

    await expect(provider.recognize(base)).rejects.toMatchObject({ kind, provider: 'azure-stt' });
  });

  it('classifies a network failure as transient', async () => {
    const fetchImpl = stubFetch([{ status: 0, throws: new Error('fetch failed') }]);
    const provider = new AzureSttProvider({ key: 'k', region: 'r', fetchImpl });

    await expect(provider.recognize(base)).rejects.toMatchObject({ kind: 'transient' });
  });

  it('refuses to construct without a key', () => {
    expect(() => new AzureSttProvider({ key: '', region: 'r' })).toThrow(/subscription key/);
  });
});

describe('GoogleTranslateProvider', () => {
  it('requests the NMT model and reports billed characters', async () => {
    const fetchImpl = stubFetch([
      { status: 200, body: { data: { translations: [{ translatedText: 'Hello', detectedSourceLanguage: 'ar' }] } } },
    ]);
    const provider = new GoogleTranslateProvider({ apiKey: 'key', fetchImpl });

    const result = await provider.translate({ text: 'مرحبا', sourceLang: 'ar', targetLang: 'en' });

    expect(result.text).toBe('Hello');
    expect(result.billedChars).toBe('مرحبا'.length);
    expect(JSON.parse(String(fetchImpl.calls[0]!.init!.body)).model).toBe('nmt');
  });

  it('skips the network entirely when source and target match', async () => {
    const fetchImpl = stubFetch([{ status: 200, body: {} }]);
    const provider = new GoogleTranslateProvider({ apiKey: 'key', fetchImpl });

    const result = await provider.translate({ text: 'same', sourceLang: 'en', targetLang: 'en' });

    expect(result.billedChars).toBe(0);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('decodes the HTML entities Google returns even in text mode', async () => {
    const fetchImpl = stubFetch([
      { status: 200, body: { data: { translations: [{ translatedText: 'It&#39;s 5 &amp; 6' }] } } },
    ]);
    const provider = new GoogleTranslateProvider({ apiKey: 'key', fetchImpl });

    expect((await provider.translate({ text: 'x', sourceLang: 'ar', targetLang: 'en' })).text).toBe("It's 5 & 6");
  });

  it('maps a quota response onto quota_exceeded', async () => {
    const fetchImpl = stubFetch([
      { status: 403, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } },
    ]);
    const provider = new GoogleTranslateProvider({ apiKey: 'key', fetchImpl });

    await expect(
      provider.translate({ text: 'hi', sourceLang: 'ar', targetLang: 'en' }),
    ).rejects.toMatchObject({ kind: 'quota_exceeded', provider: 'google-translate' });
  });

  it('throws rather than returning an empty translation', async () => {
    const fetchImpl = stubFetch([{ status: 200, body: { data: { translations: [] } } }]);
    const provider = new GoogleTranslateProvider({ apiKey: 'key', fetchImpl });

    await expect(provider.translate({ text: 'hi', sourceLang: 'ar', targetLang: 'en' })).rejects.toBeInstanceOf(
      PipelineError,
    );
  });
});

describe('decodeEntities', () => {
  it('decodes &amp; last so "&amp;lt;" does not become "<"', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('GoogleTtsProvider', () => {
  it('requests a Standard voice and MP3 audio', async () => {
    const fetchImpl = stubFetch([{ status: 200, body: { audioContent: 'AAAA' } }]);
    const provider = new GoogleTtsProvider({ apiKey: 'key', fetchImpl });

    const result = await provider.synthesize({
      text: 'Hello',
      languageCode: 'en-US',
      voiceName: 'en-US-Standard-C',
    });

    const body = JSON.parse(String(fetchImpl.calls[0]!.init!.body));
    expect(body.voice.name).toBe('en-US-Standard-C');
    expect(body.audioConfig.audioEncoding).toBe('MP3');
    expect(result.billedChars).toBe(5);
    expect(result.cached).toBe(false);
  });

  it('maps a 401 onto auth_failure', async () => {
    const fetchImpl = stubFetch([{ status: 401, body: {} }]);
    const provider = new GoogleTtsProvider({ apiKey: 'bad', fetchImpl });

    await expect(
      provider.synthesize({ text: 'x', languageCode: 'en-US', voiceName: 'v' }),
    ).rejects.toMatchObject({ kind: 'auth_failure' });
  });
});

describe('mock providers', () => {
  it('MockStt returns no_match for silence-sized buffers', async () => {
    const provider = new MockSttProvider();
    const result = await provider.recognize({
      audio: Buffer.alloc(64),
      mimeType: 'audio/webm',
      languageCode: 'ar-SA',
      durationSeconds: 1,
    });

    expect(result.status).toBe('no_match');
  });

  it('MockStt is deterministic for the same audio', async () => {
    const provider = new MockSttProvider();
    const input = { audio: fakeAudio(), mimeType: 'audio/webm', languageCode: 'ar-SA', durationSeconds: 2 };

    const a = await provider.recognize(input);
    const b = await provider.recognize({ ...input, audio: fakeAudio() });

    expect(a.text).toBe(b.text);
    expect(a.status).toBe('recognized');
  });

  it('MockTranslate uses its phrase book for known utterances', async () => {
    const provider = new MockTranslateProvider();
    const result = await provider.translate({ text: 'مرحبا، كيف حالك؟', sourceLang: 'ar', targetLang: 'en' });

    expect(result.text).toBe('Hello, how are you?');
  });

  it('MockTts produces a decodable WAV', async () => {
    const provider = new MockTtsProvider();
    const result = await provider.synthesize({ text: 'Hello', languageCode: 'en-US', voiceName: 'v' });

    const buffer = Buffer.from(result.audioBase64, 'base64');
    expect(buffer.subarray(0, 4).toString()).toBe('RIFF');
    expect(buffer.subarray(8, 12).toString()).toBe('WAVE');
  });

  it('renderToneWav length tracks the requested duration', () => {
    const oneSecond = renderToneWav(1, 'x');
    const twoSeconds = renderToneWav(2, 'x');
    expect(twoSeconds.length).toBeGreaterThan(oneSecond.length * 1.9);
  });
});

describe('createProviders', () => {
  it('falls back to mocks when no keys are configured', () => {
    const config = loadConfig({ PROVIDER_MODE: 'auto' } as NodeJS.ProcessEnv);
    const providers = createProviders(config);

    expect(providers.stt.mode).toBe('mock');
    expect(providers.translate.mode).toBe('mock');
    expect(providers.tts.mode).toBe('mock');
  });

  it('mixes real and mock per service based on which keys exist', () => {
    const config = loadConfig({
      PROVIDER_MODE: 'auto',
      GOOGLE_API_KEY: 'google-key',
    } as NodeJS.ProcessEnv);
    const providers = createProviders(config);

    expect(providers.stt.mode).toBe('mock'); // no Azure key
    expect(providers.translate.mode).toBe('real');
    expect(providers.tts.mode).toBe('real');
  });

  it('forces mocks when PROVIDER_MODE=mock even with keys present', () => {
    const config = loadConfig({
      PROVIDER_MODE: 'mock',
      AZURE_SPEECH_KEY: 'k',
      GOOGLE_API_KEY: 'g',
    } as NodeJS.ProcessEnv);

    expect(createProviders(config).translate.mode).toBe('mock');
  });
});
