/**
 * Pure base/amendment classification (decision D4). No DB, no network — both the
 * classify CLI and the tests call this directly.
 *
 * The register has no amends/amended-by edges, so each act is classified from
 * its own metadata. The failure modes are asymmetric and both mild (wrongly
 * excluding an amendment loses no content; wrongly including a diff is minor
 * retrieval noise), so a heuristic is good enough — an optional LLM pass cleans
 * up only the ambiguous middle.
 *
 * Signal order matters:
 *   1. Act-type exclusion (court rulings, notices) -> non_normative.
 *   2. Consolidation-richness -> base. This runs BEFORE the title check because
 *      titles are unreliable: the Darbo kodeksas body itself is titled
 *      "...patvirtinimo, įsigaliojimo...". A work with dated consolidations is
 *      almost always a base act regardless of title (the D4 asymmetry).
 *   3. Title patterns (pakeitimo / papildymo / pripažinimo netekusiu galios)
 *      -> amendment.
 *   4. Otherwise -> base, flagged `ambiguous` for the optional LLM pass.
 */

export type Classification = 'base' | 'amendment' | 'non_normative';

export interface ClassifyInput {
  /** Register code `tar_kodas` — the stable work identifier (D4). */
  tar_kodas?: string | null;
  /** Spinta `pavadinimas`. */
  pavadinimas?: string | null;
  /** Spinta `rusis` (act type). */
  rusis?: string | null;
  /** Number of Suvestinė consolidations attached to the work. */
  consolidationCount: number;
}

export interface ClassifyResult {
  classification: Classification;
  reason: string;
  /** True when only the weak default fired — a candidate for the LLM pass. */
  ambiguous: boolean;
}

/**
 * Act types that are never normative law: court rulings and informational
 * publications. Kept conservative — types that can carry normative content
 * (Įstatymas, Nutarimas, Įsakymas, Dekretas, Sprendimas, ...) are not listed.
 */
const NON_NORMATIVE_TYPES = new Set([
  'Nutartis',
  'Nutartis dėl teismingumo',
  'Informacija',
  'Pranešimas',
  'Atitaisymas',
]);

/** Strip Lithuanian diacritics and lowercase, so title matching is accent-insensitive. */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** Amendment-title markers, matched on the normalized (de-accented) title. */
const AMENDMENT_MARKERS = [
  'pakeitim', // pakeitimo / pakeitimas
  'papildym', // papildymo / papildymas
  'pripazinim', // pripažinimo netekusiu galios
  'neteko galios',
  'netekusiu galios',
];

export function classify(input: ClassifyInput): ClassifyResult {
  const rusis = input.rusis?.trim() ?? '';
  if (rusis && NON_NORMATIVE_TYPES.has(rusis)) {
    return {
      classification: 'non_normative',
      reason: `act type "${rusis}" is non-normative`,
      ambiguous: false,
    };
  }

  if (input.consolidationCount >= 1) {
    return {
      classification: 'base',
      reason: `has ${input.consolidationCount} consolidation(s) (D4 asymmetry)`,
      ambiguous: false,
    };
  }

  const title = normalize(input.pavadinimas ?? '');
  const marker = AMENDMENT_MARKERS.find((m) => title.includes(m));
  if (marker) {
    return {
      classification: 'amendment',
      reason: `title matches "${marker}"`,
      ambiguous: false,
    };
  }

  return {
    classification: 'base',
    reason: 'no amendment signal (default)',
    ambiguous: true,
  };
}
