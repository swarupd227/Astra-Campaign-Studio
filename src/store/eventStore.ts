import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CampaignEvent, CampaignEventBody } from "../domain/events";
import type { Actor } from "../domain/types";

/**
 * Append-only event store — the immutable spine of the platform (spec §11.2).
 * Events are never mutated or deleted; state is always a fold over the log.
 *
 * The interface is persistence-agnostic. M0 ships an in-memory store (tests)
 * and a JSON-file store (the demo). Swapping in Postgres later means one class,
 * not a rewrite of the domain.
 */
export interface EventStore {
  /**
   * Append one event to a campaign's stream. `expectedRevision` provides
   * optimistic concurrency: pass the revision you read, or -1 to skip the check.
   * Returns the persisted, sequence-stamped event.
   */
  append(
    campaignId: string,
    body: CampaignEventBody,
    actor: Actor,
    expectedRevision: number,
  ): Promise<CampaignEvent>;

  /** Read a campaign's full event stream in order. */
  read(campaignId: string): Promise<CampaignEvent[]>;

  /** List all campaign ids known to the store. */
  listCampaigns(): Promise<string[]>;
}

abstract class BaseEventStore implements EventStore {
  constructor(protected readonly now: () => string) {}

  protected abstract loadStream(campaignId: string): Promise<CampaignEvent[]>;
  protected abstract saveStream(campaignId: string, events: CampaignEvent[]): Promise<void>;
  abstract listCampaigns(): Promise<string[]>;

  async append(
    campaignId: string,
    body: CampaignEventBody,
    actor: Actor,
    expectedRevision: number,
  ): Promise<CampaignEvent> {
    const stream = await this.loadStream(campaignId);
    if (expectedRevision !== -1 && stream.length !== expectedRevision) {
      throw new ConcurrencyError(campaignId, expectedRevision, stream.length);
    }
    const event: CampaignEvent = {
      seq: stream.length + 1,
      campaignId,
      at: this.now(),
      actor,
      body,
    };
    stream.push(event);
    await this.saveStream(campaignId, stream);
    return event;
  }

  async read(campaignId: string): Promise<CampaignEvent[]> {
    return this.loadStream(campaignId);
  }
}

export class ConcurrencyError extends Error {
  constructor(campaignId: string, expected: number, actual: number) {
    super(
      `Concurrency conflict on campaign ${campaignId}: expected revision ${expected}, store is at ${actual}`,
    );
    this.name = "ConcurrencyError";
  }
}

/** In-memory store — fast, ephemeral, used by tests. */
export class InMemoryEventStore extends BaseEventStore {
  private readonly streams = new Map<string, CampaignEvent[]>();

  protected async loadStream(campaignId: string): Promise<CampaignEvent[]> {
    return [...(this.streams.get(campaignId) ?? [])];
  }

  protected async saveStream(campaignId: string, events: CampaignEvent[]): Promise<void> {
    this.streams.set(campaignId, events);
  }

  async listCampaigns(): Promise<string[]> {
    return [...this.streams.keys()];
  }
}

/** JSON-file store — one file per campaign stream under `dir`. */
export class FileEventStore extends BaseEventStore {
  constructor(
    private readonly dir: string,
    now: () => string,
  ) {
    super(now);
  }

  private streamPath(campaignId: string): string {
    return join(this.dir, `${campaignId}.events.json`);
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
  }

  protected async loadStream(campaignId: string): Promise<CampaignEvent[]> {
    const path = this.streamPath(campaignId);
    if (!existsSync(path)) return [];
    return JSON.parse(await readFile(path, "utf8")) as CampaignEvent[];
  }

  protected async saveStream(campaignId: string, events: CampaignEvent[]): Promise<void> {
    await this.ensureDir();
    await writeFile(this.streamPath(campaignId), JSON.stringify(events, null, 2), "utf8");
  }

  async listCampaigns(): Promise<string[]> {
    await this.ensureDir();
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(this.dir);
    return files
      .filter((f) => f.endsWith(".events.json"))
      .map((f) => f.replace(/\.events\.json$/, ""));
  }
}
