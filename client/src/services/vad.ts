/**
 * Voice activity detection.
 *
 * Plan doc, p.4: "Do not continuously send silent audio to Google. Detect
 * silence and stop/pause processing where appropriate."
 *
 * This module is deliberately pure — it takes a level and a timestamp and
 * returns a transition. All the browser plumbing lives in `recorder.ts`. That
 * split is what lets the segmentation logic be unit-tested against a scripted
 * amplitude envelope instead of a real microphone.
 */

export type VadEvent =
  | { type: 'none' }
  | { type: 'speech_start' }
  /** A finalised utterance: speech followed by enough trailing silence. */
  | { type: 'speech_end'; durationMs: number; reason: 'silence' | 'max_length' }
  /** No speech at all for a long stretch — the caller should stop the mic. */
  | { type: 'idle_timeout' };

export interface VadOptions {
  /** RMS above which a frame counts as speech. */
  speechThreshold?: number;
  /** RMS below which a frame counts as silence. Lower than `speechThreshold` on
   *  purpose: the gap is hysteresis, and without it a voice hovering near the
   *  threshold produces a burst of tiny fragments, each one a paid API call. */
  silenceThreshold?: number;
  /** Speech must persist this long before a segment opens (rejects coughs, door slams). */
  minSpeechMs?: number;
  /** Trailing silence that ends an utterance. Roughly a sentence boundary. */
  hangoverMs?: number;
  /** Hard cap on one segment, so a monologue is still chunked. */
  maxSegmentMs?: number;
  /** Stop the mic entirely after this much continuous silence. */
  idleTimeoutMs?: number;
}

const DEFAULTS: Required<VadOptions> = {
  speechThreshold: 0.045,
  silenceThreshold: 0.022,
  minSpeechMs: 220,
  hangoverMs: 850,
  maxSegmentMs: 12_000,
  idleTimeoutMs: 8_000,
};

export type VadState = 'silence' | 'maybe_speech' | 'speech' | 'trailing_silence';

export class VoiceActivityDetector {
  readonly #options: Required<VadOptions>;

  #state: VadState = 'silence';
  #stateSince = 0;
  #speechStartedAt = 0;
  #lastSilenceStart = 0;
  #idleReported = false;

  constructor(options: VadOptions = {}) {
    this.#options = { ...DEFAULTS, ...options };
  }

  get state(): VadState {
    return this.#state;
  }

  get options(): Required<VadOptions> {
    return this.#options;
  }

  reset(now = 0): void {
    this.#state = 'silence';
    this.#stateSince = now;
    this.#speechStartedAt = 0;
    this.#lastSilenceStart = now;
    this.#idleReported = false;
  }

  /**
   * Feed one analysis frame.
   * @param level RMS amplitude, 0–1
   * @param now   monotonic timestamp in ms
   */
  push(level: number, now: number): VadEvent {
    const { speechThreshold, silenceThreshold, minSpeechMs, hangoverMs, maxSegmentMs, idleTimeoutMs } =
      this.#options;

    const loud = level >= speechThreshold;
    const quiet = level < silenceThreshold;

    switch (this.#state) {
      case 'silence': {
        if (loud) {
          this.#transition('maybe_speech', now);
          return { type: 'none' };
        }
        // Nothing said for a long time — let the caller shut the mic down
        // rather than stream silence to a paid service.
        if (!this.#idleReported && now - this.#lastSilenceStart >= idleTimeoutMs) {
          this.#idleReported = true;
          return { type: 'idle_timeout' };
        }
        return { type: 'none' };
      }

      case 'maybe_speech': {
        if (quiet) {
          // Too brief to be speech — a transient, not a word.
          this.#transition('silence', now);
          return { type: 'none' };
        }
        if (now - this.#stateSince >= minSpeechMs) {
          this.#speechStartedAt = this.#stateSince;
          this.#transition('speech', now);
          this.#idleReported = false;
          return { type: 'speech_start' };
        }
        return { type: 'none' };
      }

      case 'speech': {
        if (now - this.#speechStartedAt >= maxSegmentMs) {
          const durationMs = now - this.#speechStartedAt;
          this.#endSegment(now);
          return { type: 'speech_end', durationMs, reason: 'max_length' };
        }
        if (quiet) {
          this.#transition('trailing_silence', now);
        }
        return { type: 'none' };
      }

      case 'trailing_silence': {
        if (loud) {
          // Just a pause between words, not the end of the sentence.
          this.#transition('speech', now);
          return { type: 'none' };
        }
        if (now - this.#stateSince >= hangoverMs) {
          // Bill the utterance, not the trailing silence.
          const durationMs = this.#stateSince - this.#speechStartedAt;
          this.#endSegment(now);
          return { type: 'speech_end', durationMs, reason: 'silence' };
        }
        if (now - this.#speechStartedAt >= maxSegmentMs) {
          const durationMs = this.#stateSince - this.#speechStartedAt;
          this.#endSegment(now);
          return { type: 'speech_end', durationMs, reason: 'max_length' };
        }
        return { type: 'none' };
      }
    }
  }

  #transition(next: VadState, now: number): void {
    this.#state = next;
    this.#stateSince = now;
  }

  #endSegment(now: number): void {
    this.#transition('silence', now);
    this.#lastSilenceStart = now;
    this.#speechStartedAt = 0;
    this.#idleReported = false;
  }
}

/** RMS of a time-domain frame. The standard loudness proxy for VAD. */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Maps RMS onto a 0–1 display level.
 *
 * Loudness is perceived logarithmically, so a linear RMS meter looks dead for
 * normal speech and then slams to full on a shout. This maps a −60…0 dBFS
 * window onto the bar heights instead, which is what makes the orb track a
 * speaking voice rather than sitting still.
 */
export function levelFromRms(rms: number, floorDb = -60): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  if (db <= floorDb) return 0;
  return Math.min(1, (db - floorDb) / -floorDb);
}
