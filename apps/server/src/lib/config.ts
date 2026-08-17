import { z } from 'zod';
import type { ProviderMode } from '../types/index.js';

const numeric = (fallback: number) =>
  z
    .preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().finite().positive())
    .default(fallback);

const boolish = (fallback: boolean) =>
  z
    .preprocess((v) => (v === undefined || v === '' ? undefined : String(v).toLowerCase() === 'true'), z.boolean())
    .default(fallback);

export const configSchema = z.object({
  port: numeric(8787),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),

  /** Whisper — runs locally, no credentials. */
  whisperModel: z.string().default('onnx-community/whisper-base'),
  whisperDtype: z.enum(['fp32', 'fp16', 'q8', 'q4']).default('q8'),
  /** Peak level below which a clip is treated as silence and never inferred. */
  whisperSilenceThreshold: numeric(0.006),
  /** Load the model at boot rather than on the first user request. */
  whisperWarmup: boolish(true),

  /** MyMemory — free, no key. An email raises the daily character allowance. */
  myMemoryEndpoint: z.string().default('https://api.mymemory.translated.net/get'),
  myMemoryEmail: z.string().default(''),

  /** Allowed browser origins. `*` permits any; otherwise a comma-separated list. */
  corsOrigin: z.string().default('*'),

  providerMode: z.enum(['real', 'mock', 'auto']).default('auto'),
  payloadEncryptionKey: z.string().default(''),

  quota: z.object({
    dailySeconds: numeric(600),
    monthlySeconds: numeric(9000),
    sessionSeconds: numeric(120),
    maxConcurrentPerUser: numeric(1),
    maxConcurrentGlobal: numeric(25),
    globalDailySeconds: numeric(36_000),
    /**
     * MyMemory hard-rejects anything over 500 characters, so this is a real
     * upstream constraint rather than a policy choice.
     */
    maxCharsPerTranslation: numeric(500),
    maxAudioBytes: numeric(8_000_000),
    /**
     * MyMemory's allowance is **daily**, roughly 5k characters anonymously and
     * 50k with a contact address. Staying under it is the whole cost story now
     * that speech and synthesis are free.
     */
    globalDailyTranslatedChars: numeric(4_500),
    /** Idle sessions are reaped so a forgotten tab cannot hold a slot. */
    sessionIdleTimeoutSeconds: numeric(120),
  }),

  ab: z.object({
    enabled: boolish(true),
    salt: z.string().default('auto-transliteration-v1'),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse({
    port: env.PORT,
    nodeEnv: env.NODE_ENV,

    whisperModel: env.WHISPER_MODEL,
    whisperDtype: env.WHISPER_DTYPE,
    whisperSilenceThreshold: env.WHISPER_SILENCE_THRESHOLD,
    whisperWarmup: env.WHISPER_WARMUP,

    myMemoryEndpoint: env.MYMEMORY_ENDPOINT,
    myMemoryEmail: env.MYMEMORY_EMAIL ?? '',

    corsOrigin: env.CORS_ORIGIN ?? '*',
    providerMode: env.PROVIDER_MODE,
    payloadEncryptionKey: env.PAYLOAD_ENCRYPTION_KEY ?? '',

    quota: {
      dailySeconds: env.QUOTA_DAILY_SECONDS,
      monthlySeconds: env.QUOTA_MONTHLY_SECONDS,
      sessionSeconds: env.QUOTA_SESSION_SECONDS,
      maxConcurrentPerUser: env.QUOTA_MAX_CONCURRENT_PER_USER,
      maxConcurrentGlobal: env.QUOTA_MAX_CONCURRENT_GLOBAL,
      globalDailySeconds: env.QUOTA_GLOBAL_DAILY_SECONDS,
      maxCharsPerTranslation: env.QUOTA_MAX_CHARS_PER_TRANSLATION,
      maxAudioBytes: env.QUOTA_MAX_AUDIO_BYTES,
      globalDailyTranslatedChars: env.QUOTA_GLOBAL_DAILY_TRANSLATED_CHARS,
      sessionIdleTimeoutSeconds: env.QUOTA_SESSION_IDLE_TIMEOUT_SECONDS,
    },

    ab: {
      enabled: env.AB_ENABLED,
      salt: env.AB_SALT,
    },
  });
}

/**
 * Resolves `auto` into a concrete mode per service.
 *
 * Neither provider needs a credential now, so `auto` means "real" for both —
 * the only reason to force `mock` is to avoid the Whisper model download or to
 * run the tests offline.
 */
export function resolveProviderMode(config: AppConfig, _service: 'stt' | 'translate'): ProviderMode {
  return config.providerMode === 'mock' ? 'mock' : 'real';
}
