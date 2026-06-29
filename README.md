# istatym.ai

Open-source, agentic retrieval-augmented question answering over the full Lithuanian law database.

istatym.ai answers natural-language legal questions (for example "How much notice am I owed for redundancy if I have worked six months?") by retrieving the relevant law, reading the relevant parts, asking clarifying questions when the answer depends on facts you have not given, and presenting a grounded answer with verifiable sources.

> **Status:** early, active development. The architecture is designed and the data source is validated; ingestion and the agent are being built. Expect rapid change.

> **Not legal advice.** istatym.ai is an information tool, not a lawyer. Its answers may be incomplete or wrong and must not be relied on as legal advice.

## Why this is possible

The full Lithuanian Register of Legal Acts (Teisės aktų registras, TAR) is published as structured open data — acts, their full text, and their consolidated (point-in-time) versions — through Lithuania's national open-data portal.
This means the corpus is built from an official API, not scraped, and every answer can be traced to a specific article of a specific consolidated version valid on a specific date.

## What makes it different

- **Latest valid state.** Law is modelled as FRBR works with dated expressions; "current law" is always computed from validity windows, so superseded and repealed text is excluded by construction.
- **Grounded by construction.** The agent copies evidence verbatim and verifies each quote is a substring of the source before reasoning — citations are verified, not trusted.
- **Law-driven clarification.** It asks a clarifying question only when the retrieved provision actually branches on a missing fact, generated from the law rather than a fixed intake form.
- **Self-hosted and private.** Embeddings are self-hosted; user queries and the corpus do not need to leave your infrastructure.

## Architecture at a glance

- **Data source:** the TAR open dataset via the data.gov.lt Spinta API (bulk JSONL + a change-data-capture feed for incremental sync).
- **Store:** a single Postgres with pgvector (semantic) + ParadeDB `pg_search` (BM25), fused with Reciprocal Rank Fusion and reranked.
- **Embeddings:** self-hosted BGE-M3 (multilingual, strong on Lithuanian), pending an evaluation bake-off.
- **Agent:** built on [Vercel eve](https://github.com/vercel/eve) and the Vercel AI SDK, with a bounded agentic retrieval loop and an exact-reference navigation tool.

The full design and the research behind it live in [`docs/`](docs/):

- [`docs/research/00-architecture-decisions.md`](docs/research/00-architecture-decisions.md) — the canonical decision log.
- [`docs/research/`](docs/research/) — supporting research (data source, temporal versioning, retrieval stack, embeddings/grounding, prior art).
- [`docs/eve-agent-design.md`](docs/eve-agent-design.md) — how the agent maps onto eve primitives.

## Repository layout

```
docs/
  research/            project research and architecture decisions
  eve-agent-design.md  agent design grounded in eve primitives
  reference/eve/       vendored copy of the eve docs (Apache-2.0; see PROVENANCE.md)
```

## Acknowledgements

- Legal data: Teisės aktų registras (TAR), published as open data by the Seimas Chancellery and the State Data Agency of Lithuania.
- Agent framework: [eve](https://github.com/vercel/eve) by Vercel, Inc. (Apache-2.0). A copy of its documentation is vendored under `docs/reference/eve/` with attribution.

## License

Copyright (C) 2026 Simas Razinskas.

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0) — see [`LICENSE`](LICENSE).
This is a strong copyleft license: if you run a modified version of istatym.ai to provide a network service, you must make your modified source available to its users.
Vendored third-party material under `docs/reference/eve/` retains its own license (Apache-2.0) and is not covered by this project's license.
