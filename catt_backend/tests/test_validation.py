import json


def test_missing_command(client):
    r = client.post("/catt", json={})
    assert r.status_code == 400
    body = r.get_json()
    assert body["status"] == "error"
    assert body["error_type"] == "ValidationError"


def test_unknown_command(client):
    r = client.post("/catt", json={"command": "bogus"})
    assert r.status_code == 400
    body = r.get_json()
    assert body["status"] == "error"
    assert body["error_type"] == "ValidationError"


def test_empty_body(client):
    r = client.post("/catt", data="", content_type="application/json")
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "ValidationError"


def test_malformed_json(client):
    r = client.post("/catt", data="{invalid}", content_type="application/json")
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "ValidationError"


def test_valid_command_no_device_delegates(client, mock_cast, mock_stream, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "pause"})
    assert r.status_code == 200


def test_command_uppercase(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "PAUSE"})
    assert r.status_code == 200


def test_command_mixed_case(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "Pause"})
    assert r.status_code == 200


def test_command_uppercase_with_underscore(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "PLAY_TOGGLE"})
    assert r.status_code == 200
