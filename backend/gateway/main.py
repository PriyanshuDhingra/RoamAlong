"""Gateway entry point: the app session WebSocket (§3.4), map data endpoints, and the web debug client (§15.2)."""

import contextlib
import hmac
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT / "protocol" / "gen" / "py"))
from messages import Error, Hello, UplinkMessage

from backend.director.tours import load_tours
from backend.gateway.session import GuideSession
from backend.geo.working_set import TALKABLE, WorkingSet

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
app = FastAPI(title="Wander Gateway")
WS = WorkingSet.load()
TOURS = load_tours(WS)


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.get("/v1/tours")
async def tours() -> list[dict]:
    return [t.summary() for t in TOURS.values()]


@app.get("/v1/places/heroes")
async def heroes() -> dict:
    return {"type": "FeatureCollection", "features": [p.feature() for p in WS.heroes()]}


@app.get("/v1/places/near")
async def near(lat: float, lon: float, r: float = 400) -> dict:
    """Talkable places with geometry around a point, so the map can highlight them instantly (§7.3)."""
    feats = [n.place.feature() for n in WS.nearby(lat, lon, None, min(r, 1000), TALKABLE)]
    return {"type": "FeatureCollection", "features": feats}


@app.get("/v1/places/{entity_id}")
async def place(entity_id: str) -> dict:
    p = WS.by_id.get(entity_id)
    if p is None:
        raise HTTPException(404, "unknown entity")
    return p.feature()


@app.websocket("/v1/session")
async def session(ws: WebSocket) -> None:
    # Shared access token (§3.4 `?token=`): required when WANDER_ACCESS_TOKEN is set, e.g. behind a public tunnel,
    # so a leaked URL can't spend the Boson credits.
    expected = os.environ.get("WANDER_ACCESS_TOKEN")
    if expected and not hmac.compare_digest(ws.query_params.get("token", ""), expected):
        await ws.close(code=1008)
        return
    await ws.accept()
    try:
        hello = UplinkMessage.model_validate_json(await ws.receive_text()).root
    except ValidationError as e:
        await _send(ws, Error(type="error", code="bad_message", message=str(e)[:500], fatal=True))
        await ws.close(code=1008)
        return
    if not isinstance(hello, Hello):
        await _send(ws, Error(type="error", code="bad_message", message="first message must be hello", fatal=True))
        await ws.close(code=1008)
        return
    try:
        await GuideSession(ws, WS, hello, TOURS).run()
    finally:
        with contextlib.suppress(RuntimeError, WebSocketDisconnect):  # already closed by the client
            await ws.close()


async def _send(ws: WebSocket, msg) -> None:
    await ws.send_text(msg.model_dump_json(exclude_none=True))


DEBUG_WEB = ROOT / "apps" / "debug-web"
if (DEBUG_WEB / "index.html").exists():
    app.mount("/debug", StaticFiles(directory=DEBUG_WEB, html=True), name="debug")

    @app.get("/")
    async def root() -> RedirectResponse:
        return RedirectResponse("/debug/")
