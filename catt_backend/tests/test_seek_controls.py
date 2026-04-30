from catt.error import CastError


def test_rewind_default(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "rewind", "device": "Kitchen"})
    assert r.status_code == 200
    assert r.get_json()["data"] == {"message": "OK"}
    mock_cast.rewind.assert_called_once_with(30)


def test_rewind_custom(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "rewind", "device": "Kitchen", "value": 60})
    assert r.status_code == 200
    mock_cast.rewind.assert_called_once_with(60)


def test_rewind_not_seekable(client, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: (_ for _ in ()).throw(CastError("Not seekable")))
    r = client.post("/catt", json={"command": "rewind", "device": "Kitchen"})
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "CastError"


def test_ffwd_default(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "ffwd", "device": "Kitchen"})
    assert r.status_code == 200
    mock_cast.ffwd.assert_called_once_with(30)


def test_ffwd_custom(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "ffwd", "device": "Kitchen", "value": 15})
    assert r.status_code == 200
    mock_cast.ffwd.assert_called_once_with(15)
