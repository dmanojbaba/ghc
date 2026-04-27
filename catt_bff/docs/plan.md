# Plan: catt_bff — Cloudflare Workers BFF

## Context

`catt_server` is a LAN-only Flask REST API for controlling Chromecast devices. This BFF runs on Cloudflare Workers and adds:

- **Per-device play queues** — SQLite-backed queue in a Durable Object
- **Automatic queue advancement** — DO Alarms use smart scheduling via `getInfo` to advance the queue when playback ends
- **Google Home Cloud-to-Cloud** — exposes devices as `action.devices.types.TV` controllable via Google Assistant
- **YouTube URL normalisation** — handles youtu.be, youtube.com/watch, embed, playlist URLs
- **YouTube playlist shuffle** — fetches playlist items and queues them for sequential playback
- **TTS** — renders text as an HTML page served via `cast_site` on TV devices, or calls `tts` command on others
- **Slack & Telegram integration** — webhook endpoints that translate slash commands into `catt_server` calls
- **Ad-hoc POST endpoint** — `POST /catt` for curl usage; supports `cast`, `site`, and `queue` commands with optional device override

Based on a working single-device prototype (`old_bff.py`) which used Cloudflare KV for state. The key architectural change is replacing KV with a **single Durable Object** (SQLite-backed) to support an ordered queue and DO Alarms for automatic advancement.

`catt_server` is exposed via **Cloudflare Tunnel** (`cloudflared`), keeping it LAN-only. Deployed at `<your-worker-domain>`.

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
   │     └── Alarm: polls catt_server + advances queue
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
│   ├── catt.ts               # catt_server HTTP client
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

| Input key | catt_server device name |
|---|---|
| `k`   | Mini Kitchen  |
| `o`   | Mini Office   |
| `b`   | Mini Bedroom  |
| `zbk` | Mini ZBK      |
| `tv`  | Google TV     |
| `otv` | Office TV     |

Default input on power-on: `otv`. Default playlist: `""` (unset).

Channels: `ping` (1), `pttv` / Tamil News (2), `sun` / Sun News (3), `london` (4), `dubai` (5), `lime` (6), `chennai` (7).

`INPUT_TO_DEVICE` maps input key → full catt_server device name string.

Helper functions:
- `getInputKey(deviceId, input, fallback)` — resolves alias or display name → key
- `getChannelCode(deviceId, channelNumber)` — resolves channel number → key
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
```

The `kv` table replaces Cloudflare KV from the prototype.

### State keys

| Key | Default | Description |
|---|---|---|
| `now` | `stopped` | `playing` or `stopped` |
| `prev` | `pingr2` | Last played URL (for repeat) |
| `next` | `ping` | Not read from kv — `getState()` derives next from the queue table directly; kv value is a legacy default only |
| `app` | `default` | `default` or `youtube` — controls `force_default` |
| `tts` | `Hello World!` | Last TTS text |
| `device` | `otv` | Active input key |
| `playlist` | `""` | YouTube playlist ID used by `mediaShuffle`; set via `/box/set/playlist/:id` |

### State Machine

```
STOPPED ──(enqueue when idle)──► PLAYING
   ▲                                │
   └──(queue empty after advance)───┤
                                    │
                        cast starts → alarm in 10s (settle)
                                    │
                        alarm fires → getInfo (player_state + duration)
                                    │
                    IDLE/UNKNOWN → advance()
                    PLAYING, duration known:
                        remaining > 10s → reschedule at (remaining - 10s)
                        remaining ≤ 10s → fast poll every 3s
                    PLAYING, duration unknown → poll every 10s
                    getInfo fails → getStatus fallback → poll every 10s
