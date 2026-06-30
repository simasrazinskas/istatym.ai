import { articles, type Article } from '@/lib/corpus';

/**
 * Tokenize on Unicode letters, lowercased. Includes Lithuanian letters
 * (ąčęėįšųūž) via the Unicode letter property so morphology survives.
 */
function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/\p{L}+/gu);
  return matches ?? [];
}

export interface SearchResult {
  article: Article;
  score: number;
}

interface IndexedDoc {
  article: Article;
  termFreqs: Map<string, number>;
  length: number;
}

// BM25 hyperparameters (standard defaults).
const K1 = 1.5;
const B = 0.75;

class BM25Index {
  private readonly docs: IndexedDoc[] = [];
  private readonly docFreq = new Map<string, number>();
  private avgDocLength = 0;

  constructor(items: Article[]) {
    for (const article of items) {
      // Index heading + body together so article titles carry weight.
      const tokens = tokenize(`${article.heading} ${article.body}`);
      const termFreqs = new Map<string, number>();
      for (const token of tokens) {
        termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
      }
      for (const term of termFreqs.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
      this.docs.push({ article, termFreqs, length: tokens.length });
    }
    const totalLength = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.avgDocLength = this.docs.length > 0 ? totalLength / this.docs.length : 0;
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.docFreq.get(term) ?? 0;
    // BM25 idf with +1 to keep it non-negative for very common terms.
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  search(query: string, k = 6): SearchResult[] {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return [];

    const uniqueTerms = [...new Set(queryTerms)];
    const results: SearchResult[] = [];

    for (const doc of this.docs) {
      let score = 0;
      for (const term of uniqueTerms) {
        const tf = doc.termFreqs.get(term);
        if (!tf) continue;
        const idf = this.idf(term);
        const denom = tf + K1 * (1 - B + (B * doc.length) / (this.avgDocLength || 1));
        score += idf * ((tf * (K1 + 1)) / denom);
      }
      if (score > 0) {
        results.push({ article: doc.article, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }
}

/** Index built once at module load over all parsed articles. */
const index = new BM25Index(articles);

/** Return the top-k articles for `query`, ranked by BM25 score. */
export function search(query: string, k = 6): SearchResult[] {
  return index.search(query, k);
}
