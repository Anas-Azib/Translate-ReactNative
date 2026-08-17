import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { PipelineError } from '../lib/errors.js';
import { quotaMessage } from '../usage/quotaManager.js';
import type { QuotaRejectReason } from '../usage/quotaManager.js';

/** Wraps an async handler so rejections reach the error middleware. */
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Single place where a failure becomes an HTTP response. Every error the client
 * can see carries the plan document's user-facing copy plus a `retryable` flag,
 * so the UI never has to guess whether offering a "try again" button is
 * appropriate — and never retries something the plan says to stop retrying.
 */
export function errorHandler(isProduction: boolean) {
  return (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }

    if (err instanceof PipelineError) {
      const body = err.toResponse();
      // Internal quota rejections carry the specific limit in `detail`; swap in
      // the friendlier, more actionable message for it.
      if (err.kind === 'internal_quota_exceeded' && err.detail) {
        body.error.message = quotaMessage(err.detail as QuotaRejectReason) ?? body.error.message;
      }
      res.status(err.policy.httpStatus).json(body);
      return;
    }

    if (err instanceof ZodError) {
      res.status(400).json({
        ok: false,
        error: {
          kind: 'bad_request',
          provider: 'backend',
          message: "That request couldn't be processed. Try recording again.",
          retryable: false,
          haltProvider: false,
          ...(isProduction ? {} : { issues: err.issues }),
        },
      });
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    if (!isProduction) console.error('[unhandled]', err);

    res.status(500).json({
      ok: false,
      error: {
        kind: 'unknown',
        provider: 'backend',
        message: 'Something went wrong. Please try again.',
        retryable: false,
        haltProvider: false,
        ...(isProduction ? {} : { detail: message }),
      },
    });
  };
}
