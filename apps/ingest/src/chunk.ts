/**
 * Pure, deterministic dual-granularity chunking of a parsed article (decision D6).
 *
 * A Lithuanian `straipsnis` (article) body is structured as numbered `dalys`
 * ("1.", "2." at the start of a line); a `dalis` may further contain `punktai`
 * ("1)", "2)"). We embed paragraph-level leaves (the `dalis` units) and keep the
 * whole article as the parent/citation unit, auto-merging leaves back up to the
 * article at query time (small-to-big).
 *
 * Every chunk carries a deterministic structural breadcrumb, prepended to the
 * text BEFORE embedding (`content`). The breadcrumb halves right-text/wrong-
 * statute mismatch and is itself the citation. This module is free of any DB or
 * network coupling so it is unit-testable in isolation.
 */

export interface ArticleInput {
  /** Article number, e.g. "57". */
  number: string;
  /** Article heading text. */
  heading: string;
  /** Article body (text after the heading), as parsed by `parseArticles`. */
  body: string;
  /** Article-level breadcrumb, e.g. "Darbo kodeksas > 57 straipsnis". */
  breadcrumb: string;
}

export type Granularity = 'article' | 'paragraph';

export interface Chunk {
  granularity: Granularity;
  /** 0 for the article parent; 1..n for paragraph leaves in document order. */
  ordinal: number;
  /** The `dalis` number this leaf represents, or null (article / un-numbered preamble). */
  dalis: string | null;
  /** Structural breadcrumb for this chunk. */
  breadcrumb: string;
  /** Raw chunk text (verbatim from the source), without the breadcrumb. */
  text: string;
  /** The string that is embedded and stored: breadcrumb prepended to the text. */
  content: string;
}

/**
 * Matches a `dalis` marker at the start of a line: a run of digits, a period,
 * then whitespace, e.g. "1. " or "12. ". Anchored per line (`m` flag).
 */
const DALIS_RE = /^[ \t]*(\d+)\.[ \t]+/gm;

/** Prepend the breadcrumb to text, the exact string we embed and index. */
function buildContent(breadcrumb: string, text: string): string {
  return `${breadcrumb}\n${text}`;
}

/**
 * Split an article into its parent chunk plus paragraph leaves.
 *
 * - The article parent (ordinal 0) embeds the heading + full body, so even a
 *   single-paragraph article has a coarse anchor.
 * - Leaves are the `dalis` units. Text before the first `dalis` marker (rare) is
 *   emitted as an un-numbered leaf. An article with no markers yields exactly one
 *   leaf carrying the whole body.
 *
 * Deterministic: the same input always yields the same chunks in the same order.
 */
export function chunkArticle(article: ArticleInput): Chunk[] {
  const { heading, body, breadcrumb } = article;
  const chunks: Chunk[] = [];

  // Parent (article-granularity) chunk.
  const articleText = heading ? `${heading}\n${body}`.trim() : body.trim();
  chunks.push({
    granularity: 'article',
    ordinal: 0,
    dalis: null,
    breadcrumb,
    text: articleText,
    content: buildContent(breadcrumb, articleText),
  });

  // Locate every `dalis` marker.
  DALIS_RE.lastIndex = 0;
  const markers: { dalis: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = DALIS_RE.exec(body)) !== null) {
    markers.push({ dalis: m[1], start: m.index });
  }

  let ordinal = 1;
  const pushLeaf = (dalis: string | null, text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const leafBreadcrumb = dalis ? `${breadcrumb} > ${dalis} dalis` : breadcrumb;
    chunks.push({
      granularity: 'paragraph',
      ordinal: ordinal++,
      dalis,
      breadcrumb: leafBreadcrumb,
      text: trimmed,
      content: buildContent(leafBreadcrumb, trimmed),
    });
  };

  if (markers.length === 0) {
    // Un-numbered article: the whole body is a single leaf.
    pushLeaf(null, body);
    return chunks;
  }

  // Any preamble before the first marker becomes an un-numbered leaf.
  pushLeaf(null, body.slice(0, markers[0].start));

  // Each marker spans to the next marker (or end of body); the "N." prefix is
  // kept because it is part of the verbatim legal text.
  for (let i = 0; i < markers.length; i += 1) {
    const end = i + 1 < markers.length ? markers[i + 1].start : body.length;
    pushLeaf(markers[i].dalis, body.slice(markers[i].start, end));
  }

  return chunks;
}
