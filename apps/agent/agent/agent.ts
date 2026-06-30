import { anthropic } from '@ai-sdk/anthropic';
import { defineAgent } from 'eve';

/**
 * Minimal self-hosted eve agent (Phase-0 runtime proof).
 *
 * Model calls go directly to Anthropic (no Vercel AI Gateway): passing a
 * provider model object makes the runtime read `ANTHROPIC_API_KEY`. Durability
 * uses the bundled local-disk workflow world (`.workflow-data`), which the
 * deployment keeps on a persistent volume — no `experimental.workflow.world`
 * override yet (the Postgres world is a later slice).
 */
export default defineAgent({
  model: anthropic('claude-haiku-4-5'),
});
