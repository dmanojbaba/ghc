# catt

Control Chromecast devices over HTTP. Two components:

- **`catt_server`** — Flask REST API that wraps the [`catt`](https://github.com/skorokithakis/catt) CLI. Runs on the LAN inside Docker, exposed externally via Cloudflare Tunnel.
- **`catt_bff`** — Cloudflare Worker that sits in front of `catt_server`, adding per-device play queues, Google Home integration, and Slack/Telegram webhooks.

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
docker run --network host catt-server
```

> `--network host` is required for mDNS Chromecast discovery.

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
| `CATT_SERVER_URL` | Cloudflare Tunnel URL for catt_server |
| `YOUTUBE_API_KEY` | YouTube Data API v3 key (for playlist shuffle) |
| `TELEGRAM_SECRET_TOKEN` | Validates incoming Telegram webhook requests |

```bash
cd catt_bff
npm install
wrangler secret put CATT_SERVER_URL
wrangler secret put YOUTUBE_API_KEY
wrangler secret put TELEGRAM_SECRET_TOKEN
wrangler deploy
```

### Key routes

| Path | Description |
|---|---|
| `POST /fulfillment` | Google Home Cloud-to-Cloud intents |
| `GET /oauth/auth`, `POST /oauth/token` | Google account linking stub |
| `/device/box/*` | Device queue controls (cast, skip, stop, state, shuffle) |
| `POST /slack` | Slack slash command webhook |
| `POST /telegram` | Telegram bot webhook |
| `GET /echo` | TTS HTML renderer (for cast_site on TV devices) |

## CI/CD

| Workflow | Trigger | Actions |
|---|---|---|
| `catt-server` | PR / push to main / manual | PR: run tests + build image. Merge: run tests + build + push to Docker Hub. |
| `catt-bff` | PR / push to main / manual | PR: run tests + wrangler dry-run. Merge/manual: run tests + deploy. |

### Required secrets

| Secret | Used by |
|---|---|
| `DOCKERHUB_USERNAME` | catt-server workflow |
| `DOCKERHUB_TOKEN` | catt-server workflow |
| `CLOUDFLARE_API_TOKEN` | catt-bff workflow |
