-- Migration 008: Case-insensitive names normalization
-- Names are stored lowercase by convention; these indexes enforce uniqueness
-- and provide efficient case-insensitive lookups.

CREATE UNIQUE INDEX IF NOT EXISTS idx_libraries_lower_name
  ON libraries(LOWER(name));

CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_library_lower_name
  ON versions(library_id, LOWER(name));
