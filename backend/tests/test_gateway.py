import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from backend.gateway.main import app

client = TestClient(app)


def test_health():
    assert client.get("/health").json() == {"ok": True}


def test_hello_gets_ready():
    with client.websocket_connect("/v1/session") as ws:
        ws.send_text('{"type":"hello","device_id":"d","mode":"tour","ui_lang":"en","app_version":"0.1.0"}')
        msg = ws.receive_json()
    assert msg["type"] == "ready" and msg["mode"] == "tour"


def test_non_hello_first_is_rejected():
    with client.websocket_connect("/v1/session") as ws:
        ws.send_text('{"type":"control","action":"mute_mic"}')
        msg = ws.receive_json()
    assert msg["type"] == "error" and msg["code"] == "bad_message"
