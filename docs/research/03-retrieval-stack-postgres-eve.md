# Retrieval Stack: Postgres Hybrid Search + Vercel eve

Supports decisions D3, D10, D11.
Versions current as of June 2026.

## Postgres hybrid-search extensions

- **pgvector** — https://github.com/pgvector/pgvector — the de-facto vector type + HNSW/IVFFlat ANN; stable, runs everywhere. Baseline semantic side. At 1–3M vectors HNSW is comfortable.
- **ParadeDB `pg_search`** — https://github.com/paradedb/paradedb — real BM25 (Tantivy/Lucene-grade) inverted index inside Postgres, with faceting and JOIN/predicate **pushdown** (so the `valid_from/valid_to` filter stays cheap); v0.22.5 (Apr 2026), PG15+. Needs `shared_preload_libraries`; **not available on AWS RDS**; works self-hosted and on Neon. This is our keyword engine.
- **VectorChord + VectorChord-bm25 + pg_tokenizer** — https://docs.vectorchord.ai — single vendor for disk-friendly RaBitQ ANN + native BM25; the successor to the deprecated pgvecto.rs. Alternative if we want one vendor at larger scale; watch the tokenization/NDCG caveat for legal text.
- **pgvectorscale** — https://github.com/timescale/pgvectorscale — StreamingDiskANN + binary quantization on top of pgvector; vector-only (no BM25). Useful only at much larger scale.
- Native `tsvector` + `ts_rank_cd` — Postgres core; runs on any managed PG including RDS; lower lexical precision than true BM25. Our fallback only when extensions are blocked.
- **Avoid:** pgvecto.rs (deprecated). **Too new to anchor on:** `pg_textsearch` (Tiger Data, Feb 2026).

## Fusion and reranking

- **Reciprocal Rank Fusion (RRF)** is the consensus fusion method and is **not** a native function in any extension — write it in SQL: rank each retriever with `ROW_NUMBER()`, score each row `1/(k + rank)` with **k=60**, `UNION ALL`, `GROUP BY id`, `SUM`, order desc. A weighted variant multiplies each arm. RRF uses ranks not raw scores, sidestepping BM25-vs-cosine scale incompatibility, and reliably beats single-retriever by 5–15% nDCG.
- Wrap it as a reusable SQL function `hybrid_search(query, query_embedding, validity_date, k, top_n)`; keep per-arm candidate limits small (~20–50) before fusion.
- **Reranking:** retrieve ~40–60 candidates → cross-encoder rerank to top ~5–8. **AI SDK 6 ships a native `rerank()`** (Cohere `rerank-v3.5`, Bedrock, Together), so do RRF in SQL and the final rerank in TypeScript — no extra infra.
- For Lithuanian, lemmatize the BM25 side (heavy inflection fragments exact-term matching).

## Vercel eve

- eve = filesystem-first, durable backend agents; Apache-2.0; **v0.17.1 beta (Jun 2026)**. https://github.com/vercel/eve · https://vercel.com/docs/eve
- Everything is authored under `agent/`: `instructions.md` (always-on prompt), `agent.ts` (`defineAgent({ model })`), `tools/*.ts` (one typed tool per file, filename = tool name), `skills/*` (Markdown playbooks loaded on demand), `subagents/*` (child agents with narrower tools).
- A **session is a durable Vercel Workflow** — event-logged, replayed, survives cold starts/redeploys, and **pauses waiting for the next user message**. This is the native substrate for our multi-turn clarify loop.
- Also: sandbox, channels (HTTP/Slack/etc.), connections (MCP/OpenAPI), schedules, evals, Agent Runs observability.
- There is no official eve RAG example yet; our concrete mapping lives in `docs/eve-agent-design.md`.

## Vercel AI SDK 6 (released Dec 22 2025)

- `ToolLoopAgent` — production tool-execution loop (LLM → tool calls → results → repeat) with type-safe streaming + structured output.
- `rerank()` — native reranking (see above).
- `Output.object({ schema })` — structured output combined with tool loops → citation enforcement and filter extraction.
- `needsApproval` on tools — human-in-the-loop gating (for actions, not for asking the user clarifying questions).
- MCP support; `embed`/`embedMany` embeddings API.
- Official RAG reference uses `streamText` + tool calls + Drizzle/Postgres pgvector (https://ai-sdk.dev/cookbook/guides/rag-chatbot) — a good scaffold, but vector-only; we add the hybrid SQL.

## Agentic RAG patterns (D10/D11)

- Autonomous retrieval loop: decompose → retrieve selectively → grade results → rewrite query on failure → repeat until grounded or budget hit.
- Query rewriting / multi-query expansion in domain vocabulary; fuse with RRF.
- Self-querying with metadata filters: the LLM extracts structured filters (our validity-date, jurisdiction) from natural language into the SQL `WHERE`.
- Retrieval grading / self-correction: a groundedness judge re-loops to retrieval if a claim is unsupported.
- Citation enforcement via structured output; reject ungrounded sentences.

## Recommended stack

Primary (self-hosted / Neon): pgvector HNSW (cosine) + ParadeDB `pg_search` (BM25, lemmatized) + RRF SQL function + AI SDK 6 `rerank()` (Cohere v3.5).
Fallback (extension-blocked managed PG): pgvector HNSW + native `tsvector`/`ts_rank_cd` + RRF + `rerank()`.
Validity filter via predicate pushdown / a partial index on the date range.
