"""Thin Valhalla client: pedestrian route + maneuvers (§9). Directions come from route geometry, never the model."""

from __future__ import annotations

import os

import httpx

VALHALLA_URL = os.environ.get("VALHALLA_URL", "http://localhost:8002")


def decode_polyline6(s: str) -> list[list[float]]:
    """Valhalla's encoded polyline (precision 6) -> [[lon, lat], ...]."""
    coords, idx, lat, lon = [], 0, 0, 0
    while idx < len(s):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[idx]) - 63
                idx += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += delta
            else:
                lon += delta
        coords.append([lon / 1e6, lat / 1e6])
    return coords


async def route(from_lat: float, from_lon: float, to_lat: float, to_lon: float, language: str = "en-US") -> dict:
    """{'geojson': LineString, 'maneuvers': [...], 'eta_s', 'distance_m'}; raises httpx errors when Valhalla is down."""
    body = {"locations": [{"lat": from_lat, "lon": from_lon}, {"lat": to_lat, "lon": to_lon}],
            "costing": "pedestrian", "directions_options": {"units": "kilometers", "language": language}}
    async with httpx.AsyncClient(timeout=5) as client:
        r = await client.post(f"{VALHALLA_URL}/route", json=body)
        r.raise_for_status()
    leg = r.json()["trip"]["legs"][0]
    shape = decode_polyline6(leg["shape"])
    maneuvers = []
    for i, m in enumerate(leg["maneuvers"]):
        lon, lat = shape[m["begin_shape_index"]]
        maneuvers.append({"index": i, "instruction": m["instruction"], "lat": lat, "lon": lon,
                          "distance_m": round(m.get("length", 0) * 1000), "street_names": m.get("street_names", [])})
    return {"geojson": {"type": "LineString", "coordinates": shape}, "maneuvers": maneuvers,
            "eta_s": leg["summary"]["time"], "distance_m": round(leg["summary"]["length"] * 1000)}
