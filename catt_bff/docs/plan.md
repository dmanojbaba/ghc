# Plan: catt_bff — Cloudflare Workers BFF

## Context

`catt_backend` is a LAN-only Flask REST API for controlling Chromecast devices. This BFF runs on Cloudflare Workers and adds:

- **Per-device play queues** — SQLite-backed queue in a Durable Object
- **Automatic queue advancement** — DO Alarms use smart scheduling via `getInfo` to advance the queue when playback ends
- **Google Home Cloud-to-Cloud** — exposes devices as `action.devices.types.TV` controllable via Google Assistant
- **YouTube URL normalisation** — handles youtu.be, youtube.com/watch, embed, playlist URLs
- **YouTube playlist shuffle** — fetches playlist items and queues them for sequential playback
- **TTS** — renders text as an HTML page served via `cast_site` on TV devices, or calls `tts` command on others
- **Slack & Telegram integration** — webhook endpoints that translate slash commands into `catt_backend` calls
- **Ad-hoc POST endpoint** — `POST /catt` for curl usage; supports `cast`, `site`, `play`, `stop`, `prev`, `next` commands with optional device override

Based on a working single-device prototype (`old_bff.py`) which used Cloudflare KV for state. The key architectural change is replacing KV with a **single Durable Object** (SQLite-backed) to support an ordered queue and DO Alarms for automatic advancement.

`catt_backend` is exposed via **Cloudflare Tunnel** (`cloudflared`), keeping it LAN-only. Deployed at `<your-worker-domain>`.

---

## Architecture

```
Google Home App / Google Assistant
   │  SYNC / QUERY / EXECUTE intents
   ▼
Cloudflare Worker (catt_bff)  — <your-worker-domain>
   │
   ├── POST /fulfillment        → googleHome.ts (intents)
   ├── GET/POST /oauth/auth     → oauth.ts (stub)
   ├── POST /oauth/token        → oauth.ts (stub)
   ├── GET/POST /echo           → TTS HTML renderer (for cast_site)
   ├── /device/:name/*          → DeviceQueue DO
   │     ├── SQLite: queue + kv tables
   │     └── Alarm: polls catt_backend + advances queue
   ├── POST /slack              → integrations.ts
   ├── POST /telegram           → integrations.ts
   └── POST /catt               → cattHandler.ts (ad-hoc POST endpoint)
```

---

## Project Structure

```
catt_bff/
├── src/
│   ├── index.ts              # Worker entrypoint — routing + cron handler
│   ├── DeviceQueue.ts        # Durable Object — queue, state, alarm
│   ├── catt.ts               # catt_backend HTTP client
│   ├── googleHome.ts         # SYNC / QUERY / EXECUTE handlers
│   ├── integrations.ts       # Slack & Telegram webhook handlers
│   ├── cattHandler.ts        # Ad-hoc POST endpoint handler
│   ├── oauth.ts              # OAuth 2.0 stub (single user, random tokens)
│   ├── urlHelper.ts          # YouTube URL normalisation + playlist fetcher
│   ├── devices.ts            # Device definitions, input map, helpers
│   └── tests/
│       ├── urlHelper.test.ts
│       └── oauth.test.ts
├── docs/
│   └── plan.md
├── .gitignore
├── worker-configuration.d.ts # Env interface
├── wrangler.toml
├── package.json
└── tsconfig.json
```

---

## Devices (`devices.ts`)

Single logical device (`id: "box"`) representing all Chromecasts. Inputs map to physical devices:

| Input key | catt_backend device name |
|---|---|
| `k`   | Mini Kitchen  |
| `o`   | Mini Office   |
| `b`   | Mini Bedroom  |
| `zbk` | Mini ZBK      |
| `tv`  | Google TV     |
| `otv` | Office TV     |

Default input on power-on: `otv`. Default playlist: `""` (unset).

Channels: `ping` (1), `sun` / Sun News (2), `pttv` / Tamil News (3), `london` (4), `dubai` (5), `chennai` (6), `raja` (7), `lime` (8), `arr` (9).

Default channel on power-on: `ping` (1).

