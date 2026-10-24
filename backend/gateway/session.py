"""One user session: app WebSocket <-> Gateway <-> Boson Higgs Realtime (IMPLEMENTATION_PLAN.md §3, §4, §7).

Owns the Boson socket, relays audio both ways, runs client tool calls, keeps the SITUATION block current, and runs
a small Director loop that decides when the guide speaks unprompted (§7.0 state machine, §7.4 gates, simplified).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import logging
import os
import re
import struct
import time
import uuid
from collections import deque
from typing import Any

import websockets
from fastapi import WebSocket

from backend.director import prompts
from backend.director.tours import ARRIVE_M, Tour, TourRun
from backend.geo import valhalla
from backend.geo.working_set import Nearby, Place, WorkingSet, bearing_deg, haversine_m
from backend.tools.handlers import TOOLS, ToolResult, run_tool

log = logging.getLogger("wander.session")

BOSON_URL = os.environ.get("BOSON_REALTIME_URL", "wss://api.boson.ai/v1/realtime?model=higgs-realtime")
VOICE = os.environ.get("BOSON_GUIDE_VOICE", "default")
IN_RATE, OUT_RATE = 16000, 24000
UPLINK_FLUSH_BYTES = IN_RATE * 2 * 60 // 1000  # batch mic audio into 60 ms appends (§14.3)

# Director timing (starting values, §7.1 / §7.4). WANDER_FAST_DIRECTOR=1 shortens them for desk testing.
FAST = os.environ.get("WANDER_FAST_DIRECTOR") == "1"
COOLDOWN_S = {"chatty": 25.0, "balanced": 45.0}
if FAST:
    COOLDOWN_S = {"chatty": 10.0, "balanced": 15.0}
AFTER_USER_S = 6.0
WAITING_FOR_USER_S = 8.0
SITUATION_DEBOUNCE_S = 5.0
HOOK_RADIUS_M = {"hero": 70.0, "other": 35.0}
# Session-level runaway guard only: per-response max_output_tokens / instructions make Boson ignore the conversation
# (docs/boson-api-issues.md #1, #2), so turn length is set through instructions.
SESSION_MAX_TOKENS = 600


def item_hash(item_id: str) -> bytes:
    return hashlib.sha1(item_id.encode()).digest()[:8]


def detect_script_language(text: str, current: str) -> str:
    """Cheap language tracking for map labels (§4.8): non-Latin scripts are certain; Latin needs a few cue words."""
    if len(text.strip()) < 6:
        return current
    if re.search(r"[؀-ۿ]", text):
        return "ar"
    if re.search(r"[ऀ-ॿ]", text):
        return "hi"
    if re.search(r"[一-鿿]", text):
        return "zh"
    words = set(re.findall(r"[a-zàâçéèêëîïôûùüÿœ']+", text.lower()))
    if len(words & {"est", "c'est", "le", "la", "les", "et", "une", "quoi", "pourquoi", "merci", "où", "ça", "qui"}) >= 2:
        return "fr"
    if len(words & {"el", "la", "los", "qué", "es", "dónde", "gracias", "por", "una", "cómo"}) >= 2:
        return "es"
    if len(words & {"the", "what", "is", "where", "how", "that", "this", "you", "and", "can"}) >= 2:
        return "en"
    return current


class GuideSession:
    def __init__(self, app: WebSocket, ws: WorkingSet, hello: Any, tours: dict[str, Tour] | None = None):
        self.app = app
        self.ws = ws
        self.session_id = f"s_{uuid.uuid4().hex[:12]}"
        self.debug = bool(hello.debug)
        self.mode = getattr(hello.mode, "root", hello.mode)  # generated Mode is a pydantic RootModel
        self.language = (hello.ui_lang or "en").split("-")[0]
        self.proactivity = "balanced"
        self.verbosity = "medium"
        self.prefs: list[dict] = []
        self.prefs_changed = False
        self.nav: dict | None = None
        self.tours = tours or {}
        self.tour: TourRun | None = None
        self._route_task: asyncio.Task | None = None
        self._last_tour_msg = 0.0

        # location
        self.pos: tuple[float, float] = (43.6640, -79.3925)  # Queen's Park until the first fix
        self.has_fix = False
        self.heading: float | None = None
        self.speed = 0.0
        self.accuracy = 50.0
        self.fixes: deque[tuple[float, float, float]] = deque(maxlen=10)
        self.top_nearby: list[Nearby] = []
        self.street: str | None = None

        # conversation state (§7.0)
        self.guide_state = "IDLE"
        self.user_speaking = False
        self.mic_muted = False
        self.responding = False
        self.response_purpose: dict[str, dict] = {}  # response_id -> {"purpose", "entity_id"}
        self.pending_purpose: deque[dict] = deque()
        self.introduced: set[str] = set()
        self.last_unsolicited = 0.0
        self.last_user_turn_end = 0.0
        self.waiting_until = 0.0
        self.greeted = False
        self.history: list[dict] = []  # {"role", "text"} for rotation replay
        self.item_seq: dict[str, int] = {}
        self.item_executor: dict[str, str] = {}
        self.played_ms: dict[str, int] = {}
        self.hash_to_item: dict[str, str] = {}
        self.spotted: dict[str, set[str]] = {}
        self.current_audio_item: str | None = None
        self.assistant_text: dict[str, str] = {}
        self.tool_tasks: dict[str, asyncio.Task] = {}
        self.focus_for_response: dict[str, list[Place]] = {}

        self.boson: websockets.ClientConnection | None = None
        self.uplink = bytearray()
        self.last_situation_sent = ""
        self.last_situation_at = 0.0
        self.closed = False
        self.active_response: str | None = None
        self.slow_since: float | None = None

    # ------------------------------------------------------------------ lifecycle

    async def run(self) -> None:
        await self.connect_boson()
        await self.send_app({"type": "ready", "session_id": self.session_id, "voice": VOICE, "mode": self.mode})
        await self.send_state()
        tasks = [asyncio.create_task(self.app_loop()), asyncio.create_task(self.boson_loop()),
                 asyncio.create_task(self.director_loop())]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                if t.exception():
                    log.exception("session task failed", exc_info=t.exception())
        finally:
            self.closed = True
            for t in tasks:
                t.cancel()
            if self.boson:
                with contextlib.suppress(Exception):
                    await self.boson.close()

    async def connect_boson(self, replay: bool = False) -> None:
        key = os.environ.get("BOSON_API_KEY")
        if not key:
            await self.send_app({"type": "error", "code": "auth", "message": "BOSON_API_KEY not set", "fatal": True})
            raise RuntimeError("BOSON_API_KEY not set")
        self.boson = await websockets.connect(BOSON_URL, additional_headers={"Authorization": f"Bearer {key}"},
                                              max_size=None, ping_interval=20)
        self.refresh_nearby()
        await self.boson_send({"type": "session.update", "session": self.session_config()})
        if replay:  # rotation (§4.5): carry the conversation over as text items
            for h in self.history[-8:]:
                part = {"type": "input_text" if h["role"] == "user" else "text", "text": h["text"]}
                await self.boson_send({"type": "conversation.item.create",
                                       "item": {"type": "message", "role": h["role"], "content": [part]}})

    def session_config(self) -> dict:
        return {
            "model": "higgs-realtime",
            "instructions": self.instructions(),
            "output_modalities": ["audio"],
            "audio": {
                "input": {"format": {"type": "audio/pcm", "rate": IN_RATE}, "turn_detection": {"type": "semantic_vad"},
                          "transcription": {"model": "higgs-stt-3.1"}, "noise_reduction": {"type": "near_field"}},
                "output": {"format": {"type": "audio/pcm", "rate": OUT_RATE}, "voice": VOICE},
            },
            "tools": TOOLS,
            "tool_choice": "auto",
            "temperature": 0.6,
            "max_output_tokens": SESSION_MAX_TOKENS,
            "truncation": "auto",
        }

    # ------------------------------------------------------------------ prompts

    def speed_class(self) -> str:
        s = self.speed
        return ("standing still" if s < 0.3 else "strolling" if s < 1.0 else "walking" if s < 1.8
                else "walking briskly" if s < 4 else "riding a vehicle")

    def situation(self) -> str:
        nav = None
        if self.tour and not self.tour.finished:
            r = self.tour
            nav = (f"guided tour '{r.tour.title}', stop {r.index + 1} of {len(r.tour.stops)}: {r.stop.name}, "
                   f"{r.stop.distance_m(*self.pos):.0f} m away (~{r.eta_min(*self.pos)} min walk)")
            if r.route and r.route_for == r.index:
                nav += f"; next instruction: {self.next_instruction(r.route)}"
        elif self.nav:
            p = self.nav_progress()
            nav = f"walking to {self.nav['destination']}, {p['remaining_m']} m left; next: {p['next_instruction']}"
        return prompts.situation_block(near=self.top_nearby[:5], street=self.street, speed_class=self.speed_class(),
                                       language=self.language,
                                       proactivity=f"{self.proactivity}, {self.verbosity} answers", nav=nav,
                                       gps_ok=self.accuracy < 25)

    def instructions(self) -> str:
        return prompts.session_instructions(self.situation(), self.prefs)

    def nav_language(self) -> str:
        return {"fr": "fr-FR", "es": "es-ES", "ar": "en-US", "hi": "hi-IN"}.get(self.language, "en-US")

    def next_instruction(self, route: dict) -> str:
        lat, lon = self.pos
        ms = route["maneuvers"][1:] or route["maneuvers"]
        m = min(ms, key=lambda m: haversine_m(lat, lon, m["lat"], m["lon"]))
        return f"{m['instruction']} (in {haversine_m(lat, lon, m['lat'], m['lon']):.0f} m)"

    def nav_progress(self) -> dict:
        r = self.nav["route"]
        lat, lon = self.pos
        ms = r["maneuvers"]
        nxt = min(ms[1:] or ms, key=lambda m: haversine_m(lat, lon, m["lat"], m["lon"]))
        end = r["geojson"]["coordinates"][-1]
        return {"next_instruction": nxt["instruction"], "next_in_m": round(haversine_m(lat, lon, nxt["lat"], nxt["lon"])),
                "remaining_m": round(haversine_m(lat, lon, end[1], end[0]))}

    # ------------------------------------------------------------------ app side

    async def send_app(self, msg: dict) -> None:
        if self.closed:
            return
        with contextlib.suppress(Exception):
            await self.app.send_text(json.dumps(msg, ensure_ascii=False))

    async def send_state(self) -> None:
        await self.send_app({"type": "state", "mode": self.mode, "guide_state": self.guide_state,
                             "language": self.language, "proactivity": self.proactivity})

    async def debug_event(self, kind: str, payload: dict) -> None:
        if self.debug:
            await self.send_app({"type": "debug", "kind": kind, "ts": time.time() * 1000, "payload": payload})

    async def set_state(self, state: str) -> None:
        if state != self.guide_state:
            self.guide_state = state
            await self.send_state()

    async def app_loop(self) -> None:
        while True:
            msg = await self.app.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if msg.get("bytes") is not None:
                if not self.mic_muted:
                    self.uplink += msg["bytes"]
                    if len(self.uplink) >= UPLINK_FLUSH_BYTES:
                        chunk, self.uplink = bytes(self.uplink), bytearray()
                        await self.boson_send({"type": "input_audio_buffer.append",
                                               "audio": base64.b64encode(chunk).decode()})
                continue
            try:
                m = json.loads(msg.get("text") or "{}")
            except json.JSONDecodeError:
                continue
            await self.handle_app_json(m)

    async def handle_app_json(self, m: dict) -> None:
        t = m.get("type")
        if t == "location":
            self.on_location(m)
        elif t == "playback":  # the app may only know the 8-byte hash from the binary header
            item = self.hash_to_item.get(m["item_id"], m["item_id"])
            self.played_ms[item] = int(m["played_ms"])
        elif t == "control":
            a = m.get("action")
            if a == "mute_mic":
                self.mic_muted = True
            elif a == "unmute_mic":
                self.mic_muted = False
            elif a == "pause_guide":
                self.proactivity = "quiet"
                await self.cancel_response()
                await self.set_state("QUIET")
            elif a == "resume_guide":
                self.proactivity = "balanced"
                await self.set_state("IDLE")
            elif a == "set_mode" and m.get("mode"):
                self.mode = m["mode"]
                await self.send_state()
        elif t == "text":
            await self.cancel_response()
            self.history.append({"role": "user", "text": m["text"]})
            self.language = detect_script_language(m["text"], self.language)
            await self.boson_send({"type": "conversation.item.create", "item": {
                "type": "message", "role": "user", "content": [{"type": "input_text", "text": m["text"]}]}})
            await self.request_response("answer")
        elif t == "ui" and m.get("action") == "start_tour" and m.get("tour_id") in self.tours:
            await self.start_tour(m["tour_id"])
        elif t == "ui" and m.get("action") == "end_tour":
            await self.end_tour()
        elif t == "ui" and m.get("action") == "skip_stop" and self.tour:
            self.tour.arrived.add(self.tour.index)
            self.tour.advance()
            await self.send_tour()
        elif t == "ui" and m.get("action") == "tap_entity" and m.get("entity_id") in self.ws.by_id:
            p = self.ws.by_id[m["entity_id"]]
            await self.cancel_response()
            note = (f"[APP EVENT — not spoken by the user] The user tapped {p.name} (id {p.id}) on the map. If you "
                    "had asked which building they meant, this is their answer. Otherwise talk briefly about it.")
            await self.boson_send({"type": "conversation.item.create", "item": {
                "type": "message", "role": "user", "content": [{"type": "input_text", "text": note}]}})
            await self.send_focus([p], response_id="tap")
            await self.request_response("answer", entity=p)

    def on_location(self, m: dict) -> None:
        lat, lon = m["lat"], m["lon"]
        now = time.monotonic()
        self.accuracy = m.get("accuracy_m", 10)
        if self.fixes:
            plat, plon, pt = self.fixes[-1]
            d = haversine_m(plat, plon, lat, lon)
            if m.get("speed_mps") is None and now > pt:
                self.speed = 0.7 * self.speed + 0.3 * d / max(0.2, now - pt)
        if m.get("speed_mps") is not None:
            self.speed = m["speed_mps"]
        course = m.get("course_deg")
        if course is None and len(self.fixes) >= 3:  # course over ground from the last few fixes
            olat, olon, _ = self.fixes[-3]
            if haversine_m(olat, olon, lat, lon) > 4:
                course = bearing_deg(olat, olon, lat, lon)
        if self.speed > 0.5 and course is not None:
            self.heading = course
        elif m.get("heading_deg") is not None:
            self.heading = m["heading_deg"]
        self.fixes.append((lat, lon, now))
        if self.speed < 0.3:
            self.slow_since = self.slow_since or now
        else:
            self.slow_since = None
        self.pos = (lat, lon)
        self.has_fix = True

    # ------------------------------------------------------------------ Boson side

    async def boson_send(self, event: dict) -> None:
        if self.boson is None:
            return
        try:
            await self.boson.send(json.dumps(event))
        except websockets.ConnectionClosed:
            log.warning("boson closed while sending %s", event.get("type"))

    async def boson_loop(self) -> None:
        while True:
            try:
                async for raw in self.boson:
                    await self.on_boson(json.loads(raw))
            except websockets.ConnectionClosed as e:
                log.info("boson closed: %s", e)
            if self.closed:
                return
            code = getattr(self.boson, "close_code", None)
            if code in (3000, 4429):
                await self.send_app({"type": "error", "code": "auth" if code == 3000 else "billing",
                                     "message": f"Boson closed the session ({code})", "fatal": True})
                return
            await self.debug_event("rotation", {"close_code": code})
            self.responding = False
            await asyncio.sleep(0.5)
            await self.connect_boson(replay=True)  # idle timeout / max duration / network: rotate (§4.5)

    async def on_boson(self, e: dict) -> None:
        t = e["type"]
        if t == "input_audio_buffer.speech_started":
            self.user_speaking = True
            await self.send_app({"type": "stop_playback", "reason": "barge_in"})
            item = self.current_audio_item
            if item and item in self.played_ms:  # keep the model's memory to what the user actually heard (§4.3)
                await self.boson_send({"type": "conversation.item.truncate", "item_id": item, "content_index": 0,
                                       "audio_end_ms": self.played_ms[item]})
            self.current_audio_item = None
            await self.set_state("LISTENING")
        elif t == "input_audio_buffer.speech_stopped":
            self.user_speaking = False
            self.last_user_turn_end = time.monotonic()
            self.pending_purpose.append({"purpose": "answer"})
        elif t == "conversation.item.input_audio_transcription.completed":
            text = e.get("transcript", "").strip()
            if text:
                self.history.append({"role": "user", "text": text})
                self.language = detect_script_language(text, self.language)
                await self.send_app({"type": "transcript", "role": "user", "item_id": e["item_id"], "text": text,
                                     "final": True, "lang": self.language})
                await self.send_state()
        elif t == "response.created":
            rid = e["response"]["id"]
            meta = e["response"].get("metadata") or {}
            purpose = {"purpose": meta.get("purpose")} if meta.get("purpose") else (
                self.pending_purpose.popleft() if self.pending_purpose else {"purpose": "answer"})
            purpose["entity_id"] = meta.get("entity_id")
            self.response_purpose[rid] = purpose
            self.responding = True
            self.active_response = rid
            await self.set_state("NARRATING" if purpose["purpose"] in ("proactive", "greeting") else
                                 "NAV_CUE" if purpose["purpose"] == "nav" else "ANSWERING")
            if purpose.get("entity_id") in self.ws.by_id:
                await self.send_focus([self.ws.by_id[purpose["entity_id"]]], response_id=rid)
        elif t == "response.output_item.added":
            item = e.get("item", {})
            if item.get("type") == "function_call":
                self.item_executor[item["id"]] = item.get("executor", "client")
        elif t == "response.output_audio.delta":
            item = e["item_id"]
            seq = self.item_seq.get(item, 0)
            self.item_seq[item] = seq + 1
            self.current_audio_item = item
            if seq == 0:
                self.hash_to_item[item_hash(item).hex()] = item
            with contextlib.suppress(Exception):
                await self.app.send_bytes(item_hash(item) + struct.pack(">I", seq) + base64.b64decode(e["delta"]))
        elif t == "response.output_audio_transcript.delta":
            item = e["item_id"]
            self.assistant_text[item] = self.assistant_text.get(item, "") + e["delta"]
            await self.spot_entities(item, e.get("response_id", ""))
            await self.send_app({"type": "transcript", "role": "assistant", "item_id": item,
                                 "text": self.assistant_text[item], "final": False})
        elif t == "response.output_audio_transcript.done":
            text = e.get("transcript", "")
            self.history.append({"role": "assistant", "text": text})
            await self.send_app({"type": "transcript", "role": "assistant", "item_id": e["item_id"], "text": text,
                                 "final": True, "lang": self.language})
        elif t == "response.function_call_arguments.done":
            if self.item_executor.get(e["item_id"], "client") == "client":  # start right away, don't wait (§4.3)
                args = json.loads(e.get("arguments") or "{}")
                self.tool_tasks[e["call_id"]] = asyncio.create_task(self.exec_tool(e["name"], args, e["response_id"]))
                await self.debug_event("tool_call", {"name": e["name"], "args": args})
        elif t == "response.done":
            await self.on_response_done(e["response"])
        elif t in ("session.idle_timeout", "session.max_duration_reached"):
            await self.debug_event(t, {k: v for k, v in e.items() if k != "type"})
        elif t == "error" and self.responding and self.active_response is None:
            # a rejected response.create never gets response.created/done: don't stay "busy" forever
            log.warning("boson rejected a request: %s", e.get("error"))
            await self.debug_event("boson_error", e.get("error", {}))
            self.responding = False
            await self.set_state("IDLE")
        elif t == "error":
            log.warning("boson error: %s", e.get("error"))
            await self.debug_event("boson_error", e.get("error", {}))

    async def exec_tool(self, name: str, args: dict, response_id: str) -> ToolResult:
        t0 = time.monotonic()
        res = await run_tool(self, name, args)
        await self.debug_event("tool_result", {"name": name, "ms": round((time.monotonic() - t0) * 1000),
                                               "status": res.output.get("status")})
        if res.focus:
            await self.send_focus(res.focus, response_id=response_id, badges=res.badges)
            if not res.badges:
                await self.send_card(res.focus[0])
        if res.route is not None:
            if res.route.get("cleared"):
                await self.send_app({"type": "route", "route_id": "none", "geojson": {
                    "type": "LineString", "coordinates": [[self.pos[1], self.pos[0]]] * 2}, "maneuvers": [],
                    "eta_s": 0, "cleared": True})
            else:
                await self.send_app({"type": "route", "route_id": f"r_{uuid.uuid4().hex[:8]}",
                                     "geojson": res.route["geojson"], "maneuvers": res.route["maneuvers"],
                                     "eta_s": res.route["eta_s"]})
        return res

    async def on_response_done(self, resp: dict) -> None:
        rid = resp["id"]
        purpose = self.response_purpose.pop(rid, {"purpose": "answer"})
        calls = [i for i in resp.get("output", []) if i.get("type") == "function_call" and i.get("executor") == "client"]
        if calls:
            for c in calls:
                task = self.tool_tasks.pop(c["call_id"], None)
                res = await task if task else await self.exec_tool(c["name"], json.loads(c["arguments"] or "{}"), rid)
                await self.boson_send({"type": "conversation.item.create", "item": {
                    "type": "function_call_output", "call_id": c["call_id"],
                    "output": json.dumps(res.output, ensure_ascii=False)}})
            if self.prefs_changed:
                self.prefs_changed = False
                await self.push_situation(force=True)
            await self.boson_send({"type": "response.create", "response": {
                "metadata": {"purpose": purpose["purpose"], "entity_id": None}}})
            return
        self.responding = False
        self.active_response = None
        if purpose["purpose"] == "tour_stop" and self.tour:
            self.tour.advance()
            if self.tour.finished:
                await self.send_tour()
                self.tour = None
                self.mode = "wander"
                await self.send_app(self.route_cleared())
            else:
                await self.send_tour()
        if purpose["purpose"] in ("proactive", "greeting", "tour_stop", "tour_intro"):
            self.last_unsolicited = time.monotonic()
            self.waiting_until = time.monotonic() + WAITING_FOR_USER_S
        await self.set_state("QUIET" if self.proactivity == "quiet" else
                             "WAITING_FOR_USER" if purpose["purpose"] in ("proactive", "greeting") else "IDLE")

    # ------------------------------------------------------------------ guided tours (§8)

    async def start_tour(self, tour_id: str, *, intro_spoken: bool = False) -> TourRun:
        self.tour = TourRun(self.tours[tour_id], started=intro_spoken)
        self.mode = "tour"
        self.greeted = True  # the tour intro replaces the generic greeting
        await self.send_state()
        await self.send_tour()
        return self.tour

    async def end_tour(self) -> None:
        if self.tour:
            self.tour.finished = True
            await self.send_tour()
        self.tour = None
        self.mode = "wander"
        await self.send_state()
        await self.send_app(self.route_cleared())

    def route_cleared(self) -> dict:
        lon_lat = [self.pos[1], self.pos[0]]
        return {"type": "route", "route_id": "none", "geojson": {"type": "LineString", "coordinates": [lon_lat, lon_lat]},
                "maneuvers": [], "eta_s": 0, "cleared": True}

    async def send_tour(self) -> None:
        if self.tour:
            self._last_tour_msg = time.monotonic()
            await self.send_app(self.tour.message(*self.pos))

    async def tour_tick(self) -> None:
        """Keep a walking route to the current stop, refresh ETA, and buzz at turns (§9.2, simplified)."""
        r = self.tour
        if r is None or r.finished or not self.has_fix:
            return
        if r.route_for != r.index and (self._route_task is None or self._route_task.done()):
            self._route_task = asyncio.create_task(self.fetch_leg(r, r.index))
        if r.route and r.route_for == r.index:
            lat, lon = self.pos
            for m in r.route["maneuvers"][1:-1]:
                d = haversine_m(lat, lon, m["lat"], m["lon"])
                if d < 20 and m["index"] not in r.cued:
                    r.cued.add(m["index"])
                    await self.send_app({"type": "nav_cue", "maneuver_idx": m["index"], "distance_m": round(d),
                                         "earcon": "turn_now"})
        if time.monotonic() - self._last_tour_msg > 10:
            await self.send_tour()

    async def fetch_leg(self, r: TourRun, index: int) -> None:
        lat, lon = self.pos
        stop = r.tour.stops[index]
        try:
            route = await valhalla.route(lat, lon, stop.lat, stop.lon, language=self.nav_language())
        except Exception as e:  # noqa: BLE001 — routing down: the tour still works with straight-line estimates
            log.warning("tour leg routing failed: %s", e)
            r.route_for = index
            return
        if self.tour is not r or r.index != index:
            return  # stale: the user skipped ahead meanwhile (§5.7)
        r.route, r.route_for = route, index
        await self.send_app({"type": "route", "route_id": f"tour_{r.tour.id}_{index}", "geojson": route["geojson"],
                             "maneuvers": route["maneuvers"], "eta_s": route["eta_s"]})
        await self.send_tour()

    async def request_response(self, purpose: str, *, briefing: str | None = None,
                               entity: Place | None = None) -> None:
        """response.create with `metadata` only. A one-turn briefing goes in as an app-event user item: per-response
        instructions drop the conversation, and a bare response.create after an assistant turn is rejected with
        "No user input" (docs/boson-api-issues.md #2, #3b)."""
        if briefing:
            note = ("[APP EVENT — not spoken by the user. Don't reply to this as if they said it; just speak to "
                    "them as the guide, following the briefing.]\n" + briefing)
            await self.boson_send({"type": "conversation.item.create", "item": {
                "type": "message", "role": "user", "content": [{"type": "input_text", "text": note}]}})
        self.responding = True
        await self.boson_send({"type": "response.create", "response": {
            "metadata": {"purpose": purpose, "entity_id": entity.id if entity else None}}})

    async def cancel_response(self) -> None:
        if self.responding:
            await self.boson_send({"type": "response.cancel"})
            await self.send_app({"type": "stop_playback", "reason": "cancel"})

    async def send_focus(self, places: list[Place], *, response_id: str, badges: bool = False) -> None:
        p0 = places[0]
        style = {"building": "building", "area": "area", "park": "area", "street": "street", "river": "path"}.get(
            p0.kind, "point" if not p0.geometry else "building")
        await self.send_app({"type": "map_focus", "focus_id": f"f_{uuid.uuid4().hex[:8]}", "response_id": response_id,
                             "entities": [{"entity_id": p.id, "kind": p.kind if p.kind != "venue" else "venue",
                                           "geometry_ref": p.id, "label": p.names.get(self.language, p.name),
                                           **({"badge": "AB"[i]} if badges and i < 2 else {})}
                                          for i, p in enumerate(places)],
                             "style": style, "camera": "fit"})

    async def spot_entities(self, item: str, response_id: str) -> None:
        """Highlight a place on the map when the guide first names it (§12.3, simplified: no audio-time offset).
        Only resolved ids from the working set are used, never names the model invented."""
        text = self.assistant_text[item].lower()
        spotted = self.spotted.setdefault(item, set())
        lat, lon = self.pos
        cands = {n.place.id: n.place for n in self.top_nearby}
        cands.update({p.id: p for p in self.ws.heroes() if haversine_m(lat, lon, p.lat, p.lon) < 900})
        for p in cands.values():
            if p.id in spotted:
                continue
            names = {p.name, p.names.get(self.language, "")} - {""}
            if any(len(n) > 4 and n.lower() in text for n in names):
                spotted.add(p.id)
                if len(spotted) == 1 or p.hero:  # first mention, or another hero later in the same answer
                    await self.send_focus([p], response_id=response_id)
                    await self.send_card(p)

    async def send_card(self, p: Place) -> None:
        facts = [{"text": f["text"][:220], "claim_type": f.get("claim_type", "established"),
                  **({"source_url": f["source"]} if f.get("source", "").startswith("http") else
                     {"source_title": f["source"]} if f.get("source") else {})} for f in p.facts(limit=3)][:3]
        await self.send_app({"type": "card", "entity_id": p.id, "title": p.names.get(self.language, p.name),
                             "subtitle": p.one_liner()[:120], "facts": facts})

    # ------------------------------------------------------------------ Director

    def refresh_nearby(self) -> None:
        lat, lon = self.pos
        self.top_nearby = self.ws.interesting_nearby(lat, lon, self.heading)
        streets = self.ws.nearby(lat, lon, self.heading, 25, {"street"})
        self.street = streets[0].place.name if streets else None

    async def push_situation(self, force: bool = False) -> None:
        sit = self.situation()
        ids_now = [n.place.id for n in self.top_nearby[:5]]
        if not force and (sit == self.last_situation_sent or time.monotonic() - self.last_situation_at
                          < SITUATION_DEBOUNCE_S or ids_now == getattr(self, "_last_ids", None)):
            return
        self._last_ids = ids_now
        self.last_situation_sent = sit
        self.last_situation_at = time.monotonic()
        await self.boson_send({"type": "session.update", "session": {"instructions": self.instructions()}})

    async def director_loop(self) -> None:
        while True:
            await asyncio.sleep(1.0)
            if self.boson is None:
                continue
            self.refresh_nearby()
            await self.tour_tick()
            await self.push_situation()
            decision = self.decide()
            if decision:
                await self.debug_event("director_decision", {k: v for k, v in decision.items() if k != "place"} |
                                       {"entity": decision["place"].name if decision.get("place") else None})
                await self.speak_proactively(decision)
            elif self.debug:
                await self.debug_event("attention_queue", {"top": [
                    {"name": n.place.name, "side": n.side, "d": round(n.distance_m),
                     "score": round(self.ws.salience(n), 2), "introduced": n.place.id in self.introduced}
                    for n in self.top_nearby[:5]], "state": self.guide_state})

    def decide(self) -> dict | None:
        """Hard gates first (§7.4), then the best not-yet-introduced place within hook range."""
        now = time.monotonic()
        if self.guide_state == "WAITING_FOR_USER" and now > self.waiting_until:
            self.guide_state = "IDLE"
        if (self.responding or self.user_speaking or self.guide_state not in ("IDLE",) or not self.has_fix
                or self.proactivity in ("quiet", "follow_my_lead")):
            return None
        if now - self.last_user_turn_end < AFTER_USER_S:
            return None
        r = self.tour
        if r and not r.finished:
            if not r.started:
                return {"action": "TOUR_INTRO", "place": r.stop}
            d = r.stop.distance_m(*self.pos)
            if d <= ARRIVE_M and r.index not in r.arrived:
                return {"action": "TOUR_STOP", "place": r.stop, "side": "nearby", "distance_m": d}
        if not self.greeted:
            return {"action": "GREETING"}
        if now - self.last_unsolicited < COOLDOWN_S.get(self.proactivity, 45):
            return None
        for n in self.top_nearby:
            p = n.place
            if p.id in self.introduced or not (p.hero or p.chunks):
                continue
            if r and not r.finished and p.id in {s.id for s in r.tour.stops[r.index:]}:
                continue  # save upcoming tour stops for their arrival story
            if n.distance_m <= HOOK_RADIUS_M["hero" if p.hero else "other"] and n.side != "behind":
                dwelling = self.slow_since is not None and now - self.slow_since >= 8  # §7.1 dwell
                action = "OFFER" if self.speed > 1.8 else "DEEP" if dwelling else "HOOK"
                return {"action": action, "place": p, "side": n.side, "distance_m": n.distance_m}
        return None

    async def speak_proactively(self, d: dict) -> None:
        if d["action"] == "GREETING":
            self.greeted = True
            self.last_unsolicited = time.monotonic()
            await self.request_response("greeting", briefing=prompts.GREETING)
            return
        if d["action"] in ("TOUR_INTRO", "TOUR_STOP"):
            await self.speak_tour(d)
            return
        p: Place = d["place"]
        self.introduced.add(p.id)
        extra = {"OFFER": "The user is walking fast: just name it and offer the story in one sentence.",
                 "DEEP": "The user has stopped here: tell the story properly (up to ~20 s) with one 'look for' cue.",
                 "HOOK": ""}[d["action"]]
        brief = prompts.briefing("", action=d["action"], place=p, side=d["side"], distance_m=d["distance_m"],
                                 speed_class=self.speed_class(), extra=extra).strip()
        await self.send_card(p)
        await self.request_response("proactive", briefing=brief, entity=p)

    async def speak_tour(self, d: dict) -> None:
        r = self.tour
        assert r is not None
        stop: Place = d["place"]
        if d["action"] == "TOUR_INTRO":
            r.started = True
            brief = prompts.tour_intro(r.tour, first=stop, eta_min=r.eta_min(*self.pos))
            await self.request_response("tour_intro", briefing=brief, entity=stop)
            await self.send_card(stop)
            return
        r.arrived.add(r.index)
        self.introduced.add(stop.id)
        nxt = r.next_stop
        nxt_eta = max(1, round(nxt.distance_m(stop.lat, stop.lon) * 1.3 / 1.3 / 60)) if nxt else None
        brief = prompts.tour_stop(r.tour, stop=stop, number=r.index + 1, next_stop=nxt, next_eta_min=nxt_eta)
        await self.send_card(stop)
        await self.send_tour()
        await self.request_response("tour_stop", briefing=brief, entity=stop)
