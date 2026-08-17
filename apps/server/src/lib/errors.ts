import type { FailureKind, FailurePolicy, ProviderName } from '../types/index.js';

/**
 * The failure-behaviour table from the plan document (p.2–3).
 *
 * The document specified these for Azure STT and said "Treat it the same as
 * above" for the other services. The providers have since been swapped for
 * local Whisper and MyMemory, but the taxonomy and its retry rules were the
 * valuable part and carry over unchanged — one table still drives everything.
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
    // The plan document's wording was "Speech service authentication failed.",
    // written for Azure. Speech recognition is now local and unauthenticated,
    // so the only thing that can reject us is the translation service.
    userMessage: 'The translation service rejected this request.',
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
 * Maps a MyMemory response onto our taxonomy. Returns `null` when the response
 * is a genuine success.
 *
 * MyMemory answers **HTTP 200 for failures** and puts the real outcome in
 * `responseStatus` inside the body, so `response.ok` is not a usable signal.
 * Worse, it echoes the error message into `responseData.translatedText` — a
 * caller that trusts that field will show "QUERY LENGTH LIMIT EXCEEDED…" to the
 * user as their translation. Both behaviours were confirmed against the live
 * API and are the reason this function exists at all.
 */
export function classifyMyMemoryFailure(
  httpStatus: number,
  body?: {
    responseStatus?: number | string;
    responseDetails?: string;
    quotaFinished?: boolean;
    responseData?: { translatedText?: string };
  } | null,
): FailureKind | null {
  if (httpStatus >= 500) return 'transient';
  if (!body) return httpStatus === 200 ? 'unknown' : classifyHttpFailure(httpStatus);

  // `responseStatus` is sometimes a string ("200"); normalise before comparing.
  const status = Number(body.responseStatus);
  const details = (body.responseDetails ?? '').toUpperCase();
  const translated = (body.responseData?.translatedText ?? '').toUpperCase();

  // The daily allowance is spent. Plan doc p.2: stop, do not retry, tell the
  // user the service limit was reached.
  if (
    body.quotaFinished === true ||
    status === 429 ||
    details.includes('YOU USED ALL AVAILABLE FREE TRANSLATIONS') ||
    translated.includes('YOU USED ALL AVAILABLE FREE TRANSLATIONS') ||
    details.includes('MYMEMORY WARNING')
  ) {
    return 'quota_exceeded';
  }

  if (status === 403 || status === 400) {
    // 403 covers invalid language pair, identical languages, and over-length
    // queries. All are "do not retry unchanged".
    return 'bad_request';
  }
  if (status === 401) return 'auth_failure';

  if (Number.isFinite(status) && status !== 200) return classifyHttpFailure(status);

  // A 200 whose "translation" is really an error banner.
  if (translated.includes('QUERY LENGTH LIMIT EXCEEDED') || translated.includes('INVALID TARGET LANGUAGE')) {
    return 'bad_request';
  }

  return null;
}

/**
 * Shared HTTP → failure-kind mapping.
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

/** Network-level errors (DNS, socket, abort) are transient by definition. */
export function classifyNetworkError(err: unknown): FailureKind {
  if (err instanceof PipelineError) return err.kind;
  const message = err instanceof Error ? err.message : String(err);
  if (/abort|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message)) {
    return 'transient';
  }
  return 'unknown';
}
