# Research

Project research and architecture decisions for istatym.ai.
Start with the decision log; the numbered files provide the supporting evidence.

- [`00-architecture-decisions.md`](00-architecture-decisions.md) — the canonical decision log (D1–D11) with reasoning.
- [`01-data-source-tar-spinta.md`](01-data-source-tar-spinta.md) — the TAR open dataset and the data.gov.lt Spinta API: models, fields, counts, query patterns, ingestion/CDC, and data-model lessons (verified live).
- [`02-temporal-versioning-and-schema.md`](02-temporal-versioning-and-schema.md) — FRBR / Akoma Ntoso / ELI and reusable tooling (laws.africa Indigo, Cobalt) for point-in-time legislation.
- [`03-retrieval-stack-postgres-eve.md`](03-retrieval-stack-postgres-eve.md) — Postgres hybrid search (pgvector + pg_search + RRF + rerank), Vercel eve, and the AI SDK.
- [`04-embeddings-and-grounding.md`](04-embeddings-and-grounding.md) — Lithuanian embeddings and rerankers, chunking, grounding, and the evaluation plan.
- [`05-prior-art-and-competitors.md`](05-prior-art-and-competitors.md) — existing tooling, datasets, and competing products (Vasara.ai, NuRule).
- [`eve-self-hosting-spike.md`](eve-self-hosting-spike.md) — Phase 0 spike: eve is fully self-hostable off-Vercel (resolves the D17 open risk).

See also [`../eve-agent-design.md`](../eve-agent-design.md) for the agent design grounded in eve primitives.

These notes synthesize research current as of June 2026.
Software versions, model rankings, and recent papers cited here are point-in-time and should be re-verified before they are relied on.
