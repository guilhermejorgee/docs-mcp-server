-- Migration 014: Add language-specific FTS text search configurations
-- Creates pt_unaccent (Portuguese + unaccent) and en_unaccent (English + unaccent)
-- configurations used when ftsLanguages config includes "portuguese" or "english".
-- These configs combine the built-in language stemmer with accent normalisation.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_ts_config WHERE cfgname = 'pt_unaccent'
  ) THEN
    EXECUTE 'CREATE TEXT SEARCH CONFIGURATION pt_unaccent (COPY = portuguese)';
    EXECUTE 'ALTER TEXT SEARCH CONFIGURATION pt_unaccent
               ALTER MAPPING FOR hword, hword_part, word
               WITH unaccent, portuguese_stem';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_ts_config WHERE cfgname = 'en_unaccent'
  ) THEN
    EXECUTE 'CREATE TEXT SEARCH CONFIGURATION en_unaccent (COPY = english)';
    EXECUTE 'ALTER TEXT SEARCH CONFIGURATION en_unaccent
               ALTER MAPPING FOR hword, hword_part, word
               WITH unaccent, english_stem';
  END IF;
END
$$;