```

### Alarm timing constants

| Constant | Value | Purpose |
|---|---|---|
| `CAST_SETTLE_MS` | 10s | Initial delay after cast to allow Chromecast to buffer and report duration |
| `APPROACH_WINDOW_MS` | 10s | How far before end to switch to fast polling |
| `FAST_POLL_MS` | 3s | Poll interval near end of media |
| `POLL_INTERVAL_MS` | 10s | Fallback poll interval for live streams or when `getInfo` fails |

### Methods

| Method | Behaviour |
|---|---|
| `enqueue(url, title?)` | Add to queue; if `now == stopped`, call `advance()` immediately |
| `advance(userInitiated?)` | Pop next from queue; if empty + `userInitiated=true` → cast `DEFAULT_NEXT` (ping), set `now=stopped`, cancel alarm; if empty + not user-initiated → set `now=stopped`, cancel alarm, nothing cast; else cast item URL, set `now=playing`, set alarm in 10s (settle) |
| `clear()` | Stop catt_server, cancel alarm, clear queue, reset `now`, `prev`, `next`, `tts` to defaults (preserves `app`, `device`, `playlist`) |
| `shuffle(playlistId)` | Clear queue, fetch playlist via YouTube API, cast first item (no prior stop — cast preempts current playback), load rest into queue, set alarm in 10s (settle) |
| `playPrev()` | If `prev=="tts"` → replay last TTS text via `tts` command, no alarm; if `prev==DEFAULT_PREV` → cast pingr2, no alarm; else cast `prev` URL via `getParsedUrl`, set `now=playing`, schedule alarm |
| `alarm()` | Call `getInfo` for player state + duration in one request; if IDLE/UNKNOWN → `advance()`; if playing with known duration → smart schedule; if playing without duration → 10s poll; if `getInfo` fails → `getStatus` fallback |
| `getState()` | Return current state dict (alarm, now, device, app, volume, prev, next, playlist, tts, queue array) — `alarm` is ISO timestamp of next scheduled alarm or `null` |

### HTTP routes (handled inside DO `fetch`)

All paths use the `/device/box/` prefix — both from external HTTP requests forwarded by the Worker and from internal DO stub calls.

| Method | Path | Action |
|---|---|---|
| `GET` | `/device/box/state` | Return `getState()` as pretty-printed JSON including scheduled alarm timestamp |
| `GET` | `/device/box/play` | `play_toggle` on catt_server |
| `GET` | `/device/box/prev` | `playPrev()` |
| `GET` | `/device/box/next` | `advance()` |
| `GET` | `/device/box/stop` | `clear()` |
| `GET` | `/device/box/clear` | Clear queue + reset `now`, keep other state |
| `GET/POST` | `/device/box/cast/:url` | GET: `enqueue(url)`; POST: `enqueue(body.url, body.title)` |
| `GET/POST` | `/device/box/site/:arg` | Stop + cancel alarm + set `now=stopped`; cast_site URL if http, else TTS (HTML on TV, `tts` command on others) |
| `GET` | `/device/box/shuffle` | `shuffle(playlist)` using saved `playlist` state key |
| `GET` | `/device/box/set/:key/:value` | Set a kv state key; setting `device` to an audio-only input (name starts with "mini") auto-resets `app` to `default` |

---

## `urlHelper.ts`

```typescript
getParsedUrl(url: string, ytVideoId = false, ytPlaylist = false): string
getPlaylistItems(apiKey: string, playlistId: string, maxResults = 10): Promise<{ first: string; rest: string[] }>
```

Resolution order for `getParsedUrl`:
1. `ytVideoId=true` → prepend `BASE_YOUTUBE` (checked first, before URL parsing)
2. Already `r.manojbaba.com` → return as-is
3. `youtu.be/<id>` → full YouTube URL
4. `youtube.com/watch`, `/embed/`, `/v/` → extract video ID
5. `youtube.com` + `ytPlaylist=true` → extract `list` param
6. Starts with `http` → return as-is
7. Bare string → prepend `BASE_REDIRECT` (`https://r.manojbaba.com/r/`)

`getPlaylistItems` calls YouTube Data API v3, returns `{ first, rest }` where `first` is the first video URL and `rest` is an array of remaining URLs.

---

## `catt.ts`

```typescript
castCommand(serverUrl, device, command, value?, extra?): Promise<CattResponse>
getStatus(serverUrl, device): Promise<CattStatusResponse>
getInfo(serverUrl, device): Promise<CattInfoResponse>
```

Posts to `POST /catt` on catt_server. `force_default` is passed as `extra` when needed by callers. `getInfo` returns `player_state`, `duration`, and `current_time` in one call — used by `alarm()` for smart scheduling. `getStatus` is used as a fallback when `getInfo` fails.

---

## `oauth.ts`

Satisfies Google account linking with no real auth. Returns a random 32-char token on every `/oauth/token` call.

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/oauth/auth` | Show "Link this service to Google" button; on submit redirect back with code + state |
| `POST` | `/oauth/auth` | Read `responseurl` from form body, redirect to it |
| `POST` | `/oauth/token` | Return random `access_token`, `expires_in: 86400` (no `refresh_token`) |

---

## `googleHome.ts`

Single endpoint `POST /fulfillment`.

### SYNC
Returns `DEVICES` from `devices.ts`.

### QUERY
Calls DO `getState()` + `getStatus` on catt_server, maps to Google state shape.

### EXECUTE — Command Mapping

| Google Command | Action |
|---|---|
| `OnOff` (on) | Call `/box/clear` (clears queue + alarm, no catt_server call), then set `app=youtube`, `device=otv` |
| `OnOff` (off) | Call `/box/stop` (stops catt_server + clears queue + alarm); `app` and `device` left unchanged |
| `SetModes` | Update `app` state in DO |
| `SetInput` | Update `device` state in DO |
| `selectChannel` | Enqueue channel URL via DO (`/cast/:url`) — URL resolved via `getParsedUrl` |
| `relativeChannel` | -1 → pttv, +1 → sun — enqueued via DO (`/cast/:url`), URL resolved via `getParsedUrl` |
| `returnChannel` | `playPrev()` |
| `mediaShuffle` | `shuffle()` using saved `playlist` state key |
| `mediaPrevious` | `playPrev()` |
| `mediaNext` | `advance()` |
| `mediaResume` / `mediaPause` | `play_toggle` on catt_server |
| `mediaStop` | `clear()` |
| `appSelect` | Update `app` state in DO |
| `setVolume` | `volume` on catt_server (Google 0–10 × 10 → catt 0–100) |
| `volumeRelative` | `volumeup` or `volumedown` on catt_server (steps × 10%); no stored volume needed |

### DISCONNECT
Returns `{}`.

---

## `integrations.ts`

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/slack` | Parse `text` form field → `<command> <device> <url_or_value>`, dispatch to DO or catt_server |
| `POST` | `/telegram` | Parse `message.text` → `<command> <device> <url_or_value>`, verify secret header, dispatch |

