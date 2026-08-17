import type { AppConfig } from '../lib/config.js';
import { resolveProviderMode } from '../lib/config.js';
import type { Providers } from '../types/index.js';
import { MockSttProvider, WhisperSttProvider } from './stt.whisper.js';
import { MockTranslateProvider, MyMemoryTranslateProvider } from './translate.mymemory.js';

/**
 * Builds the two providers the pipeline needs.
 *
 * Neither requires a credential: Whisper runs locally and MyMemory is free and
 * keyless. `mock` exists only so the test suite and offline development can
 * skip the model download and the network.
 */
export function createProviders(config: AppConfig, fetchImpl?: typeof fetch): Providers {
  const sttMode = resolveProviderMode(config, 'stt');
  const translateMode = resolveProviderMode(config, 'translate');

  return {
    stt:
      sttMode === 'real'
        ? new WhisperSttProvider({
            model: config.whisperModel,
            dtype: config.whisperDtype,
            silenceThreshold: config.whisperSilenceThreshold,
          })
        : new MockSttProvider(),
    translate:
      translateMode === 'real'
        ? new MyMemoryTranslateProvider({
            endpoint: config.myMemoryEndpoint,
            email: config.myMemoryEmail,
            ...(fetchImpl ? { fetchImpl } : {}),
          })
        : new MockTranslateProvider(),
  };
}

export function describeProviders(providers: Providers) {
  return {
    stt: {
      name: providers.stt.name,
      mode: providers.stt.mode,
      ...(providers.stt instanceof WhisperSttProvider
        ? { model: providers.stt.model, warmed: providers.stt.warmed }
        : {}),
    },
    translate: { name: providers.translate.name, mode: providers.translate.mode },
  };
}
