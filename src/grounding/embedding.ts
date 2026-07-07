/**
 * Local embedding + chunking primitives for the knowledge fabric (spec §9.3).
 *
 * The embedder is deterministic feature hashing over word uni/bigrams into a
 * fixed-dimension L2-normalised vector — real vector-retrieval infrastructure
 * (chunk → embed → store → cosine search) with zero network dependency, so the
 * whole pipeline runs offline and reproducibly. It is a seam: swap in a hosted
 * embedding model (Voyage/Azure OpenAI) behind the same signature without
 * touching storage or retrieval.
 */

export const EMBEDDING_DIM = 256;

/** Light plural stemming so "guardrails" matches "guardrail", "claims" "claim", etc. */
function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/** Same tokenizer everywhere (embedder, lexical overlap) so scoring is coherent. */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .map(stem);
}

/** FNV-1a 32-bit — stable, fast, dependency-free. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Embed text into a normalised EMBEDDING_DIM vector via signed feature hashing. */
export function embed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  const toks = tokenize(text);
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    const idx = h % EMBEDDING_DIM;
    const sign = (h >>> 8) & 1 ? 1 : -1; // second hash bit as sign to reduce collision bias
    v[idx]! += sign * weight;
  };
  for (const t of toks) add(t, 1);
  for (let i = 0; i < toks.length - 1; i++) add(`${toks[i]}_${toks[i + 1]}`, 0.5);
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

/** Cosine similarity — a plain dot product, since embeddings are normalised. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/** Split a document into retrieval-sized chunks on sentence boundaries. */
export function chunkText(text: string, maxLen = 420): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > maxLen) {
      chunks.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
    while (cur.length > maxLen) {
      chunks.push(cur.slice(0, maxLen));
      cur = cur.slice(maxLen).trim();
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Fraction of the query's unique tokens present in the text (recall-oriented). */
export function lexicalOverlap(queryTokens: string[], text: string): number {
  const unique = [...new Set(queryTokens)];
  if (!unique.length) return 0;
  const set = new Set(tokenize(text));
  return unique.filter((t) => set.has(t)).length / unique.length;
}

/** Count of shared query tokens — the recall gate (≥1 keeps keyword-era recall). */
export function sharedTokenCount(queryTokens: string[], text: string): number {
  const set = new Set(tokenize(text));
  return [...new Set(queryTokens)].filter((t) => set.has(t)).length;
}

/** Hybrid relevance: semantic similarity blended with exact lexical overlap (§9.3 "hybrid"). */
export function hybridScore(cos: number, lexical: number): number {
  return 0.6 * cos + 0.4 * lexical;
}

/** Minimum cosine for a zero-lexical-overlap chunk to still count as relevant. */
export const COSINE_FLOOR = 0.35;
