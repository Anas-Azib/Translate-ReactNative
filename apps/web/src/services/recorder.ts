import { VoiceActivityDetector, computeRms, levelFromRms } from './vad';
import type { VadOptions } from './vad';
import { TARGET_SAMPLE_RATE, downsample, encodeWav, mergeChunks } from './wav';

export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopped' | 'error';

export interface RecorderEvents {
  /** ~60 Hz display level, 0–1. Drives the orb. */
  onLevel?: (level: number) => void;
  onSpeechStart?: () => void;
  /** A finalised utterance ready to send, already encoded as 16 kHz WAV. */
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
}

/**
 * Microphone capture with silence-aware segmentation.
 *
 * Captures **raw PCM** rather than using MediaRecorder. Whisper needs mono
 * 16 kHz float samples; MediaRecorder would hand back Opus-in-WebM, which the
 * server would then have to decode with ffmpeg or a native binding on every
 * request. Since an AudioContext is already running for the level meter, taking
 * the samples straight from it removes that entire class of dependency — and
 * slicing an utterance becomes an array operation instead of the stop/restart
 * dance a container format requires.
 */
export class AudioRecorder {
  #status: RecorderStatus = 'idle';
  #stream: MediaStream | null = null;
  #context: AudioContext | null = null;
  #analyser: AnalyserNode | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #processor: ScriptProcessorNode | null = null;
  #sink: GainNode | null = null;
  #rafId: number | null = null;

  /** Captured frames for the utterance currently being recorded. */
  #chunks: Float32Array[] = [];
  #chunkSamples = 0;
  #vad: VoiceActivityDetector;
  #options: RecorderOptions;
  #sourceSampleRate = 48_000;

  constructor(options: RecorderOptions = {}) {
    this.#options = options;
    this.#vad = new VoiceActivityDetector(options.vad);
  }

  get status(): RecorderStatus {
    return this.#status;
  }

  get mimeType(): string {
    return 'audio/wav';
  }

  get vad(): VoiceActivityDetector {
    return this.#vad;
  }

  get sampleRate(): number {
    return this.#sourceSampleRate;
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
      this.#sourceSampleRate = this.#context.sampleRate;

      this.#analyser = this.#context.createAnalyser();
      this.#analyser.fftSize = 1024;
      this.#analyser.smoothingTimeConstant = 0.6;

      this.#source = this.#context.createMediaStreamSource(this.#stream);
      this.#source.connect(this.#analyser);

      // ScriptProcessor is deprecated in favour of AudioWorklet, but it is
      // still the only sample-accurate capture path that works without serving
      // a separate module file — and Safari's AudioWorklet support for
      // microphone input remains patchy. The work done per callback is a single
      // array copy, so the main-thread cost this API is criticised for does not
      // apply here.
      this.#processor = this.#context.createScriptProcessor(4096, 1, 1);
      this.#processor.onaudioprocess = (event) => {
        // Paused is a real state here: the node keeps firing because the graph
        // is still connected, and buffering through a pause would leak the
        // paused audio into the next segment.
        if (this.#status !== 'recording') return;
        // Copy: the event's buffer is reused by the audio thread.
        this.#chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        this.#chunkSamples += event.inputBuffer.length;
      };
      this.#source.connect(this.#processor);

      // A ScriptProcessor only runs while connected to a destination. Routing
      // it through a muted gain node keeps it ticking without echoing the
      // microphone back out of the speaker.
      this.#sink = this.#context.createGain();
      this.#sink.gain.value = 0;
      this.#processor.connect(this.#sink);
      this.#sink.connect(this.#context.destination);

      this.#vad.reset(now());
      this.#resetChunks();
      this.#status = 'recording';
      this.#loop();
    } catch (err) {
      this.#status = 'error';
      const error = normalizeMicError(err instanceof Error ? err : new Error(String(err)));
      this.#options.onError?.(error);
      this.#teardown();
      throw error;
    }
  }

  /**
   * Suspends capture without releasing the microphone.
   *
   * The stream and AudioContext stay alive so resuming is instant — tearing the
   * mic down and re-requesting it would re-trigger the permission path on some
   * browsers and add a visible delay mid-conversation. Buffered audio is
   * discarded rather than queued: the user asked for silence, and replaying it
   * on resume would bill time they did not intend to spend.
   */
  pause(): void {
    if (this.#status !== 'recording') return;
    this.#status = 'paused';
    if (this.#rafId !== null) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
    this.#resetChunks();
    this.#options.onLevel?.(0);
  }

  /** Resumes capture on the existing microphone stream. */
  resume(): void {
    if (this.#status !== 'paused') return;
    this.#status = 'recording';
    // Reset the detector so trailing silence from before the pause cannot
    // immediately close a segment that never started.
    this.#vad.reset(now());
    this.#resetChunks();
    this.#loop();
  }

  /** Flushes any in-flight speech as a final segment, then releases the mic. */
  async stop(options: { flush?: boolean } = {}): Promise<void> {
    if (this.#status !== 'recording' && this.#status !== 'paused') {
      this.#teardown();
      this.#status = 'stopped';
      return;
    }

    const shouldFlush = options.flush !== false && this.#vad.state !== 'silence';
    if (this.#rafId !== null) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
    this.#status = 'stopped';

    if (shouldFlush) this.#emitSegment('silence');
    this.#teardown();
  }

  #loop = (): void => {
    if (this.#status !== 'recording' || !this.#analyser) return;

    const buffer = new Float32Array(this.#analyser.fftSize);
    this.#analyser.getFloatTimeDomainData(buffer);

    const rms = computeRms(buffer);
    this.#options.onLevel?.(levelFromRms(rms));

    const event = this.#vad.push(rms, now());
    if (event.type === 'speech_start') {
      // Drop whatever was captured before speech began — that is silence, and
      // sending it would only give Whisper more room to hallucinate.
      this.#resetChunks();
      this.#options.onSpeechStart?.();
    } else if (event.type === 'speech_end') {
      this.#emitSegment(event.reason);
    } else if (event.type === 'idle_timeout') {
      this.#options.onIdleTimeout?.();
    }

    this.#rafId = requestAnimationFrame(this.#loop);
  };

  #emitSegment(reason: 'silence' | 'max_length'): void {
    if (this.#chunkSamples === 0) return;

    const merged = mergeChunks(this.#chunks, this.#chunkSamples);
    this.#resetChunks();

    const samples = downsample(merged, this.#sourceSampleRate, TARGET_SAMPLE_RATE);
    const durationSeconds = samples.length / TARGET_SAMPLE_RATE;
    if (durationSeconds < 0.35) return; // too short to be an utterance

    this.#options.onSegment?.({
      blob: encodeWav(samples, TARGET_SAMPLE_RATE),
      durationSeconds,
      reason,
    });
  }

  #resetChunks(): void {
    this.#chunks = [];
    this.#chunkSamples = 0;
  }

  #teardown(): void {
    if (this.#rafId !== null) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;

    if (this.#processor) this.#processor.onaudioprocess = null;
    this.#processor?.disconnect();
    this.#sink?.disconnect();
    this.#source?.disconnect();
    this.#analyser?.disconnect();
    // Releasing the tracks is what turns off the browser's recording indicator.
    this.#stream?.getTracks().forEach((track) => track.stop());
    void this.#context?.close().catch(() => {});

    this.#stream = null;
    this.#context = null;
    this.#analyser = null;
    this.#source = null;
    this.#processor = null;
    this.#sink = null;
    this.#resetChunks();
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
