/**
 * DB-coupled load logic: archive raw records verbatim, derive normalized
 * work/expression/priedas rows, synthesize fallback expressions, and run
 * classification. The pure pieces (classify, planDelta) live in their own
 * modules; everything here takes a `PoolClient` so callers control transactions.
 */
import type { PoolClient } from 'pg';
import { classify, type Classification } from './classify';
import type { ChangeRecord, Model, SpintaRecord } from './spinta';

/** Coerce a Spinta field to a trimmed non-empty string, or null. */
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Spinta marks failed appendix text extraction with this sentinel. */
const NO_TEXT_SENTINEL = '[Faile yra netekstinių elementų]';

/** Strip the pagination cursor; it is not part of the record. */
function toPayload(record: SpintaRecord | ChangeRecord): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  delete copy._page;
  return copy;
}

export interface ArchiveMeta {
  cid?: number | null;
  op?: string;
}

/**
 * Append records to raw_archive in chunks. Idempotent: a re-seen
 * (model, record_id, revision) is ignored, so the archive never duplicates and
 * reprocessing from it is safe.
 */
export async function archiveRecords(
  client: PoolClient,
  model: Model,
  records: (SpintaRecord | ChangeRecord)[],
  meta: ArchiveMeta = {},
): Promise<void> {
  const chunkSize = 500; // 500 rows * 6 params = 3000, well under the pg param ceiling
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const placeholders: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((rec, j) => {
      const b = j * 6;
      const cid = (rec as ChangeRecord)._cid ?? meta.cid ?? null;
      const op = (rec as ChangeRecord)._op ?? meta.op ?? 'upsert';
      placeholders.push(
        `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::jsonb)`,
      );
      params.push(model, rec._id, cid, op, rec._revision, JSON.stringify(toPayload(rec)));
    });
    await client.query(
      `INSERT INTO raw_archive (model, record_id, cid, op, revision, payload)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (model, record_id, revision) DO NOTHING`,
      params,
    );
  }
}

