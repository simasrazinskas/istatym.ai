import { parseArticles } from './parser';
import { query, withTransaction } from './db';
import { fetchCurrentConsolidation, type ConsolidationData } from './spinta';

/**
 * The single work in scope for v1: the Lithuanian Labour Code (Darbo kodeksas).
 * Identified by register code (`tar_kodas`) per decision D4, with its parent
 * document id used to query consolidations from Spinta.
 */
export const TARGET_WORK = {
  tar_kodas: '2016-23709',
  dokumento_id: 'f6d686707e7011e6b969d7ae07280e89',
  title: 'Lietuvos Respublikos darbo kodeksas',
} as const;

/**
 * Load a consolidation into Postgres: upsert the work and expression, then
 * replace the expression's articles. Idempotent — re-running with the same
 * consolidation rewrites the same rows.
 */
export async function loadConsolidation(
  work: { tar_kodas: string; title: string },
  data: ConsolidationData,
): Promise<{ articleCount: number }> {
  const articles = parseArticles(data.tekstas_lt);
  if (articles.length === 0) {
    throw new Error('Parsed 0 articles from consolidation text; refusing to load');
  }

  await withTransaction(async (client) => {
    const w = await client.query<{ id: string }>(
      `INSERT INTO work (tar_kodas, title) VALUES ($1, $2)
       ON CONFLICT (tar_kodas) DO UPDATE SET title = EXCLUDED.title
       RETURNING id`,
      [work.tar_kodas, work.title],
    );
    const workId = w.rows[0].id;

    const e = await client.query<{ id: string }>(
      `INSERT INTO expression
         (work_id, suvestine_id, dokumento_id, galioja_nuo, galioja_iki, source_url, raw_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (work_id, galioja_nuo) DO UPDATE SET
         suvestine_id = EXCLUDED.suvestine_id,
         dokumento_id = EXCLUDED.dokumento_id,
         galioja_iki  = EXCLUDED.galioja_iki,
         source_url   = EXCLUDED.source_url,
         raw_text     = EXCLUDED.raw_text,
         fetched_at   = now()
       RETURNING id`,
      [
        workId,
        data.suvestine_id,
        data.dokumento_id,
        data.galioja_nuo,
        data.galioja_iki,
        data.source_url,
        data.tekstas_lt,
      ],
    );
    const expressionId = e.rows[0].id;

    // Replace this expression's articles so re-ingest is clean.
    await client.query('DELETE FROM article WHERE expression_id = $1', [expressionId]);

    for (const [ordinal, a] of articles.entries()) {
      await client.query(
        `INSERT INTO article
           (expression_id, ordinal, number, heading, body, breadcrumb,
            galioja_nuo, galioja_iki, search_vector)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 to_tsvector('lithuanian_unaccent', $9))`,
        [
          expressionId,
          ordinal,
          a.number,
          a.heading,
          a.body,
          a.breadcrumb,
          data.galioja_nuo,
          data.galioja_iki,
          `${a.heading} ${a.body}`,
        ],
      );
    }
  });

  return { articleCount: articles.length };
}

/** True if the work has at least one article whose validity window is open at `asOf`. */
export async function hasCurrentArticles(
  tarKodas: string,
  asOf: Date = new Date(),
): Promise<boolean> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*) AS n
     FROM article a
     JOIN expression e ON e.id = a.expression_id
     JOIN work w ON w.id = e.work_id
     WHERE w.tar_kodas = $1
       AND a.galioja_nuo <= $2 AND (a.galioja_iki IS NULL OR a.galioja_iki > $2)`,
    [tarKodas, asOf],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Fetch the target work's current consolidation from Spinta and load it. */
export async function ingestTargetWork(asOf: Date = new Date()): Promise<{ articleCount: number }> {
  const data = await fetchCurrentConsolidation(TARGET_WORK.dokumento_id, asOf);
  return loadConsolidation(TARGET_WORK, data);
}

/**
 * Bootstrap on boot: if the target work has no current articles, fetch and load
 * it. Best-effort — callers treat failure as non-fatal so the app still serves.
 */
export async function bootstrapIfEmpty(): Promise<void> {
  if (await hasCurrentArticles(TARGET_WORK.tar_kodas)) return;
  const { articleCount } = await ingestTargetWork();
  console.log(`[ingest] bootstrapped ${TARGET_WORK.tar_kodas}: ${articleCount} articles`);
}
