/**
 * Pure parsing of a Lithuanian consolidated act (Suvestinė) into articles.
 *
 * This module is deliberately free of any data-source coupling: it takes the
 * consolidation full text (`tekstas_lt`) and returns parsed `straipsnis`
 * articles. Both the ingest pipeline (writing to Postgres) and tests use it.
 */

export interface ParsedArticle {
  /** Article number as a string, e.g. "57". */
  number: string;
  /** Heading text following the number, e.g. "Darbo sutarties nutraukimas...". */
  heading: string;
  /** Article body: text from after the heading until the next article heading. */
  body: string;
  /** Structural breadcrumb, e.g. "Darbo kodeksas > 57 straipsnis". */
  breadcrumb: string;
}

/** Short label used as the root of every breadcrumb. */
const ROOT_BREADCRUMB = 'Darbo kodeksas';

/**
 * Matches an article heading line such as:
 *   "57 straipsnis. Darbo sutarties nutraukimas darbdavio iniciatyva..."
 * Captures the number and the heading text. Anchored to a full line (`m` flag).
 */
const HEADING_RE = /^[ \t]*(\d+)[ \t]+straipsnis\.[ \t]*(.*)$/gm;

function normalizeWhitespace(text: string): string {
  // Normalize non-breaking spaces (U+00A0) and narrow NBSP (U+202F) to plain
  // spaces so downstream tokenization and substring checks are stable.
  return text.replace(/[  ]/g, ' ');
}

/** Parse the consolidation text into articles, sliced between heading lines. */
export function parseArticles(text: string): ParsedArticle[] {
  const normalized = normalizeWhitespace(text);

  // Collect every heading match with its position so we can slice bodies as the
  // span between one heading and the next.
  const headings: { number: string; heading: string; start: number; bodyStart: number }[] = [];
  HEADING_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HEADING_RE.exec(normalized)) !== null) {
    headings.push({
      number: match[1],
      heading: match[2].trim(),
      start: match.index,
      // Body begins at the end of the matched heading line.
      bodyStart: match.index + match[0].length,
    });
  }

  return headings.map((h, i) => {
    const end = i + 1 < headings.length ? headings[i + 1].start : normalized.length;
    const body = normalized.slice(h.bodyStart, end).trim();
    return {
      number: h.number,
      heading: h.heading,
      body,
      breadcrumb: `${ROOT_BREADCRUMB} > ${h.number} straipsnis`,
    };
  });
}

/** Collapse all runs of whitespace to single spaces; used for verbatim quote checks. */
export function normalizeForCompare(text: string): string {
  return normalizeWhitespace(text).replace(/\s+/g, ' ').trim();
}
