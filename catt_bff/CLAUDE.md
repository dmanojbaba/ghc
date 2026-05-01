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

Cloudflare Worker (TypeScript) that acts as the BFF for controlling Chromecast devices. Sits between Google Home / Slack / Telegram and `catt_backend` (a Flask API running on LAN via Cloudflare Tunnel).

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

- **`src/index.ts`** — Fetch handler + `scheduled` handler (daily state reset at 03:03 UTC: clears queue/alarm, resets `app` and `device` to defaults — no catt_backend call). Routes `/device/*` to the `DeviceQueue` Durable Object. Auth check skips `/fulfillment`, `/oauth/*`, `/echo`, `/slack` (Slack uses its own signing secret verification instead).
- **`src/DeviceQueue.ts`** — Durable Object with SQLite (`state.storage.sql`). Three tables: `queue` (play queue), `kv` (per-device state), `history` (last 10 played URLs, excluding TTS/cast_site). Handles enqueue/advance/shuffle/alarm-based polling. `fetch()` dispatches on `parts[2]` (the action segment of `/device/box/<action>`). Routes: `state`, `play`, `prev`, `next`, `stop`, `clear`, `cast`, `site`, `shuffle`, `set`, `catt`, `rewind`, `ffwd`, `sleep`, `history`, `mute`, `unmute`. `state` and `history` responses include `Cache-Control: no-store`. In the `/catt` route, `device` kv is only updated when `getInputKey` resolves the passed device to a known key — invalid or missing device leaves kv unchanged and the existing kv device is used. Empty `value` calls `advance(true)` (plays next queued item or `DEFAULT_NEXT` without touching `prev`) instead of casting directly. `clearState()` resets `channel`, `next`, `prev`, `playlist`, `session`, `sleep_at`, `tts` and clears the queue and alarm — `device` and `app` are preserved. `stopAndClearState()` additionally sends a stop command to catt_backend. The `reset` route calls `clearState()` then also resets `device` and `app` to defaults.
- **`src/devices.ts`** — Single device (`"box"`), input definitions (`k`=Mini Kitchen, `o`=Mini Office (default), `b`=Mini Bedroom, `zbk`=Mini ZBK, `tv`=Google TV, `otv`=Office TV), channel list, and defaults. `INPUT_TO_DEVICE` is derived from `availableInputs` — maps every key and `name_synonym` (lowercased) to the catt_backend device name, so short aliases (`k`, `o`), full names (`kitchen`, `office`), and any synonym added to `availableInputs` all resolve automatically. `orderedInputs: true` — inputs are ordered `k→o→b→zbk→tv→otv` (wrapping). `getAppKey(deviceId, input, fallback)` resolves an app key or synonym to the canonical key. `getAdjacentInput(deviceId, currentKey, delta)` returns the input key ±delta positions away (wraps around).
- **`src/catt.ts`** — HTTP client for `catt_backend`. Attaches `X-Catt-Secret` header.
- **`src/urlHelper.ts`** — Normalises YouTube URLs (short links, bare IDs, `/embed/`, `/v/`) and resolves bare strings to `https://r.manojbaba.com/r/<encoded-key>`. Bare strings (non-URL, non-http) are `encodeURIComponent`-encoded before appending to `BASE_REDIRECT` so multi-word search queries survive the redirect worker's `decodeURIComponent`.
- **`src/googleHome.ts`** — Google Home C2C SYNC/QUERY/EXECUTE intent handlers. QUERY maps `session` kv (`"active"`/`"paused"`/`"idle"`) to `playbackState` (`"PLAYING"`/`"PAUSED"`/`"STOPPED"`), and falls back `currentApplication` to `DEFAULT_APP` when unset. `OnOff` on calls `/reset` (full state reset including device and app). `selectChannel` and `relativeChannel` call `/clear` before `/cast` to ensure immediate playback rather than queuing. `NextInput`/`PreviousInput` use `getAdjacentInput` to cycle through ordered inputs. `appSelect` resolves `newApplication` or `newApplicationName` via `getAppKey`. `appInstall` and `appSearch` search YouTube via the redirect worker (`/r/<encoded-query>`) and cast immediately. `mediaSeekRelative` maps positive `relativePositionMs` to `ffwd` and negative to `rewind` on `catt_backend`. `mute` sends `volumemute` to `catt_backend` (`volumeCanMuteAndUnmute` is `false` so Google Home does not advertise it).
- **`src/integrations.ts`** — Slack slash command + Telegram webhook handlers. Slack requests are authenticated via HMAC-SHA256 signing secret (`SLACK_SIGNING_SECRET`) checked against `X-Slack-Signature` header — exempt from API key check. Telegram requests are validated via `X-Telegram-Bot-Api-Secret-Token` and an optional chat ID allowlist (`TELEGRAM_ALLOWED_CHAT_IDS` — comma-separated list of allowed chat IDs; if unset, all chats are accepted; unknown chats are silently ignored). Supported commands: `cast`, `volume`, `mute`, `unmute`, `tts`, `play`, `stop`, `clear`, `reset`, `prev`, `next`, `rewind`, `ffwd`, `sleep`, `channel`, `device`, `state`, `help`. Token layout: `<command> [device] [value]`. Commands and device tokens are case-insensitive; Telegram commands may be prefixed with `/`. The `device` token is optional — if the second token is not a known `INPUT_TO_DEVICE` entry (short alias, full name, or synonym), it is folded into the value and the kv device is used. `cast` routes through the DO `/catt` sub-route (same as `POST /catt`) so device resolution and kv updates are consistent: valid device → saved to kv and used; invalid or missing device → kv device used unchanged. `rewind`, `ffwd`, `sleep`, and `channel` route through the DO with the value appended to the URL path; the value falls back to the `device` token if no explicit value is given (e.g. `rewind 60` puts `60` in the device slot, which is caught by the fallback). `channel` accepts `up`, `down`, or a channel key/name (e.g. `channel sun`, `channel up`). `volume` accepts a numeric level (`volume 50`) or `up`/`down` (`volume up`, `volume down`) — the latter maps to `volumeup`/`volumedown` on catt_backend. `state` returns the DO state JSON synchronously — for Slack it appears in the response body; for Telegram it calls `sendMessage` via `TELEGRAM_BOT_TOKEN` to send it back to the chat. `device`, `clear`, and `reset` return the resulting state synchronously — for Slack the state appears in the response body (no `waitUntil`); for Telegram it is sent via `sendMessage` after executing. A bare device alias or full name (e.g. `k`, `otv`, `kitchen`) sent as the entire message is treated as an implicit `device <key>` command — sets the kv device and returns state synchronously in both Slack and Telegram.
- **`src/cattHandler.ts`** — Handler for `POST /catt`: routes `DO_COMMANDS` (`play`, `stop`, `clear`, `reset`, `prev`, `next`) directly to the DO; routes `DO_VALUE_COMMANDS` (`rewind`, `ffwd`, `sleep`) to the DO with the `value` field appended to the URL path; routes everything else to the DO's `/catt` sub-route.
- **`src/oauth.ts`** — Google account-linking stub (returns random 32-char `access_token` and `refresh_token`, 1-year expiry).

