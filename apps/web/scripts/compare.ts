/**
 * FTS-only baseline vs production hybrid retrieval on a small set of paraphrased
 * (casual) Lithuanian employment queries, each with known-relevant Darbo kodeksas
 * article numbers. Reports recall@k and MRR per arm — the "measurable improvement
 * over the FTS baseline" acceptance check (issue #7).
 *
 *   DATABASE_URL=... VOYAGE_API_KEY=... pnpm compare
 *
 * Hybrid needs the Voyage key (embeddings + optional rerank); the corpus must be
 * chunked + embedded first (`apps/ingest pnpm ingest:embed`).
 */
import { hybridSearchArticles, searchArticles } from '../src/lib/retrieval';
import { getPool } from '../src/lib/db';

const K = 6;

/**
 * Paraphrased, colloquial questions (the way a worker would actually ask) mapped
 * to the article(s) that govern the topic. Casual phrasing is exactly where FTS
 * over un-lemmatized Lithuanian degrades and the dense + rerank arm should help.
 */
const GOLD: { query: string; relevant: string[] }[] = [
  { query: 'Kiek dienų kasmetinių atostogų man priklauso per metus?', relevant: ['126'] },
  { query: 'Ar darbdavys gali mane atleisti be priežasties?', relevant: ['57'] },
  { query: 'Per kiek laiko turi įspėti prieš atleidžiant iš darbo?', relevant: ['57', '64'] },
  { query: 'Kaip ilgai gali trukti bandomasis laikotarpis priimant į darbą?', relevant: ['36'] },
  { query: 'Ar man priklauso išeitinė kompensacija atleidus?', relevant: ['57'] },
  { query: 'Noriu išeiti iš darbo savo noru, ką daryti?', relevant: ['55'] },
  { query: 'Kiek valandų per savaitę galiu dirbti maksimaliai?', relevant: ['114'] },
  { query: 'Kaip apmokamos viršvalandžių valandos?', relevant: ['144', '119'] },
  { query: 'Kiek mokama už darbą naktį?', relevant: ['144', '117'] },
  { query: 'Ar nėščia darbuotoja gali būti atleista?', relevant: ['61'] },
  { query: 'Kiek trunka motinystės atostogos?', relevant: ['132'] },
  { query: 'Ką daryti jei darbdavys vėluoja sumokėti atlyginimą?', relevant: ['146'] },
];

interface Metrics {
  recallAtK: number;
  mrr: number;
  perQuery: { query: string; got: string[]; firstHitRank: number | null }[];
}

function score(
  results: { number: string }[],
  relevant: string[],
): { got: string[]; firstHitRank: number | null } {
  const got = results.map((r) => r.number);
  let firstHitRank: number | null = null;
  for (let i = 0; i < got.length; i += 1) {
    if (relevant.includes(got[i])) {
      firstHitRank = i + 1;
      break;
    }
  }
  return { got, firstHitRank };
}

async function evaluate(
  retrieve: (q: string) => Promise<{ number: string }[]>,
): Promise<Metrics> {
  const perQuery: Metrics['perQuery'] = [];
  let recallSum = 0;
  let mrrSum = 0;
  for (const { query, relevant } of GOLD) {
    const results = await retrieve(query);
    const { got, firstHitRank } = score(results, relevant);
    if (firstHitRank !== null) {
      recallSum += 1;
      mrrSum += 1 / firstHitRank;
    }
    perQuery.push({ query, got, firstHitRank });
  }
  return { recallAtK: recallSum / GOLD.length, mrr: mrrSum / GOLD.length, perQuery };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  if (!process.env.VOYAGE_API_KEY) {
    throw new Error('VOYAGE_API_KEY is not set (hybrid arm needs Voyage embeddings)');
  }

  const fts = await evaluate((q) => searchArticles(q, K));
  const hybrid = await evaluate((q) => hybridSearchArticles(q, K));

  console.log(`\nGold set: ${GOLD.length} paraphrased employment queries, k=${K}\n`);
  console.log('query'.padEnd(58), 'gold', '  FTS rank', ' hybrid rank');
  for (let i = 0; i < GOLD.length; i += 1) {
    const g = GOLD[i];
    const f = fts.perQuery[i].firstHitRank;
    const h = hybrid.perQuery[i].firstHitRank;
    console.log(
      g.query.slice(0, 56).padEnd(58),
      g.relevant.join('/').padEnd(4),
      String(f ?? '—').padStart(9),
      String(h ?? '—').padStart(12),
    );
  }

  console.log('\n          recall@k     MRR');
  console.log(`FTS       ${pct(fts.recallAtK).padStart(7)}   ${fts.mrr.toFixed(3)}`);
  console.log(`Hybrid    ${pct(hybrid.recallAtK).padStart(7)}   ${hybrid.mrr.toFixed(3)}`);

  const improved = hybrid.recallAtK >= fts.recallAtK && hybrid.mrr >= fts.mrr;
  console.log(`\nHybrid >= FTS on both metrics: ${improved ? 'YES' : 'NO'}`);

  await getPool().end();
  process.exit(improved ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await getPool().end();
  process.exit(1);
});
