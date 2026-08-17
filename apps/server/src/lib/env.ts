import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * Loads `.env` by searching upward from this module.
 *
 * The obvious `import 'dotenv/config'` resolves `.env` against
 * `process.cwd()`, and npm sets the cwd to `server/` when it runs a workspace
 * script — so a `.env` at the repo root is never found. That failure is silent
 * and nasty: the app keeps working, just on the offline providers, and it looks
 * like your credentials are wrong when they were simply never read.
 *
 * Searching upward finds the file whether it sits next to the server or at the
 * repo root, and whether the code is running from `src/` under tsx or `dist/`
 * after a build.
 */
export function loadEnv(startDir?: string): { loaded: string[] } {
  const start = startDir ?? dirname(fileURLToPath(import.meta.url));
  const loaded: string[] = [];

  let dir = start;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      // `override: false` — a real environment variable always beats a file, so
      // deployments and `cross-env PORT=…` keep working as expected.
      dotenv.config({ path: candidate, override: false });
      loaded.push(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { loaded };
}
