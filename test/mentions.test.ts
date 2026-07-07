import { describe, expect, it } from "vitest";
import { Astra } from "../src/app";
import { fixedClock } from "../src/domain/ids";
import type { Actor } from "../src/domain/types";
import { intakeAgent } from "../src/agents/intake";
import { CampaignRepository } from "../src/store/campaignRepository";

const cm: Actor = { kind: "human", id: "u_cm", displayName: "Dana", role: "campaign-manager" };
const brand: Actor = { kind: "human", id: "u_bg", displayName: "Ben", role: "brand-guardian" };
const creator: Actor = { kind: "human", id: "u_cr", displayName: "Cara", role: "creator" };
const ops: Actor = { kind: "human", id: "u_op", displayName: "Omar", role: "marketing-ops" };

function newAstra() {
  return new Astra({ persistence: "memory", clock: fixedClock("2026-01-01T00:00:00Z"), campaignTokenBudget: 0 });
}

async function seedWithBrief(astra: Astra): Promise<{ id: string; artifactId: string }> {
  const id = await astra.createCampaign(
    { objective: "Launch cordless platform", owner: cm.id, markets: ["DE"], budget: 1000, currency: "EUR", kpis: ["CTR"] },
    cm,
  );
  const r = await astra.orchestrator.runAgent(id, intakeAgent);
  return { id, artifactId: r.artifact.id };
}

describe("@mentions / hand-offs (spec §8.4)", () => {
  it("threads on the artifact and lands in the target persona's inbox", async () => {
    const astra = newAstra();
    const { id, artifactId } = await seedWithBrief(astra);
    await astra.addMention(id, artifactId, "brand-guardian", "Please sanity-check the claim wording.", cm);

    // Threaded on the artifact card, with role-aware resolve rights.
    const asBrand = (await astra.canvas(id, "brand-guardian"))!;
    const card = asBrand.artifacts.find((a) => a.id === artifactId)!;
    expect(card.mentions).toHaveLength(1);
    expect(card.mentions[0]!).toMatchObject({ toRoleLabel: "Brand Guardian", from: "Dana", canResolve: true });

    // In MY inbox only when I'm the target.
    expect(asBrand.myMentions).toHaveLength(1);
    expect(asBrand.myMentions[0]!.artifactTitle).toBe("Campaign brief");
    const asCreator = (await astra.canvas(id, "creator"))!;
    expect(asCreator.myMentions).toHaveLength(0);
    expect(asCreator.artifacts.find((a) => a.id === artifactId)!.mentions[0]!.canResolve).toBe(false);
  });

  it("only the mentioned role (or an admin) can close the hand-off", async () => {
    const astra = newAstra();
    const { id, artifactId } = await seedWithBrief(astra);
    const mid = await astra.addMention(id, artifactId, "brand-guardian", "Check tone.", cm);

    await expect(astra.resolveMention(id, mid, creator)).rejects.toThrow(/Brand Guardian/);
    await astra.resolveMention(id, mid, brand);
    const view = (await astra.canvas(id, "brand-guardian"))!;
    expect(view.myMentions).toHaveLength(0); // closed
    expect(view.artifacts.find((a) => a.id === artifactId)!.mentions[0]!.resolved).toBe(true);
    await expect(astra.resolveMention(id, mid, brand)).rejects.toThrow(/already closed/);

    // Admins can close any hand-off.
    const mid2 = await astra.addMention(id, artifactId, "legal", "Claim check.", cm);
    await astra.resolveMention(id, mid2, ops);
  });

  it("agency partners can be pulled in (§8.4 'or an agency partner')", async () => {
    const astra = newAstra();
    const { id, artifactId } = await seedWithBrief(astra);
    await astra.addMention(id, artifactId, "agency-partner", "Please refine the hero visual.", cm);
    const asAgency = (await astra.canvas(id, "agency-partner"))!;
    expect(asAgency.myMentions).toHaveLength(1);
  });

  it("hand-offs are event-sourced: they survive a replay and appear in the audit", async () => {
    const astra = newAstra();
    const { id, artifactId } = await seedWithBrief(astra);
    await astra.addMention(id, artifactId, "brand-guardian", "Check tone.", cm);

    const rebuilt = CampaignRepository.fold(await astra.store.read(id));
    expect(rebuilt.mentions).toHaveLength(1);
    expect(rebuilt.mentions[0]!.message).toBe("Check tone.");

    const audit = await astra.auditTrail(id);
    const entry = audit.find((a) => a.what.includes("Pulled Brand Guardian"));
    expect(entry).toBeDefined();
    expect(entry!.why).toBe("Check tone.");
  });

  it("validates the target role and requires a message", async () => {
    const astra = newAstra();
    const { id, artifactId } = await seedWithBrief(astra);
    await expect(astra.addMention(id, artifactId, "no-such-role", "x", cm)).rejects.toThrow(/Unknown role/);
    await expect(astra.addMention(id, artifactId, "legal", "   ", cm)).rejects.toThrow(/needs a message/);
  });
});
