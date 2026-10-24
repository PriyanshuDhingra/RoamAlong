"""Gateway entry point. Phase 0 stub: health check and the session WebSocket handshake only.

The Boson relay, Director hookup and tool loop land in Phase 1 (IMPLEMENTATION_PLAN.md §4, §16).
"""

import sys
import uuid
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "protocol" / "gen" / "py"))
from messages import Error, Hello, Ready, UplinkMessage

app = FastAPI(title="Wander Gateway")


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.websocket("/v1/session")
async def session(ws: WebSocket) -> None:
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

    await _send(ws, Ready(type="ready", session_id=f"s_{uuid.uuid4().hex[:12]}", voice="default", mode=hello.mode))
    try:
        while True:
            await ws.receive()  # Phase 1: route audio frames to Boson, JSON frames to the Director
    except (WebSocketDisconnect, RuntimeError):
        pass


async def _send(ws: WebSocket, msg) -> None:
    await ws.send_text(msg.model_dump_json(exclude_none=True))
