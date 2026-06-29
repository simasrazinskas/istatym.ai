# Embeddings, Chunking, Grounding, and Evaluation

Supports decisions D6 and D9.
Treat all public embedding rankings as priors, not answers — none test Lithuanian legal IR.

## The single most important finding

There is **no Lithuanian-specific dense retrieval model** and **no Lithuanian legal retrieval benchmark**.
Lithuanian-native models (LitLat BERT, LT-MLKM-modernBERT, GloVe) are masked-LM encoders or static vectors, not retrievers without contrastive fine-tuning.
The headline numbers vendors quote (MIRACL) **exclude Lithuanian entirely**.
The only benchmark with real Lithuanian retrieval tasks is **MMTEB**, and even it is bitext/FAQ-heavy, not legal.
Conclusion: we must build our own small Lithuanian legal eval set.

## Embedding models (shortlist)

- **BGE-M3** — https://huggingface.co/BAAI/bge-m3 — open (MIT), self-host, 8,192 context, 1,024 dims; XLM-R backbone with `lt` explicitly in training; unique dense+sparse+ColBERT hybrid output helps morphology and exact legal terms. **Our default.**
- **Gemini `gemini-embedding-001`** — https://ai.google.dev/gemini-api/docs/embeddings — #1 on MTEB Multilingual at launch; managed API; ~2,048-token context. The bake-off baseline to beat BGE-M3 against.
- **Qwen3-Embedding (8B/4B/0.6B)** — https://huggingface.co/Qwen/Qwen3-Embedding-8B — #1 open on MTEB Multilingual; Apache-2.0; 32K context.
- **multilingual-e5-large-instruct** — open, cheap, but 512-token cap forces fine chunking.
- **Jina embeddings v3** — 89 languages incl. Lithuanian; CC-BY-NC weights (licensing caveat) + API.
- **Avoid as defaults:** OpenAI text-embedding-3-large, Cohere embed-v4.0, Voyage — they publish **zero** Lithuanian evidence. EuroBERT does **not** cover Lithuanian.

## Rerankers (shortlist)

- **BGE-reranker-v2-m3** — https://huggingface.co/BAAI/bge-reranker-v2-m3 — open (Apache-2.0), 512 context, same `lt`-listing lineage as bge-m3. Default.
- **Cohere Rerank v3.5** — https://docs.cohere.com/docs/rerank — the only commercial API that explicitly names Lithuanian; 4,096 context. API alternative.
- **Qwen3-Reranker (4B/8B)** — open, 32K context; best long-context open reranker.
- Weaker fit: Jina-reranker-v2 (CC-BY-NC — commercial blocker; 1,024 cap); mxbai / Voyage (do not name Lithuanian).

## Multilingual vs fine-tuning

A strong multilingual model is good enough to ship and to bootstrap eval data, but fine-tuning is genuinely worth it for low-resource morphologically-rich Lithuanian legal text.
Evidence: fine-tuning mE5 on a low-resource language with ~10k noisy synthetic pairs (<$20) lifted retrieval substantially in one study — but the authors caution this may transfer less for Latin-script, heavily-inflected languages, which is exactly Lithuanian, so validate rather than assume.
Path: start multilingual off-the-shelf, then contrastively fine-tune the winner on cheap synthetic Lithuanian legal query/passage pairs (LT-MLKM-modernBERT is the alternative fine-tuning base).

## Asymmetric retrieval (casual query → formal legal doc)

One shared model/checkpoint for both sides is mandatory (a dense bi-encoder needs queries and docs in the same space; "asymmetric" means short-query/long-doc, not two models).
Use the correct query/document prefixes (e5 `query:`/`passage:`, BGE query instruction) — getting these wrong silently degrades results.
Lithuanian morphology taxes tokenizers (~2.86 tokens/word, ~2.3× English), fragmenting meaning and hurting retrieval.
Highest-ROI defenses, in order: hybrid lemmatized BM25 + dense fused with RRF → cross-encoder reranker → cheap LLM query rewrite (colloquial → formal legal Lithuanian). Treat HyDE as an A/B only — it can hurt precise queries.

## Chunking (benchmarked heuristics)

