/**
 * Production bundle for Render.
 *
 * Bundling rather than plain `tsc` for one specific reason: the server imports
 * `@translate/shared`, a workspace package that exists only as a symlink into
 * ../../packages. A tsc build would emit an import that resolves at runtime
 * only if the whole workspace ships alongside it. esbuild inlines the shared
 * source into a single file, so `apps/server/dist/index.js` is self-contained.
 *
 * Real npm dependencies stay external — onnxruntime ships native binaries that
 * cannot be bundled, and re-bundling express buys nothing.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Everything from npm stays external; only the workspace package is inlined.
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@translate/'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  external,
  // Node 20 ESM has no require(); give bundled CJS deps a working shim.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