`INPUT_TO_DEVICE` maps input key → full catt_backend device name string.

Helper functions:
- `getAppKey(deviceId, input, fallback)` — resolves app key or synonym → canonical key; fallback is non-nullable
- `getInputKey(deviceId, input, fallback)` — resolves alias or display name → key
- `getAdjacentInput(deviceId, currentKey, delta)` — returns the input key ±delta positions away (wraps around); used by `NextInput`/`PreviousInput`
- `getChannelCode(deviceId, channelNumber)` — resolves channel number → key
- `getAdjacentChannel(deviceId, currentKey, delta)` — returns the channel key ±delta positions away (wraps around); used by `relativeChannel`
- `resolveDevice(input)` — maps input key → catt_backend device name
- `isAudioOnlyInput(deviceId, inputKey)` — returns `true` if any `name_synonym` for the input starts with `"mini"`; used to auto-reset `app` to `default` when switching to audio-only devices

---

## Durable Object: `DeviceQueue`

One instance, keyed by `"box"`. Created lazily on first request.

### SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS queue (
  position  INTEGER PRIMARY KEY AUTOINCREMENT,
  url       TEXT NOT NULL,
  title     TEXT,
  added_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  position  INTEGER PRIMARY KEY AUTOINCREMENT,
  url       TEXT NOT NULL,
  played_at TEXT NOT NULL
);
```

The `kv` table replaces Cloudflare KV from the prototype. The `history` table stores the last 10 played URLs (excluding TTS and cast_site), trimmed automatically after each insert.

### State keys

| Key | Default | Description |
|---|---|---|
| `session` | `idle` | `active` (playing), `paused` (paused), or `idle` (stopped/default) |
| `prev` | `pingr2` | Last played URL (for repeat) |
| `next` | `ping` | Not read from kv — `getState()` derives next from the queue table directly; kv value is a legacy default only |
| `app` | `default` | `default` or `youtube` — controls `force_default` |
| `tts` | `Hello World!` | Last TTS text |
| `device` | `otv` | Active input key |
| `channel` | `ping` | Last selected channel key; used by `relativeChannel` to compute adjacent channel |
| `playlist` | `""` | YouTube playlist ID used by `mediaShuffle`; set via `/box/set/playlist/:id` |
| `sleep_at` | `DEFAULT_SLEEP_AT` (`""`) | Unix ms timestamp for sleep timer; empty when unset. Checked in `alarm()` before session guard — fires `clear()` when due even if session is idle. |

Volume is not stored in kv and is not returned in `getState()`. `setVolume` via Google Home sends the command to catt_backend but does not write to kv. Google Home QUERY returns `DEFAULT_VOLUME` (10) as a static placeholder — matches `volumeMaxLevel: 10`.

### State Machine

```
IDLE ──(enqueue when idle)──► ACTIVE
  ▲                                │
  └──(queue empty after advance)───┤
                                   │
                       cast starts → alarm in 30s (settle)
                                   │
                       alarm fires → getInfo (player_state + duration)
                                   │
                   IDLE/UNKNOWN → advance()
                   PLAYING, duration known:
                       remaining > 10s → reschedule at min(remaining - 10s, 60s)
                       remaining ≤ 10s → fast poll every 3s
                   PLAYING, duration unknown (live stream) → cancel alarm
                   PAUSED → set session=paused, poll every 60s (Chromecast drops session after ~5 min → IDLE)
                   getInfo fails → getStatus fallback → poll every 10s
