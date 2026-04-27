# catt

Control Chromecast devices over HTTP. Three components:

- **`catt_server`** — Flask REST API that wraps the [`catt`](https://github.com/skorokithakis/catt) CLI. Runs on the LAN inside Docker, exposed externally via Cloudflare Tunnel.
- **`catt_bff`** — Cloudflare Worker that sits in front of `catt_server`, adding per-device play queues, Google Home integration, Slack/Telegram webhooks, and an ad-hoc `POST /catt` endpoint for curl usage.
- **`redirect`** — Cloudflare Worker for URL shortening and YouTube search. Deployed at `r.manojbaba.com`.

## Architecture

```
Google Assistant / Slack / Telegram
         │
         ▼
  Cloudflare Worker (catt_bff)
         │  Cloudflare Tunnel
         ▼
  catt_server (LAN, Docker)
         │
         ▼
  Chromecast devices
```

## catt_server

Flask app running on port 5000. All commands go to `POST /catt` with a JSON body.

```bash
docker build -t catt-server ./catt_server
docker run --network host -e CATT_SERVER_SECRET=your-secret catt-server
```

> `--network host` is required for mDNS Chromecast discovery. `CATT_SERVER_SECRET` is optional — if unset, auth is skipped.

On the Pi, the service is managed by systemd (`catt/catt.service`). The secret is loaded from `/home/pi/dotfiles/catt/.env`:

```bash
echo "CATT_SERVER_SECRET=your-secret" > /home/pi/dotfiles/catt/.env
chmod 600 /home/pi/dotfiles/catt/.env
sudo systemctl daemon-reload
sudo systemctl restart catt
```

```bash
curl -X POST http://localhost:5000/catt \
  -H 'Content-Type: application/json' \
  -d '{"device": "Living Room", "command": "volume", "value": 50}'
```

### Commands

| Command | `value` | Notes |
|---|---|---|
| `cast` | URL (required) | Supports local files, subtitles, yt-dlp |
| `cast_site` | URL (required) | DashCast controller |
| `tts` | Text (required) | Generates and casts MP3 via gTTS |
| `pause` / `play` / `play_toggle` / `stop` | — | Playback controls |
| `rewind` / `ffwd` | seconds (default 30) | Seek controls |
| `volume` | int 0–100 | Set volume |
| `volumeup` / `volumedown` | int 1–100 (default 10) | Relative volume |
| `volumemute` | bool (default true) | Mute toggle |
| `status` / `info` | — | Device status |

## catt_bff

Cloudflare Worker. Requires three secrets set via `wrangler secret put`:

| Secret | Description |
|---|---|
| `CATT_API_KEY` | Shared secret required on all non-Google routes via `X-API-Key` header; if unset, auth is skipped |
| `CATT_SERVER_SECRET` | Shared secret sent to catt_server via `X-Catt-Secret` header; catt_server reads from `CATT_SERVER_SECRET` env var |
| `CATT_SERVER_URL` | Cloudflare Tunnel URL for catt_server |
| `TELEGRAM_SECRET_TOKEN` | Validates incoming Telegram webhook requests |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key (for playlist shuffle) |

```bash
cd catt_bff
npm install
wrangler secret put CATT_API_KEY
wrangler secret put CATT_SERVER_SECRET
wrangler secret put CATT_SERVER_URL
wrangler secret put TELEGRAM_SECRET_TOKEN
wrangler secret put YOUTUBE_API_KEY
wrangler deploy
```

### Key routes

| Path | Description |
|---|---|
| `POST /fulfillment` | Google Home Cloud-to-Cloud intents |
| `GET /oauth/auth`, `POST /oauth/token` | Google account linking stub |
| `/device/box/*` | Device queue controls (cast, stop, prev, next, state, shuffle, site, set) |
| `POST /slack` | Slack slash command webhook |
| `POST /telegram` | Telegram bot webhook |
| `POST /catt` | Ad-hoc POST endpoint — `cast`, `site`, `play`, `stop`, `prev`, `next` commands with optional device override |
| `GET /echo` | TTS HTML renderer (for cast_site on TV devices) |
| `GET /gsync` | Debug: returns SYNC response without going through Google (pretty-printed JSON) |
| `GET /gquery` | Debug: returns live QUERY state without going through Google (pretty-printed JSON) |

### API Reference

#### `POST /catt` — Ad-hoc commands

```json
{"command": "cast|site|play|stop|prev|next", "device": "<key|name|queue>", "value": "..."}
```

| `command` | `device` | `value` | Effect |
|---|---|---|---|
| `cast` | input key or name | URL or redirect key | Clear queue, cast immediately |
| `cast` | `queue` | URL or redirect key | Enqueue; plays immediately if idle |
| `site` | input key, name, or omit | URL | `cast_site` the URL |
| `site` | input key, name, or omit | plain text | TTS: HTML on TV, spoken on audio device |
| `play` | — | — | Toggle play/pause |
| `stop` | — | — | Stop + clear queue |
| `prev` | — | — | Play previous |
| `next` | — | — | Advance queue; casts ping if empty |

`device` accepts aliases (`k`, `o`, `otv`) or full names (`Mini Kitchen`, `Office TV`). Switching to a Mini device auto-resets `app` to `default`. Ignored for `play`, `stop`, `prev`, `next`.

```bash
# Cast immediately on Mini Office
curl -X POST https://<worker>/catt \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <your-api-key>' \
  -d '{"command": "cast", "device": "o", "value": "https://youtube.com/watch?v=..."}'

# Add to queue
curl -X POST https://<worker>/catt \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <your-api-key>' \
  -d '{"command": "cast", "device": "queue", "value": "https://youtube.com/watch?v=..."}'

# TTS on Office TV
curl -X POST https://<worker>/catt \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <your-api-key>' \
  -d '{"command": "site", "device": "otv", "value": "Hello World"}'

# Cast site on Office TV
curl -X POST https://<worker>/catt \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <your-api-key>' \
  -d '{"command": "site", "device": "otv", "value": "https://example.com"}'

# Playback controls
curl -X POST https://<worker>/catt -H 'Content-Type: application/json' -H 'X-API-Key: <your-api-key>' -d '{"command": "play"}'
curl -X POST https://<worker>/catt -H 'Content-Type: application/json' -H 'X-API-Key: <your-api-key>' -d '{"command": "next"}'
```

#### `GET /device/box/*` — Queue controls

| Path | Effect |
|---|---|
| `/device/box/state` | Returns current state as pretty-printed JSON (now, device, channel, app, volume, prev, next, playlist, tts, alarm, queue) |
| `/device/box/play` | Toggle play/pause |
| `/device/box/prev` | Play previous (replays last TTS if `prev=tts`, plays pingr2 if no history) |
| `/device/box/next` | Advance queue; casts ping if queue empty |
| `/device/box/stop` | Stop playback, clear queue, cancel alarm |
| `/device/box/clear` | Clear queue + cancel alarm, no catt_server call |
| `/device/box/cast/:url` | Enqueue URL |
| `/device/box/site/:arg` | Stop + clear queue + cast_site URL, or TTS text |
| `/device/box/shuffle` | Shuffle saved playlist |
| `/device/box/set/:key/:value` | Set state key (e.g. `device`, `app`, `playlist`, `volume`) |

## redirect

Cloudflare Worker (`src/index.js`). URL shortener and redirect service deployed at `r.manojbaba.com`.

```bash
cd redirect
npm install
wrangler secret put YOUTUBE_API_KEY
npm run start   # wrangler dev (local)
npm run deploy  # wrangler deploy
```

### Routes (GET)

| Path | Behaviour |
|---|---|
| `/ip` | Returns the caller's IP (`CF-Connecting-IP`) |
| `/kv` | Lists all KV keys |
| `/kv/<key>` | Returns KV value for key (add `?output=json` for JSON) |
| `/r/<key>` | Redirects (302) to KV value; if key not found, falls back to YouTube search |
| `/r2/<key>` | Streams file from R2 bucket `md24` |
| `/y/<key>` | Returns raw YouTube search result as JSON |

### Routes (POST)

| Path | Behaviour |
|---|---|
| `/_raw` | Echoes request body |
| `/kv` | Returns KV value for key from JSON body (`{text: "<key>"}`) |

### Scheduled jobs (cron)

- **`0 6-22 * * *`** (hourly, 6am–10pm): Searches YouTube for latest Puthiyathalaimurai and Sun News headlines and updates `pttv` and `sun` KV keys.
- **`3 3 * * *`** (3:03am daily): No-op placeholder.

## CI/CD

| Workflow | Trigger | Actions |
|---|---|---|
| `catt-server` | PR / push to main / manual | PR: run tests + build image. Merge: run tests + build + push to Docker Hub. |
| `catt-bff` | PR / push to main / manual | PR: run tests + wrangler dry-run. Merge/manual: run tests + deploy. |
| `redirect` | PR / push to main / manual | PR: wrangler dry-run. Merge/manual: deploy. |

### Required secrets

| Secret | Used by |
|---|---|
| `DOCKERHUB_USERNAME` | catt-server workflow |
| `DOCKERHUB_TOKEN` | catt-server workflow |
| `CLOUDFLARE_API_TOKEN` | catt-bff, redirect workflows |
