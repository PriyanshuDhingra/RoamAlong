"""In-memory place index for the demo area (§7.2, §7.3, §14.2 L1/L2).

The demo area has ~1,700 entities, so everything lives in process memory, loaded from the pipeline's staging
files, and queries are brute force. Postgres (§10.3) replaces this when the dataset outgrows memory.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path

from pipeline.common import distance_to_geom_m

ROOT = Path(__file__).resolve().parents[2]
STAGING = ROOT / "data" / "staging"
HEROES = ROOT / "pipeline" / "curated" / "hero_places.json"
EARTH_R = 6_371_008.8

# Kinds worth talking about unprompted. Food/venues/transit only come up when asked.
TALKABLE = {"building", "artwork", "monument", "plaque", "park", "area", "street", "river"}


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def relative_side(heading: float | None, bearing: float) -> str:
    """ahead (±35°), left/right (35–110°), behind (§7.2). Unknown heading -> 'nearby'."""
    if heading is None:
        return "nearby"
    d = (bearing - heading + 540) % 360 - 180
    if abs(d) <= 35:
        return "ahead"
    if abs(d) <= 110:
        return "right" if d > 0 else "left"
    return "behind"


def _norm(s: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", s.lower()).split())


def _outline_points(geom: dict | None) -> list[tuple[float, float]]:
    """(lat, lon) vertices of a geometry, for nearest-point distances (footprint, not centroid)."""
    if not geom:
        return []
    t, c = geom["type"], geom["coordinates"]
    rings = {"Polygon": lambda: c, "MultiPolygon": lambda: [r for p in c for r in p], "LineString": lambda: [c],
             "MultiLineString": lambda: c}.get(t, list)()
    return [(p[1], p[0]) for ring in rings for p in ring]


@dataclass
class Place:
    id: str
    kind: str
    name: str
    names: dict[str, str]
    lat: float
    lon: float
    geometry: dict | None
    height_m: float | None
    attrs: dict
    prominence: float
    prominence_raw: float
    wikidata_id: str | None
    hero: bool = False
    hero_note: str = ""
    chunks: list[dict] = field(default_factory=list)

    def distance_m(self, lat: float, lon: float) -> float:
        """Metres to the nearest edge of the footprint/path (0 inside), not to the centroid."""
        if not self.geometry:
            return haversine_m(lat, lon, self.lat, self.lon)
        return distance_to_geom_m(lat, lon, self.geometry)

    @property
    def wd(self) -> dict:
        return self.attrs.get("wd", {})

    def one_liner(self) -> str:
        """Short spoken-ready descriptor for the SITUATION block, from structured data only."""
        bits = []
        if self.wd.get("description"):
            bits.append(self.wd["description"])
        if self.wd.get("inception"):
            bits.append(f"built {self.wd['inception']}")
        if self.wd.get("architect"):
            bits.append("architect " + ", ".join(self.wd["architect"][:2]))
        if self.wd.get("style"):
            bits.append(", ".join(self.wd["style"][:1]))
        if not bits:
            bits.append(self.kind)
        return "; ".join(bits)

    def facts(self, limit: int = 8, query: str | None = None) -> list[dict]:
        """Evidence packet (§10.4): structured facts first, then the text chunks most relevant to the query."""
        src_wd = f"https://www.wikidata.org/wiki/{self.wikidata_id}" if self.wikidata_id else None
        out: list[dict] = []

        def add(text: str, source: str | None, claim: str = "established") -> None:
            out.append({"text": text, "source": source, "claim_type": claim})

        wd, a = self.wd, self.attrs
        if wd.get("description"):
            add(f"{self.name}: {wd['description']}.", src_wd)
        if wd.get("inception") or a.get("start_date"):
            add(f"{self.name} dates from {wd.get('inception') or a.get('start_date')}.", src_wd)
        if wd.get("architect") or a.get("architect"):
            add(f"Architect: {', '.join(wd.get('architect') or [a['architect']])}.", src_wd)
        if wd.get("style"):
            add(f"Architectural style: {', '.join(wd['style'])}.", src_wd)
        if wd.get("heritage"):
            add(f"Heritage designation: {', '.join(wd['heritage'])}.", src_wd)
        if wd.get("named_after"):
            add(f"Named after: {', '.join(wd['named_after'])}.", src_wd)
        if wd.get("creator"):
            add(f"Created by: {', '.join(wd['creator'])}.", src_wd)
        if self.height_m:
            add(f"About {self.height_m:.0f} m tall.", "OpenStreetMap")
        for k, label in (("building:material", "Material"), ("roof:colour", "Roof colour"), ("cuisine", "Cuisine"),
                         ("opening_hours", "Listed opening hours (may be out of date)")):
            if a.get(k):
                add(f"{label}: {a[k]}.", "OpenStreetMap")

        chunks = self.chunks
        if query:
            q = set(_norm(query).split()) - {"the", "a", "of", "is", "what", "how", "when", "who", "this", "that"}
            chunks = sorted(chunks, key=lambda c: -len(q & set(_norm(c["text"]).split())))
        for c in chunks[: max(0, limit - len(out)) or 2]:
            add(c["text"], c["source_url"])
        return out[: limit + 2]

    def feature(self) -> dict:
        """GeoJSON feature for the map focus layer."""
        geom = self.geometry or {"type": "Point", "coordinates": [self.lon, self.lat]}
        return {"type": "Feature", "id": self.id, "geometry": geom,
                "properties": {"id": self.id, "name": self.name, "names": self.names, "kind": self.kind,
                               "hero": self.hero, "height_m": self.height_m or 12}}


@dataclass
class Nearby:
    place: Place
    distance_m: float
    bearing: float
    side: str


class WorkingSet:
    def __init__(self, places: list[Place]):
        self.places = places
        self.by_id = {p.id: p for p in places}

    @classmethod
    def load(cls) -> WorkingSet:
        heroes = {h["id"]: h for h in json.loads(HEROES.read_text())["places"]} if HEROES.exists() else {}
        chunks: dict[str, list[dict]] = {}
        wiki = STAGING / "wiki_chunks.jsonl"
        if wiki.exists():
            for line in wiki.open():
                c = json.loads(line)
                chunks.setdefault(c["entity_id"], []).append(c)
        places = []
        for line in (STAGING / "entities.jsonl").open():
            e = json.loads(line)
            h = heroes.get(e["id"])
            places.append(Place(
                id=e["id"], kind=e["kind"], name=e["name"], names=e["names"], lat=e["lat"], lon=e["lon"],
                geometry=e["geometry"], height_m=e["height_m"], attrs=e["attrs"], prominence=e["prominence"],
                prominence_raw=e["prominence_raw"], wikidata_id=e["wikidata_id"], hero=bool(h),
                hero_note=(h or {}).get("why", ""), chunks=chunks.get(e["id"], [])))
        ws = cls(places)
        ws._borrow_geometry()
        return ws

    def _borrow_geometry(self) -> None:
        """Point-only heroes take the outline of a same-named OSM path/area (Philosopher's Walk), else the
        nearest building footprint within 30 m of their point (Hart House)."""
        fp_path = STAGING / "osm_footprints.jsonl"
        footprints = [json.loads(line) for line in fp_path.open()] if fp_path.exists() else []
        for p in self.places:
            if not p.hero or p.geometry:
                continue
            twin = next((q for q in self.places if q is not p and q.geometry and _norm(q.name) == _norm(p.name)
                         and haversine_m(p.lat, p.lon, q.lat, q.lon) < 400), None)
            if twin:
                p.geometry = twin.geometry
            elif p.kind == "building" and footprints:
                near = [f for f in footprints if haversine_m(p.lat, p.lon, *_outline_points(f["geometry"])[0]) < 300]
                best = min(near, key=lambda f: distance_to_geom_m(p.lat, p.lon, f["geometry"]), default=None)
                if best and distance_to_geom_m(p.lat, p.lon, best["geometry"]) < 30:
                    p.geometry, p.height_m = best["geometry"], p.height_m or best["height_m"]

    def nearby(self, lat: float, lon: float, heading: float | None = None, radius_m: float = 250,
               kinds: set[str] | None = None) -> list[Nearby]:
        out = []
        for p in self.places:
            if kinds and p.kind not in kinds:
                continue
            if haversine_m(lat, lon, p.lat, p.lon) > radius_m + 400:  # cheap prefilter before outline distance
                continue
            d = p.distance_m(lat, lon)
            if d <= radius_m:
                b = bearing_deg(lat, lon, p.lat, p.lon)
                out.append(Nearby(p, d, b, relative_side(heading, b)))
        return sorted(out, key=lambda n: n.distance_m)

    def interesting_nearby(self, lat: float, lon: float, heading: float | None, radius_m: float = 200,
                           limit: int = 6) -> list[Nearby]:
        """Top talkable places by prominence, closeness and visibility (simplified §7.4 scoring)."""
        cands = [n for n in self.nearby(lat, lon, heading, radius_m, TALKABLE)
                 if n.place.wikidata_id or n.place.hero or n.place.chunks]
        return sorted(cands, key=lambda n: -self.salience(n))[:limit]

    @staticmethod
    def salience(n: Nearby) -> float:
        vis = {"ahead": 1.0, "left": 0.8, "right": 0.8, "nearby": 0.7, "behind": 0.3}[n.side]
        closeness = max(0.0, 1 - n.distance_m / 250)
        return (1.5 if n.place.hero else 0) + n.place.prominence + vis + 1.5 * closeness

    def search(self, query: str, lat: float | None = None, lon: float | None = None, limit: int = 3) -> list[Place]:
        """Name / alias match, biased to nearby places."""
        q = _norm(query)
        if not q:
            return []
        scored = []
        for p in self.places:
            names = {p.name, *p.names.values()}
            best = 0.0
            for n in names:
                nn = _norm(n)
                if not nn:
                    continue
                if nn == q:
                    s = 1.0
                elif len(nn) >= 5 and (nn in q or q in nn):
                    s = 0.9
                else:
                    s = SequenceMatcher(None, q, nn).ratio()
                best = max(best, s)
            if best < 0.6:
                continue
            if lat is not None:
                best -= min(0.3, haversine_m(lat, lon, p.lat, p.lon) / 5000)
            best += 0.1 * p.prominence + (0.1 if p.hero else 0)
            scored.append((best, p))
        return [p for _, p in sorted(scored, key=lambda t: -t[0])[:limit]]

    def heroes(self) -> list[Place]:
        return [p for p in self.places if p.hero]
