# istatym.ai legal-RAG agent: eve architecture and design guide

This guide explains how to build our agentic legal-RAG agent on the Vercel **eve** framework (v0.17.1 beta).
Every claim is grounded in the vendored eve docs under `docs/reference/eve/docs/`; doc paths are cited inline.
The four required behaviors are: (1) fact-gated, law-driven clarification, (2) a bounded agentic retrieval loop with escalation, (3) an exact-reference navigation tool, and (4) ground-by-construction citations.

## 1. How eve shapes the design

eve is filesystem-first: a file's location is its identity, and there is no central registry to keep in sync (`docs/reference/eve/docs/introduction.mdx`, `docs/reference/eve/docs/reference/project-layout.md`).
A tool at `agent/tools/hybrid_search.ts` is exposed to the model as `hybrid_search`; identity comes from the path, never a `name` field (`docs/reference/eve/docs/reference/typescript-api.md`).
Every session is a durable workflow: work nests as session -> turn -> step, each step is a durable checkpoint, and a turn can park durably and resume later without losing context (`docs/reference/eve/docs/concepts/execution-model-and-durability.md`).
This durability is the backbone of our clarification behavior: a turn can stop, wait for the user's next message for seconds or days, and pick up exactly where it parked.

Three context levers decide what the model sees and when (`docs/reference/eve/docs/concepts/context-control.md`):

- `instructions.md` / `instructions/` is always-on; use it for standing rules.
- `skills/` load on demand via the framework `load_skill` tool; use them for optional procedures.
- `tools/` are typed actions the model calls; the only place real executable behavior lives.

Our standing rules (retrieve-first, clarify-only-when-the-law-branches, ground-by-construction) are permanent identity, so they belong in instructions, not skills (`docs/reference/eve/docs/instructions.mdx`).

## 2. Proposed `agent/` project layout

This maps directly onto eve's documented slot table (`docs/reference/eve/docs/reference/project-layout.md`).

```text
istatym-agent/
├── package.json
├── tsconfig.json
├── agent/
│   ├── agent.ts                          # defineAgent: model, reasoning, compaction
│   ├── instructions.md                   # identity + the four standing rules (short, stable)
│   ├── instructions/                     # always-on rule packs, composed alphabetically
│   │   ├── 10-clarification.md           # fact-gated, law-driven clarification rule
│   │   ├── 20-retrieval-loop.md          # escalation + budget rule
│   │   ├── 30-grounding.md               # ground-by-construction / citation discipline
│   │   └── 40-jurisdiction.ts            # defineDynamic: per-tenant jurisdiction/law-version
│   ├── lib/                              # import-only shared code (never mounted to workspace)
│   │   ├── retrieval.ts                   # hybrid search client (vector + lexical)
│   │   ├── statute-store.ts              # exact-article fetch by citation/ID
│   │   ├── budget.ts                      # defineState retrieval budget
│   │   ├── grounding.ts                   # substring verification helpers
│   │   └── answer-schema.ts              # zod schema for {answer, citations[]}
│   ├── tools/
│   │   ├── hybrid_search.ts              # single-shot hybrid retrieval (behavior 2, default)
│   │   ├── get_article.ts               # exact-reference navigation by citation (behavior 3)
│   │   ├── grade_grounding.ts           # groundedness grader -> escalation signal (behavior 2)
│   │   ├── verify_quote.ts              # quote ⊂ source substring check (behavior 4)
│   │   ├── web_fetch.ts                 # disableTool() — lock down arbitrary web
│   │   ├── web_search.ts                # disableTool() — corpus-only grounding
│   │   └── bash.ts                       # disableTool() — no shell needed
│   ├── hooks/
│   │   └── reset-budget.ts              # turn.started: reset per-turn retrieval budget
│   ├── skills/
│   │   └── jurisdictions/lt-darbo-kodeksas/SKILL.md   # optional jurisdiction playbook
│   └── channels/
│       └── eve.ts                        # built-in HTTP channel (always shipped)
└── evals/
    ├── evals.config.ts
    ├── clarification/tenure-branch.eval.ts
    └── grounding/quote-substring.eval.ts
```

Notes on the layout.

