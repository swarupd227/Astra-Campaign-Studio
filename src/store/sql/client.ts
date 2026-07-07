import { createRequire } from "node:module";

// The project is ESM; `require` isn't defined. createRequire gives us lazy,
// synchronous loading of the optional native/WASM backends without top-level import.
const require = createRequire(import.meta.url);

/**
 * A minimal SQL client abstraction shared by the embedded (PGlite) and the
 * production (node-postgres) backends. Both speak the same parameterised-query
 * shape (`$1`, `$2`, …) and return `{ rows }`, so the SqlEventStore is written
 * once and runs unchanged against PGlite in dev/test and real Postgres in prod.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

/**
 * Embedded Postgres via PGlite (WASM) — the default. No external server; pass a
 * directory to persist to disk, or ":memory:"/undefined for an ephemeral store
 * (tests). Constructed synchronously; queries await PGlite's internal readiness.
 */
export function createPgliteClient(dir?: string): SqlClient {
  // Lazy require keeps startup cheap and avoids loading WASM unless SQL is used.
  const { PGlite } = require("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
  // PGlite bundles pgvector; loading it here lets the knowledge fabric CREATE EXTENSION.
  const { vector } = require("@electric-sql/pglite/vector");
  const persistent = Boolean(dir && dir !== ":memory:");
  if (persistent) {
    // PGlite mkdirs its data dir non-recursively; ensure the parents exist first.
    require("node:fs").mkdirSync(dir, { recursive: true });
  }
  const db = persistent
    ? new PGlite(dir, { extensions: { vector } })
    : new PGlite({ extensions: { vector } });
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const res = await db.query<T>(sql, params);
      return { rows: res.rows };
    },
    async close() {
      await db.close();
    },
  };
}

/**
 * Production Postgres via node-postgres. Enabled by setting DATABASE_URL; `pg`
 * is an optional dependency and imported lazily so dev/test never needs it.
 */
export function createPgClient(connectionString: string): SqlClient {
  let pg: any;
  try {
    pg = require("pg");
  } catch {
    throw new Error("DATABASE_URL is set but the 'pg' package is not installed. Run `npm install pg`.");
  }
  const pool = new pg.Pool({ connectionString });
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async close() {
      await pool.end();
    },
  };
}
