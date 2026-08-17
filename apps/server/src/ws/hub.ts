import type { Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { CLOSE_CODES } from '@translate/shared';
import type { AppConfig } from '../lib/config.js';
import type { TranslationPipeline } from '../services/pipeline.js';
import type { QuotaManager } from '../usage/quotaManager.js';
import { Connection } from './connection.js';
import { SessionRegistry } from './sessionRegistry.js';

export interface HubDeps {
  server: HttpServer;
  pipeline: TranslationPipeline;
  quota: QuotaManager;
  config: AppConfig;
  path?: string;
}

/**
 * Owns the WebSocket server and the set of live connections.
 *
 * Attached to the existing HTTP server rather than listening on its own port,
 * because Render exposes exactly one port per service — the upgrade has to
 * share it with the REST API.
 */
export class WebSocketHub {
  readonly registry: SessionRegistry;

  readonly #wss: WebSocketServer;
  readonly #connections = new Map<string, Connection>();
  readonly #deps: HubDeps;
  #closed = false;

  constructor(deps: HubDeps) {
    this.#deps = deps;
    this.registry = new SessionRegistry({ quota: deps.quota });

    this.#wss = new WebSocketServer({
      server: deps.server,
      path: deps.path ?? '/ws',
      // Audio frames are ~64 KB; the cap stops a client streaming us to death.
      maxPayload: Math.max(1_000_000, deps.config.quota.maxAudioBytes + 100_000),
    });

    this.#wss.on('connection', this.#onConnection);
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  get sessionCount(): number {
    return this.registry.size;
  }

  #onConnection = (socket: WebSocket): void => {
    if (this.#closed) {
      socket.close(CLOSE_CODES.SERVER_SHUTDOWN, 'server shutting down');
      return;
    }

    const connection = new Connection({
      socket,
      registry: this.registry,
      pipeline: this.#deps.pipeline,
      quota: this.#deps.quota,
      config: this.#deps.config,
      onSupersede: (ids) => this.#supersede(ids),
      onClosed: (id) => this.#connections.delete(id),
    });

    this.#connections.set(connection.id, connection);
  };

  /**
   * Closes connections that just lost their session to a newer one.
   *
   * The loser is told explicitly (`session.superseded`) before the socket
   * closes, so its UI can return to idle with a reason instead of appearing to
   * fail for no visible cause.
   */
  #supersede(connectionIds: string[]): void {
    for (const id of connectionIds) {
      const connection = this.#connections.get(id);
      if (!connection) continue;
      const session = this.registry.get(id);
      connection.supersede(session?.sessionId ?? '');
      this.#connections.delete(id);
    }
  }

  /**
   * Graceful shutdown. Render sends SIGTERM before replacing an instance, and
   * every open session must be released so nothing is left holding a slot in a
   * process that is about to disappear.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    for (const connection of [...this.#connections.values()]) {
      connection.close(CLOSE_CODES.SERVER_SHUTDOWN, 'server shutting down');
    }
    this.#connections.clear();
    this.registry.releaseAll('expired');

    await new Promise<void>((resolve) => {
      this.#wss.close(() => resolve());
      // Never let shutdown hang on a socket that refuses to close.
      setTimeout(resolve, 2000).unref?.();
    });
  }
}
