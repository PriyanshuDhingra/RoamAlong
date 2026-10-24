"""Wikidata ingest for the demo area (§10.4 step 3).

1. SPARQL `wikibase:box` over the bbox for every item with coordinates (P625), plus every QID referenced by an
   OSM `wikidata=*` tag (run ingest_osm first).
2. `wbgetentities` for labels (multilingual), claims and sitelinks; a second pass labels referenced items
   (architects, styles, heritage designations).
3. English Wikipedia article length (a prominence signal, §10.4 step 12).

Output: data/staging/wikidata_items.jsonl. Wikidata is CC0.
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Iterable
from typing import Any

from pipeline.common import (
    RAW,
    STAGING,
    bbox_from_env,
    http_client,
    read_jsonl,
    request_with_retry,
    write_jsonl,
)

SPARQL_URL = "https://query.wikidata.org/sparql"
WD_API = "https://www.wikidata.org/w/api.php"
ENWIKI_API = "https://en.wikipedia.org/w/api.php"

# ~15 languages for map labels and code-switching (§4.8)
LANGS = ["en", "fr", "es", "de", "it", "pt", "zh", "ja", "ko", "ar", "hi", "ru", "ur", "fa", "pa", "tl"]

# Claims we keep: property -> output field. Item-valued ones get English labels in a second pass.
ITEM_PROPS = {"P31": "instance_of", "P84": "architect", "P149": "style", "P1435": "heritage", "P138": "named_after",
              "P186": "material", "P170": "creator"}
SPARQL = """
SELECT ?item ?coord ?sitelinks WHERE {{
  SERVICE wikibase:box {{
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point({w} {s})"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point({e} {n})"^^geo:wktLiteral .
  }}
  ?item wikibase:sitelinks ?sitelinks .
}}
"""


def chunks(xs: list, n: int) -> Iterable[list]:
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def box_qids(client) -> dict[str, int]:
    """QID -> sitelink count for items inside the bbox, split into 2x2 sub-boxes to stay under the query timeout."""
    b = bbox_from_env()
    mid_lat, mid_lon = (b.south + b.north) / 2, (b.west + b.east) / 2
    boxes = [(s, w, n, e) for s, n in ((b.south, mid_lat), (mid_lat, b.north)) for w, e in ((b.west, mid_lon), (mid_lon, b.east))]
    found: dict[str, int] = {}
    for s, w, n, e in boxes:
        q = SPARQL.format(s=s, w=w, n=n, e=e)
        r = request_with_retry(client, "POST", SPARQL_URL, data={"query": q},
                               headers={"Accept": "application/sparql-results+json"})
        for row in r.json()["results"]["bindings"]:
            qid = row["item"]["value"].rsplit("/", 1)[-1]
            found[qid] = int(row["sitelinks"]["value"])
    return found


def get_entities(client, qids: list[str], props: str, langs: list[str],
                 sitefilter: str | None = "enwiki|frwiki") -> dict[str, Any]:
    out: dict[str, Any] = {}
    for batch in chunks(qids, 50):
        params = {"action": "wbgetentities", "ids": "|".join(batch), "props": props,
                  "languages": "|".join(langs), "format": "json"}
        if sitefilter:
            params["sitefilter"] = sitefilter
        r = request_with_retry(client, "GET", WD_API, params=params)
        out.update(r.json().get("entities", {}))
    return out


def article_lengths(client, titles: list[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for batch in chunks(titles, 50):
        r = request_with_retry(client, "GET", ENWIKI_API, params={
            "action": "query", "prop": "info", "titles": "|".join(batch), "redirects": 1, "format": "json",
        })
        q = r.json().get("query", {})
        norm = {n["to"]: n["from"] for n in q.get("normalized", [])}
        redir = {x["to"]: x["from"] for x in q.get("redirects", [])}
        for page in q.get("pages", {}).values():
            if "length" in page:
                t = page["title"]
                t = redir.get(t, t)
                out[norm.get(t, t)] = page["length"]
    return out


def _claim_values(claims: dict, prop: str) -> list[Any]:
    vals = []
    for c in claims.get(prop, []):
        if c.get("rank") == "deprecated":
            continue
        dv = c.get("mainsnak", {}).get("datavalue")
        if dv:
            vals.append(dv["value"])
    return vals


def _year(time_value: dict) -> str | None:
    t = time_value.get("time", "")  # "+1859-00-00T00:00:00Z"
    return t[1:5] if len(t) > 5 else None


def parse_item(qid: str, ent: dict, in_box: bool) -> dict:
    claims = ent.get("claims", {})
    labels = {lang: v["value"] for lang, v in ent.get("labels", {}).items()}
    coords = _claim_values(claims, "P625")
    heights = [float(v["amount"]) for v in _claim_values(claims, "P2048") if v.get("unit", "").endswith("Q11573")]
    images = _claim_values(claims, "P18")
    inception = [y for v in _claim_values(claims, "P571") if (y := _year(v))]
    sitelinks = ent.get("sitelinks", {})
    row = {
        "qid": qid,
        "label": labels.get("en") or next(iter(labels.values()), qid),
        "labels": labels,
        "description": ent.get("descriptions", {}).get("en", {}).get("value"),
        "lat": coords[0]["latitude"] if coords else None,
        "lon": coords[0]["longitude"] if coords else None,
        "in_bbox": in_box,
        "enwiki": sitelinks.get("enwiki", {}).get("title"),
        "frwiki": sitelinks.get("frwiki", {}).get("title"),
        "inception": inception[0] if inception else None,
        "height_m": heights[0] if heights else None,
        "image": images[0] if images else None,
    }
    for prop, field in ITEM_PROPS.items():
        row[field + "_qids"] = [v["id"] for v in _claim_values(claims, prop) if isinstance(v, dict) and "id" in v]
    return row


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--refresh", action="store_true", help="ignore the cached raw responses")
    args = ap.parse_args()

    b = bbox_from_env()
    cache = RAW / f"wikidata_{b.overpass().replace(',', '_')}.json"
    osm_qids = {f["wikidata"].split(";")[0].strip() for f in read_jsonl(STAGING / "osm_features.jsonl") if f.get("wikidata")}

    with http_client() as client:
        if cache.exists() and not args.refresh:
            print(f"using cached {cache.name}")
            raw = json.loads(cache.read_text())
        else:
            print("querying Wikidata SPARQL …")
            sitelink_counts = box_qids(client)
            box = sorted(sitelink_counts)
            all_qids = sorted(set(sitelink_counts) | osm_qids)
            print(f"  {len(sitelink_counts)} items in bbox, {len(osm_qids - set(sitelink_counts))} more from OSM tags")
            entities = get_entities(client, all_qids, "labels|descriptions|claims|sitelinks", LANGS)
            # sitelink counts for OSM-only QIDs (outside the box query)
            missing = [q for q in all_qids if q not in sitelink_counts]
            for q, ent in get_entities(client, missing, "sitelinks", ["en"], sitefilter=None).items():
                sitelink_counts[q] = len(ent.get("sitelinks", {}))
            raw = {"sitelinks": sitelink_counts, "entities": entities, "box": box}
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(raw))

        in_box = set(raw["box"])
        items = [parse_item(q, e, q in in_box) for q, e in raw["entities"].items() if "missing" not in e]
        for it in items:
            it["sitelinks"] = raw["sitelinks"].get(it["qid"], 0)

        ref_qids = sorted({q for it in items for f in ITEM_PROPS.values() for q in it[f + "_qids"]})
        ref_labels = {q: e.get("labels", {}).get("en", {}).get("value", q)
                      for q, e in get_entities(client, ref_qids, "labels", ["en"]).items()}
        for it in items:
            for f in ITEM_PROPS.values():
                it[f] = [ref_labels.get(q, q) for q in it[f + "_qids"]]

        lengths = article_lengths(client, [it["enwiki"] for it in items if it["enwiki"]])
        for it in items:
            it["enwiki_len"] = lengths.get(it["enwiki"], 0) if it["enwiki"] else 0

    n = write_jsonl(STAGING / "wikidata_items.jsonl", items)
    print(f"items: {n}  with enwiki: {sum(1 for i in items if i['enwiki'])}  "
          f"with heritage: {sum(1 for i in items if i['heritage'])}  with architect: {sum(1 for i in items if i['architect'])}")


if __name__ == "__main__":
    main()
