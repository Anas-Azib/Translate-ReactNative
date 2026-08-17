import { VoiceActivityDetector, computeRms, levelFromRms } from './vad';
import type { VadOptions } from './vad';

export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'stopped' | 'error';

export interface RecorderEvents {
  /** ~60 Hz display level, 0–1. Drives the orb. */
  onLevel?: (level: number) => void;
  onSpeechStart?: () => void;
  /** A finalised utterance ready to send. */
  onSegment?: (segment: { blob: Blob; durationSeconds: number; reason: 'silence' | 'max_length' }) => void;
  /** Sustained silence — the caller should stop to avoid burning session time. */
  onIdleTimeout?: () => void;
  onError?: (error: Error) => void;
}

export interface RecorderOptions extends RecorderEvents {
  vad?: VadOptions;
  /** Injectable for tests. */
  mediaDevices?: MediaDevices;
  audioContextFactory?: () => AudioContext;
  mediaRecorderFactory?: (stream: MediaStream, mimeType: string) => MediaRecorder;
}

/** Picks the best container the browser can actually produce. */
export function pickMimeType(candidates: string[] = DEFAULT_MIME_CANDIDATES): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return candidates[0] ?? 'audio/webm';
  }
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

const DEFAULT_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4', // Safari / iOS
];

/**
 * Microphone capture with silence-aware segmentation.
 *
 * The recorder runs continuously while the mic is on but only *emits* audio
 * around detected speech: the VAD decides where each utterance ends, and only
 * those slices are handed to the caller. That is what keeps silence from
 * reaching Azure and Google, and it is also why the transcript arrives in
 * sentence-sized pieces rather than a stream of fragments.
 */
export class AudioRecorder {
  #status: RecorderStatus = 'idle';
  #stream: MediaStream | null = null;
  #context: AudioContext | null = null;
  #analyser: AnalyserNode | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #recorder: MediaRecorder | null = null;
  #rafId: number | null = null;

  #chunks: Blob[] = [];
  #vad: VoiceActivityDetector;
  #options: RecorderOptions;
  #mimeType = '';
  #segmentOpenedAt = 0;

  constructor(options: RecorderOptions = {}) {
    this.#options = options;
    this.#vad = new VoiceActivityDetector(options.vad);
  }

  get status(): RecorderStatus {
    return this.#status;
  }

  get mimeType(): string {
    return this.#mimeType;
  }

  get vad(): VoiceActivityDetector {
    return this.#vad;
  }

