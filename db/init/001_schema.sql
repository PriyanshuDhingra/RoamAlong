-- Wander schema (IMPLEMENTATION_PLAN.md §10.3). Runs once, on first start of an empty volume.
-- Later changes go through alembic migrations in backend/data/.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS h3;
CREATE EXTENSION IF NOT EXISTS h3_postgis CASCADE;

CREATE TABLE entity (
  id            text PRIMARY KEY,               -- 'e_' || short hash
  kind          text NOT NULL,                  -- building | artwork | park | street | area | river | venue | food | plaque | ...
  name          text NOT NULL,
  names         jsonb,                          -- {"en": "...", "fr": "..."} from Wikidata/OSM name:*
  geom_point    geography(Point, 4326) NOT NULL,
  geom_shape    geography(Geometry, 4326),      -- footprint / polygon / line
  h3_10         h3index NOT NULL,
  height_m      real,
  attrs         jsonb,                          -- normalized OSM tags, style, material, colours, cuisine, hours
  prominence    real NOT NULL DEFAULT 0,        -- 0..1
  topic_vec     vector(64),
  osm_ids       text[],
  wikidata_id   text,
  city_ids      jsonb,
  sources       jsonb,
  updated_at    timestamptz DEFAULT now()
);
CREATE INDEX ON entity USING gist (geom_point);
CREATE INDEX ON entity USING gist (geom_shape);
CREATE INDEX ON entity (h3_10);
CREATE INDEX ON entity (wikidata_id);

CREATE TABLE source_doc (
  id text PRIMARY KEY, publisher text, url text, title text, license text,
  retrieved_at timestamptz, content_hash text
);

CREATE TABLE fact (
  id bigserial PRIMARY KEY,
  entity_id text REFERENCES entity(id),
  dimension text NOT NULL,
  text text NOT NULL,
  lang text NOT NULL DEFAULT 'en',
  claim_type text NOT NULL DEFAULT 'established', -- established | contested | folklore
  source_id text REFERENCES source_doc(id), source_url text, license text, quote_span text,
  confidence real NOT NULL,
  review_status text NOT NULL DEFAULT 'auto',     -- auto | verified | human_reviewed | disputed | retracted
  conflict_group text,
  retrieved_at timestamptz NOT NULL, updated_at timestamptz,
  valid_from timestamptz, valid_to timestamptz
);
CREATE INDEX ON fact (entity_id);

CREATE TABLE entity_alias (entity_id text REFERENCES entity(id), alias text, lang text, kind text);
CREATE TABLE entity_link (src text, dst text, kind text);

CREATE TABLE correction (
  id bigserial PRIMARY KEY, entity_id text, fact_id bigint, claim text, user_says text,
  session_id text, created_at timestamptz, status text DEFAULT 'open'
);

CREATE TABLE chunk (
  id bigserial PRIMARY KEY,
  entity_id text REFERENCES entity(id),
  dimension text, lang text, text text, source_url text, license text,
  embedding vector(1024)
);
CREATE INDEX ON chunk USING hnsw (embedding vector_cosine_ops);

CREATE TABLE story_card (
  entity_id text REFERENCES entity(id),
  dimension text,
  hook text,
  story text,
  deep_facts jsonb,
  look_for text,
  quiz jsonb,
  angles jsonb,
  visual_features text[],
  connections jsonb,
  fact_ids bigint[], verified boolean, model text, created_at timestamptz,
  PRIMARY KEY (entity_id, dimension)
);

CREATE TABLE relation (src text, dst text, kind text, weight real, note text, PRIMARY KEY (src, dst, kind));
CREATE TABLE theme (id text PRIMARY KEY, title text, summary text, entity_ids text[], card jsonb);

CREATE TABLE dynamic_item (
  id text PRIMARY KEY, kind text,
  title text, summary text, url text,
  geom geography(Geometry, 4326), area_id text, entity_ids text[],
  starts_at timestamptz, ends_at timestamptz,
  tz text DEFAULT 'America/Toronto',
  cache_key text,
  fetched_at timestamptz, expires_at timestamptz, source_id text REFERENCES source_doc(id)
);
CREATE INDEX ON dynamic_item USING gist (geom);
CREATE INDEX ON dynamic_item (expires_at);

CREATE TABLE app_user (id text PRIMARY KEY, created_at timestamptz, settings jsonb);
CREATE TABLE user_preference (
  id bigserial PRIMARY KEY, user_id text REFERENCES app_user(id),
  category text, value text, polarity text, strength real,
  scope text NOT NULL DEFAULT 'usually',
  source text,
  evidence text, request_id text UNIQUE,
  created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
);
CREATE TABLE session_log (session_id text, user_id text, started_at timestamptz, summary text, discussed text[], route geography(LineString, 4326));
CREATE TABLE tour (id text PRIMARY KEY, title text, theme text, spec jsonb);
