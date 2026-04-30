import json
from uuid import UUID
from datetime import datetime
from catt.error import CastError


def test_success_with_data(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "status", "device": "Kitchen"})
    body = r.get_json()
    assert body["status"] == "success"
    assert isinstance(body["data"], dict)


def test_success_without_data(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "pause", "device": "Kitchen"})
    body = r.get_json()
    assert body["status"] == "success"


def test_error_response_shape(client):
    r = client.post("/catt", json={"command": "bogus"})
    body = r.get_json()
    assert body["status"] == "error"
    assert "error" in body
    assert "error_type" in body


def test_content_type_on_success(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "pause", "device": "Kitchen"})
    assert "application/json" in r.content_type


def test_content_type_on_error(client):
    r = client.post("/catt", json={"command": "bogus"})
    assert "application/json" in r.content_type


def test_all_responses_are_valid_json(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    for cmd in ["pause", "play", "play_toggle"]:
        r = client.post("/catt", json={"command": cmd, "device": "Kitchen"})
        json.loads(r.data)


def test_info_response_is_serialisable(client, mock_cast, monkeypatch):
    mock_cast.info = {
        "uuid": UUID("12345678-1234-5678-1234-567812345678"),
        "ts": datetime(2024, 6, 1),
        "name": "test",
    }
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "info", "device": "Kitchen"})
    body = json.loads(r.data)
    assert isinstance(body["data"]["uuid"], str)
    assert isinstance(body["data"]["ts"], str)


def test_validation_error_returns_json_not_html(client):
    r = client.post("/catt", json={})
    assert "application/json" in r.content_type
    body = json.loads(r.data)
    assert "status" in body


def test_status_field_is_always_ok_or_error(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    for json_body in [
        {"command": "pause", "device": "Kitchen"},
        {"command": "bogus"},
        {},
    ]:
        r = client.post("/catt", json=json_body)
        body = r.get_json()
        assert body["status"] in ("success", "error")