/** Upsert a work from a Dokumentas record. Returns the work id, or null if it has no tar_kodas. */
export async function upsertWorkFromDokumentas(
  client: PoolClient,
  record: SpintaRecord | ChangeRecord,
): Promise<string | null> {
  const tarKodas = str(record.tar_kodas);
  if (!tarKodas) return null;
  const title = str(record.pavadinimas) ?? tarKodas;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO work (tar_kodas, title, dokumento_id, act_type, galioj_busena)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tar_kodas) DO UPDATE SET
       title         = EXCLUDED.title,
       dokumento_id  = EXCLUDED.dokumento_id,
       act_type      = EXCLUDED.act_type,
       galioj_busena = EXCLUDED.galioj_busena
     RETURNING id`,
    [tarKodas, title, str(record.dokumento_id), str(record.rusis), str(record.galioj_busena)],
  );
  return rows[0].id;
}

export type ExpressionStatus = 'upserted' | 'no_work' | 'no_validity';

/**
 * Upsert an expression from a Suvestinė record, linking it to its work via
 * dokumento_id. Returns the touched work id (for CDC re-derivation) plus a status.
 */
export async function upsertExpressionFromSuvestine(
  client: PoolClient,
  record: SpintaRecord | ChangeRecord,
): Promise<{ workId: string | null; status: ExpressionStatus }> {
  const dokumentoId = str(record.dokumento_id);
  if (!dokumentoId) return { workId: null, status: 'no_work' };

  const work = await client.query<{ id: string }>(
    'SELECT id FROM work WHERE dokumento_id = $1 LIMIT 1',
    [dokumentoId],
  );
  const workId = work.rows[0]?.id;
  if (!workId) return { workId: null, status: 'no_work' };

  const galiojaNuo = str(record.galioja_nuo);
  if (!galiojaNuo) return { workId, status: 'no_validity' };

  await client.query(
    `INSERT INTO expression
       (work_id, suvestine_id, dokumento_id, galioja_nuo, galioja_iki, source_url, raw_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (work_id, galioja_nuo) DO UPDATE SET
       suvestine_id = EXCLUDED.suvestine_id,
       dokumento_id = EXCLUDED.dokumento_id,
       galioja_iki  = EXCLUDED.galioja_iki,
       source_url   = EXCLUDED.source_url,
       raw_text     = EXCLUDED.raw_text,
       fetched_at   = now()`,
    [
      workId,
      str(record.suvestines_id),
      dokumentoId,
      galiojaNuo,
      str(record.galioja_iki),
      str(record.nuoroda),
      str(record.tekstas_lt) ?? '',
    ],
  );
  return { workId, status: 'upserted' };
}

/** Upsert appendix metadata (D5 flag-and-link). Binary text is never stored. */
export async function upsertPriedas(
  client: PoolClient,
  record: SpintaRecord | ChangeRecord,
): Promise<void> {
  const priedoId = str(record.priedo_id);
  if (!priedoId) return;
  const tekstas = str(record.priedo_tekstas);
  const hasText = tekstas !== null && tekstas !== NO_TEXT_SENTINEL;
  await client.query(
    `INSERT INTO priedas (priedo_id, dokumento_id, priedo_pav, failo_pletinys, priedo_url, has_text)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (priedo_id) DO UPDATE SET
       dokumento_id   = EXCLUDED.dokumento_id,
       priedo_pav     = EXCLUDED.priedo_pav,
       failo_pletinys = EXCLUDED.failo_pletinys,
       priedo_url     = EXCLUDED.priedo_url,
       has_text       = EXCLUDED.has_text`,
    [
      priedoId,
      str(record.dokumento_id),
      str(record.priedo_pav),
      str(record.failo_pletinys),
      str(record.priedo_url),
      hasText,
    ],
  );
}

/**
 * Ensure every currently-valid work has exactly one canonical expression:
 *  - drop fallback (Dokumentas-derived, suvestine_id NULL) expressions for works
 *    that now have a real Suvestinė expression, and
 *  - synthesize a fallback expression for valid works with no expression at all,
 *    pulling the validity window + text from the work's latest archived
 *    Dokumentas record (research doc 01: "no consolidation -> use Dokumentas").
 *
 * Idempotent and reprocesses purely from raw_archive (decision D18). Returns the
 * number of fallback expressions inserted/updated.
 */
export async function synthesizeExpressions(client: PoolClient): Promise<number> {
  await client.query(
    `DELETE FROM expression e
     WHERE e.suvestine_id IS NULL
       AND EXISTS (
         SELECT 1 FROM expression e2
         WHERE e2.work_id = e.work_id AND e2.suvestine_id IS NOT NULL
       )`,
  );

  const result = await client.query(
    `INSERT INTO expression
       (work_id, suvestine_id, dokumento_id, galioja_nuo, galioja_iki, source_url, raw_text)
     SELECT w.id, NULL, w.dokumento_id, d.gn, d.gi, d.url, d.txt
     FROM work w
     JOIN LATERAL (
       SELECT
         COALESCE(
           NULLIF(ra.payload->>'isigalioja', ''),
           NULLIF(ra.payload->>'paskelbta_tar', ''),
           NULLIF(ra.payload->>'registracija', ''),
           NULLIF(ra.payload->>'priimtas', '')
         )::timestamptz                         AS gn,
         NULLIF(ra.payload->>'negalioja', '')::timestamptz AS gi,
         NULLIF(ra.payload->>'nuoroda', '')     AS url,
         COALESCE(ra.payload->>'tekstas_lt', '') AS txt
       FROM raw_archive ra
       WHERE ra.model = 'Dokumentas'
         AND ra.payload->>'tar_kodas' = w.tar_kodas
       ORDER BY ra.fetched_at DESC, ra.cid DESC NULLS LAST
       LIMIT 1
     ) d ON d.gn IS NOT NULL
     WHERE w.galioj_busena = 'galioja'
       AND NOT EXISTS (SELECT 1 FROM expression e WHERE e.work_id = w.id)
     ON CONFLICT (work_id, galioja_nuo) DO UPDATE SET
       suvestine_id = EXCLUDED.suvestine_id,
       dokumento_id = EXCLUDED.dokumento_id,
       galioja_iki  = EXCLUDED.galioja_iki,
       source_url   = EXCLUDED.source_url,
       raw_text     = EXCLUDED.raw_text,
       fetched_at   = now()`,
  );
  return result.rowCount ?? 0;
}

export interface AmbiguousWork {
  id: string;
  tar_kodas: string;
  title: string;
  act_type: string | null;
}

export interface ClassifyRunResult {
  counts: Record<Classification, number>;
  /** Works that fell through to the weak default — candidates for the LLM pass. */
  ambiguous: AmbiguousWork[];
}

/**
 * Heuristic-classify works and store the result. Pass `onlyWorkIds` to re-classify
 * just the works touched by a CDC delta. Returns counts and the ambiguous set so
 * a caller (the CLI) can optionally refine them with an LLM.
 */
export async function classifyAllWorks(
  client: PoolClient,
  onlyWorkIds?: string[],
): Promise<ClassifyRunResult> {
  const filter = onlyWorkIds ? 'WHERE w.id = ANY($1)' : '';
  const params = onlyWorkIds ? [onlyWorkIds] : [];
  const { rows } = await client.query<{
    id: string;
    tar_kodas: string;
    title: string;
    act_type: string | null;
    cons_count: string;
  }>(
    `SELECT w.id, w.tar_kodas, w.title, w.act_type,
            count(e.id) FILTER (WHERE e.suvestine_id IS NOT NULL) AS cons_count
     FROM work w
     LEFT JOIN expression e ON e.work_id = w.id
     ${filter}
     GROUP BY w.id`,
    params,
  );

  const counts: Record<Classification, number> = { base: 0, amendment: 0, non_normative: 0 };
  const ambiguous: AmbiguousWork[] = [];

  for (const row of rows) {
    const result = classify({
      tar_kodas: row.tar_kodas,
      pavadinimas: row.title,
      rusis: row.act_type,
      consolidationCount: Number(row.cons_count),
    });
    counts[result.classification] += 1;
    if (result.ambiguous) {
      ambiguous.push({ id: row.id, tar_kodas: row.tar_kodas, title: row.title, act_type: row.act_type });
    }
    await client.query(
      `UPDATE work SET classification = $2, classification_reason = $3, classified_at = now()
       WHERE id = $1`,
      [row.id, result.classification, result.reason],
    );
  }

  return { counts, ambiguous };
}

/** Store an LLM-refined classification for one work (optional cleanup pass). */
export async function storeClassification(
  client: PoolClient,
  workId: string,
  classification: Classification,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE work SET classification = $2, classification_reason = $3, classified_at = now()
     WHERE id = $1`,
    [workId, classification, reason],
  );
}

/** CDC delete: remove the derived rows for a deleted source record. */
export async function applyDelete(
  client: PoolClient,
  model: Model,
  change: ChangeRecord,
): Promise<void> {
  if (model === 'Dokumentas') {
    const tarKodas = str(change.tar_kodas);
    if (tarKodas) {
      // Cascades to expression + article.
      await client.query('DELETE FROM work WHERE tar_kodas = $1', [tarKodas]);
    } else {
      const dokumentoId = str(change.dokumento_id);
      if (dokumentoId) await client.query('DELETE FROM work WHERE dokumento_id = $1', [dokumentoId]);
    }
  } else if (model === 'Suvestine') {
    const suvestineId = str(change.suvestines_id);
    if (suvestineId) await client.query('DELETE FROM expression WHERE suvestine_id = $1', [suvestineId]);
  } else {
    const priedoId = str(change.priedo_id);
    if (priedoId) await client.query('DELETE FROM priedas WHERE priedo_id = $1', [priedoId]);
  }
}
