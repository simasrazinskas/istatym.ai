/**
 * Streaming client for the data.gov.lt Spinta API serving the Teisės aktų
 * registras (TAR). Where apps/web's spinta.ts fetches a single work, this client
 * streams entire models for the full-corpus bulk load and reads the `/:changes`
 * CDC feed for the daily delta.
 *
 * Verified live against the API (research doc 01):
 *  - JSONL pagination: each row carries `_page.next`, an opaque base64 cursor;
 *    fetch the next page with `?page('<token>')`.
 *  - Count: `?select(count())` -> `{"_data":[{"count()":N}]}`.
 *  - CDC: `<Model>/:changes/<cid>/:format/json?limit(N)` returns records with
 *    `_cid >= cid` (a monotonic int cursor), `_op` (`upsert`|`delete`), `_id`,
 *    `_revision`, plus the base fields.
 *  - Spinta is "pre-alpha" with a known pagination-boundary bug (a page may
 *    repeat or skip at a boundary). Callers dedupe on `(_id, _revision)` and the
 *    page loop guards against a repeating cursor.
 */

export const SPINTA_BASE = 'https://get.data.gov.lt/datasets/gov/lrsk/teises_aktai';

export type Model = 'Dokumentas' | 'Suvestine' | 'Priedas';
export const MODELS: Model[] = ['Dokumentas', 'Suvestine', 'Priedas'];

/** A raw Spinta record. Fields vary by model; metadata fields are always present. */
export type SpintaRecord = Record<string, unknown> & {
  _id: string;
  _revision: string;
  _page?: { next?: string };
};

/** A change-feed record: a base record plus the CDC metadata. */
export type ChangeRecord = Record<string, unknown> & {
  _cid: number;
  _op: string;
  _id: string;
  _revision: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 4;

/** Fetch with a timeout and bounded exponential-backoff retry on transient errors. */
async function fetchWithRetry(url: string, accept: string): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { accept }, signal: controller.signal });
      if (res.ok) return res;
      // 5xx / 429 are worth retrying; other statuses are terminal.
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`Spinta request failed: ${res.status} ${res.statusText} (${url})`);
      }
      lastErr = new Error(`Spinta ${res.status} ${res.statusText}`);
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < DEFAULT_RETRIES) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error(`Spinta request failed after retries (${url}): ${String(lastErr)}`);
}

function modelUrl(model: Model, suffix: string): string {
  return `${SPINTA_BASE}/${model}/${suffix}`;
}

/** Total record count for a model via `?select(count())`. */
export async function countModel(model: Model): Promise<number> {
  const res = await fetchWithRetry(modelUrl(model, ':format/json?select(count())'), 'application/json');
  const json = (await res.json()) as { _data?: Array<{ 'count()'?: number }> };
  return Number(json._data?.[0]?.['count()'] ?? 0);
}

function parseJsonl(text: string): SpintaRecord[] {
  const out: SpintaRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) out.push(JSON.parse(trimmed) as SpintaRecord);
  }
  return out;
}

export interface StreamOptions {
  /** Stop after yielding this many records (bounded test runs). */
  limit?: number;
  /** Records per page request. */
  pageSize?: number;
}

/**
 * Stream every record of a model as JSONL, following `_page.next` cursors.
 *
 * Termination: a page returning zero rows, a missing next cursor, or a cursor
 * that repeats the previous one (the boundary-bug guard) ends the stream.
 * Content-level deduplication is the caller's job (raw_archive's unique key).
 */
export async function* streamModel(
  model: Model,
  opts: StreamOptions = {},
): AsyncGenerator<SpintaRecord> {
  const pageSize = opts.pageSize ?? 1000;
  let page: string | undefined;
  let prevPage: string | undefined;
  let yielded = 0;

  for (;;) {
    const pageParam = page ? `&page('${page}')` : '';
    const url = modelUrl(model, `:format/jsonl?limit(${pageSize})${pageParam}`);
    const res = await fetchWithRetry(url, 'application/json');
    const rows = parseJsonl(await res.text());
    if (rows.length === 0) return;

    for (const row of rows) {
      yield row;
      yielded += 1;
      if (opts.limit !== undefined && yielded >= opts.limit) return;
    }

    const nextPage = rows[rows.length - 1]?._page?.next;
    if (!nextPage || nextPage === prevPage) return; // no cursor or a repeating boundary
    prevPage = page;
    page = nextPage;
  }
}

/**
 * Latest `_cid` for a model — the baseline watermark recorded at bulk start so
 * the first CDC run resumes from the snapshot rather than replaying all history.
 * Best-effort: returns 0 if the tail cannot be read, which is safe (CDC then
 * replays from the start, and every apply is idempotent + deduped).
 */
export async function latestCid(model: Model): Promise<number> {
  try {
    const res = await fetchWithRetry(modelUrl(model, ':changes/-1/:format/json'), 'application/json');
    const json = (await res.json()) as { _data?: Array<{ _cid?: number }> };
    return Number(json._data?.[0]?._cid ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Read a page of changes with `_cid >= afterCid`. Callers pass `lastCid + 1` to
 * read strictly-new changes; the boundary-bug dedupe still guards repeats.
 */
export async function fetchChanges(
  model: Model,
  afterCid: number,
  limit = 1000,
): Promise<ChangeRecord[]> {
  const res = await fetchWithRetry(
    modelUrl(model, `:changes/${afterCid}/:format/json?limit(${limit})`),
    'application/json',
  );
  const json = (await res.json()) as { _data?: ChangeRecord[] };
  return json._data ?? [];
}
