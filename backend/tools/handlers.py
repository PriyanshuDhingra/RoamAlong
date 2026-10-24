"""Function tools exposed to the Voice Agent (IMPLEMENTATION_PLAN.md §6) and their handlers.

Handlers take the server-side session context, never a user id from the model (§5.7). Every result carries
`facts` as quoted data plus `nearby_now` so the model stays grounded after each call.
"""

from __future__ import annotations

import json
import math
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

from backend.geo import valhalla
from backend.geo.working_set import Place, WorkingSet, haversine_m

if TYPE_CHECKING:
    from backend.gateway.session import GuideSession

ROOT = Path(__file__).resolve().parents[2]
CORRECTIONS = ROOT / "data" / "corrections.jsonl"

TOOLS: list[dict] = [
    {"type": "function", "name": "lookup",
     "description": "Get sourced facts about a nearby place, person or topic. Use for any specific question you "
                    "cannot answer from SITUATION.",
     "parameters": {"type": "object", "properties": {
         "query": {"type": "string", "description": "The user's question, in their words"},
         "entity_id": {"type": "string", "description": "Entity id from SITUATION if known"}},
         "required": ["query"]}},
    {"type": "function", "name": "resolve_reference",
     "description": "Identify what the user is pointing at or describing (e.g. 'the red brick building with a tower').",
     "parameters": {"type": "object", "properties": {
         "description": {"type": "string"},
         "direction": {"type": "string", "enum": ["ahead", "left", "right", "behind", "any"]}},
         "required": ["description"]}},
    {"type": "function", "name": "find_places",
     "description": "Find places nearby: food, coffee, bars, shops, parks, washrooms, museums.",
     "parameters": {"type": "object", "properties": {
         "category": {"type": "string"},
         "constraints": {"type": "string", "description": "e.g. 'vegetarian, cheap, sit-down'"}},
         "required": ["category"]}},
    {"type": "function", "name": "navigate",
     "description": "Start or stop walking directions, or get the next instruction or status.",
     "parameters": {"type": "object", "properties": {
         "action": {"type": "string", "enum": ["start", "stop", "next_instruction", "status"]},
         "destination": {"type": "string", "description": "Place name or entity id"}},
         "required": ["action"]}},
    {"type": "function", "name": "tour",
     "description": "Guided tours: list them, start one, skip the current stop, or end the tour.",
     "parameters": {"type": "object", "properties": {
         "action": {"type": "string", "enum": ["list", "start", "skip_stop", "end"]},
         "tour_id": {"type": "string", "description": "For start; from the list result"}},
         "required": ["action"]}},
    {"type": "function", "name": "save_preference",
     "description": "Save a preference the user clearly stated about what they like to learn about, eat, or how they "
                    "like to be guided. Not for one-off requests.",
     "parameters": {"type": "object", "properties": {
         "category": {"type": "string", "enum": ["topic", "sub_interest", "food", "pace", "verbosity", "language",
                                                 "accessibility", "avoid"]},
         "value": {"type": "string"},
         "polarity": {"type": "string", "enum": ["like", "dislike"]},
         "scope": {"type": "string", "enum": ["usually", "today"]},
         "evidence": {"type": "string", "description": "The user's words"}},
         "required": ["category", "value", "polarity", "scope", "evidence"]}},
    {"type": "function", "name": "forget_preference",
     "description": "Remove a stored preference when the user asks.",
     "parameters": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}},
    {"type": "function", "name": "set_guide_style",
     "description": "Change how you guide: quiet = silent until the user speaks; follow_my_lead = answer questions "
                    "only; balanced; chatty. Verbosity short/medium/long.",
     "parameters": {"type": "object", "properties": {
         "proactivity": {"type": "string", "enum": ["quiet", "follow_my_lead", "balanced", "chatty"]},
         "verbosity": {"type": "string", "enum": ["short", "medium", "long"]}}}},
    {"type": "function", "name": "report_correction",
     "description": "Record that the user says a fact you gave is wrong, so it can be reviewed.",
     "parameters": {"type": "object", "properties": {
         "entity_id": {"type": "string"},
         "claim": {"type": "string", "description": "What you said"},
         "user_says": {"type": "string", "description": "The user's correction, in their words"}},
         "required": ["claim", "user_says"]}},
    {"type": "web_search", "location": {"country": "CA"}},
]

