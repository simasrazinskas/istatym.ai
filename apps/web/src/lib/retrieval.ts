import { query } from './db';

export interface RetrievedArticle {
  number: string;
  heading: string;
  body: string;
  breadcrumb: string;
  source_url: string | null;
  /** ISO date (YYYY-MM-DD) the cited expression became valid. */
  valid_from: string;
  /** ISO date or null (null = currently in force). */
  valid_to: string | null;
  rank: number;
}

function isoDate(value: Date | string | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

/**
 * Build an OR-combined tsquery from a natural-language question.
 *
 * `websearch_to_tsquery` AND-combines every term, so a single token absent from
 * an article (Lithuanian morphology is unhandled until pg_search lands) drops
 * the whole article. Rewriting `&` to `|` restores the OR-overlap behavior of
 * the previous BM25 baseline: `ts_rank_cd` then ranks by how many query terms a
 * passage matches. An empty question yields an empty tsquery (matches nothing).
 */
const TSQUERY_EXPR = `to_tsquery('lithuanian_unaccent',
  replace(websearch_to_tsquery('lithuanian_unaccent', $1)::text, '&', '|'))`;

/**
 * Retrieve the top-`k` currently-valid articles for `question` via Postgres
 * full-text search (lithuanian_unaccent config), ranked by `ts_rank_cd`.
 *
 * The validity-window predicate (decision D2) guarantees only law in force at
 * `asOf` is ever returned.
 */
export async function searchArticles(
  question: string,
  k = 6,
  asOf: Date = new Date(),
): Promise<RetrievedArticle[]> {
  const { rows } = await query<{
    number: string;
    heading: string;
    body: string;
    breadcrumb: string;
    source_url: string | null;
    valid_from: Date;
    valid_to: Date | null;
    rank: number;
  }>(
    `WITH q AS (SELECT ${TSQUERY_EXPR} AS query)
     SELECT a.number, a.heading, a.body, a.breadcrumb, e.source_url,
            a.galioja_nuo AS valid_from, a.galioja_iki AS valid_to,
            ts_rank_cd(a.search_vector, q.query) AS rank
     FROM article a
     JOIN expression e ON e.id = a.expression_id
     CROSS JOIN q
     WHERE a.search_vector @@ q.query
       AND a.galioja_nuo <= $3 AND (a.galioja_iki IS NULL OR a.galioja_iki > $3)
     ORDER BY rank DESC
     LIMIT $2`,
    [question, k, asOf],
  );

  return rows.map((r) => ({
    number: r.number,
    heading: r.heading,
    body: r.body,
    breadcrumb: r.breadcrumb,
    source_url: r.source_url,
    valid_from: isoDate(r.valid_from) ?? '',
    valid_to: isoDate(r.valid_to),
    rank: Number(r.rank),
  }));
}

export interface CurrentArticle {
  number: string;
  heading: string;
  body: string;
  source_url: string | null;
  valid_from: string;
  valid_to: string | null;
}

/** Look up a single currently-valid article by its number (for quote verification). */
export async function getCurrentArticle(
  number: string,
  asOf: Date = new Date(),
): Promise<CurrentArticle | null> {
  const { rows } = await query<{
    number: string;
    heading: string;
    body: string;
    source_url: string | null;
    valid_from: Date;
    valid_to: Date | null;
  }>(
    `SELECT a.number, a.heading, a.body, e.source_url,
            a.galioja_nuo AS valid_from, a.galioja_iki AS valid_to
     FROM article a
     JOIN expression e ON e.id = a.expression_id
     WHERE a.number = $1
       AND a.galioja_nuo <= $2 AND (a.galioja_iki IS NULL OR a.galioja_iki > $2)
     ORDER BY a.galioja_nuo DESC
     LIMIT 1`,
    [number, asOf],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    number: r.number,
    heading: r.heading,
    body: r.body,
    source_url: r.source_url,
    valid_from: isoDate(r.valid_from) ?? '',
    valid_to: isoDate(r.valid_to),
  };
}

export interface CorpusMeta {
  title: string;
  tar_kodas: string;
  source_url: string | null;
  as_of_date: string;
}

/** Metadata for the currently-valid expression of the in-scope work (for the UI). */
export async function getCurrentMeta(asOf: Date = new Date()): Promise<CorpusMeta | null> {
  const { rows } = await query<{
    title: string;
    tar_kodas: string;
    source_url: string | null;
    galioja_nuo: Date;
  }>(
    `SELECT w.title, w.tar_kodas, e.source_url, e.galioja_nuo
     FROM expression e
     JOIN work w ON w.id = e.work_id
     WHERE e.galioja_nuo <= $1 AND (e.galioja_iki IS NULL OR e.galioja_iki > $1)
     ORDER BY e.galioja_nuo DESC
     LIMIT 1`,
    [asOf],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    title: r.title,
    tar_kodas: r.tar_kodas,
    source_url: r.source_url,
    as_of_date: isoDate(r.galioja_nuo) ?? '',
  };
}
