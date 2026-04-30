# Test Spec: catt API Server

Tests use Flask's test client and mock `setup_cast()` to avoid requiring real Chromecast hardware.

## Setup

```python
# conftest.py
from unittest.mock import MagicMock, patch
import pytest
from app import app

@pytest.fixture
def client():
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client

@pytest.fixture
def mock_cast():
    """Returns a mock controller with sensible defaults."""
    cst = MagicMock()
    cst.cc_name = "Living Room"
    cst.cast_info = {
        "volume_level": "50",
        "volume_muted": False,
        "title": "Test Video",
        "player_state": "PLAYING",
    }
    cst.info = {**cst.cast_info, "content_id": "https://example.com/video.mp4"}
    return cst
```

---

## 1. Authentication

| # | Test | Scenario | Expected |
|---|---|---|---|
| 1.1 | Secret set, correct header | `CATT_BACKEND_SECRET=abc`, `X-Catt-Secret: abc` | Request proceeds normally |
| 1.2 | Secret set, wrong header | `CATT_BACKEND_SECRET=abc`, `X-Catt-Secret: wrong` | 401, `error_type: Unauthorized` |
| 1.3 | Secret set, missing header | `CATT_BACKEND_SECRET=abc`, no header | 401, `error_type: Unauthorized` |
| 1.4 | Secret unset, no header | `CATT_BACKEND_SECRET` not set | Request proceeds normally (dev mode) |

---

## 2. Request Validation


| # | Test | Input | Expected |
|---|---|---|---|
| 1.1 | Missing `command` field | `{}` | 400, `error_type: ValidationError` |
| 1.2 | Unknown command | `{"command": "bogus"}` | 400, `error_type: ValidationError` |
| 1.3 | Empty body | `` (no body) | 400, `error_type: ValidationError` |
| 1.4 | Malformed JSON | `{invalid}` | 400, `error_type: ValidationError` |
| 1.5 | Valid command, no `device` | `{"command": "pause"}` | delegates to `setup_cast(None, ...)` — no 400 from API layer |
| 1.6 | Command in uppercase | `{"command": "PAUSE"}` | 200, treated as `pause` |
| 1.7 | Command in mixed case | `{"command": "Pause"}` | 200, treated as `pause` |
| 1.8 | Command with underscore uppercase | `{"command": "PLAY_TOGGLE"}` | 200, treated as `play_toggle` |

---

## 2. `cast`

| # | Test | Input | Expected |
|---|---|---|---|
| 2.1 | Missing `value` | `{"command": "cast"}` | 400, error about missing value |
| 2.2 | Valid remote URL | `{"command": "cast", "device": "Kitchen", "value": "https://example.com/v.mp4"}` | 200, `status: success`, `data.message` contains URL and device name |
| 2.3 | With optional `title` | `{"command": "cast", ..., "title": "My Video"}` | 200, `play_media_url` called with `title="My Video"` |
| 2.4 | With optional `subtitle_url` | `{"command": "cast", ..., "subtitle_url": "https://example.com/subs.vtt"}` | 200, subtitles passed to `play_media_url` |
| 2.5 | With `force_default: true` | `{"command": "cast", ..., "force_default": true}` | 200, `setup_cast` called with `controller="default"` |
| 2.6 | With `ytdl_options` dict | `{"command": "cast", ..., "ytdl_options": {"format": "bestaudio"}}` | 200, options converted to tuple and passed |
| 2.7 | Device not found | `setup_cast` raises `CastError` | 400, `error_type: CastError` |
| 2.8 | Extraction failure | `setup_cast` raises `ExtractionError` | 400, `error_type: ExtractionError` |

---

## 3. `tts`

| # | Test | Input | Expected |
|---|---|---|---|
| 3.1 | Missing `value` | `{"command": "tts"}` | 400, `error_type: ValidationError` |
| 3.2 | Generates MP3 and casts | `{"command": "tts", "device": "Kitchen", "value": "hello world"}` | 200, `gTTS.save` called with `/tmp/cast_tts.mp3`, `play_media_url` called with `title="TTS"` |
| 3.3 | Casts TTS file path | `{"command": "tts", "device": "Kitchen", "value": "hello"}` | 200, `data.message` contains `/tmp/cast_tts.mp3` |
| 3.4 | Passes device through | `{"command": "tts", "device": "Bedroom", "value": "wake up"}` | 200, `setup_cast` called with `device="Bedroom"` |