### Command syntax

```
<command> <device> <url_or_value>
```

| Command | Routes via | Notes |
|---|---|---|
| `cast` | catt_server directly | URL resolved via `getParsedUrl` |
| `volume` | catt_server directly | Value is int 0–100 |
| `play` | DeviceQueue DO (`/box/play`) | Uses stored `device` key; `device` arg ignored |
| `stop` | DeviceQueue DO (`/box/stop`) | Uses stored `device` key; `device` arg ignored |
| `prev` | DeviceQueue DO (`/box/prev`) | Uses stored `device` key; `device` arg ignored |
| `next` | DeviceQueue DO (`/box/next`) | Uses stored `device` key; `device` arg ignored |
| `tts` | DeviceQueue DO (`/box/site/:text`) | All remaining tokens joined as text; uses stored `device` key |

- Slack: no auth (personal workspace); returns plain text response matching the command name
- Telegram: `X-Telegram-Bot-Api-Secret-Token` header validated against `TELEGRAM_SECRET_TOKEN` secret; skipped if secret unset; always returns `{}`

---

## `cattHandler.ts` — Ad-hoc POST Endpoint

Single endpoint for ad-hoc curl usage.

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/catt` | Dispatch `cast`, `site`, or `queue` command to the DeviceQueue DO |

### Request body

```json
{"command": "cast|site|queue", "value": "...", "device": "o"}
```

`device` is optional — if provided, resolves via `getInputKey`, updates stored device, auto-resets `app` to `default` if audio-only.

### Commands

| `command` | `device` | `value` | Behaviour |
|---|---|---|---|
| `cast` | input key or name | URL or redirect key | Clear queue + cancel alarm, cast immediately, update `prev`, schedule alarm |
| `cast` | `queue` | URL or redirect key | Enqueue via `getParsedUrl`; plays immediately if idle, appends otherwise |
| `site` | input key, name, or `queue` (uses stored device) | URL → `cast_site`; plain text → TTS (HTML on TV, spoken on audio device) | Stop + clear queue + cancel alarm |

`device` accepts aliases (`k`, `o`, `otv`) or full names (`Mini Kitchen`, `Office TV`). `"queue"` is a special value for `cast` that enqueues instead of casting immediately; for `site` it is ignored and the stored device is used.

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
| `CATT_SERVER_URL` | Cloudflare Tunnel URL for catt_server |
| `YOUTUBE_API_KEY` | Google YouTube Data API v3 key (for playlist fetching) |
| `TELEGRAM_SECRET_TOKEN` | Validates incoming Telegram webhook requests |

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
wrangler secret put CATT_SERVER_URL
wrangler secret put YOUTUBE_API_KEY
wrangler secret put TELEGRAM_SECRET_TOKEN
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
| Random 8-char token, no expiry | Random 32-char token (CSPRNG), `expires_in: 86400`, no `refresh_token` |
| `/gauth`, `/gtoken`, `/gexec`, `/gcatt`, etc. | `/oauth/auth`, `/oauth/token`, `/fulfillment`, `/device/:name/*` |
| `mediaShuffle` reads `catt` KV key | `mediaShuffle` reads `playlist` kv state key; no prior `stop` — cast preempts playback |
| No Slack/Telegram | `/slack`, `/telegram` — unified endpoints supporting `cast`, `volume`, `play`, `stop`, `prev`, `next`, `tts` |
| `/gcatt` — general-purpose GET/POST endpoint | `POST /catt` — clean POST-only endpoint with `cast`, `site`, `queue` commands and optional device override |
| No audio-only device awareness | Switching input to a Mini device (name starts with "mini") auto-resets `app` to `default` |
| `prev`/`next` sentinel keys sent raw to catt_server | Bare redirect keys (`pingr2`, `ping`) resolved via `getParsedUrl` before sending to catt_server |
| `OnOff` on calls `stop` on catt_server | `OnOff` on uses `/clear` — resets queue state only, no catt_server call |
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
