# Plan: Remote `.m3u8` HLS Casting via ffmpeg

## Context

The BFF sends the backend a remote URL pointing to an `.m3u8` file.  The backend should fetch that HLS stream, remux it to a format the Chromecast can receive over a simple HTTP connection, and cast the resulting local URL.

Passing the `.m3u8` URL directly to the Chromecast would require the device to fetch every segment itself.  That fails when the stream has auth tokens/cookies that only the Pi can resolve, when origin CORS rules block requests from the device's IP, or when segments use a codec the Default Media Receiver does not support (e.g. HEVC).  Fetching from the Pi side and re-serving avoids all of those problems.

`ffmpeg` is already installed in the Docker image (see `Dockerfile`), so no new dependencies are needed.

---

## Architecture

```
BFF  →  POST /catt  {command:"cast", value:"https://host/stream.m3u8"}
              │
              ▼  _handle_hls_cast()
         setup_cast(device, video_url=None)   ← connects to Chromecast, no yt-dlp
              │
              ▼
         ffmpeg -i <url> -c copy -f mp4
                -movflags frag_keyframe+empty_moov
                pipe:1                         ← stdout pipe, no temp file
              │
              ▼
         _serve_ffmpeg_pipe() (single-request HTTP, daemon thread, random port)
              │  http://local_ip:port/stream.mp4
              ▼
         cst.play_media_url(...)              ← Chromecast starts buffering
              │
              ▼  (API call returns; pychromecast disconnects per existing workaround)
         Chromecast reads from pipe server independently
```

**Why fragmented MP4 (`frag_keyframe+empty_moov`)?**

- The `moov` atom is placed at the stream head so the Chromecast can begin playing without downloading the entire file.
- `-c copy` (no re-encode) means ffmpeg starts piping data almost instantly.
- `video/mp4` is universally supported by the Default Media Receiver — no codec uncertainty from HLS.

---

## Implementation

All changes in `catt_backend/app.py`.  No Dockerfile changes needed.

### 1 — Detection helper

```python
def _is_hls_url(value: str) -> bool:
    """True when value is a remote URL pointing to an HLS manifest."""
    lower = value.lower()
    return lower.startswith(("http://", "https://")) and (
        lower.endswith(".m3u8") or ".m3u8?" in lower
    )
```

### 2 — Pipe-based HTTP server

New imports needed: `import socketserver`, `import subprocess`, `from http.server import BaseHTTPRequestHandler` (stdlib only, no new packages).

```python
def _serve_ffmpeg_pipe(m3u8_url: str, address: str, port: int) -> None:
    """
    Start ffmpeg, remux the HLS stream to fragmented MP4 on stdout,
    and serve exactly one HTTP GET request from that pipe.
    Runs in a daemon thread; terminates when the client disconnects.
    """
    proc = subprocess.Popen(
        [
            "ffmpeg", "-i", m3u8_url,
            "-c", "copy",
            "-f", "mp4",
            "-movflags", "frag_keyframe+empty_moov",
            "-loglevel", "error",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    class _PipeHandler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            try:
                while True:
                    chunk = proc.stdout.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass  # Chromecast stopped; normal

        def log_message(self, fmt, *args):  # suppress per-request log lines
            pass

    try:
        with socketserver.TCPServer((address, port), _PipeHandler) as httpd:
            httpd.handle_request()  # blocks until the one client disconnects
    finally:
        proc.terminate()
        proc.wait(timeout=5)
```

`handle_request()` blocks for exactly one client connection — the Chromecast.
After it disconnects, `proc.terminate()` kills ffmpeg and the thread exits.

### 3 — New handler in `_handle_cast`

At the very top of `_handle_cast`, before the existing `setup_cast` call, add:

```python
if _is_hls_url(value):
    return _handle_hls_cast(body)
```

New function:

```python
def _handle_hls_cast(body: dict):
    import time
    from catt.util import get_local_ip

    value  = body["value"]          # validated by caller
    device = body.get("device")
    title  = body.get("title") or "HLS Stream"

    # Connect to the cast device without running yt-dlp on the .m3u8 URL.
    # setup_cast(device, video_url=None) returns just the controller (not a tuple).
    cst = setup_cast(device, prep="app")

    local_ip = get_local_ip(cst._cast.cast_info.host)
    port = random.randrange(45000, 47000)
    cast_url = "http://{}:{}/stream.mp4".format(local_ip, port)

    thr = Thread(
        target=_serve_ffmpeg_pipe,
        args=(value, local_ip, port),
        daemon=True,
    )
    thr.start()

    # Give ffmpeg ~2 s to write the fMP4 header before the Chromecast connects.
    time.sleep(2)

    cst.play_media_url(
        cast_url,
        title=title,
        content_type="video/mp4",
        stream_type=body.get("stream_type"),
    )
    return _ok({"message": "Casting {} on {}".format(value, cst.cc_name)})
```

