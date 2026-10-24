"""Day-one probes of Higgs Realtime behaviour the docs don't pin down (IMPLEMENTATION_PLAN.md §4.7).

Each probe opens its own short session, drives it with text input (mic audio is exercised by the debug client),
and prints what the model did. Raw results go to data/probes/<timestamp>.json; summarize them by hand in
docs/boson-findings.md.

    uv run python tools/probe_boson.py            # all probes
    uv run python tools/probe_boson.py 1 5 11     # selected probes

Costs a few cents of Realtime credit per full run.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import websockets
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
URL = os.environ.get("BOSON_REALTIME_URL", "wss://api.boson.ai/v1/realtime?model=higgs-realtime")
OUT_RATE = 24000

BASE_SESSION: dict[str, Any] = {
    "model": "higgs-realtime",
    "output_modalities": ["audio"],
    "audio": {
        "input": {"format": {"type": "audio/pcm", "rate": 16000}, "turn_detection": {"type": "semantic_vad"},
                  "transcription": {"model": "higgs-stt-3.1"}},
        "output": {"format": {"type": "audio/pcm", "rate": OUT_RATE}, "voice": os.environ.get("BOSON_GUIDE_VOICE", "default")},
    },
    "temperature": 0.6,
}


@dataclass
class Reply:
    response_id: str | None = None
    status: str | None = None
    transcript: str = ""
    audio_ms: float = 0.0
    first_audio_ms: float | None = None  # from request to first audio chunk
    total_ms: float | None = None
    function_calls: list[dict] = field(default_factory=list)
    audio_before_tool_call: bool = False
    item_ids: list[str] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)


class Session:
    def __init__(self, ws):
        self.ws = ws
        self.events: list[dict] = []
        self.queue: asyncio.Queue[dict] = asyncio.Queue()
        self._reader = asyncio.create_task(self._read())

    @classmethod
    async def open(cls, **session: Any) -> Session:
        ws = await websockets.connect(URL, additional_headers={"Authorization": f"Bearer {os.environ['BOSON_API_KEY']}"},
                                      max_size=None)
        s = cls(ws)
        await s.update({**BASE_SESSION, **session})
        await s.wait_for(lambda e: e["type"] in ("session.created", "session.updated"), timeout=15)
        return s

    async def _read(self) -> None:
        async for raw in self.ws:
            e = json.loads(raw)
            e["_t"] = time.monotonic()
            if e["type"] != "response.output_audio.delta":
                self.events.append({k: v for k, v in e.items() if k != "delta" or len(str(v)) < 200})
            await self.queue.put(e)

    async def send(self, event: dict) -> None:
        await self.ws.send(json.dumps(event))

    async def update(self, session: dict) -> None:
        await self.send({"type": "session.update", "session": session})

    async def say(self, text: str) -> None:
        await self.send({"type": "conversation.item.create",
                         "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}})

    async def wait_for(self, pred: Callable[[dict], bool], timeout: float = 30) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            e = await asyncio.wait_for(self.queue.get(), max(0.01, deadline - time.monotonic()))
            if e["type"] == "error":
                print("   ! error:", e.get("error"))
            if pred(e):
                return e

    async def respond(self, instructions: str | None = None, timeout: float = 45,
                      on_tool: Callable[[dict], Any] | None = None, send: bool = True) -> Reply:
        """Send response.create (unless send=False) and collect one response; runs client tools if on_tool is set."""
        r = Reply()
        t0 = time.monotonic()
        if send:
            await self.send({"type": "response.create", **({"response": {"instructions": instructions}} if instructions else {})})
        deadline = t0 + timeout
        while True:
            e = await asyncio.wait_for(self.queue.get(), max(0.01, deadline - time.monotonic()))
            t = e["type"]
            if t == "error":
                r.errors.append(e.get("error", {}))
            elif t == "response.created":
                r.response_id = e["response"]["id"]
            elif t == "response.output_audio.delta":
                if r.first_audio_ms is None:
                    r.first_audio_ms = (e["_t"] - t0) * 1000
                r.audio_ms += len(base64.b64decode(e["delta"])) / 2 / OUT_RATE * 1000
                if e["item_id"] not in r.item_ids:
                    r.item_ids.append(e["item_id"])
            elif t == "response.output_audio_transcript.done":
                r.transcript += e["transcript"]
            elif t == "response.function_call_arguments.done":
                r.audio_before_tool_call = r.audio_before_tool_call or r.audio_ms > 0
            elif t == "response.done":
                r.status = e["response"]["status"]
                r.total_ms = (e["_t"] - t0) * 1000
                calls = [i for i in e["response"].get("output", []) if i.get("type") == "function_call"]
                r.function_calls += calls
                client_calls = [c for c in calls if c.get("executor") == "client"]
                if client_calls and on_tool:
                    for c in client_calls:
                        out = await on_tool(c)
                        await self.send({"type": "conversation.item.create",
                                         "item": {"type": "function_call_output", "call_id": c["call_id"], "output": json.dumps(out)}})
                    nxt = await self.respond(timeout=timeout)
                    nxt.function_calls = r.function_calls + nxt.function_calls
                    nxt.audio_before_tool_call = r.audio_before_tool_call or r.audio_ms > 0
                    nxt.transcript = (r.transcript + " | " + nxt.transcript).strip(" |")
                    nxt.first_audio_ms = r.first_audio_ms if r.first_audio_ms is not None else nxt.first_audio_ms
                    return nxt
                return r

    async def close(self) -> None:
        await self.ws.close()
        self._reader.cancel()


def show(label: str, r: Reply) -> None:
    fa = f"{r.first_audio_ms:.0f} ms" if r.first_audio_ms is not None else "—"
    print(f"   {label}: [{r.status}] first audio {fa}, {r.audio_ms / 1000:.1f}s audio")
    print(f"      “{r.transcript.strip()}”")


def script_of(text: str) -> str:
    counts = {"arabic": 0, "devanagari": 0, "latin": 0}
    for ch in text:
        o = ord(ch)
        if 0x0600 <= o <= 0x06FF:
            counts["arabic"] += 1
        elif 0x0900 <= o <= 0x097F:
            counts["devanagari"] += 1
        elif ch.isalpha() and o < 0x250:
            counts["latin"] += 1
    return max(counts, key=counts.get) if any(counts.values()) else "none"


# ---------------------------------------------------------------- probes

async def probe_1() -> dict:
    """Per-response `instructions`: replace or append to session instructions?"""
    s = await Session.open(instructions="You are a tour guide. Always end every reply with the exact word PINEAPPLE.")
    await s.say("Say hello.")
    base = await s.respond()
    show("session instructions only", base)
    await s.say("Say hello again.")
    per = await s.respond(instructions="You are a tour guide. Reply with one short sentence. Never say any fruit names.")
    show("with per-response instructions", per)
    await s.close()
    verdict = ("append (session rule still applied)" if "pineapple" in per.transcript.lower()
               else "replace" if "pineapple" in base.transcript.lower() else "inconclusive (baseline ignored the rule)")
    return {"verdict": verdict, "baseline": base.__dict__, "per_response": per.__dict__}


async def probe_2() -> dict:
    """Mid-conversation session.update of instructions: latency, and is it rejected during an active response?"""
    s = await Session.open(instructions="You are a tour guide in Toronto. Speak English.")
    t0 = time.monotonic()
    await s.update({"instructions": "You are a tour guide in Toronto. Speak English. The user is now at Hart House."})
    await s.wait_for(lambda e: e["type"] == "session.updated")
    idle_ms = (time.monotonic() - t0) * 1000
    print(f"   update while idle acknowledged in {idle_ms:.0f} ms")

    await s.say("Tell me a long story about the history of Toronto, at least a minute.")
    await s.send({"type": "response.create"})
    await s.wait_for(lambda e: e["type"] == "response.output_audio.delta", timeout=20)
    t1 = time.monotonic()
    await s.update({"instructions": "You are a tour guide in Toronto. The user is now at the Royal Ontario Museum."})
    ack = await s.wait_for(lambda e: e["type"] in ("session.updated", "error"), timeout=20)
    busy_ms = (time.monotonic() - t1) * 1000
    print(f"   update during a response -> {ack['type']} after {busy_ms:.0f} ms {ack.get('error', '')}")
    r = await s.respond(send=False, timeout=90)  # the long story keeps going
    show("story after mid-response update", r)
    await s.say("Where am I right now, according to what you know?")
    where = await s.respond()
    show("location question", where)
    await s.close()
    return {"idle_update_ms": idle_ms, "busy_update_result": ack["type"], "busy_update_ms": busy_ms,
            "busy_update_error": ack.get("error"), "story_status": r.status, "where": where.transcript}


async def probe_5() -> dict:
    """Proactive response.create with no new user input: does the model speak naturally from a briefing?"""
    instructions = ("You are Wander, a warm local guide walking beside the user in Toronto. Speak naturally, short "
                    "sentences, 1-3 sentences per turn.")
    s = await Session.open(instructions=instructions)
    briefing = (instructions + "\n\n# BRIEFING (this turn only)\nAction: HOOK\nEntity: Hart House, 40 m ahead on the "
                "right, visible.\nCard: hook=\"Hart House was a gift from the Massey family, built so students had "
                "somewhere to argue, swim and act.\" look_for=\"the stone tower over the archway\"\nConstraints: max "
                "~10 seconds; the user is walking. End with an offer to hear more, not a question about them.")
    r = await s.respond(instructions=briefing)
    show("proactive hook", r)
    await s.close()
    return {"reply": r.__dict__}


async def probe_6() -> dict:
    """A 1.5 s client tool: does the model speak a filler before the call?"""
    tools = [{"type": "function", "name": "lookup", "description": "Get facts about a nearby place.",
              "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}]
    s = await Session.open(tools=tools, tool_choice="auto",
                           instructions="You are a Toronto tour guide. For any question about a specific building, call "
                                        "lookup. Before calling a tool, say a very short natural acknowledgement.")

    async def lookup(call: dict) -> dict:
        print(f"   tool called: {call['name']}({call['arguments']}) — sleeping 1.5 s")
        await asyncio.sleep(1.5)
        return {"facts": [{"text": "Hart House opened in 1919, a gift of the Massey Foundation.", "source": "wikipedia"},
                          {"text": "Its Soldiers' Tower carillon has 51 bells.", "source": "wikipedia"}]}

    await s.say("When did Hart House open?")
    r = await s.respond(on_tool=lookup, timeout=60)
    show("tool answer", r)
    await s.close()
    return {"called": [c.get("name") for c in r.function_calls], "audio_before_tool_call": r.audio_before_tool_call,
            "reply": r.__dict__}


async def probe_9() -> dict:
    """Does conversation.item.truncate change what the model remembers saying?"""
    s = await Session.open(instructions="You are a helpful assistant. Answer exactly as asked.")
    await s.say("Slowly list these five animals in order, one sentence each: aardvark, buffalo, camel, dolphin, eagle.")
    r = await s.respond()
    show("full list", r)
    item = r.item_ids[0]
    cut_ms = min(1200, int(r.audio_ms * 0.2))
    await s.send({"type": "conversation.item.truncate", "item_id": item, "content_index": 0, "audio_end_ms": cut_ms})
    ack = await s.wait_for(lambda e: e["type"] in ("conversation.item.truncated", "error"))
    print(f"   truncate at {cut_ms} ms -> {ack['type']}")
    await s.say("Which animals did you actually manage to say before you were cut off? Only list those.")
    after = await s.respond()
    show("after truncate", after)
    await s.close()
    return {"cut_ms": cut_ms, "ack": ack["type"], "before": r.transcript, "after": after.transcript}


async def probe_11() -> dict:
    """Language switching EN -> FR -> AR -> HI -> mixed -> EN with foreign place names."""
    s = await Session.open(instructions="You are Wander, a Toronto tour guide. Reply in the language the user last spoke. "
                                        "If they mix languages, mirror their mix. A foreign place name or quoted phrase is "
                                        "not a language switch. Keep replies to 1-2 sentences.")
    turns = [
        ("en", "latin", "Hi! What's that big pink building in Queen's Park?"),
        ("fr", "latin", "Et c'était construit quand, exactement?"),
        ("ar", "arabic", "هل يمكنك أن تخبرني المزيد عن تاريخه؟"),
        ("hi", "devanagari", "क्या पास में कोई अच्छा संग्रहालय है?"),
        ("mixed", "latin", "OK merci, but what does 'Yorkville' actually mean?"),
        ("en+fr name", "latin", "Is the Musée royal de l'Ontario far from here?"),
    ]
    out = []
    for label, expected, text in turns:
        await s.say(text)
        r = await s.respond()
        got = script_of(r.transcript)
        print(f"   [{label}] expected {expected}, got {got}, first audio {r.first_audio_ms or 0:.0f} ms")
        print(f"      user: {text}\n      guide: {r.transcript.strip()}")
        out.append({"label": label, "user": text, "reply": r.transcript, "expected_script": expected,
                    "reply_script": got, "first_audio_ms": r.first_audio_ms})
    await s.close()
    return {"turns": out}


PROBES = {"1": probe_1, "2": probe_2, "5": probe_5, "6": probe_6, "9": probe_9, "11": probe_11}


async def main(selected: list[str]) -> None:
    if not os.environ.get("BOSON_API_KEY"):
        sys.exit("BOSON_API_KEY is not set (see .env.example)")
    results: dict[str, Any] = {"url": URL, "started": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    for key in selected:
        fn = PROBES[key]
        print(f"\n== probe {key}: {fn.__doc__.splitlines()[0]}")
        try:
            results[key] = await asyncio.wait_for(fn(), timeout=240)
            if "verdict" in results[key]:
                print(f"   => {results[key]['verdict']}")
        except Exception as e:  # noqa: BLE001 — keep going so one failure doesn't hide the rest
            print(f"   !! failed: {type(e).__name__}: {e}")
            results[key] = {"error": f"{type(e).__name__}: {e}"}
    out = ROOT / "data" / "probes" / f"{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2, ensure_ascii=False, default=str))
    print(f"\nraw results: {out.relative_to(ROOT)}")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:] or list(PROBES)))
