# Data Source: Teisės aktų registras (TAR) via the data.gov.lt Spinta API

All facts below were verified live against the API on 2026-06-29/30.

## Summary

The full Lithuanian Register of Legal Acts (Teisės aktų registras, TAR) is published as structured open data through Lithuania's national open-data portal, which runs the **Spinta** API engine.
This means the project does **not** need to scrape e-tar.lt: the acts, their full text, and their consolidated versions are available as queryable JSON/JSONL/CSV with server-side filtering, sorting, counts, pagination, and a change-data-capture feed.
The dataset was opened on 2025-07-02 by the Seimas Chancellery and the State Data Agency and is updated near-continuously (changes observed as recent as 2026-06-15).

## Endpoints

- API base: `https://get.data.gov.lt/datasets/gov/lrsk/teises_aktai/`
- Dataset landing page: `https://data.gov.lt/datasets/2613/`
- Formats: append `/:format/json`, `/:format/jsonl`, `/:format/csv` (also `ascii`, `rdf`, `html`).
- Namespace listing: `.../:ns/:all`.

## Data models

Three models live under `datasets/gov/lrsk/teises_aktai`.

### Dokumentas — 474,049 records

One row per legal act (base acts and amendment acts alike).
Carries the full document text and the complete chronology.
Key fields:

- `dokumento_id` — stable document identifier (used to join `Suvestine` and `Priedas`).
- `tar_kodas` — the register code / i.k. (e.g. `2016-23709`); the most reliable stable identifier for a work (titles are unreliable).
- `pavadinimas`, `nuoroda` (e-tar URL), `tekstas_lt` (full text), `rusis` (act type), `dok_grupe`, `parengusi_inst`, `priemusi_inst`.
- `galioj_busena` — validity status (`galioja` / `negalioja`).
- Chronology dates: `priimtas`, `registracija`, `paskelbta_tar`, `isigalioja`, `negalioja`, plus conditional variants (`isigalioja_po_salygu`, `negalioja_po_salygu`) and `termino_sal`.
- 383,297 records are `galioja`; only 37 have null `tekstas_lt` (28 of those valid) — so text coverage is effectively complete.

### Suvestine — 333,293 records

Consolidated versions (suvestinės redakcijos): the full merged text of an act as it stands within a validity window.
Key fields:

- `dokumento_id` — links to the parent `Dokumentas` (this is the only document↔document link in the data).
- `suvestines_id`, `nuoroda`, `tekstas_lt` (consolidated full text).
- `galioja_nuo`, `galioja_iki` — validity window (the basis for "current law"). 166,634 rows are open-ended (`galioja_iki` null = currently in force).
- `suv_duom_atnaujinimas` — last update timestamp.

### Priedas — 121,091 records

Appendix/annex texts, mostly as binary files.
Key fields: `priedo_id`, `dokumento_id`, `priedo_pav`, `failo_pletinys` (docx/pdf/xlsx/jpg/odt), `priedo_tekstas` (extracted text, frequently `"[Faile yra netekstinių elementų]"` i.e. extraction failed), `priedo_url`, `atnaujinimo_data`.
Attachment texts were only added on 2026-03-02, so coverage is newer and possibly incomplete.

## Query patterns (confirmed working)

- Count: `?select(count())`.
- Filter: `?galioj_busena="galioja"`, `?galioja_iki=null`, date comparisons like `?galioja_iki>'2026-06-29'`.
- Substring: `?pavadinimas.contains("darbo kodeks")` (operators eq/lt/gt/le/ge/contains/startswith work; `in`/`notin`/`endswith` are not live yet).
- Field selection: `?select(dokumento_id,pavadinimas)`.
- Sorting / limit: `?sort(-galioja_nuo)&limit(1)`.
- URL-encode Lithuanian diacritics in query values (use `curl --data-urlencode ... --get`).

## Ingestion strategy

- **Bulk:** stream each model as `/:format/jsonl` with cursor pagination (opaque `page('...')` tokens); record the max `_cid` per model at the start.
- **Incremental (CDC):** the `/:changes` feed returns change entries with `_cid` (monotonic change id), `_op` (`insert`/`patch`/`delete`/`move`), `_created`, `_txn`, `_id`, `_revision`. Keep a `_cid` watermark, poll `/:changes/<last_cid>`, apply by `_op`, dedupe via `_revision`. No full re-crawl needed.
- Re-run base/amendment classification and re-chunk only the works touched by a change.

## Important data-model lessons (learned by grounding)

- **No relationship edges.** There is no amends/amended-by / "Ryšiai" field anywhere in the structured data — only the `Suvestine.dokumento_id` version link. Act-to-act relationships exist only as narrative text inside `tekstas_lt`. Deriving them is both our gap and our differentiator.
- **"Current law" selection.** For each work: if it has a consolidation with `galioja_nuo <= today < galioja_iki` (or `galioja_iki` null), that consolidated text is canonical; if it has consolidations but none current, the act is fully repealed (exclude); if it has no consolidation, use `Dokumentas.tekstas_lt` when `galioj_busena = "galioja"`.
- **A "code" can be fragmented.** What the public calls one document (e.g. Darbo kodeksas) may be split across an approval law, a separately-registered code body, and many amendment laws, with no link between them. Identify the code body by its register code (`tar_kodas`), not its title.
- **The register is amendment-dominated.** 154,567 documents (33%) have "pakeit" in the title; these amendment acts mostly add noise for a "what is the current law" corpus because their content is already folded into the base act's consolidation.
- **Substance is usually inline.** Laws and technical regulations carry their full structured text inline in the consolidation / document text (verified: Statybos įstatymas, STR 2.05.18, Darbo kodeksas). Binary `Priedas` files are mostly supplementary forms/tables.
- **Caveat:** Spinta is officially "pre-alpha" and has a known pagination-boundary bug (possible infinite loop when a page boundary value repeats); guard the bulk loader against it.

## Tooling note

A community TypeScript SDK + MCP server exists (`gmacev/lt-open-data-sdk`) but is an immature solo project with its own documented live-API limitations.
The dataset is plain REST/JSONL; call Spinta directly rather than taking the dependency.
Spinta API docs: `https://docs.data.gov.lt/projects/atviriduomenys/latest/api/index.html`.
