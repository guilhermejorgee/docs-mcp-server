-- Migration 004: Add description and FTS to libraries table

ALTER TABLE libraries ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE libraries ADD COLUMN IF NOT EXISTS fts_vector TSVECTOR
  GENERATED ALWAYS AS (
    setweight(to_tsvector('multilingual', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('multilingual', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_libraries_fts ON libraries USING GIN(fts_vector);