### Durable Object state

`kv` table keys: `session`, `prev`, `next`, `app`, `tts`, `device`, `channel`, `playlist`, `sleep_at`. Defaults defined in `devices.ts`. Volume is not stored in kv and is not returned in `state`. `session` has three values: `"active"` (playing), `"paused"` (paused), `"idle"` (stopped/default).

`queue` table: `{ position, url, title, added_at }`. `GET /device/box/state` returns `queue` as `{ position, url }[]` covering all pending items (including the next-to-play item). `next` is also returned as a bare URL for backwards compatibility.

Alarm-based polling: after a cast, alarm fires after `CAST_SETTLE_MS` (30 s) to allow the device to settle. Then polls `getInfo` every `HEARTBEAT_MS` (60 s) to detect external stops, switching to `FAST_POLL_MS` (3 s) within the last `APPROACH_WINDOW_MS` (10 s) of the video. Falls back to `getStatus` on `getInfo` error. Live streams (no duration) cancel the alarm immediately — they never end naturally. PAUSED sets `session` to `"paused"` and polls every `HEARTBEAT_MS` (60 s) — Chromecast drops paused sessions after ~5 min, which transitions to IDLE naturally. PLAYING/BUFFERING sets `session` back to `"active"`. On IDLE, advances the queue.

