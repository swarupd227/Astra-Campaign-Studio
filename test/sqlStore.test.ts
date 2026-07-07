import { describe, expect, it } from "vitest";
import { Astra } from "../src/app";
import { fixedClock } from "../src/domain/ids";
import { Stage, type Actor } from "../src/domain/types";
import { agentsForStage } from "../src/agents/catalogue";
import { SqlEventStore } from "../src/store/sql/sqlEventStore";
import { createPgliteClient } from "../src/store/sql/client";
import { ConcurrencyError } from "../src/store/eventStore";
import { CampaignRepository } from "../src/store/campaignRepository";
import type { Campaign } from "../src/domain/types";

const human: Actor = { kind: "human", id: "u1", displayName: "Tester" };
const clock = fixedClock("2026-01-01T00:00:00Z");

function memStore() {
  return new SqlEventStore(createPgliteClient(":memory:"), () => clock.now());
}

function sampleCampaign(id: string): Campaign {
  return {
    id,
    objective: "Launch cordless platform",
    owner: "u1",
    markets: ["DE"],
    budget: 1000,
    currency: "EUR",
    status: "active",
    currentStage: Stage.Intake,
    kpis: ["CTR"],
    createdAt: clock.now(),
  };
}

describe("SqlEventStore (embedded Postgres via PGlite)", () => {
  it("appends and reads back an ordered, sequence-stamped stream", async () => {
    const store = memStore();
    const c = sampleCampaign("camp_a");
    const e1 = await store.append("camp_a", { type: "CampaignCreated", campaign: c }, human, 0);
    expect(e1.seq).toBe(1);
    const events = await store.read("camp_a");
    expect(events).toHaveLength(1);
    expect(events[0]!.body.type).toBe("CampaignCreated");
    expect(events[0]!.actor.displayName).toBe("Tester");
  });

  it("enforces optimistic concurrency on the expected revision", async () => {
    const store = memStore();
    await store.append("camp_b", { type: "CampaignCreated", campaign: sampleCampaign("camp_b") }, human, 0);
    // Appending again with a stale expected revision (0) must be rejected.
    await expect(
      store.append("camp_b", { type: "StageGateBlocked", stage: Stage.Intake, reason: "x" }, human, 0),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    // With the correct revision (1) it succeeds.
    const ok = await store.append("camp_b", { type: "StageGateBlocked", stage: Stage.Intake, reason: "x" }, human, 1);
    expect(ok.seq).toBe(2);
  });

  it("append with expectedRevision -1 skips the check (audit events)", async () => {
    const store = memStore();
    await store.append("camp_c", { type: "CampaignCreated", campaign: sampleCampaign("camp_c") }, human, 0);
    const e = await store.append(
      "camp_c",
      { type: "ConnectorInvoked", connector: "figma", tool: "map_content", effect: "write", summary: "x" },
      { kind: "system", id: "mcp", displayName: "MCP" },
      -1,
    );
    expect(e.seq).toBe(2);
  });

  it("lists distinct campaign ids", async () => {
    const store = memStore();
    await store.append("camp_d", { type: "CampaignCreated", campaign: sampleCampaign("camp_d") }, human, 0);
    await store.append("camp_e", { type: "CampaignCreated", campaign: sampleCampaign("camp_e") }, human, 0);
    expect((await store.listCampaigns()).sort()).toEqual(["camp_d", "camp_e"]);
  });

  it("the repository fold works identically over the SQL stream", async () => {
    const store = memStore();
    await store.append("camp_f", { type: "CampaignCreated", campaign: sampleCampaign("camp_f") }, human, 0);
    const obj = await new CampaignRepository(store).load("camp_f");
    expect(obj?.campaign.currentStage).toBe(Stage.Intake);
    expect(obj?.revision).toBe(1);
  });
});

describe("Astra on the SQL backend", () => {
  it("runs the full lifecycle end to end on Postgres", async () => {
    const astra = new Astra({ persistence: "sql", dataDir: ":memory:", clock, campaignTokenBudget: 0 });
    const id = await astra.createCampaign(
      { objective: "Launch cordless platform", owner: human.id, markets: ["DE", "US"], budget: 750_000, currency: "EUR", kpis: ["Qualified leads"] },
      human,
    );
    const orch = astra.stageOrchestrator(async () => ({ approve: true, actor: human }));
    for (let i = 0; i < 8; i++) {
      const obj = await astra.repo.load(id);
      if (agentsForStage(obj!.campaign.currentStage).length === 0) break;
      const report = await orch.runCurrentStage(id);
      if (!report.advancedTo) break; // terminal stage
    }
    const obj = await astra.repo.load(id);
    expect(obj?.campaign.currentStage).toBe(Stage.ContentOptimisation);
    // Canvas projection reads straight from the Postgres-backed log.
    const canvas = await astra.canvas(id);
    expect(canvas!.telemetry.artifacts).toBeGreaterThanOrEqual(40);
    expect(canvas!.telemetry.evalPassRate).toBe(1);
  });
});
