import { join } from 'node:path';
import express from 'express';
import type { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

import type { AppConfig } from './lib/config.js';
import { loadConfig } from './lib/config.js';
import type { Clock } from './lib/clock.js';
import { systemClock } from './lib/clock.js';
import { QuotaManager } from './usage/quotaManager.js';
import { ExperimentStore } from './experiments/store.js';
import { TranslationPipeline } from './services/pipeline.js';
import { createProviders } from './services/providerFactory.js';
import type { Providers } from './types/index.js';
import { identityMiddleware } from './middleware/identity.js';
import { errorHandler } from './middleware/errorHandler.js';
import { findWebDist } from './lib/staticSite.js';
import { sessionRoutes } from './routes/session.js';
import { translateRoutes } from './routes/translate.js';
import { experimentRoutes } from './routes/experiments.js';
import { metaRoutes } from './routes/meta.js';

export interface AppDeps {
  config?: AppConfig;
  clock?: Clock;
  providers?: Providers;
  quota?: QuotaManager;
  experiments?: ExperimentStore;
  pipeline?: TranslationPipeline;
}

export interface BuiltApp {
  app: Express;
  /** Set by the entrypoint once the WebSocket hub exists, so /health can report it. */
  setWebSocketStats: (stats: () => { connections: number; sessions: number }) => void;
  config: AppConfig;
  quota: QuotaManager;
  experiments: ExperimentStore;
  pipeline: TranslationPipeline;
  providers: Providers;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether the built web client was found at startup; surfaced on /health. */
let webClientStatus: { serving: boolean; path?: string; reason?: string } = {
  serving: false,
  reason: 'not initialised',
};

export function getWebClientStatus() {
  return webClientStatus;
}

/**
 * Composition root. Every dependency is injectable so the integration tests can
 * drive the real Express app with a fake clock and scripted providers.
 */
export function createApp(deps: AppDeps = {}): BuiltApp {
  const config = deps.config ?? loadConfig();
  const clock = deps.clock ?? systemClock;
  const providers = deps.providers ?? createProviders(config);
  const quota = deps.quota ?? new QuotaManager({ quota: config.quota, clock });
  const experiments = deps.experiments ?? new ExperimentStore({ clock });
  const pipeline = deps.pipeline ?? new TranslationPipeline({ providers, quota, config, clock });

  // Load the Whisper weights now rather than making the first user wait on a
  // cold start. Failure here is not fatal — the provider retries on demand.
  if (config.whisperWarmup && config.nodeEnv !== 'test' && providers.stt.warmup) {
    void providers.stt.warmup().catch((err: unknown) => {
      console.warn('[whisper] warmup failed, will retry on first request:', describeError(err));
    });
  }

  const app = express();
  const isProduction = config.nodeEnv === 'production';

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: false, // the SPA is served by Vite / a CDN, not here
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(compression());
  // In production the web app is served from a different origin than the API
  // (Render for the backend, a static host for the front end), so the allowed
  // origins have to be configurable rather than reflected blindly.
  const allowedOrigins = config.corsOrigin
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: allowedOrigins.includes('*') ? true : allowedOrigins,
      credentials: false,
      exposedHeaders: ['x-session-id'],
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(identityMiddleware(config.ab.salt));

  // Coarse abuse guard. The real spend control is the QuotaManager; this just
  // stops a script from burning CPU before it gets there.
  if (config.nodeEnv !== 'test') {
    app.use(
      '/api',
      rateLimit({
        windowMs: 60_000,
        limit: 120,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: {
          ok: false,
          error: {
            kind: 'quota_exceeded',
            provider: 'backend',
            message: 'Too many requests. Please slow down.',
            retryable: false,
            haltProvider: false,
          },
        },
      }),
    );
  }

  let wsStats: (() => { connections: number; sessions: number }) | undefined;
  app.use('/api', metaRoutes(providers, quota, pipeline, config, () => wsStats?.() ?? { connections: 0, sessions: 0 }));
  app.use('/api/session', sessionRoutes(quota));
  app.use('/api/translate', translateRoutes(pipeline, quota, config));
  app.use('/api/ab', experimentRoutes(experiments, config));

  // Unmatched API routes answer with JSON, never the SPA shell — a fetch that
  // silently receives HTML is far harder to debug than a clean 404.
  app.use('/api', (_req, res) => {
    res.status(404).json({
      ok: false,
      error: { kind: 'bad_request', provider: 'backend', message: 'Not found', retryable: false },
    });
  });

  /**
   * Serve the built web client, when one exists.
   *
   * This is what makes a single-service deployment possible: the API, the
   * WebSocket, and the front end all share one origin, so there is no CORS to
   * configure and the client's same-origin fallback resolves correctly with no
   * environment variables at all.
   *
   * Skipped entirely in development, where Vite serves the client on its own
   * port with hot reload.
   */
  const webDist = findWebDist();

  // Report it on /health. Without this, a service whose build command only
  // built the API looks identical to a broken one: the API answers perfectly
  // and `/` returns Express's bare "Cannot GET /", with nothing anywhere
  // saying why.
  webClientStatus = webDist
    ? { serving: true, path: webDist }
    : {
        serving: false,
        reason:
          'No web bundle found. The build command only built the API. ' +
          'Use `npm run build` (not `npm run build:server`) to build both, ' +
          'or host the front end separately.',
      };

  if (webDist) {
    app.use(
      express.static(webDist, {
        // The shell must never be cached from here; it is served explicitly
        // below so a deploy cannot leave clients pinned to stale asset URLs.
        index: false,
        setHeaders: (res, path) => {
          // Vite emits content-hashed filenames under /assets, so those are
          // safe to cache forever.
          if (path.includes(`${'/'}assets${'/'}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );

    // SPA fallback. Registered after the API and after static files, so it only
    // catches routes that are neither.
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  app.use(errorHandler(isProduction));

  return {
    app,
    config,
    quota,
    experiments,
    pipeline,
    providers,
    setWebSocketStats: (stats) => {
      wsStats = stats;
    },
  };
}
