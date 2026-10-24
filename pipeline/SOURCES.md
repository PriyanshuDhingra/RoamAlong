# Data sources

One row per source **before** it is ingested (IMPLEMENTATION_PLAN.md §10.2). Publicly readable does not mean bulk reuse is allowed.

| Field | OpenStreetMap (Overpass) | Wikidata |
|---|---|---|
| Publisher, URL, date checked | OpenStreetMap contributors, overpass-api.de, 2026-10-23 | Wikimedia Foundation, query.wikidata.org + wikidata.org/w/api.php, 2026-10-23 |
| Fields actually present (sample) | buildings with footprints; `height` / `building:levels` on some; `architect`, `start_date`, `heritage` rarely; amenity / tourism / historic POIs with `opening_hours`, `cuisine`; named ways; `wikidata=*` on ~280 features | P625 coordinates, P31 instance of, P84 architect, P149 style, P571 inception, P1435 heritage, P138 named after, P18 image, P2048 height, labels in 16 languages, en/fr Wikipedia sitelinks |
| Spatial coverage | demo bbox `43.656,-79.403,43.674,-79.386` (3,649 elements) | same bbox: 519 items with coordinates, +12 referenced by OSM tags |
| Access method | Overpass API, one query (`pipeline/ingest_osm.py`); full city later via Geofabrik PBF + osm2pgsql | SPARQL `wikibase:box` (2×2 sub-boxes) + `wbgetentities` batches of 50 (`pipeline/ingest_wikidata.py`) |
| Licence and reuse terms | ODbL 1.0: attribution "© OpenStreetMap contributors"; share-alike if the derived database is published | CC0 |
| Refresh behaviour | continuous edits; re-run monthly | continuous edits; re-run monthly |
| Ingestion effort | low | low |
| Known gaps | many buildings unnamed (named only via Wikidata); some institution QIDs tagged on individual buildings (see `data/staging/link_review.jsonl`); Queen's Park park polygon not matched | coordinates are often a single campus point; many items are organisations/events, not places (dropped, see `wikidata_dropped.jsonl`); sitelink-heavy items skew prominence |

Also used: English Wikipedia `action=query&prop=info` for article length only (prominence signal). Text not yet ingested; when it is: CC BY-SA 4.0, keep source links on derived cards.

## Not yet checked

Toronto Open Data (Heritage Register, 3D Massing, Public Art, Street Trees, Neighbourhoods, Festivals & Events), Wikivoyage, plaque sites, TTC GTFS, TOBuilt, Indigenous history sources (permissions first). See §10.2 for the planned rows.
