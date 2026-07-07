import { describe, expect, it } from "vitest";
import { Astra } from "../src/app";
import { fixedClock } from "../src/domain/ids";
import { ArtifactKind, ArtifactStatus, Stage, type Actor } from "../src/domain/types";
import { GoldenSetStore, hiltiGoldenSet } from "../src/evals/goldenSet";
import { brandToneEvaluator } from "../src/evals/evaluators";
import { copywritingAgent } from "../src/agents/creation";
import type { EvalContext } from "../src/evals/evalHarness";
import type { CampaignObject } from "../src/domain/types";

const human: Actor = { kind: "human", id: "u1", displayName: "Ben", role: "brand-guardian" };
const clock = fixedClock("2026-01-01T00:00:00Z");

function newAstra() {
  return new Astra({ persistence: "memory", clock, campaignTokenBudget: 0 });
}

describe("GoldenSetStore (admin-editable, §9.2)", () => {
  it("curates banned terms and exemplars, deduplicated", () => {
    const store = new GoldenSetStore(hiltiGoldenSet(), () => clock.now());
    store.addBannedTerm("Unbeatable");
    store.addBannedTerm("unbeatable"); // dedupe, case-insensitive
    expect(store.current().bannedTerms.filter((t) => t === "unbeatable")).toHaveLength(1);
    store.removeBannedTerm("unbeatable");
    expect(store.current().bannedTerms).not.toContain("unbeatable");

    store.addExemplar("offBrand", "Buy now!!! Limited stock!!!");
    expect(store.current().brandVoice.offBrand).toContain("Buy now!!! Limited stock!!!");
    store.removeExemplar("offBrand", "Buy now!!! Limited stock!!!");
    expect(store.current().brandVoice.offBrand).not.toContain("Buy now!!! Limited stock!!!");
  });

  it("a newly banned term flips the brand-tone gate for future runs", async () => {
    const astra = newAstra();
    const artifact = {
      id: "a1",
      kind: ArtifactKind.ContentItem,
      stage: Stage.ContentCreation,
      version: 1,
      status: ArtifactStatus.Proposed,
      title: "t",
      body: { headline: "The unbeatable cordless platform." },
      author: { kind: "agent" as const, id: "x", displayName: "x" },
      citations: [{ sourceId: "s", title: "s", version: "1", snippet: "" }],
      passedEvals: [],
      derivedFrom: [],
      createdAt: clock.now(),
    };
    const ctx = (): EvalContext => ({
      campaignId: "c1",
      gateway: astra.gateway,
      golden: astra.golden.current(),
      campaign: { campaign: {} as never, artifacts: {}, mentions: [], revision: 0 } as CampaignObject,
    });

    const before = await brandToneEvaluator.evaluate(artifact, ctx());
    expect(before.passed).toBe(true); // "unbeatable" isn't banned yet

    astra.golden.addBannedTerm("unbeatable"); // admin turns the dial
    const after = await brandToneEvaluator.evaluate(artifact, ctx());
    expect(after.passed).toBe(false); // the gate now anchors on the tuned set
  });
});

describe("the eval feedback loop (§9.2 — decisions feed back to tune the evals)", () => {
  it("a human rejection of gate-passing copy becomes a tuning suggestion; accepting it grows the golden set", async () => {
    const astra = newAstra();
    const id = await astra.createCampaign(
      { objective: "Launch cordless platform", owner: "u", markets: ["DE"], budget: 1000, currency: "EUR", kpis: ["CTR"] },
      { kind: "system", id: "sys", displayName: "System" },
    );
    const result = await astra.orchestrator.runAgent(id, copywritingAgent);
    expect(result.evals.every((e) => e.passed)).toBe(true); // gates passed…

    // …but the Brand Guardian overrules with a reason.
    await astra.orchestrator.reject(id, result.artifact.id, human, "Reads generic — not our voice.");

    const suggestions = astra.golden.listSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.reason).toContain("not our voice");
    expect(suggestions[0]!.text).toContain("Power through the workday");

    // Admin adjudicates: accept → it anchors future grading as an off-brand exemplar.
    astra.golden.acceptSuggestion(suggestions[0]!.text);
    expect(astra.golden.listSuggestions()).toHaveLength(0);
    expect(astra.golden.current().brandVoice.offBrand).toContain(suggestions[0]!.text);
  });

  it("agent-initiated rejections (revise loop) don't pollute the suggestion inbox", async () => {
    const astra = newAstra();
    const id = await astra.createCampaign(
      { objective: "x", owner: "u", markets: ["DE"], budget: 1, currency: "EUR", kpis: ["k"] },
      { kind: "system", id: "sys", displayName: "System" },
    );
    const result = await astra.orchestrator.runAgent(id, copywritingAgent);
    await astra.orchestrator.reject(id, result.artifact.id, { kind: "system", id: "s", displayName: "s" }, "auto");
    expect(astra.golden.listSuggestions()).toHaveLength(0); // only HUMAN adjudications count
  });
});
