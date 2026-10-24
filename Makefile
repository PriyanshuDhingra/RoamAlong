PY := uv run python

.PHONY: setup test protocol data data-refresh db-load up down

setup:            ## install Python deps (Python 3.12 via uv)
	uv sync

test:
	uv run pytest -q

protocol:         ## regenerate TS + pydantic types from protocol/messages.schema.json
	protocol/generate.sh

data:             ## OSM + Wikidata ingest for the demo bbox -> link -> coverage report (uses cached raw responses)
	$(PY) -m pipeline.ingest_osm
	$(PY) -m pipeline.ingest_wikidata
	$(PY) -m pipeline.link_entities
	$(PY) -m pipeline.report

data-refresh:     ## same, but refetch from Overpass / Wikidata
	$(PY) -m pipeline.ingest_osm --refresh
	$(PY) -m pipeline.ingest_wikidata --refresh
	$(PY) -m pipeline.link_entities
	$(PY) -m pipeline.report

db-load:          ## upsert staged entities into Postgres (needs `make up`)
	$(PY) -m pipeline.load_db

up:
	docker compose up -d db

down:
	docker compose down
