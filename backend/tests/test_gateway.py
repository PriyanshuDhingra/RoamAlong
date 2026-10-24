import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from backend.gateway import main
from backend.gateway.session import detect_script_language

client = TestClient(main.app)


def test_health():
    assert client.get("/health").json() == {"ok": True}


def test_hello_starts_a_guide_session(monkeypatch):
    started = {}

    async def fake_run(self):  # don't open a real Boson socket in unit tests
        started["mode"] = self.mode
        await self.send_app({"type": "ready", "session_id": self.session_id, "voice": "default", "mode": self.mode})

    monkeypatch.setattr(main.GuideSession, "run", fake_run)
    with client.websocket_connect("/v1/session") as ws:
        ws.send_text('{"type":"hello","device_id":"d","mode":"tour","ui_lang":"en","app_version":"0.1.0"}')
        msg = ws.receive_json()
    assert msg["type"] == "ready" and started["mode"] == "tour"


def test_non_hello_first_is_rejected():
    with client.websocket_connect("/v1/session") as ws:
        ws.send_text('{"type":"control","action":"mute_mic"}')
        msg = ws.receive_json()
    assert msg["type"] == "error" and msg["code"] == "bad_message"


def test_places_endpoints():
    heroes = client.get("/v1/places/heroes").json()
    assert len(heroes["features"]) == 25
    near = client.get("/v1/places/near", params={"lat": 43.6625, "lon": -79.3940, "r": 150}).json()
    assert any(f["properties"]["name"] == "University College" for f in near["features"])


@pytest.mark.parametrize("text,expected", [
    ("Et c'était construit quand, exactement?", "en"),  # one cue word only: keep current
    ("C'est quoi le nom de ce bâtiment et qui l'a construit?", "fr"),
    ("هل يمكنك أن تخبرني المزيد عن تاريخه؟", "ar"),
    ("क्या पास में कोई अच्छा संग्रहालय है?", "hi"),
    ("What does 'Yorkville' mean, and where is it?", "en"),
    ("oui?", "en"),
])
def test_language_tracking(text, expected):
    assert detect_script_language(text, "en") == expected