`ask_question` is deliberately **not** authored: it is a built-in default-harness tool and exists without us defining anything (`docs/reference/eve/docs/concepts/default-harness.md`, `docs/reference/eve/docs/tools/human-in-the-loop.md`).
We disable `bash`, `web_fetch`, and `web_search` by exporting `disableTool()` from files named after each slug, because uncontrolled web access would undermine ground-by-construction (`docs/reference/eve/docs/concepts/default-harness.md`, "Disable a default").
We keep no sandbox seed: retrieval is done through typed tools that run in the app runtime with full `process.env`, not in the sandbox (`docs/reference/eve/docs/tools/overview.mdx`).

`agent/agent.ts`:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-4.8",
  reasoning: "high",
  compaction: { thresholdPercent: 0.75 },
});
```

`model` is required when `agent.ts` is present, `reasoning` is the provider-agnostic effort lever, and `compaction.thresholdPercent` tunes when older turns are summarized (`docs/reference/eve/docs/agent-config.md`).
Compaction matters for us: long advisory sessions can summarize away earlier tool output, so we re-fetch verbatim text right before composing the answer rather than trusting old context (see behavior 4 and the open questions).

## 3. Behavior 1 — fact-gated, law-driven clarification

### The required behavior

Retrieve first.
Ask the user a clarifying question only when the *retrieved* controlling provision branches on a fact the user has not supplied (e.g., notice period depends on tenure or on a protected-employee category).
Questions are generated from the retrieved law, never from a hardcoded intake form.
If the user declines or goes silent, fall back to answering with all branches stated ("if X then ...; if Y then ...").

### The exact eve primitive

The primitive is the built-in **`ask_question`** tool, which is part of the default harness and rides eve's human-in-the-loop pause/resume protocol (`docs/reference/eve/docs/tools/human-in-the-loop.md`, section "Questions"; `docs/reference/eve/docs/concepts/default-harness.md`).
It has no `execute`; the model calls it with `{ prompt, options?, allowFreeform? }`, and eve parks the turn (`docs/reference/eve/docs/tools/human-in-the-loop.md`):

> The built-in `ask_question` tool lets the model pause and ask the user, rather than guessing. ... It produces the same `input.requested` pause as an approval, and resumes the same way.

Mechanically (`docs/reference/eve/docs/tools/human-in-the-loop.md`, "How pause and resume works"):

1. The model requests input (here, an `ask_question`).
2. eve emits an `input.requested` stream event carrying the pending request.
3. The turn parks at `session.waiting`, durably, for as long as it takes.
4. The client answers with `inputResponses` (keyed by `requestId`) or a normal follow-up `message`; a follow-up whose text matches an option ID, label, or numeric index resolves automatically.

Because the pause is durable, nothing is held in memory while it waits, and the run "picks back up exactly where it parked" (`docs/reference/eve/docs/tools/human-in-the-loop.md`).
That is the "pause and wait for the user's next message, then resume with full context" behavior: it is the **durable session parking for input via the HITL question protocol**, surfaced through the `ask_question` tool — not a plain assistant turn and not approval tooling.

### `ask_question` (clarification) vs `approval` / `needsApproval` (authorization)

These are two different things and must not be confused (`docs/reference/eve/docs/tools/human-in-the-loop.md`, intro):

- **Questions** — the agent asks the *user* a clarifying question mid-turn and parks until they answer. The agent wants information. This is `ask_question`.
- **Approvals** — a *tool* requires a person to sign off before (or instead of) running; "the agent decides to call the tool; a human decides whether it does." This is the per-tool `approval` field with the helpers `always()` / `once()` / `never()` (or an input-dependent policy) from `eve/tools/approval`.

Note on naming: AI SDK uses the per-tool term `needsApproval`; eve exposes this as the `approval` field on `defineTool` (`docs/reference/eve/docs/tools/overview.mdx`, "Gate a tool on human approval").
For our clarification behavior the correct primitive is **`ask_question`**, not `approval`.
Approval gates a side-effecting tool call (refunds, writes); we have no side effect to authorize when we simply need a missing fact from the user.
Both protocols emit the same `input.requested` event and park at `session.waiting` (`docs/reference/eve/docs/concepts/sessions-runs-and-streaming.md`, event table), but the semantics differ: clarification asks the user for input, approval asks a human to authorize the agent.

### Why not a plain assistant turn?

The agent *could* instead just emit "What is your tenure?" as a final assistant message, end the turn, park at `session.waiting`, and let the next user message start a fresh turn.
That is also durable, because session history is append-only and survives restarts (`docs/reference/eve/docs/concepts/execution-model-and-durability.md`).
We prefer `ask_question` because it keeps the retrieved-law context inside the same turn's working set and resumes that same turn, it renders as native buttons / a select menu in every channel, and it carries a structured `requestId` the client answers deterministically (`docs/reference/eve/docs/tools/human-in-the-loop.md`, "Answering from a client or channel").

### Encoding the rule

The rule is standing behavior, so it lives in always-on instructions (`docs/reference/eve/docs/instructions.mdx`, "Instructions vs skills").
`agent/instructions/10-clarification.md` (sketch):

```md
Always retrieve the controlling provision before answering.
Call ask_question ONLY when a provision you just retrieved branches on a fact the
user has not supplied. Generate the question and its options from the retrieved
text — quote the branch points; never use a fixed intake form.
Always offer a freeform answer and an explicit "Prefer not to say / cover all cases" option.
If the user declines, goes silent, or picks "cover all cases", do NOT ask again:
answer with every branch stated ("if tenure < 1 year then ...; if >= 1 year then ...").
```

The decline/silent fallback is implemented by instruction plus the "cover all cases" option on `ask_question`; if the user resolves with that option (or any unrelated follow-up that does not answer), the model resumes and states all branches.

## 4. Behavior 2 — bounded agentic retrieval loop with escalation control

### The required behavior

Single-shot hybrid retrieval by default; escalate to an iterative retrieve -> grade -> reformulate loop only when a groundedness grader flags low confidence; bound the whole thing with a retrieval budget.

### Primitives

- `hybrid_search` tool — one `defineTool` that runs vector + lexical retrieval against our corpus and returns ranked chunks with source metadata (`docs/reference/eve/docs/tools/overview.mdx`). Default path is exactly one call.
- `grade_grounding` tool — a `defineTool` whose `outputSchema` returns `{ grounded: boolean, confidence: number, missingFacts: string[] }`; the model calls it after retrieval. When `grounded` is false / `confidence` low, the standing instructions tell the model to reformulate and search again.
- Retrieval budget — `defineState` from `eve/context`, the documented pattern for a durable per-session counter with a cap (`docs/reference/eve/docs/guides/state.md`, the budget example). The `hybrid_search` executor reads the budget, throws when the cap is hit, and increments it, which bounds the loop in code rather than trusting the prompt.

`agent/lib/budget.ts` mirrors the doc's budget pattern:

```ts title="agent/lib/budget.ts"
import { defineState } from "eve/context";

