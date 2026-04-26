import argparse
import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from threading import Thread
from uuid import UUID
from datetime import datetime, date

from flask import Flask, request, jsonify
from gtts import gTTS

from catt.controllers import setup_cast
from catt.error import CattError, CattUserError
from catt.http_server import serve_file
from catt.subs_info import SubsInfo
from catt.util import hunt_subtitles

TTS_FILE = "/tmp/cast_tts.mp3"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
executor = ThreadPoolExecutor(max_workers=4)
request_timeout = 30


def _ok(data=None):
    return jsonify({"status": "success", "data": data}), 200


def _err(msg, error_type, status):
    return jsonify({"status": "error", "error": msg, "error_type": error_type}), status


def _serialisable(obj):
    if isinstance(obj, dict):
        return {k: _serialisable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialisable(v) for v in obj]
    if isinstance(obj, (UUID, datetime, date)):
        return str(obj)
    return obj


def _create_server_thread(filename, address, port, content_type=None, single_req=False):
    thr = Thread(target=serve_file, args=(filename, address, port, content_type, single_req))
    thr.daemon = True
    thr.start()
    return thr


def _handle_cast(body):
    value = body.get("value")
    if not value:
        raise _ValidationError("'value' is required for cast")

    device = body.get("device")
    title = body.get("title")
    subtitle_url = body.get("subtitle_url")
    content_type = body.get("content_type")
    stream_type = body.get("stream_type")
    force_default = body.get("force_default", False)
    ytdl_options = body.get("ytdl_options")

    ytdl_opts = tuple(ytdl_options.items()) if ytdl_options else ()
    controller = "default" if force_default or ytdl_opts else None

    cst, stream = setup_cast(
        device,
        video_url=value,
        prep="app",
        controller=controller,
        ytdl_options=ytdl_opts or None,
        stream_type=stream_type,
    )

    subs = None
    if stream.is_local_file:
        _create_server_thread(
            value,
            stream.local_ip,
            stream.port,
            stream.guessed_content_type,
            single_req=(stream.guessed_content_category == "image"),
        )
        if not subtitle_url:
            subtitle_url = hunt_subtitles(value)

    if subtitle_url:
        subs = SubsInfo(subtitle_url, stream.local_ip, stream.port + 1)
        if subs.local_subs:
            _create_server_thread(subs.file, subs.local_ip, subs.port, single_req=True)

    cst.play_media_url(
        stream.video_url,
        title=title or stream.video_title,
        content_type=content_type or stream.guessed_content_type,
        subtitles=subs.url if subs else None,
        thumb=stream.video_thumbnail,
        stream_type=getattr(stream, "stream_type", None),
        media_info=getattr(stream, "media_info", None),
    )

    return _ok({"message": "Casting {} on {}".format(value, cst.cc_name)})


def _handle_cast_site(body):
    value = body.get("value")
    if not value:
        raise _ValidationError("'value' is required for cast_site")

    device = body.get("device")
    cst = setup_cast(device, controller="dashcast", action="load_url", prep="app")
    cst.load_url(value)
    return _ok({"message": "Casting site {} on {}".format(value, cst.cc_name)})


def _handle_pause(body):
    cst = setup_cast(body.get("device"), action="pause", prep="control")
    cst.pause()
    return _ok({"message": "OK"})


def _handle_play(body):
    cst = setup_cast(body.get("device"), action="play", prep="control")
    cst.play()
    return _ok({"message": "OK"})


def _handle_play_toggle(body):
    cst = setup_cast(body.get("device"), action="play_toggle", prep="control")
    cst.play_toggle()
    return _ok({"message": "OK"})


def _handle_stop(body):
    force = bool(body.get("value", False))
    cst = setup_cast(body.get("device"))
    cst.kill(force=force)
    return _ok({"message": "OK"})


def _handle_rewind(body):
    seconds = int(body.get("value", 30))
    cst = setup_cast(body.get("device"), action="rewind", prep="control")
    cst.rewind(seconds)
    return _ok({"message": "OK"})


def _handle_ffwd(body):
    seconds = int(body.get("value", 30))
    cst = setup_cast(body.get("device"), action="ffwd", prep="control")
    cst.ffwd(seconds)
    return _ok({"message": "OK"})