# find_places category words -> OSM tag predicates
CATEGORIES: dict[str, list[tuple[str, set[str]]]] = {
    "coffee": [("amenity", {"cafe"})], "cafe": [("amenity", {"cafe"})],
    "food": [("amenity", {"restaurant", "cafe", "fast_food", "food_court", "ice_cream", "pub"})],
    "restaurant": [("amenity", {"restaurant"})], "lunch": [("amenity", {"restaurant", "cafe", "fast_food"})],
    "bar": [("amenity", {"bar", "pub"})], "drink": [("amenity", {"bar", "pub", "cafe"})],
    "ice cream": [("amenity", {"ice_cream"})], "dessert": [("amenity", {"ice_cream", "cafe"})],
    "washroom": [("amenity", {"toilets"})], "toilet": [("amenity", {"toilets"})],
    "museum": [("tourism", {"museum", "gallery"})], "gallery": [("tourism", {"gallery", "museum"})],
    "park": [("leisure", {"park", "garden"})], "book": [("shop", {"books"})], "shop": [("shop", set())],
}

COLOUR_WORDS = {"red", "brown", "pink", "white", "grey", "gray", "green", "blue", "black", "yellow", "beige", "glass",
                "stone", "brick", "sandstone", "copper", "concrete", "limestone"}
SHAPE_WORDS = {"tower", "dome", "spire", "clock", "arch", "columns", "castle", "church", "statue", "glass", "crystal",
               "tall", "modern", "old", "gothic", "romanesque", "brutalist", "round", "steeple"}


@dataclass
class ToolResult:
    output: dict
    focus: list[Place] = field(default_factory=list)  # entities to highlight on the map
    badges: bool = False  # ambiguity: show A/B badges
    route: dict | None = None


def _place_brief(p: Place, lat: float, lon: float) -> dict:
    return {"id": p.id, "name": p.name, "kind": p.kind, "distance_m": round(p.distance_m(lat, lon)),
            "summary": p.one_liner()}


def nearby_now(s: GuideSession) -> list[dict]:
    return [{"id": n.place.id, "name": n.place.name, "side": n.side, "distance_m": round(n.distance_m)}
            for n in s.top_nearby[:3]]


async def run_tool(s: GuideSession, name: str, args: dict) -> ToolResult:
    handler = HANDLERS.get(name)
    if handler is None:
        return ToolResult({"status": "error", "error": f"unknown tool {name}"})
    try:
        res = await handler(s, args)
    except Exception as e:  # noqa: BLE001 — a tool failure must become a spoken "can't check", not a dead session
        res = ToolResult({"status": "error", "error": f"{type(e).__name__}: {e}"[:300]})
    res.output.setdefault("status", "ok")
    res.output["nearby_now"] = nearby_now(s)
    return res


async def lookup(s: GuideSession, args: dict) -> ToolResult:
    ws: WorkingSet = s.ws
    lat, lon = s.pos
    place = ws.by_id.get(args.get("entity_id") or "")
    if place is None:
        found = ws.search(args.get("query", ""), lat, lon)
        place = found[0] if found else None
    # question about "this" / "here": use the most salient nearby place
    if place is None and s.top_nearby and re.search(r"\b(this|that|here|it)\b", args.get("query", "").lower()):
        place = s.top_nearby[0].place
    if place is None:
        return ToolResult({"status": "not_found", "facts": [],
                           "note": "No match in the local data. Use web_search, or say you don't know."})
    return ToolResult({"entity": _place_brief(place, lat, lon), "facts": place.facts(limit=8, query=args.get("query"))},
                      focus=[place])


