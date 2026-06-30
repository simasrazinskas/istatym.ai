# Eve Self-Hosting Spike (D17: fully self-hosted)

Decision-critical spike: can the Vercel **eve** agent framework run fully self-hosted, off-Vercel, on our own EU Linux VM alongside Postgres and a self-hosted embedding service?

This document is grounded entirely in the vendored eve docs (`docs/reference/eve/docs/`) and the cloned eve source (eve `0.17.1`).
Every claim cites a file path and quotes the relevant text.

## VERDICT

**FULLY self-hostable.**
Eve runs as a plain Node process (`eve build && eve start`) on our own host, durability persists to local disk by default or to our own Postgres via a pluggable Workflow world, the sandbox runs locally (Docker) or can be reduced to the dependency-free `just-bash` backend, and the model can call Anthropic and our embedding service directly without the Vercel AI Gateway.
Every Vercel-specific capability is classified below as a NONE/optional convenience or a SOFT dependency with a documented self-hosted alternative; **none are HARD**.
The only material caveats are maturity (eve is `0.x` beta; the Postgres world is `experimental.workflow.world`) and operational ownership of the substrate we self-host.

## What eve actually is

`packages/eve/package.json` line 3 describes eve as a "Filesystem-first framework for durable backend AI agents that run anywhere."
(The monorepo root `package.json` still says "on Vercel", but the published package and the runtime support running anywhere.)
The HTTP host is **Nitro**, not a Vercel-only server.
`docs/reference/eve/docs/guides/deployment.md` line 20: "Nitro is the HTTP host layer.
It gives eve a build artifact that can serve the health, session, stream, channel, callback, and schedule routes outside the dev server.
Workflow execution and sandbox execution are separate runtime adapters; they are not hidden Vercel dependencies inside Nitro."

## Per-Vercel-service dependency table

| Vercel capability | Classification | Evidence |
| --- | --- | --- |
| **Runtime host** (where the agent process runs) | **NONE/optional** | `deployment.md` §8 "Deploy without Vercel": "eve can also run as a normal Node service behind your own process manager, container platform, or reverse proxy" via `eve build` + `PORT=3000 eve start --host 0.0.0.0`, writing "the standard Nitro output under `.output/`". |
| **Durable Workflows** (session durability) | **SOFT** | `concepts/execution-model-and-durability.md` line 16-18: each turn "runs as a durable workflow, built on the open-source [Workflow SDK](https://workflow-sdk.dev/) (Vercel Workflow when you deploy on Vercel)"; "The Workflow SDK is not inherently tied to Vercel… eve uses the SDK's local world by default; that world persists workflow runs on disk, normally under `.workflow-data`". Postgres world selectable (see Q1). Bundled `@workflow/world-local` (eve `package.json` devDeps). |
| **Sandbox** (per-agent isolated compute) | **SOFT** (and bypassable for our use case) | `sandbox.mdx` line 123: `defaultBackend()` "picks the best available: Vercel Sandbox on hosted Vercel → Docker → microsandbox → just-bash." Off-Vercel it never selects Vercel Sandbox. Our retrieval agent does not need real code execution (see Q3b). |
| **AI Gateway** (model routing) | **NONE/optional** | `deployment.md` §3: a string model id is gateway-routed, but "To avoid the Gateway entirely, install the [AI SDK package]… pass that provider's model object… the model call goes directly to Anthropic and the runtime reads `ANTHROPIC_API_KEY`." |
| **State / persistence store** (`defineState`, session state) | **SOFT** (folds into Workflow world) | `guides/state.md` line 6: `defineState` values "survive workflow step boundaries, so they outlast crashes, redeploys, and days-long sessions" — i.e. persisted by the Workflow world, not a separate Vercel store. Local world → `.workflow-data` on disk; Postgres world → our Postgres. |
| **Blob / KV / Vercel Postgres** | **NONE** | No imports of `@vercel/blob`, `@vercel/kv`, or `@vercel/postgres` anywhere in `packages/eve/src` (grep returned zero hits). Eve does not depend on Vercel storage primitives. |
| **Channels / webhooks** (Slack, Telegram, Twilio, etc.) | **NONE/optional** | Channels are authored HTTP routes served by Nitro under `/eve/`; `deployment.md` line 152: "channels, tools, and subagents use the same routes under `/eve/`". They reach any external API directly; none require Vercel. Optional connection brokering uses `@vercel/connect` only if you author connections (see Open Questions). |
| **Schedules** (cron) | **SOFT** | `deployment.md` line 149: "the default `eve build && eve start` path starts Nitro's schedule runner, and Vercel wires schedules to Vercel Cron automatically." Self-host runs Nitro's own scheduler; Vercel Cron is a convenience. |
| **Observability / Agent Runs dashboard** | **NONE/optional** | `guides/instrumentation.md` line 141: the Agent Runs tab is a Vercel-dashboard convenience; "Agent Runs is separate from the OpenTelemetry export." `deployment.md` line 190: OTel exporters (Braintrust, Datadog, etc.) "are the recommended path" and work off-Vercel. |
| **Auth** (`vercelOidc()`) | **NONE/optional** | `deployment.md` line 118: "If you self-deploy outside Vercel, do not rely on `vercelOidc()`… Use your own route policy, such as Basic auth, JWT/OIDC verification… or a custom verifier." Helpers `httpBasic()`, `jwtHmac()`, `jwtEcdsa()`, `oidc()` ship in-box (line 116). |

