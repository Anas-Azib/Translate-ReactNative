import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { applyOverrides, assignAll } from '../experiments/assignment.js';
import { EXPERIMENTS, METRICS } from '../experiments/registry.js';
import type { ExperimentStore } from '../experiments/store.js';
import type { AppConfig } from '../lib/config.js';

const eventSchema = z.object({
  experiment: z.string().min(1),
  variant: z.string().min(1),
  metric: z.enum(METRICS as [string, ...string[]]),
  value: z.number().finite().optional(),
});

const batchSchema = z.object({
  events: z.array(eventSchema).min(1).max(50),
});

/**
 * A/B endpoints.
 *
 * Assignment is computed server-side and echoed to the client so both sides
 * agree, and conversions are posted back here rather than being trusted to a
 * client-side aggregate.
 */
export function experimentRoutes(store: ExperimentStore, config: AppConfig): Router {
  const router = Router();

  router.get(
    '/assignments',
    asyncHandler((req, res) => {
      const base = assignAll(req.userId, config.ab.salt);
      const assignments = config.ab.enabled
        ? applyOverrides(base, req.query as Record<string, string | undefined>)
        : Object.fromEntries(EXPERIMENTS.map((e) => [e.key, e.variants[0]!.key]));

      for (const [experiment, variant] of Object.entries(assignments)) {
        store.recordExposure(experiment, variant, req.userId);
      }

      res.json({
        ok: true,
        enabled: config.ab.enabled,
        assignments,
        experiments: EXPERIMENTS.map((e) => ({
          key: e.key,
          description: e.description,
          primaryMetric: e.primaryMetric,
          variants: e.variants.map((v) => v.key),
        })),
      });
    }),
  );

  router.post(
    '/event',
    asyncHandler((req, res) => {
      const parsed = batchSchema.safeParse(req.body);
      const events = parsed.success ? parsed.data.events : [eventSchema.parse(req.body)];

      for (const event of events) {
        store.recordEvent({
          userId: req.userId,
          experiment: event.experiment,
          variant: event.variant,
          metric: event.metric as (typeof METRICS)[number],
          ...(event.value !== undefined ? { value: event.value } : {}),
        });
      }

      res.status(202).json({ ok: true, recorded: events.length });
    }),
  );

  router.get(
    '/report',
    asyncHandler((_req, res) => {
      res.json({ ok: true, reports: store.reportAll(), totalEvents: store.eventCount });
    }),
  );

  router.get(
    '/report/:experiment',
    asyncHandler((req, res) => {
      const report = store.report(req.params.experiment!);
      if (!report) {
        res.status(404).json({ ok: false, error: { kind: 'bad_request', message: 'Unknown experiment' } });
        return;
      }
      res.json({ ok: true, report });
    }),
  );

  return router;
}
