import { createServer } from 'node:http';
import { loadEnv } from './lib/env.js';

// Must run before createApp() reads process.env.
const { loaded } = loadEnv();

const { createApp, getWebClientStatus } = await import('./app.js');
const { describeProviders } = await import('./services/providerFactory.js');
const { WebSocketHub } = await import('./ws/hub.js');

const { app, config, quota, providers, pipeline, setWebSocketStats } = createApp();

// The WebSocket server shares the HTTP server: Render exposes a single port,
// so the upgrade handshake has to arrive on the same listener as the REST API.
const server = createServer(app);
const hub = new WebSocketHub({ server, pipeline, quota, config });
setWebSocketStats(() => ({ connections: hub.connectionCount, sessions: hub.sessionCount }));

// 0.0.0.0 is required on Render — binding to localhost makes the service
// unreachable from outside the container and the deploy fails its health check.
const host = process.env.HOST ?? '0.0.0.0';

server.listen(config.port, host, () => {
  const modes = describeProviders(providers);
  console.log(`\n  Auto Transliteration API`);
  console.log(`  ────────────────────────────────────────────`);
  console.log(`  http://${host}:${config.port}    (${config.nodeEnv})`);
  console.log(`  ws   ://${host}:${config.port}/ws`);
  console.log(
    `  STT        ${modes.stt.name}  [${modes.stt.mode}]` +
      ('model' in modes.stt ? `  ${modes.stt.model}` : ''),
  );
  console.log(`  Translate  ${modes.translate.name}  [${modes.translate.mode}]`);
  console.log(`  TTS        browser speechSynthesis  [on device]`);

  // Say plainly whether the front end is being served. A silent skip here is
  // what turns a correct API into a site that answers "Cannot GET /".
  const web = getWebClientStatus();
  console.log(
    `  Web client ${web.serving ? `serving from ${web.path}` : 'NOT SERVED (API only)'}`,
  );
  if (!web.serving) {
    console.warn(`\n  ⚠  ${web.reason}\n`);
  }
  console.log(
    `  env        ${loaded.length ? loaded.join(', ') : 'none found (using defaults)'}`,
  );
  if (Object.values(modes).some((m) => m.mode === 'mock')) {
    console.log(`\n  Providers are mocked (PROVIDER_MODE=mock).`);
  }
  console.log(
    `\n  Limits: ${config.quota.sessionSeconds}s/session · ${config.quota.dailySeconds}s/day · ` +
      `${config.quota.maxConcurrentGlobal} concurrent\n`,
  );
});

/**
 * Backstop reaper.
 *
 * Sessions are now released the moment their socket closes, so this should
 * find nothing. It stays as a safety net for any session created outside the
 * WebSocket path (the REST endpoint) and to prune old usage buckets.
 */
const reaper = setInterval(() => {
  quota.reapIdle();
  quota.store.prune(Date.now());
}, 30_000);
reaper.unref();

/**
 * Graceful shutdown.
 *
 * Render sends SIGTERM before it replaces an instance. Closing the hub first
 * releases every session and tells each client why, so a redeploy does not
 * strand sessions or leave clients silently talking to a dead process.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n  ${signal} — shutting down`);
  clearInterval(reaper);

  await hub.close();
  server.close(() => process.exit(0));

  // Render's grace period is finite; do not wait forever on a lingering socket.
  setTimeout(() => process.exit(0), 8000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}
