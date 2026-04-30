from unittest.mock import patch, MagicMock


def _setup(monkeypatch, mock_cast, mock_stream):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: (mock_cast, mock_stream))
    monkeypatch.setattr("app.hunt_subtitles", lambda v: None)


def test_tts_missing_value(client):
    r = client.post("/catt", json={"command": "tts"})
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "ValidationError"


def test_tts_generates_and_casts(client, mock_cast, mock_stream, monkeypatch):
    _setup(monkeypatch, mock_cast, mock_stream)
    mock_gtts = MagicMock()
    monkeypatch.setattr("app.gTTS", lambda text: mock_gtts)

    r = client.post("/catt", json={"command": "tts", "device": "Kitchen", "value": "hello world"})

    assert r.status_code == 200
    mock_gtts.save.assert_called_once_with("/tmp/cast_tts.mp3")
    _, kwargs = mock_cast.play_media_url.call_args
    assert kwargs["title"] == "TTS"


def test_tts_casts_to_tts_file_path(client, mock_cast, mock_stream, monkeypatch):
    _setup(monkeypatch, mock_cast, mock_stream)
    mock_gtts = MagicMock()
    monkeypatch.setattr("app.gTTS", lambda text: mock_gtts)

    r = client.post("/catt", json={"command": "tts", "device": "Kitchen", "value": "hello"})

    assert r.status_code == 200
    body = r.get_json()
    assert "/tmp/cast_tts.mp3" in body["data"]["message"]


def test_tts_passes_device(client, mock_cast, mock_stream, monkeypatch):
    captured = {}

    def fake_setup_cast(device, **kw):
        captured["device"] = device
        return mock_cast, mock_stream

    monkeypatch.setattr("app.setup_cast", fake_setup_cast)
    monkeypatch.setattr("app.hunt_subtitles", lambda v: None)
    monkeypatch.setattr("app.gTTS", lambda text: MagicMock())

    client.post("/catt", json={"command": "tts", "device": "Bedroom", "value": "wake up"})
    assert captured["device"] == "Bedroom"
