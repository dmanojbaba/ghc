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
        └── /device/<key>/*    → DeviceQueue Durable Object (one DO per device key)
```

### Key source files

- **`src/index.ts`** — Fetch handler + `scheduled` handler (daily state reset at 03:03 UTC: clears queue/alarm, resets `app` to default for every known device key — no catt_backend call). Routes `/device/*` to the per-device `DeviceQueue` Durable Object — the session device key is read from `CALLER_KV` and the request URL is rewritten to `/device/<deviceKey>/<action>` before forwarding. State responses for `/device/*/state` have `device: <deviceKey>` injected as the first field. The `/catt` route handles `command: "device"` directly (writes KV, returns state) without forwarding to `cattHandler`. `command: "queue"` is intercepted before `cattHandler`: resolves the target device from `body.device` (without updating caller KV), routes to that DO's `/enqueue` route with `{ value }` — appends to a named device's queue without interrupting playback or switching the session. If no `body.device` is given, uses the current session device. `command: "cast"` with an explicit `body.device` is **one-shot** — routes to the target device DO for this request only, does not update caller KV. Use `command: "device"` to permanently switch the session. Auth check skips `/fulfillment`, `/oauth/*`, `/echo`, `/slack` (Slack uses its own signing secret verification instead), and `/telegram` (Telegram uses its own secret token verification instead). `GET /devices` returns the device list as `[{ key, name }]` — requires `X-API-Key`. `GET /channels` returns the channel list as `[{ key, name, number }]` sorted by number — requires `X-API-Key`.
- **`src/DeviceQueue.ts`** — Durable Object with SQLite (`state.storage.sql`). One DO instance per physical device key (e.g. `"k"`, `"o"`, `"otv"`), identified by `idFromName(deviceKey)`. Three tables: `queue` (play queue), `kv` (per-device state), `history` (last 10 played URLs, excluding TTS/cast_site). Handles enqueue/advance/shuffle/alarm-based polling. `fetch()` dispatches on `parts[2]` (the action segment of `/device/<key>/<action>`); `parts[1]` is the device key and is used directly for all `castCommand` calls — there is no `device` kv field. `_deviceKey` is stored in kv once per request so `alarm()` can use it. Routes: `state`, `play`, `prev`, `next`, `stop`, `off`, `clear`, `cast`, `enqueue`, `site`, `shuffle`, `set`, `catt`, `rewind`, `ffwd`, `sleep`, `history`, `mute`, `unmute`, `jump`. `stop` → `stopDevice(deviceKey)` (stops device, resets session + sleep_at, deletes alarm, preserves queue/prev/channel/playlist/tts). `off` → `stopAndClearState(deviceKey)` (full wipe — used only by GH `OnOff off`). `state` and `history` responses include `Cache-Control: no-store`. Empty `value` in `/catt` calls `advance(deviceKey, true)` (plays next queued item or `DEFAULT_NEXT` without touching `prev`) instead of casting directly. If the value is a YouTube playlist URL (has a `list=` param) and `YOUTUBE_API_KEY` is set, the playlist is expanded via the YouTube API (up to 50 items), the first item is cast immediately, and the rest are queued — `playlist` kv is also updated so `mediaShuffle` can re-shuffle the same playlist. `/enqueue` accepts `{ value }` — appends to the queue (with YouTube playlist expansion if applicable); auto-starts if session is idle. This is the dedicated append-only route used by `command=queue` from all surfaces. `clearState()` resets `channel`, `playlist`, `session`, `sleep_at`, `tts` and clears the queue and alarm — `app`, `prev`, and `next` are not kv fields and are unaffected. `stopAndClearState()` additionally sends a stop command to catt_backend. The `reset` route calls `clearState()`, resets `app` to default, and clears history.
- **`src/devices.ts`** — Single device (`"box"`), input definitions (`k`=Mini Kitchen, `o`=Mini Office (default), `b`=Mini Bedroom, `zbk`=Mini ZBK, `tv`=Google TV, `otv`=Office TV), channel list, and defaults. `getDeviceList(deviceId)` returns `[{ key, name }]` using the first `name_synonym` of each input as the display name — used by `GET /devices`. `getChannelList(deviceId)` returns `[{ key, name, number }]` sorted by number, using the first name as the display name — used by `GET /channels`. `INPUT_TO_DEVICE` is derived from `availableInputs` — maps every key and `name_synonym` (lowercased) to the catt_backend device name, so short aliases (`k`, `o`), full names (`kitchen`, `office`), and any synonym added to `availableInputs` all resolve automatically. `orderedInputs: true` — inputs are ordered `k→o→b→zbk→tv→otv` (wrapping). `getAppKey(deviceId, input, fallback)` resolves an app key or synonym to the canonical key. `getDefaultPrev(inputKey)` returns `"pingmp3"` for audio-only (Mini) inputs and `"pingmp4"` for video-capable inputs — used as the `prev` fallback when no history exists. `getAdjacentInput(deviceId, currentKey, delta)` returns the input key ±delta positions away (wraps around). `getChannelListWithSynonyms(deviceId)` returns `[{ key, names[] }]` with all name synonyms per channel — used by `parseWithAI` to build the AI prompt so all channel names (e.g. "Radio Rahman", "Athavan Radio") resolve to their correct key.
- **`src/catt.ts`** — HTTP client for `catt_backend`. Attaches `X-Catt-Secret` header. All three functions (`castCommand`, `getStatus`, `getInfo`) set a 50s `AbortSignal.timeout` — just over the 45s backend timeout — to prevent indefinite hangs when the tunnel is down.
- **`src/urlHelper.ts`** — Normalises YouTube URLs (short links, bare IDs, `/embed/`, `/v/`) and resolves bare strings to `<REDIRECT_URL><encoded-key>`. `getParsedUrl(url, redirectBase, ...)` and `getPlaylistItems(apiKey, playlistId, redirectBase, maxResults=50)` both take `redirectBase` (from `env.REDIRECT_URL`) instead of hardcoding the redirect worker URL. Bare strings (non-URL, non-http) are `encodeURIComponent`-encoded before appending to `redirectBase` so multi-word search queries survive the redirect worker's `decodeURIComponent`. `extractYouTubePlaylistId(url)` returns the `list` param from YouTube URLs, or `null` if not a playlist URL. `getPlaylistItems` returns `{ first, firstTitle, rest }` where `rest` is `Array<{ url, title }>` — titles are truncated to 40 characters and stored in the queue table alongside each URL.
- **`src/googleHome.ts`** — Google Home C2C SYNC/QUERY/EXECUTE intent handlers. QUERY maps `session` kv (`"active"`/`"paused"`/`"idle"`) to `playbackState` (`"PLAYING"`/`"PAUSED"`/`"STOPPED"`), and falls back `currentApplication` to `DEFAULT_APP` when unset. `OnOff` on calls `/reset` (full state reset including device and app). `selectChannel` and `relativeChannel` route to the DO `/channel/<key>` and `/channel/up` or `/channel/down` respectively — consistent with Slack/Telegram channel switching (no history recorded). `mute` routes to the DO `/mute/<true|false>`. `mediaSeekRelative` routes to the DO `/ffwd/<seconds>` or `/rewind/<seconds>`. `NextInput`/`PreviousInput` use `getAdjacentInput` to cycle through ordered inputs. `appSelect` resolves `newApplication` or `newApplicationName` via `getAppKey`. `appInstall` and `appSearch` search YouTube via the redirect worker (`/r/<encoded-query>`) and cast immediately. `mediaSeekRelative` maps positive `relativePositionMs` to `ffwd` and negative to `rewind` on `catt_backend`. `mute` sends `volumemute` to `catt_backend` (`volumeCanMuteAndUnmute` is `false` so Google Home does not advertise it).
- **`src/integrations.ts`** — Slack slash command + Telegram webhook handlers. Slack requests are authenticated via HMAC-SHA256 signing secret (`SLACK_SIGNING_SECRET`) checked against `X-Slack-Signature` header — exempt from API key check. Telegram requests are validated via `X-Telegram-Bot-Api-Secret-Token` and an optional chat ID allowlist (`TELEGRAM_ALLOWED_CHAT_IDS` — comma-separated list of allowed chat IDs; if unset, all chats are accepted; unknown chats are silently ignored). All state replies (Slack and Telegram) truncate `queue` to the first 5 items with a `… N more` suffix to stay within chat message size limits. A shared `truncateStateQueue` helper handles this consistently across all state reply paths. Supported commands: `cast`, `queue`, `volume`, `mute`, `unmute`, `tts`, `speak`, `talk`, `play`, `stop`, `clear`, `reset`, `prev`, `next`, `rewind`, `ffwd`, `sleep`, `channel`, `device`, `playlist`, `state`, `history`, `help`, `start` (Telegram `/start` — sends the same help text as `help`). `playlist` replays the active playlist KV from the start (maps to DO `/shuffle`). If a YouTube playlist URL is passed as value, it sets a new playlist and starts playing (routes to DO `/catt` cast). Device tokens in commands (e.g. `cast k <url>`, `volume k 50`) are one-shot — they target that device for the current command only and do not update the session in `CALLER_KV`. `speak` and `talk` are aliases for `tts`. Token layout: `<command> [device] [value]`. Commands and device tokens are case-insensitive; Telegram commands may be prefixed with `/`. The `device` token is optional — if the second token is not a known `INPUT_TO_DEVICE` entry (short alias, full name, or synonym), it is folded into the value and the session device is used. `queue [device] <url>` appends to the named device's queue (or current session device if no device token) without switching the session or interrupting playback; auto-starts if the device is idle. `cast` with a value that matches a known channel key (e.g. `cast ping`) is automatically redirected to the `channel` route — prevents channel keys from being cast as search queries and polluting history. Otherwise `cast` routes through the DO `/catt` sub-route. `rewind`, `ffwd`, `sleep`, and `channel` route through the DO with the value appended to the URL path; the value falls back to the `device` token if no explicit value is given. `channel` accepts `up`, `down`, or a channel key/name. `volume` accepts a numeric level (`volume 50`) or `up`/`down` — routes directly to `catt_backend`, not through DO; uses the session device key as fallback when no device token is given. `state` returns the DO state JSON synchronously — for Slack it appears in the response body; for Telegram it calls `sendMessage` via `TELEGRAM_BOT_TOKEN` to send it back to the chat. `history` sends the DO history JSON as a pre-formatted message (Slack and Telegram truncate to 5 items with a `… N more` suffix; HTTP POST returns all rows). `clear` and `reset` return the resulting state synchronously. `device <key>` switches the session — writes the canonical input key to `CALLER_KV` and returns state from the new DO, identical to the bare alias shorthand. A bare device alias or full name (e.g. `k`, `otv`, `kitchen`) sent as the entire message does the same. **AI fallback (Telegram only)**: when the first token of a Telegram message is not a known command or device alias, `parseWithAI()` is called using the `CATT_AI` Workers AI binding (`@cf/meta/llama-3.1-8b-instruct-fast`). The AI receives a structured system prompt with the live device list, channel list (all synonyms and channel numbers via `getChannelListWithSynonyms` + `getChannelList` — e.g. `arr=Radio ARR|Radio Rahman|8`), and command list, and returns either a single `{ command, device?, value? }` object or an array of such objects for compound requests (e.g. "play radio lime for 30 minutes" → `[{command:"channel",value:"lime"},{command:"sleep",value:"30"}]`). If the AI returns `{"command":"unknown"}`, an empty valid array, malformed JSON, or throws, the user receives "Unknown command". On success, each command in the array is dispatched sequentially to the session DO. A combined confirmation message is sent back as `key: value` lines: `command: <dispatched>` and optional `value: <value>` for each command, followed by a single `device: <key>` (the session device key). Slack is unaffected — it retains strict token parsing only. Both dispatch paths in `handleTelegram` (known command and AI fallback) wrap `dispatchCommand` in a try/catch — if any command fails (e.g. `catt_backend` unreachable), the user receives "Backend error" instead of silence.
- **`src/cattHandler.ts`** — Handler for `POST /catt`. All commands are wrapped in a try/catch — errors return `500 { error: "..." }` to the caller (admin UI shows a `"Backend error"` toast). Routes `DO_COMMANDS` (`play`, `stop`, `clear`, `reset`, `prev`, `next`) directly to the DO; routes `playlist` to `/device/<key>/shuffle` when no value given (replays active playlist KV from start); if `value` is a YouTube playlist URL, routes to `/device/<key>/catt` with `command:"cast"` (sets playlist KV + plays); routes `volume` to `catt_backend` directly (`volumeup`/`volumedown` for `up`/`down`, numeric `volume` otherwise) — `body.device` overrides the session `deviceKey`; routes `DO_VALUE_COMMANDS` (`rewind`, `ffwd`, `sleep`) to the DO with the `value` field appended to the URL path; routes `app` to `set/app/:key`; routes `channel` to `channel/:key`; routes `state` to `GET /device/<key>/state`; routes `tts`, `speak`, `talk` to `site/:value` (same as Slack/Telegram); routes `jump` to `jump/:value` (skip to queue position); for `cast`, checks if the value is a known channel key or name (case-insensitive, via `getChannelKey`) and redirects to `channel/:key` — prevents channel names like `ping` from being cast as search queries and polluting history; routes everything else to the DO's `/catt` sub-route.
- **`src/oauth.ts`** — Google account-linking stub (returns random 32-char `access_token` and `refresh_token`, 1-year expiry).

### Durable Object state

`kv` table keys: `session`, `app`, `tts`, `channel`, `playlist`, `sleep_at`, `_deviceKey`. `prev` and `next` are no longer stored in kv — `prev` is derived from the latest history row (falls back to `getDefaultPrev(deviceKey)`: `pingmp3` for audio-only inputs, `pingmp4` for video inputs); `next` is derived from `queue` row 0 (falls back to `DEFAULT_NEXT`). `device` is not stored in kv — the DO identity (its `idFromName` key) determines which physical device to use; `_deviceKey` is stored so `alarm()` can call `castCommand` without a request URL. Defaults defined in `devices.ts`. Volume is not stored in kv and is not returned in `state`. `session` has three values: `"active"` (playing), `"paused"` (paused), `"idle"` (stopped/default).

`queue` table: `{ position, url, title, added_at }`. `GET /device/<key>/state` returns `queue` as `{ position, url, title }[]` ordered by position ASC, covering all pending items (including the next-to-play item). `position` is included for use by the `jump` route but not displayed in the UI. `title` is populated (truncated to 40 chars) when items come from a YouTube playlist expansion; otherwise null. `next` is also returned as a bare URL for backwards compatibility.

`history` table: `{ position, url, title, played_at }`. `title` is populated from the queue row title (playlist items), `firstTitle` from `getPlaylistItems` (shuffle/direct playlist cast), or the spoken text for TTS entries; otherwise null. `url` is `"tts"` for TTS entries — `playPrev()` checks `url === "tts"` and replays via `this.get("tts")`. Channel changes are not recorded in history. The `/device/<key>/history` route returns all columns including `title`. `/device/<key>/history/clear` deletes all history rows (used by the scheduled handler and `reset` route). The admin UI shows `title ?? url` as the link text for history items.

Alarm-based polling: after a cast, alarm fires after `CAST_SETTLE_MS` (30 s) to allow the device to settle. Then polls `getInfo` every `HEARTBEAT_MS` (60 s) to detect external stops, switching to `FAST_POLL_MS` (3 s) within the last `APPROACH_WINDOW_MS` (10 s) of the video. Falls back to `getStatus` on `getInfo` error. Live streams (no duration) do not poll — if a `sleep_at` is set the alarm is rescheduled to `sleep_at` so the timer still fires; otherwise the alarm is deleted. PAUSED sets `session` to `"paused"` and polls every `HEARTBEAT_MS` (60 s) — Chromecast drops paused sessions after ~5 min, which transitions to IDLE naturally. PLAYING/BUFFERING sets `session` back to `"active"`. On IDLE, advances the queue.

The DO has a single alarm slot shared between playback polling and the sleep timer. `sleep_at` is stored as a ms timestamp in `kv`. `alarm()` checks `sleep_at` first (before the session-idle guard) and calls `stopAndClearState()` if due — so it fires even when nothing is playing. The sleep route sets the alarm to `sleep_at` only when no sooner alarm is already scheduled — this preserves any in-flight settle alarm (e.g. when `channel` and `sleep` are dispatched together as a compound command) so the polling loop starts correctly and picks up `sleep_at` at the right tick.

When switching to an audio-only input (Mini devices), `app` is always reset to `"default"`.

### State reset comparison

| | `stop` | GH mediaStop | `clear` | GH Off (`/off`) | GH On | `reset` | Scheduled (03:03) |
|---|---|---|---|---|---|---|---|
| Notes | keeps queue | same as stop | keeps device+app+history | stop + clear | same as reset | same as GH On | reset (all DOs + all sessions) |
| Stops device | yes | yes | no | yes | no | no | no |
| Clears history | no | no | no | no | yes | yes | yes (all devices) |
| Clears queue | **no** | **no** | yes | yes | yes | yes | yes (all devices) |
| Deletes alarm | yes | yes | yes | yes | yes | yes | yes |
| Resets `session` | yes | yes | yes | yes | yes | yes | yes |
| Resets `channel` | **no** | **no** | yes | yes | yes | yes | yes |
| `prev` (history) | kept | cleared | kept | kept | kept | cleared | cleared (all) |
| `next` (queue[0]) | cleared | cleared | kept | kept | cleared | cleared | cleared (all) |
| Resets `playlist` | **no** | **no** | yes | yes | yes | yes | yes |
| Resets `sleep_at` | yes | yes | yes | yes | yes | yes | yes |
| Resets `tts` | **no** | **no** | yes | yes | yes | yes | yes |
| Resets `app` | no | no | no | no | yes | yes | yes (all devices) |
| Resets caller KV | no | no | no | no | yes → `DEFAULT_DEVICE` | yes → `DEFAULT_DEVICE` | yes → `DEFAULT_DEVICE` (all sessions) |

`stop` and `GH mediaStop` use the DO `/stop` route → `stopDevice(deviceKey)` (keeps queue).
`GH Off` uses the DO `/off` route → `stopAndClearState(deviceKey)` (stop + clear).
`GH On` and `reset` use the DO `/reset` route → `clearState()` + reset `app` + clear history.
`sleep_at` firing in `alarm()` → `stopAndClearState(deviceKey)` (full wipe).
Scheduled (03:03 UTC) calls `/reset` on every known device key, then resets all `CALLER_KV` entries to `DEFAULT_DEVICE` via `list()` — full nightly clean slate across all DOs and all caller sessions.
`device` is no longer a kv field — physical device is determined by the DO's own identity key, not stored state.

### Caller KV update behaviour by command

| Command | HTTP POST — updates KV? | Slack — updates KV? | Telegram — updates KV? |
|---|---|---|---|
| `cast <device> <value>` | no (one-shot) | no (one-shot) | no (one-shot) |
| `cast <value>` (no device) | no — uses session device | no — uses session device | no — uses session device |
| `queue [device] <value>` | **never** — targets device directly | **never** — targets device directly | **never** — targets device directly |
| `device <key>` | yes → new device | yes → new device | yes → new device |
| bare device alias (e.g. `k`) | n/a (not supported) | yes → new device | yes → new device |
| `reset` | yes → `DEFAULT_DEVICE` | yes → `DEFAULT_DEVICE` | yes → `DEFAULT_DEVICE` |
| `volume <device> <value>` | no (one-shot) | no (one-shot) | no (one-shot) |
| `volume <value>` (no device) | no — uses session device | no — uses session device | no — uses session device |
| everything else (`play`, `stop`, `channel`, `tts`, etc.) | no — uses session device | no — uses session device | no — uses session device |

### Auth

- All routes except `/fulfillment`, `/oauth/*`, `/echo`, `/slack`, `/telegram` require `X-API-Key` matching `CATT_API_KEY` secret.
- `/slack` is exempt from API key check — verified instead via HMAC-SHA256 Slack signing secret (`SLACK_SIGNING_SECRET`).
- `/telegram` is exempt from API key check — verified instead via `X-Telegram-Bot-Api-Secret-Token` and optional chat ID allowlist.
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
| `REDIRECT_URL` | Base URL of the redirect worker (e.g. `https://redirect.example.com`) — used by `urlHelper.ts`; `/r/` path is appended in code |
| `CATT_AI` | Workers AI binding (not a secret — declared in `wrangler.toml` under `[ai]`). Used by `parseWithAI()` for natural language Telegram commands. |

## Testing conventions

Tests use Vitest with `vi.stubGlobal("fetch", ...)` to mock outbound HTTP — no integration tests. Test files live in `src/tests/`:

| File | Covers |
|---|---|
| `urlHelper.test.ts` | URL normalisation, YouTube URL parsing, playlist item fetching, title truncation to 40 chars, null title when missing |
| `oauth.test.ts` | OAuth auth flow, token shape and uniqueness |
| `devices.test.ts` | `getDeviceList` shape, all expected keys present, correct display name, empty array for unknown deviceId; `getChannelList` shape, all expected keys present, sorted by number, correct display name, empty array for unknown deviceId; `getDefaultPrev` returns `pingmp3` for audio-only inputs (`k`, `o`, `b`, `zbk`) and `pingmp4` for video inputs (`tv`, `otv`) |
| `integrations.test.ts` | Slack signature verification, `ctx.waitUntil` immediate response, `state` synchronous reply, device token parsing, Telegram chat ID allowlist, case-insensitive commands and device tokens, Telegram `/`-prefixed commands, `clear` and `reset` routing, `channel` up/down/name routing, bare device alias shorthand, `device <key>` command (Slack + Telegram), Slack and Telegram state queue truncation, Slack and Telegram `history` command with truncation to 5 items, Telegram `/start` sends help text and does not call AI, `queue` without device routes to session DO; `queue` with device token routes to named device DO without updating KV (Slack + Telegram) |
| `cattHandler.test.ts` | `jump` routing to `/device/<key>/jump/:position`, `state` routing to `/device/<key>/state`, `tts`/`speak`/`talk` routing to `/site/:value`, `cast` channel redirect (key, case-insensitive name, URL passthrough, unknown value), `app` command routing, `playlist` (no value→shuffle, device token ignored; with value→/catt cast), `stop` routing to `/device/<key>/stop`, `history` routing to `/device/<key>/history`, `volume` (up/down/numeric) routing to catt_backend with active device from session key, error handling → `500 { error }` |
| (integrations.test.ts AI section) | AI called for unrecognised Telegram message, dispatches to session DO, confirmation message format (`command: <cmd>` / `value: <val>` / `device: <key>`), `unknown` command → "Unknown command", malformed JSON → graceful fallback, AI throws → graceful fallback, known command → AI not called, channel synonym and number in prompt (e.g. `arr=Radio ARR|Radio Rahman|8`), compound command array dispatched sequentially with combined confirmation, `dispatchCommand` throws → "Backend error" (AI path and known command path) |
| `index.test.ts` | API key enforcement (missing key, wrong key, correct key); public path exemptions (`/fulfillment`, `/echo`, `/telegram`); `command: "cast"` with explicit device is one-shot (no KV update); `command: "queue"` routes to named device DO `/enqueue` without updating KV, falls back to session device when no device given |
| `googleHome.test.ts` | `OnOff off` routes to `/off` (full wipe); `OnOff on` routes to `/reset`; `mediaStop` routes to `/stop` (preserve queue); `selectChannel` routes to `/channel/<key>`; `relativeChannel` routes to `/channel/up` or `/channel/down`; `mute`/`unmute` routes to `/mute/<true|false>` through DO; `mediaSeekRelative` routes to `/ffwd/` or `/rewind/` through DO; `mediaPrevious`/`returnChannel` routes to `/prev`; `mediaNext` routes to `/next` |
| `DeviceQueue.ts` (not unit-tested) | `alarm()` sleep/polling logic requires a real DO runtime — not covered by vitest. Key behaviours documented in CLAUDE.md: sleep alarm not overwriting a sooner settle alarm; live stream alarm rescheduled to `sleep_at` instead of deleted when sleep timer is pending. |
