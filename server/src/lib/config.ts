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

  azureSpeechKey: z.string().default(''),
  azureSpeechRegion: z.string().default('westeurope'),
  googleTranslateApiKey: z.string().default(''),
  googleTtsApiKey: z.string().default(''),
  googleProjectId: z.string().default(''),

  providerMode: z.enum(['real', 'mock', 'auto']).default('auto'),
  payloadEncryptionKey: z.string().default(''),

  quota: z.object({
    dailySeconds: numeric(600),
    monthlySeconds: numeric(9000),
    sessionSeconds: numeric(120),
    maxConcurrentPerUser: numeric(1),
    maxConcurrentGlobal: numeric(25),
    globalDailySeconds: numeric(36_000),
    maxCharsPerTranslation: numeric(800),
    maxAudioBytes: numeric(2_000_000),
    globalMonthlyTranslatedChars: numeric(450_000),
    globalMonthlyTtsChars: numeric(3_800_000),
    /** Idle sessions are reaped so a forgotten tab cannot hold a concurrency slot. */
    sessionIdleTimeoutSeconds: numeric(120),
  }),

  ab: z.object({
    enabled: boolish(true),
    salt: z.string().default('auto-transliteration-v1'),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const googleFallback = env.GOOGLE_API_KEY ?? '';
  return configSchema.parse({
    port: env.PORT,
    nodeEnv: env.NODE_ENV,

    azureSpeechKey: env.AZURE_SPEECH_KEY ?? '',
    azureSpeechRegion: env.AZURE_SPEECH_REGION,
    googleTranslateApiKey: env.GOOGLE_TRANSLATE_API_KEY || googleFallback,
    googleTtsApiKey: env.GOOGLE_TTS_API_KEY || googleFallback,
    googleProjectId: env.GOOGLE_PROJECT_ID ?? '',

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
      globalMonthlyTranslatedChars: env.QUOTA_GLOBAL_MONTHLY_TRANSLATED_CHARS,
      globalMonthlyTtsChars: env.QUOTA_GLOBAL_MONTHLY_TTS_CHARS,
      sessionIdleTimeoutSeconds: env.QUOTA_SESSION_IDLE_TIMEOUT_SECONDS,
    },

    ab: {
      enabled: env.AB_ENABLED,
      salt: env.AB_SALT,
    },
  });
}

/**
 * Resolves `auto` into a concrete mode per service, so a deployment with only
 * Google keys still gets real translation while STT falls back to mock.
 */
export function resolveProviderMode(
  config: AppConfig,
  service: 'stt' | 'translate' | 'tts',
): ProviderMode {
  if (config.providerMode === 'mock') return 'mock';

  const hasKey =
    service === 'stt'
      ? Boolean(config.azureSpeechKey && config.azureSpeechRegion)
      : service === 'translate'
        ? Boolean(config.googleTranslateApiKey)
        : Boolean(config.googleTtsApiKey);

  if (config.providerMode === 'real') return hasKey ? 'real' : 'mock';
  return hasKey ? 'real' : 'mock';
}
