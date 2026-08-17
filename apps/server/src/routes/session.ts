import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { PipelineError } from '../lib/errors.js';
import type { QuotaManager } from '../usage/quotaManager.js';

const stopSchema = z.object({
  reason: z.enum(['user_stopped', 'session_limit', 'expired']).optional(),
});

/**
 * Session lifecycle.
 *
 * Sessions are explicit by design: the plan document requires that after a
 * limit stop the user must "explicitly start a new session", so nothing here
 * auto-renews.
 */
export function sessionRoutes(quota: QuotaManager): Router {
  const router = Router();

  router.post(
    '/start',
    asyncHandler((req, res) => {
      const { session, snapshot } = quota.startSession(req.userId);
      res.status(201).json({
        ok: true,
        sessionId: session.id,
        startedAt: session.startedAt,
        quota: snapshot,
      });
    }),
  );

  router.get(
    '/:sessionId',
    asyncHandler((req, res) => {
      const sessionId = req.params.sessionId!;
      const session = quota.getSession(sessionId);
      if (!session || session.userId !== req.userId) {
        throw new PipelineError('internal_quota_exceeded', 'backend', 'unknown_session');
      }
      res.json({ ok: true, quota: quota.snapshot(sessionId), segments: session.segments });
    }),
  );

  router.post(
    '/:sessionId/stop',
    asyncHandler((req, res) => {
      const sessionId = req.params.sessionId!;
      const { reason } = stopSchema.parse(req.body ?? {});
      const session = quota.getSession(sessionId);
      if (!session || session.userId !== req.userId) {
        throw new PipelineError('internal_quota_exceeded', 'backend', 'unknown_session');
      }
      quota.endSession(sessionId, reason ?? 'user_stopped');
      res.json({ ok: true, quota: quota.snapshot(sessionId) });
    }),
  );

  return router;
}