```

### Alarm timing constants

| Constant | Value | Purpose |
|---|---|---|
| `CAST_SETTLE_MS` | 30s | Initial delay after cast to allow Chromecast to buffer and report duration |
| `HEARTBEAT_MS` | 60s | Max poll interval between alarm checks; caps the gap so external stops are detected within 60s |
| `APPROACH_WINDOW_MS` | 10s | How far before end to switch to fast polling |
| `FAST_POLL_MS` | 3s | Poll interval near end of media |
| `POLL_INTERVAL_MS` | 10s | Fallback poll interval when `getInfo` fails |

### Methods

| Method | Behaviour |
|---|---|
| `enqueue(url, title?)` | Add to queue; if `session == idle`, call `advance()` immediately |
| `advance(userInitiated?)` | Pop next from queue; if empty + `userInitiated=true` → cast `DEFAULT_NEXT` (ping), set `session=idle`, cancel alarm; if empty + not user-initiated → set `session=idle`, cancel alarm, nothing cast; else cast item URL, set `session=active`, set alarm in 30s (settle) |
| `clear()` | Stop catt_backend, cancel alarm, clear queue, reset `session`, `prev`, `next`, `tts`, `channel`, `sleep_at` to defaults (preserves `app`, `device`, `playlist`) |
| `shuffle(playlistId)` | Clear queue, fetch playlist via YouTube API, cast first item (no prior stop — cast preempts current playback), load rest into queue, set alarm in 30s (settle) |
| `playPrev()` | If `prev=="tts"` → replay last TTS text via `tts` command, no alarm; if `prev==DEFAULT_PREV` → cast pingr2, no alarm; else cast `prev` URL via `getParsedUrl`, set `session=active`, schedule alarm |
| `alarm()` | Call `getInfo` for player state + duration in one request; if IDLE/UNKNOWN → `advance()`; if PLAYING/BUFFERING → set `session=active`, smart schedule; if playing without duration (live stream) → cancel alarm; if PAUSED → set `session=paused`, poll every 60s; if `getInfo` fails → `getStatus` fallback |
| `getState()` | Return current state dict (alarm, session, device, channel, app, prev, next, playlist, tts, sleep_at, queue array) — `alarm` and `sleep_at` are ISO timestamps or `null`. `queue` is `{ position, url }[]` covering all pending items including next-to-play. |

### HTTP routes (handled inside DO `fetch`)

All paths use the `/device/box/` prefix — both from external HTTP requests forwarded by the Worker and from internal DO stub calls.

| Method | Path | Action |
|---|---|---|
| `GET` | `/device/box/state` | Return `getState()` as pretty-printed JSON (`Cache-Control: no-store`). Includes `queue` as `{ position, url }[]`, `sleep_at` as ISO string or null. |
| `GET` | `/device/box/history` | Return last 10 played URLs as `{ position, url, played_at }[]` newest-first (`Cache-Control: no-store`). Excludes TTS and cast_site. |
| `GET` | `/device/box/play` | `play_toggle` on catt_backend |
| `GET` | `/device/box/prev` | `playPrev()` |
| `GET` | `/device/box/next` | `advance()` |
| `GET` | `/device/box/stop` | Stop catt_backend + clear queue + cancel alarm + reset `session`, `prev`, `next`, `tts`, `channel`, `sleep_at` |
| `GET` | `/device/box/clear` | Clear queue + cancel alarm + reset `session`, `prev`, `next`, `tts`, `channel`, `sleep_at` — no catt_backend call |
| `GET/POST` | `/device/box/cast/:url` | GET: `enqueue(url)`; POST: `enqueue(body.url, body.title)` |
| `GET/POST` | `/device/box/site/:arg` | Stop + clear queue + cancel alarm + set `session=idle`; cast_site URL if http, else TTS (HTML on TV via `/echo?text=`, `tts` command on others) |
| `GET` | `/device/box/shuffle` | `shuffle(playlist)` using saved `playlist` state key |
| `GET` | `/device/box/mute/:bool` | `volumemute` on catt_backend; `true` = mute (default), `false` = unmute |
| `GET` | `/device/box/unmute` | `volumemute false` on catt_backend; alias for `mute/false` |
| `GET` | `/device/box/rewind/:seconds` | Rewind N seconds on catt_backend (default 30) |
| `GET` | `/device/box/ffwd/:seconds` | Fast-forward N seconds on catt_backend (default 30) |
| `GET` | `/device/box/sleep/:minutes` | Set sleep timer; if session idle, sets alarm directly to `sleep_at` |
| `GET` | `/device/box/sleep/cancel` | Clear `sleep_at` kv key |
| `GET` | `/device/box/set/:key/:value` | Set a kv state key; setting `device` to an audio-only input auto-resets `app` to `default` |

### `/clear` vs `/stop` vs `OnOff`

| | `/clear` | `/stop` | `OnOff` on | `OnOff` off |
|---|---|---|---|---|
| Calls catt_backend `stop` | No | Yes | No | Yes |
| Clears queue | Yes | Yes | Yes | Yes |
| Cancels alarm | Yes | Yes | Yes | Yes |
| Resets `session` | Yes | Yes | Yes | Yes |
| Resets `prev` | Yes | Yes | Yes | Yes |
| Resets `next` | Yes | Yes | Yes | Yes |
| Resets `tts` | Yes | Yes | Yes | Yes |
| Resets `channel` | Yes | Yes | Yes | Yes |
| Resets `sleep_at` | Yes | Yes | Yes | Yes |
| Resets `app` | No | No | Sets `youtube` | No |
| Resets `device` | No | No | Sets `otv` | No |
| Resets `playlist` | No | No | No | No |

---

## `urlHelper.ts`

```typescript
getParsedUrl(url: string, ytVideoId = false, ytPlaylist = false): string
getPlaylistItems(apiKey: string, playlistId: string, maxResults = 10): Promise<{ first: string; rest: string[] }>
```

Resolution order for `getParsedUrl`:
1. `ytVideoId=true` → prepend `BASE_YOUTUBE` (checked first, before URL parsing)
2. Already `redirect.example.com` → return as-is
3. `youtu.be/<id>` → full YouTube URL
4. `youtube.com/watch`, `/embed/`, `/v/` → extract video ID
5. `youtube.com` + `ytPlaylist=true` → extract `list` param
6. Starts with `http` → return as-is
7. Bare string → `encodeURIComponent` + prepend `BASE_REDIRECT` (`https://redirect.example.com/r/<encoded>`) — encoding required so multi-word queries survive the redirect worker's `decodeURIComponent`

