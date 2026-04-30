from catt.error import CastError


def test_pause(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "pause", "device": "Kitchen"})
    assert r.status_code == 200
    assert r.get_json()["data"] == {"message": "OK"}
    mock_cast.pause.assert_called_once()


def test_pause_nothing_playing(client, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: (_ for _ in ()).throw(CastError("Nothing is currently playing")))
    r = client.post("/catt", json={"command": "pause", "device": "Kitchen"})
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "CastError"


def test_play(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "play", "device": "Kitchen"})
    assert r.status_code == 200
    assert r.get_json()["data"] == {"message": "OK"}
    mock_cast.play.assert_called_once()


def test_play_toggle(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "play_toggle", "device": "Kitchen"})
    assert r.status_code == 200
    assert r.get_json()["data"] == {"message": "OK"}
    mock_cast.play_toggle.assert_called_once()


def test_stop_default(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "stop", "device": "Kitchen"})
    assert r.status_code == 200
    mock_cast.kill.assert_called_once_with(force=False)


def test_stop_with_force(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "stop", "device": "Kitchen", "value": True})
    assert r.status_code == 200
    mock_cast.kill.assert_called_once_with(force=True)
