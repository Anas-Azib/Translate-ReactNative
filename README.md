# Auto Transliteration — mobile-first voice translation

Speak in your language. They hear it in theirs.

Built to the specification in `Plan_documant.pdf`: a mobile-first web app that
takes microphone input, recognises the speech, translates it, and speaks the
result back — with the backend owning every credential and every spend control.

```
   microphone → speech-to-text → translation → text-to-speech → audio out
      (phone)      (Azure)        (Google NMT)   (Google TTS)     (phone)
                      └───────────── backend ──────────────┘
```

The plan document specifies React Native; this is the same architecture and the
same flow delivered as a mobile-first **web** app, as requested. Everything
below the UI layer — the pipeline, the usage control, the failure policies — is
identical to what a React Native client would talk to.

---

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Then open **http://localhost:5173** (API on `:8787`).

No API keys are required to run it. Without credentials each provider falls back
to a deterministic offline implementation, so the full flow — recording, silence
detection, recognition, translation, playback, quota enforcement — works end to
end with zero spend. Add keys to `.env` (see `.env.example`) and the same code
paths call the real services.

---

## Architecture

```
client/                     mobile-first React app
  src/
    animations/             GSAP: aurora, mic orb, text reveal, transitions
    components/             ui/ (orb, cards, sheet, meter) + screens/
    experiments/            A/B assignment + conversion tracking
    hooks/                  useTranslationSession — the live loop
    services/               api client, recorder, VAD, playback
    styles/                 design tokens, base, components
    types/

server/                     the only thing that holds credentials
  src/
    services/               Azure STT · Google NMT · Google TTS (+ offline doubles)
                            pipeline.ts   — orchestration
                            segmenter.ts  — what is worth paying to translate
                            circuit.ts    — hard stop after a provider says stop
    usage/                  quotaManager.ts — daily / session / global limits
    experiments/            assignment, event store, significance testing
    lib/                    config, errors, crypto, cache, languages
    routes/                 session · translate · ab · meta
```

### Why the audio goes through the backend

Azure's browser SDK would be faster to wire up, but the plan document's data
flow is `Phone → Backend → Speech API`, and routing audio through the server is
what keeps the subscription key off the device. The client never learns a
provider URL, let alone a credential — `/api/config` is deliberately free of
both.

---

## Cost controls

Every constraint on p.4 of the plan document is enforced server-side, before any
upstream call. The client is never trusted to report its own usage.

| Constraint | Where | Behaviour |
|---|---|---|
| Max translation time per day / month | `QuotaManager` | New sessions refused once spent |
| Session time limit | `QuotaManager` | Session auto-stops; user must explicitly start a new one |
| No indefinite microphone | `VoiceActivityDetector` + session cap | Mic stops itself after sustained silence |
| No silent audio sent upstream | `vad.ts`, `segmenter.ts` | Silence never leaves the device; a server-side floor rejects it again |
| Only finalized segments translated | `segmenter.ts` | Filler ("uh"), duplicates, and low-confidence text are dropped before Google |
| No unnecessary TTS | `pipeline.ts` + `TtlCache` | Identical text is served from cache and billed nothing |
| Max text size per request | `QuotaManager` | Over-long transcripts are clamped on a word boundary |
| Concurrent sessions per user / globally | `QuotaManager` | Refused with a plain-language message |
| Reject at internal quota | `QuotaManager` | `429` before a single upstream call |
| Track usage per user and globally | `UsageStore` | Per-day and per-month buckets, derived only from bytes the server handled |
| Budget alerting | `GET /api/metrics` | Character spend vs. the free-tier ceilings, ready to scrape |
| Never expose credentials | `middleware`, `routes/meta.ts` | Keys live only in server env; error detail is never returned |

The free-tier ceilings from the plan document are configured as app-wide caps
(`450k` translation characters and `3.8M` TTS characters per month), so the app
stops itself before Google starts charging.

### Failure behaviour

The failure tables on p.2–3 are encoded once, in `server/src/lib/errors.ts`, and
drive both the HTTP status and the retry policy:

