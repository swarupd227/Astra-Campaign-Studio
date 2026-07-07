import { ArtifactKind, Stage } from "../domain/types";
import { defineAgent, findArtifactId, type Agent, type AgentContext } from "../orchestration/agent";
import { ANALYTICS_SCOPES, type PerformanceSnapshot } from "../integrations/analytics";

/**
 * Stage 5 · Campaign Optimisation agents (spec §6.5) — watch performance against
 * the KPIs locked in planning and act WITHIN GUARDRAILS. Small reversible moves
 * run bounded-auto (L3); anything above the pre-approved threshold declares
 * `exceedsGuardrails` and requires a human regardless of the autonomy dial.
 */

const role = "performance-marketer";

/** Pre-approved guardrail (would come from the Budget & Pacing plan in full). */
export const BUDGET_SHIFT_GUARDRAIL = 0.1; // ≤10% of channel budget may move automatically

/** Reads live performance through the governed analytics connector. */
export const performanceManagementAgent: Agent = {
  name: "Performance Management Agent",
  stage: Stage.CampaignOptimisation,
  role,
  async propose(ctx: AgentContext) {
    let snapshot: PerformanceSnapshot | undefined;
    if (ctx.connectors) {
      snapshot = (await ctx.connectors.invoke(
        "analytics",
        "fetch_performance",
        { campaignId: ctx.campaignId },
        {
          campaignId: ctx.campaignId,
          actor: { kind: "agent", id: "Performance Management Agent", displayName: "Performance Management Agent" },
          grantedScopes: ctx.grantedScopes ?? [ANALYTICS_SCOPES.read],
        },
      )) as PerformanceSnapshot;
    }
    const channels = snapshot?.channels ?? [];
    const totals = channels.reduce(
      (a, c) => ({ leads: a.leads + c.leads, spend: a.spend + c.spend }),
      { leads: 0, spend: 0 },
    );
    return {
      kind: ArtifactKind.Metric,
      stage: Stage.CampaignOptimisation,
      title: "Performance snapshot",
      body: {
        observation: snapshot?.observation ?? 0,
        channels,
        totals: { ...totals, blendedCpl: totals.leads ? Math.round(totals.spend / totals.leads) : 0 },
      },
      rationale: "Pulled live channel performance and compared it against the KPIs locked at planning.",
      citations: [],
      derivedFrom: findArtifactId(ctx, ArtifactKind.Kpi),
    };
  },
};

export const budgetReallocationAgent: Agent = {
  name: "Budget Reallocation Agent",
  stage: Stage.CampaignOptimisation,
  role,
  async propose(ctx: AgentContext) {
    const shift = 0.08; // 8% — inside the pre-approved guardrail
    return {
      kind: ArtifactKind.Metric,
      stage: Stage.CampaignOptimisation,
      title: "Budget move — within guardrails",
      body: {
        action: "reallocate",
        from: "paid-social",
        to: "email",
        share: shift,
        reason: "Paid-social CTR is fatiguing while email CPL is the strongest — shifting 8% of daily budget.",
        reversible: true,
      },
      rationale: `Shifted ${Math.round(shift * 100)}% of daily budget toward the best CPL — inside the ${Math.round(BUDGET_SHIFT_GUARDRAIL * 100)}% guardrail, so it applies automatically and is fully reversible.`,
      citations: [],
      derivedFrom: findArtifactId(ctx, ArtifactKind.Metric),
      exceedsGuardrails: shift > BUDGET_SHIFT_GUARDRAIL,
    };
  },
};

export const bidPacingAgent: Agent = defineAgent({
  name: "Bid / Pacing Agent",
  stage: Stage.CampaignOptimisation,
  role,
  kind: ArtifactKind.Note,
  title: "Bid & pacing adjustments",
  system: "You are Hilti's Bid/Pacing Agent. Tune bids and delivery within guardrails.",
  query: () => "bid pacing delivery guardrails daily cap",
  rationale: "Nudged bids down 5% on fatiguing placements and smoothed delivery to the daily cap — reversible, in-guardrail.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.Metric),
  body: () => ({ adjustments: [{ placement: "paid-social/feed", bidChange: -0.05 }], withinGuardrails: true }),
});

export const experimentationAgent: Agent = defineAgent({
  name: "Experimentation / A-B Agent",
  stage: Stage.CampaignOptimisation,
  role,
  kind: ArtifactKind.Note,
  title: "A/B test — headline variants",
  system: "You are Hilti's Experimentation Agent. Design, run and read experiments.",
  query: () => "ab test experiment variant headline significance",
  rationale: "Set up a 50/50 headline test on paid-social; readout at 95% confidence or 7 days.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.Metric),
  body: () => ({
    hypothesis: "The benefit-led headline beats the product-led headline on CTR.",
    split: "50/50",
    readout: "95% confidence or 7 days",
  }),
});

