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

# Hybrid Retrieval (issue #7, migration 003)

- **Pipeline (D3):** pgvector cosine (`embedding <=> q`) + pg_search BM25 (`id @@@ paradedb.match('content', q)`, rank via `paradedb.score(id)`), each capped per arm, fused by **RRF in SQL** (`1/(60+rank)`, `UNION ALL`+`GROUP BY`), reranked by a cross-encoder, then winning leaves **auto-merge to distinct parent articles** (best-leaf order). All arms apply the D2 validity predicate. Lives in `apps/web/src/lib/retrieval.ts:hybridSearchArticles` (injectable `embedQuery`/`rerank` deps make it testable with NO model service).
- **Chunking (D6):** `apps/ingest/src/chunk.ts` (pure) splits each article body on line-start `N.` `dalis` markers into paragraph leaves + keeps one `article`-granularity parent; prepends the structural breadcrumb to each chunk's `content` BEFORE embedding. `pnpm ingest:embed` (apps/ingest) chunks current articles, embeds via Voyage, replaces chunks per article (idempotent), `--limit` for bounded runs. Darbo kodeksas: 263 articles → ~1.5k chunks.
- **Embeddings (D9):** **Voyage AI** (Anthropic's recommended provider; default `voyage-4-large`, 1024-dim). Voyage is **asymmetric** — pass `input_type` `document` for passages, `query` for queries (the shared `embed.ts` exports `embedDocuments`/`embedQuery`). Vectors are L2-normalized (cosine == dot). Reranker = Voyage `/v1/rerank` (`VOYAGE_RERANK_MODEL`, default `rerank-2.5`), called from `retrieval.ts`. `embed.ts` is an identical copy in web + ingest. `VOYAGE_API_KEY` unset → route falls back to FTS; hybrid/rerank errors also fall back. App builds/serves with no key. (Pivoted away from self-hosted BGE-M3/TEI: TEI ships amd64-only and emulating it on Apple Silicon crashed the local Docker daemon — never run emulated x86 model inference locally.)
- **Residency note:** using Voyage sends corpus chunk text + queries to the provider; this revises the earlier "embeddings stay self-hosted" posture (D9/D17). Voyage offers an AWS Marketplace in-VPC deployment if strict residency is needed later.
- **Eval:** `apps/web pnpm compare` runs FTS vs hybrid recall@k/MRR over ~12 paraphrased employment queries (gold article numbers verified against headings). Acceptance = hybrid ≥ FTS on both.
- **Network-free tests:** chunker units in `apps/ingest scripts/test.ts`; RRF fusion + auto-merge in `apps/web scripts/smoke-db.ts` (inserts fake chunks with literal vectors, stubs embed+rerank). Both run on the existing ParadeDB CI services — no TEI in CI.

# eve Agent Runtime (apps/agent)

- **Self-hosted, no Vercel.** `eve build` emits a self-contained Nitro node-server under `.output/` (the `just-bash` sandbox is vendored into `.output/server/node_modules`), so the runtime image runs `node .output/server/index.mjs` with NO app `node_modules`. eve requires Node `>=24`.
- **Direct Anthropic:** pass a provider object `anthropic("claude-...")` (hyphenated ids) in `defineAgent({ model })` → runtime reads `ANTHROPIC_API_KEY`, no AI Gateway. A dotted string id (`anthropic/claude-...`) would route through the Gateway instead.
- **Durability:** the bundled local-disk workflow world persists to `./.workflow-data`; mount it on a volume. Proven: kill the container, `docker restart` with the same volume, resume the session via its `continuationToken` → prior turn recalled.
- **Reverse proxy MUST forward both `/eve/` and `/.well-known/workflow/v1/flow`.** A Traefik `Host(...)` rule (no PathPrefix) forwards all paths and satisfies this automatically; a path-restricted proxy stalls runs forever.
- **Route auth fails closed:** author `agent/channels/eve.ts`; `localDev()` admits loopback only (so local curl + container healthcheck work), `httpBasic()` gates the public host. `/eve/v1/health` is always public.
- **Sandbox:** pin `justbash()` (`agent/sandbox/sandbox.ts`) so the container needs no Docker daemon; `defaultBackend()` would try Docker first off-Vercel. Set `allowBuilds` false for just-bash's optional native deps (`@mongodb-js/zstd`, `node-liblzma`) in `pnpm-workspace.yaml`.
- HTTP turn flow: `POST /eve/v1/session {message}` → `{sessionId, continuationToken}`; stream NDJSON at `GET /eve/v1/session/:id/stream`; follow up with `POST /eve/v1/session/:id {continuationToken, message}`.