The DO has a single alarm slot shared between playback polling and the sleep timer. `sleep_at` is stored as a ms timestamp in `kv`. `alarm()` checks `sleep_at` first (before the session-idle guard) and calls `stopAndClearState()` if due — so it fires even when nothing is playing. When session is idle and a sleep timer is set, the route sets the alarm directly to `sleep_at`.

When switching to an audio-only input (Mini devices), `app` is always reset to `"default"`.

### State reset comparison

| | `clear` | `reset` | `stop` | GH mediaStop | GH Off | GH On |
|---|---|---|---|---|---|---|
| Stops device | no | no | yes | yes | yes | no |
| Clears queue | yes | yes | yes | yes | yes | yes |
| Deletes alarm | yes | yes | yes | yes | yes | yes |
| Resets `session` | yes | yes | yes | yes | yes | yes |
| Resets `channel` | yes | yes | yes | yes | yes | yes |
| Resets `prev` | yes | yes | yes | yes | yes | yes |
| Resets `next` | yes | yes | yes | yes | yes | yes |
| Resets `playlist` | yes | yes | yes | yes | yes | yes |
| Resets `sleep_at` | yes | yes | yes | yes | yes | yes |
| Resets `tts` | yes | yes | yes | yes | yes | yes |
| Resets `device` | no | yes | no | no | no | yes |
| Resets `app` | no | yes | no | no | no | yes |

### Auth

- All routes except `/fulfillment`, `/oauth/*`, `/echo`, `/slack` require `X-API-Key` matching `CATT_API_KEY` secret.
- `/slack` is exempt from API key check — verified instead via HMAC-SHA256 Slack signing secret (`SLACK_SIGNING_SECRET`).
- Outbound requests to `catt_backend` include `X-Catt-Secret` from `CATT_BACKEND_SECRET` secret.

## Secrets (set via `wrangler secret put`)

| Secret | Purpose |
|---|---|
| `CATT_API_KEY` | Inbound auth for all non-Google routes |
| `CATT_BACKEND_SECRET` | Passed to catt_backend as `X-Catt-Secret` |
| `CATT_BACKEND_URL` | Cloudflare Tunnel URL for catt_backend |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Comma-separated list of allowed Telegram chat IDs; if unset all chats are accepted |
| `TELEGRAM_BOT_TOKEN` | Bot token for sending replies via Telegram `sendMessage` API |
| `TELEGRAM_SECRET_TOKEN` | Validates Telegram webhook requests |
| `SLACK_SIGNING_SECRET` | Validates Slack slash command requests (HMAC-SHA256) |
| `YOUTUBE_API_KEY` | YouTube Data API v3 (playlist shuffle) |

## Testing conventions

Tests use Vitest with `vi.stubGlobal("fetch", ...)` to mock outbound HTTP — no integration tests. Test files live in `src/tests/`:

| File | Covers |
|---|---|
| `urlHelper.test.ts` | URL normalisation, YouTube URL parsing, playlist item fetching |
| `oauth.test.ts` | OAuth auth flow, token shape and uniqueness |
| `integrations.test.ts` | Slack signature verification, `ctx.waitUntil` immediate response, `state` synchronous reply, device token parsing, Telegram chat ID allowlist, case-insensitive commands and device tokens, Telegram `/`-prefixed commands, `clear` and `reset` routing, `channel` up/down/name routing, bare device alias shorthand |
