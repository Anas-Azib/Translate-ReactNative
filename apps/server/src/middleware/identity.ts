import type { NextFunction, Request, Response } from 'express';
import { stableHash } from '../lib/crypto.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: string;
      rawDeviceId: string;
    }
  }
}

/**
 * Derives a stable pseudonymous user id from the client's device id.
 *
 * The raw device id is hashed with a server-side salt and never stored, so the
 * usage counters and experiment buckets are keyed by something that cannot be
 * reversed back to a device. This is what makes per-user quota tracking
 * possible without holding personal data — which matters given the plan
 * document's "encrypted, temporarily processed, then deleted" requirement.
 */
export function identityMiddleware(salt: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header('x-device-id');
    const raw = typeof header === 'string' && header.length >= 8 ? header.slice(0, 128) : `anon:${req.ip ?? 'unknown'}`;
    req.rawDeviceId = raw;
    req.userId = stableHash(salt, raw).slice(0, 32);
    next();
  };
}
