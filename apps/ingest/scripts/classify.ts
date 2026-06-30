/**
 * Classify every work as base | amendment | non_normative (decision D4).
 *
 *   DATABASE_URL=postgres://... pnpm ingest:classify
 *   DATABASE_URL=... ANTHROPIC_API_KEY=... pnpm ingest:classify --llm [--llm-limit 200]
 *
 * The heuristic pass is standalone and always runs. The optional `--llm` pass
 * refines only the ambiguous middle (works that fell through to the weak default)
 * with Claude Haiku, and only when ANTHROPIC_API_KEY is set — it is cheap and
 * fully optional. The canonical corpus is the set of `base` works.
 */
import { z } from 'zod';
import { getPool, endPool, withTransaction } from '../src/db';
import { classifyAllWorks, storeClassification, type AmbiguousWork } from '../src/load';
import type { Classification } from '../src/classify';

interface Args {
  llm: boolean;
  llmLimit: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { llm: false, llmLimit: 200 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--llm') args.llm = true;
    else if (argv[i] === '--llm-limit') args.llmLimit = Number(argv[(i += 1)]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

const llmSchema = z.object({
  classification: z.enum(['base', 'amendment', 'non_normative']),
  reason: z.string(),
});

/** Lazy-import the AI SDK so the heuristic path never needs the dependency loaded. */
async function refineWithLlm(work: AmbiguousWork): Promise<{ classification: Classification; reason: string }> {
  const { anthropic } = await import('@ai-sdk/anthropic');
  const { generateObject } = await import('ai');
  const result = await generateObject({
    model: anthropic('claude-haiku-4-5'),
    schema: llmSchema,
    system: [
      'You classify Lithuanian legal acts for a legal-RAG corpus.',
      'base = a standalone normative act (a law, code, regulation establishing rules).',
      'amendment = an act whose sole purpose is to change/repeal another act.',
      'non_normative = court rulings, notices, informational publications.',
      'Answer from the title and act type. When unsure, prefer base.',
    ].join('\n'),
    prompt: `Act type (rusis): ${work.act_type ?? 'unknown'}\nTitle (pavadinimas): ${work.title}`,
  });
  return result.object;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { counts, ambiguous } = await withTransaction((client) => classifyAllWorks(client));
  console.log('Heuristic classification:');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
  console.log(`  ambiguous (LLM candidates): ${ambiguous.length}`);

  if (args.llm) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('Skipping LLM pass: ANTHROPIC_API_KEY not set.');
    } else {
      const targets = ambiguous.slice(0, args.llmLimit);
      console.log(`Refining ${targets.length} ambiguous work(s) with Claude Haiku...`);
      const client = await getPool().connect();
      let refined = 0;
      try {
        for (const work of targets) {
          try {
            const out = await refineWithLlm(work);
            await storeClassification(client, work.id, out.classification, `LLM: ${out.reason}`);
            refined += 1;
          } catch (err) {
            console.error(`  LLM failed for ${work.tar_kodas}:`, err instanceof Error ? err.message : err);
          }
        }
      } finally {
        client.release();
      }
      console.log(`Refined ${refined} work(s).`);
    }
  }

  await endPool();
}

main().catch(async (err) => {
  console.error(err);
  await endPool();
  process.exit(1);
});
