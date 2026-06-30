-- istatym.ai schema (slice: Postgres-backed retrieval).
--
-- Models acts under the FRBR work -> expression -> point-in-time view:
--   work        an act, identified by its register code (tar_kodas) -- decision D4
--   expression  a dated consolidation (Suvestinė) with a validity window
--   article     a parsed `straipsnis` within an expression, carrying its own
--               denormalized validity window for the query-time "current law"
--               date predicate (decision D2)
--
-- Real Lithuanian lemmatization arrives later with ParadeDB pg_search; this
-- slice uses an unaccent + simple text-search configuration as the baseline.

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Lithuanian FTS configuration: unaccent (diacritic-insensitive) over `simple`.
-- No stemmer ships for Lithuanian, so this matches normalized tokens -- a
-- faithful, DB-backed port of the previous in-process token matcher.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'lithuanian_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION lithuanian_unaccent ( COPY = simple );
    ALTER TEXT SEARCH CONFIGURATION lithuanian_unaccent
      ALTER MAPPING FOR
        asciiword, asciihword, hword_asciipart,
        word, hword, hword_part,
        numword, numhword, hword_numpart
      WITH unaccent, simple;
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS work (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tar_kodas   text NOT NULL UNIQUE,
  title       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expression (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id       uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  suvestine_id  text,
  dokumento_id  text,
  galioja_nuo   timestamptz NOT NULL,
  galioja_iki   timestamptz,
  source_url    text,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  raw_text      text NOT NULL,
  UNIQUE (work_id, galioja_nuo)
);

CREATE TABLE IF NOT EXISTS article (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expression_id  uuid NOT NULL REFERENCES expression(id) ON DELETE CASCADE,
  ordinal        int  NOT NULL,
  number         text NOT NULL,
  heading        text NOT NULL,
  body           text NOT NULL,
  breadcrumb     text NOT NULL,
  galioja_nuo    timestamptz NOT NULL,
  galioja_iki    timestamptz,
  search_vector  tsvector NOT NULL,
  UNIQUE (expression_id, ordinal)
);

CREATE INDEX IF NOT EXISTS article_search_idx   ON article USING gin (search_vector);
CREATE INDEX IF NOT EXISTS article_validity_idx ON article (galioja_nuo, galioja_iki);
CREATE INDEX IF NOT EXISTS article_number_idx   ON article (number);
