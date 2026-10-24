# Postgres 16 + PostGIS + pgvector + h3-pg (all from the PGDG apt repo the postgis image already uses)
FROM postgis/postgis:16-3.4

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-pgvector postgresql-16-h3 \
 && rm -rf /var/lib/apt/lists/*
