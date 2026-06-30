'use client';

import { useState, type FormEvent, type ReactNode } from 'react';

interface Citation {
  article_number: string;
  article_label: string;
  quote: string;
  url: string;
  valid_from: string;
}

interface RetrievedItem {
  number: string;
  heading: string;
  snippet: string;
}

interface ConfiguredAnswer {
  configured: true;
  answer_markdown: string;
  citations: Citation[];
  confidence: number;
  abstained: boolean;
  caveats: string[];
  as_of_date: string;
}

interface UnconfiguredAnswer {
  configured: false;
  retrieved: RetrievedItem[];
  as_of_date: string;
}

type AskResponse = ConfiguredAnswer | UnconfiguredAnswer;

/**
 * Minimal Markdown renderer — intentionally dependency-free. Handles the small
 * subset the model emits: headings, unordered lists, bold, inline code, and
 * paragraphs (blank-line separated, single newlines preserved as breaks).
 */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Split on **bold** and `code`, keeping delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  parts.forEach((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      nodes.push(<strong key={i}>{part.slice(2, -2)}</strong>);
    } else if (/^`[^`]+`$/.test(part)) {
      nodes.push(<code key={i}>{part.slice(1, -1)}</code>);
    } else if (part) {
      nodes.push(part);
    }
  });
  return nodes;
}

function Markdown({ source }: { source: string }) {
  const blocks = source.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, bi) => {
        const lines = block.split('\n');

        // Headings (#, ##, ###).
        const headingMatch = lines.length === 1 && lines[0].match(/^(#{1,3})\s+(.*)$/);
        if (headingMatch) {
          const level = headingMatch[1].length;
          const Tag = (`h${level}` as 'h1' | 'h2' | 'h3');
          return <Tag key={bi}>{renderInline(headingMatch[2])}</Tag>;
        }

        // Unordered list (every line starts with - or *).
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={bi}>
              {lines.map((l, li) => (
                <li key={li}>{renderInline(l.replace(/^\s*[-*]\s+/, ''))}</li>
              ))}
            </ul>
          );
        }

        // Paragraph; preserve single line breaks.
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <span key={li}>
                {renderInline(l)}
                {li < lines.length - 1 ? <br /> : null}
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}

export default function Home() {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResponse | null>(null);

  async function ask(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? 'Įvyko klaida.');
      }
      setResult(data as AskResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Įvyko nenumatyta klaida.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <h1 className="brand">
        istatym<span className="dot">.ai</span>
      </h1>
      <p className="subtitle">
        Klauskite apie Lietuvos darbo teisę paprasta kalba. Atsakymai grindžiami galiojančiu
        Darbo kodeksu ir pateikiami su patikrintomis citatomis.
      </p>

      <form className="composer" onSubmit={ask}>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Pvz.: Kiek iš anksto darbdavys turi įspėti apie atleidimą iš darbo?"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') ask(e);
          }}
        />
        <div className="composer-row">
          <span className="hint">Cmd/Ctrl + Enter</span>
          <button className="ask" type="submit" disabled={loading || question.trim().length === 0}>
            {loading ? 'Ieškoma…' : 'Klausti'}
          </button>
        </div>
      </form>

      {error ? <div className="error">{error}</div> : null}

      {result ? (
        <section className="results">
          {result.configured ? (
            <ConfiguredView answer={result} />
          ) : (
            <UnconfiguredView answer={result} />
          )}
        </section>
      ) : null}

      <p className="disclaimer">Tai nėra teisinė konsultacija.</p>
    </main>
  );
}

function ConfiguredView({ answer }: { answer: ConfiguredAnswer }) {
  return (
    <>
      <article className={`card answer${answer.abstained ? ' abstain' : ''}`}>
        <p className="section-label">Atsakymas</p>
        <Markdown source={answer.answer_markdown} />
        <div className="meta-bar">
          {answer.abstained ? <span className="badge">Susilaikyta</span> : null}
          <span className="badge">Pasitikėjimas {Math.round(answer.confidence * 100)}%</span>
          <span>
            Atsakymas pagal teisės aktų redakciją, galiojančią nuo {answer.as_of_date}
          </span>
        </div>
      </article>

      {answer.citations.length > 0 ? (
        <div className="citations">
          <p className="section-label">Šaltiniai</p>
          {answer.citations.map((c, i) => (
            <div className="citation" key={`${c.article_number}-${i}`}>
              <div className="citation-head">
                <span className="citation-label">{c.article_label}</span>
                <a className="citation-link" href={c.url} target="_blank" rel="noreferrer">
                  Žiūrėti šaltinį ↗
                </a>
              </div>
              <blockquote>„{c.quote}“</blockquote>
            </div>
          ))}
        </div>
      ) : null}

      {answer.caveats.length > 0 ? (
        <div className="caveats">
          <p className="section-label">Pastabos</p>
          <ul>
            {answer.caveats.map((cav, i) => (
              <li key={i}>{cav}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function UnconfiguredView({ answer }: { answer: UnconfiguredAnswer }) {
  return (
    <>
      <div className="retrieved-note">
        Atsakymų modelis nesukonfigūruotas (nėra <code>ANTHROPIC_API_KEY</code>). Žemiau —
        aktualiausi rasti Darbo kodekso straipsniai jūsų klausimui.
      </div>
      <p className="section-label">Rasti straipsniai</p>
      <div className="retrieved-list">
        {answer.retrieved.map((item) => (
          <div className="retrieved-item" key={item.number}>
            <span className="num">
              {item.number} straipsnis. {item.heading}
            </span>
            <p className="snippet">{item.snippet}</p>
          </div>
        ))}
      </div>
      <div className="meta-bar">
        <span>Pagal teisės aktų redakciją, galiojančią nuo {answer.as_of_date}</span>
      </div>
    </>
  );
}
