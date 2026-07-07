import type { CampaignEvent, CampaignEventBody } from "../../domain/events";
import type { Actor } from "../../domain/types";
import { ConcurrencyError, type EventStore } from "../eventStore";
import type { SqlClient } from "./client";

const DDL = `
CREATE TABLE IF NOT EXISTS campaign_events (
  campaign_id text    NOT NULL,
  seq         integer NOT NULL,
  at          text    NOT NULL,
  actor       jsonb   NOT NULL,
  body        jsonb   NOT NULL,
  PRIMARY KEY (campaign_id, seq)
);`;

interface EventRow {
  seq: number;
  at: string;
  actor: Actor;
  body: CampaignEventBody;
}

/**
 * Postgres-backed event store — the production spine (spec §11.2/§12). It is the
 * same append-only log as the in-memory/file stores, now durable and queryable.
 * The event stream is the source of truth; state is always a fold over it.
 *
 * Optimistic concurrency is enforced in a single INSERT: the next seq is computed
 * as MAX(seq)+1 for the campaign, guarded by the caller's expected revision, and
 * backstopped by the (campaign_id, seq) primary key — so two racing appends can
 * never both win.
 */
export class SqlEventStore implements EventStore {
  private ready?: Promise<void>;

  constructor(
    private readonly client: SqlClient,
    private readonly now: () => string,
  ) {}

  /** Run the schema migration once, lazily, on first use. */
  private ensureReady(): Promise<void> {
    return (this.ready ??= this.client.query(DDL).then(() => undefined));
  }

  async append(
    campaignId: string,
    body: CampaignEventBody,
    actor: Actor,
    expectedRevision: number,
  ): Promise<CampaignEvent> {
    await this.ensureReady();
    const at = this.now();
    const guard = expectedRevision === -1 ? "" : "HAVING COALESCE(MAX(seq), 0) = $5";
    const params: unknown[] = [campaignId, at, JSON.stringify(actor), JSON.stringify(body)];
    if (expectedRevision !== -1) params.push(expectedRevision);

    const sql = `
      INSERT INTO campaign_events (campaign_id, seq, at, actor, body)
      SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3::jsonb, $4::jsonb
      FROM campaign_events WHERE campaign_id = $1
      ${guard}
      RETURNING seq`;

    let rows: { seq: number }[];
    try {
      rows = (await this.client.query<{ seq: number }>(sql, params)).rows;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const actual = await this.revision(campaignId);
        throw new ConcurrencyError(campaignId, expectedRevision, actual);
      }
      throw err;
    }

    // Guard filtered the row out → the expected revision didn't match.
    if (rows.length === 0) {
      const actual = await this.revision(campaignId);
      throw new ConcurrencyError(campaignId, expectedRevision, actual);
    }

    return { seq: rows[0]!.seq, campaignId, at, actor, body };
  }

  async read(campaignId: string): Promise<CampaignEvent[]> {
    await this.ensureReady();
    const { rows } = await this.client.query<EventRow>(
      "SELECT seq, at, actor, body FROM campaign_events WHERE campaign_id = $1 ORDER BY seq ASC",
      [campaignId],
    );
    return rows.map((r) => ({
      seq: r.seq,
      campaignId,
      at: r.at,
      actor: parse<Actor>(r.actor),
      body: parse<CampaignEventBody>(r.body),
    }));
  }

  async listCampaigns(): Promise<string[]> {
    await this.ensureReady();
    const { rows } = await this.client.query<{ campaign_id: string }>(
      "SELECT DISTINCT campaign_id FROM campaign_events",
    );
    return rows.map((r) => r.campaign_id);
  }

  private async revision(campaignId: string): Promise<number> {
    const { rows } = await this.client.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM campaign_events WHERE campaign_id = $1",
      [campaignId],
    );
    return rows[0]?.n ?? 0;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** jsonb columns come back parsed from pg/PGlite, but tolerate a string too. */
function parse<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "23505" || /duplicate key|unique constraint/i.test(String((err as Error)?.message));
}
