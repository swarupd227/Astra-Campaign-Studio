import { describe, expect, it } from "vitest";
import { Astra } from "../src/app";
import { fixedClock } from "../src/domain/ids";
import { Stage, type Actor } from "../src/domain/types";
import { agentsForStage } from "../src/agents/catalogue";
import { AccessControl, AccessDeniedError, getRole } from "../src/security/roles";

const clock = fixedClock("2026-01-01T00:00:00Z");

function newAstra() {
  return new Astra({ persistence: "memory", clock, campaignTokenBudget: 0 });
}
const asRole = (role: string): Actor => ({ kind: "human", id: `u_${role}`, displayName: role, role });

async function seed(astra: Astra): Promise<string> {
  return astra.createCampaign(
    { objective: "Launch cordless platform", owner: "sys", markets: ["DE", "US"], budget: 750_000, currency: "EUR", kpis: ["Qualified leads"] },
    { kind: "system", id: "sys", displayName: "System" },
  );
}

describe("persona catalogue & capabilities (spec §5.1)", () => {
  it("assigns capabilities per RACI role", () => {
    expect(getRole("campaign-manager")?.canAdvance).toBe(true);
    expect(getRole("brand-guardian")?.canRunAgents).toBe(false);
    // Legal signs off claim-bearing work at creation AND on refreshed content (§6.6).
    expect(getRole("legal")?.approvesStages).toEqual([Stage.ContentCreation, Stage.ContentOptimisation]);
    expect(getRole("creator")?.approvesStages).toEqual([]);
    // MVP-2 personas (§5.2): go-live authority and optimisation ownership.
    expect(getRole("channel-specialist")?.canGoLive).toBe(true);
    expect(getRole("performance-marketer")?.approvesStages).toContain(Stage.CampaignOptimisation);
  });
});

describe("AccessControl authority (spec §5.2)", () => {
  const access = new AccessControl();
  const artifact = (stage: Stage, kind: string) =>
    ({ stage, kind, id: "a", title: "t" }) as never;

  it("Marketing Leader cannot advance stages", () => {
    expect(access.canAdvance("marketing-leader").allowed).toBe(false);
    expect(access.canAdvance("campaign-manager").allowed).toBe(true);
  });

  it("Legal may approve claim-bearing creation artifacts but not a strategy", () => {
    expect(access.canApprove("legal", artifact(Stage.ContentCreation, "content-item")).allowed).toBe(true);
    expect(access.canApprove("legal", artifact(Stage.CampaignPlanning, "strategy")).allowed).toBe(false);
  });

  it("Brand Guardian approves content but cannot run agents", () => {
    expect(access.canApprove("brand-guardian", artifact(Stage.ContentPlanning, "concept")).allowed).toBe(true);
    expect(access.canRunAgents("brand-guardian").allowed).toBe(false);
  });

  it("MVP-2 personas: localisation, analyst and the scoped agency partner (§5.1)", () => {
    const access = new AccessControl();
    const artifact = (stage: Stage, kind: string) => ({ stage, kind, id: "a", title: "t" }) as never;
    // Localisation signs off market variants at creation/roll-out — nothing else.
    expect(access.canApprove("localisation", artifact(Stage.ContentCreation, "content-item")).allowed).toBe(true);
    expect(access.canApprove("localisation", artifact(Stage.Rollout, "content-item")).allowed).toBe(true);
    expect(access.canApprove("localisation", artifact(Stage.CampaignPlanning, "strategy")).allowed).toBe(false);
    // The analyst signs off learnings only.
    expect(access.canApprove("analyst", artifact(Stage.ContentOptimisation, "learning")).allowed).toBe(true);
    expect(access.canApprove("analyst", artifact(Stage.ContentOptimisation, "content-item")).allowed).toBe(false);
    // Agency partners collaborate (edit) but never approve.
    expect(access.canEdit("agency-partner").allowed).toBe(true);
    expect(access.canApprove("agency-partner", artifact(Stage.ContentCreation, "content-item")).allowed).toBe(false);
    expect(access.canCreateCampaign("agency-partner").allowed).toBe(false);
  });

  it("guest access is campaign-scoped for agency partners only (§13)", async () => {
    const { GuestAccess } = await import("../src/security/guestAccess");
    const guests = new GuestAccess();
    // Internal roles are never scoped.
    expect(guests.isAllowed("campaign-manager", "camp_1")).toBe(true);
    expect(guests.isAllowed(undefined, "camp_1")).toBe(true);
    // Guests see nothing until an admin shares a campaign.
    expect(guests.isAllowed("agency-partner", "camp_1")).toBe(false);
    guests.assign("camp_1");
    expect(guests.isAllowed("agency-partner", "camp_1")).toBe(true);
    expect(guests.isAllowed("agency-partner", "camp_2")).toBe(false);
    guests.revoke("camp_1");
    expect(guests.isAllowed("agency-partner", "camp_1")).toBe(false);
  });

  it("producers may edit content; reviewers may not", () => {
    expect(access.canEdit("creator").allowed).toBe(true);
    expect(access.canEdit("content-strategist").allowed).toBe(true);
    expect(access.canEdit("brand-guardian").allowed).toBe(false);
    expect(access.canEdit("legal").allowed).toBe(false);
    expect(access.canEdit("marketing-leader").allowed).toBe(false);
  });
});

describe("Orchestrator enforces approval authority", () => {
  it("rejects an approval by a role without authority for that stage", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    const r = await astra.orchestrator.runAgent(id, agentsForStage(Stage.Intake)[0]!);
    // Legal has no authority at intake → AccessDeniedError.
    await expect(astra.orchestrator.approve(id, r.artifact.id, asRole("legal"))).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    // Campaign Manager is accountable at intake → allowed.
    await astra.orchestrator.approve(id, r.artifact.id, asRole("campaign-manager"));
    const obj = await astra.repo.load(id);
    expect(obj?.artifacts[r.artifact.id]?.status).toBe("approved");
  });

  it("role-less actors (system/tests) bypass enforcement for back-compat", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    const r = await astra.orchestrator.runAgent(id, agentsForStage(Stage.Intake)[0]!);
    await astra.orchestrator.approve(id, r.artifact.id, { kind: "human", id: "u", displayName: "u" });
    const obj = await astra.repo.load(id);
    expect(obj?.artifacts[r.artifact.id]?.status).toBe("approved");
  });
});

describe("role-scoped canvas lens (spec §8.1)", () => {
  it("scopes the review queue to what the viewer may approve", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    // Produce intake proposals (they land in review).
    for (const a of agentsForStage(Stage.Intake)) await astra.orchestrator.runAgent(id, a);

    const asManager = await astra.canvas(id, "campaign-manager");
    const asLegal = await astra.canvas(id, "legal");
    // The Campaign Manager can act on the intake brief; Legal has no intake authority.
    expect(asManager!.reviewQueue.length).toBeGreaterThan(0);
    expect(asLegal!.reviewQueue.length).toBe(0);
    expect(asManager!.viewer.canAdvance).toBe(true);
    expect(asLegal!.viewer.canAdvance).toBe(false);
  });
});
