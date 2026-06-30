/**
 * Network-free tests for the ingest plane (a tsx assert script, like apps/web's
 * smoke-db.ts). Three layers:
 *   1. Classifier unit tests  — pure, no DB, no network.
 *   2. CDC delta-logic test    — pure, no DB, no network.
 *   3. DB integration test     — migrate (001 + 002), load an in-memory fixture
 *      via the real load functions, assert the derived rows, classification, and
 *      the current-expression predicate. Requires DATABASE_URL.
 *
 *   DATABASE_URL=postgres://... pnpm test:db
 */
import { classify } from '../src/classify';
import { chunkArticle } from '../src/chunk';
import { planDelta } from '../src/cdc';
import type { ChangeRecord, SpintaRecord } from '../src/spinta';
import { runMigrations } from '../src/migrate';
import { query, withTransaction, endPool } from '../src/db';
import {
  archiveRecords,
  classifyAllWorks,
  synthesizeExpressions,
  upsertExpressionFromSuvestine,
  upsertWorkFromDokumentas,
} from '../src/load';

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures += 1;
  }
}

// ---------------------------------------------------------------------------
// 1. Classifier unit tests
// ---------------------------------------------------------------------------
function testClassifier() {
  console.log('Classifier:');

  // Darbo kodeksas: title is "...patvirtinimo..." but it has consolidations,
  // so the consolidation-richness signal makes it a base act (the D4 asymmetry).
  const dk = classify({
    tar_kodas: '2016-23709',
    pavadinimas: 'Lietuvos Respublikos darbo kodekso patvirtinimo, įsigaliojimo ir įgyvendinimo įstatymas',
    rusis: 'Įstatymas',
    consolidationCount: 38,
  });
  check('Darbo kodeksas -> base', dk.classification === 'base');

  const amendment = classify({
    tar_kodas: 'X',
    pavadinimas: 'Dėl Darbo kodekso 57 straipsnio pakeitimo įstatymas',
    rusis: 'Įstatymas',
    consolidationCount: 0,
  });
  check('"...pakeitimo įstatymas" -> amendment', amendment.classification === 'amendment');

  check('Nutartis -> non_normative', classify({ pavadinimas: 'X', rusis: 'Nutartis', consolidationCount: 0 }).classification === 'non_normative');
  check('Informacija -> non_normative', classify({ pavadinimas: 'X', rusis: 'Informacija', consolidationCount: 0 }).classification === 'non_normative');

  // A base law WITH consolidations stays base even if its title would otherwise
  // look like an amendment (consolidation signal beats the title pattern).
  const baseWithCons = classify({
    pavadinimas: 'Statybos įstatymo pakeitimo įstatymas',
    rusis: 'Įstatymas',
    consolidationCount: 5,
  });
  check('base law WITH consolidations -> base', baseWithCons.classification === 'base');

  // The weak default is flagged ambiguous for the optional LLM pass.
  const ambiguous = classify({ pavadinimas: 'Dėl komisijos sudarymo', rusis: 'Nutarimas', consolidationCount: 0 });
  check('no signal -> base + ambiguous', ambiguous.classification === 'base' && ambiguous.ambiguous);
}

