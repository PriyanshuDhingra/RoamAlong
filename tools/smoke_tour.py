"""Tour-mode smoke test against a running gateway: start the Queen's Park tour, expect the intro, a route and tour
progress; then jump next to the first stop and expect the arrival story and the leg to stop 2.

    uv run python tools/smoke_tour.py [ws://localhost:8000/v1/session]
"""

from __future__ import annotations

import asyncio
import json
import sys
import time

import httpx
import websockets

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8000/v1/session"
HTTP = URL.replace("ws", "http", 1).rsplit("/v1/", 1)[0]


async def main() -> None:
    tours = httpx.get(f"{HTTP}/v1/tours").json()  # noqa: ASYNC210 — one call before the loop starts
    tour = next(t for t in tours if t["id"] == "queens-park-lost-river")
    first = tour["stops"][0]
    print(f"tour: {tour['title']} — {len(tour['stops'])} stops, {tour['distance_m']} m")
    async with websockets.connect(URL, max_size=None) as ws:
        await ws.send(json.dumps({"type": "hello", "device_id": "smoke", "mode": "wander", "ui_lang": "en",
                                  "app_version": "smoke", "debug": True}))

        async def fix(lat: float, lon: float) -> None:
            await ws.send(json.dumps({"type": "location", "lat": lat, "lon": lon, "accuracy_m": 6, "speed_mps": 0,
                                      "ts": time.time() * 1000, "source": "sim"}))

        async def reader() -> None:
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                m = json.loads(raw)
                if m["type"] == "transcript" and m.get("final") and m["role"] == "assistant":
                    print(f"  [guide] {m['text']}")
                elif m["type"] == "tour":
                    cur = m["stops"][m["current"]]["name"] if m["status"] == "active" else "—"
                    print(f"  <tour> {m['status']} stop {m['current'] + 1}: {cur}, eta {m.get('leg_eta_min')} min")
                elif m["type"] == "route":
                    print(f"  <route> {'cleared' if m.get('cleared') else f'{len(m[chr(109) + 'aneuvers'])} steps'}")
                elif m["type"] == "debug" and m["kind"] in ("director_decision", "boson_error"):
                    print(f"  <{m['kind']}> {json.dumps(m['payload'])[:160]}")

        task = asyncio.create_task(reader())
        await fix(43.66205, -79.39560)  # King's College Circle
        await asyncio.sleep(1)
        await ws.send(json.dumps({"type": "ui", "action": "start_tour", "tour_id": tour["id"]}))
        for _ in range(20):
            await fix(43.66205, -79.39560)
            await asyncio.sleep(1)
        print("-- arriving at stop 1")
        for _ in range(35):
            await fix(first["lat"], first["lon"])
            await asyncio.sleep(1)
        task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
