-- Migration 003: No-op for PostgreSQL. Vector storage is via embedding column and HNSW index created in migration 000.
SELECT 1;