`getPlaylistItems` calls YouTube Data API v3, returns `{ first, rest }` where `first` is the first video URL and `rest` is an array of remaining URLs.

---

## `catt.ts`

```typescript
castCommand(serverUrl, device, command, value?, extra?, secret?): Promise<CattResponse>
getStatus(serverUrl, device, secret?): Promise<CattStatusResponse>
getInfo(serverUrl, device, secret?): Promise<CattInfoResponse>
```

Posts to `POST /catt` on catt_backend. `force_default` is passed as `extra` when needed by callers. `secret` is sent as `X-Catt-Secret` header when provided. `getInfo` returns `player_state`, `duration`, and `current_time` in one call — used by `alarm()` for smart scheduling. `getStatus` is used as a fallback when `getInfo` fails.

---

## `oauth.ts`

Satisfies Google account linking with no real auth. Returns a random 32-char token on every `/oauth/token` call.

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/oauth/auth` | Show "Link this service to Google" button; on submit redirect back with code + state |
| `POST` | `/oauth/auth` | Read `responseurl` from form body, redirect to it |
| `POST` | `/oauth/token` | Return random `access_token`, random `refresh_token`, `expires_in: 31536000` (1 year) |

---

## `googleHome.ts`

Single endpoint `POST /fulfillment`.

### SYNC
Returns `DEVICES` from `devices.ts`.

### QUERY
Calls DO `getState()`, maps to Google state shape. Returns `currentToggleSettings: { youtube_app: bool }` derived from `app` kv key (`youtube` → `true`, `default` → `false`). Returns `currentApplication` with fallback to `DEFAULT_APP` when unset. Maps `session` to `playbackState`: `active` → `PLAYING`, `paused` → `PAUSED`, `idle` → `STOPPED`.

### EXECUTE — Command Mapping

| Google Command | Action |
|---|---|
| `OnOff` (on) | Call `/box/clear` (clears queue + alarm, no catt_backend call), then set `app=youtube`, `device=otv` |
| `OnOff` (off) | Call `/box/stop` (stops catt_backend + clears queue + alarm); `app` and `device` left unchanged |
| `SetToggles` | `youtube_app` toggle: `true` → `app=youtube`, `false` → `app=default` in DO |
| `SetInput` | Update `device` state in DO |
| `NextInput` / `PreviousInput` | Cycle to adjacent input via `getAdjacentInput` (±1, wraps around); update `device` state in DO |
| `selectChannel` | Call `/clear` (reset queue/alarm, no catt_backend call), store channel key via `/set/channel/:key`, then cast immediately via `/cast/:url` — URL resolved via `getParsedUrl` |
| `relativeChannel` | Read `channel` from DO state, compute adjacent channel via `getAdjacentChannel` (wraps around), call `/clear`, store via `/set/channel/:key`, then cast immediately via `/cast/:url` |
| `returnChannel` | `playPrev()` |
| `mediaShuffle` | `shuffle()` using saved `playlist` state key |
| `mediaPrevious` | `playPrev()` |
| `mediaNext` | `advance()` |
| `mediaResume` / `mediaPause` | `play_toggle` on catt_backend |
| `mediaStop` | `clear()` |
| `appSelect` | Resolve `newApplication` or `newApplicationName` via `getAppKey`; update `app` state in DO |
| `appInstall` / `appSearch` | Search YouTube via redirect worker (`/r/<encoded-query>`) using `newApplicationName ?? newApplication`; call `/clear` then cast immediately |
| `mediaSeekRelative` | Positive `relativePositionMs` → `ffwd`; negative → `rewind` on catt_backend (converted ms → seconds) |
| `setVolume` | `volume` on catt_backend (Google 0–10 × 10 → catt 0–100); not written to kv |
| `volumeRelative` | `volumeup` or `volumedown` on catt_backend (steps × 10%); no stored volume needed |
| `mute` | `volumemute` on catt_backend with boolean `mute` param; `volumeCanMuteAndUnmute` is `false` so Google Home does not advertise this capability |

### DISCONNECT
Returns `{}`.

---

## `integrations.ts`

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/slack` | Parse `text` form field → `<command> <device> <url_or_value>`, dispatch to DO or catt_backend |
| `POST` | `/telegram` | Parse `message.text` → `<command> <device> <url_or_value>`, verify secret header, dispatch |

