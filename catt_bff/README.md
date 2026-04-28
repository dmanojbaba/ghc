# catt_bff

Cloudflare Worker BFF for controlling Chromecast devices. Deployed at `ghc.manojbaba.com`.

## Devices

| Input key | Device |
|---|---|
| `k` | Mini Kitchen |
| `o` | Mini Office |
| `b` | Mini Bedroom |
| `zbk` | Mini ZBK |
| `tv` | Google TV |
| `otv` | Office TV (default) |

## Slack / Telegram

Command syntax: `<command> [device] [value]`

| Command | Example | Notes |
|---|---|---|
| `cast` | `cast otv https://youtu.be/abc123` | Cast a URL immediately. Accepts YouTube URLs, shortcodes, or full URLs. |
| `cast` | `cast queue https://youtu.be/abc123` | Add to queue instead of casting immediately. |
| `tts` | `tts otv hello world` | Speak text. On TV devices renders as HTML; on Mini devices uses TTS audio. |
| `volume` | `volume otv 50` | Set volume 0–100. |
| `mute` | `mute` | Mute. Always acts on the currently active device. |
| `mute` | `mute false` | Unmute. Always acts on the currently active device. |
| `unmute` | `unmute` | Unmute. Alias for `mute false`. Always acts on the currently active device. |
| `play` | `play` | Toggle play/pause. |
| `stop` | `stop` | Stop playback and clear queue. |
| `prev` | `prev` | Replay previous item. |
| `next` | `next` | Skip to next item in queue. |
| `rewind` | `rewind 60` | Rewind N seconds (default 30). |
| `ffwd` | `ffwd 30` | Fast-forward N seconds (default 30). |
| `sleep` | `sleep 30` | Stop playback after N minutes. |
| `sleep` | `sleep cancel` | Cancel a pending sleep timer. |

`play`, `stop`, `prev`, `next`, `rewind`, `ffwd`, `sleep`, `mute`, `unmute` always act on the currently active device — the device argument is ignored for these.

## POST /catt

Ad-hoc HTTP endpoint for curl usage. Requires `X-API-Key` header.

```bash
# Cast a URL immediately
curl -X POST https://ghc.manojbaba.com/catt \
  -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' \
  -d '{"command": "cast", "device": "otv", "value": "https://youtu.be/abc123"}'

# Add to queue
curl -X POST https://ghc.manojbaba.com/catt \
  -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' \
  -d '{"command": "cast", "device": "queue", "value": "https://youtu.be/abc123"}'

# TTS
curl -X POST https://ghc.manojbaba.com/catt \
  -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' \
  -d '{"command": "site", "device": "otv", "value": "Hello World"}'

# Playback controls
curl -X POST https://ghc.manojbaba.com/catt -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' -d '{"command": "play"}'
curl -X POST https://ghc.manojbaba.com/catt -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' -d '{"command": "stop"}'
curl -X POST https://ghc.manojbaba.com/catt -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' -d '{"command": "prev"}'
curl -X POST https://ghc.manojbaba.com/catt -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' -d '{"command": "next"}'

# Seek
curl -X POST https://ghc.manojbaba.com/catt -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' -d '{"command": "rewind", "value": "60"}'
curl -X POST https://ghc.manojbaba.com/catt -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' -d '{"command": "ffwd", "value": "30"}'

# Sleep timer
curl -X POST https://ghc.manojbaba.com/catt -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' -d '{"command": "sleep", "value": "30"}'
curl -X POST https://ghc.manojbaba.com/catt -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' -d '{"command": "sleep", "value": "cancel"}'

# Mute / unmute
curl -X POST https://ghc.manojbaba.com/catt -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' -d '{"command": "mute"}'
curl -X POST https://ghc.manojbaba.com/catt -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' -d '{"command": "mute", "value": "false"}'
curl -X POST https://ghc.manojbaba.com/catt -H 'X-API-Key: <key>' \
  -H 'Content-Type: application/json' -d '{"command": "unmute"}'
```

## GET /device/box/* endpoints

All require `X-API-Key` header.

| Endpoint | Description |
|---|---|
| `GET /device/box/state` | Current state — session, device, queue, sleep timer, etc. |
| `GET /device/box/history` | Last 10 played items (newest first). Excludes TTS. |
| `GET /device/box/play` | Toggle play/pause. |
| `GET /device/box/stop` | Stop playback and clear queue. |
| `GET /device/box/prev` | Replay previous item. |
| `GET /device/box/next` | Skip to next item in queue. |
| `GET /device/box/cast/:url` | Enqueue a URL. |
| `GET /device/box/shuffle` | Shuffle the saved YouTube playlist. |
| `GET /device/box/mute/:bool` | Mute (`true`) or unmute (`false`). Default: mute. |
| `GET /device/box/unmute` | Unmute. Alias for `mute/false`. |
| `GET /device/box/rewind/:seconds` | Rewind N seconds (default 30). |
| `GET /device/box/ffwd/:seconds` | Fast-forward N seconds (default 30). |
| `GET /device/box/sleep/:minutes` | Stop after N minutes. |
| `GET /device/box/sleep/cancel` | Cancel sleep timer. |
| `GET /device/box/set/device/:key` | Switch active device (e.g. `otv`, `k`). |
| `GET /device/box/set/playlist/:id` | Set YouTube playlist ID for shuffle. |

## State response

```json
{
  "session": "active",
  "device": "otv",
  "app": "youtube",
  "channel": "ping",
  "prev": "https://...",
  "next": "https://...",
  "playlist": "PLxxx",
  "tts": "Hello World!",
  "sleep_at": "2026-04-28T15:00:00.000Z",
  "alarm": "2026-04-28T14:45:00.000Z",
  "queue": [
    { "position": 1, "url": "https://..." },
    { "position": 2, "url": "https://..." }
  ]
}
```

`sleep_at` and `alarm` are `null` when not set. `queue` includes all pending items including the next-to-play item.
