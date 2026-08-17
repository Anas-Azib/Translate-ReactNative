/**
 * Text-to-speech using the browser's own `speechSynthesis` engine.
 *
 * Replaces the cloud TTS call entirely: no key, no quota, no audio download,
 * and it works offline. The trade is that voice availability is the device's
 * business, not ours — so voice selection below degrades gracefully rather than
 * assuming any particular voice exists.
 */

export interface SpeakOptions {
  /** BCP-47 tag, e.g. "ar-SA". */
  lang: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

export class SpeechUnavailableError extends Error {
  constructor(message = 'This device cannot speak the translation out loud.') {
    super(message);
    this.name = 'SpeechUnavailableError';
  }
}

export function isSpeechSupported(): boolean {
  if (typeof window === 'undefined') return false;
  // Checks the *value*, not just `'speechSynthesis' in window`. The property
  // can exist while holding undefined or null — a stubbed environment, or a
  // polyfill that declares the global before deciding it cannot provide it —
  // and the `in` test would call that supported, then throw on first use.
  return Boolean(window.speechSynthesis) && typeof window.SpeechSynthesisUtterance === 'function';
}

/**
 * Picks the best available voice for a language tag.
 *
 * Falls back through exact match → same base language → any voice, because a
 * phone that has "ar-EG" but not "ar-SA" should still speak Arabic rather than
 * silently reading it in the UI language, which is what happens if you hand
 * `speechSynthesis` a tag it does not recognise.
 */
export function pickVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const target = lang.toLowerCase();
  const base = target.split('-')[0]!;

  const exact = voices.find((v) => v.lang.toLowerCase() === target);
  if (exact) return exact;

  const sameBase = voices.filter((v) => v.lang.toLowerCase().split('-')[0] === base);
  if (sameBase.length > 0) {
    // Prefer a local voice: network voices add latency and fail offline.
    return sameBase.find((v) => v.localService) ?? sameBase[0]!;
  }

  return null;
}

export class SpeechSynthesizer {
  #voices: SpeechSynthesisVoice[] = [];
  #voicesReady: Promise<SpeechSynthesisVoice[]> | null = null;
  #unlocked = false;

  get supported(): boolean {
    return isSpeechSupported();
  }

  get unlocked(): boolean {
    return this.#unlocked;
  }

  /**
   * Loads the voice list.
   *
   * `getVoices()` returns an empty array on first call in Chrome and Safari —
   * the list arrives asynchronously via `voiceschanged`. Calling it once and
   * trusting the result is why so many web apps silently use the wrong voice.
   */
  async voices(): Promise<SpeechSynthesisVoice[]> {
    if (!this.supported) return [];
    if (this.#voices.length > 0) return this.#voices;

    this.#voicesReady ??= new Promise<SpeechSynthesisVoice[]>((resolve) => {
      const immediate = window.speechSynthesis.getVoices();
      if (immediate.length > 0) {
        resolve(immediate);
        return;
      }

      const onChange = () => {
        const list = window.speechSynthesis.getVoices();
        if (list.length > 0) {
          window.speechSynthesis.removeEventListener('voiceschanged', onChange);
          resolve(list);
        }
      };
      window.speechSynthesis.addEventListener('voiceschanged', onChange);

      // Some engines never fire the event. Resolve with whatever exists rather
      // than leaving the caller waiting forever.
      setTimeout(() => {
        window.speechSynthesis.removeEventListener('voiceschanged', onChange);
        resolve(window.speechSynthesis.getVoices());
      }, 1500);
    });

    this.#voices = await this.#voicesReady;
    return this.#voices;
  }

  /**
   * Call once from a real user gesture (the first mic tap).
   *
   * iOS refuses to speak unless synthesis was first triggered inside a user
   * gesture. Speaking an empty utterance during the tap satisfies that, so the
   * translation can be spoken automatically later.
   */
  async unlock(): Promise<void> {
    if (!this.supported || this.#unlocked) return;
    try {
      const utterance = new window.SpeechSynthesisUtterance('');
      utterance.volume = 0;
      window.speechSynthesis.speak(utterance);
      window.speechSynthesis.cancel();
      this.#unlocked = true;
      void this.voices();
    } catch {
      // Nothing to do — playback will need an explicit tap.
    }
  }

  /** Resolves when the phrase has finished being spoken. */
  async speak(text: string, options: SpeakOptions): Promise<void> {
    if (!this.supported) throw new SpeechUnavailableError();
    const trimmed = text.trim();
    if (!trimmed) return;

    const voices = await this.voices();
    this.cancel();

    return new Promise<void>((resolve, reject) => {
      const utterance = new window.SpeechSynthesisUtterance(trimmed);
      utterance.lang = options.lang;
      utterance.rate = options.rate ?? 1;
      utterance.pitch = options.pitch ?? 1;
      utterance.volume = options.volume ?? 1;

      const voice = pickVoice(voices, options.lang);
      if (voice) utterance.voice = voice;

      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        if (err) reject(err);
        else resolve();
      };

      utterance.onend = () => finish();
      utterance.onerror = (event) => {
        // A cancel is a normal outcome — the user started a new phrase.
        finish(event.error === 'canceled' || event.error === 'interrupted' ? undefined : new Error(event.error));
      };

      // Chrome drops long utterances without firing either callback, which
      // would leave the UI stuck in its "speaking" state forever. Bound the
      // wait by a generous estimate of the phrase's spoken length.
      const guard = setTimeout(() => finish(), estimateDurationMs(trimmed) + 5000);

      window.speechSynthesis.speak(utterance);
    });
  }

  cancel(): void {
    if (!this.supported) return;
    window.speechSynthesis.cancel();
  }

  get speaking(): boolean {
    return this.supported && window.speechSynthesis.speaking;
  }

  dispose(): void {
    this.cancel();
    this.#voices = [];
    this.#voicesReady = null;
  }
}

/** Rough spoken length, used only as a safety timeout. ~14 chars/second. */
export function estimateDurationMs(text: string): number {
  return Math.max(1000, (text.length / 14) * 1000);
}

/**
 * Haptic feedback. Android honours the Vibration API; iOS Safari ignores it
 * silently, which is fine — it is an enhancement, never a signal on its own.
 */
export const haptics = {
  tap(): void {
    navigator.vibrate?.(10);
  },
  success(): void {
    navigator.vibrate?.([12, 40, 18]);
  },
  warning(): void {
    navigator.vibrate?.([24, 60, 24]);
  },
};
