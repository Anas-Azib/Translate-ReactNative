import { describe, expect, it, beforeEach } from 'vitest';
import { QuotaManager } from '../../src/usage/quotaManager.js';
import { PipelineError } from '../../src/lib/errors.js';
import { FakeClock, testConfig } from '../helpers.js';

/**
 * Covers the plan document's "Cost constraints" (p.4) and the Usage Control
 * decision tree (p.5). Each limit gets a test that proves it *blocks*, not just
 * that it counts.
 */
describe('QuotaManager', () => {
  let clock: FakeClock;
  let quota: QuotaManager;
  const config = testConfig();

  beforeEach(() => {
    clock = new FakeClock();
    quota = new QuotaManager({ quota: config.quota, clock });
  });

  describe('session lifecycle', () => {
    it('opens a session with a full budget', () => {
      const { session, snapshot } = quota.startSession('user-1');

      expect(session.ended).toBe(false);
      expect(snapshot.sessionSecondsUsed).toBe(0);
      expect(snapshot.sessionSecondsLimit).toBe(20);
      expect(quota.activeSessions()).toBe(1);
    });

    it('auto-stops the session once the session limit is reached', () => {
      const { session } = quota.startSession('user-1');

      quota.commitAudio(session.id, 12);
      expect(quota.getSession(session.id)?.ended).toBe(false);

      const snapshot = quota.commitAudio(session.id, 9); // 21 > 20

      expect(snapshot.sessionEnded).toBe(true);
      expect(snapshot.endedReason).toBe('session_limit');
    });

    it('refuses further audio on an ended session — the user must start a new one', () => {
      const { session } = quota.startSession('user-1');
      quota.commitAudio(session.id, 25);

      const decision = quota.checkAudio({ sessionId: session.id, audioSeconds: 1, audioBytes: 1000 });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('session_ended');
    });

    it('lets the user start a fresh session after a session-limit stop', () => {
      const first = quota.startSession('user-1');
      quota.commitAudio(first.session.id, 20);

      const second = quota.startSession('user-1');

      expect(second.session.id).not.toBe(first.session.id);
      expect(second.snapshot.sessionSecondsUsed).toBe(0);
      // Daily usage carries over even though the session budget reset.
      expect(second.snapshot.dailySecondsUsed).toBe(20);
    });

    it('rejects an unknown session id', () => {
      const decision = quota.checkAudio({ sessionId: 'nope', audioSeconds: 1, audioBytes: 100 });
      expect(decision.reason).toBe('unknown_session');
    });
  });

  describe('daily and monthly limits', () => {
    it('blocks a new session once the daily ceiling is reached', () => {
      // 60s daily limit, 20s per session → three sessions exhaust the day.
      for (let i = 0; i < 3; i += 1) {
        const { session } = quota.startSession('user-1');
        quota.commitAudio(session.id, 20);
      }

      expect(() => quota.startSession('user-1')).toThrow(PipelineError);
      try {
        quota.startSession('user-1');
      } catch (err) {
        expect((err as PipelineError).kind).toBe('internal_quota_exceeded');
        expect((err as PipelineError).detail).toBe('daily_limit');
      }
    });

    it('ends the active session when the daily ceiling is crossed mid-session', () => {
      // A daily budget that is not a multiple of the session budget, so the
      // daily limit is provably the one that fires — with 60/20 both ceilings
      // land on the same commit and the assertion would prove nothing.
      const daily = new QuotaManager({
        quota: { ...config.quota, dailySeconds: 50 },
        clock,
      });

      for (const _ of [0, 1]) {
        const { session } = daily.startSession('user-1');
        daily.commitAudio(session.id, 20);
      }

      const third = daily.startSession('user-1');
      const snapshot = daily.commitAudio(third.session.id, 5);

      expect(snapshot.dailySecondsUsed).toBe(45);
      expect(snapshot.sessionEnded).toBe(false);

      const final = daily.commitAudio(third.session.id, 5);

      expect(final.sessionEnded).toBe(true);
      expect(final.sessionSecondsUsed).toBeLessThan(final.sessionSecondsLimit);
      expect(final.endedReason).toBe('daily_limit');
    });

    it('resets the daily budget on the next calendar day', () => {
      const { session } = quota.startSession('user-1');
      quota.commitAudio(session.id, 20);
      expect(quota.userUsage('user-1').daily.audioSeconds).toBe(20);

      clock.advance(24 * 60 * 60 * 1000);

      expect(quota.userUsage('user-1').daily.audioSeconds).toBe(0);
      // The month bucket keeps accumulating across the day boundary.
      expect(quota.userUsage('user-1').monthly.audioSeconds).toBe(20);
    });

    it('keeps each user’s budget separate', () => {
      const a = quota.startSession('user-a');
      quota.commitAudio(a.session.id, 20);

      expect(quota.userUsage('user-a').daily.audioSeconds).toBe(20);
      expect(quota.userUsage('user-b').daily.audioSeconds).toBe(0);
      expect(() => quota.startSession('user-b')).not.toThrow();
    });
  });

  describe('concurrency limits', () => {
    it('blocks a second concurrent session for the same user', () => {
      quota.startSession('user-1');
      expect(() => quota.startSession('user-1')).toThrow(/concurrent_user_limit/);
    });

    it('allows a new session once the previous one is stopped', () => {
      const { session } = quota.startSession('user-1');
      quota.endSession(session.id, 'user_stopped');
      expect(() => quota.startSession('user-1')).not.toThrow();
    });

    it('blocks new sessions once the global concurrency cap is hit', () => {
      quota.startSession('user-1');
      quota.startSession('user-2');
      quota.startSession('user-3'); // cap is 3

      expect(() => quota.startSession('user-4')).toThrow(/concurrent_global_limit/);
    });

    it('reaps idle sessions so a crashed client cannot hold a slot forever', () => {
      const { session } = quota.startSession('user-1');
      expect(quota.activeSessions()).toBe(1);

      clock.advance(61 * 1000); // idle timeout is 60s
      const reaped = quota.reapIdle();

      expect(reaped).toBe(1);
      expect(quota.getSession(session.id)?.endedReason).toBe('expired');
      expect(() => quota.startSession('user-1')).not.toThrow();
    });

    it('keeps a session alive while it is being used', () => {
      const { session } = quota.startSession('user-1');
      clock.advance(50 * 1000);
      quota.touch(session.id);
      clock.advance(50 * 1000);

      expect(quota.reapIdle()).toBe(0);
    });
  });

  describe('request-size limits', () => {
    it('rejects audio over the per-request byte cap', () => {
      const { session } = quota.startSession('user-1');
      const decision = quota.checkAudio({
        sessionId: session.id,
        audioSeconds: 2,
        audioBytes: 600_000, // cap is 500k
      });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('audio_too_large');
    });

    it('rejects text over the per-translation character cap', () => {
      const { session } = quota.startSession('user-1');
      const decision = quota.checkTranslation({ sessionId: session.id, text: 'x'.repeat(101) });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('text_too_long');
    });

    it('accepts text exactly at the cap', () => {
      const { session } = quota.startSession('user-1');
      expect(quota.checkTranslation({ sessionId: session.id, text: 'x'.repeat(100) }).allowed).toBe(true);
    });
  });

  describe('global free-tier ceilings', () => {
    it('stops translating before the app-wide daily character allowance is breached', () => {
      const { session } = quota.startSession('user-1');
      // MyMemory's allowance is daily; the test config caps it at 5,000 chars.
      for (let i = 0; i < 50; i += 1) quota.commitTranslation(session.id, 100);

      const decision = quota.checkTranslation({ sessionId: session.id, text: 'one more' });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('global_translate_char_limit');
    });

    it('resets the translation allowance the next day, unlike a monthly cap', () => {
      const { session } = quota.startSession('user-1');
      for (let i = 0; i < 50; i += 1) quota.commitTranslation(session.id, 100);
      expect(quota.checkTranslation({ sessionId: session.id, text: 'x' }).allowed).toBe(false);

      clock.advance(24 * 60 * 60 * 1000);
      const fresh = quota.startSession('user-2');

      expect(quota.checkTranslation({ sessionId: fresh.session.id, text: 'x' }).allowed).toBe(true);
    });

    it('blocks a new session at the global daily audio ceiling', () => {
      // 300s global cap; each user contributes up to their 60s daily allowance.
      for (let u = 0; u < 5; u += 1) {
        for (let s = 0; s < 3; s += 1) {
          const { session } = quota.startSession(`user-${u}`);
          quota.commitAudio(session.id, 20);
        }
      }

      expect(quota.globalUsage().daily.audioSeconds).toBe(300);
      expect(() => quota.startSession('fresh-user')).toThrow(/global_daily_limit/);
    });
  });

  describe('usage accounting', () => {
    it('tracks audio and translation separately, per user and globally', () => {
      const { session } = quota.startSession('user-1');
      quota.commitAudio(session.id, 5);
      quota.commitTranslation(session.id, 42);

      const user = quota.userUsage('user-1');
      expect(user.daily.audioSeconds).toBe(5);
      expect(user.daily.translatedChars).toBe(42);
      expect(user.daily.sttRequests).toBe(1);

      const global = quota.globalUsage();
      expect(global.daily.audioSeconds).toBe(5);
      expect(global.monthly.translatedChars).toBe(42);
    });

    it('never lets a negative value reduce the counters', () => {
      const { session } = quota.startSession('user-1');
      quota.commitAudio(session.id, 10);
      quota.commitAudio(session.id, -100);

      expect(quota.userUsage('user-1').daily.audioSeconds).toBe(10);
    });
  });
});
