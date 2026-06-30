import { NextResponse } from 'next/server';
import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { search } from '@/lib/bm25';
import { asOfDate, corpusMeta, getArticle, normalizeForCompare } from '@/lib/corpus';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MODEL_ID = 'claude-opus-4-8';
const TOP_K = 6;
const SNIPPET_LEN = 280;

const requestSchema = z.object({
  question: z.string().min(1, 'question is required'),
});

const generationSchema = z.object({
  answer_markdown: z.string(),
  citations: z.array(
    z.object({
      article_number: z.string(),
      quote: z.string(),
    }),
  ),
  confidence: z.number().min(0).max(1),
  abstained: z.boolean(),
  caveats: z.array(z.string()),
});

function snippet(body: string): string {
  const clean = body.replace(/\s+/g, ' ').trim();
  return clean.length > SNIPPET_LEN ? `${clean.slice(0, SNIPPET_LEN).trimEnd()}…` : clean;
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'A non-empty `question` is required' }, { status: 400 });
  }
  const { question } = parsed.data;

  const retrieved = search(question, TOP_K);

  // Graceful degradation: no model key -> return retrieval only, no LLM call.
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({
      configured: false,
      retrieved: retrieved.map(({ article }) => ({
        number: article.number,
        heading: article.heading,
        snippet: snippet(article.body),
      })),
      as_of_date: asOfDate,
    });
  }

  const context = retrieved
    .map(
      ({ article }) =>
        `### ${article.number} straipsnis. ${article.heading}\n${article.body}`,
    )
    .join('\n\n---\n\n');

  const system = [
    'You are a Lithuanian employment-law assistant specializing in the Lithuanian Labour Code (Darbo kodeksas).',
    'Answer in Lithuanian, in clear and precise legal prose.',
    'Use ONLY the provided articles as your source of law. Do not rely on outside knowledge of the law.',
    'Every legal assertion in your answer MUST cite a specific article by its number.',
    'For each citation, the `quote` field MUST be copied verbatim (character-for-character) from the body of the cited article as provided to you. Do not paraphrase, translate, or edit quotes.',
    'Cite using the `article_number` of the article the quote comes from.',
    'If the provided articles are insufficient to answer the question reliably, set `abstained` to true and explain in `answer_markdown` (in Lithuanian) what is missing.',
    'Set `confidence` between 0 and 1 reflecting how well the provided articles support your answer.',
    'Use `caveats` (in Lithuanian) for important conditions, exceptions, or facts the user should clarify.',
    'Write `answer_markdown` as Markdown.',
  ].join('\n');

  const prompt = [
    `Klausimas (vartotojo): ${question}`,
    '',
    'Pateikti Darbo kodekso straipsniai (vienintelis leistinas šaltinis):',
    '',
    context,
  ].join('\n');

  let generation;
  try {
    const result = await generateObject({
      model: anthropic(MODEL_ID),
      schema: generationSchema,
      system,
      prompt,
    });
    generation = result.object;
  } catch (err) {
    console.error('generateObject failed:', err);
    return NextResponse.json(
      { error: 'Answer generation failed. Please try again.' },
      { status: 502 },
    );
  }

  // Ground-by-construction: verify each quote is a verbatim substring of the
  // cited article's body (after whitespace normalization). Drop failures.
  const caveats = [...generation.caveats];
  const verifiedCitations: Array<{
    article_number: string;
    article_label: string;
    quote: string;
    url: string;
    valid_from: string;
  }> = [];
  let droppedCount = 0;

  for (const citation of generation.citations) {
    const article = getArticle(citation.article_number);
    const haystack = article ? normalizeForCompare(article.body) : '';
    const needle = normalizeForCompare(citation.quote);
    const valid = article && needle.length > 0 && haystack.includes(needle);

    if (valid) {
      verifiedCitations.push({
        article_number: citation.article_number,
        article_label: `${citation.article_number} straipsnis`,
        quote: citation.quote,
        url: corpusMeta.nuoroda,
        valid_from: corpusMeta.galioja_nuo,
      });
    } else {
      droppedCount += 1;
    }
  }

  let confidence = generation.confidence;
  if (droppedCount > 0) {
    caveats.push(
      `${droppedCount} cituot${droppedCount === 1 ? 'a citata buvo' : 'os citatos buvo'} atmest${droppedCount === 1 ? 'a' : 'os'}, nes neatitiko šaltinio teksto pažodžiui.`,
    );
  }
  // If the model claimed an answer but every citation failed verification,
  // the answer is ungrounded -> reduce confidence.
  if (!generation.abstained && generation.citations.length > 0 && verifiedCitations.length === 0) {
    confidence = Math.min(confidence, 0.2);
    caveats.push('Nepavyko patvirtinti nė vienos citatos pagal šaltinio tekstą; atsakymą vertinkite atsargiai.');
  }

  return NextResponse.json({
    configured: true,
    answer_markdown: generation.answer_markdown,
    citations: verifiedCitations,
    confidence,
    abstained: generation.abstained,
    caveats,
    as_of_date: asOfDate,
  });
}
