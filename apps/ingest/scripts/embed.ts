/**
 * Chunk + embed the currently-valid articles into the `chunk` table (decision
 * D6/D9). Reads each in-force article, splits it into dual-granularity chunks,
 * embeds every chunk's breadcrumb-prefixed `content` via Voyage (input_type
 * document), and replaces that article's chunks (idempotent — re-running
 * rewrites the same rows).
 *
 *   DATABASE_URL=... VOYAGE_API_KEY=... pnpm ingest:embed
 *   ... pnpm ingest:embed -- --limit 20      # bounded run
 */
import { chunkArticle } from '../src/chunk';
import { embedDocuments, toVectorLiteral } from '../src/embed';
import { getPool, withTransaction, endPool } from '../src/db';

interface ArticleRow {
  id: string;
  expression_id: string;
  number: string;
  heading: string;
  body: string;
  breadcrumb: string;
  galioja_nuo: Date;
  galioja_iki: Date | null;
}

/** Embedding requests per call; keeps memory bounded on large corpora. */
const EMBED_BATCH = 64;

function parseLimit(argv: string[]): number | null {
  const i = argv.indexOf('--limit');
  if (i === -1) return null;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n <= 0) throw new Error('--limit expects a positive integer');
  return n;
}

async function main() {
  if (!process.env.VOYAGE_API_KEY) {
    throw new Error('VOYAGE_API_KEY is not set (required to embed via Voyage)');
  }
  const limit = parseLimit(process.argv.slice(2));

  const { rows } = await getPool().query<ArticleRow>(
    `SELECT a.id, a.expression_id, a.number, a.heading, a.body, a.breadcrumb,
            a.galioja_nuo, a.galioja_iki
     FROM article a
     WHERE a.galioja_nuo <= now() AND (a.galioja_iki IS NULL OR a.galioja_iki > now())
     ORDER BY a.expression_id, a.ordinal
     ${limit ? 'LIMIT $1' : ''}`,
    limit ? [limit] : [],
  );

  console.log(`Chunking ${rows.length} current article(s)...`);

  // Build all chunks first (pure), then embed in batches across articles so a
  // single TEI round-trip covers many leaves.
  const perArticle = rows.map((a) => ({ article: a, chunks: chunkArticle(a) }));
  const allContents = perArticle.flatMap((p) => p.chunks.map((c) => c.content));
  const vectors: number[][] = [];
  for (let i = 0; i < allContents.length; i += EMBED_BATCH) {
    process.stdout.write(`  embedding ${i + 1}-${Math.min(i + EMBED_BATCH, allContents.length)} / ${allContents.length}\r`);
    vectors.push(...(await embedDocuments(allContents.slice(i, i + EMBED_BATCH))));
  }
  process.stdout.write('\n');

  // Write per article in a transaction: replace its chunks atomically.
  let cursor = 0;
  let chunkCount = 0;
  for (const { article, chunks } of perArticle) {
    const slice = vectors.slice(cursor, cursor + chunks.length);
    cursor += chunks.length;
    await withTransaction(async (client) => {
      await client.query('DELETE FROM chunk WHERE article_id = $1', [article.id]);
      for (const [i, c] of chunks.entries()) {
        await client.query(
          `INSERT INTO chunk
             (article_id, expression_id, granularity, ordinal, breadcrumb, content,
              galioja_nuo, galioja_iki, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)`,
          [
            article.id,
            article.expression_id,
            c.granularity,
            c.ordinal,
            c.breadcrumb,
            c.content,
            article.galioja_nuo,
            article.galioja_iki,
            toVectorLiteral(slice[i]),
          ],
        );
        chunkCount += 1;
      }
    });
  }

  console.log(`Embedded ${chunkCount} chunk(s) across ${perArticle.length} article(s).`);
  await endPool();
}

main().catch(async (err) => {
  console.error(err);
  await endPool();
  process.exit(1);
});
