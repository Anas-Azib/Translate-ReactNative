import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { DEFAULT_SOURCE, DEFAULT_TARGET, LANGUAGES } from '../lib/languages.js';
import { describeProviders } from '../services/providerFactory.js';
import type { Providers } from '../types/index.js';
import type { AppConfig } from '../lib/config.js';
import type { QuotaManager } from '../usage/quotaManager.js';
import type { TranslationPipeline } from '../services/pipeline.js';

/** Health, capability discovery, and usage reporting. */
export function metaRoutes(
  providers: Providers,
  quota: QuotaManager,
  pipeline: TranslationPipeline,
  config: AppConfig,
  /** Live WebSocket counters, injected after the hub is created. */
  stats?: () => { connections: number; sessions: number },
): Router {
  const router = Router();

  /**
   * Render's health check polls this.
   *
   * Deliberately cheap and independent of the Whisper model: reporting
   * unhealthy during a cold start would make Render kill the instance while it
   * was still downloading weights, and the deploy would never converge.
   */
  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      status: 'healthy',
      uptimeSeconds: Math.round(process.uptime()),
      providers: describeProviders(providers),
      haltedProviders: pipeline.circuit.status().map((h) => ({ provider: h.provider, kind: h.kind })),
      websocket: stats?.() ?? null,
    });
  });

  /**
   * Everything the client needs to render before the first interaction.
   * There are no credentials to withhold any more — Whisper is local and
   * MyMemory is keyless — but the response is still limited to what the UI
   * actually needs.
   */
  router.get(
    '/config',
    asyncHandler((req, res) => {
      res.json({
        ok: true,
        languages: LANGUAGES,
        defaults: { source: DEFAULT_SOURCE, target: DEFAULT_TARGET },
        limits: {
          sessionSeconds: config.quota.sessionSeconds,
          dailySeconds: config.quota.dailySeconds,
          monthlySeconds: config.quota.monthlySeconds,
          maxCharsPerTranslation: config.quota.maxCharsPerTranslation,
          maxAudioBytes: config.quota.maxAudioBytes,
        },
        providers: describeProviders(providers),
        usage: quota.userUsage(req.userId),
      });
    }),
  );

  router.get(
    '/usage',
    asyncHandler((req, res) => {
      res.json({ ok: true, user: quota.userUsage(req.userId) });
    }),
  );

  /**
   * Operational counters. Backs the "Track usage per user and globally"
   * requirement — scrape this to alert when the app-wide daily character spend
   * approaches MyMemory's allowance.
   */
  router.get(
    '/metrics',
    asyncHandler((_req, res) => {
      const global = quota.globalUsage();
      res.json({
        ok: true,
        global,
        pendingAudioBuffers: pipeline.pendingAudioBuffers,
        websocket: stats?.() ?? null,
        halted: pipeline.circuit.status(),
        budget: {
          translatedCharsToday: global.daily.translatedChars,
          translatedCharsDailyLimit: config.quota.globalDailyTranslatedChars,
          audioSecondsUsedToday: global.daily.audioSeconds,
          audioSecondsLimitToday: config.quota.globalDailySeconds,
        },
      });
    }),
  );

  return router;
}
