import rawCorpus from '@/corpus/darbo-kodeksas.json';

/** Shape of the corpus JSON shipped in `src/corpus/darbo-kodeksas.json`. */
export interface CorpusFile {
  title: string;
  tar_kodas: string;
  nuoroda: string;
  galioja_nuo: string;
  galioja_iki: string | null;
  fetched_at: string;
  tekstas_lt: string;
}

export interface Article {
  /** Article number as a string, e.g. "57". */
  number: string;
  /** Heading text following the number, e.g. "Darbo sutarties nutraukimas...". */
  heading: string;
  /** Article body: text from after the heading until the next article heading. */
  body: string;
  /** Structural breadcrumb, e.g. "Darbo kodeksas > 57 straipsnis". */
  breadcrumb: string;
}

const corpus = rawCorpus as CorpusFile;

/** Corpus-level metadata (everything except the large `tekstas_lt` blob). */
export const corpusMeta = {
  title: corpus.title,
  tar_kodas: corpus.tar_kodas,
  nuoroda: corpus.nuoroda,
  galioja_nuo: corpus.galioja_nuo,
  galioja_iki: corpus.galioja_iki,
  fetched_at: corpus.fetched_at,
} as const;

/** Date part of `galioja_nuo` (e.g. "2025-01-01" from an ISO timestamp). */
export const asOfDate: string = corpus.galioja_nuo.slice(0, 10);

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

function parseArticles(text: string): Article[] {
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

/** Parsed articles, memoized at module load. */
export const articles: Article[] = parseArticles(corpus.tekstas_lt);

const articleByNumber = new Map<string, Article>(articles.map((a) => [a.number, a]));

/** Look up the first article with the given number (numbers can repeat across acts). */
export function getArticle(number: string): Article | undefined {
  return articleByNumber.get(number);
}

/** Collapse all runs of whitespace to single spaces; used for verbatim quote checks. */
export function normalizeForCompare(text: string): string {
  return normalizeWhitespace(text).replace(/\s+/g, ' ').trim();
}
