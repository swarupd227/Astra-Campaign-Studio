import { describe, expect, it } from "vitest";
import { Astra } from "../src/app";
import { fixedClock } from "../src/domain/ids";
import { Stage, type Actor } from "../src/domain/types";
import { intakeAgent } from "../src/agents/intake";

const human: Actor = { kind: "human", id: "u1", displayName: "Reviewer" };

function newAstra() {
  return new Astra({ persistence: "memory", clock: fixedClock("2026-01-01T00:00:00Z"), campaignTokenBudget: 0 });
}

async function seed(astra: Astra): Promise<string> {
  return astra.createCampaign(
    { objective: "Launch cordless platform", owner: human.id, markets: ["DE"], budget: 1000, currency: "EUR", kpis: ["CTR"] },
    human,
  );
}

describe("Experience-layer projections (spec §8)", () => {
  it("Campaign Canvas reflects stage rail, artifacts and review queue", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await astra.orchestrator.runAgent(id, intakeAgent); // proposes + evals, lands in review

    const view = await astra.canvas(id);
    expect(view).not.toBeNull();
    expect(view!.campaign.currentStage).toBe(Stage.Intake);

    // Stage rail marks the current stage active with its gate status.
    const active = view!.stageRail.find((s) => s.state === "active");
    expect(active?.stage).toBe(Stage.Intake);
    expect(active?.gate).toBeDefined();

    // The proposed brief is awaiting human review, with explainability attached.
    expect(view!.reviewQueue.length).toBe(1);
    const brief = view!.artifacts.find((a) => a.id === view!.reviewQueue[0]);
    expect(brief?.rationale.length).toBeGreaterThan(0);
    expect(brief?.evals.some((e) => e.name === "grounding" && e.passed)).toBe(true);
    expect(brief?.citations.length).toBeGreaterThan(0);
  });

  it("activity stream is newest-first and telemetry counts events", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await astra.orchestrator.runAgent(id, intakeAgent);
    const view = await astra.canvas(id);
    expect(view!.activity[0]!.seq).toBeGreaterThan(view!.activity[view!.activity.length - 1]!.seq);
    expect(view!.telemetry.events).toBeGreaterThan(0);
    expect(view!.telemetry.evalPassRate).toBe(1);
  });

  it("Mission Control summarises the portfolio with pending approvals", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await astra.orchestrator.runAgent(id, intakeAgent);
    const rows = await astra.missionControl();
    const row = rows.find((r) => r.id === id);
    expect(row?.pendingApprovals).toBe(1);
    expect(row?.currentStage).toBe(Stage.Intake);
  });

  it("Localisation Workbench pairs market variants with their sources (§8.2)", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    const { agentsForStage } = await import("../src/agents/catalogue");
    const orch = astra.stageOrchestrator(async () => ({ approve: true, actor: human, note: "ok" }));
    // Drive through content creation so the DE transcreation exists.
    for (let i = 0; i < 4; i++) {
      const obj = await astra.repo.load(id);
      if (agentsForStage(obj!.campaign.currentStage).length === 0) break;
      const report = await orch.runCurrentStage(id);
      if (report.stage === "content-creation") break;
    }

    const view = (await astra.localisation(id, "localisation"))!;
    expect(view.markets).toContain("DE");
    const de = view.pairs.find((p) => p.market === "DE")!;
    // Side-by-side: the DE adaptation is paired with its English source.
    expect((de.target.body as { headline: string }).headline).toContain("Kraftvoll");
    expect(de.source).not.toBeNull();
    expect((de.source!.body as { headline: string }).headline).toContain("Power through");
    // The localisation-equivalence outcome rides along for the reviewer.
    expect(de.equivalence?.passed).toBe(true);
  });

  it("delivery telemetry: rework rate, human-edit distance and cost per item (§14.1)", async () => {
    const { editDistanceRatio } = await import("../src/experience/projections");
    expect(editDistanceRatio({ a: "same text here" }, { a: "same text here" })).toBe(0);
    expect(editDistanceRatio({ a: "old headline entirely" }, { a: "new copy altogether different" })).toBeGreaterThan(0.5);

    const astra = newAstra();
    const id = await seed(astra);
    const first = await astra.orchestrator.runAgent(id, intakeAgent);

    // Baseline: no rework, no human edits yet; tokens were spent on the draft.
    let view = (await astra.canvas(id))!;
    expect(view.telemetry.reworkRate).toBe(0);
    expect(view.telemetry.humanEditDistance).toBeNull();
    expect(view.telemetry.tokensSpent).toBeGreaterThan(0);

    // A human sends the brief back → rework registers.
    await astra.orchestrator.reject(id, first.artifact.id, human, "Sharpen it.");
    const redraft = await astra.orchestrator.runAgent(id, intakeAgent, { feedback: "Sharpen it.", supersedes: first.artifact.id });
    view = (await astra.canvas(id))!;
    expect(view.telemetry.reworkRate).toBeGreaterThan(0);

    // A human edit → edit distance measured against the predecessor.
    await astra.orchestrator.editArtifact(id, redraft.artifact.id, { objective: "A completely rewritten uptime-first objective" }, human);
    await astra.orchestrator.approve(
      id,
      (await astra.repo.load(id))!.artifacts && Object.values((await astra.repo.load(id))!.artifacts).find((a) => a.status === "in-review")!.id,
      human,
    );
    view = (await astra.canvas(id))!;
    expect(view.telemetry.humanEditDistance).not.toBeNull();
    expect(view.telemetry.humanEditDistance!).toBeGreaterThan(0);
    // One approved item + spent tokens → a concrete cost-per-item figure.
    expect(view.telemetry.costPerApprovedItem).not.toBeNull();
    expect(view.telemetry.costPerApprovedItem!).toBeGreaterThan(0);
  });

  it("portfolio rollup aggregates pending, items, budget and pipeline across campaigns", async () => {
    const astra = newAstra();
    const id1 = await seed(astra);
    await astra.orchestrator.runAgent(id1, intakeAgent); // one pending item
    await astra.createCampaign(
      { objective: "Second campaign", owner: human.id, markets: ["US"], budget: 250, currency: "EUR", kpis: ["CTR"] },
      human,
    );

    const p = await astra.portfolio();
    expect(p.totals.campaigns).toBe(2);
    expect(p.totals.pendingApprovals).toBeGreaterThanOrEqual(1);
    expect(p.totals.totalBudget).toBe(1250);
    expect(p.totals.currency).toBe("EUR");
    // Every campaign appears exactly once in the pipeline distribution.
    expect(p.pipeline.reduce((a, b) => a + b.count, 0)).toBe(2);
    expect(p.roiConnected).toBe(false);
  });
});
