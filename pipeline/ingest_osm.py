"""OSM ingest for the demo area via the Overpass API (§10.4 step 1).

The plan's full-city path is `osmium extract` + `osm2pgsql --output=flex`; for the ~3 km² demo bbox a single
Overpass query is enough and needs no local tooling. Output:

  data/raw/osm_overpass.json          raw response (cached; pass --refresh to refetch)
  data/staging/osm_features.jsonl     named / notable features, normalized (entity candidates)
  data/staging/osm_footprints.jsonl   every building footprint with height (for FOV occlusion, §7.2)

ODbL: attribution "© OpenStreetMap contributors" is required wherever this data is shown.
"""

from __future__ import annotations

import argparse
import json
import re
from typing import Any

from pipeline.common import (
    RAW,
    STAGING,
    area_m2,
    bbox_from_env,
    http_client,
    representative_point,
    request_with_retry,
    write_jsonl,
)

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

QUERY = """
[out:json][timeout:240][bbox:{bbox}];
(
  way["building"]; relation["building"];
  nwr["tourism"]; nwr["historic"];
  nwr["leisure"~"^(park|garden|nature_reserve)$"];
  nwr["amenity"]["name"];
  nwr["shop"]["name"];
  way["highway"]["name"];
  nwr["waterway"]["name"]; nwr["natural"="water"];
  nwr["railway"="station"]; nwr["public_transport"="station"];
  node["place"~"^(neighbourhood|suburb|quarter)$"];
  nwr["wikidata"];
);
out body geom;
"""

# Tags kept in `attrs` (everything else is dropped to keep rows small).
KEEP_TAGS = {
    "building", "building:levels", "building:material", "building:colour", "building:architecture",
    "roof:colour", "roof:shape", "roof:material", "height", "min_height",
    "architect", "start_date", "construction_date", "heritage", "heritage:operator", "ref:heritage",
    "amenity", "tourism", "historic", "leisure", "shop", "cuisine", "diet:vegetarian", "diet:vegan",
    "opening_hours", "website", "wikipedia", "wikidata",
    "artwork_type", "artist_name", "material", "memorial", "inscription", "description", "subject:wikidata",
    "highway", "railway", "public_transport", "waterway", "natural", "place", "operator",
    "addr:housenumber", "addr:street", "religion", "denomination", "wheelchair",
}

FOOD = {"restaurant", "cafe", "bar", "pub", "fast_food", "ice_cream", "food_court", "biergarten"}
VENUE_AMENITY = {"theatre", "arts_centre", "cinema", "library", "place_of_worship", "community_centre", "music_venue"}
STREET_HIGHWAYS = {
    "primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "pedestrian",
    "service", "footway", "path", "cycleway", "steps", "primary_link", "secondary_link", "tertiary_link",
}


def classify(tags: dict[str, str]) -> str | None:
    """Entity kind (protocol EntityKind) or None if the feature isn't an entity candidate."""
    if tags.get("tourism") == "artwork":
        return "artwork"
    hist = tags.get("historic")
    if hist:
        if hist == "memorial" and tags.get("memorial") in ("plaque", "blue_plaque"):
            return "plaque"
        if hist in ("memorial", "monument", "statue"):
            return "monument"
        if hist == "building" or "building" in tags:
            return "building"
        return "monument"
    if tags.get("railway") == "station" or tags.get("public_transport") == "station":
        return "transit"
    if tags.get("amenity") in FOOD:
        return "food"
    if tags.get("tourism") in ("museum", "gallery", "attraction") or tags.get("amenity") in VENUE_AMENITY:
        return "building" if "building" in tags else "venue"
    if tags.get("leisure") in ("park", "garden", "nature_reserve"):
        return "park"
    if "waterway" in tags or tags.get("natural") == "water":
        return "river" if "waterway" in tags else "other"
    if tags.get("place") or (tags.get("amenity") in ("university", "college") and "building" not in tags):
        return "area"
    if tags.get("highway") in STREET_HIGHWAYS:
        return "street"
    if "building" in tags:
        return "building"
    if tags.get("shop") or tags.get("amenity") or tags.get("tourism"):
        return "venue"
    return None


_NUM = re.compile(r"[-+]?\d+(?:\.\d+)?")


def parse_height(tags: dict[str, str]) -> tuple[float | None, str | None]:
    """(metres, how) from `height` (m or ft) or `building:levels` × 3.2 m."""
    h = tags.get("height")
    if h:
        m = _NUM.search(h.replace(",", "."))
        if m:
            v = float(m.group())
            if "'" in h or "ft" in h:
                v *= 0.3048
            return round(v, 1), "osm:height"
    lv = tags.get("building:levels")
    if lv:
        m = _NUM.search(lv)
        if m:
            return round(float(m.group()) * 3.2, 1), "osm:levels"
    return None, None


def _coords(geometry: list[dict]) -> list[list[float]]:
    return [[round(p["lon"], 7), round(p["lat"], 7)] for p in geometry if p]