export const retrievalBudget = defineState("istatym.retrieval", () => ({ count: 0, cap: 6 }));
```

`agent/tools/hybrid_search.ts`:

```ts title="agent/tools/hybrid_search.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { retrievalBudget } from "../lib/budget.js";
import { hybridRetrieve } from "../lib/retrieval.js";

export default defineTool({
  description: "Hybrid (vector + lexical) search over the controlling legal corpus.",
  inputSchema: z.object({ query: z.string().min(1), jurisdiction: z.string() }),
  async execute({ query, jurisdiction }) {
    const { count, cap } = retrievalBudget.get();
    if (count >= cap) throw new Error("Retrieval budget exhausted for this turn.");
    retrievalBudget.update((s) => ({ ...s, count: s.count + 1 }));
    return hybridRetrieve({ query, jurisdiction });
  },
});
```

Because state is durable and does not reset between turns by default, we reset the budget per turn with a `turn.started` hook, exactly as documented (`docs/reference/eve/docs/guides/state.md`, "Reset state between turns"):

```ts title="agent/hooks/reset-budget.ts"
import { defineHook } from "eve/hooks";
import { retrievalBudget } from "../lib/budget.js";

export default defineHook({
  events: {
    async "turn.started"() {
      retrievalBudget.update(() => ({ count: 0, cap: 6 }));
    },
  },
});
```

### Where the grader can live

Option A (recommended for simplicity): `grade_grounding` is an ordinary tool, and the loop is driven by the model under the standing rule in `agent/instructions/20-retrieval-loop.md`.
Option B: a declared subagent `agent/subagents/grounding-grader/` with its own narrow prompt, run in task mode via an `outputSchema` so it returns a structured grade (`docs/reference/eve/docs/subagents.mdx`, "What the parent sees").
Caution for Option B: a declared subagent inherits nothing from the root and starts with fresh state, and `defineState` never crosses the parent/child boundary (`docs/reference/eve/docs/subagents.mdx`, "The isolation boundary"; `docs/reference/eve/docs/guides/state.md`, "State is never shared with subagents").
So the retrieval budget must stay in the root agent's tools; we cannot push budget accounting into a subagent.
Start with Option A; reach for a subagent only if grading needs a genuinely different prompt and tool surface (`docs/reference/eve/docs/subagents.mdx`, "When to split").

## 5. Behavior 3 — exact-reference navigation tool

### The required behavior

Deterministically fetch a specific statute article by its citation/ID (e.g., "57 straipsnio 1 dalies 4 punktas") to follow cross-references — distinct from semantic search.

### Primitive

A plain `defineTool`, `get_article`, that parses a structured citation and does a deterministic lookup in `statute-store.ts` (no embeddings, no ranking).
Tools run in the app runtime with full `process.env`, so this is a direct database/index read (`docs/reference/eve/docs/tools/overview.mdx`).

```ts title="agent/tools/get_article.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { fetchArticle } from "../lib/statute-store.js";

