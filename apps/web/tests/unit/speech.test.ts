import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  SpeechSynthesizer,
  SpeechUnavailableError,
  estimateDurationMs,
  isSpeechSupported,
  pickVoice,
} from '../../src/services/speech';

/** Minimal stand-in for a SpeechSynthesisVoice. */
function voice(lang: string, name = lang, localService = true): SpeechSynthesisVoice {
  return { lang, name, localService, default: false, voiceURI: name } as SpeechSynthesisVoice;
}

/**
 * Installs a controllable `speechSynthesis` on the jsdom window, which has none.
 */
function installSpeechSynthesis(options: { voices?: SpeechSynthesisVoice[]; deferVoices?: boolean } = {}) {
  const spoken: SpeechSynthesisUtterance[] = [];
  const listeners: Record<string, Array<() => void>> = {};
  let voices = options.deferVoices ? [] : (options.voices ?? [voice('en-US'), voice('ar-SA')]);

  const synth = {
    speaking: false,
    getVoices: () => voices,
    speak: (utterance: SpeechSynthesisUtterance) => {
      spoken.push(utterance);
      // Real engines fire `end` asynchronously.
      setTimeout(() => utterance.onend?.(new Event('end') as SpeechSynthesisEvent), 0);
    },
    cancel: vi.fn(),
    addEventListener: (type: string, handler: () => void) => {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener: (type: string, handler: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((h) => h !== handler);
    },
  };

  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    value: class {
      text: string;
      lang = '';
      rate = 1;
      pitch = 1;
      volume = 1;
      voice: SpeechSynthesisVoice | null = null;
      onend: ((event: SpeechSynthesisEvent) => void) | null = null;
      onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;
      constructor(text = '') {
        this.text = text;
      }
    },
    configurable: true,
    writable: true,
  });

  return {
    spoken,
    synth,
    /** Simulates the voice list arriving later, as Chrome and Safari do. */
    deliverVoices(list: SpeechSynthesisVoice[]) {
      voices = list;
      for (const handler of listeners.voiceschanged ?? []) handler();
    },
  };
}

describe('pickVoice', () => {
  it('prefers an exact language tag match', () => {
    const voices = [voice('en-US'), voice('ar-SA'), voice('ar-EG')];
    expect(pickVoice(voices, 'ar-SA')?.lang).toBe('ar-SA');
  });

  it('is case-insensitive about the tag', () => {
    expect(pickVoice([voice('ar-SA')], 'AR-sa')?.lang).toBe('ar-SA');
  });

  /**
   * A phone with "ar-EG" but not "ar-SA" must still speak Arabic. Handing
   * `speechSynthesis` an unknown tag makes it fall back to the UI language, so
   * an Arabic sentence would be read aloud with an English voice.
   */
  it('falls back to another region of the same language', () => {
    const voices = [voice('en-US'), voice('ar-EG')];
    expect(pickVoice(voices, 'ar-SA')?.lang).toBe('ar-EG');
  });

  it('prefers a local voice over a network one', () => {
    const voices = [voice('ar-EG', 'remote', false), voice('ar-MA', 'local', true)];
    // Network voices add latency and stop working offline.
    expect(pickVoice(voices, 'ar-SA')?.name).toBe('local');
  });

  it('returns null rather than a wrong-language voice', () => {
    expect(pickVoice([voice('en-US'), voice('fr-FR')], 'ar-SA')).toBeNull();
  });

  it('returns null when the device has no voices at all', () => {
    expect(pickVoice([], 'en-US')).toBeNull();
  });
});

