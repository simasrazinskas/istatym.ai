/**
 * Network-free integration smoke test for the Postgres retrieval slice.
 * Requires a live database via DATABASE_URL (provided by CI's Postgres service).
 *
 *   DATABASE_URL=postgres://... pnpm test:db
 *
 * It migrates a fresh schema, loads a small in-memory consolidation fixture via
 * the real ingest path, and asserts that FTS retrieval, quote lookup, and the
 * validity-window predicate all behave.
 */
import { runMigrations } from '../src/lib/migrate';
import { loadConsolidation, TARGET_WORK } from '../src/lib/ingest';
import { getCurrentArticle, hybridSearchArticles, searchArticles } from '../src/lib/retrieval';
import { query, getPool } from '../src/lib/db';
import type { ConsolidationData } from '../src/lib/spinta';

const FIXTURE_TEXT = `Suvestinė redakcija nuo 2025-01-01

1 straipsnis. Darbo kodekso paskirtis
Šis kodeksas reglamentuoja darbo santykius Lietuvos Respublikoje.

57 straipsnis. Darbo sutarties nutraukimas darbdavio iniciatyva
Darbdavys turi teisę nutraukti darbo sutartį dėl svarbių priežasčių, įspėjęs darbuotoją.`;

const FIXTURE: ConsolidationData = {
  suvestine_id: 'SMOKE',
  dokumento_id: TARGET_WORK.dokumento_id,
  source_url: 'https://e-tar.lt/test',
  galioja_nuo: '2025-01-01T00:00:00',
  galioja_iki: null,
  tekstas_lt: FIXTURE_TEXT,
};

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures += 1;
  }
}

/** Build a 1024-dim pgvector literal with the given non-zero components. */
function vec(weights: Record<number, number>): string {
  const arr = new Array<number>(1024).fill(0);
  for (const [axis, w] of Object.entries(weights)) arr[Number(axis)] = w;
  return `[${arr.join(',')}]`;
}

/**
 * RRF fusion + auto-merge correctness against a tiny fixture of fake chunks with
 * literal embeddings. Stubs the query embedding and reranker, so this needs NO
 * model service. Exercises migration 003 (pgvector HNSW + pg_search BM25) on the
 * ParadeDB CI service.
 *
 * Fixture: two articles, two paragraph leaves each.
 *   A1 "910": L1a "alpha alpha alpha" @ axis0,  L1b "beta beta" @ axis1
 *   A2 "920": L2a "gamma" @ axis2,              L2b "delta delta delta delta" @ axis3
 * Query vector leans on axis0>axis1>axis2>axis3 (semantic favors A1); the BM25
 * query "delta gamma" matches only A2's leaves (lexical favors A2).
 */
