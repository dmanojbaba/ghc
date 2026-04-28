# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm test             # vitest run (once)
npm run test:watch   # vitest watch
npm run dev          # wrangler dev (local)
npm run deploy       # wrangler deploy
npm run cf-typegen   # regenerate worker-configuration.d.ts from wrangler.toml bindings
npx tsc --noEmit     # type-check without emitting
```

Run a single test file:
```bash
npx vitest run src/tests/urlHelper.test.ts
```

## Architecture

Cloudflare Worker (TypeScript) that acts as the BFF for controlling Chromecast devices. Sits between Google Home / Slack / Telegram and `catt_server` (a Flask API running on LAN via Cloudflare Tunnel).

### Request flow

```
Google Home / Slack / Telegram / curl
        │
        ▼
   src/index.ts  ← auth (X-API-Key), routing
        │
        ├── /fulfillment       → googleHome.ts
        ├── /catt              → cattHandler.ts → DeviceQueue DO or catt.ts
        ├── /slack, /telegram  → integrations.ts
        ├── /echo              → TTS HTML page
        └── /device/box/*      → DeviceQueue Durable Object
```

### Key source files

- **`src/index.ts`** — Fetch handler + `scheduled` handler (daily state reset at 03:03 UTC: clears queue/alarm, resets `app` and `device` to defaults — no catt_server call). Routes `/device/*` to the `DeviceQueue` Durable Object. Auth check skips `/fulfillment`, `/oauth/*`, `/echo`.
- **`src/DeviceQueue.ts`** — Durable Object with SQLite (`state.storage.sql`). Three tables: `queue` (play queue), `kv` (per-device state), `history` (last 10 played URLs, excluding TTS/cast_site). Handles enqueue/advance/shuffle/alarm-based polling. `fetch()` dispatches on `parts[2]` (the action segment of `/device/box/<action>`). Routes: `state`, `play`, `prev`, `next`, `stop`, `clear`, `cast`, `site`, `shuffle`, `set`, `catt`, `rewind`, `ffwd`, `sleep`, `history`. `state` and `history` responses include `Cache-Control: no-store`.
- **`src/devices.ts`** — Single device (`"box"`), input aliases (`k`=Mini Kitchen, `o`=Mini Office, `b`=Mini Bedroom, `zbk`=Mini ZBK, `tv`=Google TV, `otv`=Office TV), channel list, and defaults.
- **`src/catt.ts`** — HTTP client for `catt_server`. Attaches `X-Catt-Secret` header.
- **`src/urlHelper.ts`** — Normalises YouTube URLs (short links, bare IDs, `/embed/`, `/v/`) and resolves bare shortcodes to `https://r.manojbaba.com/r/<key>`.
- **`src/googleHome.ts`** — Google Home C2C SYNC/QUERY/EXECUTE intent handlers. `selectChannel` and `relativeChannel` call `/clear` before `/cast` to ensure immediate playback rather than queuing. `mediaSeekRelative` maps positive `relativePositionMs` to `ffwd` and negative to `rewind` on `catt_server`.
- **`src/integrations.ts`** — Slack slash command + Telegram webhook handlers. Supported commands: `cast`, `volume`, `tts`, `play`, `stop`, `prev`, `next`, `rewind`, `ffwd`, `sleep`. `rewind`, `ffwd`, and `sleep` route through the DO with the value appended to the URL path. For all three, the value falls back to the `device` token if no explicit value is given (e.g. `rewind 60` puts `60` in the device slot, which is caught by the fallback).
- **`src/cattHandler.ts`** — Handler for `POST /catt`: routes `DO_COMMANDS` (`play`, `stop`, `prev`, `next`) directly to the DO; routes `DO_VALUE_COMMANDS` (`rewind`, `ffwd`, `sleep`) to the DO with the `value` field appended to the URL path; routes everything else to the DO's `/catt` sub-route.
- **`src/oauth.ts`** — Google account-linking stub (returns a random 32-char token, 24 h expiry).

### Durable Object state

`kv` table keys: `session`, `prev`, `next`, `app`, `tts`, `device`, `channel`, `playlist`, `sleep_at`. Defaults defined in `devices.ts`. Volume is not stored in kv — `state` and Google Home QUERY always return `DEFAULT_VOLUME` (50).

`queue` table: `{ position, url, title, added_at }`. `GET /device/box/state` returns `queue` as `{ position, url }[]` covering all pending items (including the next-to-play item). `next` is also returned as a bare URL for backwards compatibility.

Alarm-based polling: after a cast, alarm fires after `CAST_SETTLE_MS` (30 s) to allow the device to settle. Then polls `getInfo` every `HEARTBEAT_MS` (60 s) to detect external stops, switching to `FAST_POLL_MS` (3 s) within the last `APPROACH_WINDOW_MS` (10 s) of the video. Falls back to `getStatus` on `getInfo` error. Live streams (no duration) cancel the alarm immediately — they never end naturally. PAUSED polls every `HEARTBEAT_MS` (60 s) — Chromecast drops paused sessions after ~5 min, which transitions to IDLE naturally. On IDLE, advances the queue.

The DO has a single alarm slot shared between playback polling and the sleep timer. `sleep_at` is stored as a ms timestamp in `kv`. `alarm()` checks `sleep_at` first (before the session-idle guard) and calls `clear()` if due — so it fires even when nothing is playing. When session is idle and a sleep timer is set, the route sets the alarm directly to `sleep_at`.

When switching to an audio-only input (Mini devices), `app` is always reset to `"default"`.

### Auth

- All routes except `/fulfillment`, `/oauth/*`, `/echo` require `X-API-Key` matching `CATT_API_KEY` secret.
- Outbound requests to `catt_server` include `X-Catt-Secret` from `CATT_SERVER_SECRET` secret.

## Secrets (set via `wrangler secret put`)

| Secret | Purpose |
|---|---|
| `CATT_API_KEY` | Inbound auth for all non-Google routes |
| `CATT_SERVER_SECRET` | Passed to catt_server as `X-Catt-Secret` |
| `CATT_SERVER_URL` | Cloudflare Tunnel URL for catt_server |
| `TELEGRAM_SECRET_TOKEN` | Validates Telegram webhook requests |
| `YOUTUBE_API_KEY` | YouTube Data API v3 (playlist shuffle) |

## Testing conventions

Tests use Vitest with `vi.stubGlobal("fetch", ...)` to mock outbound HTTP — no integration tests. Test files live in `src/tests/`.
