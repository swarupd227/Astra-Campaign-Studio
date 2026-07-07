import { describe, expect, it } from "vitest";
import { fixedClock } from "../src/domain/ids";
import { ArtifactKind, ArtifactStatus, Stage, type Artifact, type CampaignObject } from "../src/domain/types";
import { ModelGateway } from "../src/gateway/modelGateway";
import { hiltiGoldenSet } from "../src/evals/goldenSet";
import {
  brandToneEvaluator,
  complianceEvaluator,
  localisationEquivalenceEvaluator,
  regressionEvaluator,
} from "../src/evals/evaluators";
import type { EvalContext } from "../src/evals/evalHarness";

const clock = fixedClock("2026-01-01T00:00:00Z");

function artifact(kind: ArtifactKind, body: Record<string, unknown>, extra: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_x",
    kind,
    stage: Stage.ContentCreation,
    version: 1,
    status: ArtifactStatus.Proposed,
    title: "t",
    body,
    author: { kind: "agent", id: "a", displayName: "a" },
    citations: [{ sourceId: "s", title: "s", version: "1", snippet: "…" }],
    passedEvals: [],
    derivedFrom: [],
    createdAt: clock.now(),
    ...extra,
  };
}

function ctx(campaign?: CampaignObject): EvalContext {
  return {
    campaignId: "c1",
    gateway: new ModelGateway({ defaultModel: "claude-opus-4-8", campaignTokenBudget: 0 }),
    golden: hiltiGoldenSet(),
    campaign: campaign ?? ({ campaign: {} as never, artifacts: {}, mentions: [], revision: 0 } as CampaignObject),
  };
}

describe("model-graded brand/tone (golden-set-anchored)", () => {
  it("passes on-brand copy", async () => {
    const a = artifact(ArtifactKind.ContentItem, { headline: "No downtime, no compromise.", body: "Extended runtime keeps your crew moving." });
    const out = await brandToneEvaluator.evaluate(a, ctx());
    expect(out.score).toBeGreaterThanOrEqual(0.7);
  });

  it("fails copy that uses a banned hype term", async () => {
    const a = artifact(ArtifactKind.ContentItem, { headline: "The world's best, revolutionary tool — guaranteed!" });
    const out = await brandToneEvaluator.evaluate(a, ctx());
    expect(out.score).toBeLessThan(0.7);
  });
});

describe("model-graded compliance", () => {
  it("passes a performance claim that carries a footnote", async () => {
    const a = artifact(ArtifactKind.ContentItem, { body: "Extended runtime¹ for the fleet.", footnote: "¹ Tested under standard conditions; substantiation on file." });
    const out = await complianceEvaluator.evaluate(a, ctx());
    expect(out.score).toBeGreaterThanOrEqual(0.7);
  });

  it("fails a performance claim with no substantiation", async () => {
    const a = artifact(ArtifactKind.ContentItem, { body: "The longest runtime and fastest performance, period." });
    const out = await complianceEvaluator.evaluate(a, ctx());
    expect(out.score).toBeLessThan(0.7);
  });
});

describe("model-graded regression (§9.2 — did a refresh degrade a winning asset?)", () => {
  const source = artifact(
    ArtifactKind.ContentItem,
    { headline: "No downtime, no compromise.", body: "One battery platform with extended runtime¹.", footnote: "¹ substantiated" },
    { id: "src" },
  );
  const campaignWith = (arts: Record<string, unknown>) =>
    ({ campaign: {} as never, artifacts: arts, revision: 1 }) as unknown as import("../src/domain/types").CampaignObject;

  it("passes a refresh that renews the creative but keeps the winning core", async () => {
    const refresh = artifact(
      ArtifactKind.ContentItem,
      { headline: "Your crew doesn't stop.", body: "One battery platform with extended runtime¹ for long shifts.", footnote: "¹ substantiated" },
      { derivedFrom: ["src"] },
    );
    const out = await regressionEvaluator.evaluate(refresh, ctx(campaignWith({ src: source })));
    expect(out.score).toBeGreaterThanOrEqual(0.7);
  });

  it("fails a refresh that drops the winning core message", async () => {
    const refresh = artifact(
      ArtifactKind.ContentItem,
      { headline: "Big spring savings!", body: "Great deals on tools this month only." },
      { derivedFrom: ["src"] },
    );
    const out = await regressionEvaluator.evaluate(refresh, ctx(campaignWith({ src: source })));
    expect(out.score).toBeLessThan(0.7);
  });

  it("is not applicable (passes) for non-refresh artifacts", async () => {
    const fresh = artifact(ArtifactKind.ContentItem, { headline: "Anything" });
    const out = await regressionEvaluator.evaluate(fresh, ctx());
    expect(out.score).toBe(1);
  });
});

describe("model-graded localisation equivalence", () => {
  it("is not applicable (passes) for a non-localised asset", async () => {
    const a = artifact(ArtifactKind.ContentItem, { headline: "No downtime, no compromise." });
    const out = await localisationEquivalenceEvaluator.evaluate(a, ctx());
    expect(out.score).toBe(1);
  });

  it("passes a transcreation that preserves the source meaning", async () => {
    const source = artifact(ArtifactKind.ContentItem, { headline: "No downtime, no compromise." }, { id: "src" });
    const de = artifact(
      ArtifactKind.ContentItem,
      { market: "DE", headline: "Keine Ausfallzeit, keine Kompromisse." },
      { derivedFrom: ["src"] },
    );
    const campaign = { campaign: {} as never, artifacts: { src: source }, revision: 1 } as unknown as CampaignObject;
    const out = await localisationEquivalenceEvaluator.evaluate(de, ctx(campaign));
    expect(out.score).toBeGreaterThanOrEqual(0.7);
  });
});
