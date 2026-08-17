import type { FailureKind, FailurePolicy, ProviderName } from '../types/index.js';

/**
 * The failure-behaviour table from the plan document (p.2–3).
 *
 * The document specifies these for Azure STT and then says "Treat it the same
 * as above" for Translation and TTS — so one table drives all three providers.
 */
export const FAILURE_POLICIES: Record<FailureKind, FailurePolicy> = {
  no_match: {
    retryable: true, // retrying means "speak again", not "resend this audio"
    haltProvider: false,
    httpStatus: 200, // not an error for the user — just silence
    userMessage: 'No speech recognized',
  },
  auth_failure: {
    retryable: false,
    haltProvider: true,
    httpStatus: 502,
    userMessage: 'Speech service authentication failed.',
  },
  bad_request: {
    retryable: false, // "STOP — Don't retry unchanged request"
    haltProvider: false,
    httpStatus: 400,
    userMessage: "That request couldn't be processed. Try recording again.",
  },
  quota_exceeded: {
    retryable: false, // "STOP API requests. Do NOT retry."
    haltProvider: true,
    httpStatus: 429,
    userMessage: 'Service limit was reached. Please try again later.',
  },
  internal_quota_exceeded: {
    retryable: false,
    haltProvider: false,
    httpStatus: 429,
    userMessage: 'You have used all of your translation time. Start a new session later.',
  },
  transient: {
    retryable: true,
    haltProvider: false,
    httpStatus: 503,
    userMessage: 'The service is busy. Please try again in a moment.',
  },
  unknown: {
    retryable: false,
    haltProvider: false,
    httpStatus: 500,
    userMessage: 'Something went wrong. Please try again.',
  },
};

/** A failure that has already been classified against the plan doc's taxonomy. */
export class PipelineError extends Error {
  readonly kind: FailureKind;
  readonly provider: ProviderName | 'backend';
  readonly policy: FailurePolicy;
  readonly detail?: string;

  constructor(kind: FailureKind, provider: ProviderName | 'backend', detail?: string) {
    const policy = FAILURE_POLICIES[kind];
    super(`${provider}: ${kind}${detail ? ` (${detail})` : ''}`);
    this.name = 'PipelineError';
    this.kind = kind;
    this.provider = provider;
    this.policy = policy;
    this.detail = detail;
  }

  toResponse() {
    return {
      ok: false as const,
      error: {
        kind: this.kind,
        provider: this.provider,
        message: this.policy.userMessage,
        retryable: this.policy.retryable,
        haltProvider: this.policy.haltProvider,
      },
    };
  }
}

/**
 * Maps an Azure Speech `RecognitionStatus` / REST response onto our taxonomy.
 * Azure reports NoMatch in the body with HTTP 200, so status alone is not enough.
 */
export function classifyAzureFailure(
  httpStatus: number,
  body?: { RecognitionStatus?: string } | null,
): FailureKind | null {
  if (body?.RecognitionStatus === 'NoMatch' || body?.RecognitionStatus === 'InitialSilenceTimeout') {
    return 'no_match';
  }
  if (httpStatus === 200) return null;
  return classifyHttpFailure(httpStatus);
}

/**
 * Shared HTTP → failure-kind mapping. Google Translation and TTS use this
 * directly ("Treat it the same as above", plan doc p.3).
 */
export function classifyHttpFailure(httpStatus: number): FailureKind {
  if (httpStatus === 401 || httpStatus === 403) return 'auth_failure';
  if (httpStatus === 429) return 'quota_exceeded';
  if (httpStatus === 400 || httpStatus === 404 || httpStatus === 413 || httpStatus === 415) {
    return 'bad_request';
  }
  if (httpStatus >= 500) return 'transient';
  return 'unknown';
}

/**
 * Google's JSON error bodies distinguish a quota stop from a plain 403 auth
 * failure only by `reason`, so inspect it before falling back to the status.
 */
export function classifyGoogleFailure(
  httpStatus: number,
  body?: { error?: { status?: string; message?: string; errors?: Array<{ reason?: string }> } } | null,
): FailureKind {
  const reason = body?.error?.errors?.[0]?.reason;
  const status = body?.error?.status;

  if (reason === 'rateLimitExceeded' || reason === 'quotaExceeded' || reason === 'userRateLimitExceeded') {
    return 'quota_exceeded';
  }
  if (status === 'RESOURCE_EXHAUSTED') return 'quota_exceeded';
  if (reason === 'keyInvalid' || reason === 'forbidden' || status === 'UNAUTHENTICATED') {
    return 'auth_failure';
  }
  if (status === 'INVALID_ARGUMENT') return 'bad_request';
  return classifyHttpFailure(httpStatus);
}

/** Network-level errors (DNS, socket, abort) are transient by definition. */
export function classifyNetworkError(err: unknown): FailureKind {
  if (err instanceof PipelineError) return err.kind;
  const message = err instanceof Error ? err.message : String(err);
  if (/abort|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message)) {
    return 'transient';
  }
  return 'unknown';
}
