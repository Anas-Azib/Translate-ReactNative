import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.js';
import { QuotaManager } from '../../src/usage/quotaManager.js';
import { TranslationPipeline } from '../../src/services/pipeline.js';
import { ExperimentStore } from '../../src/experiments/store.js';
import { PipelineError } from '../../src/lib/errors.js';
import { FakeClock, fakeAudio, scriptedProviders, testConfig } from '../helpers.js';

/**
 * End-to-end through the real Express app: routing, validation, quota
 * middleware, pipeline, and error mapping all together. Only the three external
 * providers are doubled.
 */
describe('API integration', () => {
  const DEVICE = 'device-integration-0001';
  const config = testConfig();

  let app: Express;
  let clock: FakeClock;
  let quota: QuotaManager;
  let providers: ReturnType<typeof scriptedProviders>;
  let pipeline: TranslationPipeline;
  let experiments: ExperimentStore;

  beforeEach(() => {
    clock = new FakeClock();
    providers = scriptedProviders();
    quota = new QuotaManager({ quota: config.quota, clock });
    pipeline = new TranslationPipeline({ providers, quota, config, clock });
    experiments = new ExperimentStore({ clock });
    app = createApp({ config, clock, providers, quota, pipeline, experiments }).app;
  });

  const startSession = async (device = DEVICE): Promise<string> => {
    const response = await request(app).post('/api/session/start').set('x-device-id', device).expect(201);
    return response.body.sessionId;
  };

  const postSegment = (sessionId: string, options: Record<string, string> = {}, device = DEVICE) => {
    const req = request(app)
      .post('/api/translate/segment')
      .set('x-device-id', device)
      .field('sessionId', sessionId)
      .field('sourceLang', options.sourceLang ?? 'ar-SA')
      .field('targetLang', options.targetLang ?? 'en-US')
      .field('durationSeconds', options.durationSeconds ?? '2');

    if (options.previousText) req.field('previousText', options.previousText);
    if (options.speak) req.field('speak', options.speak);

    return req.attach('audio', fakeAudio(), { filename: 'segment.webm', contentType: 'audio/webm' });
  };

  describe('discovery', () => {
    it('reports healthy with the active provider modes', async () => {
      const response = await request(app).get('/api/health').expect(200);

      expect(response.body.status).toBe('healthy');
      expect(response.body.providers.stt.name).toBe('azure-stt');
    });

    it('serves languages and limits, and leaks no credentials', async () => {
      const response = await request(app).get('/api/config').set('x-device-id', DEVICE).expect(200);

      expect(response.body.languages.length).toBeGreaterThan(5);
      expect(response.body.defaults.source).toBe('ar-SA');
      expect(response.body.limits.sessionSeconds).toBe(20);

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toMatch(/apiKey|api_key|subscription|AZURE_SPEECH_KEY|GOOGLE_/i);
    });

    it('404s an unknown API route with the standard error shape', async () => {
      const response = await request(app).get('/api/nope').expect(404);
      expect(response.body.ok).toBe(false);
      expect(response.body.error.kind).toBe('bad_request');
    });
  });

  describe('session lifecycle', () => {
    it('starts a session and returns the initial budget', async () => {
      const response = await request(app).post('/api/session/start').set('x-device-id', DEVICE).expect(201);

      expect(response.body.sessionId).toBeTruthy();
      expect(response.body.quota.sessionSecondsLimit).toBe(20);
      expect(response.body.quota.sessionEnded).toBe(false);
    });

    it('refuses a second concurrent session from the same device', async () => {
      await startSession();
      const response = await request(app).post('/api/session/start').set('x-device-id', DEVICE).expect(429);

      expect(response.body.error.kind).toBe('internal_quota_exceeded');
      expect(response.body.error.message).toMatch(/another device/i);
    });

    it('allows a different device to start its own session', async () => {
      await startSession('device-a-0000001');
      await request(app).post('/api/session/start').set('x-device-id', 'device-b-0000001').expect(201);
    });

    it('stops a session on request', async () => {
      const sessionId = await startSession();
      const response = await request(app)
        .post(`/api/session/${sessionId}/stop`)
        .set('x-device-id', DEVICE)
        .expect(200);

      expect(response.body.quota.sessionEnded).toBe(true);
    });

    it('will not let one device touch another device’s session', async () => {
      const sessionId = await startSession('device-owner-001');

      await request(app)
        .post(`/api/session/${sessionId}/stop`)
        .set('x-device-id', 'device-attacker-1')
        .expect(429);
    });
  });

  describe('the full translation flow', () => {
    it('returns recognised text, translation, and audio in one response', async () => {
      const sessionId = await startSession();
      const response = await postSegment(sessionId).expect(200);

      expect(response.body.status).toBe('recognized');
      expect(response.body.segment.sourceText).toBe('hello world');
      expect(response.body.segment.translatedText).toBe('[en] hello world');
      expect(response.body.segment.audioBase64).toBeTruthy();
      expect(response.body.quota.sessionSecondsUsed).toBe(2);
    });

    it('routes audio through the backend — the client never talks to Azure', async () => {
      const sessionId = await startSession();
      await postSegment(sessionId).expect(200);

      expect(providers.stt.calls).toHaveLength(1);
      expect(providers.stt.calls[0]!.bytes).toBeGreaterThan(1000);
    });

    it('accumulates budget across several segments', async () => {
      const sessionId = await startSession();

      await postSegment(sessionId, { durationSeconds: '3' }).expect(200);
      const second = await postSegment(sessionId, { durationSeconds: '4', previousText: 'hello world' });

      expect(second.body.quota.sessionSecondsUsed).toBe(7);
    });

    it('reports "No speech recognized" for silence without spending anything', async () => {
      const sessionId = await startSession();
      const response = await postSegment(sessionId, { durationSeconds: '0.1' }).expect(200);

      expect(response.body.status).toBe('no_speech');
      expect(response.body.message).toBe('No speech recognized');
      expect(providers.stt.calls).toHaveLength(0);
    });

    it('serves a repeated phrase from the TTS cache', async () => {
      const sessionId = await startSession();
      await postSegment(sessionId).expect(200);
      const second = await postSegment(sessionId).expect(200);

      expect(second.body.segment.ttsCached).toBe(true);
      expect(providers.tts.calls).toHaveLength(1);
    });

    it('synthesises on demand via /translate/speak', async () => {
      const sessionId = await startSession();
      const response = await request(app)
        .post('/api/translate/speak')
        .set('x-device-id', DEVICE)
        .send({ sessionId, text: 'Hello there', targetLang: 'en-US' })
        .expect(200);

      expect(response.body.audioBase64).toBeTruthy();
      expect(response.body.mimeType).toBe('audio/mpeg');
    });
  });

  describe('input validation', () => {
    it('rejects a request with no audio attached', async () => {
      const sessionId = await startSession();
      const response = await request(app)
        .post('/api/translate/segment')
        .set('x-device-id', DEVICE)
        .field('sessionId', sessionId)
        .field('sourceLang', 'ar-SA')
        .field('targetLang', 'en-US')
        .field('durationSeconds', '2')
        .expect(400);

      expect(response.body.error.kind).toBe('bad_request');
      expect(response.body.error.retryable).toBe(false);
    });

    it('rejects an unsupported language', async () => {
      const sessionId = await startSession();
      await postSegment(sessionId, { targetLang: 'xx-XX' }).expect(400);
    });

    it('rejects an unknown session id', async () => {
      await postSegment('00000000-0000-0000-0000-000000000000').expect(429);
    });

    it('rejects a malformed speak payload', async () => {
      const sessionId = await startSession();
      await request(app)
        .post('/api/translate/speak')
        .set('x-device-id', DEVICE)
        .send({ sessionId, targetLang: 'en-US' }) // no text
        .expect(400);
    });
  });

  describe('provider failure behaviour reaches the client correctly', () => {
    it('returns 502 and the documented message on an auth failure', async () => {
      providers.stt.queue(new PipelineError('auth_failure', 'azure-stt'));
      const sessionId = await startSession();

      const response = await postSegment(sessionId).expect(502);

      expect(response.body.error.message).toBe('Speech service authentication failed.');
      expect(response.body.error.retryable).toBe(false);
      expect(response.body.error.haltProvider).toBe(true);
    });

    it('returns 429 and stops further calls after a provider quota stop', async () => {
      providers.translate.queue(new PipelineError('quota_exceeded', 'google-translate'));
      const sessionId = await startSession();

      const first = await postSegment(sessionId).expect(429);
      expect(first.body.error.message).toMatch(/service limit was reached/i);

      // Second attempt must be refused locally, without a provider call.
      const callsBefore = providers.translate.calls.length;
      await postSegment(sessionId, { previousText: 'x' }).expect(429);
      expect(providers.translate.calls).toHaveLength(callsBefore);
    });

    it('marks a transient failure retryable so the client may try again', async () => {
      providers.tts.queue(new PipelineError('transient', 'google-tts'));
      const sessionId = await startSession();

      const response = await postSegment(sessionId).expect(503);

      expect(response.body.error.retryable).toBe(true);
      expect(response.body.error.haltProvider).toBe(false);
    });

    it('never exposes upstream error detail to the client', async () => {
      providers.stt.queue(new PipelineError('auth_failure', 'azure-stt', 'key sk-live-abc123 rejected'));
      const sessionId = await startSession();

      const response = await postSegment(sessionId).expect(502);

      expect(JSON.stringify(response.body)).not.toContain('sk-live-abc123');
    });
  });

  describe('quota enforcement over HTTP', () => {
    it('auto-stops the session at the limit and refuses further segments', async () => {
      const sessionId = await startSession();

      await postSegment(sessionId, { durationSeconds: '10' }).expect(200);
      const second = await postSegment(sessionId, { durationSeconds: '10', previousText: 'hello world' });

      expect(second.body.quota.sessionEnded).toBe(true);
      expect(second.body.quota.endedReason).toBe('session_limit');

      const third = await postSegment(sessionId, { previousText: 'x' }).expect(429);
      expect(third.body.error.message).toMatch(/begin a new one/i);
    });

    it('lets the user start a new session after the limit, keeping daily usage', async () => {
      const first = await startSession();
      await postSegment(first, { durationSeconds: '20' }).expect(200);

      const response = await request(app).post('/api/session/start').set('x-device-id', DEVICE).expect(201);

      expect(response.body.quota.sessionSecondsUsed).toBe(0);
      expect(response.body.quota.dailySecondsUsed).toBe(20);
    });

    it('blocks a new session once the daily budget is gone', async () => {
      for (let i = 0; i < 3; i += 1) {
        const sessionId = await startSession();
        await postSegment(sessionId, { durationSeconds: '20', previousText: `unique-${i}` }).expect(200);
      }

      const response = await request(app).post('/api/session/start').set('x-device-id', DEVICE).expect(429);
      expect(response.body.error.message).toMatch(/today/i);
    });

    it('rejects an oversized upload', async () => {
      const sessionId = await startSession();
      const huge = Buffer.alloc(600_000, 1); // cap is 500k

      const response = await request(app)
        .post('/api/translate/segment')
        .set('x-device-id', DEVICE)
        .field('sessionId', sessionId)
        .field('sourceLang', 'ar-SA')
        .field('targetLang', 'en-US')
        .field('durationSeconds', '2')
        .attach('audio', huge, { filename: 'big.webm', contentType: 'audio/webm' })
        .expect(400);

      expect(response.body.error.kind).toBe('bad_request');
      expect(providers.stt.calls).toHaveLength(0);
    });
  });

  describe('operational metrics', () => {
    it('exposes global usage and budget headroom for alerting', async () => {
      const sessionId = await startSession();
      await postSegment(sessionId).expect(200);

      const response = await request(app).get('/api/metrics').expect(200);

      expect(response.body.global.daily.audioSeconds).toBe(2);
      expect(response.body.budget.translatedCharsLimit).toBe(5000);
      expect(response.body.budget.ttsCharsUsed).toBeGreaterThan(0);
      expect(response.body.pendingAudioBuffers).toBe(0);
    });

    it('reports the TTS cache hit rate', async () => {
      const sessionId = await startSession();
      await postSegment(sessionId).expect(200);
      await postSegment(sessionId).expect(200);

      const response = await request(app).get('/api/metrics').expect(200);
      expect(response.body.ttsCache.hits).toBe(1);
    });

    it('lists halted providers so an operator can see a stop', async () => {
      providers.stt.queue(new PipelineError('quota_exceeded', 'azure-stt'));
      const sessionId = await startSession();
      await postSegment(sessionId).expect(429);

      const response = await request(app).get('/api/health').expect(200);
      expect(response.body.haltedProviders).toEqual([{ provider: 'azure-stt', kind: 'quota_exceeded' }]);
    });
  });

  describe('privacy', () => {
    it('never echoes the raw device id back to the client', async () => {
      const sessionId = await startSession();
      const response = await postSegment(sessionId).expect(200);

      expect(JSON.stringify(response.body)).not.toContain(DEVICE);
    });

    it('gives two devices independent usage counters', async () => {
      const a = await startSession('device-alpha-0001');
      await postSegment(a, { durationSeconds: '5' }, 'device-alpha-0001').expect(200);

      const response = await request(app)
        .get('/api/usage')
        .set('x-device-id', 'device-beta-00001')
        .expect(200);

      expect(response.body.user.daily.audioSeconds).toBe(0);
    });
  });
});