export const anomalyAgent: Agent = defineAgent({
  name: "Anomaly Detection Agent",
  stage: Stage.CampaignOptimisation,
  role,
  kind: ArtifactKind.Note,
  title: "Anomaly watch",
  system: "You are Hilti's Anomaly Detection Agent. Flag sudden drops, fraud or delivery issues.",
  query: () => "anomaly detection drop delivery fraud monitor",
  rationale: "Paid-social CTR is decaying steadily (creative fatigue pattern) — flagged for content optimisation; no fraud signals.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.Metric),
  body: () => ({ findings: [{ signal: "paid-social CTR decay", severity: "medium", pattern: "creative fatigue" }] }),
});

/** A material move — above guardrails, so it must wait for a human even at L3. */
export const performanceOptimisationAgent: Agent = {
  name: "Performance Optimisation Agent",
  stage: Stage.CampaignOptimisation,
  role,
  async propose(ctx: AgentContext) {
    const shift = 0.25; // 25% — material, above the guardrail
    return {
      kind: ArtifactKind.Metric,
      stage: Stage.CampaignOptimisation,
      title: "Budget move — needs approval",
      body: {
        action: "reallocate",
        from: "paid-social",
        to: "email",
        share: shift,
        reason: "Sustained fatigue on paid-social; a material shift would hit the lead target sooner.",
        reversible: true,
      },
      rationale: `Recommends moving ${Math.round(shift * 100)}% of budget — above the ${Math.round(BUDGET_SHIFT_GUARDRAIL * 100)}% guardrail, so it is queued for the Performance Marketer regardless of the autonomy dial.`,
      citations: [],
      derivedFrom: findArtifactId(ctx, ArtifactKind.Metric),
      exceedsGuardrails: shift > BUDGET_SHIFT_GUARDRAIL,
    };
  },
};

/** Deterministic pseudo-random in [0,1) (same scheme as the analytics connector). */
function seeded(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

const WINNER_HEADLINE = "Zero downtime. Total control.";

/** Reads the A/B test out (§6.5 "designs, runs and READS experiments"). */
export const experimentReadoutAgent: Agent = {
  name: "Experiment Readout Agent",
  stage: Stage.CampaignOptimisation,
  role,
  async propose(ctx: AgentContext) {
    const experiment = Object.values(ctx.campaign.artifacts).find((a) => a.title.startsWith("A/B test"));
    const lift = Math.round(8 + seeded(`${ctx.campaignId}|exp-lift`) * 12); // 8–20%
    return {
      kind: ArtifactKind.Note,
      stage: Stage.CampaignOptimisation,
      title: "A/B readout — headline variants",
      body: {
        winner: "Variant B (benefit-led)",
        winnerHeadline: WINNER_HEADLINE,
        lift: `+${lift}% CTR`,
        confidence: "96%",
        decision: "Apply the winning variant to the live creative.",
      },
      rationale: `Variant B beat the control by ${lift}% CTR at 96% confidence — recommending it replace the live headline.`,
      citations: [],
      derivedFrom: experiment ? [experiment.id] : findArtifactId(ctx, ArtifactKind.Metric),
    };
  },
};

/**
 * Applies the experiment winner to the live creative. Content changes are
 * brand-sensitive, so this runs at Draft autonomy (human approval) and passes the
 * same brand/compliance gates — no optimisation bypasses them (§6.6).
 */
export const applyWinnerAgent: Agent = {
  name: "Apply Winner Agent",
  stage: Stage.CampaignOptimisation,
  role: "creator", // creative change → Draft autonomy → explicit human approval
  async propose(ctx: AgentContext) {
    const readout = Object.values(ctx.campaign.artifacts).find((a) => a.title.startsWith("A/B readout"));
    const current = Object.values(ctx.campaign.artifacts).find(
      (a) => a.title === "Paid-social copy" && a.status === "approved",
    );
    const winnerHeadline = (readout?.body as { winnerHeadline?: string })?.winnerHeadline ?? WINNER_HEADLINE;
    return {
      kind: ArtifactKind.ContentItem,
      stage: Stage.CampaignOptimisation,
      title: "Paid-social copy", // same title → approving this supersedes the live version
      body: {
        ...(current?.body ?? {}),
        channel: "paid-social",
        headline: winnerHeadline,
        body: "The new Hilti cordless platform delivers extended runtime¹ so your crew keeps moving.",
        footnote: "¹ Runtime measured under standard test conditions; substantiation on file.",
        appliedFromExperiment: true,
      },
      rationale: "Applies the A/B winner to the live creative — same claim and substantiation, proven headline.",
      citations: current?.citations ?? [],
      derivedFrom: [readout?.id, current?.id].filter((x): x is string => Boolean(x)),
    };
  },
};

export const optimisationAgents: Agent[] = [
  performanceManagementAgent,
  budgetReallocationAgent,
  bidPacingAgent,
  experimentationAgent,
  anomalyAgent,
  performanceOptimisationAgent,
  experimentReadoutAgent,
  applyWinnerAgent,
];
