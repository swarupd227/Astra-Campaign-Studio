import { describe, expect, it } from "vitest";
import { Astra } from "../src/app";
import { fixedClock } from "../src/domain/ids";
import { ArtifactKind, ArtifactStatus, Stage, type Actor } from "../src/domain/types";
import { agentsForStage } from "../src/agents/catalogue";
import {
  budgetReallocationAgent,
  performanceManagementAgent,
  performanceOptimisationAgent,
} from "../src/agents/optimisation";
import { PUBLISHING_SCOPES } from "../src/integrations/publishing";
import { GovernanceError } from "../src/integrations/mcp";
import { gateStatus } from "../src/orchestration/stateMachine";

const human: Actor = { kind: "human", id: "u1", displayName: "Tester" };
const ops: Actor = { kind: "human", id: "u_ops", displayName: "Marketing Ops", role: "marketing-ops" };

function newAstra() {
  return new Astra({ persistence: "memory", clock: fixedClock("2026-01-01T00:00:00Z"), campaignTokenBudget: 0 });
}

async function seed(astra: Astra): Promise<string> {
  return astra.createCampaign(
    { objective: "Launch cordless platform", owner: human.id, markets: ["DE", "US"], budget: 750_000, currency: "EUR", kpis: ["Qualified leads"] },
    human,
  );
}

/** Drive the campaign forward (auto-approving) until it reaches `target`. */
async function advanceTo(astra: Astra, campaignId: string, target: Stage): Promise<void> {
  const orch = astra.stageOrchestrator(async () => ({ approve: true, actor: human, note: "ok" }));
  for (let i = 0; i < 10; i++) {
    const obj = await astra.repo.load(campaignId);
    if (obj!.campaign.currentStage === target) return;
    await orch.runCurrentStage(campaignId);
  }
  throw new Error(`never reached ${target}`);
}

describe("MVP-2 — the full chain runs end to end", () => {
  it("advances brief → … → content optimisation (terminal)", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    const orch = astra.stageOrchestrator(async () => ({ approve: true, actor: human, note: "ok" }));
    for (let i = 0; i < 8; i++) {
      const obj = await astra.repo.load(id);
      if (agentsForStage(obj!.campaign.currentStage).length === 0) break;
      const report = await orch.runCurrentStage(id);
      if (!report.advancedTo) break; // terminal stage
    }
    const obj = await astra.repo.load(id);
    expect(obj?.campaign.currentStage).toBe(Stage.ContentOptimisation);

    const byKindStage = (kind: string, stage: Stage) =>
      Object.values(obj!.artifacts).filter((a) => a.kind === kind && a.stage === stage && a.status === ArtifactStatus.Approved);
    expect(byKindStage(ArtifactKind.Deployment, Stage.Rollout).length).toBeGreaterThanOrEqual(3);
    expect(byKindStage(ArtifactKind.Metric, Stage.CampaignOptimisation).length).toBeGreaterThanOrEqual(1);
    expect(byKindStage(ArtifactKind.Learning, Stage.ContentOptimisation).length).toBe(1);
    // Refreshed content re-passed the brand/compliance/accessibility gates (§6.6).
    expect(byKindStage(ArtifactKind.ContentItem, Stage.ContentOptimisation).length).toBeGreaterThanOrEqual(2);
  });

  it("stage gates are stage-scoped: stage-3 content can't satisfy stage 6", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.ContentOptimisation);
    const obj = await astra.repo.load(id);
    // Approved stage-3 content items exist, but the stage-6 gate is still open.
    const stage3Items = Object.values(obj!.artifacts).filter(
      (a) => a.kind === ArtifactKind.ContentItem && a.stage === Stage.ContentCreation && a.status === ArtifactStatus.Approved,
    );
    expect(stage3Items.length).toBeGreaterThan(0);
    expect(gateStatus(obj!).satisfied).toBe(false);
  });
});