The `time.sleep(2)` runs inside a `ThreadPoolExecutor` worker, not the Flask thread.
The 45 s `request_timeout` is not breached because `play_media_url` returns quickly once the Chromecast acknowledges the load command.

---

## Request flow comparison

| | Normal cast | HLS cast |
|---|---|---|
| yt-dlp called | Yes | **No** (bypassed) |
| Who fetches segments | Chromecast directly | **Pi via ffmpeg** |
| Transport to Chromecast | original format | **fragmented MP4 `video/mp4`** |
| Auth / CORS handled by | Chromecast (may fail) | **Pi** |
| Seek support | yes | No (piped stream, no Content-Length) |
| Non-HLS cast path | unchanged | unchanged |

---

## Tests (`tests/test_cast_hls.py`)

New file — follows the monkeypatch fixture pattern from `conftest.py`.

```python
from unittest.mock import MagicMock


def _setup_hls(monkeypatch, mock_cast):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    monkeypatch.setattr("app.get_local_ip", lambda host: "192.168.1.10")
    monkeypatch.setattr("app._serve_ffmpeg_pipe", lambda *a: None)
    monkeypatch.setattr("app.time.sleep", lambda s: None)


def test_hls_url_routed_to_hls_handler(client, mock_cast, monkeypatch):
    """Remote .m3u8 URL reaches _handle_hls_cast, not the normal cast path."""
    _setup_hls(monkeypatch, mock_cast)
    r = client.post("/catt", json={"command": "cast", "value": "https://example.com/stream.m3u8"})
    assert r.status_code == 200
    assert "stream.m3u8" in r.get_json()["data"]["message"]


def test_hls_play_media_url_uses_local_mp4(client, mock_cast, monkeypatch):
    """play_media_url receives the pipe-server URL with content_type=video/mp4."""
    _setup_hls(monkeypatch, mock_cast)
    client.post("/catt", json={"command": "cast", "value": "https://example.com/stream.m3u8"})
    _, kwargs = mock_cast.play_media_url.call_args
    assert kwargs["url"].startswith("http://192.168.1.10:")
    assert kwargs["url"].endswith("/stream.mp4")
    assert kwargs["content_type"] == "video/mp4"


def test_hls_pipe_server_started_with_original_url(client, mock_cast, monkeypatch):
    """_serve_ffmpeg_pipe is called with the original .m3u8 URL."""
    pipe_calls = []
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    monkeypatch.setattr("app.get_local_ip", lambda host: "192.168.1.10")
    monkeypatch.setattr("app._serve_ffmpeg_pipe", lambda *a: pipe_calls.append(a))
    monkeypatch.setattr("app.time.sleep", lambda s: None)
    client.post("/catt", json={"command": "cast", "value": "https://example.com/live.m3u8"})
    assert len(pipe_calls) == 1
    assert pipe_calls[0][0] == "https://example.com/live.m3u8"


def test_hls_title_forwarded(client, mock_cast, monkeypatch):
    """Caller-supplied title is forwarded to play_media_url."""
    _setup_hls(monkeypatch, mock_cast)
    client.post("/catt", json={"command": "cast", "value": "https://example.com/s.m3u8", "title": "My Stream"})
    _, kwargs = mock_cast.play_media_url.call_args
    assert kwargs["title"] == "My Stream"


def test_hls_query_string_url_detected(client, mock_cast, monkeypatch):
    """.m3u8 URLs with query parameters are recognised as HLS."""
    _setup_hls(monkeypatch, mock_cast)
    r = client.post("/catt", json={"command": "cast", "value": "https://cdn.example.com/stream.m3u8?token=abc"})
    assert r.status_code == 200


def test_non_hls_url_unaffected(client, mock_cast, mock_stream, monkeypatch):
    """A .mp4 URL does not trigger HLS handling."""
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: (mock_cast, mock_stream))
    monkeypatch.setattr("app.hunt_subtitles", lambda v: None)
    pipe_calls = []
    monkeypatch.setattr("app._serve_ffmpeg_pipe", lambda *a: pipe_calls.append(a))
    r = client.post("/catt", json={"command": "cast", "value": "https://example.com/video.mp4"})
    assert r.status_code == 200
    assert pipe_calls == []
```

---

## Out of scope

- **Seek / scrubbing**: not possible without `Content-Length`. If needed, write ffmpeg output to a temp file and serve with the existing `serve_file` — adds latency proportional to stream length.
- **Transcoding**: `-c copy` requires the stream to use H.264 video + AAC audio. HEVC or other unsupported codecs need `-c:v libx264 -c:a aac` added to the ffmpeg args — follow-up work.
- **Multiple concurrent HLS casts**: each call gets its own port and ffmpeg process; the ThreadPoolExecutor's 4 workers set the concurrency ceiling.
