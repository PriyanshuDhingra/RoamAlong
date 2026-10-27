"""Shared config, HTTP, IO and geometry helpers for the ingestion pipeline (§10.4)."""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import os
import re
import time
import unicodedata
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
STAGING = ROOT / "data" / "staging"


@dataclass(frozen=True)
class BBox:
    south: float
    west: float
    north: float
    east: float

    def overpass(self) -> str:
        return f"{self.south},{self.west},{self.north},{self.east}"

    def contains(self, lat: float, lon: float) -> bool:
        return self.south <= lat <= self.north and self.west <= lon <= self.east


# Hackathon demo area (§1.2): UofT St. George -> Queen's Park -> Philosopher's Walk -> ROM -> Yorkville.
# Roughly Spadina to Bay, College to Davenport (~3 km²). Override with WANDER_BBOX="s,w,n,e".
DEMO_BBOX = BBox(43.6560, -79.4030, 43.6740, -79.3860)


def bbox_from_env() -> BBox:
    raw = os.environ.get("WANDER_BBOX")
    if not raw:
        return DEMO_BBOX
    s, w, n, e = (float(x) for x in raw.split(","))
    return BBox(s, w, n, e)


USER_AGENT = os.environ.get(
    "WANDER_CONTACT",
    "wander-hackathon (https://github.com/PriyanshuDhingra/realtime-conversation-walking-guide)",
)


def http_client() -> httpx.Client:
    return httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=httpx.Timeout(300, connect=20))


def request_with_retry(client: httpx.Client, method: str, url: str, *, tries: int = 4, **kw: Any) -> httpx.Response:
    """Retry on 429/5xx and network errors with exponential backoff (public APIs throttle aggressively)."""
    for attempt in range(tries):
        try:
            r = client.request(method, url, **kw)
            if r.status_code not in (429, 500, 502, 503, 504):
                r.raise_for_status()
                return r
            wait = float(r.headers.get("Retry-After", 0)) or 5 * 2**attempt
        except httpx.TransportError:
            if attempt == tries - 1:
                raise
            wait = 5 * 2**attempt
        print(f"  retrying {url[:60]}… in {wait:.0f}s")
        time.sleep(wait)
    r.raise_for_status()
    return r


def write_jsonl(path: Path, rows: Iterable[dict]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += 1
    return n


def read_jsonl(path: Path) -> Iterator[dict]:
    with path.open() as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def entity_id(key: str) -> str:
    """Stable id from the entity's primary source key (wikidata QID, else OSM id)."""
    return "e_" + hashlib.sha1(key.encode()).hexdigest()[:10]


def normalize_name(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = s.replace("&", " and ")
    s = re.sub(r"\b(the|of|at)\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())


# --- geometry (lon/lat GeoJSON; planar math is fine at neighbourhood scale) ---

EARTH_R = 6_371_008.8


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def _ring_centroid(ring: list[list[float]]) -> tuple[float, float, float]:
    """(signed area, cx, cy) of a closed ring via the shoelace formula."""
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in itertools.pairwise(ring):
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    a /= 2
    if abs(a) < 1e-14:
        xs, ys = zip(*ring)
        return 0.0, sum(xs) / len(xs), sum(ys) / len(ys)
    return a, cx / (6 * a), cy / (6 * a)


def _line_midpoint(line: list[list[float]]) -> tuple[float, float, float]:
    """(length in degrees, x, y) of the point halfway along a polyline."""
    segs = [math.dist(a, b) for a, b in itertools.pairwise(line)]
    total = sum(segs)
    if total == 0:
        return 0.0, line[0][0], line[0][1]
    half, acc = total / 2, 0.0
    for (a, b), d in zip(itertools.pairwise(line), segs):
        if acc + d >= half:
            t = (half - acc) / d if d else 0
            return total, a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])
        acc += d
    return total, line[-1][0], line[-1][1]


def representative_point(geom: dict) -> tuple[float, float]:
    """(lat, lon): area centroid for polygons, halfway point of the longest line for lines."""
    t, c = geom["type"], geom["coordinates"]
    if t == "Point":
        return c[1], c[0]
    if t == "Polygon":
        _, x, y = _ring_centroid(c[0])
        return y, x
    if t == "MultiPolygon":
        best = max((_ring_centroid(p[0]) for p in c), key=lambda r: abs(r[0]))
        return best[2], best[1]
    if t == "LineString":
        _, x, y = _line_midpoint(c)
        return y, x
    if t == "MultiLineString":
        best = max((_line_midpoint(line) for line in c), key=lambda r: r[0])
        return best[2], best[1]
    raise ValueError(f"unsupported geometry {t}")


def _rings_and_lines(geom: dict) -> tuple[list[list[list[float]]], list[list[list[float]]]]:
    t, c = geom["type"], geom["coordinates"]
    if t == "Polygon":
        return [c[0]], []
    if t == "MultiPolygon":
        return [p[0] for p in c], []
    if t == "LineString":
        return [], [c]
    if t == "MultiLineString":
        return [], c
    return [], []


def _in_ring(x: float, y: float, ring: list[list[float]]) -> bool:
    inside = False
    for (x0, y0), (x1, y1) in itertools.pairwise(ring):
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            inside = not inside
    return inside


def distance_to_geom_m(lat: float, lon: float, geom: dict) -> float:
    """Metres from a point to a geometry's outline (0 inside a polygon). Local equirectangular projection."""
    if geom["type"] == "Point":
        return haversine_m(lat, lon, geom["coordinates"][1], geom["coordinates"][0])
    rings, lines = _rings_and_lines(geom)
    if any(_in_ring(lon, lat, r) for r in rings):
        return 0.0
    kx = math.radians(1) * EARTH_R * math.cos(math.radians(lat))
    ky = math.radians(1) * EARTH_R
    best = math.inf
    for line in rings + lines:
        for (x0, y0), (x1, y1) in itertools.pairwise(line):
            ax, ay = (x0 - lon) * kx, (y0 - lat) * ky
            bx, by = (x1 - lon) * kx, (y1 - lat) * ky
            dx, dy = bx - ax, by - ay
            t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
            best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def area_m2(geom: dict) -> float:
    if geom["type"] not in ("Polygon", "MultiPolygon"):
        return 0.0
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    total = 0.0
    for poly in polys:
        lat = poly[0][0][1]
        kx = math.radians(1) * EARTH_R * math.cos(math.radians(lat))
        ky = math.radians(1) * EARTH_R
        a, _, _ = _ring_centroid(poly[0])
        total += abs(a) * kx * ky
    return total