---

## 4. `cast_site`

| # | Test | Input | Expected |
|---|---|---|---|
| 4.1 | Missing `value` | `{"command": "cast_site"}` | 400, error about missing value |
| 4.2 | Valid URL | `{"command": "cast_site", "device": "Kitchen", "value": "https://example.com"}` | 200, `cst.load_url` called with the URL |
| 4.3 | `setup_cast` called with dashcast controller | — | `setup_cast(..., controller="dashcast", prep="app")` verified |

---

## 5. Playback Controls

### 5.1 `pause`
| # | Test | Input | Expected |
|---|---|---|---|
| 5.1.1 | Valid | `{"command": "pause", "device": "Kitchen"}` | 200, `cst.pause()` called, `data == {"message": "OK"}` |
| 5.1.2 | Nothing playing | `setup_cast` raises `CastError("Nothing is currently playing")` | 400, `error_type: CastError` |

### 5.2 `play`
| # | Test | Input | Expected |
|---|---|---|---|
| 5.2.1 | Valid | `{"command": "play", "device": "Kitchen"}` | 200, `cst.play()` called, `data == {"message": "OK"}` |

### 5.3 `play_toggle`
| # | Test | Input | Expected |
|---|---|---|---|
| 5.3.1 | Valid | `{"command": "play_toggle", "device": "Kitchen"}` | 200, `cst.play_toggle()` called, `data == {"message": "OK"}` |

### 5.4 `stop`
| # | Test | Input | Expected |
|---|---|---|---|
| 5.4.1 | Default (no force) | `{"command": "stop", "device": "Kitchen"}` | 200, `cst.kill(force=False)` called, `data == {"message": "OK"}` |
| 5.4.2 | With `value: true` | `{"command": "stop", "device": "Kitchen", "value": true}` | 200, `cst.kill(force=True)` called, `data == {"message": "OK"}` |

---

## 6. Seek Controls

### 6.1 `rewind`
| # | Test | Input | Expected |
|---|---|---|---|
| 6.1.1 | Default seconds | `{"command": "rewind", "device": "Kitchen"}` | 200, `cst.rewind(30)` called, `data == {"message": "OK"}` |
| 6.1.2 | Custom seconds | `{"command": "rewind", "device": "Kitchen", "value": 60}` | 200, `cst.rewind(60)` called, `data == {"message": "OK"}` |
| 6.1.3 | Not seekable | `cst.rewind` raises `CastError` | 400, `error_type: CastError` |

### 6.2 `ffwd`
| # | Test | Input | Expected |
|---|---|---|---|
| 6.2.1 | Default seconds | `{"command": "ffwd", "device": "Kitchen"}` | 200, `cst.ffwd(30)` called, `data == {"message": "OK"}` |
| 6.2.2 | Custom seconds | `{"command": "ffwd", "device": "Kitchen", "value": 15}` | 200, `cst.ffwd(15)` called, `data == {"message": "OK"}` |

---

## 7. Volume Controls

### 7.1 `volume`
| # | Test | Input | Expected |
|---|---|---|---|
| 7.1.1 | Missing `value` | `{"command": "volume", "device": "Kitchen"}` | 400, error about missing value |
| 7.1.2 | Valid level | `{"command": "volume", "device": "Kitchen", "value": 50}` | 200, `cst.volume(0.5)` called, `data == {"volume_level": 50}` |
| 7.1.3 | Boundary: 0 | `{"command": "volume", ..., "value": 0}` | 200, `cst.volume(0.0)` called, `data == {"volume_level": 0}` |
| 7.1.4 | Boundary: 100 | `{"command": "volume", ..., "value": 100}` | 200, `cst.volume(1.0)` called, `data == {"volume_level": 100}` |
| 7.1.5 | Out of range: 101 | `{"command": "volume", ..., "value": 101}` | 400, validation error |
| 7.1.6 | Out of range: -1 | `{"command": "volume", ..., "value": -1}` | 400, validation error |

