from unittest.mock import patch, MagicMock
from catt.error import CastError, ExtractionError


def _setup(monkeypatch, mock_cast, mock_stream):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: (mock_cast, mock_stream))
    monkeypatch.setattr("app.hunt_subtitles", lambda v: None)


def test_cast_missing_value(client):
    r = client.post("/catt", json={"command": "cast"})
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "ValidationError"


def test_cast_valid_remote_url(client, mock_cast, mock_stream, monkeypatch):
    _setup(monkeypatch, mock_cast, mock_stream)
    r = client.post("/catt", json={"command": "cast", "device": "Kitchen", "value": "https://example.com/v.mp4"})
    assert r.status_code == 200
    body = r.get_json()
    assert body["status"] == "success"
    assert "https://example.com/v.mp4" in body["data"]["message"]
    assert mock_cast.cc_name in body["data"]["message"]


def test_cast_with_title(client, mock_cast, mock_stream, monkeypatch):
    _setup(monkeypatch, mock_cast, mock_stream)
    client.post("/catt", json={"command": "cast", "device": "Kitchen", "value": "https://example.com/v.mp4", "title": "My Video"})
    _, kwargs = mock_cast.play_media_url.call_args
    assert kwargs["title"] == "My Video"


def test_cast_with_subtitle_url(client, mock_cast, mock_stream, monkeypatch):
    mock_subs = MagicMock()
    mock_subs.local_subs = False
    mock_subs.url = "https://example.com/subs.vtt"

    _setup(monkeypatch, mock_cast, mock_stream)
    monkeypatch.setattr("app.SubsInfo", lambda *a, **kw: mock_subs)

    client.post("/catt", json={"command": "cast", "device": "Kitchen", "value": "https://example.com/v.mp4", "subtitle_url": "https://example.com/subs.vtt"})
    _, kwargs = mock_cast.play_media_url.call_args
    assert kwargs["subtitles"] == "https://example.com/subs.vtt"


def test_cast_force_default(client, mock_cast, mock_stream, monkeypatch):
    captured = {}

    def fake_setup_cast(device, **kw):
        captured.update(kw)
        return mock_cast, mock_stream

    monkeypatch.setattr("app.setup_cast", fake_setup_cast)
    monkeypatch.setattr("app.hunt_subtitles", lambda v: None)

    client.post("/catt", json={"command": "cast", "device": "Kitchen", "value": "https://example.com/v.mp4", "force_default": True})
    assert captured.get("controller") == "default"


def test_cast_with_ytdl_options(client, mock_cast, mock_stream, monkeypatch):
    captured = {}

    def fake_setup_cast(device, **kw):
        captured.update(kw)
        return mock_cast, mock_stream

    monkeypatch.setattr("app.setup_cast", fake_setup_cast)
    monkeypatch.setattr("app.hunt_subtitles", lambda v: None)

    client.post("/catt", json={"command": "cast", "device": "Kitchen", "value": "https://example.com/v.mp4", "ytdl_options": {"format": "bestaudio"}})
    assert captured.get("ytdl_options") == (("format", "bestaudio"),)


def test_cast_device_not_found(client, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: (_ for _ in ()).throw(CastError("Device not found")))
    r = client.post("/catt", json={"command": "cast", "device": "Nowhere", "value": "https://example.com/v.mp4"})
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "CastError"


def test_cast_extraction_failure(client, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: (_ for _ in ()).throw(ExtractionError("Not found")))
    r = client.post("/catt", json={"command": "cast", "device": "Kitchen", "value": "https://example.com/v.mp4"})
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "ExtractionError"
