# Plan: Standalone REST API Server for catt + Docker Packaging

## Context

catt is a CLI tool for casting media to Chromecast devices. We want a standalone REST API application that accepts JSON via POST so external tools (Home Assistant, scripts, mobile apps) can control Chromecasts over HTTP.

The app is **standalone** — a separate application that installs `catt` and `flask` as dependencies, rather than being part of the catt package itself. It will be shipped as a Docker image built on a slim Python base.

The existing `CattDevice` class in `catt/api.py` is too limited. We'll import and call `setup_cast()` from `catt.controllers` directly — the same path the CLI uses — for full feature parity.

`catt_server` is **LAN-only**. It is exposed to the internet exclusively via Cloudflare Tunnel. Slack and Telegram integrations live in `catt_bff` (Cloudflare Workers), which calls `catt_server` via the tunnel.

## Project Structure

```
catt_server/
├── app.py                   # Flask application (standalone, imports from catt)
├── requirements.txt         # flask + catt + gtts
├── Dockerfile               # slim Python image
├── .dockerignore
├── docs/
│   ├── plan.md
│   └── test-spec.md
└── tests/
    ├── conftest.py
    ├── test_cast.py
    ├── test_cast_site.py
    ├── test_error_handling.py
    ├── test_playback_controls.py
    ├── test_response_shape.py
    ├── test_seek_controls.py
    ├── test_status_info.py
    ├── test_tts.py
    ├── test_validation.py
    └── test_volume_controls.py
```

## Design

**Framework**: Flask (pychromecast is entirely synchronous; async adds complexity with no benefit)

**Endpoint**: `POST /catt` with JSON body containing `device`, `command`, and (where needed) `value` keys

**Default bind**: `0.0.0.0:5000` inside Docker (unlike the CLI default of 127.0.0.1, the container network provides the isolation boundary)

### Request/Response Format

```json
// Request
{"device": "Living Room", "command": "volume", "value": 50}

// Success
{"status": "success", "data": null}

// Error
{"status": "error", "error": "Device not found", "error_type": "CastError"}

// Timeout
{"status": "error", "error": "Request timed out after 30s", "error_type": "TimeoutError"}
```

> **Note**: `command` is case-insensitive — `"PAUSE"`, `"Pause"`, and `"pause"` are all accepted.

### Commands and Parameters

| Command | `value` | Returns | Notes |
|---|---|---|---|
| `cast` | URL string (required) + optional: `title`, `subtitle_url`, `content_type`, `stream_type`, `force_default`, `ytdl_options` (dict) | `{"message": "Casting ..."}` | Local file detection, subtitle support |
| `cast_site` | URL string (required) | `{"message": "Casting site ..."}` | DashCast controller |
| `tts` | Text string (required) | `{"message": "Casting ..."}` | Generates `/tmp/cast_tts.mp3` via gTTS, casts with title `"TTS"` |
| `pause` | — | `{"message": "OK"}` | |
| `play` | — | `{"message": "OK"}` | |
| `play_toggle` | — | `{"message": "OK"}` | |
| `stop` | — | `{"message": "OK"}` | |
| `rewind` | seconds int (default 30) | `{"message": "OK"}` | |
| `ffwd` | seconds int (default 30) | `{"message": "OK"}` | |
| `volume` | int 0-100 (required) | `{"volume_level": 50}` | |
| `volumeup` | int 1-100 (default 10) | `{"message": "OK"}` | |
| `volumedown` | int 1-100 (default 10) | `{"message": "OK"}` | |
| `volumemute` | bool (default true) | `{"volume_muted": true}` | |
| `status` | — | cast_info dict | |
| `info` | — | full info dict | |

### Error Mapping

| Exception | HTTP Status |
|---|---|
| Missing/invalid command or params | 400 |
| `CattUserError` subclasses (CastError, CliError, etc.) | 400 |
| `CattError` internal subclasses | 500 |
| Unhandled exceptions | 500 |
| Request timeout | 504 |

### JSON Serialisation

