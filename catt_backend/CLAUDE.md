# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Create local environment (Python 3.12 matches the Docker image — required for pychromecast 14.x)
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt pytest

# Run all tests
.venv/bin/pytest tests/

# Run a single test file
.venv/bin/pytest tests/test_cast.py

# Run a single test
.venv/bin/pytest tests/test_validation.py::test_missing_command

# Run the server directly (dev)
.venv/bin/python app.py --debug

# Docker build and run (must use --network host for mDNS Chromecast discovery)
docker build -t catt-backend .
docker run --network host -e CATT_BACKEND_SECRET=your-secret catt-backend
```

## Architecture

Flask REST API wrapping the [`catt`](https://github.com/skorokithakis/catt) CLI library. Exposes one endpoint: `POST /catt`. Two files:

- **`app.py`** — request handling, routing, all command handlers
- **`pychromecast_workarounds.py`** — workaround for [pychromecast#866](https://github.com/home-assistant-libs/pychromecast/issues/866): wraps `setup_cast` to disconnect the Chromecast after each request, preventing background reconnect threads from spinning on a stopped Zeroconf instance. Delete this file when upstream is fixed (see instructions inside).

### Request flow

```
POST /catt  {command, device?, value?, ...}
     │
     ├── auth check (X-Catt-Secret header vs CATT_BACKEND_SECRET env var)
     ├── JSON validation
     ├── command lookup in ACTION_HANDLERS
     └── executor.submit(handler)  ← ThreadPoolExecutor, 45s timeout
              │
              ├── _handle_cast() — if value is a remote .m3u8 URL:
              │        ├── setup_cast(device, video_url=None)  ← connect only, no yt-dlp
              │        ├── ffmpeg -i <url> -c copy -bsf:a aac_adtstoasc -f mp4
              │        │          -movflags frag_keyframe+empty_moov+default_base_moof pipe:1
              │        ├── _serve_ffmpeg_pipe()  ← daemon thread, single-request HTTP server
              │        │     blocks reading first chunk, sets ready_event (max 30s wait)
              │        └── cst.play_media_url(http://local_ip:port/stream.mp4)
              │
              ├── setup_cast()  ← pychromecast_workarounds (wraps catt, mDNS discovery)
              │        │
              │        └── Chromecast device
              │
              └── disconnect_after_request()  ← pychromecast_workarounds (always, in finally)
```

### Commands

15 handlers in `ACTION_HANDLERS`:

| Command                                             | Description                                                                                                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cast`                                              | Cast URL or local file. Remote `.m3u8` URLs are intercepted by `_is_hls_url()` before yt-dlp and remuxed to fragmented MP4 via ffmpeg (`_handle_hls_cast`). All other URLs go through yt-dlp + StreamInfo as normal. |
| `cast_site`                                         | Cast website via DashCast controller                                                                                                                                                                                 |
| `tts`                                               | Generate MP3 via gTTS, then cast it                                                                                                                                                                                  |
| `play` / `pause` / `play_toggle` / `stop`           | Playback controls                                                                                                                                                                                                    |
| `rewind` / `ffwd`                                   | Seek ±N seconds (default 30)                                                                                                                                                                                         |
| `volume` / `volumeup` / `volumedown` / `volumemute` | Volume controls                                                                                                                                                                                                      |
| `status`                                            | Returns `cast_info` (volume, player state, title)                                                                                                                                                                    |
| `info`                                              | Returns full playback info (duration, current_time, content_id)                                                                                                                                                      |

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

`test_cast_hls.py` covers the HLS path. It monkeypatches `app.setup_cast` (returns just the controller, not a tuple), `app.get_local_ip`, `app._serve_ffmpeg_pipe`, and `app.Event` (returns a mock whose `.wait()` returns `True` immediately). Tests cover URL detection, pipe server invocation, query-string URLs, title forwarding, and non-HLS passthrough.

`test_pychromecast_workarounds.py` tests the workaround module in isolation by monkeypatching `_setup_cast` directly on the module. It covers both return shapes of `setup_cast` (plain controller and `(controller, stream)` tuple), and all `disconnect_after_request` paths (cast present, cast absent, thread-local unset).

## Deployment

Runs on a Raspberry Pi inside Docker, exposed to the internet via Cloudflare Tunnel. `--network host` is required so the container can reach Chromecast devices via mDNS on the LAN.

Production config (gunicorn): 1 worker, 4 threads, 60s timeout.

The Dockerfile uses `COPY *.py ./` so all root-level Python modules are included automatically. Avoid placing scripts in the root that shouldn't be in the image (e.g. migration scripts, one-offs).
