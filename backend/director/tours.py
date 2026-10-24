"""Guided tour mode (IMPLEMENTATION_PLAN.md §8): curated tours from tours/*.json and the per-session tour run.

A run walks stop by stop: route to the current stop (Valhalla), an arrival story when the user is within
ARRIVE_M, then on to the next stop. Wander-style hooks keep running on the legs between stops.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from backend.geo.working_set import Place, WorkingSet, haversine_m

ROOT = Path(__file__).resolve().parents[2]
TOURS_DIR = ROOT / "tours"
ARRIVE_M = 30.0
WALK_MPS = 1.3
DETOUR = 1.3  # straight-line -> walking distance, for estimates before Valhalla answers


@dataclass
class Tour:
    id: str
    title: str
    subtitle: str
    theme: str
    duration_min: int
    stops: list[Place]
    intro: str
    outro: str

    def summary(self) -> dict:
        legs = sum(haversine_m(a.lat, a.lon, b.lat, b.lon) for a, b in zip(self.stops, self.stops[1:], strict=False))
        return {"id": self.id, "title": self.title, "subtitle": self.subtitle, "theme": self.theme,
                "duration_min": self.duration_min, "distance_m": round(legs * DETOUR),
                "image_url": next((p.image_url for p in self.stops if p.image_url), None),
                "stops": [stop_brief(p) for p in self.stops]}


def stop_brief(p: Place) -> dict:
    return {"entity_id": p.id, "name": p.name, "lat": p.lat, "lon": p.lon, "image_url": p.image_url,
            "summary": p.one_liner()}


def load_tours(ws: WorkingSet) -> dict[str, Tour]:
    tours = {}
    for path in sorted(TOURS_DIR.glob("*.json")):
        d = json.loads(path.read_text())
        stops = [ws.by_id[s["entity_id"]] for s in d["stops"] if s["entity_id"] in ws.by_id]
        if len(stops) >= 2:
            tours[d["id"]] = Tour(d["id"], d["title"], d.get("subtitle", ""), d.get("theme", ""),
                                  d.get("duration_min", 45), stops, d.get("intro", ""), d.get("outro", ""))
    return tours


@dataclass
class TourRun:
    tour: Tour
    index: int = 0
    arrived: set[int] = field(default_factory=set)
    started: bool = False  # intro spoken
    route: dict | None = None  # Valhalla leg to the current stop
    route_for: int = -1
    cued: set[int] = field(default_factory=set)  # maneuver indexes already cued
    finished: bool = False

    @property
    def stop(self) -> Place:
        return self.tour.stops[self.index]

    @property
    def next_stop(self) -> Place | None:
        return self.tour.stops[self.index + 1] if self.index + 1 < len(self.tour.stops) else None

    def advance(self) -> None:
        if self.index + 1 < len(self.tour.stops):
            self.index += 1
            self.route, self.route_for, self.cued = None, -1, set()
        else:
            self.finished = True

    def eta_min(self, lat: float, lon: float) -> int:
        if self.route and self.route_for == self.index:
            return max(1, round(self.route["eta_s"] / 60))
        return max(1, round(haversine_m(lat, lon, self.stop.lat, self.stop.lon) * DETOUR / WALK_MPS / 60))

    def message(self, lat: float, lon: float) -> dict:
        """Downlink `tour` message (protocol TourState)."""
        stops = []
        for i, p in enumerate(self.tour.stops):
            status = "done" if i < self.index or i in self.arrived else "current" if i == self.index else "upcoming"
            stops.append({**stop_brief(p), "status": status})
        return {"type": "tour", "tour_id": self.tour.id, "title": self.tour.title, "subtitle": self.tour.subtitle,
                "status": "ended" if self.finished else "active", "current": self.index, "stops": stops,
                "leg_eta_min": None if self.finished else self.eta_min(lat, lon),
                "leg_distance_m": None if self.finished else round(self.stop.distance_m(lat, lon))}
