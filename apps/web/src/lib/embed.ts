/**
 * Client for the Voyage AI embedding API — the embeddings provider Anthropic
 * recommends. Shared, verbatim, between the ingest plane (document vectors) and
 * the query plane (query vectors) so both sides come from the identical model
 * (the asymmetric-retrieval requirement, decision D9).
 *
 * Voyage is asymmetric by `input_type`: passages use "document" and search
 * queries use "query", which Voyage maps to distinct internal prompts. Using the
 * correct type on each side materially improves retrieval quality. Voyage vectors
 * are L2-normalized, so cosine distance and dot product rank identically.
 *
 * Auth: `VOYAGE_API_KEY`. Model: `VOYAGE_EMBED_MODEL` (default `voyage-4-large`,
 * the best-multilingual-quality model). All current Voyage models default to
 * 1024 dimensions, matching the `chunk.embedding vector(1024)` column.
 */

export const EMBEDDING_DIM = 1024;

const VOYAGE_EMBED_URL = 'https://api.voyageai.com/v1/embeddings';
const DEFAULT_MODEL = 'voyage-4-large';

/**
 * Voyage accepts up to 1000 inputs per request but caps total tokens, so we
 * batch conservatively to stay well under the token ceiling on long passages.
 */
const MAX_BATCH = 128;

type InputType = 'document' | 'query';

function apiKey(): string {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error('VOYAGE_API_KEY is not set');
  return key;
}

function model(): string {
  return process.env.VOYAGE_EMBED_MODEL ?? DEFAULT_MODEL;
}

interface VoyageEmbedResponse {
  data: { embedding: number[]; index: number }[];
}

async function embedBatch(inputs: string[], inputType: InputType): Promise<number[][]> {
  const res = await fetch(VOYAGE_EMBED_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({ input: inputs, model: model(), input_type: inputType }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Voyage embeddings ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as VoyageEmbedResponse;
  if (!json.data || json.data.length !== inputs.length) {
    throw new Error('Voyage embeddings returned an unexpected shape');
  }
  // Restore input order (Voyage returns an `index` per item).
  const ordered = new Array<number[]>(inputs.length);
  for (const item of json.data) ordered[item.index] = item.embedding;
  return ordered;
}

async function embedAll(texts: string[], inputType: InputType): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    out.push(...(await embedBatch(texts.slice(i, i + MAX_BATCH), inputType)));
  }
  return out;
}

/** Embed corpus passages (`input_type=document`), preserving input order. */
export function embedDocuments(texts: string[]): Promise<number[][]> {
  return embedAll(texts, 'document');
}

/** Embed a single search query (`input_type=query`). */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embedAll([text], 'query');
  return vector;
}

/** Format a vector as a pgvector literal, e.g. `[0.1,0.2,...]`. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
