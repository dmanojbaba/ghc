import json
from uuid import UUID
from datetime import datetime
from catt.error import CastError


def test_status_valid(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "status", "device": "Kitchen"})
    assert r.status_code == 200
    data = r.get_json()["data"]
    assert "volume_level" in data
    assert "volume_muted" in data


def test_status_device_inactive(client, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: (_ for _ in ()).throw(CastError("Device inactive")))
    r = client.post("/catt", json={"command": "status", "device": "Kitchen"})
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "CastError"


def test_info_valid(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "info", "device": "Kitchen"})
    assert r.status_code == 200
    data = r.get_json()["data"]
    assert "content_id" in data


def test_info_serialisable(client, mock_cast, monkeypatch):
    mock_cast.info = {
        "uuid": UUID("12345678-1234-5678-1234-567812345678"),
        "timestamp": datetime(2024, 1, 1, 12, 0, 0),
        "title": "Test",
    }
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "info", "device": "Kitchen"})
    assert r.status_code == 200
    body = json.loads(r.data)
    assert isinstance(body["data"]["uuid"], str)
    assert isinstance(body["data"]["timestamp"], str)