describe("go-live governance (spec §6.4)", () => {
  it("registry refuses an irreversible publish without the explicit approval flag", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await expect(
      astra.connectors.invoke("ads", "launch_campaign", { title: "x" }, { campaignId: id, actor: ops, grantedScopes: PUBLISHING_SCOPES }),
    ).rejects.toBeInstanceOf(GovernanceError);
  });

  it("go-live is blocked without a passing, approved consent check — then executes", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.Rollout);

    // Run the roll-out agents but approve nothing yet.
    for (const agent of agentsForStage(Stage.Rollout)) await astra.orchestrator.runAgent(id, agent);
    await expect(astra.goLive(id, ops)).rejects.toThrow(/consent/i);

    // Approve everything in review at roll-out (Marketing Ops has authority).
    const obj = await astra.repo.load(id);
    for (const a of Object.values(obj!.artifacts)) {
      if (a.stage === Stage.Rollout && a.status === ArtifactStatus.InReview) {
        await astra.orchestrator.approve(id, a.id, ops);
      }
    }
    const { executed } = await astra.goLive(id, ops);
    const systems = executed.map((e) => e.system).sort();
    expect(systems).toEqual(["ads", "contentful", "dam", "sfmc"]);

    // Every publish is an audited, irreversible connector call.
    const events = await astra.store.read(id);
    const irreversible = events.filter((e) => e.body.type === "ConnectorInvoked" && e.body.effect === "irreversible");
    expect(irreversible.length).toBeGreaterThanOrEqual(3);
  });

  it("go-live authority is role-gated", () => {
    expect(astraAccess().canGoLive("marketing-ops").allowed).toBe(true);
    expect(astraAccess().canGoLive("channel-specialist").allowed).toBe(true);
    expect(astraAccess().canGoLive("campaign-manager").allowed).toBe(false);
    expect(astraAccess().canGoLive("creator").allowed).toBe(false);
    function astraAccess() {
      return newAstra().access;
    }
  });
});

describe("bounded autonomy (spec §6.5)", () => {
  it("within-guardrail moves apply automatically at L3; material moves wait for a human", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.CampaignOptimisation);

    // The snapshot comes first (as in the stage run) — moves must trace to metrics.
    const snapshot = await astra.orchestrator.runAgent(id, performanceManagementAgent);
    expect(snapshot.autoApproved).toBe(true); // L3 bounded-auto, lineage to locked KPIs

    const small = await astra.orchestrator.runAgent(id, budgetReallocationAgent);
    expect(small.autoApproved).toBe(true); // 8% shift, inside the 10% guardrail
    expect(small.pendingHumanApproval).toBe(false);

    const material = await astra.orchestrator.runAgent(id, performanceOptimisationAgent);
    expect(material.autoApproved).toBe(false); // 25% shift — human required despite L3
    expect(material.pendingHumanApproval).toBe(true);
    expect(material.reason).toContain("guardrail");
  });
});

describe("Performance & Optimisation surface (spec §8.2)", () => {
  it("aggregates snapshots, KPIs, budget moves and anomalies into one view", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.CampaignOptimisation);
    // Run the optimisation agents WITHOUT a blanket approver, so the governance
    // states stay distinct: L3 auto-applies in-guardrail work, material waits.
    for (const agent of agentsForStage(Stage.CampaignOptimisation)) {
      await astra.orchestrator.runAgent(id, agent);
    }
    // A second snapshot so the trend has two observations (paid-social fatigues).
    const { performanceManagementAgent } = await import("../src/agents/optimisation");
    await astra.orchestrator.runAgent(id, performanceManagementAgent);

    const p = (await astra.performance(id))!;
    expect(p.available).toBe(true);
    expect(p.totals.observations).toBe(2);
    expect(p.kpi.leadTarget).toBe(1200); // locked at planning (§6.1)
    expect(p.kpi.maxCpl).toBe(45);
    expect(p.series.map((s) => s.channel).sort()).toEqual(["email", "landing-page", "paid-social"]);
    // Synthetic fatigue: paid-social CTR declines across observations.
    const paid = p.series.find((s) => s.channel === "paid-social")!;
    expect(paid.points[1]!.ctr).toBeLessThan(paid.points[0]!.ctr);
    // Both budget moves surface, with their governance state visible.
    const applied = p.budgetMoves.filter((m) => m.applied);
    const waiting = p.budgetMoves.filter((m) => !m.applied);
    expect(applied.length).toBeGreaterThanOrEqual(1); // 8% within guardrail
    expect(waiting.length).toBeGreaterThanOrEqual(1); // 25% material move
    expect(p.experiments.length).toBeGreaterThanOrEqual(1);
    expect(p.anomalies.length).toBeGreaterThanOrEqual(1);
  });

  it("reports unavailable before any snapshot exists", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    const p = (await astra.performance(id))!;
    expect(p.available).toBe(false);
  });
});

