import { Stage, type Artifact } from "../domain/types";
import { EvalHarness, type Evaluator } from "./evalHarness";
import { modelGradedEvaluator } from "./modelGraded";

/**
 * The MVP-1 evaluator set (spec §9.2). Objective dimensions (grounding presence,
 * accessibility alt-text) stay deterministic — fast, cheap, unambiguous. Subjective
 * marketing dimensions (brand/tone, regulated-claim compliance, localisation
 * equivalence) are model-graded against Hilti's golden set.
 */

function textOf(artifact: Artifact): string {
  return JSON.stringify(artifact.body).toLowerCase();
}

// ── Deterministic evaluators ────────────────────────────────────────────────

/** Factual grounding — an artifact must cite sources, or it may be hallucinating. */
export const groundingEvaluator: Evaluator = {
  name: "grounding",
  threshold: 1,
  async evaluate(artifact) {
    const cited = artifact.citations.length > 0;
    return {
      name: "grounding",
      passed: cited,
      score: cited ? 1 : 0,
      detail: cited
        ? `Grounded in ${artifact.citations.length} cited source(s).`
        : "No grounding citations — output is not traceable to Hilti sources.",
    };
  },
};

/**
 * Traceability — later-stage artifacts (deployments, metrics, refreshed content,
 * learnings) must derive from upstream artifacts or cite sources (§12: lineage is
 * first-class; a deployment that traces to nothing approved is not publishable).
 */
export const lineageEvaluator: Evaluator = {
  name: "lineage",
  threshold: 1,
  async evaluate(artifact) {
    const ok = artifact.derivedFrom.length > 0 || artifact.citations.length > 0;
    return {
      name: "lineage",
      passed: ok,
      score: ok ? 1 : 0,
      detail: ok
        ? `Traceable to ${artifact.derivedFrom.length} upstream artifact(s).`
        : "No lineage — this artifact traces to nothing approved upstream.",
    };
  },
};

/** Accessibility — creative image assets must carry alt text (WCAG, §8.5/§9.2). */
export const accessibilityEvaluator: Evaluator = {
  name: "accessibility",
  threshold: 1,
  async evaluate(artifact) {
    const body = artifact.body as Record<string, unknown>;
    const needsAlt = "imageUrl" in body || "image" in body;
    const hasAlt = typeof body.altText === "string" && (body.altText as string).length > 0;
    const ok = !needsAlt || hasAlt;
    return {
      name: "accessibility",
      passed: ok,
      score: ok ? 1 : 0,
      detail: ok ? "Accessibility checks pass." : "Image asset missing alt text (WCAG).",
    };
  },
};

// ── Model-graded evaluators (golden-set-anchored) ────────────────────────────

/** Brand/tone conformance — judged against Hilti's approved voice exemplars. */
export const brandToneEvaluator: Evaluator = modelGradedEvaluator({
  name: "brand-tone",
  threshold: 0.7,
  rubric:
    "Score 1.0 if the copy matches Hilti's confident, expert, proof-led voice and contains no banned/hype terms. Score below 0.7 if it uses hype, superlatives or any banned term, or reads off-brand.",
  exemplars: (ctx) => ({
    onBrand: ctx.golden.brandVoice.onBrand,
    offBrand: ctx.golden.brandVoice.offBrand,
    notes: [ctx.golden.brandVoice.descriptor],
  }),
  subject: (artifact, ctx) => {
    const text = textOf(artifact);
    const bannedHits = ctx.golden.bannedTerms.filter((t) => text.includes(t.toLowerCase()));
    return { text: JSON.stringify(artifact.body), signals: { bannedHits } };
  },
});

/** Regulated-claim compliance — performance claims need a substantiation footnote. */
export const complianceEvaluator: Evaluator = modelGradedEvaluator({
  name: "compliance",
  threshold: 0.7,
  rubric:
    "Score 1.0 if any regulated performance claim (runtime, uptime, faster, longer, performance) carries a substantiation footnote, or if there is no such claim. Score below 0.7 if a performance claim appears without substantiation.",
  exemplars: (ctx) => ({
    notes: ctx.golden.approvedClaims.map(
      (c) => `${c.claim}${c.requiresFootnote ? " — requires footnote" : ""}`,
    ),
  }),
  subject: (artifact) => {
    // Inspect the VALUES, not the JSON (which includes key names like "footnote").
    const values = Object.values(artifact.body)
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join(" ")
      .toLowerCase();
    const makesClaim = /runtime|performance|longer|faster|uptime/.test(values);
    const hasFootnote = /test condition|substantiat|¹|nachweis|testbedingung/.test(values);
    return { text: JSON.stringify(artifact.body), signals: { makesClaim, hasFootnote } };
  },
});