### Command syntax

```
<command> <device> <url_or_value>
```

| Command | Routes via | Notes |
|---|---|---|
| `cast` | catt_backend directly | URL resolved via `getParsedUrl` |
| `volume` | catt_backend directly | Value is int 0–100 |
| `mute` | DeviceQueue DO (`/box/mute/:bool`) | No value = mute; `false` = unmute; uses stored `device` key |
| `unmute` | DeviceQueue DO (`/box/unmute`) | Alias for `mute false`; uses stored `device` key |
| `play` | DeviceQueue DO (`/box/play`) | Uses stored `device` key; `device` arg ignored |
| `stop` | DeviceQueue DO (`/box/stop`) | Uses stored `device` key; `device` arg ignored |
| `prev` | DeviceQueue DO (`/box/prev`) | Uses stored `device` key; `device` arg ignored |
| `next` | DeviceQueue DO (`/box/next`) | Uses stored `device` key; `device` arg ignored |
| `tts` | DeviceQueue DO (`/box/site/:text`) | All remaining tokens joined as text; uses stored `device` key |
| `rewind` | DeviceQueue DO (`/box/rewind/:seconds`) | Value is seconds (default 30); falls back to `device` token if no explicit value given; uses stored `device` key |
| `ffwd` | DeviceQueue DO (`/box/ffwd/:seconds`) | Value is seconds (default 30); falls back to `device` token if no explicit value given; uses stored `device` key |
| `sleep` | DeviceQueue DO (`/box/sleep/:arg`) | Value is minutes or `cancel`; `device` arg ignored |

- Slack: no auth (personal workspace); returns plain text response matching the command name
- Telegram: `X-Telegram-Bot-Api-Secret-Token` header validated against `TELEGRAM_SECRET_TOKEN` secret; skipped if secret unset; always returns `{}`

---

