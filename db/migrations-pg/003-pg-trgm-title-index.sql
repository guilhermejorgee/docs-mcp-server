-- Migration 003: Enable pg_trgm extension and add trigram index on pages.title
-- Enables typo-tolerant title matching via similarity() in hybrid FTS queries.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_pages_title_trgm
  ON pages USING GIN (title gin_trgm_ops);
