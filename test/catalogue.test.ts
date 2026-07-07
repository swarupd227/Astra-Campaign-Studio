import { describe, expect, it } from "vitest";
import { Astra } from "../src/app";
import { fixedClock } from "../src/domain/ids";
import { ArtifactStatus, MVP1_STAGES, Stage, type Actor } from "../src/domain/types";
import { agentsForStage, getAgentByName } from "../src/agents/catalogue";

const human: Actor = { kind: "human", id: "u1", displayName: "Tester" };

function newAstra() {
  return new Astra({ persistence: "memory", clock: fixedClock("2026-01-01T00:00:00Z"), campaignTokenBudget: 0 });
}

async function seed(astra: Astra): Promise<string> {
  return astra.createCampaign(
    { objective: "Launch cordless platform", owner: human.id, markets: ["DE", "US"], budget: 750_000, currency: "EUR", kpis: ["Qualified leads"] },
    human,
  );
}

/** Drives the whole lifecycle via stage orchestrators, auto-approving. */
async function runLifecycle(astra: Astra, campaignId: string) {
  const orch = astra.stageOrchestrator(async () => ({ approve: true, actor: human, note: "ok" }));
  for (let i = 0; i < 8; i++) {
    const obj = await astra.repo.load(campaignId);
    if (agentsForStage(obj!.campaign.currentStage).length === 0) break;
    const report = await orch.runCurrentStage(campaignId);
    if (!report.advancedTo) break; // terminal stage reached
  }
}

describe("full-chain catalogue", () => {
  it("runs every stage to completion — brief to content optimisation (terminal)", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await runLifecycle(astra, id);
    const obj = await astra.repo.load(id);
    expect(obj?.campaign.currentStage).toBe(Stage.ContentOptimisation);
  });

  it("every artifact is traceable — grounded citations or upstream lineage (§9.3/§12)", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await runLifecycle(astra, id);
    const obj = await astra.repo.load(id);
    const artifacts = Object.values(obj!.artifacts);
    expect(artifacts.length).toBeGreaterThanOrEqual(40);
    for (const a of artifacts) {
      expect(a.citations.length + a.derivedFrom.length, `${a.title} must be traceable`).toBeGreaterThan(0);
    }
  });

  it("gates each stage on its primary outputs before advancing", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    const orch = astra.stageOrchestrator(async () => ({ approve: true, actor: human }));

    const intake = await orch.runCurrentStage(id);
    expect(intake.stage).toBe(Stage.Intake);
    expect(intake.advancedTo).toBe(Stage.CampaignPlanning);

    const planning = await orch.runCurrentStage(id);
    expect(planning.advancedTo).toBe(Stage.ContentPlanning);
  });

  it("records content lineage from the DE transcreation back to the brief", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await runLifecycle(astra, id);
    const obj = await astra.repo.load(id);
    const de = Object.values(obj!.artifacts).find((a) => a.title.includes("DE (transcreation)"));
    expect(de).toBeDefined();
    // The DE copy derives from the base paid-social copy.
    const parent = obj!.artifacts[de!.derivedFrom[0]!];
    expect(parent?.title).toBe("Paid-social copy");
  });
});

describe("grounding gate blocks ungrounded output (spec §9.2/§9.3)", () => {
  it("fails an agent whose query the knowledge fabric is silent on", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    const ungroundedAgent = {
      name: "Rogue Agent",
      stage: Stage.Intake,
      role: "campaign-manager",
      async propose() {
        return {
          kind: "note" as const,
          stage: Stage.Intake,
          title: "Ungrounded note",
          body: { text: "invented" },
          rationale: "no grounding",
          citations: [], // nothing retrieved → grounding eval must fail
        };
      },
    };
    const result = await astra.orchestrator.runAgent(id, ungroundedAgent);
    expect(result.evals.find((e) => e.name === "grounding")?.passed).toBe(false);
    expect(result.pendingHumanApproval).toBe(false); // blocked at the gate, never reaches a human
    const obj = await astra.repo.load(id);
    expect(obj?.artifacts[result.artifact.id]?.status).toBe(ArtifactStatus.Proposed);
  });
});