## `cattHandler.ts` — Ad-hoc POST Endpoint

Single endpoint for ad-hoc curl usage.

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/catt` | Dispatch command to the DeviceQueue DO |

### Request body

```json
{"command": "cast|site|play|stop|prev|next", "value": "...", "device": "o"}
```

`device` is optional — if provided, resolves via `getInputKey`, updates stored device, auto-resets `app` to `default` if audio-only. Ignored for `play`, `stop`, `prev`, `next`.

### Commands

| `command` | `device` | `value` | Behaviour |
|---|---|---|---|
| `cast` | input key or name | URL or redirect key | Clear queue + cancel alarm, cast immediately, update `prev`, record history, schedule alarm |
| `cast` | `queue` | URL or redirect key | Enqueue via `getParsedUrl`; plays immediately if idle, appends otherwise |
| `site` | input key, name, or omit | URL → `cast_site`; plain text → TTS (HTML on TV, spoken on audio device) | Stop + clear queue + cancel alarm |
| `play` | — | — | Toggle play/pause on catt_backend |
| `stop` | — | — | Stop catt_backend + clear queue + cancel alarm + reset `sleep_at` |
| `prev` | — | — | Play previous |
| `next` | — | — | Advance queue; casts ping if queue empty |
| `mute` | — | omit or `true` = mute, `false` = unmute | `volumemute` on catt_backend |
| `unmute` | — | — | `volumemute false` on catt_backend; alias for `mute` with `value=false` |
| `rewind` | — | seconds (default 30) | Rewind on catt_backend |
| `ffwd` | — | seconds (default 30) | Fast-forward on catt_backend |
| `sleep` | — | minutes or `cancel` | Set or cancel sleep timer |

`device` accepts aliases (`k`, `o`, `otv`) or full names (`Mini Kitchen`, `Office TV`). `"queue"` is a special value for `cast` that enqueues instead of casting immediately.

### Examples

```bash
# Cast immediately
curl -X POST https://<worker>/catt \
  -H 'Content-Type: application/json' \
  -d '{"command": "cast", "device": "o", "value": "https://youtube.com/watch?v=..."}'

# Add to queue
curl -X POST https://<worker>/catt \
  -H 'Content-Type: application/json' \
  -d '{"command": "cast", "device": "queue", "value": "https://youtube.com/watch?v=..."}'

# TTS on TV
curl -X POST https://<worker>/catt \
  -H 'Content-Type: application/json' \
  -d '{"command": "site", "device": "tv", "value": "Hello World"}'

# Cast site on TV
curl -X POST https://<worker>/catt \
  -H 'Content-Type: application/json' \
  -d '{"command": "site", "device": "tv", "value": "https://example.com"}'

# Playback controls
curl -X POST https://<worker>/catt -H 'Content-Type: application/json' -d '{"command": "play"}'
curl -X POST https://<worker>/catt -H 'Content-Type: application/json' -d '{"command": "stop"}'
curl -X POST https://<worker>/catt -H 'Content-Type: application/json' -d '{"command": "prev"}'
curl -X POST https://<worker>/catt -H 'Content-Type: application/json' -d '{"command": "next"}'
```

---

## `/echo` — TTS HTML Renderer

Accepts `GET ?text=...` or `POST` (JSON or form). Returns an HTML page with the text in a centred `<h1>` — cast via `cast_site` to display on TV devices.

---

## `wrangler.toml`

```toml
name = "ghc"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[[durable_objects.bindings]]
name = "DEVICE_QUEUE"
class_name = "DeviceQueue"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DeviceQueue"]

[triggers]
crons = ["3 3 * * *"]   # 03:03 UTC daily — clear all device queues
```

### Worker Secrets (`wrangler secret put`)

| Secret | Description |
|---|---|
| `CATT_API_KEY` | Shared secret required on all non-Google routes via `X-API-Key` header; if unset, auth is skipped (dev mode) |
| `CATT_BACKEND_SECRET` | Shared secret sent to catt_backend via `X-Catt-Secret` header on every outbound call; if unset, header is omitted |
| `CATT_BACKEND_URL` | Cloudflare Tunnel URL for catt_backend |
| `TELEGRAM_SECRET_TOKEN` | Validates incoming Telegram webhook requests |
| `YOUTUBE_API_KEY` | Google YouTube Data API v3 key (for playlist fetching) |

---

## Cloudflare Tunnel Setup

```bash
cloudflared tunnel create catt
cloudflared tunnel route dns catt <tunnel-hostname>

