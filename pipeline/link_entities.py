"""Link OSM features and Wikidata items into unified entities (§10.4 step 4, entity resolution).

Rules (one real-world thing = one entity):
  1. Named street segments merge by name into one street entity.
  2. OSM features sharing a `wikidata` tag merge (largest polygon is the primary geometry).
  3. An untagged OSM point merges into a same-named polygon within 75 m (e.g. museum node inside its building).
  4. A Wikidata item without an OSM tag link merges into an OSM entity within 75 m (300 m for streets) of a
     compatible kind when the names match closely; near-misses go to a review list instead of auto-merging.
  5. Wikidata items that aren't places you can stand near (organisations, journals, events, the city itself)
     are dropped unless OSM links them.

Output (data/staging/):
  entities.jsonl          unified entities, shaped like the `entity` table (§10.3) plus raw fields for later steps
  link_review.jsonl       uncertain merges for a human to check; decisions go in pipeline/curated/link_overrides.json
  wikidata_dropped.jsonl  non-place Wikidata items, for transparency
"""

from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from difflib import SequenceMatcher

import h3

from pipeline.common import (
    ROOT,
    STAGING,
    bbox_from_env,
    distance_to_geom_m,
    entity_id,
    haversine_m,
    normalize_name,
    read_jsonl,
    write_jsonl,
)

# Human decisions on link_review.jsonl rows: {"reject": [{"osm_id": ..., "qid": ..., "why": ...}]}
OVERRIDES = ROOT / "pipeline" / "curated" / "link_overrides.json"
# Curated prominence boost (the a5 term), keyed by Wikidata QID: {"Q...": {"boost": 0..1, "why": "..."}}
BOOSTS = ROOT / "pipeline" / "curated" / "boosts.json"

AUTO_MERGE_SIM = 0.85
REVIEW_SIM = 0.6
MERGE_RADIUS_M = 75
STREET_MERGE_RADIUS_M = 300

# Wikidata P31 label keywords -> kind. Checked in order; first match wins.
WD_KIND_KEYWORDS = [
    ("artwork", ("statue", "sculpture", "visual artwork", "mural", "artwork", "bust")),
    ("monument", ("monument", "memorial", "cenotaph")),
    ("plaque", ("plaque",)),
    ("park", ("park", "garden", "square", "cemetery", "burying ground")),
    ("street", ("street", "road", "avenue", "boulevard", "lane")),
    ("area", ("neighborhood", "neighbourhood", "district", "village", "quarter", "campus")),
    ("transit", ("station",)),
    ("food", ("restaurant", "cafe", "café", "bar", "pub", "bakery")),
    ("river", ("river", "creek", "stream", "watercourse")),
    ("building", ("building", "skyscraper", "house", "dormitory", "hotel", "structure", "tower", "hospital",
                  "church", "chapel", "construction", "complex", "observatory", "stadium", "college", "residence",
                  "planetarium")),
    ("venue", ("museum", "theatre", "theater", "hall", "venue", "library", "gallery", "cinema", "arena")),
]
# Types that are never a place on their own (only kept if OSM links them).
WD_NON_PLACE = ("journal", "festival", "event", "edition", "electoral district", "city", "metropolis",
                "rapid transit", "metro system", "organization", "organisation", "company", "business",
                "faculty", "unit", "archive", "collection", "network", "institute", "school", "university in",
                "collegiate university", "public university")

WD_KIND_OVERRIDES = ("artwork", "monument", "plaque", "park", "area", "street", "transit", "river")

KIND_GROUP = {
    "building": "built", "venue": "built", "food": "built", "transit": "built",
    "artwork": "art", "monument": "art", "plaque": "art",
    "park": "open", "area": "open",
    "street": "street", "river": "water", "other": "other",
}

# Prominence weights (§10.4 step 12). Starting values, to tune after the first coverage review.
A_WIKI, A_SITELINKS, A_HERITAGE, A_HEIGHT, A_CURATED, BIAS = 0.35, 0.6, 1.0, 0.3, 2.0, -3.0


def kinds_compatible(osm_kind: str, wd_kind_: str) -> bool:
    if wd_kind_ == "other":
        return True
    a, b = KIND_GROUP.get(osm_kind), KIND_GROUP.get(wd_kind_)
    # a college/campus polygon (area) and a Wikidata "building" item are often the same thing
    return a == b or {a, b} == {"built", "open"} and "area" in (osm_kind, wd_kind_)