// ---------------------------------------------------------------------------
// 1b. Chunker unit tests (pure, no DB, no network)
// ---------------------------------------------------------------------------
function testChunker() {
  console.log('Chunker:');

  // A multi-`dalis` article: paragraph leaves split on line-start "N." markers,
  // breadcrumbs name the dalis, and the parent article chunk is kept.
  const multi = chunkArticle({
    number: '57',
    heading: 'Darbo sutarties nutraukimas darbdavio iniciatyva',
    breadcrumb: 'Darbo kodeksas > 57 straipsnis',
    body: '1. Darbdavys turi teisę nutraukti darbo sutartį.\n2. Įspėjimo terminas yra vienas mėnuo.\n3. Išeitinė išmoka mokama darbuotojui.',
  });
  const leaves = multi.filter((c) => c.granularity === 'paragraph');
  const parent = multi.filter((c) => c.granularity === 'article');
  check('multi-dalis -> one article parent', parent.length === 1);
  check('multi-dalis -> 3 paragraph leaves', leaves.length === 3);
  check('leaf ordinals are 1..n', leaves.map((l) => l.ordinal).join(',') === '1,2,3');
  check(
    'leaf breadcrumb names the dalis',
    leaves[0].breadcrumb === 'Darbo kodeksas > 57 straipsnis > 1 dalis',
  );
  check('content prepends the breadcrumb before the text', leaves[1].content.startsWith('Darbo kodeksas > 57 straipsnis > 2 dalis\n'));
  check('leaf keeps the verbatim "N." prefix', leaves[1].text.startsWith('2. Įspėjimo terminas'));
  check('parent embeds heading + body', parent[0].content.includes('Darbo sutarties nutraukimas') && parent[0].content.includes('Išeitinė išmoka'));

  // An un-numbered article: exactly one leaf carrying the whole body, breadcrumb
  // unchanged (no "> N dalis").
  const single = chunkArticle({
    number: '1',
    heading: 'Darbo kodekso paskirtis',
    breadcrumb: 'Darbo kodeksas > 1 straipsnis',
    body: 'Šis kodeksas reglamentuoja darbo santykius Lietuvos Respublikoje.',
  });
  const singleLeaves = single.filter((c) => c.granularity === 'paragraph');
  check('un-numbered article -> 1 leaf', singleLeaves.length === 1);
  check('un-numbered leaf breadcrumb has no dalis', singleLeaves[0].breadcrumb === 'Darbo kodeksas > 1 straipsnis' && singleLeaves[0].dalis === null);

  // Preamble before the first marker is captured as an un-numbered leaf.
  const preamble = chunkArticle({
    number: '5',
    heading: 'Sąvokos',
    breadcrumb: 'Darbo kodeksas > 5 straipsnis',
    body: 'Šiame straipsnyje vartojamos sąvokos:\n1. Darbuotojas yra fizinis asmuo.\n2. Darbdavys yra įmonė.',
  });
  const preLeaves = preamble.filter((c) => c.granularity === 'paragraph');
  check('preamble + 2 dalys -> 3 leaves', preLeaves.length === 3);
  check('preamble leaf is un-numbered first', preLeaves[0].dalis === null && preLeaves[1].dalis === '1');

  // Determinism: identical input -> identical output.
  const again = chunkArticle({
    number: '57',
    heading: 'Darbo sutarties nutraukimas darbdavio iniciatyva',
    breadcrumb: 'Darbo kodeksas > 57 straipsnis',
    body: '1. Darbdavys turi teisę nutraukti darbo sutartį.\n2. Įspėjimo terminas yra vienas mėnuo.\n3. Išeitinė išmoka mokama darbuotojui.',
  });
  check('chunking is deterministic', JSON.stringify(again) === JSON.stringify(multi));
}

// ---------------------------------------------------------------------------
// 2. CDC delta-logic test
// ---------------------------------------------------------------------------
function testDelta() {
  console.log('CDC delta:');
  const changes: ChangeRecord[] = [
    { _cid: 9, _op: 'upsert', _id: 'OLD', _revision: 'r0' }, // <= watermark, must drop
    { _cid: 10, _op: 'upsert', _id: 'A', _revision: 'rA1', tar_kodas: 'A' },
    { _cid: 10, _op: 'upsert', _id: 'A', _revision: 'rA1', tar_kodas: 'A' }, // boundary repeat
    { _cid: 11, _op: 'upsert', _id: 'B', _revision: 'rB1' },
    { _cid: 12, _op: 'delete', _id: 'B', _revision: 'rB2' }, // B finally deleted
    { _cid: 13, _op: 'upsert', _id: 'C', _revision: 'rC1' },
  ];
  const plan = planDelta(changes, 9);

  check('drops changes at/below the watermark', plan.upserts.every((c) => c._id !== 'OLD'));
  check('dedupes the boundary repeat', plan.dedupedCount === 4);
  check('A and C are upserts', plan.upserts.map((c) => c._id).sort().join(',') === 'A,C');
  check('B collapses to a delete', plan.deletes.length === 1 && plan.deletes[0]._id === 'B');
  check('watermark advances to 13', plan.newWatermark === 13);

  // Nothing new -> watermark unchanged.
  const empty = planDelta([{ _cid: 5, _op: 'upsert', _id: 'Z', _revision: 'z' }], 9);
  check('stale-only page leaves watermark', empty.newWatermark === 9 && empty.upserts.length === 0);
}

// ---------------------------------------------------------------------------
// 3. DB integration test
// ---------------------------------------------------------------------------
const DOKUMENTAS: SpintaRecord[] = [
  {
    _id: 'test-d1', _revision: 'r1', tar_kodas: 'TEST-1', dokumento_id: 'TESTDOC1',
    pavadinimas: 'Bandomojo kodekso patvirtinimo įstatymas', rusis: 'Įstatymas',
    galioj_busena: 'galioja', isigalioja: '2020-01-01', negalioja: null,
    tekstas_lt: 'Kodekso pradinis tekstas', nuoroda: 'https://e-tar.lt/test1',
  },
  {
    _id: 'test-d2', _revision: 'r1', tar_kodas: 'TEST-2', dokumento_id: 'TESTDOC2',
    pavadinimas: 'Dėl Bandomojo kodekso 5 straipsnio pakeitimo įstatymas', rusis: 'Įstatymas',
    galioj_busena: 'galioja', isigalioja: '2019-06-01', negalioja: null,
    tekstas_lt: 'Pakeitimo tekstas', nuoroda: 'https://e-tar.lt/test2',
  },
  {
    _id: 'test-d3', _revision: 'r1', tar_kodas: 'TEST-3', dokumento_id: 'TESTDOC3',
    pavadinimas: 'Teismo nutartis byloje', rusis: 'Nutartis',
    galioj_busena: 'galioja', isigalioja: '2021-01-01',
    tekstas_lt: 'Nutarties tekstas', nuoroda: 'https://e-tar.lt/test3',
  },
];

