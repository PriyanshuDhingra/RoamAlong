# Wander

A realtime, location-aware voice tour guide for Toronto, built on Boson AI's Higgs Realtime for the **Higgs Audio Hackathon 2026**. You walk with earbuds in; the guide notices what you're about to pass, tells you about it, and holds a real conversation: you can interrupt it, switch language mid-sentence, ask for directions, or ask it to be quiet.

Full design: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## Status

Phase 0 (foundations), in progress:

- [x] Repo skeleton, docker-compose (Postgres + PostGIS + pgvector + h3, Valhalla, backend, worker), `.env.example`
- [x] App ↔ Gateway protocol schema with generated TS and pydantic types ([protocol/](protocol/))
- [x] Gateway stub: `/health` and the `hello` → `ready` handshake
- [x] OSM + Wikidata ingest for the demo area, entity linking, coverage report ([data/reports/coverage.md](data/reports/coverage.md))
- [ ] `tools/probe_boson.py` (needs `BOSON_API_KEY`)
- [ ] Expo dev build + mobile feasibility spike (needs Xcode, Android Studio, physical devices)
- [ ] Pick the 20–30 hero places from the coverage report

## Layout

```
backend/     FastAPI gateway, director, agents, tools, geo, prefs, data, jobs
pipeline/    offline ingestion: OSM, Wikidata, linking, coverage report, DB loader
protocol/    messages.schema.json (source of truth) + generated types in gen/
apps/        mobile (Expo) and debug-web (Vite) — not scaffolded yet
db/          Postgres image with PostGIS, pgvector, h3-pg; schema in db/init/
data/        raw/ and staging/ are gitignored and rebuilt by `make data`; reports/ is committed
docs/        Boson probe findings, device matrix
```

## Setup

Requires [uv](https://docs.astral.sh/uv/), Node 20+, and Docker.

```bash
cp .env.example .env          # then fill in BOSON_API_KEY, ANTHROPIC_API_KEY
make setup                    # Python 3.12 env via uv
make test
make data                     # OSM + Wikidata ingest for the demo bbox -> data/reports/coverage.md
make up && make db-load       # start Postgres and load entities
docker compose up valhalla    # first start builds routing tiles (slow for all of Ontario; see .env.example)
uv run uvicorn backend.gateway.main:app --reload
```

`make protocol` regenerates `protocol/gen/` after editing the schema.

## Data and attribution

Map and place data © OpenStreetMap contributors (ODbL). Wikidata (CC0). Wikipedia article metadata (CC BY-SA). Per-source terms and gaps: [pipeline/SOURCES.md](pipeline/SOURCES.md).