def attach_footprints(ents: list[dict], footprints: list[dict]) -> int:
    """Give point-only Wikidata buildings the unnamed OSM footprint they sit inside (e.g. Hart House)."""
    used = {i for e in ents for i in e["osm_ids"]}
    free = [fp for fp in footprints if fp["osm_id"] not in used]
    n = 0
    for e in ents:
        if e["osm_ids"] or e["kind"] not in ("building", "venue", "other"):
            continue
        fp = next((fp for fp in free if distance_to_geom_m(e["lat"], e["lon"], fp["geometry"]) == 0), None)
        if fp is None:
            continue
        free.remove(fp)
        e.update(geometry=fp["geometry"], osm_ids=[fp["osm_id"]], height_m=e["height_m"] or fp["height_m"],
                 link_method="wikidata point inside unnamed footprint")
        if e["kind"] == "other":
            e["kind"] = "building"
        n += 1
    return n


def wd_kind(item: dict) -> tuple[str | None, bool]:
    """(kind, is_place). Place keywords beat non-place ones (a 'university building' is a place)."""
    types = " | ".join(t.lower() for t in item.get("instance_of", []))
    for kind, words in WD_KIND_KEYWORDS:
        if _has_word(types, words):  # whole words: "pub" must not match "public university"
            return kind, True
    if not types or _has_word(types, WD_NON_PLACE):
        return None, False
    return "other", True


def _has_word(text: str, words: tuple[str, ...]) -> bool:
    return any(re.search(rf"\b{re.escape(w)}s?\b", text) for w in words)


def name_sim(a: str, b: str) -> float:
    na, nb = normalize_name(a), normalize_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if (na in nb or nb in na) and min(len(na), len(nb)) >= 6:
        return 0.9
    return SequenceMatcher(None, na, nb).ratio()


def best_name_sim(item: dict, ent: dict) -> float:
    item_names = {item["label"], *item.get("labels", {}).values()}
    ent_names = {ent["name"], *ent.get("names", {}).values(), *ent.get("aliases", [])}
    return max(name_sim(a, b) for a in item_names for b in ent_names)


def _geom_rank(f: dict) -> tuple[int, float]:
    return ({"MultiPolygon": 3, "Polygon": 3, "MultiLineString": 2, "LineString": 2}.get(f["geometry"]["type"], 1),
            f["area_m2"])


def merge_osm(features: list[dict]) -> dict:
    """Combine OSM features describing the same thing; the largest polygon provides the geometry."""
    features = sorted(features, key=_geom_rank, reverse=True)
    primary = dict(features[0])
    attrs, names, aliases = {}, {}, []
    for f in reversed(features):  # primary's values win
        attrs.update(f["attrs"])
        names.update(f["names"])
        aliases += f["aliases"]
    if not primary["named"]:
        named = next((f for f in features if f["named"]), None)
        if named:
            primary["name"], primary["named"] = named["name"], True
    primary.update(attrs=attrs, names=names, aliases=sorted(set(aliases)),
                   osm_ids=[f["osm_id"] for f in features])
    if primary["kind"] == "venue" and "building" in attrs:
        primary["kind"] = "building"
    primary["height_m"] = next((f["height_m"] for f in features if f["height_m"]), None)
    return primary


def merge_streets(segments: list[dict]) -> list[dict]:
    by_name: dict[str, list[dict]] = defaultdict(list)
    for s in segments:
        by_name[normalize_name(s["name"])].append(s)
    streets = []
    for segs in by_name.values():
        lines = [s["geometry"]["coordinates"] for s in segs if s["geometry"]["type"] == "LineString"]
        lines += [ring for s in segs if s["geometry"]["type"] == "Polygon" for ring in s["geometry"]["coordinates"]]
        longest = max(segs, key=lambda s: len(s["geometry"]["coordinates"][0]) if s["geometry"]["type"] == "Polygon"
                      else len(s["geometry"]["coordinates"]))
        m = merge_osm(segs)
        m.update(kind="street", geometry={"type": "MultiLineString", "coordinates": lines},
                 lat=longest["lat"], lon=longest["lon"], area_m2=0.0,
                 attrs={**m["attrs"], "highway_types": sorted({s["attrs"].get("highway", "") for s in segs} - {""})})
        m["attrs"].pop("highway", None)
        streets.append(m)
    return streets