describe("revision loop (Request changes → redraft)", () => {
  it("re-runs the producing agent with feedback and records lineage", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    const agent = agentsForStage(Stage.Intake)[0]!;
    const first = await astra.orchestrator.runAgent(id, agent);

    // Reviewer requests changes, then the same agent redrafts with the feedback.
    await astra.orchestrator.reject(id, first.artifact.id, human, "Tighten the objective.");
    const revised = await astra.orchestrator.runAgent(id, agent, {
      feedback: "Tighten the objective.",
      supersedes: first.artifact.id,
    });

    expect(revised.artifact.derivedFrom).toContain(first.artifact.id);
    expect(revised.artifact.version).toBe(2);

    // Rationale lives on the proposal event; the canvas projection surfaces it.
    const canvas = await astra.canvas(id, "campaign-manager");
    const revisedView = canvas!.artifacts.find((a) => a.id === revised.artifact.id);
    expect(revisedView!.rationale).toContain("Revised to address reviewer feedback");
    expect(revisedView!.rationale).toContain("Tighten the objective.");

    const obj = await astra.repo.load(id);
    expect(obj?.artifacts[first.artifact.id]?.status).toBe(ArtifactStatus.Rejected);
  });

  it("resolves the producing agent from an artifact's author name", () => {
    const agent = agentsForStage(Stage.Intake)[0]!;
    expect(getAgentByName(agent.name)?.name).toBe(agent.name);
    expect(getAgentByName("No Such Agent")).toBeUndefined();
  });
});

describe("inline editing (edit anything, lose nothing)", () => {
  const creator: Actor = { kind: "human", id: "u_creator", displayName: "Creator", role: "creator" };

  it("creates a new human-authored version, supersedes the prior, and re-runs evals", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    const agent = agentsForStage(Stage.Intake)[0]!;
    const first = await astra.orchestrator.runAgent(id, agent);

    const edited = await astra.orchestrator.editArtifact(
      id,
      first.artifact.id,
      { objective: "Sharper, uptime-led objective" },
      creator,
    );
    expect(edited.artifact.version).toBe(2);
    expect(edited.artifact.author.displayName).toBe("Creator");
    expect(edited.artifact.derivedFrom).toContain(first.artifact.id);
    expect(edited.pendingHumanApproval).toBe(true); // human edits still need sign-off

    const obj = await astra.repo.load(id);
    expect(obj?.artifacts[first.artifact.id]?.status).toBe(ArtifactStatus.Superseded);
    expect((obj?.artifacts[edited.artifact.id]?.body as { objective: string }).objective).toBe(
      "Sharper, uptime-led objective",
    );
  });

  it("blocks an edit that strips a required compliance footnote", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    const { copywritingAgent } = await import("../src/agents/creation");
    const draft = await astra.orchestrator.runAgent(id, copywritingAgent);
    expect(draft.evals.find((e) => e.name === "compliance")?.passed).toBe(true);

    // Remove the substantiation footnote while keeping the performance claim.
    const edited = await astra.orchestrator.editArtifact(
      id,
      draft.artifact.id,
      { footnote: "", body: "Extended runtime for the whole fleet." },
      creator,
    );
    expect(edited.evals.find((e) => e.name === "compliance")?.passed).toBe(false);
    expect(edited.pendingHumanApproval).toBe(false); // blocked at the quality gate
  });
});

describe("autonomy dial (Admin console, spec §7.2)", () => {
  it("raising autonomy to L3 lets an agent act within guardrails without per-action approval", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    const { copywritingAgent } = await import("../src/agents/creation");

    // Default (L1 Draft) → the agent's output needs human approval.
    const before = await astra.orchestrator.runAgent(id, copywritingAgent);
    expect(before.pendingHumanApproval).toBe(true);

    // Admin turns the dial up to L3 (bounded-auto) for creators at content creation.
    astra.policy.setAutonomy("creator", Stage.ContentCreation, "L3");
    const after = await astra.orchestrator.runAgent(id, copywritingAgent);
    expect(after.autoApproved).toBe(true);
    expect(after.pendingHumanApproval).toBe(false);
  });

  it("captures a structured brief from campaign inputs including mandatory claims", async () => {
    const astra = newAstra();
    const id = await astra.createCampaign(
      {
        objective: "Launch in the Nordics",
        owner: "u",
        markets: ["SE", "NO"],
        budget: 480_000,
        currency: "EUR",
        kpis: ["Demo requests"],
        mandatoryClaims: "Runtime claims require an EN 62841 footnote.",
      },
      { kind: "system", id: "sys", displayName: "System" },
    );
    const r = await astra.orchestrator.runAgent(id, agentsForStage(Stage.Intake)[0]!);
    const brief = r.artifact.body as { mandatoryClaims: string; successMetric: string; markets: string[] };
    expect(brief.mandatoryClaims).toContain("EN 62841");
    expect(brief.successMetric).toBe("Demo requests");
    expect(brief.markets).toEqual(["SE", "NO"]);
  });
});

describe("full-chain scope", () => {
  it("registers agents for every lifecycle stage (MVP-1 + MVP-2)", () => {
    for (const stage of MVP1_STAGES) {
      expect(agentsForStage(stage).length).toBeGreaterThan(0);
    }
    expect(agentsForStage(Stage.Rollout).length).toBe(9);
    expect(agentsForStage(Stage.CampaignOptimisation).length).toBe(8); // + readout, apply-winner
    expect(agentsForStage(Stage.ContentOptimisation).length).toBe(6);
  });
});
