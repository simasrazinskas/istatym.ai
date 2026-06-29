# Implementation Plan

A phased build plan that sequences the architecture decisions (`research/00-architecture-decisions.md`, D1–D18) into work.
The guiding principle is the v1 scope (D7): ingest and classify the **full** corpus, but embed, build the agent, and evaluate for the **employment** vertical only (D8), then widen.
Phases are ordered by dependency; the de-risking spikes in Phase 0 come first because they can change later decisions.

## Phase 0 — De-risking spikes

These are small, time-boxed investigations whose outcomes can force changes to D15/D17, so they run before committing build effort.

- **eve self-hosting (highest priority).** Read eve's deployment docs (`reference/eve/docs/guides/deployment.md`) and the beta self-host story; determine whether the durable agent runtime can run off-Vercel. Outcome decides whether D17 (fully self-hosted) holds, or whether eve-on-Vercel becomes an accepted exception, or whether the agent framework is revisited.
- **Spinta bulk + CDC spike.** Pull a few thousand `Dokumentas`/`Suvestine` records via `/:format/jsonl` with cursor pagination and exercise `/:changes`; reproduce and guard against the known pagination-boundary bug. Confirms the ingestion contract end to end.
- **Embedding-service spike.** Stand up BGE-M3 behind a minimal Python service (batch + single-query paths) with correct query/document prefixes; confirm throughput on CPU (query) and the GPU need for batch.

Exit criteria: each spike answers its question with a written note in `docs/` and a go/no-go for the dependent decision.

## Phase 1 — Data spine (full corpus)

Goal: the entire corpus ingested, classified, and modelled in Postgres, with incremental sync working.
This is the D7 "full ingest" half and is domain-agnostic.

- **Schema (D1, D2, D16).** Postgres tables for works (keyed by `tar_kodas`), dated expressions (validity windows `valid_from`/`valid_to`), documents, and the raw-archive references; append-only expressions; FRBR-style identifiers (Cobalt for URI handling).
- **Ingestion (D18).** Bulk loader (JSONL + cursor pagination) writing to the immutable raw archive first, then into Postgres; daily CDC via `/:changes` with a `_cid` watermark applying `insert`/`patch`/`delete`; re-process only touched works.
- **Base/amendment classification (D4).** Title patterns + act type + consolidation-richness heuristic, with an LLM pass on the ambiguous middle; exclude non-normative `rūšys` (Nutartis/Informacija/Pranešimas).
- **Canonical-set + validity (D2).** Compute the current valid expression per work as a query-time predicate; materialize only an "embed this" hint, refreshed by the daily validity-rollover reconciliation.

