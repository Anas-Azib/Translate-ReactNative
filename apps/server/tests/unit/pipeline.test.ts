import { describe, expect, it, beforeEach } from 'vitest';
import { TranslationPipeline } from '../../src/services/pipeline.js';
import { ProviderCircuit } from '../../src/services/circuit.js';
import { QuotaManager } from '../../src/usage/quotaManager.js';
import { PipelineError } from '../../src/lib/errors.js';
import { FakeClock, fakeAudio, scriptedProviders, testConfig } from '../helpers.js';

describe('TranslationPipeline', () => {
  const config = testConfig();
  let clock: FakeClock;
  let quota: QuotaManager;
  let providers: ReturnType<typeof scriptedProviders>;
  let pipeline: TranslationPipeline;
  let sessionId: string;

  beforeEach(() => {
    clock = new FakeClock();
    quota = new QuotaManager({ quota: config.quota, clock });
    providers = scriptedProviders();
    pipeline = new TranslationPipeline({ providers, quota, config, clock });
    sessionId = quota.startSession('user-1').session.id;
  });

  const segment = (overrides: Partial<Parameters<typeof pipeline.translateSegment>[0]> = {}) =>
    pipeline.translateSegment({
      sessionId,
      audio: fakeAudio(),
      mimeType: 'audio/wav',
      durationSeconds: 2,
      sourceLang: 'ar-SA',
      targetLang: 'en-US',
      ...overrides,
    });

  describe('the happy path', () => {
    it('runs recognition then translation and returns a full segment', async () => {
      const outcome = await segment();

      expect(outcome.status).toBe('recognized');
      if (outcome.status !== 'recognized') return;

      expect(outcome.segment.sourceText).toBe('hello world');
      expect(outcome.segment.translatedText).toBe('[en] hello world');
      expect(providers.stt.calls).toHaveLength(1);
      expect(providers.translate.calls).toHaveLength(1);
    });

    it('returns text only — speech is synthesised on the device', async () => {
      const outcome = await segment();

      expect(outcome.status).toBe('recognized');
      if (outcome.status !== 'recognized') return;
      // No audio payload of any kind travels back to the client.
      expect(JSON.stringify(outcome.segment)).not.toMatch(/audio(Base64|Content)|"data:/i);
    });

    it('gives each provider the code it expects', async () => {
      await segment({ sourceLang: 'ar-SA', targetLang: 'fr-FR' });

      // Whisper takes an ISO-639-1 hint, and so does MyMemory's langpair.
      expect(providers.stt.calls[0]!.languageCode).toBe('ar');
      expect(providers.translate.calls[0]).toMatchObject({ sourceLang: 'ar', targetLang: 'fr' });
    });

    it('records the audio time and characters against the session', async () => {
      await segment({ durationSeconds: 3 });

      expect(quota.snapshot(sessionId).sessionSecondsUsed).toBe(3);
      expect(quota.userUsage('user-1').daily.translatedChars).toBe('hello world'.length);
    });

    it('passes a MyMemory match score through to the segment', async () => {
      providers.translate.queue({ text: 'roughly this', billedChars: 5, matchQuality: 0.4 });

      const outcome = await segment();

      expect(outcome.status).toBe('recognized');
      if (outcome.status !== 'recognized') return;
      expect(outcome.segment.matchQuality).toBeCloseTo(0.4);
    });

    it('deletes the encrypted audio buffer once the request finishes', async () => {
      await segment();
      expect(pipeline.pendingAudioBuffers).toBe(0);
    });

    it('deletes the buffer even when a provider throws', async () => {
      providers.stt.queue(new PipelineError('transient', 'whisper-stt'));

      await expect(segment()).rejects.toBeInstanceOf(PipelineError);
      expect(pipeline.pendingAudioBuffers).toBe(0);
    });
  });

  describe('silence and no-speech handling', () => {
    it('rejects sub-threshold audio before running the model', async () => {
      const outcome = await segment({ durationSeconds: 0.1 });

      expect(outcome.status).toBe('no_speech');
      expect(providers.stt.calls).toHaveLength(0); // no CPU spent
    });

    it('rejects a near-empty buffer without running the model', async () => {
      const outcome = await segment({ audio: Buffer.alloc(100) });

      expect(outcome.status).toBe('no_speech');
      expect(providers.stt.calls).toHaveLength(0);
    });

    it('reports no speech when the recogniser finds none', async () => {
      providers.stt.queue({ text: '', confidence: 0, status: 'no_match', durationSeconds: 2 });

      const outcome = await segment();

      expect(outcome.status).toBe('no_speech');
      if (outcome.status !== 'no_speech') return;
      expect(outcome.message).toBe('No speech recognized');
      // Recognition still ran, so the session time is still consumed.
      expect(outcome.quota.sessionSecondsUsed).toBe(2);
      expect(providers.translate.calls).toHaveLength(0);
    });
  });

  describe('segment gating — not every transcript is worth translating', () => {
    it('skips filler-only transcripts before the translation call', async () => {
      providers.stt.queue({ text: 'uh', confidence: 0.9, status: 'recognized', durationSeconds: 1 });

      const outcome = await segment();

      expect(outcome.status).toBe('skipped');
      if (outcome.status !== 'skipped') return;
      expect(outcome.reason).toBe('filler_only');
      expect(providers.translate.calls).toHaveLength(0);
    });

    it('skips a repeat of the previous segment', async () => {
      providers.stt.queue({ text: 'hello world', confidence: 0.9, status: 'recognized', durationSeconds: 1 });

      const outcome = await segment({ previousText: 'hello world' });

      expect(outcome.status).toBe('skipped');
      expect(providers.translate.calls).toHaveLength(0);
    });

    it('skips low-confidence recognitions', async () => {
      providers.stt.queue({ text: 'mmble grbl', confidence: 0.1, status: 'recognized', durationSeconds: 1 });

      const outcome = await segment();

      expect(outcome.status).toBe('skipped');
      if (outcome.status !== 'skipped') return;
      expect(outcome.reason).toBe('low_confidence');
    });

    it('clamps an over-long transcript to MyMemory’s query limit', async () => {
      const long = 'word '.repeat(60).trim();
      providers.stt.queue({ text: long, confidence: 0.9, status: 'recognized', durationSeconds: 5 });

      const outcome = await segment();

      expect(outcome.status).toBe('recognized');
      expect(providers.translate.calls[0]!.text.length).toBeLessThanOrEqual(100);
    });
  });

  describe('provider failures', () => {
    it('halts translation after a quota stop and refuses further calls locally', async () => {
      providers.translate.queue(new PipelineError('quota_exceeded', 'mymemory-translate'));

      await expect(segment()).rejects.toMatchObject({ kind: 'quota_exceeded' });
      expect(pipeline.circuit.isHalted('mymemory-translate')).toBe(true);

      // The next request must not reach the provider at all.
      const before = providers.translate.calls.length;
      await expect(segment({ previousText: 'x' })).rejects.toMatchObject({ kind: 'quota_exceeded' });
      expect(providers.translate.calls).toHaveLength(before);
    });

    it('halts on an auth failure', async () => {
      providers.translate.queue(new PipelineError('auth_failure', 'mymemory-translate'));

      await expect(segment()).rejects.toMatchObject({ kind: 'auth_failure' });
      expect(pipeline.circuit.isHalted('mymemory-translate')).toBe(true);
    });

    it('does not halt on a transient failure — those are retryable', async () => {
      providers.translate.queue(new PipelineError('transient', 'mymemory-translate'));

      await expect(segment()).rejects.toMatchObject({ kind: 'transient' });
      expect(pipeline.circuit.isHalted('mymemory-translate')).toBe(false);
    });

    it('does not halt on a bad request, but does not retry it either', async () => {
      providers.translate.queue(new PipelineError('bad_request', 'mymemory-translate'));

      const error = (await segment().catch((e: unknown) => e)) as PipelineError;

      expect(error.policy.retryable).toBe(false);
      expect(pipeline.circuit.isHalted('mymemory-translate')).toBe(false);
    });

    it('treats a Whisper cold-start failure as transient without halting', async () => {
      // The model download can fail on a flaky network; that must not
      // permanently disable recognition.
      providers.stt.queue(new PipelineError('transient', 'whisper-stt', 'model load failed'));

      await expect(segment()).rejects.toMatchObject({ kind: 'transient' });
      expect(pipeline.circuit.isHalted('whisper-stt')).toBe(false);
    });

    it('wraps an unclassified provider error as unknown rather than leaking it', async () => {
      providers.stt.queue(new Error('onnxruntime exploded'));

      const error = (await segment().catch((e: unknown) => e)) as PipelineError;

      expect(error).toBeInstanceOf(PipelineError);
      expect(error.kind).toBe('unknown');
      expect(error.toResponse().error.message).not.toContain('onnxruntime');
    });

    it('still records the audio when translation fails afterwards', async () => {
      providers.translate.queue(new PipelineError('transient', 'mymemory-translate'));

      await expect(segment({ durationSeconds: 2 })).rejects.toBeTruthy();

      expect(quota.snapshot(sessionId).sessionSecondsUsed).toBe(2);
    });
  });

  describe('quota enforcement inside the pipeline', () => {
    it('refuses a segment on an ended session before any provider call', async () => {
      quota.endSession(sessionId, 'user_stopped');

      await expect(segment()).rejects.toMatchObject({ kind: 'internal_quota_exceeded' });
      expect(providers.stt.calls).toHaveLength(0);
    });

    it('refuses an unsupported language pair', async () => {
      await expect(segment({ targetLang: 'xx-XX' })).rejects.toMatchObject({ kind: 'bad_request' });
    });

    it('stops mid-conversation once the session budget runs out', async () => {
      await segment({ durationSeconds: 8 });
      await segment({ durationSeconds: 8, previousText: 'x' });
      const third = await segment({ durationSeconds: 8, previousText: 'y' });

      expect(third.quota.sessionEnded).toBe(true);
      await expect(segment({ previousText: 'z' })).rejects.toMatchObject({
        kind: 'internal_quota_exceeded',
      });
    });

    it('still delivers the sentence whose audio ended the session', async () => {
      // The user finished speaking before the cutoff, so they must get the
      // translation — recognition already ran.
      const outcome = await segment({ durationSeconds: 20 });

      expect(outcome.status).toBe('recognized');
      if (outcome.status !== 'recognized') return;
      expect(outcome.segment.translatedText).toBe('[en] hello world');
      expect(outcome.quota.sessionEnded).toBe(true);
      expect(outcome.quota.endedReason).toBe('session_limit');
    });

    it('refuses translation once the app-wide daily character allowance is gone', async () => {
      // MyMemory's allowance is daily and app-wide; test config caps it at 5,000.
      for (let i = 0; i < 50; i += 1) quota.commitTranslation(sessionId, 100);

      await expect(segment()).rejects.toMatchObject({ kind: 'internal_quota_exceeded' });
      expect(providers.translate.calls).toHaveLength(0);
    });
  });

  describe('circuit cooldown', () => {
    it('re-allows a halted provider after the cooldown elapses', async () => {
      const circuit = new ProviderCircuit({ clock, cooldownMs: 60_000 });
      circuit.halt('mymemory-translate', 'quota_exceeded');

      expect(circuit.isHalted('mymemory-translate')).toBe(true);
      clock.advance(60_001);
      expect(circuit.isHalted('mymemory-translate')).toBe(false);
    });

    it('reports which providers are currently halted', () => {
      const circuit = new ProviderCircuit({ clock });
      circuit.halt('whisper-stt', 'unknown');

      expect(circuit.status()).toEqual([
        expect.objectContaining({ provider: 'whisper-stt', kind: 'unknown' }),
      ]);
    });
  });
});
