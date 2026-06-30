-- istatym.ai schema (slice: full-corpus ingest data plane). Issue #6.
--
-- Layers the corpus-wide ingest concerns on top of migration 001 (work,
-- expression, article). Both apps run migrations from a shared convention; the
-- ingest migrate runner applies apps/web's 001 first, then this file.
--
--   raw_archive   immutable append-only mirror of everything pulled from Spinta
--                 (decision D18): the source of truth for reprocessing without
--                 re-fetching, and the citation-integrity audit trail.
--   sync_state    per-model CDC watermark (the monotonic `_cid` cursor).
--   work (+cols)  base/amendment classification + source metadata (D4).
--   priedas       flag-and-link appendix metadata (D5); binary text NOT parsed.

-- raw_archive: one row per (model, record, revision) ever observed. Append-only;
-- never updated in place. A new revision of the same record is a new row, so the
-- full history of a record is preserved.
CREATE TABLE IF NOT EXISTS raw_archive (
  model       text        NOT NULL,
  record_id   text        NOT NULL,           -- Spinta `_id`
  cid         bigint,                          -- CDC `_cid`; NULL for bulk-fetched rows
  op          text        NOT NULL DEFAULT 'upsert',  -- `upsert` | `delete`
  revision    text        NOT NULL,           -- Spinta `_revision`
  payload     jsonb       NOT NULL,           -- the verbatim record
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model, record_id, revision)
);

-- Lookup by model + change id (CDC replay, verify counts, synthesize lookups).
CREATE INDEX IF NOT EXISTS raw_archive_model_cid_idx ON raw_archive (model, cid);

-- sync_state: the resume point for the daily CDC delta. `last_cid` is the
-- highest `_cid` whose change has been confirmed-applied for this model.
CREATE TABLE IF NOT EXISTS sync_state (
  model      text        PRIMARY KEY,
  last_cid   bigint      NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Extend `work` with classification (D4) and the source metadata the classifier
-- and CDC re-derivation need. ADD COLUMN IF NOT EXISTS keeps this idempotent and
-- non-destructive on a database already carrying the slice-4 `work` rows.
ALTER TABLE work ADD COLUMN IF NOT EXISTS dokumento_id          text;
ALTER TABLE work ADD COLUMN IF NOT EXISTS act_type              text;   -- Spinta `rusis`
ALTER TABLE work ADD COLUMN IF NOT EXISTS galioj_busena         text;   -- `galioja` | `negalioja`
ALTER TABLE work ADD COLUMN IF NOT EXISTS classification        text;   -- base | amendment | non_normative
ALTER TABLE work ADD COLUMN IF NOT EXISTS classification_reason text;
ALTER TABLE work ADD COLUMN IF NOT EXISTS classified_at         timestamptz;

CREATE INDEX IF NOT EXISTS work_dokumento_id_idx  ON work (dokumento_id);
CREATE INDEX IF NOT EXISTS work_classification_idx ON work (classification);

-- priedas: appendix metadata only (D5). We store a flag + the official URL so the
-- agent can tell the user "this act has an annex I have not ingested — see
-- [link]". We deliberately do NOT store or parse the (often OCR-garbled) binary
-- text; `has_text` records whether Spinta extracted any usable text at all.
CREATE TABLE IF NOT EXISTS priedas (
  priedo_id      text PRIMARY KEY,
  dokumento_id   text,
  priedo_pav     text,
  failo_pletinys text,
  priedo_url     text,
  has_text       boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS priedas_dokumento_id_idx ON priedas (dokumento_id);

-- current_expression: convenience view applying the decision-D2 query-time date
-- predicate to pick the currently-valid expression per work. The predicate, not
-- this view, is authoritative; the view just centralizes it for ad-hoc queries
-- and the daily validity-rollover reconciliation (which is otherwise a no-op).
CREATE OR REPLACE VIEW current_expression AS
SELECT DISTINCT ON (e.work_id) e.*
FROM expression e
WHERE e.galioja_nuo <= now()
  AND (e.galioja_iki IS NULL OR e.galioja_iki > now())
ORDER BY e.work_id, e.galioja_nuo DESC;