- Dual-granularity: embed paragraph/`punktas` leaves, keep `straipsnis` as parent/citation unit, auto-merge small-to-big (LlamaIndex `HierarchicalNodeParser` + `AutoMergingRetriever`). Article+paragraph beats either alone.
- Prepend a deterministic structural breadcrumb to every chunk before embedding (this is Summary-Augmented Chunking done losslessly; it halves document-level retrieval mismatch and provides free citations).
- Use contextualized-chunk embeddings only via open options (ConTEB/InSeNT) if desired — do **not** take a Voyage dependency for Lithuanian; the breadcrumb gives most of the benefit deterministically with any embedder.
- Config: primary unit = article; leaf ceiling ~512–1024 tokens; floor ~200–300 (merge tiny definitions within the same parent only, never across a citation boundary); split oversized articles by native `dalis`→`punktas`, recursive-char split only as fallback; overlap 0 on clean structural boundaries; assert `tokens <= 0.9 × model_limit` to prevent silent truncation (Vertex silently truncates >2,048 unless `autoTruncate=false`; OpenAI caps at 8,191).
- Skip semantic chunking for statutes — the boundaries already exist; it does not justify its ~10–14× cost.
- Parsing libraries: Docling (https://github.com/docling-project/docling, PDF/DOCX) + unstructured (HTML) self-hosted; avoid cloud parsers that send legal text off-infra. Note Lithuania does not publish Akoma Ntoso XML, so AKN parsers cannot ingest TAR directly — use the JSON/text we have and align the internal schema to AKN/FRBR.

## Grounding (hard requirement)

- Even best-in-class commercial legal RAG hallucinates: Stanford RegLab found Lexis+AI and Ask Practical Law >17%, Westlaw AI >34%. The dangerous mode is the **"misgrounded" citation** — a plausible cite that does not support the claim — which is exactly our article-level risk.
- Adopt **grounding by construction** (BigLaw pattern, https://github.com/discover-legal/BigLaw): the agent copies evidence verbatim and verifies each quote is a substring of the source before any analysis; paraphrases are discarded before becoming citations (reported ~94% verbatim-citation accuracy vs ~0% without).
- Add a SelfCite-style ablation/offset check as a gate. The Anthropic Citations API returns machine-checkable `cited_text` spans with char offsets if we use a Claude answer model.
- Treat grounding as verified, not trusted.

## Evaluation plan

1. Build a ~150–300 query Lithuanian legal eval set on the employment vertical: corpus = Darbo kodeksas + EUR-Lex Lithuanian; generate casual Lithuanian questions with an LLM, then human-check gold passages. Seed cheaply with EUR-Lex-Sum `lt` summary→act pairs as ready positives.
2. Baseline 3 embedders out-of-the-box (BGE-M3 vs Gemini-001 vs Qwen3-Embedding): report nDCG@10, Recall@20, MRR.
3. Add lemmatized BM25 + RRF hybrid, then a reranker (BGE-reranker-v2-m3 / Cohere v3.5) on top-k; measure lift at each stage.
4. Measure span-level citation fidelity in the LegalBench-RAG shape (https://github.com/zeroentropy-ai/legalbenchrag); watch GreekBarBench as a civil-law, statute-centric analog.
5. If retrieval is short of target, contrastively fine-tune the winner on synthetic Lithuanian legal pairs and re-measure (expect morphology to cap the gain).

## Datasets

- EUR-Lex-Sum (`dennlinger/eur-lex-sum`) — doc↔summary pairs incl. ~1.3–1.8k Lithuanian; the most reusable signal for eval bootstrap + fine-tuning.
- MultiEURLEX (`coastalcph/multi_eurlex`) — 65k EU laws with EUROVOC labels and a `lt` split; weak positives via shared labels.
- TAR open data (data.gov.lt/datasets/2613) — national Lithuanian law (documents only, no queries).
- LT-MLKM-modernBERT (`VSSA-SDSA/LT-MLKM-modernBERT`) — state-backed Lithuanian ModernBERT trained on legal text; best base to fine-tune a Lithuanian legal retriever later (not itself a retriever).

## Caveat

Several very recent (2026) arXiv ids surfaced during research (e.g. "Legal-DC 2603.11772", "LEMUR 2602.09570", "LegalCiteBench 2605.10186") were not independently verified — do not treat them as load-bearing until checked.
