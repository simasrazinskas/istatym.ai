# Architecture Decisions

This document records the load-bearing design decisions for istatym.ai and the reasoning behind each.
It is the canonical decision log; the topic-specific research files in this directory provide the supporting evidence.

## Product goal

An agentic RAG system that answers Lithuanian-law questions in natural language (e.g. "Can I build a shed on my lot?", "How much notice for redundancy?").
The agent retrieves the relevant law, reads the relevant parts, asks clarifying questions when the answer depends on facts the user has not given, and presents a grounded answer with verifiable sources.
The agent framework is **Vercel eve** (durable backend agents) on top of the **Vercel AI SDK 6**.

## Decisions

### D1 — Canonical retrieval unit = the act / consolidation, modelled as FRBR work → expression

An act is a *work*; each consolidated version (`Suvestine`) is a dated *expression* with a validity window.
Articles are a *chunking* concern layered on top, not first-class versioned rows.
Rationale: this is exactly what the source data gives us, it keeps deduplication and supersession clean, and it matches the FRBR/Akoma-Ntoso model used by every serious legislation platform (laws.africa Indigo, legislation.gov.uk, EUR-Lex CDM).
See `02-temporal-versioning-and-schema.md`.

### D2 — "Currently valid" is a query-time date predicate, not a stored flag

The authoritative test for "current law" is always `valid_from <= as_of AND (valid_to IS NULL OR valid_to > as_of)`, applied at query time.
A materialized `is_current` flag is used only to decide *what to embed*, never to decide correctness.
Rationale: validity windows roll over by the calendar with no data-change event, so a baked flag silently serves stale law; a query-time predicate cannot.
A daily reconciliation job keeps the vector index lean (embed only current/near-future expressions) but the date predicate remains the backstop.

### D3 — Storage = single Postgres with pgvector + ParadeDB pg_search (BM25) + RRF + reranker

One Postgres holds canonical text, metadata, the BM25 index, and the vectors.
Hybrid search = pgvector HNSW (semantic) + `pg_search` BM25 (keyword, lemmatized for Lithuanian), fused with Reciprocal Rank Fusion written in SQL (k=60), then a cross-encoder reranker.
Rationale: at ~1–3M chunks a dedicated vector DB buys nothing and costs transactional consistency between validity metadata and vectors; legal queries hinge on exact terms and article numbers, so true BM25 (not native `ts_rank_cd`) matters.
Fallback to native `tsvector` only on a managed Postgres that forbids custom extensions (e.g. RDS).
Avoid pgvecto.rs (deprecated → VectorChord).
See `03-retrieval-stack-postgres-eve.md`.

### D4 — Base-vs-amendment classification is heuristic + LLM, leaning on an asymmetry