def osm_entities(features: list[dict]) -> list[dict]:
    for f in features:
        f["osm_ids"] = [f["osm_id"]]
    streets = [f for f in features if f["kind"] == "street" and not f.get("wikidata")]
    rest = [f for f in features if not (f["kind"] == "street" and not f.get("wikidata"))]

    by_qid: dict[str, list[dict]] = defaultdict(list)
    untagged = []
    for f in rest:
        q = (f.get("wikidata") or "").split(";")[0].strip()
        (by_qid[q] if q else untagged).append(f)
    merged = [merge_osm(fs) | {"wikidata": q} for q, fs in by_qid.items()]

    # untagged named point inside/next to a same-named polygon -> fold in
    polys = [m for m in merged if m["geometry"]["type"] in ("Polygon", "MultiPolygon")]
    polys += [f for f in untagged if f["geometry"]["type"] in ("Polygon", "MultiPolygon")]
    groups: dict[int, list[dict]] = defaultdict(list)
    loose = []
    for f in untagged:
        if f["geometry"]["type"] == "Point" and f["named"]:
            host = next((p for p in polys if p is not f and haversine_m(f["lat"], f["lon"], p["lat"], p["lon"]) < MERGE_RADIUS_M
                         and name_sim(f["name"], p["name"]) >= AUTO_MERGE_SIM), None)
            if host is not None:
                groups[id(host)].append(f)
                continue
        loose.append(f)
    out = []
    for e in merged + loose:
        extra = groups.get(id(e))
        out.append(merge_osm([e, *extra]) | {"wikidata": e.get("wikidata")} if extra else e)
    return out + merge_streets(streets)


