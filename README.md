# Auto Transliteration — voice translation monorepo

Speak in your language. They hear it in theirs.

```
   microphone → speech-to-text → translation → text-to-speech → audio out
     (device)   Whisper, local     MyMemory     browser engine   (device)
                     └──────── backend ────────┘
                          over one WebSocket
```

**No API keys. No cloud accounts. No per-request cost.** Speech recognition runs
locally with Whisper, translation uses MyMemory's free keyless API, and the
browser's own speech engine reads the translation aloud.

> **A note on the client.** `apps/web` is a mobile-first **web** app (Vite +
> React DOM), not React Native — there is no Expo, Metro, or React Navigation in
> this repository and never has been. See
> [Client platform](#client-platform-important) before planning mobile work.

---

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Open **http://localhost:5173** (API and WebSocket on `:8787`).

First run downloads the Whisper weights (~145 MB for `whisper-base`), cached
after. `PROVIDER_MODE=mock` skips the download for offline development.

---

## Monorepo structure

```
translate-ReactNative/
│
├── apps/
│   ├── web/                    mobile-first React web client
│   │   ├── src/
│   │   │   ├── animations/     GSAP: aurora, mic orb, transitions
│   │   │   ├── components/     ui/ + screens/
│   │   │   ├── config/         env.ts — dev/prod URL resolution
│   │   │   ├── experiments/    A/B assignment + tracking
│   │   │   ├── hooks/          useTranslationSession, useTypewriter
│   │   │   ├── services/       wsClient, recorder, vad, wav, speech, api
│   │   │   ├── styles/
│   │   │   └── types/
│   │   ├── .env.example        PUBLIC values only
│   │   └── package.json
│   │
│   └── server/                 Node backend (Express + ws)
│       ├── src/
│       │   ├── ws/             hub, connection, sessionRegistry
│       │   ├── services/       whisper, mymemory, pipeline, segmenter, circuit
│       │   ├── usage/          quotaManager, store
│       │   ├── experiments/
│       │   ├── lib/            audio, config, errors, crypto, languages
│       │   └── routes/
│       ├── .env.example        BACKEND-ONLY values
│       ├── build.mjs           esbuild bundle for Render
│       └── package.json
│
├── packages/
│   └── shared/                 the contract both sides import
│       ├── src/
│       │   ├── sessionState.ts session state machine
│       │   ├── protocol.ts     WebSocket message union
│       │   └── text.ts         text reconciliation (anti-duplication)
│       └── package.json
│
├── render.yaml                 Render blueprint (deploys apps/server only)
├── package.json                npm workspaces
└── README.md
```

Tooling is **npm workspaces** alone. Turborepo was considered and rejected: with
two apps and one library, the build graph is `shared → {web, server}` and takes
under a second — a task orchestrator would add configuration without saving time.

---

## Local development

```bash
npm install          # installs all workspaces and links packages/shared
npm run dev          # server on :8787 + web on :5173, both hot-reloading
```

Individual services:

```bash
npm run dev:server
```

```bash
npm run dev:web
```

Or by workspace name:

```bash
npm run dev --workspace @translate/server
```

| Command | Does |
|---|---|
| `npm run dev` | Both services with hot reload |
| `npm run build` | Build server bundle + web bundle |
| `npm run build:server` | Server only (what Render runs) |
| `npm start` | Run the built server |
| `npm run typecheck` | Strict TypeScript across all three workspaces |
| `npm test` | Full suite — 555 tests |
| `npm run check:providers` | Load Whisper and call MyMemory; report what works |

---

## Client platform (important)

This repository contains **no React Native code**. `apps/web` is Vite +
`react-dom`, rendering to `index.html` with CSS stylesheets and GSAP animating
DOM nodes.

If a React Native app is wanted, the monorepo is already shaped for it: add
`apps/mobile`, depend on `@translate/shared`, and the session state machine,
WebSocket protocol, and text-reconciliation logic all work unchanged — they are
platform-agnostic TypeScript with no DOM dependencies. What would need rewriting
is the presentation layer (GSAP → Reanimated, CSS → StyleSheet) and the device
layer (`getUserMedia`/`AudioContext` → `expo-av`, `speechSynthesis` →
`expo-speech`).

---

## The session lifecycle

The microphone is one state machine, defined once in
`packages/shared/src/sessionState.ts` and imported by **both** the client and
the server.

```
        ┌──────────────────────── RESET ────────────────────────┐
        │                                                       │
      IDLE ──START──> STARTING ──STARTED──> ACTIVE ──PAUSE──> PAUSED
        ▲                 │                  │  ▲                │
        │                 │                  │  └─── RESUME ─────┘
        │                 │            CONNECTION_LOST
        │                 │                  ↓
        │                 │            RECONNECTING ──RECONNECTED──> ACTIVE
        │                 │                  │
        │                 └──── FAIL ───> ERROR ──START──> STARTING
        │                                    │
        └──STOPPED── STOPPING <──STOP────────┘
```

Transitions not in the table are **impossible by construction**. That is what
makes rapid tapping safe: `START` has no transition out of `STARTING` or
`ACTIVE`, so three taps produce one session rather than three.

It also makes the reported contradictory state unrepresentable. There is no way
to express "not recording, not paused, but the backend thinks a session is
live", because the session is a single value and whether it holds a server slot
is *derived* from that value rather than tracked separately.

### Why "session already in progress" no longer happens

**Root cause.** A session used to be a row in the `QuotaManager` and nothing
more. The only thing that removed it was a 120-second idle reaper polled every
30 seconds. Any client that vanished without calling `/stop` — a closed tab, a
refresh, a crash, a dropped network, or an error thrown on the stop path — left
the row behind. `startSession` then saw `activeSessionsFor(user) >= 1` and
refused, locking the user out for up to two and a half minutes.

**Two changes fix it:**

1. **The connection is the session's lifetime.** One socket owns one session
   (`apps/server/src/ws/sessionRegistry.ts`). When that socket closes — cleanly,
   abruptly, or by heartbeat timeout — the session is released immediately.
   There is no window in which a dead client holds a live slot.

2. **Ownership transfers instead of blocking.** If the same device opens a new
   connection and starts, the older session is *superseded*: the previous owner
   receives `session.superseded`, its socket closes with code 4001, and the slot
   is handed over. The concurrency limit still applies across *different* users,
   which is what it was actually for — it was never meant to stop someone
   restarting their own microphone.

**Half-open sockets** are covered by a ping/pong heartbeat (15 s interval, 40 s
budget). A phone that loses signal leaves a socket that looks open forever from
the server's side; without the heartbeat that is the original bug wearing a
different hat.

**Verified live** — the exact reported scenario:

```
1) start session over WS          → active
2) client vanishes (terminate, no stop frame)
3) same device reconnects, starts → active,  errors: none
```

---

## Letter-by-letter text

Both the detected speech and the translation reveal character by character, with
**independent** animation states.

### Two-stage delivery

The server pushes the transcript the moment recognition finishes, *before*
requesting the translation:

```
audio ──> Whisper ──> transcript ────────────> client starts animating source
                          │
                          └──> MyMemory ─────> translation ──> client animates target
```

Measured on a live run: transcript at **821 ms**, translation at **1600 ms** — a
779 ms head start during which the source text is already typing. The two texts
are separate `useTypewriter` instances, so neither blocks or restarts the other.

### Why duplication cannot occur

Every update carries the **complete text so far**, not a delta. The renderer
reconciles rather than appends (`packages/shared/src/text.ts`):

| Update | Classified | Behaviour |
|---|---|---|
| `Hell` → `Hello` | `extended` | Keep all revealed characters, keep typing |
| `Hello world` → `Hello there` | `diverged` | Rewind to `Hello `, retype the tail |
| `Hello` → `Hello` | `unchanged` | Nothing |
| `Hello` → `` | `cleared` | Clear |

So a stream of `H` / `He` / `Hel` / `Hell` / `Hello` renders `Hello`, never
`HHeHelHellHello`. Appending would produce the second; reconciling produces the
first. The `extended` case is also what keeps a fast stream looking like one
continuous animation instead of restarting on every update.

Whisper is batch — it emits one final transcript per utterance, so there are no
interim results today. The protocol carries `isFinal` and the typewriter is
prefix-safe regardless, so a streaming recogniser can be dropped in without
touching either.

Other guarantees: empty text is safe, updates arriving faster than frames are
handled, graphemes are never split mid-emoji, and `prefers-reduced-motion`
switches to instant display.

---

## WebSocket handling

One socket, strictly managed (`apps/web/src/services/wsClient.ts`):

- `connect()` while connecting or open is a no-op returning the existing promise
  — double-tapping cannot open two sockets.
- Handlers are keyed to a **generation counter**. A replaced socket's events are
  dropped, so a dying socket can never push state into React or resurrect a
  closed session.
- `disconnect()` sets a flag that cancels pending reconnects — otherwise an
  intentional stop races a retry and silently reopens the session.
- Reconnection is bounded (5 attempts, exponential backoff capped at 10 s) and
  skipped entirely for `SUPERSEDED`, `PROTOCOL_MISMATCH`, and normal closes.
- States: `connecting → connected → disconnecting → disconnected`, plus `error`.

Development uses `ws://`, production `wss://` — derived automatically from the
API origin's scheme, so an `https` page can never open an insecure socket.

---

## Environment variables

Split by app, with the security boundary enforced by naming:

| File | Contents | Exposure |
|---|---|---|
| `apps/web/.env.example` | `VITE_API_URL`, `VITE_WS_URL` | **Public** — inlined into the JS bundle |
| `apps/server/.env.example` | ports, model, quotas, `MYMEMORY_EMAIL`, `PAYLOAD_ENCRYPTION_KEY` | Server only |

Vite exposes **only** `VITE_`-prefixed variables. No backend variable uses that
prefix, so a server secret cannot reach the client even by accident. (There are
no third-party API keys in this project at all — Whisper is local and MyMemory
is keyless.)

### Development vs production URLs

No component ever writes a URL; everything resolves in
`apps/web/src/config/env.ts`.

**Development** — leave both blank. The Vite dev server proxies `/api` and `/ws`
to `localhost:8787`, so same-origin just works.

**Production** — `apps/web/.env.production`:

```bash
VITE_API_URL=https://YOUR-SERVICE.onrender.com
VITE_WS_URL=wss://YOUR-SERVICE.onrender.com
```

Set only `VITE_API_URL` and the WebSocket URL is derived from it (`https` → `wss`).

---

## Deployment

Two services, deployed separately from one repo:

```
        GitHub — one repo
              │
    ┌─────────┴─────────┐
    │                   │
  Vercel              Render
  apps/web            apps/server
  static bundle       Node + WebSocket
    │                   │
    └──── wss:// ───────┘
```

**Deploy Render first** — you need its URL before building the front end, because
Vite inlines the API URL at build time.

### Order of operations

1. Deploy the backend to Render → get `https://YOUR-API.onrender.com`
2. Deploy the front end to Vercel with `VITE_API_URL` set to that URL
3. Set Render's `CORS_ORIGIN` to your Vercel domain
4. Redeploy Render so the CORS change takes effect

### 1. Render — `apps/server`

Either commit `render.yaml` and use **New → Blueprint**, or configure manually:

| Setting | Value |
|---|---|
| Type | Web Service |
| Runtime | Node |
| **Root Directory** | *(blank — the repo root)* |
| Build Command | `npm ci && npm run build:server` |
| Start Command | `node apps/server/dist/index.js` |
| Health Check Path | `/api/health` |
| Instance Type | Starter or above |

**Root Directory must be blank.** `npm install` inside `apps/server` cannot
resolve `@translate/shared` — npm workspace symlinks only exist when the install
runs at the root.

**Do not use the free tier.** It sleeps after inactivity, which drops every open
WebSocket and takes ~50 s to wake.

Environment variables:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | *(do not set — Render injects it)* |
| `CORS_ORIGIN` | your Vercel domain (step 3) |
| `WHISPER_MODEL` | `onnx-community/whisper-base` |
| `WHISPER_WARMUP` | `true` |
| `MYMEMORY_EMAIL` | your email — raises the daily allowance ~5k → ~50k chars |
| `PAYLOAD_ENCRYPTION_KEY` | generate a random value |

Add a **persistent disk** at `/opt/render/.cache/huggingface` (2 GB) so the
~145 MB model is not re-downloaded on every deploy.

Verify:

```bash
curl https://YOUR-API.onrender.com/api/health
```

### 2. Vercel — `apps/web`

`vercel.json` at the repo root already sets the build. In the dashboard:

| Setting | Value |
|---|---|
| Framework Preset | Other |
| **Root Directory** | *(blank — the repo root)* |
| Build Command | `npm run build:web` *(from vercel.json)* |
| Output Directory | `apps/web/dist` *(from vercel.json)* |

Environment variable — **Production** scope:

| Key | Value |
|---|---|
| `VITE_API_URL` | `https://YOUR-API.onrender.com` |

`VITE_WS_URL` is optional: the WebSocket URL is derived from `VITE_API_URL`,
mapping `https` → `wss` automatically. Set it only if the socket is on a
different host.

> Vite inlines `VITE_*` at **build** time. Changing this variable requires a
> redeploy — editing it in the dashboard alone changes nothing.

### 3. Close the CORS loop

Set `CORS_ORIGIN` on Render to your Vercel domain (e.g.
`https://your-app.vercel.app`) and redeploy. Include preview domains as a
comma-separated list if you want them to work too.

### Why the backend is not on Vercel

Vercel's serverless functions cannot hold a long-lived WebSocket, and this app's
entire session model depends on one: the socket *is* the liveness signal that
releases a session the moment a client disconnects. On serverless the session
lifecycle — and the fix for the "session already in progress" bug — would not
work. Render runs a persistent Node process, which is what this needs.

## Testing

```bash
npm test                # 555 tests across all workspaces
npm run test:unit
npm run test:integration
npm run test:ab
```

| Suite | Covers |
|---|---|
| `packages/shared` (59) | State machine: rapid taps, restart, connection loss, illegal transitions, contradictory-state impossibility. Text reconciliation: the `H`/`He`/`Hel` → `Hello` guarantee, corrections, graphemes |
| `apps/server` (277) | WS session lifecycle over real sockets — abrupt disconnect, takeover, rapid Start/Stop, two-stage delivery, paused audio dropped, shutdown cleanup. Plus quotas, providers, audio decoding, failure classification |
| `apps/web` (219) | Typewriter (no duplication, continuity, independence), session hook against a scripted socket, VAD, WAV encoding, speech synthesis, A/B |

---

## Cost and safety controls

Enforced server-side before any provider call; the client never reports its own
usage. Session and daily/monthly time limits, per-user and global concurrency,
a 500-character cap (MyMemory's own limit), silence gating, filler and duplicate
rejection, and an app-wide daily character ceiling. `GET /api/metrics` exposes
the counters for alerting.

Audio is encrypted with AES-256-GCM on arrival, decrypted only for the instant
the recogniser needs it, and shredded on every path including thrown errors —
`pendingAudioBuffers` is `0` between requests. Recognition and synthesis are
local, so the only thing leaving your infrastructure is the recognised *text*
sent to MyMemory.