Exit criteria: full corpus loaded; daily delta applies cleanly; classification spot-checked on a labelled sample (including the Darbo kodeksas case, where the base code's title looks like an amendment).

## Phase 2 — Employment content pipeline (narrow)

Goal: the employment corpus parsed, chunked, and embedded.
This is the D7 "narrow" half on the D8 vertical.

- **Corpus selection (D8).** Darbo kodeksas (work `f6d686707e7011e6b969d7ae07280e89`, i.k. `2016-23709`) plus its cluster of implementing acts (pay, leave, work-time `nutarimai`/`įsakymai`).
- **Hierarchy parser + breadcrumb (D6).** Deterministic parser for `skyrius → straipsnis → dalis → punktas`; strip the bibliographic header and amendment-history annotations (keep `Neteko galios` markers); recursive-split fallback for unstructured acts.
- **Dual-granularity chunker (D6).** Paragraph/`punktas` leaves with the `straipsnis` as parent/citation unit; ceiling ~512–1024 tokens, floor ~200–300, merge tiny definitions within the parent only, overlap 0, assert `tokens <= 0.9 × model_limit`.
- **Embedding + index (D3, D9).** Embed leaves with BGE-M3 via the shared service (breadcrumb prepended); store vectors + the lemmatized BM25 column in Postgres.

Exit criteria: employment corpus is chunked, breadcrumbed, embedded, and queryable; chunk identities are stable across a re-run (deterministic).

## Phase 3 — Retrieval layer

Goal: hybrid retrieval that respects validity and resolves intra-act references.

- **Hybrid search (D3).** SQL `hybrid_search(query, query_embedding, validity_date, k, top_n)`: pgvector HNSW + `pg_search` BM25 fused with RRF (k=60), with the validity-date predicate pushed down.
- **Reranker (D3, D9).** Cross-encoder rerank (BGE-reranker-v2-m3 or Cohere v3.5) of the top candidates.
- **Intra-act reference resolution (D12).** Parse Lithuanian citation grammar ("X straipsnio Y dalies Z punktas") and resolve deterministically within the act; this backs the agent's `get_article` tool.

Exit criteria: a query returns correctly-ranked, currently-valid chunks with citations; an exact-reference lookup resolves deterministically.

## Phase 4 — Evaluation harness

Goal: the measurement that lets us choose the embedder and gate releases (D14).
The eval query set can be authored in parallel with Phases 2–3 since it needs only corpus text.

- **Eval set (D14).** ~150–300 Lithuanian employment questions with human-checked gold passages; seed from EUR-Lex-Sum `lt` where useful; a ~50-question golden set with human-written gold answers.
- **Automated gate (D14).** Recall@20 / nDCG@10 / MRR + deterministic citation-substring verification + temporal-correctness check (cited expression is the currently-valid one).
- **Embedder bake-off (D9).** BGE-M3 vs Gemini-001 (vs Qwen3) on the eval set; decide the default on measured nDCG@10 / Recall@20 / MRR.
- **Pre-release judging (D14).** LLM-judge on the golden set calibrated against human spot-checks.

Exit criteria: gates run in CI; the embedder is chosen on data; baseline retrieval clears Recall@20 ≥ ~0.90.

## Phase 5 — The eve agent

Goal: the product behavior, grounded in eve primitives (`docs/eve-agent-design.md`).

- **Scaffold (D16).** `agent/` layout: `instructions.md` (citation/abstention/non-legal-advice policy), `agent.ts`, tools, skills.
- **Tools.** `hybrid_search` (Phase 3), `get_article` (D12 exact-reference), `verify_quote` (D6 substring check).
- **Bounded retrieval loop (D10).** Single-shot fast path; escalate to retrieve→grade→reformulate when a groundedness grader flags low confidence; bounded by a `defineState` retrieval budget reset on `turn.started`.
- **Clarification (D11).** Fact-gated, law-driven questions via the built-in `ask_question` HITL primitive (the durable park/resume), with the all-branches fallback.
- **Output contract (D13).** Per-turn `outputSchema` `{ answer_markdown, claims, citations[], as_of_date, confidence, caveats }`; explicit abstention; ground-by-construction enforced in code via `verify_quote`, not just by schema shape.
- **Reasoning model (D15).** Opus 4.8 for the answer/citation step (Anthropic Citations API), cheaper tiers for sub-tasks, via the AI Gateway under a zero-retention arrangement.

Exit criteria: the worked "6 months redundancy notice" trace from `eve-agent-design.md` runs end to end — retrieve → detect tenure-branch → clarify → resume → grounded, cited, as-of-dated answer.

## Phase 6 — Hardening and widening

- Meet all D14 release gates (citation-substring = 100%, temporal-correctness = 100% on the golden set, high abstention precision); milestone lawyer review.
- Resolve the eve beta gaps noted in `eve-agent-design.md` (e.g. whether a per-turn `outputSchema` survives an `ask_question` pause).
- Widen the agent past employment by embedding more corpus partitions — no re-architecture, since the data spine (Phase 1) is already full-corpus.
- Phase-2 (post-v1) features: the cross-act amends/amended-by relationship graph (the differentiation), and targeted binary-appendix ingestion.

## Dependency summary

- Phase 0 gates D15/D17 and the ingestion/embedding contracts.
- Phase 1 (full data spine) unblocks everything; Phase 2 depends on it.
- Phases 2 and 3 feed Phase 4; the eval-set authoring overlaps Phases 2–3.
- Phase 5 depends on Phases 3 and 4; Phase 6 depends on all.

## Cross-cutting gates (D14, apply from Phase 3 onward)

- Recall@20 ≥ ~0.90 on the eval set.
- Citation-substring verification = 100% (non-substring quote = hard fail).
- Temporal correctness = 100% on the golden set (never cite a superseded version as current).
- Explicit abstention when grounding confidence is low.
