# General Guidelines

- When writing or substantially editing long Markdown files, put each full sentence on its own line. Preserve normal Markdown structure, but avoid wrapping multiple sentences onto one physical line.
- When making technical decisions, do not give much weight to development cost. Instead, prefer quality, simplicity, robustness, scalability, and long term maintainability.
- When doing bug fixes, always start with reproducing the bug in an E2E setting as closely aligned with how an end user would experience it as possible. This makes sure you find the real problem so your fix will actually solve it.
- When end-to-end testing a product, be picky about the UI you see and be obsessed with pixel perfection. If something clearly looks off, even if it is not directly related to what you are doing, try to get it fixed along the way.
- Apply that same high standard to engineering excellence: lint, test failures, and test flakiness. If you see one, even if it is not caused by what you are working on right now, still get it fixed.
- Store your learnings and general information in a very concise manner in this AGENTS.md file.
- When starting an implementation request, always create a feature branch first; never commit work directly to the default branch (`main`).

# Architecture / Ops Learnings

- **Store:** ParadeDB image (`paradedb/paradedb:<v>-pg<major>`) is used as Postgres from day one so later slices add pgvector/pg_search without a data-directory migration. It boots as vanilla Postgres; pg_search needs `shared_preload_libraries` only when actually used.
- **Migrations** are plain SQL in `apps/web/db/migrations/`, applied forward-only on server boot via Next `instrumentation.ts` (`register()`), tracked in `schema_migrations`. The SQL files are read from disk at runtime, so they are NOT traced into the Next standalone bundle — the Dockerfile must `COPY db ./db` explicitly.
- **Lithuanian FTS (this slice):** no stemmer ships for Lithuanian; we use a custom `lithuanian_unaccent` tsconfig (unaccent + `simple`). `websearch_to_tsquery` AND-combines terms, which drops articles when any token is absent — rewrite `&`→`|` to restore BM25-style OR overlap ranked by `ts_rank_cd`. Real lemmatization is deferred to pg_search.
- **"Current law"** is a query-time validity predicate: `galioja_nuo <= asOf AND (galioja_iki IS NULL OR galioja_iki > asOf)`, denormalized onto `article` rows.
- **pnpm v11** reads build-script allowlists from `pnpm-workspace.yaml` `allowBuilds:` (NOT `package.json`). `esbuild: true` is required for `tsx` (ingest CLI + DB smoke test) to install its binary under `--frozen-lockfile`.
- **`pg`** is server-only — list it in `serverExternalPackages` so Next does not bundle it.
- **CI** gates the image build on a `test` job that runs `pnpm test:db` against a ParadeDB service container (network-free fixture ingest + retrieval asserts).
