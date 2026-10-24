# Postgres 16 + PostGIS + pgvector + h3-pg. Built on the official multi-arch image (postgis/postgis has no arm64
# builds) with extensions from the PGDG apt repo it already configures.
FROM postgres:16-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-postgis-3 postgresql-16-pgvector postgresql-16-h3 \
 && rm -rf /var/lib/apt/lists/*