### 7.2 `volumeup`
| # | Test | Input | Expected |
|---|---|---|---|
| 7.2.1 | Default delta | `{"command": "volumeup", "device": "Kitchen"}` | 200, `cst.volumeup(0.1)` called, `data == {"message": "OK"}` |
| 7.2.2 | Custom delta | `{"command": "volumeup", "device": "Kitchen", "value": 20}` | 200, `cst.volumeup(0.2)` called, `data == {"message": "OK"}` |
| 7.2.3 | Out of range: 0 | `{"command": "volumeup", ..., "value": 0}` | 400, validation error |

### 7.3 `volumedown`
| # | Test | Input | Expected |
|---|---|---|---|
| 7.3.1 | Default delta | `{"command": "volumedown", "device": "Kitchen"}` | 200, `cst.volumedown(0.1)` called, `data == {"message": "OK"}` |
| 7.3.2 | Custom delta | `{"command": "volumedown", "device": "Kitchen", "value": 20}` | 200, `cst.volumedown(0.2)` called, `data == {"message": "OK"}` |

### 7.4 `volumemute`
| # | Test | Input | Expected |
|---|---|---|---|
| 7.4.1 | Default (mute) | `{"command": "volumemute", "device": "Kitchen"}` | 200, `cst.volumemute(True)` called, `data == {"volume_muted": true}` |
| 7.4.2 | Explicit unmute | `{"command": "volumemute", "device": "Kitchen", "value": false}` | 200, `cst.volumemute(False)` called, `data == {"volume_muted": false}` |

---

## 8. Status / Info

### 8.1 `status`
| # | Test | Input | Expected |
|---|---|---|---|
| 8.1.1 | Valid | `{"command": "status", "device": "Kitchen"}` | 200, `data` contains `volume_level`, `volume_muted` |
| 8.1.2 | Device inactive | `setup_cast` raises `CastError` | 400, `error_type: CastError` |

### 8.2 `info`
| # | Test | Input | Expected |
|---|---|---|---|
| 8.2.1 | Valid | `{"command": "info", "device": "Kitchen"}` | 200, `data` contains full info dict |
| 8.2.2 | All values JSON-serialisable | — | Response body parses without error |

---

## 9. Error Handling

| # | Test | Scenario | Expected |
|---|---|---|---|
| 9.1 | `CattUserError` → 400 | Any handler raises `CattUserError` | 400, `status: error`, `error_type` matches class name |
| 9.2 | `CastError` → 400 | Device not found | 400, `error_type: CastError` |
| 9.3 | `ControllerError` → 400 | Unsupported action on controller | 400, `error_type: ControllerError` |
| 9.4 | Internal `CattError` → 500 | e.g. `ListenerError` raised | 500, `status: error` |
| 9.5 | Unexpected exception → 500 | Handler raises `RuntimeError` | 500, `error_type: InternalError` |
| 9.6 | Response always has `status` field | All responses | `status` is always `"success"` or `"error"` |
| 9.7 | Timeout → 504 | Handler takes longer than `--timeout` | 504, `error_type: TimeoutError` |

---

## 10. Response Shape and JSON Validity

| # | Test | Expected |
|---|---|---|
| 10.1 | Success with data | `{"status": "success", "data": {...}}` |
| 10.2 | Success without data | `{"status": "success", "data": null}` |
| 10.3 | Error response | `{"status": "error", "error": "...", "error_type": "..."}` |
| 10.4 | Content-Type header | `application/json` on all responses, including errors |
| 10.5 | All responses are valid JSON | `json.loads(response.data)` must not raise for every response |
| 10.6 | `info` response is serialisable | Non-serialisable types (UUID, datetime, etc.) converted to strings |
| 10.7 | 400 errors return JSON | Validation errors return JSON, not HTML or plain text |
| 10.8 | 500 errors return JSON | Unhandled exceptions return JSON, not Flask's default HTML error page |
| 10.9 | `status` field always present | All responses contain `status` as either `"success"` or `"error"` |
