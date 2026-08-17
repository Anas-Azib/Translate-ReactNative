import type { AudioRecorder, RecorderOptions, RecorderStatus } from '../src/services/recorder';

/**
 * Stands in for `AudioRecorder` so tests can drive the pipeline without a
 * microphone. The VAD itself is covered separately in `unit/vad.test.ts`; this
 * exists so integration tests can say "the user spoke a sentence" in one line.
 */
export class FakeRecorder {
  status: RecorderStatus = 'idle';
  readonly options: RecorderOptions;

  startCalls = 0;
  stopCalls = 0;
  lastStopFlush: boolean | undefined;
  /** Set to make `start()` reject, e.g. a denied permission prompt. */
  startError: Error | null = null;

  constructor(options: RecorderOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.startError) {
      this.status = 'error';
      this.options.onError?.(this.startError);
      throw this.startError;
    }
    this.status = 'recording';
  }

  async stop(options: { flush?: boolean } = {}): Promise<void> {
    this.stopCalls += 1;
    this.lastStopFlush = options.flush;
    this.status = 'stopped';
  }

  // ── Test drivers ────────────────────────────────────────────────────────

  /** Simulates a finished utterance being handed to the caller. */
  speak(durationSeconds = 2, bytes = 4096): void {
    this.options.onSpeechStart?.();
    this.options.onSegment?.({
      blob: new Blob([new Uint8Array(bytes)], { type: 'audio/webm' }),
      durationSeconds,
      reason: 'silence',
    });
  }

  emitLevel(level: number): void {
    this.options.onLevel?.(level);
  }

  emitIdleTimeout(): void {
    this.options.onIdleTimeout?.();
  }

  emitError(error: Error): void {
    this.options.onError?.(error);
  }
}

/** Factory plus a handle on the most recently created recorder. */
export function fakeRecorderFactory(config: { startError?: Error } = {}): {
  factory: (options: RecorderOptions) => AudioRecorder;
  current: () => FakeRecorder;
  all: FakeRecorder[];
} {
  const all: FakeRecorder[] = [];
  return {
    factory: (options: RecorderOptions) => {
      const recorder = new FakeRecorder(options);
      if (config.startError) recorder.startError = config.startError;
      all.push(recorder);
      return recorder as unknown as AudioRecorder;
    },
    current: () => all[all.length - 1]!,
    all,
  };
}

/** Records what was played so autoplay behaviour can be asserted. */
export class FakePlayer {
  played: Array<{ base64: string; mimeType: string }> = [];
  unlockCalls = 0;
  #endedHandlers = new Set<() => void>();
  #playing = false;

  async unlock(): Promise<void> {
    this.unlockCalls += 1;
  }

  async play(base64: string, mimeType = 'audio/mpeg'): Promise<void> {
    this.played.push({ base64, mimeType });
    this.#playing = true;
    // A real element fires 'ended' well after play() resolves, and the caller
    // attaches its listener in between. setTimeout (a macrotask) reproduces
    // that ordering; queueMicrotask would fire before the listener exists.
    setTimeout(() => {
      this.#playing = false;
      for (const handler of [...this.#endedHandlers]) handler();
    }, 0);
  }

  stop(): void {
    this.#playing = false;
  }

  dispose(): void {
    this.#endedHandlers.clear();
  }

  get playing(): boolean {
    return this.#playing;
  }

  onEnded(handler: () => void): () => void {
    this.#endedHandlers.add(handler);
    return () => this.#endedHandlers.delete(handler);
  }
}
