import type { SqlClient } from "../store/sql/client";
import { EMBEDDING_DIM, embed, chunkText } from "./embedding";
import {
  rankChunks,
  toGroundingResult,
  type GroundingResult,
  type KnowledgeDoc,
  type KnowledgeFabric,
  type KnowledgeSourceInfo,
} from "./knowledgeFabric";

// One statement per entry — prepared statements accept a single command each.
const DDL: string[] = [
  `CREATE EXTENSION IF NOT EXISTS vector`,
  `CREATE TABLE IF NOT EXISTS knowledge_sources (
    source_id text PRIMARY KEY,
    title     text NOT NULL,
    domain    text NOT NULL,
    version   text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_chunks (
    source_id text    NOT NULL,
    chunk_no  integer NOT NULL,
    content   text    NOT NULL,
    embedding vector(${EMBEDDING_DIM}) NOT NULL,
    PRIMARY KEY (source_id, chunk_no)
  )`,
];

function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => Number(x.toFixed(6))).join(",")}]`;
}

/**
 * Postgres-backed knowledge fabric (spec §9.3) using pgvector for the ANN pass —
 * embedded PGlite ships the extension, so this runs fully local; a hosted
 * Postgres just needs pgvector installed. Ingested documents persist across
 * restarts alongside the event log (same database, same durability story).
 *
 * Retrieval is hybrid: pgvector cosine ordering fetches a candidate pool, then
 * the shared lexical/hybrid re-ranker (same code as the in-memory fabric) picks
 * the best chunk per source.
 */
export class PgVectorFabric implements KnowledgeFabric {
  private ready?: Promise<void>;

  constructor(
    private readonly client: SqlClient,
    private readonly seed: KnowledgeDoc[] = [],
  ) {}

  private ensureReady(): Promise<void> {
    return (this.ready ??= (async () => {
      for (const stmt of DDL) await this.client.query(stmt);
      const { rows } = await this.client.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM knowledge_sources",
      );
      if ((rows[0]?.n ?? 0) === 0) {
        for (const doc of this.seed) await this.write(doc);
      }
    })());
  }

  private async write(doc: KnowledgeDoc): Promise<KnowledgeSourceInfo> {
    await this.client.query("DELETE FROM knowledge_chunks WHERE source_id = $1", [doc.id]);
    await this.client.query("DELETE FROM knowledge_sources WHERE source_id = $1", [doc.id]);
    await this.client.query(
      "INSERT INTO knowledge_sources (source_id, title, domain, version) VALUES ($1, $2, $3, $4)",
      [doc.id, doc.title, doc.domain, doc.version],
    );
    const chunks = chunkText(doc.text);
    for (let i = 0; i < chunks.length; i++) {
      await this.client.query(
        "INSERT INTO knowledge_chunks (source_id, chunk_no, content, embedding) VALUES ($1, $2, $3, $4::vector)",
        [doc.id, i + 1, chunks[i], toVectorLiteral(embed(chunks[i]!))],
      );
    }
    return { id: doc.id, title: doc.title, domain: doc.domain, version: doc.version, chunks: chunks.length };
  }

  async ingest(doc: KnowledgeDoc): Promise<KnowledgeSourceInfo> {
    await this.ensureReady();
    return this.write(doc);
  }

  async retrieve(query: string, k = 3): Promise<GroundingResult> {
    await this.ensureReady();
    const q = toVectorLiteral(embed(query));
    // ANN pass in Postgres (cosine distance), hybrid re-rank in the shared scorer.
    const { rows } = await this.client.query<{
      source_id: string;
      title: string;
      version: string;
      content: string;
      cos: number;
    }>(
      `SELECT c.source_id, s.title, s.version, c.content,
              1 - (c.embedding <=> $1::vector) AS cos
       FROM knowledge_chunks c
       JOIN knowledge_sources s ON s.source_id = c.source_id
       ORDER BY c.embedding <=> $1::vector
       LIMIT 24`,
      [q],
    );
    const candidates = rows.map((r) => ({
      id: r.source_id,
      title: r.title,
      version: r.version,
      content: r.content,
      cos: Number(r.cos),
    }));
    return toGroundingResult(query, rankChunks(query, candidates, k));
  }

  async listSources(): Promise<KnowledgeSourceInfo[]> {
    await this.ensureReady();
    const { rows } = await this.client.query<KnowledgeSourceInfo & { source_id: string }>(
      `SELECT s.source_id, s.title, s.domain, s.version, COUNT(c.*)::int AS chunks
       FROM knowledge_sources s
       LEFT JOIN knowledge_chunks c ON c.source_id = s.source_id
       GROUP BY s.source_id, s.title, s.domain, s.version
       ORDER BY s.title`,
    );
    return rows.map((r) => ({
      id: r.source_id,
      title: r.title,
      domain: r.domain,
      version: r.version,
      chunks: Number(r.chunks),
    }));
  }

  async isSilentOn(query: string): Promise<boolean> {
    return (await this.retrieve(query, 1)).citations.length === 0;
  }
}
