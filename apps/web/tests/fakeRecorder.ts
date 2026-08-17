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
  pauseCalls = 0;
  resumeCalls = 0;
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

  pause(): void {
    this.pauseCalls += 1;
    this.status = 'paused';
  }

  resume(): void {
    this.resumeCalls += 1;
    this.status = 'recording';
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

/** Records what was spoken so autoplay behaviour can be asserted. */
export class FakeSynthesizer {
  spoken: Array<{ text: string; lang: string }> = [];
  unlockCalls = 0;
  cancelCalls = 0;
  supported = true;
  /** Set to make `speak()` reject, e.g. no voice for the language. */
  speakError: Error | null = null;

  async unlock(): Promise<void> {
    this.unlockCalls += 1;
  }

  async speak(text: string, options: { lang: string }): Promise<void> {
    if (this.speakError) throw this.speakError;
    this.spoken.push({ text, lang: options.lang });
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  get speaking(): boolean {
    return false;
  }

  async voices(): Promise<SpeechSynthesisVoice[]> {
    return [];
  }

  dispose(): void {}
}

/**
 * Stands in for `WsClient` so tests can drive the transport directly: push
 * server messages, inspect what was sent, and simulate disconnects — without a
 * real socket.
 */
export class FakeWsClient {
  sent: Array<Record<string, unknown>> = [];
  segments: Array<{ segmentId: string; durationSeconds: number; size: number }> = [];
  connectCalls = 0;
  disconnectCalls = 0;
  state: 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'error' = 'disconnected';
  /** Set to make `connect()` reject. */
  connectError: Error | null = null;

  readonly #onMessage: (message: unknown) => void;
  readonly #onStateChange?: (state: string) => void;

  constructor(options: { onMessage: (m: unknown) => void; onStateChange?: (s: string) => void }) {
    this.#onMessage = options.onMessage;
    this.#onStateChange = options.onStateChange;
  }

  get connected(): boolean {
    return this.state === 'connected';
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectError) {
      this.#setState('error');
      throw this.connectError;
    }
    this.#setState('connected');
  }

  send(message: Record<string, unknown>): boolean {
    this.sent.push(message);
    return true;
  }

  async sendSegment(header: { segmentId: string; durationSeconds: number }, blob: Blob): Promise<boolean> {
    this.segments.push({ ...header, size: blob.size });
    return true;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.#setState('disconnected');
  }

  // ── Test drivers ────────────────────────────────────────────────────────

  /** Pushes a message as if the server had sent it. */
  emit(message: Record<string, unknown>): void {
    this.#onMessage(message);
  }

  /** Simulates the socket dropping underneath an active session. */
  drop(): void {
    this.#setState('disconnected');
  }

  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type);
  }

  #setState(state: typeof this.state): void {
    this.state = state;
    this.#onStateChange?.(state);
  }
}
