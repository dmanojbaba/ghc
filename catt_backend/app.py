import argparse
import logging
import os
import random
import socketserver
import subprocess
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from http.server import BaseHTTPRequestHandler
from threading import Event, Thread
from uuid import UUID
from datetime import datetime, date

from flask import Flask, request, jsonify
from gtts import gTTS

from catt.error import CattError, CattUserError
from catt.http_server import serve_file
from catt.subs_info import SubsInfo
from catt.util import get_local_ip, hunt_subtitles

# Workaround import — see pychromecast_workarounds.py for removal instructions.
from pychromecast_workarounds import setup_cast, disconnect_after_request

TTS_FILE = "/tmp/cast_tts.mp3"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

# pychromecast logs are noisy (reconnects, app start/stop, mDNS discovery) and not actionable.
logging.getLogger("pychromecast").setLevel(logging.WARNING)

app = Flask(__name__)
executor = ThreadPoolExecutor(max_workers=4)
request_timeout = 45


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
    thr = Thread(
        target=serve_file, args=(filename, address, port, content_type, single_req)
    )
    thr.daemon = True
    thr.start()
    return thr


def _is_hls_url(value: str) -> bool:
    """True when value is a remote URL pointing to an HLS manifest."""
    lower = value.lower()
    return lower.startswith(("http://", "https://")) and (
        lower.endswith(".m3u8") or ".m3u8?" in lower
    )


def _serve_ffmpeg_pipe(
    m3u8_url: str, address: str, port: int, ready_event: Event = None
) -> None:
    """
    Start ffmpeg, remux the HLS stream to fragmented MP4 on stdout,
    and serve exactly one HTTP GET request from that pipe.
    Runs in a daemon thread; terminates when the client disconnects.

    Blocks reading the first chunk from ffmpeg before signalling ready_event so
    the Chromecast always connects to a server that has data immediately available.
    """
    proc = subprocess.Popen(
        [
            "ffmpeg",
            "-i",
            m3u8_url,
            "-c",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
            "-f",
            "mp4",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            "-loglevel",
            "error",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    logger.info("hls ffmpeg_started url=%s pid=%s port=%s", m3u8_url, proc.pid, port)

    # Block until ffmpeg produces its first chunk (fMP4 header + first fragment).
    # This guarantees the Chromecast gets data the moment it connects.
    first_chunk = proc.stdout.read(64 * 1024)
    if not first_chunk:
        stderr_out = proc.stderr.read().decode(errors="replace").strip()
        logger.error("hls ffmpeg_no_data url=%s stderr=%r", m3u8_url, stderr_out)
    else:
        logger.info(
            "hls ffmpeg_ready url=%s first_chunk_bytes=%d", m3u8_url, len(first_chunk)
        )
    if ready_event is not None:
        ready_event.set()

    class _PipeHandler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            try:
                if first_chunk:
                    self.wfile.write(first_chunk)
                    self.wfile.flush()
                while True:
                    chunk = proc.stdout.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                logger.info("hls client_disconnected url=%s", m3u8_url)

        def log_message(self, fmt, *args):  # suppress per-request log lines
            pass

    try:
        with socketserver.TCPServer((address, port), _PipeHandler) as httpd:
            logger.info("hls pipe_server_ready url=%s port=%s", m3u8_url, port)
            httpd.handle_request()  # blocks until the one client disconnects
        logger.info("hls pipe_server_done url=%s", m3u8_url)
    finally:
        proc.terminate()
        stderr_out = proc.stderr.read().decode(errors="replace").strip()
        if stderr_out:
            logger.warning("hls ffmpeg_stderr url=%s stderr=%r", m3u8_url, stderr_out)
        proc.wait(timeout=5)
        logger.info(
            "hls ffmpeg_terminated url=%s returncode=%s", m3u8_url, proc.returncode
        )


def _handle_hls_cast(body: dict):
    value = body["value"]  # validated by caller
    device = body.get("device")
    title = body.get("title") or "HLS Stream"

    # Connect to the cast device without running yt-dlp on the .m3u8 URL.
    # setup_cast(device, video_url=None) returns just the controller (not a tuple).
    cst = setup_cast(device, prep="app")

    local_ip = get_local_ip(cst._cast.cast_info.host)
    port = random.randrange(45000, 47000)
    cast_url = "http://{}:{}/stream.mp4".format(local_ip, port)
    logger.info(
        "hls cast_start url=%s device=%s cast_url=%s", value, cst.cc_name, cast_url
    )

    ready_event = Event()
    thr = Thread(
        target=_serve_ffmpeg_pipe,
        args=(value, local_ip, port, ready_event),
        daemon=True,
    )
    thr.start()

    # Wait until ffmpeg has produced its first chunk before telling the Chromecast
    # to connect. Timeout of 30 s covers slow remote servers; the overall
    # request_timeout of 45 s still applies as an outer bound.
    if not ready_event.wait(timeout=30):
        raise CattError(
            "HLS stream failed to produce data within 30s (url={})".format(value)
        )

    logger.info("hls sending_to_chromecast url=%s cast_url=%s", value, cast_url)

    cst.play_media_url(
        cast_url,
        title=title,
        content_type="video/mp4",
        stream_type=body.get("stream_type"),
    )
    return _ok({"message": "Casting {} on {}".format(value, cst.cc_name)})


def _handle_cast(body):
    value = body.get("value")
    if not value:
        raise _ValidationError("'value' is required for cast")

    if _is_hls_url(value):
        return _handle_hls_cast(body)

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
    secret = os.environ.get("CATT_BACKEND_SECRET")
    if secret and request.headers.get("X-Catt-Secret") != secret:
        return _err("Unauthorized", "Unauthorized", 401)

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
    logger.info("command=%s device=%s body=%s", cmd, body.get("device"), body)

    def run_in_context():
        with app.app_context():
            try:
                return handler(body)
            finally:
                disconnect_after_request()  # Workaround — see pychromecast_workarounds.py

    future = executor.submit(run_in_context)
    try:
        response = future.result(timeout=request_timeout)
        logger.info("command=%s status=ok", cmd)
        return response
    except FuturesTimeoutError:
        logger.error("command=%s timed out after %ss", cmd, request_timeout)
        return _err(
            "Request timed out after {}s".format(request_timeout), "TimeoutError", 504
        )
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
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    global request_timeout
    request_timeout = args.timeout
    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
