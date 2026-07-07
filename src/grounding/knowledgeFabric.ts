import type { Citation } from "../domain/types";
import {
  COSINE_FLOOR,
  chunkText,
  cosine,
  embed,
  hybridScore,
  lexicalOverlap,
  sharedTokenCount,
  tokenize,
} from "./embedding";

/** A document handed to the fabric for indexing (the ingestion path, §9.3). */
export interface KnowledgeDoc {
  /** Stable id; re-ingesting the same id replaces the source (new version). */
  id: string;
  title: string;
  domain: "brand" | "product" | "market" | "history";
  version: string;
  text: string;
}

export interface KnowledgeSourceInfo {
  id: string;
  title: string;
  domain: string;
  version: string;
  chunks: number;
}

export interface GroundingResult {
  citations: Citation[];
  /** Concatenated retrieved context an agent injects into its prompt. */
  context: string;
}

/**
 * The Hilti knowledge fabric (spec §9.3): brand system & tone, product data,
 * prior campaigns & performance, market/regulatory rules — chunked, embedded,
 * and retrievable via hybrid (vector + lexical) search, with citations and
 * source versioning for lineage. Implementations: in-memory (tests, scripts)
 * and Postgres/pgvector (the server — ingested docs survive restarts).
 */
export interface KnowledgeFabric {
  /** Retrieve the top-k most relevant sources for a query, with citations. */
  retrieve(query: string, k?: number): Promise<GroundingResult>;
  /** Index (or replace, by id) a document: chunk → embed → store. */
  ingest(doc: KnowledgeDoc): Promise<KnowledgeSourceInfo>;
  /** List indexed sources (Admin console → Knowledge fabric). */
  listSources(): Promise<KnowledgeSourceInfo[]>;
  /** "No generic drift" (§9.3): true when nothing relevant exists for a query. */
  isSilentOn(query: string): Promise<boolean>;
}

interface ScoredChunk {
  doc: { id: string; title: string; version: string };
  content: string;
  score: number;
}

/** Shared ranking: score chunks, keep the best chunk per source, top-k sources. */
export function rankChunks(
  query: string,
  chunks: { id: string; title: string; version: string; content: string; cos: number }[],
  k: number,
): ScoredChunk[] {
  const qTokens = tokenize(query);
  const bySource = new Map<string, ScoredChunk>();
  for (const c of chunks) {
    const shared = sharedTokenCount(qTokens, c.content);
    // Recall gate: a lexical hit (keyword-era behaviour) OR a strong semantic match.
    if (shared < 1 && c.cos < COSINE_FLOOR) continue;
    const score = hybridScore(c.cos, lexicalOverlap(qTokens, c.content));
    const existing = bySource.get(c.id);
    if (!existing || score > existing.score) {
      bySource.set(c.id, { doc: { id: c.id, title: c.title, version: c.version }, content: c.content, score });
    }
  }
  return [...bySource.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

/** Relevance-aware snippet: a window around the first query-term match in the chunk. */
function makeSnippet(query: string, content: string, len = 160): string {
  const lower = content.toLowerCase();
  let first = -1;
  for (const t of new Set(tokenize(query))) {
    const p = lower.indexOf(t);
    if (p >= 0 && (first < 0 || p < first)) first = p;
  }
  if (first < 0) return content.slice(0, len);
  const start = Math.max(0, first - Math.floor(len / 3));
  return (start > 0 ? "…" : "") + content.slice(start, start + len);
}

export function toGroundingResult(query: string, ranked: ScoredChunk[]): GroundingResult {
  return {
    citations: ranked.map((r) => ({
      sourceId: r.doc.id,
      title: r.doc.title,
      version: r.doc.version,
      snippet: makeSnippet(query, r.content),
    })),
    context: ranked
      .map((r) => `[${r.doc.id} v${r.doc.version}] ${r.doc.title}\n${r.content}`)
      .join("\n\n"),
  };
}

/** In-memory vector fabric — same chunk/embed/hybrid pipeline, JS-scored. */
export class InMemoryVectorFabric implements KnowledgeFabric {
  private readonly sources = new Map<
    string,
    { doc: Omit<KnowledgeDoc, "text">; chunks: { content: string; embedding: number[] }[] }
  >();

  constructor(seed: KnowledgeDoc[] = []) {
    for (const doc of seed) this.ingestSync(doc);
  }

  private ingestSync(doc: KnowledgeDoc): KnowledgeSourceInfo {
    const chunks = chunkText(doc.text).map((content) => ({ content, embedding: embed(content) }));
    this.sources.set(doc.id, {
      doc: { id: doc.id, title: doc.title, domain: doc.domain, version: doc.version },
      chunks,
    });
    return { id: doc.id, title: doc.title, domain: doc.domain, version: doc.version, chunks: chunks.length };
  }

  async ingest(doc: KnowledgeDoc): Promise<KnowledgeSourceInfo> {
    return this.ingestSync(doc);
  }

  async retrieve(query: string, k = 3): Promise<GroundingResult> {
    const q = embed(query);
    const candidates: { id: string; title: string; version: string; content: string; cos: number }[] = [];
    for (const { doc, chunks } of this.sources.values()) {
      for (const c of chunks) {
        candidates.push({ id: doc.id, title: doc.title, version: doc.version, content: c.content, cos: cosine(q, c.embedding) });
      }
    }
    return toGroundingResult(query, rankChunks(query, candidates, k));
  }

  async listSources(): Promise<KnowledgeSourceInfo[]> {
    return [...this.sources.values()].map(({ doc, chunks }) => ({
      id: doc.id,
      title: doc.title,
      domain: doc.domain,
      version: doc.version,
      chunks: chunks.length,
    }));
  }

  async isSilentOn(query: string): Promise<boolean> {
    return (await this.retrieve(query, 1)).citations.length === 0;
  }
}

/** Seed corpus standing in for Hilti's grounding sources during MVP-1 bring-up. */
export function seedHiltiKnowledge(): KnowledgeDoc[] {
  return [
    {
      id: "brand-tov-01",
      title: "Hilti tone of voice",
      version: "2024.3",
      domain: "brand",
      text: "Confident, expert, direct. Speak to professional trades. Emphasise productivity, durability and jobsite uptime. Avoid hype; lead with proof.",
    },
    {
      id: "prod-cordless-22v",
      title: "Nuron 22V cordless platform",
      version: "1.2",
      domain: "product",
      text: "One battery platform across the fleet. Positioning: no downtime, no compromise. Approved claim: extended runtime with active temperature management. Mandatory: cordless performance claims require test-condition footnote.",
    },
    {
      id: "market-dach-reg",
      title: "DACH marketing regulation notes",
      version: "2025.1",
      domain: "market",
      text: "Comparative advertising permitted with substantiation. Environmental claims must be specific and evidenced. German-language transcreation required, not literal translation.",
    },
    {
      id: "hist-q3-launch",
      title: "Prior cordless launch performance",
      version: "2024.4",
      domain: "history",
      text: "Uptime-led messaging outperformed price-led by 34% CTR in paid social. Email hero with jobsite imagery drove strongest open rates.",
    },
    {
      id: "market-media-benchmarks",
      title: "Media cost & pacing benchmarks",
      version: "2025.2",
      domain: "market",
      text: "Paid-social CPM benchmarks by market for budget allocation. Recommended front-loaded pacing at launch, then even. Per-market daily spend caps act as budget guardrails; typical allocation splits spend across paid, email and landing.",
    },
  ];
}
