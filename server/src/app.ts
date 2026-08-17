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
  config: AppConfig;
  quota: QuotaManager;
  experiments: ExperimentStore;
  pipeline: TranslationPipeline;
  providers: Providers;
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
  app.use(cors({ origin: true, credentials: false, exposedHeaders: ['x-session-id'] }));
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

  app.use('/api', metaRoutes(providers, quota, pipeline, config));
  app.use('/api/session', sessionRoutes(quota));
  app.use('/api/translate', translateRoutes(pipeline, quota, config));
  app.use('/api/ab', experimentRoutes(experiments, config));

  app.use('/api', (_req, res) => {
    res.status(404).json({
      ok: false,
      error: { kind: 'bad_request', provider: 'backend', message: 'Not found', retryable: false },
    });
  });

  app.use(errorHandler(isProduction));

  return { app, config, quota, experiments, pipeline, providers };
}
