import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from unittest.mock import MagicMock
import pytest
from app import app


@pytest.fixture
def client():
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


@pytest.fixture
def mock_cast():
    cst = MagicMock()
    cst.cc_name = "Living Room"
    cst.cast_info = {
        "volume_level": "50",
        "volume_muted": False,
        "title": "Test Video",
        "player_state": "PLAYING",
    }
    cst.info = {**cst.cast_info, "content_id": "https://example.com/video.mp4"}
    return cst


@pytest.fixture
def mock_stream():
    stream = MagicMock()
    stream.is_local_file = False
    stream.is_playlist = False
    stream.video_url = "https://example.com/video.mp4"
    stream.video_title = "Test Video"
    stream.video_thumbnail = None
    stream.guessed_content_type = "video/mp4"
    stream.guessed_content_category = "video"
    stream.local_ip = "192.168.1.10"
    stream.port = 45114
    stream.stream_type = None
    stream.media_info = None
    return stream