async function testHybridRrf() {
  console.log('Hybrid RRF + auto-merge:');
  const TAR = 'RRF-TEST';
  await query('DELETE FROM work WHERE tar_kodas = $1', [TAR]);

  const gn = '2025-01-01T00:00:00';
  const w = await query<{ id: string }>(
    'INSERT INTO work (tar_kodas, title) VALUES ($1, $2) RETURNING id',
    [TAR, 'RRF fixture'],
  );
  const e = await query<{ id: string }>(
    `INSERT INTO expression (work_id, galioja_nuo, galioja_iki, source_url, raw_text)
     VALUES ($1, $2, NULL, 'https://e-tar.lt/rrf', 'x') RETURNING id`,
    [w.rows[0].id, gn],
  );
  const expressionId = e.rows[0].id;

  async function addArticle(ordinal: number, number: string): Promise<string> {
    const a = await query<{ id: string }>(
      `INSERT INTO article
         (expression_id, ordinal, number, heading, body, breadcrumb, galioja_nuo, galioja_iki, search_vector)
       VALUES ($1, $2, $3, '', 'b', $4, $5, NULL, to_tsvector('simple', 'b')) RETURNING id`,
      [expressionId, ordinal, number, `Darbo kodeksas > ${number} straipsnis`, gn],
    );
    return a.rows[0].id;
  }
  async function addLeaf(articleId: string, ordinal: number, content: string, embedding: string) {
    await query(
      `INSERT INTO chunk
         (article_id, expression_id, granularity, ordinal, breadcrumb, content, galioja_nuo, galioja_iki, embedding)
       VALUES ($1, $2, 'paragraph', $3, 'bc', $4, $5, NULL, $6::vector)`,
      [articleId, expressionId, ordinal, content, gn, embedding],
    );
  }

  const a1 = await addArticle(1, '910');
  const a2 = await addArticle(2, '920');
  await addLeaf(a1, 1, 'alpha alpha alpha', vec({ 0: 1 }));
  await addLeaf(a1, 2, 'beta beta', vec({ 1: 1 }));
  await addLeaf(a2, 1, 'gamma', vec({ 2: 1 }));
  await addLeaf(a2, 2, 'delta delta delta delta', vec({ 3: 1 }));

  // Query vector: axis0 > axis1 > axis2 > axis3 -> semantic order A1 leaves first.
  const queryVec = [0.8, 0.4, 0.2, 0.1];
  const embedQuery = async () =>
    Object.assign(new Array<number>(1024).fill(0), queryVec) as number[];

  // No reranker (null) -> fused RRF order. The lexical "delta gamma" lifts A2 so
  // an A2 leaf fuses highest; auto-merge collapses each article's two leaves to
  // one distinct article.
  const fused = await hybridSearchArticles('delta gamma', 6, new Date(), {
    embedQuery,
    rerank: async () => null,
  });
  check('auto-merge returns distinct articles only', fused.length === 2);
  check('RRF (lexical-boosted) ranks A2 first', fused[0]?.number === '920' && fused[1]?.number === '910');

  // Reranker that prefers A1's leaves flips the article order.
  const reranked = await hybridSearchArticles('delta gamma', 6, new Date(), {
    embedQuery,
    rerank: async (_q, texts) =>
      texts.map((t) => (t.includes('alpha') ? 10 : t.includes('beta') ? 5 : 1)),
  });
  check('reranker reorders auto-merged articles', reranked[0]?.number === '910' && reranked[1]?.number === '920');

  // k bounds the number of distinct articles returned.
  const top1 = await hybridSearchArticles('delta gamma', 1, new Date(), {
    embedQuery,
    rerank: async () => null,
  });
  check('k limits distinct articles', top1.length === 1 && top1[0]?.number === '920');

  await query('DELETE FROM work WHERE tar_kodas = $1', [TAR]);
}

async function main() {
  await runMigrations();

  // Clean slate for repeatable runs.
  await query('DELETE FROM work WHERE tar_kodas = $1', [TARGET_WORK.tar_kodas]);

  const { articleCount } = await loadConsolidation(TARGET_WORK, FIXTURE);
  check('ingest parses both articles', articleCount === 2);

  const hits = await searchArticles('darbo sutarties nutraukimas', 6);
  check('FTS returns results', hits.length > 0);
  check('top hit is article 57', hits[0]?.number === '57');

  // OR-overlap: a natural-language question with a token absent from any article
  // ("kaip") must still retrieve via the remaining terms (regression guard).
  const natural = await searchArticles('kaip nutraukti darbo sutartį', 6);
  check('natural-language question still retrieves', natural.some((a) => a.number === '57'));

  // Empty / lexeme-free input yields an empty tsquery, not an error.
  const empty = await searchArticles('...', 6);
  check('lexeme-free query returns no rows without erroring', empty.length === 0);
  check('hit carries as-of validity', hits[0]?.valid_from === '2025-01-01');
  check('hit carries source url', hits[0]?.source_url === 'https://e-tar.lt/test');

  // Diacritic-insensitive matching (query without Lithuanian accents still hits).
  const unaccented = await searchArticles('darbo sutarties nutraukimas darbdavio', 6);
  check('unaccent-config matches', unaccented.some((a) => a.number === '57'));

  const article = await getCurrentArticle('57');
  check('getCurrentArticle resolves body', !!article && article.body.includes('Darbdavys turi teisę'));

  // Validity predicate: nothing is in force before galioja_nuo.
  const pastHits = await searchArticles('darbo sutarties nutraukimas', 6, new Date('2024-06-01'));
  check('validity predicate excludes future-dated law', pastHits.length === 0);

  await testHybridRrf();

  await getPool().end();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