def _merge_rings(segments: list[list[list[float]]]) -> list[list[list[float]]]:
    """Join open way segments end-to-end into closed rings (multipolygon outers)."""
    rings, open_ = [], [s for s in segments if len(s) >= 2]
    while open_:
        ring = open_.pop()
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, seg in enumerate(open_):
                if seg[0] == ring[-1]:
                    ring += seg[1:]
                elif seg[-1] == ring[-1]:
                    ring += seg[::-1][1:]
                elif seg[-1] == ring[0]:
                    ring = seg[:-1] + ring
                elif seg[0] == ring[0]:
                    ring = seg[::-1][:-1] + ring
                else:
                    continue
                open_.pop(i)
                changed = True
                break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def element_geometry(el: dict) -> dict | None:
    t = el["type"]
    if t == "node":
        return {"type": "Point", "coordinates": [round(el["lon"], 7), round(el["lat"], 7)]}
    if t == "way":
        c = _coords(el.get("geometry", []))
        if len(c) < 2:
            return None
        tags = el.get("tags", {})
        closed = c[0] == c[-1] and len(c) >= 4
        is_area = closed and not (tags.get("highway") and tags.get("area") != "yes") and "waterway" not in tags
        return {"type": "Polygon", "coordinates": [c]} if is_area else {"type": "LineString", "coordinates": c}
    if t == "relation":
        members = [m for m in el.get("members", []) if m.get("type") == "way" and m.get("geometry")]
        outers = [_coords(m["geometry"]) for m in members if m.get("role") in ("outer", "")]
        rings = _merge_rings(outers)
        if rings:
            return {"type": "MultiPolygon", "coordinates": [[r] for r in rings]}
        lines = [c for c in (_coords(m["geometry"]) for m in members) if len(c) >= 2]
        if lines:
            return {"type": "MultiLineString", "coordinates": lines}
    return None


def names_from_tags(tags: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    names = {k[5:]: v for k, v in tags.items() if k.startswith("name:") and len(k) <= 10}
    if "name" in tags:
        names.setdefault("en", tags["name"])
    aliases = [v for k in ("alt_name", "old_name", "official_name", "short_name", "loc_name") if (v := tags.get(k))]
    return names, aliases


def normalize(el: dict) -> tuple[dict | None, dict | None]:
    """(entity candidate, building footprint) for one Overpass element; either may be None."""
    tags = el.get("tags", {})
    geom = element_geometry(el)
    if geom is None:
        return None, None
    osm_id = f"{el['type'][0]}{el['id']}"
    height, height_src = parse_height(tags)

    footprint = None
    if "building" in tags and geom["type"] in ("Polygon", "MultiPolygon"):
        footprint = {"osm_id": osm_id, "geometry": geom, "height_m": height, "height_src": height_src}

    kind = classify(tags)
    name = tags.get("name")
    notable = bool(tags.get("wikidata") or tags.get("heritage") or tags.get("historic") or tags.get("tourism"))
    if kind is None or (not name and not notable):
        return None, footprint
    if kind == "street" and not name:
        return None, footprint

    lat, lon = representative_point(geom)
    names, aliases = names_from_tags(tags)
    feature = {
        "osm_id": osm_id,
        "kind": kind,
        "name": name or tags.get("description") or tags.get("inscription", "")[:60] or f"{kind} {osm_id}",
        "named": bool(name),
        "names": names,
        "aliases": aliases,
        "lat": round(lat, 7),
        "lon": round(lon, 7),
        "geometry": geom,
        "area_m2": round(area_m2(geom), 1),
        "height_m": height,
        "height_src": height_src,
        "wikidata": tags.get("wikidata"),
        "attrs": {k: v for k, v in tags.items() if k in KEEP_TAGS},
    }
    return feature, footprint


def fetch(refresh: bool) -> dict[str, Any]:
    bbox = bbox_from_env()
    cache = RAW / f"osm_overpass_{bbox.overpass().replace(',', '_')}.json"
    if cache.exists() and not refresh:
        print(f"using cached {cache.relative_to(RAW.parent.parent)}")
        return json.loads(cache.read_text())
    print(f"querying Overpass for bbox {bbox.overpass()} …")
    with http_client() as client:
        r = request_with_retry(client, "POST", OVERPASS_URL, data={"data": QUERY.format(bbox=bbox.overpass())})
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(r.content)
    return r.json()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--refresh", action="store_true", help="ignore the cached Overpass response")
    args = ap.parse_args()

    data = fetch(args.refresh)
    features, footprints = [], []
    for el in data.get("elements", []):
        f, fp = normalize(el)
        if f:
            features.append(f)
        if fp:
            footprints.append(fp)

    n_f = write_jsonl(STAGING / "osm_features.jsonl", features)
    n_fp = write_jsonl(STAGING / "osm_footprints.jsonl", footprints)
    kinds: dict[str, int] = {}
    for f in features:
        kinds[f["kind"]] = kinds.get(f["kind"], 0) + 1
    print(f"elements: {len(data.get('elements', []))}  features: {n_f}  footprints: {n_fp}")
    print("by kind: " + ", ".join(f"{k}={v}" for k, v in sorted(kinds.items(), key=lambda kv: -kv[1])))


if __name__ == "__main__":
    main()