Every response — success or error — must be valid JSON with `Content-Type: application/json`. This includes:
- All values in `data` dicts must be JSON-serialisable (str, int, float, bool, list, dict, null)
- The `info` command returns raw pychromecast status fields which may include non-serialisable types (e.g. `UUID`, `datetime`); these are explicitly converted to strings by `_serialisable(obj)`
- Errors are never returned as plain text or HTML — the Flask error handlers for 400/500 also return JSON

## `catt_server/requirements.txt`

```
catt
flask>=3.0
gtts
gunicorn>=22.0
pychromecast>=14.0
zeroconf>=0.132
```

## `catt_server/Dockerfile`

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        jq \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --upgrade yt-dlp

COPY app.py .

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "4", "--timeout", "60", "app:app"]
```

Key choices:
- `python:3.12-slim` — Debian-based slim image, has everything pychromecast needs (no Alpine due to C extension deps)
- `ffmpeg` — required by yt-dlp for merging separate audio/video streams (1080p+)
- `curl` and `jq` — available inside the container for debugging
- `yt-dlp` upgraded at build time — keeps YouTube casting working as sites change
- `gunicorn` with 1 worker + 4 threads — pychromecast is not multiprocess-safe; threads are fine
- `--network host` required at runtime for mDNS Chromecast discovery

## `catt_server/app.py`

Standalone Flask app. Imports directly from the installed `catt` package:

```python
from catt.controllers import setup_cast
from catt.error import CattError, CattUserError
from catt.http_server import serve_file
from catt.subs_info import SubsInfo
from catt.util import hunt_subtitles
```

Structure:
- `_ok(data)` / `_err(msg, type, status)` — response helpers returning `{"status": "success/error", ...}`
- `_serialisable(obj)` — recursively converts UUID/datetime/date to strings
- One handler function per command (15 total, registered in `ACTION_HANDLERS`)
- `ThreadPoolExecutor` with 4 workers — handlers run off the request thread for timeout support
- `POST /catt` — checks `X-Catt-Secret` header against `CATT_SERVER_SECRET` env var (skipped if unset); dispatches to handler via executor, wraps errors into structured JSON
- `main()` with argparse for `--host`, `--port`, `--timeout` (default 30s), `--debug`
- Structured logging via `logging.basicConfig` — INFO on request received (logs full JSON body including `command`, `device`, `value`), INFO on success, WARNING on client errors, ERROR/EXCEPTION on server errors

### Authentication

`CATT_SERVER_SECRET` env var — if set, every request to `POST /catt` must include an `X-Catt-Secret` header with a matching value. Requests with a missing or incorrect header are rejected with 401. If the env var is unset, auth is skipped (dev mode).

### Constants

| Constant | Value | Purpose |
|---|---|---|
| `TTS_FILE` | `/tmp/cast_tts.mp3` | Fixed path for TTS audio output |

## Running the Container

```bash
# Build
docker build -t catt-api ./catt_server

# Run (host networking required for mDNS Chromecast discovery)
docker run --network host -e CATT_SERVER_SECRET=your-secret catt-api
```

`CATT_SERVER_SECRET` is optional — if omitted, auth is skipped.

> **Important**: Chromecast discovery uses mDNS (multicast DNS), which does not work with Docker's default bridge networking. `--network host` is required so the container can see Chromecast devices on the LAN.

## Verification

```bash
# Build and start
docker build -t catt-api ./catt_server
docker run --network host -e CATT_SERVER_SECRET=your-secret catt-api

# Test volume
curl -X POST http://localhost:5000/catt \
  -H 'Content-Type: application/json' \
  -H 'X-Catt-Secret: your-secret' \
  -d '{"device": "<name>", "command": "volume", "value": 50}'

# Test cast
curl -X POST http://localhost:5000/catt \
  -H 'Content-Type: application/json' \
  -d '{"device": "<name>", "command": "cast", "value": "https://..."}'

# Test TTS
curl -X POST http://localhost:5000/catt \
  -H 'Content-Type: application/json' \
  -d '{"device": "<name>", "command": "tts", "value": "hello world"}'

# Test unknown command → expect 400
curl -X POST http://localhost:5000/catt \
  -H 'Content-Type: application/json' \
  -d '{"command": "bogus"}'
```