/** Localisation equivalence — does the transcreation preserve the source meaning? */
export const localisationEquivalenceEvaluator: Evaluator = modelGradedEvaluator({
  name: "localisation-equivalence",
  threshold: 0.7,
  rubric:
    "For a localised/transcreated asset, score 1.0 if it preserves the meaning and intent of its source (not a literal translation, but equivalent). Score below 0.7 if meaning drifts or key claims are lost. If the asset is not a localisation, it is not applicable — score 1.0.",
  exemplars: () => ({
    notes: ["Transcreation adapts meaning and tone per market — it is not literal translation."],
  }),
  subject: (artifact, ctx) => {
    const body = artifact.body as Record<string, unknown>;
    const isLocalisation = typeof body.market === "string" && artifact.derivedFrom.length > 0;
    if (!isLocalisation) {
      return { text: "N/A — not a localised asset.", signals: { applicable: false, equivalent: true } };
    }
    const source = ctx.campaign.artifacts[artifact.derivedFrom[0]!];
    const sourceText = source ? JSON.stringify(source.body) : "";
    // Naive objective signal: both mention the core "uptime / downtime" idea.
    const core = /downtime|uptime|ausfallzeit|laufzeit/i;
    const equivalent = core.test(sourceText) && core.test(JSON.stringify(body));
    return {
      text: `SOURCE:\n${sourceText}\n\nLOCALISED (${body.market}):\n${JSON.stringify(body)}`,
      signals: { applicable: true, equivalent },
    };
  },
});

/** Regression (§9.2) — did a refresh degrade a winning asset? A refreshed item must
 * preserve the source's winning core (message motif + substantiated claim) while
 * changing the fatigued creative. Not applicable to non-refresh artifacts. */
export const regressionEvaluator: Evaluator = modelGradedEvaluator({
  name: "regression",
  threshold: 0.7,
  rubric:
    "For a refreshed/adapted asset, compare it against its source. Score 1.0 if it preserves the winning elements (core message motif, substantiated claim) while renewing the creative. Score below 0.7 if the refresh drops the core message or its substantiation — that would degrade a winning asset. Not a refresh → not applicable, score 1.0.",
  exemplars: () => ({
    notes: ["A refresh renews the creative angle; it never discards the message that was winning."],
  }),
  subject: (artifact, ctx) => {
    const source = artifact.derivedFrom.map((id) => ctx.campaign.artifacts[id]).find((a) => a?.kind === artifact.kind);
    const isRefresh = artifact.kind === "content-item" && Boolean(source);
    if (!isRefresh || !source) {
      return { text: "N/A — not a refreshed asset.", signals: { applicable: false, preservesCore: true } };
    }
    // Objective signal: the campaign's winning motif must survive the refresh.
    const CORE = /battery platform|one battery|runtime|downtime/i;
    const values = (a: typeof artifact) =>
      Object.values(a.body).filter((v) => typeof v === "string").join(" ");
    const preservesCore = CORE.test(values(source)) ? CORE.test(values(artifact)) : true;
    return {
      text: `SOURCE:\n${values(source)}\n\nREFRESH:\n${values(artifact)}`,
      signals: { applicable: true, preservesCore },
    };
  },
});

/**
 * MVP-1 gate configuration (spec §6.3 — creation must clear brand, compliance and
 * accessibility; §9.2 adds localisation equivalence). Planning stages gate on
 * grounding; content planning adds brand/tone.
 */
export function mvp1EvalHarness(): EvalHarness {
  return new EvalHarness({
    [Stage.Intake]: [groundingEvaluator],
    [Stage.CampaignPlanning]: [groundingEvaluator],
    [Stage.ContentPlanning]: [groundingEvaluator, brandToneEvaluator],
    [Stage.ContentCreation]: [
      groundingEvaluator,
      brandToneEvaluator,
      complianceEvaluator,
      accessibilityEvaluator,
      localisationEquivalenceEvaluator,
    ],
    // MVP-2 — the full chain (spec §6.4–§6.6). Roll-out artifacts must trace to
    // approved content and stay compliant; optimisation actions must trace to the
    // metrics/KPIs that justify them; refreshed content re-enters the SAME
    // brand/compliance/accessibility gates as net-new (§6.6 "no optimisation
    // bypasses brand, compliance or accessibility").
    [Stage.Rollout]: [lineageEvaluator, complianceEvaluator],
    // Optimisation can change content (apply-winner) — so brand/compliance apply
    // here too: no optimisation bypasses the gates (§6.6), and regression checks
    // that a refresh never degrades what was winning (§9.2).
    [Stage.CampaignOptimisation]: [lineageEvaluator, brandToneEvaluator, complianceEvaluator],
    [Stage.ContentOptimisation]: [
      lineageEvaluator,
      brandToneEvaluator,
      complianceEvaluator,
      accessibilityEvaluator,
      regressionEvaluator,
    ],
  });
}
