import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locates the built web client, if it was built.
 *
 * Serving the front end from the same process as the API is the simplest way to
 * deploy this app: one origin means no CORS configuration, no second hosting
 * provider, and `VITE_API_URL` can stay empty because the client's same-origin
 * fallback then resolves to exactly the right place.
 *
 * Returns `null` when there is no bundle — during local development the web app
 * is served by Vite on its own port, and the backend must not try to serve a
 * directory that does not exist.
 */
export function findWebDist(): string | null {
  const explicit = process.env.WEB_DIST;
  if (explicit) return existsSync(explicit) ? resolve(explicit) : null;

  const here = dirname(fileURLToPath(import.meta.url));

  // Checked in order of likelihood rather than assuming one layout: the bundle
  // runs from apps/server/dist, but the source tree runs from apps/server/src,
  // and the working directory depends on how the process was started.
  const candidates = [
    resolve(here, '../../../web/dist'), // apps/server/dist/lib → apps/web/dist
    resolve(here, '../../web/dist'), // apps/server/dist      → apps/web/dist
    resolve(process.cwd(), 'apps/web/dist'), // started from the repo root
    resolve(process.cwd(), '../web/dist'), // started from apps/server
  ];

  return candidates.find((path) => existsSync(resolve(path, 'index.html'))) ?? null;
}
