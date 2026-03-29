-- Migration 000: Initial PostgreSQL schema
-- Equivalent to all foundational SQLite migrations (000–006, 009–012)
-- Uses pgvector for embeddings, GIN index for full-text search, HNSW for ANN

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector: vector similarity search
CREATE EXTENSION IF NOT EXISTS unaccent; -- accent-insensitive full-text search

-- ---------------------------------------------------------------------------
-- Full-text search configuration
-- ---------------------------------------------------------------------------

-- Multilingual config: accent-insensitive, language-agnostic tokenisation
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_ts_config WHERE cfgname = 'multilingual'
  ) THEN
    EXECUTE 'CREATE TEXT SEARCH CONFIGURATION multilingual (COPY = simple)';
    EXECUTE 'ALTER TEXT SEARCH CONFIGURATION multilingual
               ALTER MAPPING FOR hword, hword_part, word
               WITH unaccent, simple';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS libraries (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS versions (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  library_id        BIGINT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name              TEXT NOT NULL DEFAULT '',
  status            TEXT DEFAULT 'not_indexed',
  progress_pages    INT DEFAULT 0,
  progress_max_pages INT DEFAULT 0,
  error_message     TEXT,
  started_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ DEFAULT now(),
  source_url        TEXT,
  scraper_options   JSONB,
  created_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(library_id, name)
);

CREATE TABLE IF NOT EXISTS pages (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id          BIGINT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  url                 TEXT NOT NULL,
  title               TEXT,
  etag                TEXT,
  last_modified       TEXT,
  source_content_type TEXT,
  content_type        TEXT,
  depth               INT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE(version_id, url)
);

CREATE TABLE IF NOT EXISTS documents (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  page_id     BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  content     TEXT,
  metadata    JSONB,
  sort_order  INT NOT NULL,
  embedding   vector(1536),
  fts_vector  tsvector,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Migration tracking (managed by the migration runner)
CREATE TABLE IF NOT EXISTS _schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes — libraries
-- ---------------------------------------------------------------------------

-- Case-insensitive name lookup (names are stored lowercase by convention)
CREATE UNIQUE INDEX IF NOT EXISTS idx_libraries_lower_name
  ON libraries(LOWER(name));

-- ---------------------------------------------------------------------------
-- Indexes — versions
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_versions_library_id
  ON versions(library_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_library_lower_name
  ON versions(library_id, LOWER(name));

-- ---------------------------------------------------------------------------
-- Indexes — pages
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_pages_version_id
  ON pages(version_id);

-- ---------------------------------------------------------------------------
-- Indexes — documents
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_documents_page_id
  ON documents(page_id);

CREATE INDEX IF NOT EXISTS idx_documents_sort_order
  ON documents(page_id, sort_order);

-- GIN index for full-text search on the pre-computed tsvector column
CREATE INDEX IF NOT EXISTS idx_documents_fts
  ON documents USING GIN(fts_vector);

-- HNSW index for approximate nearest-neighbour vector search (cosine distance)
CREATE INDEX IF NOT EXISTS idx_documents_embedding
  ON documents USING hnsw(embedding vector_cosine_ops);
