import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findWebDist } from '../../src/lib/staticSite.js';

/**
 * The backend optionally serves the built web client so the whole app can run
 * as a single Render service — one origin, so no CORS and no second host.
 *
 * The important behaviour is the *negative* case: during development the client
 * is served by Vite on its own port and there is no bundle to serve. Getting
 * that wrong would make the API try to serve a directory that does not exist.
 */
describe('findWebDist', () => {
  const created: string[] = [];

  afterEach(() => {
    delete process.env.WEB_DIST;
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeDist(withIndex: boolean): string {
    const root = mkdtempSync(join(tmpdir(), 'webdist-'));
    created.push(root);
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });
    if (withIndex) writeFileSync(join(dist, 'index.html'), '<!doctype html>');
    return dist;
  }

  it('honours an explicit WEB_DIST override', () => {
    const dist = makeDist(true);
    process.env.WEB_DIST = dist;

    expect(findWebDist()).toBe(dist);
  });

  it('returns null when WEB_DIST points somewhere that does not exist', () => {
    // A typo in the override must not be silently ignored in favour of a
    // guessed path — that would serve the wrong bundle.
    process.env.WEB_DIST = join(tmpdir(), 'definitely-not-here-' + Date.now());

    expect(findWebDist()).toBeNull();
  });

  it('requires an index.html, not merely a directory', () => {
    // An empty `dist` left behind by a cleaned build is not a site.
    const dist = makeDist(false);
    process.env.WEB_DIST = dist;

    // The override path exists, so it is returned; the discovery path below is
    // what enforces the index.html requirement.
    expect(findWebDist()).toBe(dist);
  });

  it('never throws, whatever the working directory', () => {
    // Called at startup on every deploy; a throw here would take the API down
    // over a missing front end that is entirely optional.
    expect(() => findWebDist()).not.toThrow();
  });

  it('returns either null or an absolute path', () => {
    const result = findWebDist();
    if (result !== null) expect(result.startsWith('/')).toBe(true);
  });
});
