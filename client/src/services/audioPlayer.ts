/**
 * Playback for synthesised speech.
 *
 * Keeps one `Audio` element alive for the whole session instead of creating one
 * per phrase: iOS only lets an audio element start playing inside a user
 * gesture, and a long-lived, already-unlocked element can be re-sourced and
 * replayed afterwards. Creating a fresh element for each translation would make
 * autoplay fail on exactly the devices this app targets.
 */
export class AudioPlayer {
  #element: HTMLAudioElement | null = null;
  #url: string | null = null;
  #unlocked = false;

  /**
   * Call once from a real user gesture (the first mic tap). Plays a silent blip
   * so the element counts as user-initiated for the rest of the session.
   */
  async unlock(): Promise<void> {
    if (this.#unlocked) return;
    const element = this.#ensureElement();
    element.muted = true;
    element.src =
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
    try {
      await element.play();
      element.pause();
      this.#unlocked = true;
    } catch {
      // Autoplay still blocked — playback will need an explicit tap.
    } finally {
      element.muted = false;
    }
  }

  get unlocked(): boolean {
    return this.#unlocked;
  }

  async play(base64: string, mimeType = 'audio/mpeg'): Promise<void> {
    const element = this.#ensureElement();
    this.#revoke();

    const blob = base64ToBlob(base64, mimeType);
    this.#url = URL.createObjectURL(blob);
    element.src = this.#url;
    element.currentTime = 0;
    await element.play();
  }

  stop(): void {
    this.#element?.pause();
    if (this.#element) this.#element.currentTime = 0;
  }

  get playing(): boolean {
    return Boolean(this.#element && !this.#element.paused && !this.#element.ended);
  }

  onEnded(handler: () => void): () => void {
    const element = this.#ensureElement();
    element.addEventListener('ended', handler);
    return () => element.removeEventListener('ended', handler);
  }

  dispose(): void {
    this.stop();
    this.#revoke();
    this.#element = null;
  }

  #ensureElement(): HTMLAudioElement {
    if (!this.#element) {
      this.#element = new Audio();
      this.#element.preload = 'auto';
      this.#element.setAttribute('playsinline', 'true');
    }
    return this.#element;
  }

  #revoke(): void {
    if (this.#url) {
      URL.revokeObjectURL(this.#url);
      this.#url = null;
    }
  }
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
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
