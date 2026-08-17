import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { PipelineError } from '../lib/errors.js';
import { isSupported } from '../lib/languages.js';
import type { TranslationPipeline } from '../services/pipeline.js';
import type { QuotaManager } from '../usage/quotaManager.js';
import type { AppConfig } from '../lib/config.js';

const segmentSchema = z.object({
  sessionId: z.string().min(8),
  sourceLang: z.string().min(2).refine(isSupported, 'unsupported source language'),
  targetLang: z.string().min(2).refine(isSupported, 'unsupported target language'),
  durationSeconds: z.coerce.number().min(0).max(120),
  previousText: z.string().max(2000).optional(),
});

/**
 * The translation endpoint.
 *
 * `POST /api/translate/segment` takes WAV audio and returns recognised text
 * plus its translation. There is no longer a `/speak` endpoint: the client
 * synthesises speech locally, so no audio is ever sent back.
 */
export function translateRoutes(
  pipeline: TranslationPipeline,
  quota: QuotaManager,
  config: AppConfig,
): Router {
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(), // never touches disk
    limits: { fileSize: config.quota.maxAudioBytes, files: 1 },
  });

  router.post(
    '/segment',
    // Multer's own limit rejects oversized bodies before we buffer them.
    (req, res, next) => {
      upload.single('audio')(req, res, (err: unknown) => {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'LIMIT_FILE_SIZE') {
          next(new PipelineError('bad_request', 'backend', 'audio_too_large'));
          return;
        }
        next(err as Error | undefined);
      });
    },
    asyncHandler(async (req, res) => {
      const input = segmentSchema.parse(req.body ?? {});

      const session = quota.getSession(input.sessionId);
      if (!session || session.userId !== req.userId) {
        throw new PipelineError('internal_quota_exceeded', 'backend', 'unknown_session');
      }

      if (!req.file?.buffer?.length) {
        throw new PipelineError('bad_request', 'backend', 'missing audio');
      }

      const outcome = await pipeline.translateSegment({
        sessionId: input.sessionId,
        audio: req.file.buffer,
        mimeType: req.file.mimetype || 'audio/wav',
        durationSeconds: input.durationSeconds,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        ...(input.previousText !== undefined ? { previousText: input.previousText } : {}),
      });

      res.json({ ok: true, ...outcome });
    }),
  );

  return router;
}