describe("rollback (spec §6.5 — every optimisation is reversible)", () => {
  const perfMarketer: Actor = { kind: "human", id: "u_pm", displayName: "Petra", role: "performance-marketer" };

  async function appliedMove(astra: Astra, id: string) {
    const { performanceManagementAgent, budgetReallocationAgent } = await import("../src/agents/optimisation");
    await astra.orchestrator.runAgent(id, performanceManagementAgent);
    const move = await astra.orchestrator.runAgent(id, budgetReallocationAgent);
    expect(move.autoApproved).toBe(true);
    return move.artifact;
  }

  it("reverses an applied move: compensating artifact, swapped direction, audited", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.CampaignOptimisation);
    const move = await appliedMove(astra, id);

    const rollback = await astra.rollbackAction(id, move.id, perfMarketer, "CPL worsened after the shift.");
    expect(rollback.title).toBe("Rollback — Budget move — within guardrails");
    expect(rollback.body).toMatchObject({ action: "rollback", from: "email", to: "paid-social", rollbackOf: move.id });
    expect(rollback.derivedFrom).toContain(move.id);

    const obj = await astra.repo.load(id);
    expect(obj!.artifacts[rollback.id]!.status).toBe(ArtifactStatus.Approved); // the human's decision applies

    // The Performance surface reflects both sides of the story.
    const p = (await astra.performance(id, "performance-marketer"))!;
    const original = p.budgetMoves.find((m) => m.id === move.id)!;
    expect(original.rolledBack).toBe(true);
    expect(original.canRollback).toBe(false);
    expect(p.budgetMoves.some((m) => m.isRollback)).toBe(true);

    // A rollback can't be rolled back, and the same move can't be reversed twice.
    await expect(astra.rollbackAction(id, rollback.id, perfMarketer, "x")).rejects.toThrow(/can’t be rolled back/);
    await expect(astra.rollbackAction(id, move.id, perfMarketer, "x")).rejects.toThrow(/already/);
  });

  it("rollback authority follows the RACI — a Creator can't reverse budget moves", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.CampaignOptimisation);
    const move = await appliedMove(astra, id);
    const creator: Actor = { kind: "human", id: "u_cr", displayName: "Cara", role: "creator" };
    await expect(astra.rollbackAction(id, move.id, creator, "x")).rejects.toThrow(/can’t approve/i);
  });
});

describe("experiment readout → apply winner (spec §6.5)", () => {
  it("reads the test out automatically, then a human approves the creative change", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.CampaignOptimisation);
    const { optimisationAgents } = await import("../src/agents/optimisation");

    const results = new Map<string, Awaited<ReturnType<typeof astra.orchestrator.runAgent>>>();
    for (const agent of optimisationAgents) {
      results.set(agent.name, await astra.orchestrator.runAgent(id, agent));
    }

    // The readout applies automatically (bounded-auto), with lineage to the experiment.
    const readout = results.get("Experiment Readout Agent")!;
    expect(readout.autoApproved).toBe(true);
    expect(readout.artifact.body).toMatchObject({ winner: expect.stringContaining("Variant B") });
    expect((await astra.performance(id))!.readouts.length).toBe(1);

    // Applying the winner is a CONTENT change — human approval required (§6.6 no-bypass).
    const apply = results.get("Apply Winner Agent")!;
    expect(apply.pendingHumanApproval).toBe(true);
    expect(apply.evals.some((e) => e.name === "brand-tone" && e.passed)).toBe(true);
    expect(apply.evals.some((e) => e.name === "compliance" && e.passed)).toBe(true);

    const perfMarketer: Actor = { kind: "human", id: "u_pm", displayName: "Petra", role: "performance-marketer" };
    await astra.orchestrator.approve(id, apply.artifact.id, perfMarketer);

    // The winner supersedes the live copy — one active "Paid-social copy" with the new headline.
    const obj = await astra.repo.load(id);
    const copies = Object.values(obj!.artifacts).filter((a) => a.title === "Paid-social copy");
    const active = copies.filter((a) => a.status === ArtifactStatus.Approved);
    expect(active).toHaveLength(1);
    expect((active[0]!.body as { headline: string }).headline).toBe("Zero downtime. Total control.");
    expect(copies.some((a) => a.status === ArtifactStatus.Superseded)).toBe(true);
  });
});

describe("the learning loop (spec §6.7)", () => {
  it("approved learnings are written back and ground the next campaign", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.ContentOptimisation);
    const orch = astra.stageOrchestrator(async () => ({ approve: true, actor: human, note: "ok" }));
    await orch.runCurrentStage(id);

    const obj = await astra.repo.load(id);
    const learning = Object.values(obj!.artifacts).find(
      (a) => a.kind === ArtifactKind.Learning && a.status === ArtifactStatus.Approved,
    );
    expect(learning).toBeDefined();

    const harvested = await astra.harvestLearning(id, learning!.id);
    expect(harvested).not.toBeNull();

    // The insight is now retrievable grounding — the compounding advantage (§6.7).
    const r = await astra.fabric.retrieve("crew creative email share cordless campaign learnings");
    expect(r.citations.map((c) => c.sourceId)).toContain(`learning-${id}`);
  });
});
