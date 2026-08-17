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
): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      status: 'healthy',
      uptimeSeconds: Math.round(process.uptime()),
      providers: describeProviders(providers),
      haltedProviders: pipeline.circuit.status().map((h) => ({ provider: h.provider, kind: h.kind })),
    });
  });

  /**
   * Everything the client needs to render before the first interaction.
   * Note what is *not* here: no keys, no endpoints, no service-account details.
   * (Plan doc p.4: "Never expose Google Cloud service-account credentials in
   * the mobile application.")
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
   * Operational counters. Backs the "Track usage per user and globally" and
   * budget-alert requirements — scrape this to drive an alert when the app-wide
   * character spend approaches the free-tier ceiling.
   */
  router.get(
    '/metrics',
    asyncHandler((_req, res) => {
      const global = quota.globalUsage();
      res.json({
        ok: true,
        global,
        ttsCache: pipeline.ttsCacheStats,
        pendingAudioBuffers: pipeline.pendingAudioBuffers,
        halted: pipeline.circuit.status(),
        budget: {
          translatedCharsUsed: global.monthly.translatedChars,
          translatedCharsLimit: config.quota.globalMonthlyTranslatedChars,
          ttsCharsUsed: global.monthly.ttsChars,
          ttsCharsLimit: config.quota.globalMonthlyTtsChars,
          audioSecondsUsedToday: global.daily.audioSeconds,
          audioSecondsLimitToday: config.quota.globalDailySeconds,
        },
      });
    }),
  );

  return router;
}
