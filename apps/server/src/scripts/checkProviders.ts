/**
 * Provider smoke test: `npm run check:providers`
 *
 * There are no credentials to validate any more, but two things can still go
 * wrong before a single user shows up: the Whisper model may fail to download,
 * and MyMemory may be unreachable or out of daily allowance. This checks both,
 * using the same failure classification the app itself uses.
 */
import { loadEnv } from '../lib/env.js';

const { loaded } = loadEnv();

const { loadConfig } = await import('../lib/config.js');
const { WhisperSttProvider } = await import('../services/stt.whisper.js');
const { MyMemoryTranslateProvider } = await import('../services/translate.mymemory.js');
const { PipelineError } = await import('../lib/errors.js');

const config = loadConfig();

type Outcome = 'ok' | 'failed';

interface Result {
  service: string;
  outcome: Outcome;
  detail: string;
  fix?: string;
}

const FIXES: Record<string, string> = {
  auth_failure: 'MyMemory rejected the request. If MYMEMORY_EMAIL is set, check that it is a valid address.',
  quota_exceeded:
    "MyMemory's daily allowance is spent. Set MYMEMORY_EMAIL in .env to raise it from ~5k to ~50k characters/day.",
  bad_request: 'The request was rejected. Check MYMEMORY_ENDPOINT in .env.',
  transient: 'Could not reach the service. Check your network, then retry.',
  unknown: 'Unrecognised response from the service.',
};

/** Synthesises a spoken-like WAV so Whisper has something above the silence gate. */
function probeWav(seconds = 1.2): Buffer {
  const sampleRate = 16_000;
  const frames = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    const syllable = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.5 * t);
    const sample = (Math.sin(2 * Math.PI * 180 * t) * 0.6 + Math.sin(2 * Math.PI * 360 * t) * 0.3) * syllable;
    data.writeInt16LE(Math.round(sample * 9000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function checkWhisper(): Promise<Result> {
  const provider = new WhisperSttProvider({
    model: config.whisperModel,
    dtype: config.whisperDtype,
    silenceThreshold: config.whisperSilenceThreshold,
  });

  const started = Date.now();
  try {
    console.log(`  loading ${config.whisperModel} (first run downloads weights) ...`);
    await provider.warmup();
    const loadMs = Date.now() - started;

    const inferStart = Date.now();
    const result = await provider.recognize({
      audio: probeWav(),
      mimeType: 'audio/wav',
      languageCode: 'en',
      durationSeconds: 1.2,
    });

    return {
      service: `Whisper (${config.whisperModel})`,
      outcome: 'ok',
      detail:
        `model ready in ${(loadMs / 1000).toFixed(1)}s, inference ${Date.now() - inferStart}ms ` +
        `(probe returned ${result.status})`,
    };
  } catch (err) {
    const kind = err instanceof PipelineError ? err.kind : 'unknown';
    return {
      service: `Whisper (${config.whisperModel})`,
      outcome: 'failed',
      detail: err instanceof Error ? err.message : String(err),
      fix:
        kind === 'transient'
          ? 'The model download failed. Check your network, or set WHISPER_MODEL to a smaller model.'
          : FIXES.unknown!,
    };
  }
}

async function checkMyMemory(): Promise<Result> {
  const provider = new MyMemoryTranslateProvider({
    endpoint: config.myMemoryEndpoint,
    email: config.myMemoryEmail,
  });

  try {
    const started = Date.now();
    const result = await provider.translate({ text: 'hello', sourceLang: 'en', targetLang: 'ar' });
    return {
      service: 'MyMemory translation',
      outcome: 'ok',
      detail:
        `"hello" → "${result.text}" in ${Date.now() - started}ms` +
        (config.myMemoryEmail ? ' (using the raised daily allowance)' : ' (anonymous ~5k chars/day)'),
    };
  } catch (err) {
    const kind = err instanceof PipelineError ? err.kind : 'unknown';
    return {
      service: 'MyMemory translation',
      outcome: 'failed',
      detail: kind.replace(/_/g, ' '),
      fix: FIXES[kind] ?? FIXES.unknown!,
    };
  }
}

const ICONS: Record<Outcome, string> = { ok: '  OK   ', failed: ' FAIL  ' };

async function main() {
  console.log('\n  Provider check');
  console.log('  ────────────────────────────────────────────────────────────');
  console.log(`  env file   ${loaded.length ? loaded.join(', ') : 'none found'}`);
  console.log(`  mode       PROVIDER_MODE=${config.providerMode}`);
  console.log('  Speech synthesis runs in the browser — nothing to check here.\n');

  // Sequential: the model load is memory-hungry and there is no point racing it
  // against a network call.
  const results = [await checkWhisper(), await checkMyMemory()];

  console.log('');
  for (const result of results) {
    console.log(`  [${ICONS[result.outcome]}] ${result.service}`);
    console.log(`           ${result.detail}`);
    if (result.fix) console.log(`           → ${result.fix}`);
  }

  const failed = results.filter((r) => r.outcome === 'failed');
  console.log('  ────────────────────────────────────────────────────────────');
  console.log(
    failed.length === 0
      ? '  Both providers are working. No API keys are needed.\n'
      : `  ${failed.length} provider(s) failed. See the fixes above.\n`,
  );

  process.exit(failed.length > 0 ? 1 : 0);
}

await main();
