from catt.error import CastError


def test_cast_site_missing_value(client):
    r = client.post("/catt", json={"command": "cast_site"})
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "ValidationError"


def test_cast_site_valid_url(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "cast_site", "device": "Kitchen", "value": "https://example.com"})
    assert r.status_code == 200
    mock_cast.load_url.assert_called_once_with("https://example.com")


def test_cast_site_uses_dashcast_controller(client, mock_cast, monkeypatch):
    captured = {}

    def fake_setup_cast(device, **kw):
        captured.update(kw)
        return mock_cast

    monkeypatch.setattr("app.setup_cast", fake_setup_cast)
    client.post("/catt", json={"command": "cast_site", "device": "Kitchen", "value": "https://example.com"})
    assert captured.get("controller") == "dashcast"
    assert captured.get("prep") == "app"
