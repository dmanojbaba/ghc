def test_volume_missing_value(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "volume", "device": "Kitchen"})
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "ValidationError"


def test_volume_valid(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "volume", "device": "Kitchen", "value": 50})
    assert r.status_code == 200
    mock_cast.volume.assert_called_once_with(0.5)
    assert r.get_json()["data"] == {"volume_level": 50}


def test_volume_boundary_zero(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "volume", "device": "Kitchen", "value": 0})
    assert r.status_code == 200
    mock_cast.volume.assert_called_once_with(0.0)
    assert r.get_json()["data"] == {"volume_level": 0}


def test_volume_boundary_hundred(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "volume", "device": "Kitchen", "value": 100})
    assert r.status_code == 200
    mock_cast.volume.assert_called_once_with(1.0)
    assert r.get_json()["data"] == {"volume_level": 100}


def test_volume_out_of_range_high(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "volume", "device": "Kitchen", "value": 101})
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "ValidationError"


def test_volume_out_of_range_low(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "volume", "device": "Kitchen", "value": -1})
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "ValidationError"


def test_volumeup_default(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "volumeup", "device": "Kitchen"})
    assert r.status_code == 200
    mock_cast.volumeup.assert_called_once_with(0.1)
    assert r.get_json()["data"] == {"message": "OK"}


def test_volumeup_custom(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "volumeup", "device": "Kitchen", "value": 20})
    assert r.status_code == 200
    mock_cast.volumeup.assert_called_once_with(0.2)


def test_volumeup_out_of_range_zero(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "volumeup", "device": "Kitchen", "value": 0})
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "ValidationError"


def test_volumedown_default(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "volumedown", "device": "Kitchen"})
    assert r.status_code == 200
    mock_cast.volumedown.assert_called_once_with(0.1)
    assert r.get_json()["data"] == {"message": "OK"}


def test_volumedown_custom(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "volumedown", "device": "Kitchen", "value": 20})
    assert r.status_code == 200
    mock_cast.volumedown.assert_called_once_with(0.2)


def test_volumemute_default(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "volumemute", "device": "Kitchen"})
    assert r.status_code == 200
    mock_cast.volumemute.assert_called_once_with(True)
    assert r.get_json()["data"] == {"volume_muted": True}


def test_volumemute_explicit_unmute(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "volumemute", "device": "Kitchen", "value": False})
    assert r.status_code == 200
    mock_cast.volumemute.assert_called_once_with(False)
    assert r.get_json()["data"] == {"volume_muted": False}