| Provider says | We do | User sees |
|---|---|---|
| `NoMatch` | Not an error; nothing billed downstream | "No speech recognized" |
| `AuthenticationFailure` | **Stop.** Halt the provider, never retry | "Speech service authentication failed." |
| Bad request | **Stop.** Never retry unchanged | "That request couldn't be processed…" |
| Quota exceeded | **Stop all requests.** Never retry | "Service limit was reached…" |
| 5xx / network | Retry with backoff | "The service is busy…" |

`ProviderCircuit` makes the hard stops real: after an auth failure or a quota
stop, further calls are refused locally without touching the network. Retrying
into a `429` is exactly how a small overage becomes a large bill.

### Privacy

Audio is encrypted with AES-256-GCM the moment it arrives, decrypted only for
the instant a provider needs it, and shredded on every path including thrown
errors — `GET /api/metrics` exposes `pendingAudioBuffers`, which is `0` between
requests. Device ids are salted and hashed before they touch a counter, so usage
and experiment data cannot be traced back to a device.

---

## The interface

Apple's design language, applied to a colourful app: system-palette accents,
frosted materials, large continuous corners, 44 pt minimum targets, safe-area
insets, and motion built on custom eases (`apple-out`, `apple-spring`) so the
whole app moves like one system. Light and dark themes both ship.

It is designed for someone who has never used a translation app. There is one
obvious control. Copy avoids every internal term — no "quota", "session", or
"API" appears anywhere in the UI. The time budget reads as "1:38 left" and turns
amber then red before it stops, so the cutoff is never a surprise.

### Animation

GSAP drives a handful of systems that are load-bearing rather than decorative:

- **Aurora background** — five blobs on independent, non-repeating timelines,
  energised in real time by microphone amplitude.
- **Mic orb** — a morphing `MorphSVG` core, staggered ripple rings, a 40-bar
  circular equaliser, a `DrawSVG` budget ring, and a `Physics2D` particle burst
  on a completed translation. The equaliser runs on `gsap.ticker`, entirely
  outside React's render cycle, because amplitude arrives at 60 Hz.
- **Text reveal** — per-character 3D rise, except for Arabic and other cursive
  scripts, which split by word so letter joining survives. The split carries an
  `aria-label` so the accessible name never fragments, and restores itself if
  interrupted.
- **Language swap** — `Flip`, because the chips are different widths and the
  travel distance is only knowable after the DOM reorders.
- **Sheets** — iOS presentation: the sheet rises while the content behind it
  scales and dims.

`prefers-reduced-motion` is honoured globally.

---

## Testing

```bash
npm test               # everything — 378 tests
npm run test:unit
npm run test:integration
npm run test:ab
npm run test:coverage
```

**Unit** — quota ceilings and rollover, the failure-classification tables,
segment gating, provider request/response shapes, encryption and shredding, the
VAD state machine against a scripted amplitude envelope, the API client's retry
policy, and the animation primitives.

**Integration** — the real Express app driven over HTTP with only the three
providers doubled: full pipeline, session lifecycle, quota rejections, upload
limits, credential leakage, and per-device isolation. On the client, the real
component tree with only the network doubled: boot, onboarding, language
selection, and the complete speak → translate → play loop.

**A/B** — assignment determinism, distribution, and independence between
experiments; the two-proportion z-test, confidence intervals, and sample-size
maths against known values; per-user conversion counting; and assertions that
each variant genuinely renders a different experience.

### Running experiments

Four are live: `mic_control` (hold vs tap), `onboarding` (guided vs instant),
`autoplay_tts` (which is also a cost experiment), and `result_layout`.

Assignment is a deterministic hash of `salt : experiment : user`, so a user
always lands in the same variant with nothing stored, and experiments are
independent of one another. Force a variant with `?ab_mic_control=tap`. Read
results at `GET /api/ab/report` — each metric comes back with conversion rates,
a p-value, a 95% confidence interval, a ship verdict, and the sample size the
observed effect would need.

---

## Configuration

See `.env.example`. Provider mode is per service: with only Google keys present,
translation and TTS go live while speech recognition stays on the offline
provider, so the app is demoable at every stage of credential setup.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | API + client with hot reload |
| `npm run build` | Type-check and build both |
| `npm start` | Run the built API |
| `npm run typecheck` | Strict TypeScript across both workspaces |
| `npm test` | Full suite |
