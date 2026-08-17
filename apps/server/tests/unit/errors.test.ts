import { describe, expect, it } from 'vitest';
import {
  FAILURE_POLICIES,
  PipelineError,
  classifyHttpFailure,
  classifyMyMemoryFailure,
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

    it('treats an auth failure as terminal', () => {
      const policy = FAILURE_POLICIES.auth_failure;
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

  describe('classifyMyMemoryFailure', () => {
    /**
     * Every case here mirrors a response captured from the live API. MyMemory
     * answers failures with **HTTP 200** and hides the real outcome in
     * `responseStatus`, so a caller that checks `response.ok` sees every error
     * as a success.
     */
    it('returns null for a genuine success', () => {
      const body = { responseStatus: 200, responseData: { translatedText: 'مرحبا' } };
      expect(classifyMyMemoryFailure(200, body)).toBeNull();
    });

    it('accepts a string responseStatus, which the API sometimes sends', () => {
      const body = { responseStatus: '200', responseData: { translatedText: 'مرحبا' } };
      expect(classifyMyMemoryFailure(200, body)).toBeNull();
    });

    it('detects a 403 hidden inside an HTTP 200', () => {
      const body = { responseStatus: 403, responseDetails: 'PLEASE SELECT TWO DISTINCT LANGUAGES' };
      expect(classifyMyMemoryFailure(200, body)).toBe('bad_request');
    });

    it('detects an invalid target language', () => {
      const body = { responseStatus: 403, responseDetails: "'ZZZ' IS AN INVALID TARGET LANGUAGE" };
      expect(classifyMyMemoryFailure(200, body)).toBe('bad_request');
    });

    it('detects the query-length limit', () => {
      const body = {
        responseStatus: 403,
        responseDetails: 'QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS',
      };
      expect(classifyMyMemoryFailure(200, body)).toBe('bad_request');
    });

    it('catches the length banner even when the status claims success', () => {
      // The API echoes its error text into the translation field. Without this
      // the banner would be shown to the user as their translation.
      const body = {
        responseStatus: 200,
        responseData: { translatedText: 'QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS' },
      };
      expect(classifyMyMemoryFailure(200, body)).toBe('bad_request');
    });

    it('reads quotaFinished as a quota stop', () => {
      expect(classifyMyMemoryFailure(200, { responseStatus: 200, quotaFinished: true })).toBe('quota_exceeded');
    });

    it('reads the daily-allowance warning as a quota stop', () => {
      const body = {
        responseStatus: 200,
        responseData: {
          translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY.',
        },
      };
      expect(classifyMyMemoryFailure(200, body)).toBe('quota_exceeded');
    });

    it('reads a 429 as a quota stop', () => {
      expect(classifyMyMemoryFailure(200, { responseStatus: 429 })).toBe('quota_exceeded');
    });

    it('treats a 5xx as transient regardless of the body', () => {
      expect(classifyMyMemoryFailure(503, null)).toBe('transient');
    });

    it('treats a missing body on a 200 as unknown rather than success', () => {
      expect(classifyMyMemoryFailure(200, null)).toBe('unknown');
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
      const original = new PipelineError('quota_exceeded', 'mymemory-translate');
      expect(classifyNetworkError(original)).toBe('quota_exceeded');
    });

    it('falls back to unknown for anything unrecognised', () => {
      expect(classifyNetworkError(new Error('something odd'))).toBe('unknown');
    });
  });

  describe('PipelineError', () => {
    it('serialises to the client contract without leaking internals', () => {
      const error = new PipelineError('auth_failure', 'mymemory-translate', 'internal endpoint detail');
      const body = error.toResponse();

      expect(body).toEqual({
        ok: false,
        error: {
          kind: 'auth_failure',
          provider: 'mymemory-translate',
          message: FAILURE_POLICIES.auth_failure.userMessage,
          retryable: false,
          haltProvider: true,
        },
      });
      expect(JSON.stringify(body)).not.toContain('internal endpoint detail');
    });

    it('carries the correct HTTP status from its policy', () => {
      expect(new PipelineError('quota_exceeded', 'mymemory-translate').policy.httpStatus).toBe(429);
      expect(new PipelineError('bad_request', 'backend').policy.httpStatus).toBe(400);
    });
  });

  describe('classifyHttpFailure', () => {
    it('treats an unmapped 3xx as unknown rather than guessing', () => {
      expect(classifyHttpFailure(301)).toBe('unknown');
    });
  });
});
