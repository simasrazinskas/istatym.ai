import { query } from './db';
import { embedQuery, toVectorLiteral } from './embed';

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

// ---------------------------------------------------------------------------
// Hybrid retrieval (decisions D3, D6, D9): pgvector cosine + pg_search BM25,
// fused with Reciprocal Rank Fusion, reranked by a cross-encoder, then the
// winning leaves are auto-merged to their parent article.
// ---------------------------------------------------------------------------

/** RRF constant (decision D3): score each arm `1/(k + rank)`. */
const RRF_K = 60;
/** Per-arm candidate cap fed into fusion. */
const CANDIDATE_CAP = 40;
/** Fused leaves handed to the reranker. */
const RERANK_TOP_N = 30;

/**
 * Injectable dependencies for `hybridSearchArticles`. Defaults call the
 * self-hosted services; tests pass stubs so the path needs no model service.
 */
export interface HybridDeps {
  /** Embed the query into a 1024-dim Voyage vector. */
  embedQuery?: (question: string) => Promise<number[]>;
  /** Score each text against the query; `null` means "skip reranking, keep RRF order". */
  rerank?: (question: string, texts: string[]) => Promise<number[] | null>;
}

const VOYAGE_RERANK_URL = 'https://api.voyageai.com/v1/rerank';

/**
 * Rerank fused candidates with Voyage's cross-encoder. Returns `null` (keep RRF
 * order) when `VOYAGE_API_KEY` is unset, and degrades to `null` on any service
 * error so a reranker hiccup never fails a query. Model: `VOYAGE_RERANK_MODEL`
 * (default `rerank-2.5`).
 */
async function rerankByService(question: string, texts: string[]): Promise<number[] | null> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key || texts.length === 0) return null;
  try {
    const res = await fetch(VOYAGE_RERANK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query: question,
        documents: texts,
        model: process.env.VOYAGE_RERANK_MODEL ?? 'rerank-2.5',
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Voyage rerank ${res.status}: ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data: { index: number; relevance_score: number }[] };
    const scores = new Array<number>(texts.length).fill(Number.NEGATIVE_INFINITY);
    for (const r of json.data) scores[r.index] = r.relevance_score;
    return scores;
  } catch (err) {
    console.error('rerank failed, falling back to RRF order:', err);
    return null;
  }
}

/**
 * Hybrid retrieval over currently-valid chunks. Embeds the query, fuses the
 * semantic (pgvector cosine) and lexical (pg_search BM25) leaf rankings with RRF
 * (k=60), reranks the fused top-N leaves with a cross-encoder, then auto-merges
 * the winning leaves up to their distinct parent articles (best-leaf order).
 *
 * Returns the same `RetrievedArticle[]` shape the FTS baseline returns. The
 * validity-window predicate (decision D2) is applied to every arm.
 */
export async function hybridSearchArticles(
  question: string,
  k = 6,
  asOf: Date = new Date(),
  deps: HybridDeps = {},
): Promise<RetrievedArticle[]> {
  const doEmbedQuery = deps.embedQuery ?? embedQuery;
  const rerank = deps.rerank ?? rerankByService;

  const queryVector = await doEmbedQuery(question);
  const vectorLiteral = toVectorLiteral(queryVector);

  const { rows: leaves } = await query<{
    id: string;
    article_id: string;
    content: string;
    rrf: string;
  }>(
    `WITH sem AS (
       SELECT c.id, c.article_id,
              row_number() OVER (ORDER BY c.embedding <=> $1::vector) AS rank
       FROM chunk c
       WHERE c.granularity = 'paragraph'
         AND c.embedding IS NOT NULL
         AND c.galioja_nuo <= $3 AND (c.galioja_iki IS NULL OR c.galioja_iki > $3)
       ORDER BY c.embedding <=> $1::vector
       LIMIT $4
     ),
     lex AS (
       SELECT c.id, c.article_id,
              row_number() OVER (ORDER BY paradedb.score(c.id) DESC) AS rank
       FROM chunk c
       WHERE c.id @@@ paradedb.match('content', $2)
         AND c.granularity = 'paragraph'
         AND c.galioja_nuo <= $3 AND (c.galioja_iki IS NULL OR c.galioja_iki > $3)
       ORDER BY paradedb.score(c.id) DESC
       LIMIT $4
     ),
     ranked AS (
       SELECT id, article_id, 1.0 / ($6 + rank) AS s FROM sem
       UNION ALL
       SELECT id, article_id, 1.0 / ($6 + rank) AS s FROM lex
     ),
     fused AS (
       SELECT id, article_id, sum(s) AS rrf
       FROM ranked
       GROUP BY id, article_id
     )
     SELECT f.id, f.article_id, c.content, f.rrf
     FROM fused f
     JOIN chunk c ON c.id = f.id
     ORDER BY f.rrf DESC
     LIMIT $5`,
    [vectorLiteral, question, asOf, CANDIDATE_CAP, RERANK_TOP_N, RRF_K],
  );

  if (leaves.length === 0) return [];

  // Rerank the fused leaves; fall back to RRF order when unconfigured.
  const scores = await rerank(question, leaves.map((l) => l.content));
  const order = leaves.map((_, i) => i);
  if (scores) {
    order.sort((a, b) => scores[b] - scores[a]);
  }

  // Auto-merge to distinct parent articles, keeping each article's best-ranked
  // leaf position and score.
  const articleOrder: string[] = [];
  const articleScore = new Map<string, number>();
  for (const i of order) {
    const articleId = leaves[i].article_id;
    if (articleScore.has(articleId)) continue;
    articleScore.set(articleId, scores ? scores[i] : Number(leaves[i].rrf));
    articleOrder.push(articleId);
  }
  const topArticleIds = articleOrder.slice(0, k);
  if (topArticleIds.length === 0) return [];

  const { rows: articles } = await query<{
    id: string;
    number: string;
    heading: string;
    body: string;
    breadcrumb: string;
    source_url: string | null;
    valid_from: Date;
    valid_to: Date | null;
  }>(
    `SELECT a.id, a.number, a.heading, a.body, a.breadcrumb, e.source_url,
            a.galioja_nuo AS valid_from, a.galioja_iki AS valid_to
     FROM article a
     JOIN expression e ON e.id = a.expression_id
     WHERE a.id = ANY($1)`,
    [topArticleIds],
  );
  const byId = new Map(articles.map((a) => [a.id, a]));

  // Return in best-leaf-rank order.
  return topArticleIds
    .map((id) => {
      const a = byId.get(id);
      if (!a) return null;
      return {
        number: a.number,
        heading: a.heading,
        body: a.body,
        breadcrumb: a.breadcrumb,
        source_url: a.source_url,
        valid_from: isoDate(a.valid_from) ?? '',
        valid_to: isoDate(a.valid_to),
        rank: articleScore.get(id) ?? 0,
      } satisfies RetrievedArticle;
    })
    .filter((a): a is RetrievedArticle => a !== null);
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