const SUVESTINE: SpintaRecord[] = [
  {
    _id: 'test-s1', _revision: 'r1', suvestines_id: 'TESTS1', dokumento_id: 'TESTDOC1',
    galioja_nuo: '2020-01-01', galioja_iki: '2023-01-01', tekstas_lt: 'Sena redakcija',
    nuoroda: 'https://e-tar.lt/test1-s1',
  },
  {
    _id: 'test-s2', _revision: 'r1', suvestines_id: 'TESTS2', dokumento_id: 'TESTDOC1',
    galioja_nuo: '2023-01-01', galioja_iki: null, tekstas_lt: 'Galiojanti redakcija',
    nuoroda: 'https://e-tar.lt/test1-s2',
  },
];

const TEST_TAR = ['TEST-1', 'TEST-2', 'TEST-3'];

async function cleanup() {
  await query('DELETE FROM work WHERE tar_kodas = ANY($1)', [TEST_TAR]);
  await query("DELETE FROM raw_archive WHERE record_id LIKE 'test-%'");
}

async function testDb() {
  console.log('DB integration:');
  await runMigrations();
  await cleanup();

  await withTransaction(async (client) => {
    await archiveRecords(client, 'Dokumentas', DOKUMENTAS);
    for (const rec of DOKUMENTAS) await upsertWorkFromDokumentas(client, rec);
    await archiveRecords(client, 'Suvestine', SUVESTINE);
    for (const rec of SUVESTINE) await upsertExpressionFromSuvestine(client, rec);
    await synthesizeExpressions(client);
    await classifyAllWorks(client);
  });

  const arch = await query<{ model: string; n: string }>(
    "SELECT model, count(DISTINCT record_id) AS n FROM raw_archive WHERE record_id LIKE 'test-%' GROUP BY model",
  );
  const archCounts = Object.fromEntries(arch.rows.map((r) => [r.model, Number(r.n)]));
  check('archived 3 Dokumentas', archCounts.Dokumentas === 3);
  check('archived 2 Suvestine', archCounts.Suvestine === 2);

  const works = await query<{ tar_kodas: string; classification: string }>(
    'SELECT tar_kodas, classification FROM work WHERE tar_kodas = ANY($1)',
    [TEST_TAR],
  );
  const cls = Object.fromEntries(works.rows.map((r) => [r.tar_kodas, r.classification]));
  check('TEST-1 (has consolidations) -> base', cls['TEST-1'] === 'base');
  check('TEST-2 (pakeitimo title) -> amendment', cls['TEST-2'] === 'amendment');
  check('TEST-3 (Nutartis) -> non_normative', cls['TEST-3'] === 'non_normative');

  const exprCounts = await query<{ tar_kodas: string; n: string; fallback: string }>(
    `SELECT w.tar_kodas, count(e.id) AS n,
            count(e.id) FILTER (WHERE e.suvestine_id IS NULL) AS fallback
     FROM work w JOIN expression e ON e.work_id = w.id
     WHERE w.tar_kodas = ANY($1) GROUP BY w.tar_kodas`,
    [TEST_TAR],
  );
  const ec = Object.fromEntries(exprCounts.rows.map((r) => [r.tar_kodas, { n: Number(r.n), fb: Number(r.fallback) }]));
  check('TEST-1 has 2 Suvestinė expressions, no fallback', ec['TEST-1']?.n === 2 && ec['TEST-1']?.fb === 0);
  check('TEST-2 has 1 synthesized fallback expression', ec['TEST-2']?.n === 1 && ec['TEST-2']?.fb === 1);
  check('TEST-3 has 1 synthesized fallback expression', ec['TEST-3']?.n === 1 && ec['TEST-3']?.fb === 1);

  // current-expression predicate must select the open-ended S2, not the closed S1.
  const current = await query<{ suvestine_id: string }>(
    `SELECT ce.suvestine_id FROM current_expression ce
     JOIN work w ON w.id = ce.work_id WHERE w.tar_kodas = 'TEST-1'`,
  );
  check('current_expression for TEST-1 is S2 (open-ended)', current.rows[0]?.suvestine_id === 'TESTS2');

  await cleanup();
}

async function main() {
  testClassifier();
  testChunker();
  testDelta();

  if (process.env.DATABASE_URL) {
    await testDb();
    await endPool();
  } else {
    console.log('DB integration: skipped (DATABASE_URL not set)');
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await endPool();
  process.exit(1);
});
