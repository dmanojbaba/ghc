# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
pip install -r requirements.txt pytest

# Run all tests
pytest tests/

# Run a single test file
pytest tests/test_cast.py

# Run a single test
pytest tests/test_validation.py::test_missing_command

# Run the server directly (dev)
python app.py --debug

# Docker build and run (must use --network host for mDNS Chromecast discovery)
docker build -t catt-backend .
docker run --network host -e CATT_BACKEND_SECRET=your-secret catt-backend
```

## Architecture

Single-file Flask REST API (`app.py`) wrapping the [`catt`](https://github.com/skorokithakis/catt) CLI library. Exposes one endpoint: `POST /catt`.

### Request flow

```
POST /catt  {command, device?, value?, ...}
     │
     ├── auth check (X-Catt-Secret header vs CATT_BACKEND_SECRET env var)
     ├── JSON validation
     ├── command lookup in ACTION_HANDLERS
     └── executor.submit(handler)  ← ThreadPoolExecutor, 45s timeout
              │
              └── setup_cast()  ← catt library (mDNS device discovery)
                       │
                       └── Chromecast device
```

### Commands

15 handlers in `ACTION_HANDLERS`:

| Command | Description |
|---|---|
| `cast` | Cast URL or local file (auto-detects subtitles, spawns HTTP server for local files) |
| `cast_site` | Cast website via DashCast controller |
| `tts` | Generate MP3 via gTTS, then cast it |
| `play` / `pause` / `play_toggle` / `stop` | Playback controls |
| `rewind` / `ffwd` | Seek ±N seconds (default 30) |
| `volume` / `volumeup` / `volumedown` / `volumemute` | Volume controls |
| `status` | Returns `cast_info` (volume, player state, title) |
| `info` | Returns full playback info (duration, current_time, content_id) |

### Response format

```json
{"status": "success", "data": {...}}
{"status": "error", "error": "...", "error_type": "ValidationError|CattError|TimeoutError|..."}
```

HTTP status codes: 200 OK, 400 validation/user error, 401 unauthorized, 504 timeout, 500 internal.

### Error handling

- `_ValidationError` → 400
- `CattUserError` → 400
- `CattError` → 500
- `FuturesTimeoutError` (>45s) → 504
- Unhandled exceptions → 500

Non-serialisable types (`UUID`, `datetime`, `date`) are converted to strings by `_serialisable()`.

### Logging

`pychromecast` logger is set to `WARNING` to suppress noisy INFO messages (channel disconnects, app start/stop, mDNS discovery) that fire on every device sleep/reconnect. Errors and warnings still surface.

### Auth

Optional. If `CATT_BACKEND_SECRET` env var is set, all requests must include `X-Catt-Secret: <secret>` header. Auth is skipped if the env var is absent (useful for local dev).

### Local file casting

When `value` is a local file path, `app.py` spawns a background `Thread` running `serve_file()` (from the `catt` library) to serve the file over HTTP on the local network. Subtitle files are handled similarly on `port + 1`.

## Testing conventions

Tests use `pytest` with `monkeypatch.setattr("app.setup_cast", ...)` to mock the catt library — no real Chromecast needed. Fixtures `mock_cast` and `mock_stream` are defined in `conftest.py`. Tests cover validation, auth, all 15 commands, error handling, seek, volume, and response shape.

## Deployment

Runs on a Raspberry Pi inside Docker, exposed to the internet via Cloudflare Tunnel. `--network host` is required so the container can reach Chromecast devices via mDNS on the LAN.

Production config (gunicorn): 1 worker, 4 threads, 60s timeout.