async def resolve_reference(s: GuideSession, args: dict) -> ToolResult:
    lat, lon = s.pos
    words = set(re.findall(r"[a-z]+", args.get("description", "").lower()))
    direction = args.get("direction", "any")
    scored = []
    for n in s.ws.nearby(lat, lon, s.heading, 220):
        p = n.place
        if p.kind in ("street", "food", "venue", "transit") and not p.hero:
            continue
        text = " ".join([p.name, p.one_liner(), " ".join(str(v) for v in p.attrs.values() if isinstance(v, str)),
                         " ".join(c["text"][:300] for c in p.chunks[:2])]).lower()
        score = sum(1.0 for w in words & (COLOUR_WORDS | SHAPE_WORDS) if w in text)
        score += 0.5 * sum(1 for w in words if len(w) > 4 and w in text)
        if direction != "any" and n.side != direction:
            score -= 1.5
        score += 0.6 * p.prominence + (0.5 if p.hero else 0) - n.distance_m / 200
        scored.append((score, n))
    scored.sort(key=lambda t: -t[0])
    top = scored[:3]
    if not top:
        return ToolResult({"status": "not_found", "candidates": [], "note": "Nothing matching nearby; ask the user."})
    margin = top[0][0] - (top[1][0] if len(top) > 1 else -9)
    confident = margin > 0.8
    cands = [{**_place_brief(n.place, lat, lon), "side": n.side, "confidence": round(1 / (1 + math.exp(-sc)), 2),
              "badge": "AB"[i] if not confident and i < 2 else None} for i, (sc, n) in enumerate(top)]
    note = ("Confident match." if confident else
            "Not sure: ask the user which one (they can also tap it on the map; it is highlighted as A and B).")
    return ToolResult({"candidates": cands, "confident": confident, "note": note,
                       "facts": top[0][1].place.facts(limit=4) if confident else []},
                      focus=[n.place for _, n in (top[:1] if confident else top[:2])], badges=not confident)


async def find_places(s: GuideSession, args: dict) -> ToolResult:
    lat, lon = s.pos
    cat = args.get("category", "").lower()
    preds = next((v for k, v in CATEGORIES.items() if k in cat), [("amenity", {cat})])
    constraints = args.get("constraints", "").lower()
    out = []
    for n in s.ws.nearby(lat, lon, s.heading, 600):
        a = n.place.attrs
        if not any(a.get(k) in vals or (not vals and a.get(k)) for k, vals in preds):
            continue
        if "vegetarian" in constraints and a.get("diet:vegetarian") not in ("yes", "only") and "vegetarian" not in \
                a.get("cuisine", ""):
            continue
        out.append(n)
    out = out[:5]
    places = [{**_place_brief(n.place, lat, lon), "side": n.side, "walk_min": max(1, round(n.distance_m / 80)),
               "cuisine": n.place.attrs.get("cuisine"), "listed_hours": n.place.attrs.get("opening_hours")}
              for n in out]
    return ToolResult({"places": places, "note": "From OpenStreetMap. Listed hours may be outdated: don't claim a "
                                                 "place is open now. No ratings available."},
                      focus=[n.place for n in out[:3]])


async def navigate(s: GuideSession, args: dict) -> ToolResult:
    action = args.get("action")
    if action == "stop":
        s.nav = None
        return ToolResult({"status": "stopped"}, route={"cleared": True})
    if action in ("status", "next_instruction"):
        if not s.nav:
            return ToolResult({"status": "no_route", "note": "No active directions."})
        return ToolResult({"destination": s.nav["destination"], **s.nav_progress()})
    lat, lon = s.pos
    dest = s.ws.by_id.get(args.get("destination", "")) or next(iter(s.ws.search(args.get("destination", ""), lat, lon)),
                                                               None)
    if dest is None:
        return ToolResult({"status": "not_found", "note": "Destination not in local data; ask for another name."})
    try:
        r = await valhalla.route(lat, lon, dest.lat, dest.lon, language=s.nav_language())
    except (httpx.HTTPError, KeyError) as e:
        d = haversine_m(lat, lon, dest.lat, dest.lon)
        return ToolResult({"status": "routing_unavailable", "destination": dest.name, "straight_line_m": round(d),
                           "walk_min_estimate": max(1, round(d * 1.3 / 80)),
                           "note": f"Routing is down ({type(e).__name__}); give only the rough distance and point "
                                   "to the map."}, focus=[dest])
    s.nav = {"destination": dest.name, "entity_id": dest.id, "route": r, "started": time.time(), "next_idx": 1}
    first = r["maneuvers"][:3]
    return ToolResult({"destination": dest.name, "eta_min": round(r["eta_s"] / 60), "distance_m": r["distance_m"],
                       "first_instructions": [m["instruction"] for m in first]}, focus=[dest], route=r)