No row is HARD.
The SOFT rows are substrates we already plan to run (Postgres) or trivially provide (disk, Docker), not net-new Vercel-only services.

## The five decisive questions

### Q1. Durability substrate — Vercel Workflows specifically, or pluggable? Can it use our Postgres?

**Pluggable, and yes to our own Postgres.**
Durability is provided by the open-source Workflow SDK, not by Vercel Workflow specifically.
`concepts/execution-model-and-durability.md` line 18: "In local development and in a self-deployed `eve start` process, eve uses the SDK's local world by default; that world persists workflow runs on disk, normally under `.workflow-data`, and dispatches through the same Nitro-hosted workflow routes.
On Vercel, the same workflow code runs against Vercel Workflow instead, which adds platform features such as latest production deployment routing and dashboard run metadata."
Line 22: "Nitro… does not supply the workflow state store… Those are separate adapters: Workflow uses the active world implementation."

The world is selectable in the root `agent.ts` (`execution-model-and-durability.md` lines 24-39):

```ts
export default defineAgent({
  model: "anthropic/claude-opus-4.8",
  experimental: { workflow: { world: "@workflow/world-postgres" } },
});
```

`deployment.md` line 143 gives the install command and the pinning rule: "install a world package built against the same `@workflow/*` line as your eve release (currently the `5.0.0-beta` line)… pin the version explicitly, for example `pnpm add @workflow/world-postgres@5.0.0-beta.x`.
A mismatched world… fails with a `ZodError: invalid_union` during run replay."

Source confirms the mechanism: `packages/eve/src/internal/workflow/configure-world.ts` loads the configured world module, accepts a `default` or `createWorld()` factory (lines 84-100), boot-checks `@workflow/*` line compatibility (lines 46-71), then `setWorld(world)` and `world.start()`.
Eve bundles `@workflow/world-local` `5.0.0-beta.22` (eve `package.json` devDeps) as the default disk-backed world.

So our two viable substrates are: (a) the bundled local world writing `.workflow-data` on a persistent volume, or (b) `@workflow/world-postgres` pointed at our own Postgres — the cleaner production choice since we already run Postgres.

### Q2. Runtime host — plain Node/Docker we control, or Vercel-platform required?

**Plain Node process we control.**
`deployment.md` §8 (lines 130-152): `eve build && PORT=3000 eve start --host 0.0.0.0` "serves that built app… Put TLS, routing, autoscaling, and log collection around that process the same way you would for any other Node HTTP service."
The harness is not Vercel-managed; it is eve's own runtime layer hosted by Nitro.
`reference/cli.md` confirms `eve build` ("build the host output") and `eve start` ("Serve the built `.output/` app") as first-class self-host commands.

**One critical reverse-proxy requirement** (`deployment.md` line 144): "forward **both** `/eve/` and `/.well-known/workflow/`.
The workflow world delivers run callbacks to `/.well-known/workflow/v1/flow`; a proxy restricted to `/eve/` lets sessions start but silently stalls runs forever, because the callbacks never reach eve."
Our Traefik config must route both prefixes to the eve process.

### Q3. Per-service classification

See the table above.
Summary: Runtime host, AI Gateway, Blob/KV/Postgres, Channels, Observability dashboard, and `vercelOidc` auth are NONE/optional.
Durable Workflows, Sandbox, State, and Schedules are SOFT — each has a documented, in-box self-hosted path that runs on substrates we control.
There are no HARD dependencies.

### Q3b. Sandbox specifically — Vercel Sandbox only, or local? Is it even needed for us?

