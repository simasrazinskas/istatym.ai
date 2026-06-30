/**
 * Thin client for the data.gov.lt Spinta API serving the Teisės aktų registras
 * (TAR). For this slice we only need the current consolidation (Suvestinė) of a
 * single work.
 */

const SPINTA_BASE = 'https://get.data.gov.lt/datasets/gov/lrsk/teises_aktai';

export interface ConsolidationData {
  suvestine_id: string;
  dokumento_id: string;
  source_url: string;
  /** ISO timestamp; start of this consolidation's validity window. */
  galioja_nuo: string;
  /** ISO timestamp or null (null = open-ended / currently in force). */
  galioja_iki: string | null;
  tekstas_lt: string;
}

interface SuvestineRow {
  suvestines_id: string;
  dokumento_id: string;
  nuoroda: string;
  galioja_nuo: string;
  galioja_iki: string | null;
  tekstas_lt: string | null;
}

/**
 * Fetch the consolidation valid at `asOf` for a given parent document.
 *
 * "Current law" selection (research doc 01): among a work's consolidations,
 * pick the one whose validity window contains `asOf`
 * (`galioja_nuo <= asOf < galioja_iki`, with null `galioja_iki` meaning open).
 */
export async function fetchCurrentConsolidation(
  dokumentoId: string,
  asOf: Date = new Date(),
): Promise<ConsolidationData> {
  const url =
    `${SPINTA_BASE}/Suvestine/:format/json` +
    `?dokumento_id.eq("${dokumentoId}")` +
    `&select(suvestines_id,dokumento_id,nuoroda,galioja_nuo,galioja_iki,tekstas_lt)` +
    `&sort(-galioja_nuo)`;

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Spinta request failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { _data?: SuvestineRow[] };
  const rows = json._data ?? [];

  const current = rows.find((r) => {
    const from = new Date(r.galioja_nuo);
    const to = r.galioja_iki ? new Date(r.galioja_iki) : null;
    return from <= asOf && (to === null || to > asOf);
  });

  if (!current) {
    throw new Error(`No consolidation valid at ${asOf.toISOString()} for ${dokumentoId}`);
  }
  if (!current.tekstas_lt) {
    throw new Error(`Consolidation ${current.suvestines_id} has no tekstas_lt`);
  }

  return {
    suvestine_id: current.suvestines_id,
    dokumento_id: current.dokumento_id,
    source_url: current.nuoroda,
    galioja_nuo: current.galioja_nuo,
    galioja_iki: current.galioja_iki,
    tekstas_lt: current.tekstas_lt,
  };
}