  async start(): Promise<void> {
    if (this.#status === 'recording') return;
    this.#status = 'requesting';

    try {
      const devices = this.#options.mediaDevices ?? navigator.mediaDevices;
      if (!devices?.getUserMedia) {
        throw new Error('Microphone is not available in this browser.');
      }

      this.#stream = await devices.getUserMedia({
        audio: {
          // Browser DSP does a lot of the noise work for us, which makes the
          // VAD thresholds meaningful across very different phones.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });

      const AudioCtx =
        this.#options.audioContextFactory ??
        (() => new (window.AudioContext || (window as any).webkitAudioContext)());
      this.#context = AudioCtx();
      // iOS starts contexts suspended until a user gesture resumes them.
      if (this.#context.state === 'suspended') await this.#context.resume();

      this.#analyser = this.#context.createAnalyser();
      this.#analyser.fftSize = 1024;
      this.#analyser.smoothingTimeConstant = 0.6;
      this.#source = this.#context.createMediaStreamSource(this.#stream);
      this.#source.connect(this.#analyser);

      this.#mimeType = pickMimeType();
      const factory =
        this.#options.mediaRecorderFactory ??
        ((stream: MediaStream, mimeType: string) =>
          new MediaRecorder(stream, mimeType ? { mimeType } : undefined));
      this.#recorder = factory(this.#stream, this.#mimeType);

      this.#recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) this.#chunks.push(event.data);
      };

      // A short timeslice keeps a segment boundary close to where the VAD
      // actually heard silence.
      this.#recorder.start(250);
      this.#vad.reset(now());
      this.#segmentOpenedAt = now();
      this.#status = 'recording';
      this.#loop();
    } catch (err) {
      this.#status = 'error';
      const error = err instanceof Error ? err : new Error(String(err));
      this.#options.onError?.(normalizeMicError(error));
      throw normalizeMicError(error);
    }
  }

  /** Flushes any in-flight speech as a final segment, then releases the mic. */
  async stop(options: { flush?: boolean } = {}): Promise<void> {
    if (this.#status !== 'recording') {
      this.#teardown();
      return;
    }
    const shouldFlush = options.flush !== false && this.#vad.state !== 'silence';
    const durationSeconds = (now() - this.#segmentOpenedAt) / 1000;

    if (this.#rafId !== null) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;

    await this.#finishRecorder();

    if (shouldFlush && this.#chunks.length > 0) {
      this.#emitSegment(durationSeconds, 'silence');
    }

    this.#teardown();
    this.#status = 'stopped';
  }

  #loop = (): void => {
    if (this.#status !== 'recording' || !this.#analyser) return;

    const buffer = new Float32Array(this.#analyser.fftSize);
    this.#analyser.getFloatTimeDomainData(buffer);

    const rms = computeRms(buffer);
    this.#options.onLevel?.(levelFromRms(rms));

    const event = this.#vad.push(rms, now());
    if (event.type === 'speech_start') {
      this.#segmentOpenedAt = now();
      this.#options.onSpeechStart?.();
    } else if (event.type === 'speech_end') {
      this.#cutSegment(event.durationMs / 1000, event.reason);
    } else if (event.type === 'idle_timeout') {
      this.#options.onIdleTimeout?.();
    }

    this.#rafId = requestAnimationFrame(this.#loop);
  };

  /**
   * Closes the current recording and immediately opens a new one. Restarting is
   * what makes each emitted blob a self-contained, decodable container — slicing
   * a continuous WebM stream would produce fragments without headers that no
   * decoder on Azure's side would accept.
   */
  #cutSegment(durationSeconds: number, reason: 'silence' | 'max_length'): void {
    const recorder = this.#recorder;
    if (!recorder || recorder.state === 'inactive') return;

    recorder.onstop = () => {
      this.#emitSegment(durationSeconds, reason);
      if (this.#status === 'recording' && this.#stream) {
        this.#chunks = [];
        try {
          recorder.start(250);
          this.#segmentOpenedAt = now();
        } catch (err) {
          this.#options.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    };
    recorder.stop();
  }

  #emitSegment(durationSeconds: number, reason: 'silence' | 'max_length'): void {
    if (this.#chunks.length === 0) return;
    const blob = new Blob(this.#chunks, { type: this.#mimeType || 'audio/webm' });
    this.#chunks = [];
    if (blob.size <= 512) return; // silence in a container — not worth a call
    this.#options.onSegment?.({ blob, durationSeconds: Math.max(0.35, durationSeconds), reason });
  }

  #finishRecorder(): Promise<void> {
    return new Promise((resolve) => {
      const recorder = this.#recorder;
      if (!recorder || recorder.state === 'inactive') {
        resolve();
        return;
      }
      recorder.onstop = () => resolve();
      try {
        recorder.stop();
      } catch {
        resolve();
      }
    });
  }

  #teardown(): void {
    if (this.#rafId !== null) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
    this.#source?.disconnect();
    this.#analyser?.disconnect();
    // Releasing the tracks is what turns off the browser's recording indicator.
    this.#stream?.getTracks().forEach((track) => track.stop());
    void this.#context?.close().catch(() => {});
    this.#stream = null;
    this.#context = null;
    this.#analyser = null;
    this.#source = null;
    this.#recorder = null;
    this.#chunks = [];
  }
}

/** Turns getUserMedia's terse DOMExceptions into something a user can act on. */
export function normalizeMicError(error: Error): Error {
  const name = (error as DOMException).name ?? '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return new Error('Microphone access was blocked. Allow it in your browser settings to translate.');
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return new Error('No microphone found on this device.');
  }
  if (name === 'NotReadableError') {
    return new Error('Your microphone is being used by another app.');
  }
  return error;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
