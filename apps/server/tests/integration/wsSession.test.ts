import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { CLOSE_CODES, PROTOCOL_VERSION } from '@translate/shared';
import type { ServerMessage } from '@translate/shared';
import { createApp } from '../../src/app.js';
import { WebSocketHub } from '../../src/ws/hub.js';
import { QuotaManager } from '../../src/usage/quotaManager.js';
import { TranslationPipeline } from '../../src/services/pipeline.js';
import { FakeClock, scriptedProviders, testConfig, wavFixture } from '../helpers.js';

/**
 * The regression suite for the reported bug:
 *
 *   "The microphone can become paused/stopped, and when I click it again the
 *    application reports: There is already a session in progress."
 *
 * Every test here is a scenario that used to leave a session stranded.
 */
describe('WebSocket session lifecycle', () => {
  const config = testConfig();
  let server: Server;
  let hub: WebSocketHub;
  let quota: QuotaManager;
  let providers: ReturnType<typeof scriptedProviders>;
  let url: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const clock = new FakeClock();
    providers = scriptedProviders();
    quota = new QuotaManager({ quota: config.quota, clock });
    const pipeline = new TranslationPipeline({ providers, quota, config, clock });
    const built = createApp({ config, clock, providers, quota, pipeline });

    server = createServer(built.app);
    hub = new WebSocketHub({ server, pipeline, quota, config });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/ws`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      try {
        socket.terminate();
      } catch {
        /* already gone */
      }
    }
    await hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // ── Helpers ─────────────────────────────────────────────────────────────

  interface Client {
    socket: WebSocket;
    messages: ServerMessage[];
    /**
     * Returns the next *unconsumed* message of `type`, waiting if none has
     * arrived yet.
     *
     * Consumption tracking matters in both directions. A start/stop/start
     * sequence produces several `session.state` frames, so re-matching an old
     * one would assert against the previous cycle; meanwhile `session.superseded`
     * can arrive before the assertion is even written, so a waiter that only
     * looks forward would hang. Marking each message consumed once handles both.
     */
    next: (type: ServerMessage['type'], timeoutMs?: number) => Promise<ServerMessage>;
    send: (message: unknown) => void;
    closed: Promise<{ code: number }>;
  }

  async function connect(deviceId: string): Promise<Client> {
    const socket = new WebSocket(url);
    sockets.push(socket);
    const messages: ServerMessage[] = [];
    const consumed = new Set<ServerMessage>();
    const waiters: Array<{ type: string; resolve: (m: ServerMessage) => void }> = [];

    let resolveClosed: (v: { code: number }) => void;
    const closed = new Promise<{ code: number }>((r) => {
      resolveClosed = r;
    });
    socket.on('close', (code) => resolveClosed({ code }));

    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as ServerMessage;
      messages.push(message);
      const index = waiters.findIndex((w) => w.type === message.type);
      if (index >= 0) {
        consumed.add(message);
        waiters.splice(index, 1)[0]!.resolve(message);
      }
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const client: Client = {
      socket,
      messages,
      send: (message) => socket.send(JSON.stringify(message)),
      closed,
      next: (type, timeoutMs = 3000) => {
        const existing = messages.find((m) => m.type === type && !consumed.has(m));
        if (existing) {
          consumed.add(existing);
          return Promise.resolve(existing);
        }
        return new Promise<ServerMessage>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
          waiters.push({
            type,
            resolve: (m) => {
              clearTimeout(timer);
              resolve(m);
            },
          });
        });
      },
    };

    await client.next('ready');
    client.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, deviceId });
    return client;
  }

  async function startSession(client: Client, deviceLangs = { sourceLang: 'ar-SA', targetLang: 'en-US' }) {
    client.send({ type: 'session.start', ...deviceLangs, takeover: true });
    const state = await client.next('session.state');
    // Assert on the state we actually got: a leftover `idle` from a previous
    // stop must never be mistaken for confirmation that a new session opened.
    expect(state).toMatchObject({ state: 'active' });
    return state;
  }

  /** Stops and waits for the server to confirm, rather than sleeping. */
  async function stopSession(client: Client) {
    client.send({ type: 'session.stop' });
    const state = await client.next('session.state');
    expect(state).toMatchObject({ state: 'idle' });
    return state;
  }

  const flush = () => new Promise((r) => setTimeout(r, 60));

  // ── The reported bug ────────────────────────────────────────────────────

  describe('the "session already in progress" bug', () => {
    /**
     * The exact failure: a client vanishes without stopping, then the user taps
     * the mic again. Previously the second start was refused for up to 2.5
     * minutes. Now the first socket's death releases the session immediately.
     */
    it('lets the same device start again after an abrupt disconnect', async () => {
      const first = await connect('device-abrupt-01');
      const started = await startSession(first);
      expect(started).toMatchObject({ type: 'session.state', state: 'active' });
      expect(hub.sessionCount).toBe(1);

      // Kill it the way a closed tab or a dropped network would: no stop frame.
      first.socket.terminate();
      await first.closed;
      await flush();

      const second = await connect('device-abrupt-01');
      const restarted = await startSession(second);

      expect(restarted).toMatchObject({ type: 'session.state', state: 'active' });
      const errors = second.messages.filter((m) => m.type === 'error');
      expect(errors).toHaveLength(0);
    });

    it('releases the session the moment the socket closes', async () => {
      const client = await connect('device-release-01');
      await startSession(client);
      expect(hub.sessionCount).toBe(1);

      client.socket.close();
      await client.closed;
      await flush();

      // No waiting on a reaper: the slot is free straight away.
      expect(hub.sessionCount).toBe(0);
    });

    it('hands the session over when the same device reconnects while one is live', async () => {
      const first = await connect('device-takeover-01');
      await startSession(first);

      // The old connection is still open — the previous design's worst case.
      const second = await connect('device-takeover-01');
      const started = await startSession(second);

      expect(started).toMatchObject({ state: 'active' });

      // The loser is told why, rather than silently breaking.
      const superseded = await first.next('session.superseded');
      expect(superseded.type).toBe('session.superseded');
      const closed = await first.closed;
      expect(closed.code).toBe(CLOSE_CODES.SUPERSEDED);

      await flush();
      expect(hub.sessionCount).toBe(1);
    });

    it('still refuses a genuine capacity limit, so takeover is not a bypass', async () => {
      // maxConcurrentGlobal is 3 in the test config. Different devices must
      // still contend — takeover only ever displaces the *same* device.
      const a = await connect('device-cap-a');
      const b = await connect('device-cap-b');
      const c = await connect('device-cap-c');
      await startSession(a);
      await startSession(b);
      await startSession(c);

      const d = await connect('device-cap-d');
      d.send({ type: 'session.start', sourceLang: 'ar-SA', targetLang: 'en-US' });
      const error = await d.next('error');

      expect(error).toMatchObject({ type: 'error', kind: 'internal_quota_exceeded' });
    });
  });

  // ── Rapid interaction ───────────────────────────────────────────────────

  describe('rapid interaction', () => {
    it('Start Start Start creates exactly one session', async () => {
      const client = await connect('device-rapid-01');

      client.send({ type: 'session.start', sourceLang: 'ar-SA', targetLang: 'en-US' });
      client.send({ type: 'session.start', sourceLang: 'ar-SA', targetLang: 'en-US' });
      client.send({ type: 'session.start', sourceLang: 'ar-SA', targetLang: 'en-US' });
      await flush();

      expect(hub.sessionCount).toBe(1);
      expect(client.messages.filter((m) => m.type === 'error')).toHaveLength(0);
    });

    it('Pause Resume Pause Resume leaves exactly one active session', async () => {
      const client = await connect('device-rapid-02');
      await startSession(client);

      for (let i = 0; i < 2; i += 1) {
        client.send({ type: 'session.pause' });
        client.send({ type: 'session.resume' });
      }
      await flush();

      expect(hub.sessionCount).toBe(1);
      expect(client.messages.filter((m) => m.type === 'error')).toHaveLength(0);
    });

    it('Start Stop Start Stop Start ends with one clean session', async () => {
      const client = await connect('device-rapid-03');

      for (let i = 0; i < 2; i += 1) {
        await startSession(client);
        expect(hub.sessionCount).toBe(1);
        await stopSession(client);
        expect(hub.sessionCount).toBe(0);
      }

      // The third start must open a genuinely clean session.
      await startSession(client);
      expect(hub.sessionCount).toBe(1);
      expect(client.messages.filter((m) => m.type === 'error')).toHaveLength(0);
    });

    it('tolerates a stop with no session', async () => {
      const client = await connect('device-rapid-04');
      client.send({ type: 'session.stop' });
      const state = await client.next('session.state');

      expect(state).toMatchObject({ state: 'idle' });
      expect(client.messages.filter((m) => m.type === 'error')).toHaveLength(0);
    });
  });

  // ── Two-stage delivery ──────────────────────────────────────────────────

  describe('transcript and translation arrive as separate stages', () => {
    it('sends the transcript before the translation', async () => {
      const client = await connect('device-stages-01');
      await startSession(client);

      const audio = wavFixture({ seconds: 1.2 });
      client.send({
        type: 'segment.header',
        segmentId: 'seg-1',
        durationSeconds: 1.2,
        byteLength: audio.byteLength,
      });
      client.socket.send(audio);

      const transcript = await client.next('transcript');
      const translation = await client.next('translation');

      expect(transcript).toMatchObject({ type: 'transcript', segmentId: 'seg-1', isFinal: true });
      expect(translation).toMatchObject({ type: 'translation', segmentId: 'seg-1', isFinal: true });

      // Ordering is what lets the client animate the source text while the
      // translation is still in flight.
      const transcriptIndex = client.messages.findIndex((m) => m.type === 'transcript');
      const translationIndex = client.messages.findIndex((m) => m.type === 'translation');
      expect(transcriptIndex).toBeLessThan(translationIndex);
    });

    it('reports a skipped segment rather than an empty translation', async () => {
      providers.stt.queue({ text: '', confidence: 0, status: 'no_match', durationSeconds: 1 });
      const client = await connect('device-stages-02');
      await startSession(client);

      const audio = wavFixture({ seconds: 1.2 });
      client.send({
        type: 'segment.header',
        segmentId: 'seg-skip',
        durationSeconds: 1.2,
        byteLength: audio.byteLength,
      });
      client.socket.send(audio);

      const skipped = await client.next('segment.skipped');
      expect(skipped).toMatchObject({ type: 'segment.skipped', segmentId: 'seg-skip' });
    });

    it('drops audio that arrives while paused', async () => {
      const client = await connect('device-stages-03');
      await startSession(client);

      client.send({ type: 'session.pause' });
      await client.next('session.state');

      const before = providers.stt.calls.length;
      const audio = wavFixture({ seconds: 1.2 });
      client.send({
        type: 'segment.header',
        segmentId: 'seg-paused',
        durationSeconds: 1.2,
        byteLength: audio.byteLength,
      });
      client.socket.send(audio);
      await flush();

      // Paused means paused: processing it would bill time the user did not
      // intend to spend.
      expect(providers.stt.calls).toHaveLength(before);
    });

    it('ignores a binary frame with no preceding header', async () => {
      const client = await connect('device-stages-04');
      await startSession(client);

      const before = providers.stt.calls.length;
      client.socket.send(wavFixture({ seconds: 1 }));
      await flush();

      expect(providers.stt.calls).toHaveLength(before);
    });
  });

  // ── Cleanup ─────────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('leaves no session behind when many clients disconnect at once', async () => {
      const clients = await Promise.all(
        ['bulk-a', 'bulk-b', 'bulk-c'].map((id) => connect(`device-${id}`)),
      );
      for (const client of clients) await startSession(client);
      expect(hub.sessionCount).toBe(3);

      for (const client of clients) client.socket.terminate();
      await Promise.all(clients.map((c) => c.closed));
      await flush();

      expect(hub.sessionCount).toBe(0);
      expect(hub.connectionCount).toBe(0);
    });

    it('releases everything on shutdown', async () => {
      const client = await connect('device-shutdown-01');
      await startSession(client);
      expect(hub.sessionCount).toBe(1);

      await hub.close();

      expect(hub.sessionCount).toBe(0);
      const closed = await client.closed;
      expect(closed.code).toBe(CLOSE_CODES.SERVER_SHUTDOWN);
    });

    it('rejects a mismatched protocol version instead of misbehaving later', async () => {
      const socket = new WebSocket(url);
      sockets.push(socket);
      await new Promise<void>((resolve) => socket.once('open', () => resolve()));

      const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
      socket.send(JSON.stringify({ type: 'hello', protocolVersion: 999, deviceId: 'device-proto' }));

      expect(await closed).toBe(CLOSE_CODES.PROTOCOL_MISMATCH);
    });

    it('refuses to start before the client has identified itself', async () => {
      const socket = new WebSocket(url);
      sockets.push(socket);
      const messages: ServerMessage[] = [];
      socket.on('message', (raw) => messages.push(JSON.parse(String(raw)) as ServerMessage));
      await new Promise<void>((resolve) => socket.once('open', () => resolve()));

      // No `hello` first.
      socket.send(JSON.stringify({ type: 'session.start', sourceLang: 'ar-SA', targetLang: 'en-US' }));
      await flush();

      expect(messages.some((m) => m.type === 'error')).toBe(true);
      expect(hub.sessionCount).toBe(0);
    });

    it('rejects an unsupported language pair', async () => {
      const client = await connect('device-lang-01');
      client.send({ type: 'session.start', sourceLang: 'xx-XX', targetLang: 'en-US' });
      const error = await client.next('error');

      expect(error).toMatchObject({ kind: 'bad_request' });
      expect(hub.sessionCount).toBe(0);
    });
  });
});