describe('SpeechSynthesizer', () => {
  beforeEach(() => {
    // Remove any synthesis left over from a previous test.
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true, writable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  it('reports whether the device supports synthesis', () => {
    expect(new SpeechSynthesizer().supported).toBe(false);

    installSpeechSynthesis();
    expect(new SpeechSynthesizer().supported).toBe(true);
  });

  it('speaks the text in the requested language', async () => {
    const { spoken } = installSpeechSynthesis();
    const synth = new SpeechSynthesizer();

    await synth.speak('Hello there', { lang: 'en-US' });

    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.text).toBe('Hello there');
    expect(spoken[0]!.lang).toBe('en-US');
  });

  it('attaches the matching voice', async () => {
    const { spoken } = installSpeechSynthesis({ voices: [voice('en-US'), voice('ar-SA')] });
    const synth = new SpeechSynthesizer();

    await synth.speak('مرحبا', { lang: 'ar-SA' });

    expect(spoken[0]!.voice?.lang).toBe('ar-SA');
  });

  it('trims the text before speaking', async () => {
    const { spoken } = installSpeechSynthesis();
    await new SpeechSynthesizer().speak('  spaced out  ', { lang: 'en-US' });

    expect(spoken[0]!.text).toBe('spaced out');
  });

  it('does nothing for empty text', async () => {
    const { spoken } = installSpeechSynthesis();
    await new SpeechSynthesizer().speak('   ', { lang: 'en-US' });

    expect(spoken).toHaveLength(0);
  });

  it('cancels any in-flight phrase before starting a new one', async () => {
    const { synth: engine } = installSpeechSynthesis();
    const synth = new SpeechSynthesizer();

    await synth.speak('first', { lang: 'en-US' });
    await synth.speak('second', { lang: 'en-US' });

    // Otherwise two translations would talk over each other.
    expect(engine.cancel).toHaveBeenCalled();
  });

  it('throws a typed error when the device cannot speak', async () => {
    await expect(new SpeechSynthesizer().speak('hello', { lang: 'en-US' })).rejects.toBeInstanceOf(
      SpeechUnavailableError,
    );
  });

  describe('the voice list', () => {
    /**
     * `getVoices()` returns an empty array on first call in Chrome and Safari —
     * the list arrives later via `voiceschanged`. Trusting the first call is why
     * so many web apps silently use the wrong voice.
     */
    it('waits for voices that arrive asynchronously', async () => {
      const harness = installSpeechSynthesis({ deferVoices: true });
      const synth = new SpeechSynthesizer();

      const pending = synth.voices();
      harness.deliverVoices([voice('ar-SA'), voice('en-US')]);

      expect(await pending).toHaveLength(2);
    });

    it('caches the list once resolved', async () => {
      installSpeechSynthesis({ voices: [voice('en-US')] });
      const synth = new SpeechSynthesizer();

      const first = await synth.voices();
      expect(await synth.voices()).toBe(first);
    });

    it('returns an empty list when synthesis is unavailable', async () => {
      expect(await new SpeechSynthesizer().voices()).toEqual([]);
    });
  });

  describe('unlock', () => {
    it('marks itself unlocked after a user gesture', async () => {
      installSpeechSynthesis();
      const synth = new SpeechSynthesizer();
      expect(synth.unlocked).toBe(false);

      await synth.unlock();

      expect(synth.unlocked).toBe(true);
    });

    it('is a no-op when synthesis is unavailable', async () => {
      const synth = new SpeechSynthesizer();
      await expect(synth.unlock()).resolves.toBeUndefined();
      expect(synth.unlocked).toBe(false);
    });

    it('only unlocks once', async () => {
      const { spoken } = installSpeechSynthesis();
      const synth = new SpeechSynthesizer();

      await synth.unlock();
      await synth.unlock();

      expect(spoken).toHaveLength(1);
    });
  });
});

describe('estimateDurationMs', () => {
  it('grows with the length of the phrase', () => {
    expect(estimateDurationMs('a'.repeat(140))).toBeGreaterThan(estimateDurationMs('short'));
  });

  it('never returns less than a second, so the guard cannot fire early', () => {
    expect(estimateDurationMs('hi')).toBeGreaterThanOrEqual(1000);
  });
});

describe('isSpeechSupported', () => {
  it('is false without the API', () => {
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true, writable: true });
    expect(isSpeechSupported()).toBe(false);
  });
});
