import 'dotenv/config';
import { createApp } from './app.js';
import { describeProviders } from './services/providerFactory.js';

const { app, config, quota, providers } = createApp();

const server = app.listen(config.port, () => {
  const modes = describeProviders(providers);
  console.log(`\n  Auto Transliteration API`);
  console.log(`  ────────────────────────────────────────────`);
  console.log(`  http://localhost:${config.port}    (${config.nodeEnv})`);
  console.log(`  STT        ${modes.stt.name}        [${modes.stt.mode}]`);
  console.log(`  Translate  ${modes.translate.name}  [${modes.translate.mode}]`);
  console.log(`  TTS        ${modes.tts.name}        [${modes.tts.mode}]`);
  if (Object.values(modes).some((m) => m.mode === 'mock')) {
    console.log(`\n  Some providers are mocked — add keys to .env for live calls.`);
  }
  console.log(
    `\n  Limits: ${config.quota.sessionSeconds}s/session · ${config.quota.dailySeconds}s/day · ` +
      `${config.quota.maxConcurrentGlobal} concurrent\n`,
  );
});

// Idle sessions must not hold a concurrency slot forever.
const reaper = setInterval(() => {
  quota.reapIdle();
  quota.store.prune(Date.now());
}, 30_000);
reaper.unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n  ${signal} — shutting down`);
    clearInterval(reaper);
    server.close(() => process.exit(0));
  });
}
