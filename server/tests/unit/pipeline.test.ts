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
      mimeType: 'audio/webm',
      durationSeconds: 2,
      sourceLang: 'ar-SA',
      targetLang: 'en-US',
      ...overrides,
    });

  describe('the happy path', () => {
    it('runs STT → translation → TTS and returns a full segment', async () => {
      const outcome = await segment();

      expect(outcome.status).toBe('recognized');
      if (outcome.status !== 'recognized') return;

      expect(outcome.segment.sourceText).toBe('hello world');
      expect(outcome.segment.translatedText).toBe('[en] hello world');
      expect(outcome.segment.audioBase64).toBeTruthy();
      expect(providers.stt.calls).toHaveLength(1);
      expect(providers.translate.calls).toHaveLength(1);
      expect(providers.tts.calls).toHaveLength(1);
    });

    it('passes the right language codes to each provider', async () => {
      await segment({ sourceLang: 'ar-SA', targetLang: 'fr-FR' });

      expect(providers.stt.calls[0]!.languageCode).toBe('ar-SA'); // BCP-47 for speech
      expect(providers.translate.calls[0]).toMatchObject({ sourceLang: 'ar', targetLang: 'fr' }); // ISO-639-1
      expect(providers.tts.calls[0]!.languageCode).toBe('fr-FR');
    });

    it('bills the session for the audio it processed', async () => {
      await segment({ durationSeconds: 3 });

      expect(quota.snapshot(sessionId).sessionSecondsUsed).toBe(3);
      expect(quota.userUsage('user-1').daily.translatedChars).toBe('hello world'.length);
    });

    it('deletes the encrypted audio buffer once the request finishes', async () => {
      await segment();
      expect(pipeline.pendingAudioBuffers).toBe(0);
    });

    it('deletes the buffer even when a provider throws', async () => {
      providers.stt.queue(new PipelineError('transient', 'azure-stt'));

      await expect(segment()).rejects.toBeInstanceOf(PipelineError);
      expect(pipeline.pendingAudioBuffers).toBe(0);
    });
  });

  describe('silence and no-speech handling', () => {
    it('rejects sub-threshold audio before calling any provider', async () => {
      const outcome = await segment({ durationSeconds: 0.1 });

      expect(outcome.status).toBe('no_speech');
      expect(providers.stt.calls).toHaveLength(0); // nothing was spent
    });

    it('rejects a near-empty buffer without calling STT', async () => {
      const outcome = await segment({ audio: Buffer.alloc(100) });

      expect(outcome.status).toBe('no_speech');
      expect(providers.stt.calls).toHaveLength(0);
    });

    it('returns the plan document’s message when Azure reports NoMatch', async () => {
      providers.stt.queue({ text: '', confidence: 0, status: 'no_match', durationSeconds: 2 });

      const outcome = await segment();

      expect(outcome.status).toBe('no_speech');
      if (outcome.status !== 'no_speech') return;
      expect(outcome.message).toBe('No speech recognized');
      // Azure still processed (and would bill for) the audio.
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
      expect(providers.tts.calls).toHaveLength(0);
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

    it('clamps an over-long transcript instead of rejecting it outright', async () => {
      const long = 'word '.repeat(60).trim(); // 299 chars, cap is 100
      providers.stt.queue({ text: long, confidence: 0.9, status: 'recognized', durationSeconds: 5 });

      const outcome = await segment();

      expect(outcome.status).toBe('recognized');
      expect(providers.translate.calls[0]!.text.length).toBeLessThanOrEqual(100);
    });
  });

  describe('TTS caching', () => {
    it('does not re-synthesise identical translated text', async () => {
      await segment();
      await segment({ previousText: undefined });

      expect(providers.translate.calls).toHaveLength(2);
      expect(providers.tts.calls).toHaveLength(1); // second one hit the cache
      expect(pipeline.ttsCacheStats.hits).toBe(1);
    });

    it('does not bill TTS characters for a cache hit', async () => {
      await segment();
      const afterFirst = quota.userUsage('user-1').daily.ttsChars;

      await segment();

      expect(quota.userUsage('user-1').daily.ttsChars).toBe(afterFirst);
    });

    it('marks a cached segment so the UI can show it', async () => {
      await segment();
      const second = await segment();

      expect(second.status).toBe('recognized');
      if (second.status !== 'recognized') return;
      expect(second.segment.ttsCached).toBe(true);
    });

    it('re-synthesises when the target language changes', async () => {
      await segment({ targetLang: 'en-US' });
      await segment({ targetLang: 'fr-FR' });

      expect(providers.tts.calls).toHaveLength(2);
    });

    it('serves speak() from the same cache', async () => {
      await segment();
      const result = await pipeline.speak({ sessionId, text: '[en] hello world', targetLang: 'en-US' });

      expect(result.cached).toBe(true);
      expect(providers.tts.calls).toHaveLength(1);
    });
  });

  describe('skipping TTS', () => {
    it('honours speak:false and never calls the TTS provider', async () => {
      const outcome = await segment({ speak: false });

      expect(outcome.status).toBe('recognized');
      if (outcome.status !== 'recognized') return;
      expect(outcome.segment.audioBase64).toBeNull();
      expect(providers.tts.calls).toHaveLength(0);
    });
  });

  describe('provider failures', () => {
    it('halts Azure after an auth failure and refuses further calls locally', async () => {
      providers.stt.queue(new PipelineError('auth_failure', 'azure-stt'));

      await expect(segment()).rejects.toMatchObject({ kind: 'auth_failure' });
      expect(pipeline.circuit.isHalted('azure-stt')).toBe(true);

      // The next request must not reach the provider at all.
      const before = providers.stt.calls.length;
      await expect(segment()).rejects.toMatchObject({ kind: 'auth_failure' });
      expect(providers.stt.calls).toHaveLength(before);
    });

    it('halts a provider after it reports a quota stop', async () => {
      providers.translate.queue(new PipelineError('quota_exceeded', 'google-translate'));

      await expect(segment()).rejects.toMatchObject({ kind: 'quota_exceeded' });
      expect(pipeline.circuit.isHalted('google-translate')).toBe(true);
    });

    it('does not halt on a transient failure — those are retryable', async () => {
      providers.translate.queue(new PipelineError('transient', 'google-translate'));

      await expect(segment()).rejects.toMatchObject({ kind: 'transient' });
      expect(pipeline.circuit.isHalted('google-translate')).toBe(false);
    });

    it('does not halt on a bad request, but does not retry it either', async () => {
      providers.translate.queue(new PipelineError('bad_request', 'google-translate'));

      const error = (await segment().catch((e: unknown) => e)) as PipelineError;

      expect(error.policy.retryable).toBe(false);
      expect(pipeline.circuit.isHalted('google-translate')).toBe(false);
    });

    it('wraps an unclassified provider error as unknown rather than leaking it', async () => {
      providers.tts.queue(new Error('socket exploded'));

      const error = (await segment().catch((e: unknown) => e)) as PipelineError;

      expect(error).toBeInstanceOf(PipelineError);
      expect(error.kind).toBe('unknown');
      expect(error.toResponse().error.message).not.toContain('socket');
    });

    it('still bills the audio when translation fails afterwards', async () => {
      providers.translate.queue(new PipelineError('transient', 'google-translate'));

      await expect(segment({ durationSeconds: 2 })).rejects.toBeTruthy();

      // Azure ran and charged for it, so the counter must reflect that.
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
      // 20s session budget, 8s per segment.
      await segment({ durationSeconds: 8 });
      await segment({ durationSeconds: 8, previousText: 'x' });
      const third = await segment({ durationSeconds: 8, previousText: 'y' });

      expect(third.quota.sessionEnded).toBe(true);
      await expect(segment({ previousText: 'z' })).rejects.toMatchObject({
        kind: 'internal_quota_exceeded',
      });
    });

    it('still delivers the sentence whose audio ended the session', async () => {
      // A single segment that exhausts the whole 20s budget at once. The user
      // finished speaking before the cutoff, so they must get the translation —
      // we already recognised it and already paid Azure for it.
      const outcome = await segment({ durationSeconds: 20 });

      expect(outcome.status).toBe('recognized');
      if (outcome.status !== 'recognized') return;
      expect(outcome.segment.translatedText).toBe('[en] hello world');
      expect(outcome.segment.audioBase64).toBeTruthy();
      expect(outcome.quota.sessionEnded).toBe(true);
      expect(outcome.quota.endedReason).toBe('session_limit');
    });

    it('refuses a standalone speak() on an ended session', async () => {
      quota.endSession(sessionId, 'session_limit');

      // Unlike an in-flight segment, this is a fresh request for new audio.
      await expect(
        pipeline.speak({ sessionId, text: 'brand new phrase', targetLang: 'en-US' }),
      ).rejects.toMatchObject({ kind: 'internal_quota_exceeded' });
    });
  });

  describe('circuit cooldown', () => {
    it('re-allows a halted provider after the cooldown elapses', async () => {
      const circuit = new ProviderCircuit({ clock, cooldownMs: 60_000 });
      circuit.halt('azure-stt', 'quota_exceeded');

      expect(circuit.isHalted('azure-stt')).toBe(true);
      clock.advance(60_001);
      expect(circuit.isHalted('azure-stt')).toBe(false);
    });

    it('reports which providers are currently halted', () => {
      const circuit = new ProviderCircuit({ clock });
      circuit.halt('google-tts', 'auth_failure');

      expect(circuit.status()).toEqual([
        expect.objectContaining({ provider: 'google-tts', kind: 'auth_failure' }),
      ]);
    });
  });
});
