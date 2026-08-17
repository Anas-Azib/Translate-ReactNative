import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, getDeviceId } from '../../src/services/api';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Asserts the call rejects and hands back the typed error. */
async function captureError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('Expected the request to reject, but it resolved.');
}

function errorBody(overrides: Partial<{ kind: string; retryable: boolean; haltProvider: boolean }> = {}) {
  return {
    ok: false,
    error: {
      kind: 'transient',
      provider: 'google-translate',
      message: 'The service is busy. Please try again in a moment.',
      retryable: true,
      haltProvider: false,
      ...overrides,
    },
  };
}

describe('ApiClient', () => {
  const options = { deviceId: 'test-device-0001', retryDelayMs: 0 };

  it('sends the device id on every request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, languages: [] }));
    const client = new ApiClient({ ...options, fetchImpl });

    await client.getConfig();

    const headers = fetchImpl.mock.calls[0]![1].headers;
    expect(headers['x-device-id']).toBe('test-device-0001');
  });

  it('posts audio as multipart with all the pipeline fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, status: 'recognized' }));
    const client = new ApiClient({ ...options, fetchImpl });

    await client.translateSegment({
      sessionId: 'session-1',
      audio: new Blob(['audio'], { type: 'audio/webm' }),
      durationSeconds: 2.5,
      sourceLang: 'ar-SA',
      targetLang: 'en-US',
      previousText: 'earlier',
    });

    const body = fetchImpl.mock.calls[0]![1].body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('sessionId')).toBe('session-1');
    expect(body.get('sourceLang')).toBe('ar-SA');
    expect(body.get('durationSeconds')).toBe('2.5');
    expect(body.get('previousText')).toBe('earlier');
    // FormData must set its own multipart boundary.
    expect(fetchImpl.mock.calls[0]![1].headers['Content-Type']).toBeUndefined();
  });

  describe('retry policy — the plan document’s rules', () => {
    it('retries a transient failure and succeeds', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(503, errorBody({ kind: 'transient', retryable: true })))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true, sessionId: 'ok' }));
      const client = new ApiClient({ ...options, fetchImpl });

      const result = await client.startSession();

      expect(result.sessionId).toBe('ok');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('never retries a bad request — "Don’t retry unchanged request"', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse(400, errorBody({ kind: 'bad_request', retryable: false })));
      const client = new ApiClient({ ...options, fetchImpl });

      await expect(client.startSession()).rejects.toBeInstanceOf(ApiError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('never retries an auth failure', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse(502, errorBody({ kind: 'auth_failure', retryable: false, haltProvider: true })));
      const client = new ApiClient({ ...options, fetchImpl });

      const error = await captureError(client.startSession());

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(error.haltProvider).toBe(true);
    });

    it('never retries a provider quota stop — "STOP API requests. Do NOT retry."', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse(429, errorBody({ kind: 'quota_exceeded', retryable: false })));
      const client = new ApiClient({ ...options, fetchImpl });

      await expect(client.startSession()).rejects.toMatchObject({ kind: 'quota_exceeded' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('gives up after the attempt budget on a persistently transient failure', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, errorBody({ retryable: true })));
      const client = new ApiClient({ ...options, fetchImpl, maxAttempts: 3 });

      await expect(client.startSession()).rejects.toBeInstanceOf(ApiError);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('retries a network failure, which has no response to classify', async () => {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true, sessionId: 'recovered' }));
      const client = new ApiClient({ ...options, fetchImpl });

      const result = await client.startSession();

      expect(result.sessionId).toBe('recovered');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('surfaces a plain-language message when the network never comes back', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      const client = new ApiClient({ ...options, fetchImpl, maxAttempts: 2 });

      const error = await captureError(client.startSession());

      expect(error.kind).toBe('network');
      expect(error.message).toMatch(/check your internet/i);
    });
  });

  describe('error surface', () => {
    it('preserves the server’s classification on the thrown error', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse(502, errorBody({ kind: 'auth_failure', retryable: false, haltProvider: true })));
      const client = new ApiClient({ ...options, fetchImpl });

      const error = await captureError(client.getConfig());

      expect(error).toBeInstanceOf(ApiError);
      expect(error.kind).toBe('auth_failure');
      expect(error.status).toBe(502);
      expect(error.retryable).toBe(false);
    });

    it('treats ok:false on a 200 as a failure', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, errorBody({ retryable: false })));
      const client = new ApiClient({ ...options, fetchImpl });

      await expect(client.getConfig()).rejects.toBeInstanceOf(ApiError);
    });

    it('handles a response body that is not JSON', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json');
        },
      } as unknown as Response);
      const client = new ApiClient({ ...options, fetchImpl });

      const error = await captureError(client.getConfig());
      expect(error.kind).toBe('unknown');
    });
  });

  describe('experiment tracking', () => {
    it('sends a batch via sendBeacon when it is available', () => {
      const sendBeacon = vi.fn().mockReturnValue(true);
      Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
      const fetchImpl = vi.fn();
      const client = new ApiClient({ ...options, fetchImpl });

      client.trackEvents([{ experiment: 'mic_control', variant: 'tap', metric: 'session_started' }]);

      expect(sendBeacon).toHaveBeenCalledTimes(1);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('falls back to fetch when sendBeacon refuses the payload', () => {
      Object.defineProperty(navigator, 'sendBeacon', {
        value: vi.fn().mockReturnValue(false),
        configurable: true,
      });
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(202, { ok: true }));
      const client = new ApiClient({ ...options, fetchImpl });

      client.trackEvents([{ experiment: 'mic_control', variant: 'tap', metric: 'session_started' }]);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('does nothing for an empty batch', () => {
      const sendBeacon = vi.fn();
      Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
      const client = new ApiClient({ ...options, fetchImpl: vi.fn() });

      client.trackEvents([]);

      expect(sendBeacon).not.toHaveBeenCalled();
    });

    it('never rejects when analytics fail — telemetry must not break the app', async () => {
      Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true });
      const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
      const client = new ApiClient({ ...options, fetchImpl });

      expect(() =>
        client.trackEvents([{ experiment: 'mic_control', variant: 'tap', metric: 'session_started' }]),
      ).not.toThrow();
      await Promise.resolve();
    });
  });
});

describe('getDeviceId', () => {
  it('generates and persists an id on first use', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as unknown as Storage;

    const first = getDeviceId(storage);
    const second = getDeviceId(storage);

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it('still returns an id when storage is unavailable (Safari private mode)', () => {
    expect(getDeviceId(undefined)).toBeTruthy();
  });
});
