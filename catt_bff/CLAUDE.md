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

- **`src/index.ts`** — Fetch handler + `scheduled` handler (daily stop at 03:03 UTC). Routes `/device/*` to the `DeviceQueue` Durable Object. Auth check skips `/fulfillment`, `/oauth/*`, `/echo`.
- **`src/DeviceQueue.ts`** — Durable Object with SQLite (`state.storage.sql`). Two tables: `queue` (play queue) and `kv` (per-device state). Handles enqueue/advance/shuffle/alarm-based polling. `fetch()` dispatches on `parts[2]` (the action segment of `/device/box/<action>`).
- **`src/devices.ts`** — Single device (`"box"`), input aliases (`k`=Mini Kitchen, `o`=Mini Office, `b`=Mini Bedroom, `zbk`=Mini ZBK, `tv`=Google TV, `otv`=Office TV), channel list, and defaults.
- **`src/catt.ts`** — HTTP client for `catt_server`. Attaches `X-Catt-Secret` header.
- **`src/urlHelper.ts`** — Normalises YouTube URLs (short links, bare IDs, `/embed/`, `/v/`) and resolves bare shortcodes to `https://r.manojbaba.com/r/<key>`.
- **`src/googleHome.ts`** — Google Home C2C SYNC/QUERY/EXECUTE intent handlers.
- **`src/integrations.ts`** — Slack slash command + Telegram webhook handlers.
- **`src/cattHandler.ts`** — Handler for `POST /catt`: routes DO_COMMANDS (`play`, `stop`, `prev`, `next`) to the DO, everything else to the DO's `/catt` sub-route.
- **`src/oauth.ts`** — Google account-linking stub (returns a random 32-char token, 24 h expiry).

### Durable Object state

`kv` table keys: `now`, `prev`, `next`, `app`, `tts`, `device`, `channel`, `playlist`, `volume`. Defaults defined in `devices.ts`.

Alarm-based polling: after a cast, alarm fires after `CAST_SETTLE_MS` (10 s), then polls `getInfo` → falls back to `getStatus` on error to detect playback end and advance the queue.

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
