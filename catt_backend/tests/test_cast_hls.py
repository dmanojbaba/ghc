import pytest
from unittest.mock import MagicMock


def _make_ready_event():
    """Return a mock Event that reports ready immediately."""
    ev = MagicMock()
    ev.wait.return_value = True
    return ev


def _setup_hls(monkeypatch, mock_cast):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    monkeypatch.setattr("app.get_local_ip", lambda host: "192.168.1.10")
    monkeypatch.setattr("app._serve_ffmpeg_pipe", lambda *a: None)
    monkeypatch.setattr("app.Event", _make_ready_event)


def test_hls_url_routed_to_hls_handler(client, mock_cast, monkeypatch):
    """Remote .m3u8 URL reaches _handle_hls_cast, not the normal cast path."""
    _setup_hls(monkeypatch, mock_cast)
    r = client.post(
        "/catt", json={"command": "cast", "value": "https://example.com/stream.m3u8"}
    )
    assert r.status_code == 200
    assert "stream.m3u8" in r.get_json()["data"]["message"]


def test_hls_play_media_url_uses_local_mp4(client, mock_cast, monkeypatch):
    """play_media_url receives the pipe-server URL as first arg with content_type=video/mp4."""
    _setup_hls(monkeypatch, mock_cast)
    client.post(
        "/catt", json={"command": "cast", "value": "https://example.com/stream.m3u8"}
    )
    args, kwargs = mock_cast.play_media_url.call_args
    assert args[0].startswith("http://192.168.1.10:")
    assert args[0].endswith("/stream.mp4")
    assert kwargs["content_type"] == "video/mp4"


def test_hls_pipe_server_started_with_original_url(client, mock_cast, monkeypatch):
    """_serve_ffmpeg_pipe is called with the original .m3u8 URL."""
    pipe_calls = []
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    monkeypatch.setattr("app.get_local_ip", lambda host: "192.168.1.10")
    monkeypatch.setattr("app._serve_ffmpeg_pipe", lambda *a: pipe_calls.append(a))
    monkeypatch.setattr("app.Event", _make_ready_event)
    client.post(
        "/catt", json={"command": "cast", "value": "https://example.com/live.m3u8"}
    )
    assert len(pipe_calls) == 1
    assert pipe_calls[0][0] == "https://example.com/live.m3u8"


def test_hls_title_forwarded(client, mock_cast, monkeypatch):
    """Caller-supplied title is forwarded to play_media_url."""
    _setup_hls(monkeypatch, mock_cast)
    client.post(
        "/catt",
        json={
            "command": "cast",
            "value": "https://example.com/s.m3u8",
            "title": "My Stream",
        },
    )
    _, kwargs = mock_cast.play_media_url.call_args
    assert kwargs["title"] == "My Stream"


def test_hls_default_title_when_none_given(client, mock_cast, monkeypatch):
    """Default title 'HLS Stream' is used when caller omits title."""
    _setup_hls(monkeypatch, mock_cast)
    client.post(
        "/catt", json={"command": "cast", "value": "https://example.com/s.m3u8"}
    )
    _, kwargs = mock_cast.play_media_url.call_args
    assert kwargs["title"] == "HLS Stream"


def test_hls_query_string_url_detected(client, mock_cast, monkeypatch):
    """.m3u8 URLs with query parameters are recognised as HLS."""
    _setup_hls(monkeypatch, mock_cast)
    r = client.post(
        "/catt",
        json={
            "command": "cast",
            "value": "https://cdn.example.com/stream.m3u8?token=abc&ts=123",
        },
    )
    assert r.status_code == 200


def test_hls_query_string_url_passed_to_ffmpeg(client, mock_cast, monkeypatch):
    """The full URL including query string is passed to _serve_ffmpeg_pipe."""
    pipe_calls = []
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    monkeypatch.setattr("app.get_local_ip", lambda host: "192.168.1.10")
    monkeypatch.setattr("app._serve_ffmpeg_pipe", lambda *a: pipe_calls.append(a))
    monkeypatch.setattr("app.Event", _make_ready_event)
    url = "https://cdn.example.com/stream.m3u8?token=abc&ts=123"
    client.post("/catt", json={"command": "cast", "value": url})
    assert pipe_calls[0][0] == url


def test_non_hls_url_unaffected(client, mock_cast, mock_stream, monkeypatch):
    """A .mp4 URL does not trigger HLS handling."""
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: (mock_cast, mock_stream))
    monkeypatch.setattr("app.hunt_subtitles", lambda v: None)
    pipe_calls = []
    monkeypatch.setattr("app._serve_ffmpeg_pipe", lambda *a: pipe_calls.append(a))
    r = client.post(
        "/catt", json={"command": "cast", "value": "https://example.com/video.mp4"}
    )
    assert r.status_code == 200
    assert pipe_calls == []
