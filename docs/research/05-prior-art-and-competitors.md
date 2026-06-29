# Prior Art and Competitors

Lithuanian legal-data tooling, existing datasets/models, and competing products.

## Tooling for the data source

- **gmacev/lt-open-data-sdk** — https://github.com/gmacev/lt-open-data-sdk — TypeScript SDK + CLI (`lt-data`) + MCP server wrapping the Spinta API generically; v1.2.2 (Jan 2026), MIT, single-maintainer, ~2 stars. Dataset-agnostic (no special handling for the legal-acts dataset). Documents live-API limitations (`endswith`/`in`/`notin` not supported; do not use `.select()` with `stream()`). **Verdict: call Spinta directly; do not take this dependency** (borrow its CDC/pagination patterns if useful).
- **Spinta** — https://github.com/atviriduomenys/spinta — the engine behind get.data.gov.lt; self-described pre-alpha but in production. Docs: https://atviriduomenys.readthedocs.io/api/index.html.

## Existing datasets / models

- **ELRC Monolingual Lithuanian Legal corpus** (from e-tar.lt) — https://data.europa.eu/data/datasets/elrc_2385 — a text corpus, useful for embedding eval.
- **EUR-Lex-Sum**, **MultiEURLEX**, **LT-MLKM-modernBERT** — see `04-embeddings-and-grounding.md`.
- HF: `joelniklaus/legal-lithuanian-roberta-base`, `VSSA-SDSA/LT-NER-modernBERT` (legal NER) — useful for NER/embedding baselines, not ingestion.
- `Lietuvos-Respublika/Lietuvos-Respublikos-Konstitucija` (GitHub) — the Constitution with change history; demo-scale only.
- Legacy e-tar.lt HTML scrapers are effectively **obsolete** now that the official open dataset exists; no actively-maintained scraper repo of note.

## Competing products

- **Vasara.ai** — https://vasara.ai/ (Sunny Ventures UAB) — the closest competitor and the benchmark to study. Mature RAG over Lithuanian legislation + treaties + decrees/orders + EU acts + Constitutional/Supreme/Administrative court + CJEU/ECtHR + agency guidance. Features: cited Q&A, search, document generation, "Radar" monitoring, bilingual output, EU data residency; enterprise clients including the **Lithuanian Finance Ministry**. Strong source-citation emphasis.
- **NuRule** — Q&A focused on court practice + legal norms, with jurisprudence-change email alerts; more case-law than statute-RAG.

## Differentiation

Vasara already has broad coverage and a government client, so competing on breadth is a weak opening move.
The defensible edges:
- The **act-to-act relationship graph** (amends/amended-by, cross-references) — these edges exist nowhere in the open data, so structuring them is genuinely additive.
- **Agentic multi-hop reasoning** with an exact-reference navigation tool and law-driven clarifying questions.
- **Data residency / fully self-hosted** posture (self-hosted embeddings; no user query or corpus leaves our infrastructure).
- A focused, demonstrably-better vertical (employment first) rather than broad mediocre coverage.
