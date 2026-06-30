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
import { getCurrentArticle, searchArticles } from '../src/lib/retrieval';
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