The open data has **no** amends/amended-by relationship edges, so we must classify each act ourselves.
Backbone: title patterns (`pakeitimo`, `papildymo`, `pripažinimo netekusiu galios`) + act type (exclude `Nutartis` court rulings, `Informacija`, `Pranešimas`) + **consolidation-richness** (a work with many dated expressions and a large current text is a base act regardless of title).
An LLM pass cleans up the ambiguous middle (e.g. "nauja redakcija" restatements).
Rationale: the failure modes are asymmetric and both mild — wrongly excluding an amendment act loses no content (its text is already folded into the base act's consolidation), and wrongly including an amendment diff is minor retrieval noise filtered by validity + ranking.
So a heuristic is good enough; we are not in a high-stakes classification regime.
Caveat learned from grounding: titles are unreliable (the Darbo kodeksas body itself is titled "...patvirtinimo, įsigaliojimo..."); use `tar_kodas` (the register i.k.) as the stable work identifier, and the consolidation-richness signal to avoid misclassifying base codes as amendments.

### D5 — Ingest inline text only in v1; defer binary appendixes

The substantive normative text (laws, technical regulations) is inline in the consolidation / document text.
Binary `Priedas` appendixes (docx/pdf/xlsx/jpg — forms, tables, drawings) are mostly supplementary and frequently have failed text extraction.
v1 indexes inline text only; for acts that have un-ingested binary appendixes we store a flag + the official `priedo_url` so the agent can tell the user "this act has an annex I have not ingested — see [link]".
Rationale: honest flag-and-link is safe; silently injecting OCR-garbled legal text the agent might cite confidently is not.
Targeted binary-appendix parsing is a phase-2 task for specific high-value acts.

### D6 — Chunking = dual-granularity + breadcrumb + ground-by-construction

Embed paragraph/`punktas` leaf chunks, keep the `straipsnis` (article) as the parent and citation unit, and auto-merge leaves up to the parent at query time (small-to-big).
Prepend a deterministic structural breadcrumb to every chunk before embedding, e.g. `"Darbo kodeksas > XII skyrius > 57 straipsnis, 1 dalis [galioja nuo 2025-01-01]"`.
Strip the bibliographic header and inline amendment-history annotations from the embedded text (keep them as metadata) but preserve `Neteko galios` repeal markers.
Config: leaf ceiling ~512–1024 tokens, floor ~200–300 (merge tiny definitions within the same parent only), split oversized articles by native `dalis`/`punktas`, overlap 0, assert `tokens <= 0.9 × model_limit` to prevent silent truncation.
Ground-by-construction is a hard agent-side requirement: copy evidence verbatim, verify each quote is a substring of the source, then reason.
Rationale: benchmarked legal RAG shows article+paragraph beats either alone; the breadcrumb fixes the #1 legal failure (right text, wrong statute) and is itself the citation; even commercial legal RAG hallucinates 17–34% (Stanford RegLab), so citations must be verified, not trusted.
See `04-embeddings-and-grounding.md`.

### D7 — Scope of v1 = full corpus ingested, narrow embed/agent/eval

Bulk-ingest and classify the **entire** corpus into Postgres from day one (storage is cheap and it makes the CDC sync real), but **embed, build the agent, and build the eval set for one domain only**.
Rationale: gives a complete data spine immediately and lets us widen the agent later by embedding more partitions, with no re-architecture; the eval set must be hand-built (no Lithuanian legal retrieval benchmark exists), which is only tractable on a bounded domain.

### D8 — v1 vertical = employment law (Darbo kodeksas)

Confirmed in the data: the Code is work `f6d686707e7011e6b969d7ae07280e89` (register i.k. `2016-23709`), with 38 dated expressions; the current open-ended consolidation (from 2025-01-01) is ~434 KB / ~280 articles of clean structured text.
Rationale: a single large national consolidated code, inline, with no municipal-law dependency — the cleanest possible target to validate the whole pipeline and build the first eval set.
The v1 "employment" corpus = the Code plus its cluster of implementing acts (Vyriausybės nutarimai / ministro įsakymai on pay, leave, work time).

### D9 — Embeddings = self-host BGE-M3 (pending an eval bake-off vs Gemini)

Self-host BGE-M3 (open, MIT): embeddings never leave our infrastructure (a compliance posture and a marketing differentiator for confidential legal data), no per-token cost at our volume, and its hybrid dense+sparse+ColBERT output suits Lithuanian morphology and exact legal terms.
Validate against Gemini `gemini-embedding-001` on the Lithuanian employment-law eval set before locking in.
Reranker: BGE-reranker-v2-m3 (open, lists `lt`) or Cohere Rerank v3.5 (API).
Rationale: no Lithuanian-specific retrieval model exists and vendor benchmarks (MIRACL) exclude Lithuanian, so treat public rankings as priors and decide on our own eval.
See `04-embeddings-and-grounding.md`.

### D10 — Retrieval = bounded agentic loop + exact-reference navigation tool

Single-shot hybrid retrieval is the fast path; escalate to an iterative retrieve → grade → reformulate loop only when a groundedness grader flags low confidence, bounded by a retrieval budget.
Include an exact-reference navigation tool that deterministically fetches a specific article by its citation/ID to follow cross-references (distinct from semantic search).
Rationale: legal reasoning is genuinely multi-hop (an article references another article or a government resolution), and resolving precise cross-references by ID is more correct than hoping semantic search surfaces them; this agentic loop is also the differentiation against incumbents.

### D11 — Clarification = fact-gated, law-driven (B), with all-branches fallback (C)

Retrieve first; ask the user a clarifying question only when the retrieved controlling provision branches on a fact the user has not given and the branch is material.
Questions are generated from the retrieved law (the agent asks "how long have you worked there?" because it retrieved an article with a 1-year threshold), never from a hardcoded intake form, so the mechanism transfers when we widen past employment.
If the user declines or goes silent, fall back to answering with all branches stated.
This rides eve's durable sessions (pause for the next user message, resume with full context).
See `docs/eve-agent-design.md`.

## Open decisions (not yet made)

- Project open-source license (publishing as public `istatym.ai`).
- Whether/when to build the act-to-act relationship graph (the "moat") — likely phase-2, derived from text since no source edges exist.
- The agent's reasoning/answer LLM (default to a current top Claude model via the AI SDK gateway, to be confirmed).
- Eval set construction details and target metrics.
