"""End-to-end smoke test against a running gateway (no mic): hello, a few location fixes walking past University
College, one typed question. Prints every downlink message type and the guide's transcripts.

    uv run python tools/smoke_gateway.py [ws://localhost:8000/v1/session]
"""

from __future__ import annotations

import asyncio
import json
import sys
import time

import websockets

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8000/v1/session"
# King's College Circle, walking north-east past University College towards Hart House
TRACK = [(43.66205, -79.39560), (43.66225, -79.39535), (43.66245, -79.39510), (43.66265, -79.39485),
         (43.66285, -79.39460)]


async def main() -> None:
    audio_bytes = 0
    seen: dict[str, int] = {}
    async with websockets.connect(URL, max_size=None) as ws:
        await ws.send(json.dumps({"type": "hello", "device_id": "smoke", "mode": "wander", "ui_lang": "en",
                                  "app_version": "smoke", "debug": True}))

        async def reader() -> None:
            nonlocal audio_bytes
            async for raw in ws:
                if isinstance(raw, bytes):
                    audio_bytes += len(raw) - 12
                    continue
                m = json.loads(raw)
                seen[m["type"]] = seen.get(m["type"], 0) + 1
                if m["type"] == "transcript" and m.get("final"):
                    print(f"  [{m['role']}] {m['text']}")
                elif m["type"] in ("map_focus", "card", "state", "error", "ready", "route"):
                    brief = {k: v for k, v in m.items() if k in ("guide_state", "title", "entities", "message", "code",
                                                                 "session_id", "eta_s")}
                    print(f"  <{m['type']}> {json.dumps(brief, ensure_ascii=False)[:200]}")
                elif m["type"] == "debug" and m["kind"] in ("director_decision", "tool_call", "tool_result",
                                                            "boson_error"):
                    print(f"  <debug:{m['kind']}> {json.dumps(m['payload'], ensure_ascii=False)[:200]}")

        task = asyncio.create_task(reader())
        for lat, lon in TRACK:
            await ws.send(json.dumps({"type": "location", "lat": lat, "lon": lon, "accuracy_m": 6, "speed_mps": 1.2,
                                      "ts": time.time() * 1000, "source": "sim"}))
            await asyncio.sleep(1)
        await asyncio.sleep(14)  # greeting
        await ws.send(json.dumps({"type": "text", "text": "Quick question: who designed the building on my left?"}))
        await asyncio.sleep(18)
        task.cancel()
    print(f"\nmessage counts: {seen}\naudio received: {audio_bytes / 48000:.1f} s")


if __name__ == "__main__":
    asyncio.run(main())