async def tour(s: GuideSession, args: dict) -> ToolResult:
    action = args.get("action")
    if action == "list" or (action == "start" and args.get("tour_id") not in s.tours):
        return ToolResult({"tours": [{"tour_id": t.id, "title": t.title, "subtitle": t.subtitle,
                                      "minutes": t.duration_min, "stops": [p.name for p in t.stops]}
                                     for t in s.tours.values()],
                           "note": "Offer them by title in one sentence each; start one when the user picks."})
    if action == "start":
        run = await s.start_tour(args["tour_id"], intro_spoken=True)
        return ToolResult({"started": run.tour.title, "theme": run.tour.theme, "first_stop": run.stop.name,
                           "walk_min": run.eta_min(*s.pos),
                           "note": "Give the theme in one sentence and tell them to follow the line on the map to "
                                   "the first stop. You'll tell the story when they arrive."}, focus=[run.stop])
    if not s.tour:
        return ToolResult({"status": "no_tour", "note": "No tour is running."})
    if action == "skip_stop":
        skipped = s.tour.stop.name
        s.tour.arrived.add(s.tour.index)
        s.tour.advance()
        await s.send_tour()
        nxt = None if s.tour.finished else s.tour.stop
        return ToolResult({"skipped": skipped, "next_stop": nxt.name if nxt else None,
                           "walk_min": s.tour.eta_min(*s.pos) if nxt else None}, focus=[nxt] if nxt else [])
    if action == "end":
        await s.end_tour()
        return ToolResult({"ended": True, "note": "Say goodbye to the tour in a few words; keep wandering with them."})
    return ToolResult({"status": "error", "error": f"unknown action {action}"})


async def save_preference(s: GuideSession, args: dict) -> ToolResult:
    value = args.get("value", "").strip()
    if not value or not args.get("evidence"):
        return ToolResult({"status": "rejected", "note": "Need the user's own words."})
    s.prefs = [p for p in s.prefs if p["value"].lower() != value.lower()]
    s.prefs.append({k: args.get(k) for k in ("category", "value", "polarity", "scope", "evidence")})
    s.prefs_changed = True
    return ToolResult({"saved": value, "note": "Confirm lightly in a few words."})


async def forget_preference(s: GuideSession, args: dict) -> ToolResult:
    before = len(s.prefs)
    s.prefs = [p for p in s.prefs if args.get("value", "").lower() not in p["value"].lower()]
    s.prefs_changed = True
    return ToolResult({"removed": before - len(s.prefs)})


async def set_guide_style(s: GuideSession, args: dict) -> ToolResult:
    if args.get("proactivity"):
        s.proactivity = args["proactivity"]
    if args.get("verbosity"):
        s.verbosity = args["verbosity"]
    note = "Say one or two words, then stay silent." if s.proactivity == "quiet" else "Acknowledge briefly."
    return ToolResult({"proactivity": s.proactivity, "verbosity": s.verbosity, "note": note})


async def report_correction(s: GuideSession, args: dict) -> ToolResult:
    CORRECTIONS.parent.mkdir(parents=True, exist_ok=True)
    with CORRECTIONS.open("a") as f:
        f.write(json.dumps({"session_id": s.session_id, "ts": time.time(), **{k: args.get(k) for k in
                            ("entity_id", "claim", "user_says")}}) + "\n")
    return ToolResult({"recorded": True, "note": "Thank them; don't repeat the disputed claim as fact."})


HANDLERS: dict[str, Any] = {
    "lookup": lookup, "resolve_reference": resolve_reference, "find_places": find_places, "navigate": navigate,
    "tour": tour, "save_preference": save_preference, "forget_preference": forget_preference, "set_guide_style": set_guide_style,
    "report_correction": report_correction,
}
