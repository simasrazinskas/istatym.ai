# Temporal Versioning and Data Model

How to represent point-in-time / consolidated legislation so we can serve the latest valid state and ignore repealed parts.
Supports decisions D1 and D2.

## Bottom line

The hard problem is already solved as a *model*: FRBR's work → dated-expression → point-in-time structure.
Adopt the model (and borrow the schema from laws.africa Indigo), keep storage pragmatic, and build only the Lithuanian ingestion/dedup/sync layer ourselves.
Do not adopt full Akoma Ntoso XML as primary RAG storage — it is overkill for embeddings; keep a faithful structured source-of-truth and derive clean text + temporal metadata for the vector store (the legislation.gov.uk "one master, derive the rest" discipline).

## Standards

- **Akoma Ntoso / LegalDocML (OASIS)** — https://docs.oasis-open.org/legaldocml/ — FRBR-based XML standard; its eId discipline keeps a section's id stable across versions even after renumbering, which is what makes diffing/supersession tractable.
- **FRBR temporal model** — work (the abstract law) / expression (a dated consolidated version) / manifestation (a file format). Internalize this three-tier split; every serious system uses it.
- **ELI (European Legislation Identifier)** — https://eur-lex.europa.eu/eli-register/ — URI + RDF metadata. Lithuania implements **Pillar 1 only** (URI naming), so do not depend on rich ELI metadata from TAR. Adopt ELI-style URIs for citation if cheap.
- **EU CDM (Common Data Model)** — http://publications.europa.eu/ontology/cdm — borrow relation names (`consolidated_by`, `repeals`, `amends`, expression-level `effective_from/to`); a consolidated text's validity date = the date its latest included amendment became applicable (exactly our semantics).

## Reusable tooling

- **laws.africa Indigo** — https://github.com/laws-africa/indigo — Django/Postgres platform that manages, consolidates and publishes legislation in Akoma Ntoso; **v19.1.0 (Dec 2025), very active, GPL-3.0**. Its data model is the strongest reference: a Point in Time = all expressions of a work on a date; each amended version is a distinct expression keyed by an FRBR URI with the date after `@` (e.g. `/act/1998/55/eng@2014-01-17`); each point in time stores a pre-consolidated snapshot, not just a diff. Copy this `points_in_time` schema.
- **Cobalt** — https://github.com/laws-africa/cobalt — lightweight Python library for Akoma Ntoso documents and FRBR URIs; adopt for parsing/constructing the dated FRBR URIs that key the temporal index, even if we do not adopt full Indigo.
- **Bluebell** — https://github.com/laws-africa/bluebell — Markdown-like text → valid Akoma Ntoso XML; optional, useful if we ever normalize TAR text into AKN structure.
- **legislation.gov.uk OSS** — https://github.com/legislation — the gold-standard public point-in-time system; reusable ideas: keep one canonical master format and derive the rest; the dated-URI + "Timeline of Changes" UX; an open GATE NLP pipeline that detects amendments in legislation automatically (relevant only if our heuristic+LLM amendment detection falls short).

## Recommendation for our schema

Adopt the FRBR work/expression/point-in-time abstraction and dated identifiers as the internal keys; mirror Indigo's `points_in_time` selection logic; borrow CDM relation names.
Map onto our source data: act = work (keyed by `tar_kodas`), each `Suvestine` = a dated expression with `galioja_nuo`/`galioja_iki` as the validity window.
"Current valid version" = the latest expression with `effective_from <= as_of` that is not repealed — a near-trivial query once expressions are dated.
Store the structured/clean text as source-of-truth; derive chunked text + temporal metadata for pgvector.

## Verdicts

- ADOPT the model (FRBR/AKN semantics) and Cobalt; consider forking Indigo only if we want its editorial UI (mind GPL-3).
- BUILD the Lithuanian ingestion/dedup/incremental-sync layer (append-only, keyed by `(work_id, expression_date, content_hash)`).
- Do NOT expect a ready Lithuanian connector from `openlegaldata/awesome-legal-data` (no Baltic entries, no AKN/ELI tooling).
