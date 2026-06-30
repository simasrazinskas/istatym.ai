-- istatym.ai schema (slice: production hybrid retrieval). Issue #7.
--
-- Adds the dense + lexical retrieval layer on top of the parsed `article` table
-- (migration 001). Both apps apply this file: the web app at boot via
-- instrumentation, and the ingest migrate runner (which reads apps/web's dir).
--
-- Decisions:
--   D3  hybrid retrieval = pgvector HNSW (semantic) + pg_search BM25 (lexical)
--       fused with Reciprocal Rank Fusion (k=60) + cross-encoder reranker.
--   D6  dual-granularity chunking: paragraph/`punktas` leaves are the embedded
--       unit; the `straipsnis` (article) is the parent/citation unit. A
--       deterministic structural breadcrumb is prepended to every chunk before
--       embedding (it doubles as the citation and fixes the right-text/wrong-
--       statute failure mode).
--   D9  embeddings = Voyage AI (voyage-4-large default), 1024 dims, cosine.
--       Voyage is asymmetric: documents and queries use distinct input_type
--       values, and its vectors are L2-normalized (cosine == dot).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;

-- chunk: one row per embedded text unit. Two granularities coexist:
--   'paragraph' — a `dalis`/`punktas` leaf within an article; the search unit.
--   'article'   — the whole article; the parent anchor kept so auto-merge always
--                 has a coarse representation even for single-paragraph articles.
-- `content` is exactly what was embedded (breadcrumb prepended to the leaf text),
-- stored verbatim so the BM25 index and the reranker see the same string.
CREATE TABLE IF NOT EXISTS chunk (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id     uuid NOT NULL REFERENCES article(id) ON DELETE CASCADE,
  expression_id  uuid NOT NULL,
  granularity    text NOT NULL CHECK (granularity IN ('article', 'paragraph')),
  ordinal        int  NOT NULL,
  breadcrumb     text NOT NULL,
  content        text NOT NULL,
  galioja_nuo    timestamptz NOT NULL,
  galioja_iki    timestamptz,
  embedding      vector(1024),
  UNIQUE (article_id, granularity, ordinal)
);

-- Semantic side: HNSW over cosine distance (Voyage vectors are cosine-compared).
CREATE INDEX IF NOT EXISTS chunk_embedding_idx
  ON chunk USING hnsw (embedding vector_cosine_ops);

-- Lexical side: ParadeDB BM25 over the same `content` the dense side embedded.
-- `granularity` is indexed so the paragraph-leaf filter pushes down; the validity
-- window is applied as a heap predicate alongside the `@@@` match.
CREATE INDEX IF NOT EXISTS chunk_bm25_idx
  ON chunk USING bm25 (id, content, granularity)
  WITH (key_field = 'id');

-- Query-time validity predicate (decision D2) over chunks.
CREATE INDEX IF NOT EXISTS chunk_validity_idx ON chunk (galioja_nuo, galioja_iki);

CREATE INDEX IF NOT EXISTS chunk_article_idx ON chunk (article_id);
