import type { ApiErrorShape, AppConfigResponse, QuotaSnapshot } from '../types';

const DEVICE_KEY = 'atl.device-id';

/** A normalised API failure. Carries the retry policy the server decided on. */
export class ApiError extends Error {
  readonly kind: ApiErrorShape['kind'];
  readonly provider: string;
  readonly retryable: boolean;
  readonly haltProvider: boolean;
  readonly status: number;

  constructor(shape: ApiErrorShape, status: number) {
    super(shape.message);
    this.name = 'ApiError';
    this.kind = shape.kind;
    this.provider = shape.provider;
    this.retryable = shape.retryable;
    this.haltProvider = shape.haltProvider ?? false;
    this.status = status;
  }
}

/** Stable per-device id. The server hashes it; the raw value never leaves here. */
export function getDeviceId(storage: Storage | undefined = safeStorage()): string {
  const existing = storage?.getItem(DEVICE_KEY);
  if (existing) return existing;
  const generated =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `dev-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  storage?.setItem(DEVICE_KEY, generated);
  return generated;
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined; // Safari private mode throws on access
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  deviceId?: string;
  /** Attempts for a *retryable* failure, including the first. */
  maxAttempts?: number;
  retryDelayMs?: number;
}

/**
 * REST client for everything that is not the live session.
 *
 * Audio, transcripts and translations travel over the WebSocket (see
 * `wsClient.ts`); this handles config, experiment assignment, and analytics.
 *
 * The retry policy is the important part. The plan document is explicit that a
 * bad request must not be retried unchanged, and that an auth failure or quota
 * stop must stop requests entirely rather than back off. So this client retries
 * **only** when the server marked the failure `retryable` — it never decides on
 * its own that a 4xx is worth another attempt. Getting this wrong is how a
 * quota overage turns into a bill.
 */
export class ApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #deviceId: string;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;

  constructor(options: ApiClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? '/api';
    this.#fetch = options.fetchImpl ?? ((...args) => fetch(...args));
    this.#deviceId = options.deviceId ?? getDeviceId();
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#retryDelayMs = options.retryDelayMs ?? 400;
  }

  get deviceId(): string {
    return this.#deviceId;
  }

  async getConfig(): Promise<AppConfigResponse> {
    return this.#request<AppConfigResponse>('GET', '/config');
  }

  async getAssignments(overrides?: Record<string, string>): Promise<{
    enabled: boolean;
    assignments: Record<string, string>;
  }> {
    const query = overrides && Object.keys(overrides).length
      ? `?${new URLSearchParams(overrides).toString()}`
      : '';
    return this.#request('GET', `/ab/assignments${query}`);
  }

  async startSession(): Promise<{ sessionId: string; quota: QuotaSnapshot }> {
    return this.#request('POST', '/session/start');
  }

  async stopSession(sessionId: string): Promise<{ quota: QuotaSnapshot }> {
    return this.#request('POST', `/session/${sessionId}/stop`, { reason: 'user_stopped' });
  }

  async getSession(sessionId: string): Promise<{ quota: QuotaSnapshot }> {
    return this.#request('GET', `/session/${sessionId}`);
  }

  /**
   * Fire-and-forget experiment events. Uses `sendBeacon` when available so a
   * conversion still lands if the user closes the tab immediately after.
   */
  trackEvents(events: Array<{ experiment: string; variant: string; metric: string; value?: number }>): void {
    if (events.length === 0) return;
    const url = `${this.#baseUrl}/ab/event`;
    const payload = JSON.stringify({ events });

    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      // sendBeacon cannot set headers, so identity rides in the body.
      const blob = new Blob([JSON.stringify({ events, deviceId: this.#deviceId })], {
        type: 'application/json',
      });
      if (navigator.sendBeacon(url, blob)) return;
    }

    void this.#fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-device-id': this.#deviceId },
      body: payload,
      keepalive: true,
    }).catch(() => {
      // Analytics must never break the app.
    });
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: ApiError | null = null;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
        const response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method,
          headers: {
            'x-device-id': this.#deviceId,
            ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body !== undefined
            ? { body: isForm ? (body as FormData) : JSON.stringify(body) }
            : {}),
        });

        const payload = await response.json().catch(() => null);

        if (!response.ok || payload?.ok === false) {
          const shape: ApiErrorShape = payload?.error ?? {
            kind: 'unknown',
            provider: 'backend',
            message: 'Something went wrong. Please try again.',
            retryable: false,
          };
          const error = new ApiError(shape, response.status);

          // Only the server gets to say a failure is worth retrying.
          if (!error.retryable || attempt === this.#maxAttempts) throw error;
          lastError = error;
          await delay(this.#retryDelayMs * attempt);
          continue;
        }

        return payload as T;
      } catch (err) {
        if (err instanceof ApiError) throw err;

        // Network-level failure: no response at all. Transient by nature.
        const networkError = new ApiError(
          {
            kind: 'network',
            provider: 'backend',
            message: 'No connection. Check your internet and try again.',
            retryable: true,
          },
          0,
        );
        if (attempt === this.#maxAttempts) throw networkError;
        lastError = networkError;
        await delay(this.#retryDelayMs * attempt);
      }
    }

    throw lastError ?? new ApiError(
      { kind: 'unknown', provider: 'backend', message: 'Request failed.', retryable: false },
      0,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