**Runs locally, and is effectively unnecessary for our retrieval use case.**
`sandbox.mdx` lines 117-123 list four backends: `vercel()` (hosted), `docker()` (local container), `microsandbox()` (local VM), `justbash()` ("pure-JS `just-bash` interpreter (no daemon or VM, but no real binaries either)").
`deployment.md` line 98: "For a self-deployed process, leave `defaultBackend()` in place or choose an explicit non-Vercel backend such as Docker or microsandbox… Do not pin `vercel()` unless that process should create hosted Vercel sandboxes."
Off-Vercel, `defaultBackend()` never resolves to Vercel Sandbox (`sandbox.mdx` line 129: Vercel only "when `process.env.VERCEL` is set").

For istatym.ai the agent's job is to call a Postgres retrieval tool, not run arbitrary shell.
Authored tools run in the **app runtime**, not the sandbox — `sandbox.mdx` line 230: "authored tools run in the app runtime (full `process.env`); only sandbox tools run in the sandbox."
So our retrieval tool (a `defineTool` that queries Postgres and calls the embedding service) never touches the sandbox.
The sandbox still technically exists ("Every eve agent has exactly one", `sandbox.mdx` line 6) and backs the default `bash`/`read_file` tools, but we can pin `docker({ image: "ghcr.io/vercel/eve:latest" })` on our VM, or pin the dependency-free `justbash()` backend if we also drop the built-in shell tools, eliminating even the Docker daemon dependency.

### Q4. Models — direct Anthropic + self-hosted BGE-M3, no AI Gateway?

**Yes, both, with no Gateway.**
`deployment.md` §3 (lines 66-81): install `@ai-sdk/anthropic`, pass a provider model object, set the provider key:

```ts
import { anthropic } from "@ai-sdk/anthropic";
export default defineAgent({ model: anthropic("claude-opus-4-8") });
```

"With that shape, the model call goes directly to Anthropic and the runtime reads `ANTHROPIC_API_KEY`…
This is the usual choice when self-deploying without any Vercel-managed services."
The model is resolved from the `model` field of `defineAgent`: a dotted **string** id (`"anthropic/claude-opus-4.8"`) is Gateway-routed; a provider **object** (`anthropic("claude-opus-4-8")`) is direct.
This is exactly the zero-retention direct-Anthropic arrangement D17 wants.

The AI SDK provider object supports a custom `baseURL`, so a self-hosted or proxied Claude endpoint is configurable through the provider, not eve.

**Embeddings are entirely our concern, not eve's.**
Eve does no embedding itself — a source-wide grep for `embed` in `packages/eve/src` finds only unrelated uses ("embedded in the prompt", string interpolation); there is no embedding model, vector store, or Vercel embedding dependency.
Our self-hosted BGE-M3 service is called from our own retrieval `defineTool` (and/or directly by our ingest pipeline), so it sits completely outside eve's model-routing path and needs no Gateway.
Confirm: the only model eve routes is the chat/agent LLM (Claude); embeddings flow through our tool code using the AI SDK or a plain HTTP client of our choosing.

### Q5. Beta maturity caveats

- Eve is `0.17.1` — a `0.x` framework; APIs and defaults can change between minor versions.
- The Postgres/custom Workflow world is gated behind `experimental.workflow.world` (`execution-model-and-durability.md` line 24: "For advanced self-hosted deployments"; `deployment.md` line 24 calls custom worlds "Advanced self-hosted deployments").
- Strict version coupling: a self-hosted world package must match eve's bundled `@workflow/*` line (`5.0.0-beta`) exactly, and "The npm `latest` tag may lag, so pin the version explicitly" (`deployment.md` line 143); a mismatch fails at run replay with `ZodError: invalid_union`.
- The whole Workflow SDK line is itself `5.0.0-beta.*` (eve `package.json`: `@workflow/core@5.0.0-beta.26`, `@workflow/world-local@5.0.0-beta.22`), so the durable substrate is pre-1.0.
- `microsandbox` and `just-bash` are optional peer deps that `eve dev` auto-installs but that "production processes fail with actionable install errors instead" if missing (`sandbox.mdx` lines 154, 158) — i.e. we must explicitly provision the chosen sandbox backend for production.
- Self-hosting is documented and first-class (`deployment.md` §8), but Vercel-managed conveniences (Agent Runs dashboard, Vercel Cron, Sandbox prewarm, deployment-protection bypass) are explicitly "Vercel-only conveniences" (`deployment.md` line 150) we forgo.

## Recommendation for D17

**D17 (full self-host) holds with eve.**
There is no hard Vercel lock-in: the runtime is a Nitro Node server we run on our VM behind Traefik, durability persists to our own Postgres via `@workflow/world-postgres` (or to a persistent disk volume via the bundled local world), the LLM calls Anthropic directly via `@ai-sdk/anthropic`, and embeddings never enter eve's path at all.

