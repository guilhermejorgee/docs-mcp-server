-- Migration 013: Drop embedding column from documents table
-- The embedding column is no longer populated during ingestion.
-- Semantic chunking now happens before storage, so vectors are not stored in the DB.

ALTER TABLE documents DROP COLUMN IF EXISTS embedding;
