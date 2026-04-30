import json
import time
from catt.error import CattError, CattUserError, CastError, ControllerError, ListenerError
import app as app_module


def test_catt_user_error_returns_400(client, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: (_ for _ in ()).throw(CattUserError("user error")))
    r = client.post("/catt", json={"command": "pause", "device": "Kitchen"})
    assert r.status_code == 400
    body = r.get_json()
    assert body["status"] == "error"
    assert body["error_type"] == "CattUserError"


def test_cast_error_returns_400(client, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: (_ for _ in ()).throw(CastError("not found")))
    r = client.post("/catt", json={"command": "pause", "device": "Nowhere"})
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "CastError"


def test_controller_error_returns_400(client, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: (_ for _ in ()).throw(ControllerError("unsupported")))
    r = client.post("/catt", json={"command": "pause", "device": "Kitchen"})
    assert r.status_code == 400
    assert r.get_json()["error_type"] == "ControllerError"


def test_internal_catt_error_returns_500(client, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: (_ for _ in ()).throw(ListenerError("internal")))
    r = client.post("/catt", json={"command": "pause", "device": "Kitchen"})
    assert r.status_code == 500
    assert r.get_json()["status"] == "error"


def test_unexpected_exception_returns_500(client, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom")))
    r = client.post("/catt", json={"command": "pause", "device": "Kitchen"})
    assert r.status_code == 500
    assert r.get_json()["error_type"] == "InternalError"


def test_timeout_returns_504(client, monkeypatch):
    original_timeout = app_module.request_timeout
    app_module.request_timeout = 1

    def slow_cast(*a, **kw):
        time.sleep(5)

    monkeypatch.setattr("app.setup_cast", slow_cast)
    try:
        r = client.post("/catt", json={"command": "pause", "device": "Kitchen"})
        assert r.status_code == 504
        assert r.get_json()["error_type"] == "TimeoutError"
    finally:
        app_module.request_timeout = original_timeout


def test_status_field_always_present(client, mock_cast, monkeypatch):
    monkeypatch.setattr("app.setup_cast", lambda *a, **kw: mock_cast)
    r = client.post("/catt", json={"command": "pause", "device": "Kitchen"})
    assert "status" in r.get_json()
    assert r.get_json()["status"] in ("success", "error")