def _handle_volume(body):
    value = body.get("value")
    if value is None:
        raise _ValidationError("'value' is required for volume")
    level = int(value)
    if not 0 <= level <= 100:
        raise _ValidationError("'value' must be between 0 and 100")
    cst = setup_cast(body.get("device"))
    cst.volume(level / 100.0)
    return _ok({"volume_level": level})


def _handle_volumeup(body):
    value = body.get("value", 10)
    delta = int(value)
    if delta < 1 or delta > 100:
        raise _ValidationError("'value' must be between 1 and 100")
    cst = setup_cast(body.get("device"))
    cst.volumeup(delta / 100.0)
    return _ok({"message": "OK"})


def _handle_volumedown(body):
    delta = int(body.get("value", 10))
    cst = setup_cast(body.get("device"))
    cst.volumedown(delta / 100.0)
    return _ok({"message": "OK"})


def _handle_volumemute(body):
    muted = bool(body.get("value", True))
    cst = setup_cast(body.get("device"))
    cst.volumemute(muted)
    return _ok({"volume_muted": muted})


def _handle_tts(body):
    value = body.get("value")
    if not value:
        raise _ValidationError("'value' is required for tts")
    gTTS(value).save(TTS_FILE)
    return _handle_cast({**body, "value": TTS_FILE, "title": "TTS"})


def _handle_status(body):
    cst = setup_cast(body.get("device"), prep="info")
    return _ok(_serialisable(cst.cast_info))


def _handle_info(body):
    cst = setup_cast(body.get("device"), prep="info")
    return _ok(_serialisable(cst.info))


ACTION_HANDLERS = {
    "cast": _handle_cast,
    "cast_site": _handle_cast_site,
    "pause": _handle_pause,
    "play": _handle_play,
    "play_toggle": _handle_play_toggle,
    "stop": _handle_stop,
    "rewind": _handle_rewind,
    "ffwd": _handle_ffwd,
    "volume": _handle_volume,
    "volumeup": _handle_volumeup,
    "volumedown": _handle_volumedown,
    "volumemute": _handle_volumemute,
    "tts": _handle_tts,
    "status": _handle_status,
    "info": _handle_info,
}


class _ValidationError(Exception):
    pass


@app.route("/catt", methods=["POST"])
def handle_catt():
    body = request.get_json(silent=True)
    if body is None:
        return _err("Request body must be valid JSON", "ValidationError", 400)

    command = body.get("command")
    if not command:
        return _err("'command' field is required", "ValidationError", 400)

    handler = ACTION_HANDLERS.get(command.lower())
    if not handler:
        return _err("Unknown command: {}".format(command), "ValidationError", 400)

    cmd = command.lower()
    logger.info("command=%s device=%s", cmd, body.get("device"))

    def run_in_context():
        with app.app_context():
            return handler(body)

    future = executor.submit(run_in_context)
    try:
        response = future.result(timeout=request_timeout)
        logger.info("command=%s status=ok", cmd)
        return response
    except FuturesTimeoutError:
        logger.error("command=%s timed out after %ss", cmd, request_timeout)
        return _err("Request timed out after {}s".format(request_timeout), "TimeoutError", 504)
    except _ValidationError as e:
        logger.warning("command=%s validation_error=%s", cmd, e)
        return _err(str(e), "ValidationError", 400)
    except CattUserError as e:
        logger.warning("command=%s error=%s type=%s", cmd, e, type(e).__name__)
        return _err(str(e), type(e).__name__, 400)
    except CattError as e:
        logger.error("command=%s error=%s type=%s", cmd, e, type(e).__name__)
        return _err(str(e), type(e).__name__, 500)
    except Exception as e:
        logger.exception("command=%s unhandled exception", cmd)
        return _err(str(e), "InternalError", 500)


@app.errorhandler(400)
def bad_request(e):
    return _err(str(e), "BadRequest", 400)


@app.errorhandler(500)
def internal_error(e):
    return _err(str(e), "InternalError", 500)


def main():
    parser = argparse.ArgumentParser(description="catt REST API server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    global request_timeout
    request_timeout = args.timeout
    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
