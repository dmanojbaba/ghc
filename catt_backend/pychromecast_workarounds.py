# Workaround for https://github.com/home-assistant-libs/pychromecast/issues/866
#
# pychromecast stops the Zeroconf instance after discovery, but the socket client's
# background thread keeps a reference to it and calls zconf.get_service_info() on
# reconnect, causing AssertionError: "Zeroconf instance loop must be running".
#
# Fix: disconnect the cast after each request to stop the background thread before
# it can spin on the dead Zeroconf.
#
# TO REMOVE THIS WORKAROUND (once pychromecast#866 is fixed and catt's discovery.py
# no longer calls browser.stop_discovery() while cast connections are still alive):
#   1. Delete this file.
#   2. In app.py, replace:
#        from pychromecast_workarounds import setup_cast, disconnect_after_request
#      with:
#        from catt.controllers import setup_cast
#   3. In app.py, remove the try/finally block in run_in_context, leaving just:
#        return handler(body)
#   4. No Dockerfile change needed — it uses COPY *.py ./ and picks up deletions automatically.

from threading import local

from catt.controllers import setup_cast as _setup_cast

_thread_local = local()


def setup_cast(*args, **kwargs):
    result = _setup_cast(*args, **kwargs)
    cast = result[0] if isinstance(result, tuple) else result
    _thread_local.cast = cast._cast
    return result


def disconnect_after_request():
    cast = getattr(_thread_local, "cast", None)
    if cast:
        cast.disconnect()
        _thread_local.cast = None