def link_wikidata(ents: list[dict], items: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    """Attach Wikidata items to OSM entities. Returns (entities, review rows, dropped items)."""
    overrides = json.loads(OVERRIDES.read_text()) if OVERRIDES.exists() else {}
    rejected = {(r["osm_id"], r["qid"]) for r in overrides.get("reject", [])}
    for e in ents:
        if e.get("wikidata") and any((o, e["wikidata"]) in rejected for o in e["osm_ids"]):
            e["wikidata"] = None
    by_qid = {e["wikidata"]: e for e in ents if e.get("wikidata")}
    review, dropped = [], []
    bbox = bbox_from_env()
    for item in items:
        kind, is_place = wd_kind(item)
        if item["qid"] in by_qid:
            e = by_qid[item["qid"]]
            e["wd"] = item  # OSM tags are deliberate; trust them even when names are worded differently
            sim = best_name_sim(item, e)
            if not is_place and sim < 1:
                review.append({"qid": item["qid"], "label": item["label"], "osm_ids": e["osm_ids"],
                               "osm_name": e["name"], "similarity": round(sim, 2),
                               "reason": "osm tag points at a non-place item (institution?); attached, check"})
            continue
        if not is_place:
            dropped.append({"qid": item["qid"], "label": item["label"], "instance_of": item["instance_of"]})
            continue
        if item["lat"] is None or not bbox.contains(item["lat"], item["lon"]):
            continue
        best, best_sim = None, 0.0
        for e in ents:
            if e.get("wd") or e.get("wikidata"):
                continue
            radius = STREET_MERGE_RADIUS_M if e["kind"] == "street" else MERGE_RADIUS_M
            if not kinds_compatible(e["kind"], kind):
                continue
            if distance_to_geom_m(item["lat"], item["lon"], e["geometry"]) > radius:
                continue
            s = best_name_sim(item, e)
            if s > best_sim:
                best, best_sim = e, s
        if best is not None and best_sim >= AUTO_MERGE_SIM:
            best["wd"], best["wikidata"] = item, item["qid"]
            best["link_method"] = f"name+distance ({best_sim:.2f})"
            continue
        if kind == "other":  # no place type and nothing in OSM to stand next to (events, painting, offices)
            dropped.append({"qid": item["qid"], "label": item["label"], "instance_of": item["instance_of"]})
            continue
        if best is not None and best_sim >= REVIEW_SIM:
            review.append({"qid": item["qid"], "label": item["label"], "osm_ids": best["osm_ids"],
                           "osm_name": best["name"], "similarity": round(best_sim, 2),
                           "distance_m": round(distance_to_geom_m(item["lat"], item["lon"], best["geometry"])),
                           "reason": "name near-miss"})
        ents.append({
            "osm_id": None, "osm_ids": [], "kind": kind, "name": item["label"], "named": True,
            "names": {}, "aliases": [], "lat": item["lat"], "lon": item["lon"],
            "geometry": {"type": "Point", "coordinates": [item["lon"], item["lat"]]}, "area_m2": 0.0,
            "height_m": None, "height_src": None, "wikidata": item["qid"], "attrs": {}, "wd": item,
            "link_method": "wikidata only",
        })
    return ents, review, dropped


def prominence_raw(e: dict, boosts: dict[str, dict]) -> float:
    wd = e.get("wd") or {}
    heritage = bool(wd.get("heritage") or e["attrs"].get("heritage") or e["attrs"].get("historic"))
    height = e.get("height_m") or wd.get("height_m") or 0
    curated = boosts.get(e.get("wikidata") or "", {}).get("boost", 0.0)
    return (A_WIKI * math.log1p(wd.get("enwiki_len", 0) / 1000) + A_SITELINKS * math.log1p(wd.get("sitelinks", 0))
            + A_HERITAGE * heritage + A_HEIGHT * math.log1p(height) + A_CURATED * curated + BIAS)


def finalize(e: dict, boosts: dict[str, dict]) -> dict:
    wd = e.get("wd") or {}
    names = {**e.get("names", {}), **wd.get("labels", {})}
    if e.get("names", {}).get("en"):
        names["en"] = e["names"]["en"]  # local signage name wins over the Wikidata label
    key = e["wikidata"] or (e["osm_ids"][0] if e["osm_ids"] else e["name"])
    if e["kind"] == "street" and not e["wikidata"]:
        key = "street:" + normalize_name(e["name"])
    attrs = dict(e["attrs"])
    if wd:
        attrs["wd"] = {k: wd[k] for k in ("description", "instance_of", "architect", "style", "inception", "heritage",
                                          "named_after", "material", "creator", "image", "enwiki", "frwiki",
                                          "enwiki_len", "sitelinks") if wd.get(k)}
    sources = []
    if e["osm_ids"]:
        sources.append({"source": "osm", "ids": e["osm_ids"], "license": "ODbL-1.0"})
    if wd:
        sources.append({"source": "wikidata", "id": wd["qid"], "license": "CC0-1.0", "link": e.get("link_method", "osm tag")})
    kind = e["kind"]
    wk, _ = wd_kind(wd) if wd else (None, False)
    if wk in WD_KIND_OVERRIDES or (wk == "building" and kind in ("food", "venue", "other")):
        kind = wk
    raw = prominence_raw(e, boosts)
    return {
        "id": entity_id(key),
        "kind": kind,
        "name": names.get("en") or e["name"],
        "names": names,
        "aliases": e.get("aliases", []),
        "lat": e["lat"], "lon": e["lon"],
        "geometry": None if e["geometry"]["type"] == "Point" else e["geometry"],
        "h3_10": h3.latlng_to_cell(e["lat"], e["lon"], 10),
        "height_m": e.get("height_m") or wd.get("height_m"),
        "attrs": attrs,
        "prominence_raw": round(raw, 3),
        "prominence": 1 / (1 + math.exp(-raw)),  # renormalized per kind below
        "osm_ids": e["osm_ids"],
        "wikidata_id": e["wikidata"],
        "sources": sources,
    }


def normalize_prominence(rows: list[dict]) -> None:
    """Min-max per kind so a tree never competes with a tower on height (§10.4 step 12)."""
    by_kind: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_kind[r["kind"]].append(r)
    for group in by_kind.values():
        lo, hi = min(r["prominence"] for r in group), max(r["prominence"] for r in group)
        for r in group:
            r["prominence"] = round((r["prominence"] - lo) / (hi - lo), 3) if hi > lo else 0.0


def main() -> None:
    features = list(read_jsonl(STAGING / "osm_features.jsonl"))
    items = list(read_jsonl(STAGING / "wikidata_items.jsonl"))
    bbox = bbox_from_env()

    ents = osm_entities(features)
    ents, review, dropped = link_wikidata(ents, items)
    n_fp = attach_footprints(ents, list(read_jsonl(STAGING / "osm_footprints.jsonl")))
    print(f"footprints attached to wikidata-only buildings: {n_fp}")
    boosts = {k: v for k, v in json.loads(BOOSTS.read_text()).items() if k.startswith("Q")} if BOOSTS.exists() else {}
    rows = [finalize(e, boosts) for e in ents if e["kind"] == "street" or bbox.contains(e["lat"], e["lon"])]

    seen: dict[str, dict] = {}
    for r in rows:  # same id = same thing reached by two paths; keep the richer row
        if r["id"] not in seen or len(r["osm_ids"]) > len(seen[r["id"]]["osm_ids"]):
            seen[r["id"]] = r
    rows = list(seen.values())
    normalize_prominence(rows)

    write_jsonl(STAGING / "entities.jsonl", rows)
    write_jsonl(STAGING / "link_review.jsonl", review)
    write_jsonl(STAGING / "wikidata_dropped.jsonl", dropped)
    linked = sum(1 for r in rows if r["wikidata_id"] and r["osm_ids"])
    print(f"entities: {len(rows)}  osm+wikidata: {linked}  "
          f"wikidata-only: {sum(1 for r in rows if r['wikidata_id'] and not r['osm_ids'])}  "
          f"review: {len(review)}  dropped non-place items: {len(dropped)}")


if __name__ == "__main__":
    main()
