import { describe, expect, it } from 'vitest';
import {
  FAILURE_POLICIES,
  PipelineError,
  classifyAzureFailure,
  classifyGoogleFailure,
  classifyHttpFailure,
  classifyNetworkError,
} from '../../src/lib/errors.js';

/**
 * These assertions encode the failure tables on p.2–3 of the plan document
 * verbatim. If a policy here changes, the app's behaviour has diverged from the
 * spec — which is exactly what these tests exist to catch.
 */
describe('failure classification', () => {
  describe('policies match the plan document', () => {
    it('treats NoMatch as "No speech recognized" and not an error', () => {
      const policy = FAILURE_POLICIES.no_match;
      expect(policy.userMessage).toBe('No speech recognized');
      expect(policy.haltProvider).toBe(false);
      expect(policy.httpStatus).toBe(200);
    });

    it('treats AuthenticationFailure as terminal with the documented message', () => {
      const policy = FAILURE_POLICIES.auth_failure;
      expect(policy.userMessage).toBe('Speech service authentication failed.');
      expect(policy.retryable).toBe(false);
      expect(policy.haltProvider).toBe(true);
    });

    it('never retries a bad request unchanged', () => {
      expect(FAILURE_POLICIES.bad_request.retryable).toBe(false);
    });

    it('stops all requests on a provider quota stop and tells the user', () => {
      const policy = FAILURE_POLICIES.quota_exceeded;
      expect(policy.retryable).toBe(false);
      expect(policy.haltProvider).toBe(true);
      expect(policy.userMessage).toMatch(/service limit was reached/i);
    });

    it('allows retry only for transient failures', () => {
      const retryable = Object.entries(FAILURE_POLICIES)
        .filter(([, policy]) => policy.retryable)
        .map(([kind]) => kind)
        .sort();

      expect(retryable).toEqual(['no_match', 'transient']);
    });
  });

  describe('classifyAzureFailure', () => {
    it('detects NoMatch even on a 200 response', () => {
      expect(classifyAzureFailure(200, { RecognitionStatus: 'NoMatch' })).toBe('no_match');
    });

    it('treats InitialSilenceTimeout as no speech', () => {
      expect(classifyAzureFailure(200, { RecognitionStatus: 'InitialSilenceTimeout' })).toBe('no_match');
    });

    it('returns null for a clean success', () => {
      expect(classifyAzureFailure(200, { RecognitionStatus: 'Success' })).toBeNull();
    });

    it.each([
      [401, 'auth_failure'],
      [403, 'auth_failure'],
      [429, 'quota_exceeded'],
      [400, 'bad_request'],
      [415, 'bad_request'],
      [500, 'transient'],
      [503, 'transient'],
    ])('maps HTTP %i to %s', (status, expected) => {
      expect(classifyAzureFailure(status, null)).toBe(expected);
    });
  });

  describe('classifyGoogleFailure', () => {
    it('distinguishes a quota stop from a plain auth failure on 403', () => {
      const quota = classifyGoogleFailure(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } });
      const auth = classifyGoogleFailure(403, { error: { errors: [{ reason: 'forbidden' }] } });

      expect(quota).toBe('quota_exceeded');
      expect(auth).toBe('auth_failure');
    });

    it('reads RESOURCE_EXHAUSTED as a quota stop', () => {
      expect(classifyGoogleFailure(429, { error: { status: 'RESOURCE_EXHAUSTED' } })).toBe('quota_exceeded');
    });

    it('reads INVALID_ARGUMENT as a bad request', () => {
      expect(classifyGoogleFailure(400, { error: { status: 'INVALID_ARGUMENT' } })).toBe('bad_request');
    });

    it('falls back to the HTTP status when the body is unhelpful', () => {
      expect(classifyGoogleFailure(500, null)).toBe('transient');
    });
  });

  describe('classifyNetworkError', () => {
    it.each(['fetch failed', 'ETIMEDOUT', 'ECONNRESET', 'The operation was aborted'])(
      'treats "%s" as transient',
      (message) => {
        expect(classifyNetworkError(new Error(message))).toBe('transient');
      },
    );

    it('preserves an already-classified PipelineError', () => {
      const original = new PipelineError('quota_exceeded', 'google-tts');
      expect(classifyNetworkError(original)).toBe('quota_exceeded');
    });

    it('falls back to unknown for anything unrecognised', () => {
      expect(classifyNetworkError(new Error('something odd'))).toBe('unknown');
    });
  });

  describe('PipelineError', () => {
    it('serialises to the client contract without leaking internals', () => {
      const error = new PipelineError('auth_failure', 'azure-stt', 'HTTP 401 subscription key rejected');
      const body = error.toResponse();

      expect(body).toEqual({
        ok: false,
        error: {
          kind: 'auth_failure',
          provider: 'azure-stt',
          message: 'Speech service authentication failed.',
          retryable: false,
          haltProvider: true,
        },
      });
      expect(JSON.stringify(body)).not.toContain('subscription key');
    });

    it('carries the correct HTTP status from its policy', () => {
      expect(new PipelineError('quota_exceeded', 'google-tts').policy.httpStatus).toBe(429);
      expect(new PipelineError('bad_request', 'backend').policy.httpStatus).toBe(400);
    });
  });

  describe('classifyHttpFailure', () => {
    it('treats an unmapped 3xx as unknown rather than guessing', () => {
      expect(classifyHttpFailure(301)).toBe('unknown');
    });
  });
});