export default defineTool({
  description:
    "Fetch the exact text of one statute provision by citation (act, article, " +
    "part/dalis, point/punktas) to follow a cross-reference. Deterministic; not a search.",
  inputSchema: z.object({
    actId: z.string(),          // e.g. "LT-DK" (Darbo kodeksas)
    article: z.string(),        // e.g. "57"
    part: z.string().optional(),   // dalis, e.g. "1"
    point: z.string().optional(),  // punktas, e.g. "4"
    asOf: z.string().optional(),   // validity date for point-in-time law
  }),
  outputSchema: z.object({
    actId: z.string(),
    article: z.string(),
    validityWindow: z.string(),
    text: z.string(),
  }),
  async execute(input) {
    return fetchArticle(input);
  },
});
```

The `outputSchema` types the return and gives the model a stable contract (`docs/reference/eve/docs/tools/overview.mdx`).
The returned `text` is the verbatim source the model later copies quotes from, which is what makes behavior 4 ground-by-construction.

## 6. Behavior 4 — ground-by-construction citations

### The required behavior

The agent copies evidence verbatim, verifies each quote is a substring of the source before reasoning, and emits a structured answer `{ answer, citations: [{ actId, article, validityWindow, quote }] }`.

### What structured output enforces, and what it does not

eve/AI SDK structured output enforces the **shape** of the answer, not the truth of the quotes.
For an interactive chat turn the client supplies a per-turn `outputSchema`; the runtime "makes the model satisfy the schema before the turn settles, then emits the final payload as `result.completed`" (`docs/reference/eve/docs/guides/client/output-schema.mdx`).
Note the scoping rule: an agent/subagent-level `outputSchema` in `defineAgent` is for task-mode runs, and "Interactive conversation turns ignore it unless the client supplies a per-message schema" (`docs/reference/eve/docs/agent-config.md`, `outputSchema` row).
So our Next.js proxy / `useEveAgent` client sends each legal-question turn with the answer schema attached, and reads the structured result off `result.completed` (`docs/reference/eve/docs/concepts/sessions-runs-and-streaming.md`, event table: "the finalized structured result for a turn that requested an output schema; carries `result`").

`agent/lib/answer-schema.ts`:

```ts title="agent/lib/answer-schema.ts"
import { z } from "zod";

export const answerSchema = z.object({
  answer: z.string(),
  citations: z.array(
    z.object({
      actId: z.string(),
      article: z.string(),
      validityWindow: z.string(),
      quote: z.string(),
    }),
  ),
});
```

Client side (`docs/reference/eve/docs/guides/client/output-schema.mdx`):

```ts
const response = await session.send({ message: userQuestion, outputSchema: answerSchema });
const { data } = await response.result(); // { answer, citations: [...] }
```

### Making the quotes true-by-construction

The schema cannot guarantee a `quote` is real, so substring truth is enforced in code, not by the schema.
We add a `verify_quote` tool that the standing grounding rule requires the model to call for every citation before it reasons on or emits that quote:

```ts title="agent/tools/verify_quote.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { isVerbatimSubstring } from "../lib/grounding.js";

