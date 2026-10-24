"""Load data/staging/entities.jsonl into Postgres (`entity` + `entity_alias`). Idempotent upsert by id.

Needs the docker-compose `db` service (`docker compose up -d db`) and DATABASE_URL.
"""

from __future__ import annotations

import json
import os

import psycopg

from pipeline.common import STAGING, read_jsonl

UPSERT = """
INSERT INTO entity (id, kind, name, names, geom_point, geom_shape, h3_10, height_m, attrs, prominence,
                    osm_ids, wikidata_id, sources, updated_at)
VALUES (%(id)s, %(kind)s, %(name)s, %(names)s,
        ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326)::geography,
        CASE WHEN %(geometry)s::text IS NULL THEN NULL ELSE ST_GeomFromGeoJSON(%(geometry)s)::geography END,
        %(h3_10)s::h3index, %(height_m)s, %(attrs)s, %(prominence)s, %(osm_ids)s, %(wikidata_id)s, %(sources)s, now())
ON CONFLICT (id) DO UPDATE SET
  kind = EXCLUDED.kind, name = EXCLUDED.name, names = EXCLUDED.names, geom_point = EXCLUDED.geom_point,
  geom_shape = EXCLUDED.geom_shape, h3_10 = EXCLUDED.h3_10, height_m = EXCLUDED.height_m, attrs = EXCLUDED.attrs,
  prominence = EXCLUDED.prominence, osm_ids = EXCLUDED.osm_ids, wikidata_id = EXCLUDED.wikidata_id,
  sources = EXCLUDED.sources, updated_at = now()
"""


def main() -> None:
    url = os.environ.get("DATABASE_URL", "postgresql://wander:wander@localhost:5432/wander")
    rows = list(read_jsonl(STAGING / "entities.jsonl"))
    with psycopg.connect(url) as conn, conn.cursor() as cur:
        for r in rows:
            cur.execute(UPSERT, {
                **r,
                "names": json.dumps(r["names"]),
                "geometry": json.dumps(r["geometry"]) if r["geometry"] else None,
                "attrs": json.dumps(r["attrs"]),
                "sources": json.dumps(r["sources"]),
            })
        cur.execute("DELETE FROM entity_alias WHERE entity_id = ANY(%s)", ([r["id"] for r in rows],))
        cur.executemany(
            "INSERT INTO entity_alias (entity_id, alias, lang, kind) VALUES (%s, %s, %s, %s)",
            [(r["id"], a, None, "osm_alias") for r in rows for a in r["aliases"]]
            + [(r["id"], n, lang, "label") for r in rows for lang, n in r["names"].items() if n != r["name"]],
        )
    print(f"loaded {len(rows)} entities")


if __name__ == "__main__":
    main()
