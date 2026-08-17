import type {
  ClientMessage,
  ConnectionState,
  ServerMessage,
} from '@translate/shared';
import { CLOSE_CODES, PROTOCOL_VERSION, parseMessage } from '@translate/shared';
import { env } from '../config/env';

export interface WsClientOptions {
  url?: string;
  deviceId: string;
  onMessage: (message: ServerMessage) => void;
  onStateChange?: (state: ConnectionState) => void;
  /** Injectable for tests. */
  socketFactory?: (url: string) => WebSocket;
  maxReconnectAttempts?: number;
  reconnectBaseDelayMs?: number;
}

/**
 * WebSocket transport with a strict, single-socket lifecycle.
 *
 * Every rule below exists because the naive version of this class is the source
 * of the "ghost session" class of bug:
 *
 *  - **One socket, ever.** `connect()` while already connecting or open is a
 *    no-op that returns the existing promise, so double-tapping cannot open two
 *    sockets — and therefore cannot create two sessions.
 *  - **Superseded sockets go mute.** Handlers are keyed to a generation
 *    counter. When a socket is replaced, its generation is stale and its events
 *    are dropped, so a dying socket can never push state into the UI or
 *    resurrect a closed session.
 *  - **Reconnect is bounded and cancellable.** A deliberate `disconnect()`
 *    stops reconnection dead; without that flag an intentional stop races with
 *    a pending retry and silently reopens the session the user just ended.
 */
export class WsClient {
  #socket: WebSocket | null = null;
  #state: ConnectionState = 'disconnected';
  /** Incremented per socket. Events from an older generation are ignored. */
  #generation = 0;
  #connectPromise: Promise<void> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempts = 0;
  /** True after an intentional disconnect: suppresses reconnection. */
  #closedByUs = false;

  readonly #options: Required<Pick<WsClientOptions, 'url' | 'maxReconnectAttempts' | 'reconnectBaseDelayMs'>> &
    WsClientOptions;

  constructor(options: WsClientOptions) {
    this.#options = {
      url: options.url ?? env.websocketUrl,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 5,
      reconnectBaseDelayMs: options.reconnectBaseDelayMs ?? 600,
      ...options,
    };
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get connected(): boolean {
    return this.#state === 'connected';
  }

  /** Opens the socket, or returns the in-flight/settled connection. */
  connect(): Promise<void> {
    if (this.#state === 'connected') return Promise.resolve();
    if (this.#connectPromise) return this.#connectPromise;

    this.#closedByUs = false;
    this.#connectPromise = this.#openSocket();
    return this.#connectPromise;
  }

  #openSocket(): Promise<void> {
    const generation = ++this.#generation;
    this.#setState('connecting');

    return new Promise<void>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = this.#options.socketFactory
          ? this.#options.socketFactory(this.#options.url)
          : new WebSocket(this.#options.url);
      } catch (err) {
        this.#setState('error');
        this.#connectPromise = null;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      socket.binaryType = 'arraybuffer';
      this.#socket = socket;

      let settled = false;

      socket.onopen = () => {
        if (generation !== this.#generation) return;
        this.#setState('connected');
        this.#reconnectAttempts = 0;
        // Identify immediately: the server needs the device id before it will
        // accept a session start.
        this.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, deviceId: this.#options.deviceId });
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      socket.onmessage = (event: MessageEvent) => {
        if (generation !== this.#generation) return; // stale socket
        if (typeof event.data !== 'string') return; // server sends JSON only
        const message = parseMessage<ServerMessage>(event.data);
        if (!message) return;

        // Answer the heartbeat so the server does not drop us as half-open.
        if (message.type === 'ping') {
          this.send({ type: 'pong', at: Date.now() });
          return;
        }
        this.#options.onMessage(message);
      };

      socket.onerror = () => {
        if (generation !== this.#generation) return;
        this.#setState('error');
        if (!settled) {
          settled = true;
          this.#connectPromise = null;
          reject(new Error('WebSocket connection failed'));
        }
      };

      socket.onclose = (event: CloseEvent) => {
        if (generation !== this.#generation) return;

        this.#detach(socket);
        this.#socket = null;
        this.#connectPromise = null;
        this.#setState('disconnected');

        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed before opening (${event.code})`));
        }

        // Superseded means another connection deliberately took over — coming
        // back would fight it. A user-initiated close must also stay closed.
        const permanent =
          this.#closedByUs ||
          event.code === CLOSE_CODES.SUPERSEDED ||
          event.code === CLOSE_CODES.PROTOCOL_MISMATCH ||
          event.code === CLOSE_CODES.NORMAL;

        if (!permanent) this.#scheduleReconnect();
      };
    });
  }

  #scheduleReconnect(): void {
    if (this.#closedByUs) return;
    if (this.#reconnectAttempts >= this.#options.maxReconnectAttempts) {
      this.#setState('error');
      return;
    }

    this.#reconnectAttempts += 1;
    // Exponential backoff, capped: a phone in a tunnel should not hammer.
    const delay = Math.min(this.#options.reconnectBaseDelayMs * 2 ** (this.#reconnectAttempts - 1), 10_000);

    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#closedByUs) return;
      this.#connectPromise = this.#openSocket().catch(() => {
        // Failure re-enters onclose, which schedules the next attempt.
      });
    }, delay);
  }

  send(message: ClientMessage): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Sends an audio segment: a JSON header, then the binary frame. */
  async sendSegment(header: { segmentId: string; durationSeconds: number }, blob: Blob): Promise<boolean> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;

    const buffer = await blob.arrayBuffer();
    // The header must precede the binary frame; WebSocket preserves order, so
    // the pair cannot be interleaved with another segment's.
    const announced = this.send({
      type: 'segment.header',
      segmentId: header.segmentId,
      durationSeconds: header.durationSeconds,
      byteLength: buffer.byteLength,
    });
    if (!announced) return false;

    try {
      socket.send(buffer);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Closes deliberately. Cancels any pending reconnect and bumps the
   * generation so nothing from the old socket can still fire.
   */
  disconnect(code: number = CLOSE_CODES.NORMAL, reason = 'client closed'): void {
    this.#closedByUs = true;
    this.#generation += 1;

    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#reconnectAttempts = 0;
    this.#connectPromise = null;

    const socket = this.#socket;
    this.#socket = null;

    if (socket) {
      this.#detach(socket);
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(code, reason);
        }
      } catch {
        // Already closing.
      }
    }

    this.#setState('disconnected');
  }

  /** Removes every handler so a lingering socket cannot touch React state. */
  #detach(socket: WebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onStateChange?.(state);
  }
}