Recommended self-host configuration:

1. **Runtime:** `eve build && eve start` in a container on the EU VM; Traefik forwards **both** `/eve/` and `/.well-known/workflow/` to it (non-negotiable — see Q2).
2. **Durability:** select `experimental.workflow.world: "@workflow/world-postgres"`, pinned to the exact `5.0.0-beta.x` matching our eve release, pointed at our own Postgres.
   Fallback for the first iteration: the bundled local world on a persistent volume, to de-risk the experimental world before committing.
3. **Model:** `model: anthropic("claude-opus-4-8")` with `ANTHROPIC_API_KEY` (zero-retention arrangement); set a custom `baseURL` if we front Claude through our own proxy.
4. **Embeddings:** called from our retrieval `defineTool` (app runtime, full `process.env`) against the self-hosted BGE-M3 service — no eve involvement.
5. **Sandbox:** pin `docker({ image: "ghcr.io/vercel/eve:latest" })`, or drop the built-in shell tools and pin `justbash()` to avoid even a Docker daemon, since our agent only needs the Postgres retrieval tool.
6. **Auth:** replace `vercelOidc()`/`placeholderAuth()` with `httpBasic()`, JWT/OIDC, or a custom `AuthFn`.
7. **Observability:** wire OTel export in `instrumentation.ts` to our own backend; skip the Vercel Agent Runs dashboard.

This is preferable to **(a)** running eve-on-Vercel as a hosted island, which would put EU-resident conversation/session state on Vercel's platform and undercut the data-residency rationale behind D17.
It is also preferable to **(b)** switching frameworks: eve's self-host path is documented, in-box, and matches our stack (Postgres + direct Anthropic + a single retrieval tool) closely, so the integration cost is low relative to re-platforming onto a different agent framework.
The price we accept is operating the durable substrate ourselves (Postgres-backed Workflow world plus the version-pinning discipline) and tracking a `0.x`/`beta` dependency line.

## Open questions (and how to resolve them)

1. **Does `@workflow/world-postgres` exist and ship on the `5.0.0-beta` line today? — RESOLVED (npm, 2026-06-30).**
   Yes: `npm view @workflow/world-postgres` shows `latest 4.2.0`, `beta 5.0.0-beta.20`, so a `5.0.0-beta` line is published.
   However there is a beta-increment skew: eve `0.17.1` pins `@workflow/core@5.0.0-beta.26`, `@workflow/world@5.0.0-beta.14`, and bundles `@workflow/world-local@5.0.0-beta.22`, while the Postgres world's newest beta is `.20`.
   These `@workflow/*` packages are versioned independently, so `.20` may still be peer-compatible, but exact compatibility must be confirmed by an actual install against eve `0.17.1` before relying on it.
   **Not a blocker:** the bundled `@workflow/world-local` (local-disk durability) is guaranteed-compatible and is sufficient for a single self-hosted VM with a persistent volume; the Postgres world is an upgrade (shared/multi-instance durability), to be adopted once peer-compat is verified or once a matching beta lands.
2. **Local-world durability semantics on a single VM under restart/redeploy.**
   The local world persists to `.workflow-data` on disk; we should verify a mid-turn crash resumes correctly on our volume (the doc promises step-level resume, `execution-model-and-durability.md` lines 42-45).
   Resolve: a small runtime experiment — start a session, kill the process mid-turn, restart, confirm the turn resumes from the last completed step. (Spike only; do not run as part of this doc task.)
3. **Postgres world operational characteristics** (schema it creates, migrations, connection pooling, multi-instance/HA behavior, EU residency of any callback URLs).
   Resolve: read the `@workflow/world-postgres` README/source once obtained; run it against a scratch Postgres and inspect the tables and the `/.well-known/workflow/v1/flow` callback flow.
4. **Connections (`@vercel/connect`) — needed at all?**
   If we use any eve "connection" (OAuth/MCP credential brokering), the scaffold imports `@vercel/connect`/`@vercel/connect/eve` (seen in `packages/eve/src/setup/scaffold/...`).
   For our use case (one Postgres retrieval tool) we author a plain `defineTool` and use no connections, so this dependency should not arise — confirm during implementation that no connection is scaffolded.
5. **Scheduler parity** if we ever adapt the Nitro output to a custom host: `deployment.md` line 149 warns a custom HTTP-only host must still run Nitro scheduled tasks or trigger the work from our own scheduler.
   For the standard `eve start` path this is automatic; only relevant if we customize the host preset.