# ~/.cloudflared/config.yml
tunnel: <tunnel-id>
ingress:
  - hostname: <tunnel-hostname>
    service: http://localhost:5000
  - service: http_status:404
```

---

## Deployment

```bash
cd catt_bff
npm install
wrangler secret put CATT_API_KEY
wrangler secret put CATT_BACKEND_SECRET
wrangler secret put CATT_BACKEND_URL
wrangler secret put TELEGRAM_SECRET_TOKEN
wrangler secret put YOUTUBE_API_KEY
wrangler deploy
```

---

## Setting the Playlist for mediaShuffle

Before using the Google Assistant "shuffle" command, set the YouTube playlist ID on the DO:

```bash
curl https://<your-worker-domain>/device/box/set/playlist/<youtube-playlist-id>
```

The `mediaShuffle` EXECUTE intent will read this value and populate the queue.

---

## Key Differences from Prototype

| Prototype (`old_bff.py`) | `catt_bff` |
|---|---|
| Python (Pyodide) | TypeScript |
| Cloudflare KV for state | Durable Object SQLite (`kv` table) |
| Single active device | Per-input device resolution via `INPUT_TO_DEVICE` |
| Queue as KV pipe-separated string | SQLite `queue` table with autoincrement |
| Manual next only | Auto-advance via DO Alarms + smart `getInfo`-based scheduling; `next` uses `advance()` directly (no stop) |
| No Report State | State reported reactively via QUERY intent only |
| Random 8-char token, no expiry | Random 32-char token (CSPRNG), `expires_in: 31536000` (1 year), random `refresh_token` |
| `/gauth`, `/gtoken`, `/gexec`, `/gcatt`, etc. | `/oauth/auth`, `/oauth/token`, `/fulfillment`, `/device/:name/*` |
| `mediaShuffle` reads `catt` KV key | `mediaShuffle` reads `playlist` kv state key; no prior `stop` — cast preempts playback |
| No Slack/Telegram | `/slack`, `/telegram` — unified endpoints supporting `cast`, `volume`, `play`, `stop`, `prev`, `next`, `tts` |
| `/gcatt` — general-purpose GET/POST endpoint | `POST /catt` — clean POST-only endpoint with `cast`, `site`, `queue` commands and optional device override |
| No audio-only device awareness | Switching input to a Mini device (name starts with "mini") auto-resets `app` to `default` |
| `prev`/`next` sentinel keys sent raw to catt_backend | Bare redirect keys (`pingr2`, `ping`) resolved via `getParsedUrl` before sending to catt_backend |
| `OnOff` on calls `stop` on catt_backend | `OnOff` on uses `/clear` — resets queue state only, no catt_backend call |
| `OnOff` off resets `app` to `default` | `OnOff` off leaves `app` unchanged |
| No `volumeRelative` support | `volumeRelative` maps to `volumeup`/`volumedown` — no stored volume needed |

## Constraints and Trade-offs

| Decision | Rationale |
|---|---|
| Single DO (`box`) | All state is logically one device set; simplifies routing |
| SQLite `kv` table over CF KV | Collocated with queue; consistent transactions; no extra binding |
| DO Alarms for polling | Built-in retry, no Queues service needed |
| Cron at 03:03 UTC daily | Clears queues end-of-day; avoids midnight surge |
| Smart alarm scheduling | `getInfo`-based precise scheduling minimises invocations; falls back to 10s polling for live streams |
| `force_default` per-call | Callers decide based on `app` state — no hidden coupling |
| Random OAuth tokens | Single-user stub; no token storage needed |
| `playlist` as kv state key | Consistent with other state; settable via `/box/set/playlist/:id` |
