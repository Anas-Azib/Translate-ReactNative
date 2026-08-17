import { vi } from 'vitest';
import type { AppConfigResponse, QuotaSnapshot } from '../src/types';

/**
 * A scripted stand-in for the backend.
 *
 * Deliberately hand-written rather than MSW: these tests need to *assert* on
 * exact request sequences (how many segment uploads, in what order, with what
 * fields) and to flip a single endpoint into a failure mode mid-test. A plain
 * fetch double makes both trivial and keeps the tests synchronous.
 */

export const TEST_CONFIG: AppConfigResponse = {
  languages: [
    {
      speechCode: 'ar-SA',
      translateCode: 'ar',
      labelEn: 'Arabic',
      labelNative: 'العربية',
      flag: '🇸🇦',
      rtl: true,
    },
    {
      speechCode: 'en-US',
      translateCode: 'en',
      labelEn: 'English',
      labelNative: 'English',
      flag: '🇺🇸',
      rtl: false,
    },
    {
      speechCode: 'fr-FR',
      translateCode: 'fr',
      labelEn: 'French',
      labelNative: 'Français',
      flag: '🇫🇷',
      rtl: false,
    },
  ],
  defaults: { source: 'ar-SA', target: 'en-US' },
  limits: {
    sessionSeconds: 120,
    dailySeconds: 600,
    monthlySeconds: 9000,
    maxCharsPerTranslation: 500,
    maxAudioBytes: 8_000_000,
  },
  providers: {
    stt: { name: 'whisper-stt', mode: 'mock', model: 'onnx-community/whisper-base' },
    translate: { name: 'mymemory-translate', mode: 'mock' },
  },
  usage: { daily: { audioSeconds: 0 }, monthly: { audioSeconds: 0 } },
};

export function quotaSnapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    sessionId: 'session-test',
    sessionSecondsUsed: 0,
    sessionSecondsLimit: 120,
    dailySecondsUsed: 0,
    dailySecondsLimit: 600,
    monthlySecondsUsed: 0,
    monthlySecondsLimit: 9000,
    sessionEnded: false,
    ...overrides,
  };
}

export interface MockServerOptions {
  assignments?: Record<string, string>;
  /** Overrides keyed by path suffix, e.g. `'/translate/segment'`. */
  handlers?: Record<string, () => { status: number; body: unknown }>;
}

export interface MockServer {
  fetch: ReturnType<typeof vi.fn>;
  requests: Array<{ url: string; method: string; body?: unknown }>;
  /** Requests to a given path suffix. */
  requestsTo: (suffix: string) => Array<{ url: string; method: string; body?: unknown }>;
  setHandler: (suffix: string, handler: () => { status: number; body: unknown }) => void;
  segmentResponses: Array<{ status: number; body: unknown }>;
  trackedEvents: Array<{ experiment: string; variant: string; metric: string }>;
}

export function createMockServer(options: MockServerOptions = {}): MockServer {
  const requests: MockServer['requests'] = [];
  const handlers: Record<string, () => { status: number; body: unknown }> = { ...options.handlers };
  const segmentResponses: Array<{ status: number; body: unknown }> = [];
  const trackedEvents: MockServer['trackedEvents'] = [];

  let segmentCount = 0;

  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(url);
    let parsedBody: unknown;
    if (init?.body && typeof init.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    } else if (init?.body instanceof FormData) {
      parsedBody = Object.fromEntries(
        [...init.body.entries()].map(([k, v]) => [k, v instanceof Blob ? `<blob:${v.size}>` : v]),
      );
    }
    requests.push({ url: path, method, ...(parsedBody !== undefined ? { body: parsedBody } : {}) });

    const suffix = Object.keys(handlers).find((key) => path.endsWith(key));
    if (suffix) return respond(handlers[suffix]!());

    if (path.endsWith('/config')) {
      return respond({ status: 200, body: { ok: true, ...TEST_CONFIG } });
    }

    if (path.includes('/ab/assignments')) {
      return respond({
        status: 200,
        body: {
          ok: true,
          enabled: true,
          assignments: options.assignments ?? {
            mic_control: 'hold',
            onboarding: 'guided',
            autoplay_tts: 'autoplay',
            result_layout: 'stacked',
          },
        },
      });
    }

    if (path.endsWith('/ab/event')) {
      const events = (parsedBody as { events?: MockServer['trackedEvents'] })?.events ?? [];
      trackedEvents.push(...events);
      return respond({ status: 202, body: { ok: true, recorded: events.length } });
    }

    if (path.endsWith('/session/start')) {
      return respond({
        status: 201,
        body: { ok: true, sessionId: 'session-test', quota: quotaSnapshot() },
      });
    }

    if (path.endsWith('/stop')) {
      return respond({ status: 200, body: { ok: true, quota: quotaSnapshot({ sessionEnded: true }) } });
    }

    if (path.endsWith('/translate/segment')) {
      const scripted = segmentResponses[segmentCount] ?? segmentResponses.at(-1);
      segmentCount += 1;
      if (scripted) return respond(scripted);

      return respond({
        status: 200,
        body: {
          ok: true,
          status: 'recognized',
          segment: {
            id: `segment-${segmentCount}`,
            sourceText: 'مرحبا، كيف حالك؟',
            translatedText: 'Hello, how are you?',
            sourceLang: 'ar-SA',
            targetLang: 'en-US',
            confidence: 0.94,
            matchQuality: 1,
            audioSeconds: 2,
            createdAt: Date.now(),
          },
          quota: quotaSnapshot({ sessionSecondsUsed: 2 * segmentCount }),
        },
      });
    }

    return respond({ status: 404, body: { ok: false, error: { kind: 'bad_request', message: 'Not found' } } });
  });

  return {
    fetch: fetchImpl,
    requests,
    requestsTo: (suffix) => requests.filter((r) => r.url.endsWith(suffix)),
    setHandler: (suffix, handler) => {
      handlers[suffix] = handler;
    },
    segmentResponses,
    trackedEvents,
  };
}

function respond({ status, body }: { status: number; body: unknown }): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Standard error envelope, matching the server's `PipelineError.toResponse()`. */
export function apiError(
  kind: string,
  message: string,
  extras: { retryable?: boolean; haltProvider?: boolean } = {},
) {
  return {
    ok: false,
    error: {
      kind,
      provider: 'backend',
      message,
      retryable: extras.retryable ?? false,
      haltProvider: extras.haltProvider ?? false,
    },
  };
}
