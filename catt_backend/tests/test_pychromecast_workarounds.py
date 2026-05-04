import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from unittest.mock import MagicMock, patch
import pychromecast_workarounds as workarounds


def _make_cast_controller(raw_cast=None):
    controller = MagicMock()
    controller._cast = raw_cast or MagicMock()
    return controller


def test_setup_cast_stores_raw_cast_in_thread_local(monkeypatch):
    controller = _make_cast_controller()
    monkeypatch.setattr(workarounds, "_setup_cast", lambda *a, **kw: controller)
    workarounds._thread_local.cast = None

    workarounds.setup_cast("Kitchen")

    assert workarounds._thread_local.cast is controller._cast


def test_setup_cast_tuple_return_stores_raw_cast(monkeypatch):
    controller = _make_cast_controller()
    stream = MagicMock()
    monkeypatch.setattr(workarounds, "_setup_cast", lambda *a, **kw: (controller, stream))
    workarounds._thread_local.cast = None

    result = workarounds.setup_cast("Kitchen", video_url="https://example.com/v.mp4")

    assert result == (controller, stream)
    assert workarounds._thread_local.cast is controller._cast


def test_setup_cast_non_tuple_return_stores_raw_cast(monkeypatch):
    controller = _make_cast_controller()
    monkeypatch.setattr(workarounds, "_setup_cast", lambda *a, **kw: controller)
    workarounds._thread_local.cast = None

    result = workarounds.setup_cast("Kitchen")

    assert result is controller
    assert workarounds._thread_local.cast is controller._cast


def test_disconnect_after_request_calls_disconnect(monkeypatch):
    raw_cast = MagicMock()
    workarounds._thread_local.cast = raw_cast

    workarounds.disconnect_after_request()

    raw_cast.disconnect.assert_called_once_with()


def test_disconnect_after_request_clears_thread_local(monkeypatch):
    workarounds._thread_local.cast = MagicMock()

    workarounds.disconnect_after_request()

    assert workarounds._thread_local.cast is None


def test_disconnect_after_request_is_noop_when_no_cast():
    workarounds._thread_local.cast = None

    # Should not raise
    workarounds.disconnect_after_request()


def test_disconnect_after_request_is_noop_when_thread_local_unset():
    if hasattr(workarounds._thread_local, "cast"):
        del workarounds._thread_local.cast

    # Should not raise
    workarounds.disconnect_after_request()