export default defineTool({
  description:
    "Verify a candidate quote is an exact substring of a retrieved source before it is cited. " +
    "Call this for every citation. A false result means the quote was paraphrased — re-copy it.",
  inputSchema: z.object({ quote: z.string(), sourceText: z.string() }),
  outputSchema: z.object({ verbatim: z.boolean() }),
  async execute({ quote, sourceText }) {
    return { verbatim: isVerbatimSubstring(quote, sourceText) };
  },
});
```

`sourceText` is the `text` returned by `get_article` or `hybrid_search`, so the check compares the quote against the exact source the citation points at.
We back the instruction with an eval gate (section 8) so a regression that emits an unverified quote fails CI.

`agent/instructions/30-grounding.md` (sketch):

```md
Copy quotes verbatim from get_article / hybrid_search output; never paraphrase a quote.
Before citing any quote, call verify_quote with that quote and its source text.
If verify_quote returns verbatim=false, re-copy the exact text and verify again; do not cite unverified text.
Right before composing the final answer, re-fetch each cited provision with get_article so the
quote and validityWindow reflect current source text, then emit {answer, citations:[...]}.
```

## 7. Worked example trace

User turn: *"How much notice for redundancy if I've worked 6 months?"*
(Illustrative Lithuanian Labour Code, Darbo kodeksas / `LT-DK`; provision numbers are illustrative.)

The user supplied tenure (6 months).
The controlling notice provision branches on tenure *and* on a protected-employee category the user did **not** mention, so that second fact triggers clarification.

Stream events (`docs/reference/eve/docs/concepts/sessions-runs-and-streaming.md`):

1. `turn.started` — the `reset-budget` hook resets the retrieval budget to `{count:0, cap:6}`.
2. `actions.requested` -> `action.result`: `hybrid_search({ query: "redundancy notice period", jurisdiction: "LT" })` returns DK art. 57 chunks: art. 57(1)(4) is the redundancy ground; art. 57(7) sets base notice by tenure; art. 57(8) cross-references increased notice for protected employees. Budget count -> 1.
3. `actions.requested` -> `action.result`: `grade_grounding(...)` returns `{ grounded: true, confidence: 0.9, missingFacts: ["protected-category status"] }`. Confidence is high, so the loop does **not** escalate; one shot was enough.
4. `actions.requested` -> `action.result`: `get_article({ actId:"LT-DK", article:"57", part:"8" })` follows the cross-reference and returns verbatim text: base notice is tripled for an employee raising a child under 14, a person with a disability, or someone within five years of pension age. Budget unaffected (`get_article` is not search).
5. The model resolves the tenure branch (6 months -> base bracket, e.g. two weeks) but detects an unsupplied branch fact: protected-category status, taken straight from art. 57(8).
6. `actions.requested`: `ask_question({ prompt: "Notice for a 6-month employee is the base period, but it is tripled for protected employees. Do any apply to you?", options: ["Raising a child under 14", "I have a disability", "Within 5 years of pension age", "None of these", "Prefer not to say / show all cases"], allowFreeform: true })`. Options are generated from the retrieved art. 57(8) text, not a fixed form.
7. `input.requested` (carries the request) -> `session.waiting`. The turn parks durably; no compute is held.
8. The user answers via the stored `continuationToken` (e.g., POST `/eve/v1/session/<id>` with `{ continuationToken, message: "None of these" }`), or with `inputResponses` keyed by `requestId`. A matching follow-up resolves automatically. The same turn resumes with all retrieved context intact.
   - Decline / silence path: if the user picks "show all cases" or replies with something unrelated, the model does not re-ask; per the standing rule it answers with every branch stated.
9. The model re-fetches each cited provision with `get_article` (guards against compaction having summarized earlier output) and calls `verify_quote` for each quote against that source text.
10. `result.completed` carries the structured payload:

```json
{
  "answer": "After 6 months you are in the base notice bracket (two weeks). Because none of the protected categories apply, the notice is not increased. If a protected category did apply, the notice would be tripled.",
  "citations": [
    { "actId": "LT-DK", "article": "57 str. 7 d.", "validityWindow": "2017-07-01–dabar", "quote": "<verbatim base-notice text>" },
    { "actId": "LT-DK", "article": "57 str. 8 d.", "validityWindow": "2017-07-01–dabar", "quote": "<verbatim tripling text>" }
  ]
}
```

11. `turn.completed` -> `session.waiting` (ready for the next question on the same durable session).

## 8. Evals

eve discovers evals under `evals/` as `.eval.ts` files driven through the same HTTP client real users hit (`docs/reference/eve/docs/evals/overview.mdx`).
Two gates protect the load-bearing behaviors:

- `evals/clarification/tenure-branch.eval.ts` — drives the redundancy question, asserts the run paused for input (`t.requireInputRequest(...)`), answers it, and checks the reply covers the branch. Use `t.send`, `t.respond`, and `t.calledTool("ask_question")` (`docs/reference/eve/docs/evals/overview.mdx`, "The `t` context").
- `evals/grounding/quote-substring.eval.ts` — requests the answer with `outputSchema`, then `t.check`s every returned `quote` is a verbatim substring of the cited source (a deterministic gate), so an unverified quote fails CI. Run `eve eval --strict` in CI.

## 9. Open questions / things to verify in eve v0.17.1 beta

These are not clearly answered by the vendored docs and should be confirmed against the running beta.

1. **Per-turn `outputSchema` across an `ask_question` pause.** `output-schema.mdx` shows `outputSchema` on a HITL *response* send (with `inputResponses`), implying the schema must be re-supplied on the resuming send. It is not stated whether a single `send({ outputSchema })` whose turn parks on `ask_question` mid-turn still applies that schema to the eventual `result.completed`, or whether the client must re-attach the schema when answering. Verify the resume contract.
2. **Can a hook veto a result?** Hooks are documented as event subscribers in a fixed dispatch order (`docs/reference/eve/docs/concepts/sessions-runs-and-streaming.md`, "Dispatch order"); there is no documented ability for a hook to reject or rewrite a `result.completed` that fails substring verification. Our substring guarantee therefore rests on the `verify_quote` tool plus an eval gate, not a runtime hook. Confirm whether a hook can hard-fail a turn.
3. **Compaction vs verbatim quotes.** Compaction resets read-before-write tracking and re-injects the todo list, but the docs do not list tool-returned source text as preserved (`docs/reference/eve/docs/concepts/default-harness.md`, "Compaction"). Long sessions could summarize away a quote's source before composition. We mitigate by re-fetching with `get_article` right before composing; verify this is sufficient and consider lowering `thresholdPercent` further.
4. **No first-class retrieval-budget primitive.** There is no documented "budget" feature; we build it from `defineState` (the documented budget example). Confirm `defineState` get/update semantics under step replay for our increment-then-search ordering, since "a step interrupted mid-execution re-runs" (`docs/reference/eve/docs/concepts/execution-model-and-durability.md`).
5. **Budget cannot live in a grading subagent.** `defineState` never crosses to subagents and subagent state is fresh (`docs/reference/eve/docs/subagents.mdx`). If we adopt a declared `grounding-grader` subagent, budget accounting must stay in root tools. Confirm there is no shared-state escape hatch.
6. **Disabling provider `web_search`.** `web_search` is provider-managed with no local executor (`docs/reference/eve/docs/concepts/default-harness.md`). Verify that `disableTool()` for `web_search` reliably removes the provider-side capability and is not silently re-enabled.
7. **Jurisdiction / law-version scoping via auth.** The multi-tenant patterns read tenant/scope from `ctx.session.auth.current.attributes` (`docs/reference/eve/docs/patterns/multi-tenant-memory.md`, `docs/reference/eve/docs/patterns/multi-tenant-approvals.md`). Confirm our channel/auth layer actually populates a `jurisdiction` (and point-in-time `asOf`) attribute so `40-jurisdiction.ts` (`defineDynamic` instructions) can resolve the correct corpus per session.
8. **`ask_question` option generation.** The model fills `prompt`/`options` freely; there is no schema constraint binding options to retrieved text. Our law-driven-options guarantee is prompt-enforced and eval-checked, not framework-enforced. Confirm this is acceptable for the compliance bar, or add a tool that returns vetted option text.
