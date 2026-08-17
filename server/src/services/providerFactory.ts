import type { AppConfig } from '../lib/config.js';
import { resolveProviderMode } from '../lib/config.js';
import type { Providers } from '../types/index.js';
import { AzureSttProvider, MockSttProvider } from './stt.azure.js';
import { GoogleTranslateProvider, MockTranslateProvider } from './translate.google.js';
import { GoogleTtsProvider, MockTtsProvider } from './tts.google.js';

/**
 * Chooses real vs mock per service. A deployment with only Google keys still
 * gets real translation and TTS while STT falls back to the offline provider,
 * which keeps the app demoable at every stage of credential setup.
 */
export function createProviders(config: AppConfig, fetchImpl?: typeof fetch): Providers {
  const sttMode = resolveProviderMode(config, 'stt');
  const translateMode = resolveProviderMode(config, 'translate');
  const ttsMode = resolveProviderMode(config, 'tts');

  return {
    stt:
      sttMode === 'real'
        ? new AzureSttProvider({
            key: config.azureSpeechKey,
            region: config.azureSpeechRegion,
            ...(fetchImpl ? { fetchImpl } : {}),
          })
        : new MockSttProvider(),
    translate:
      translateMode === 'real'
        ? new GoogleTranslateProvider({
            apiKey: config.googleTranslateApiKey,
            ...(fetchImpl ? { fetchImpl } : {}),
          })
        : new MockTranslateProvider(),
    tts:
      ttsMode === 'real'
        ? new GoogleTtsProvider({
            apiKey: config.googleTtsApiKey,
            ...(fetchImpl ? { fetchImpl } : {}),
          })
        : new MockTtsProvider(),
  };
}

export function describeProviders(providers: Providers) {
  return {
    stt: { name: providers.stt.name, mode: providers.stt.mode },
    translate: { name: providers.translate.name, mode: providers.translate.mode },
    tts: { name: providers.tts.name, mode: providers.tts.mode },
  };
}
