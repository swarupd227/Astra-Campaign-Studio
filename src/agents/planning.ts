import { ArtifactKind, Stage } from "../domain/types";
import { defineAgent, findArtifactId, groundedGenerate, type Agent } from "../orchestration/agent";

/** Stage 1 · Campaign Planning agents (spec §6.1). All derive from the approved Brief. */

const role = "strategist";
const briefLineage = (ctx: Parameters<typeof findArtifactId>[0]) =>
  findArtifactId(ctx, ArtifactKind.Brief);

export const strategyAgent: Agent = defineAgent({
  name: "MarComms Strategy Agent",
  stage: Stage.CampaignPlanning,
  role,
  kind: ArtifactKind.Strategy,
  title: "Campaign strategy",
  system: "You are Hilti's MarComms Strategy Agent. Frame strategy, objectives and the messaging hierarchy.",
  query: () => "positioning messaging uptime tone of voice prior performance",
  rationale: "Grounded in tone of voice and prior uptime-led performance (+34% CTR).",
  derivedFrom: briefLineage,
  body: () => ({
    positioning: "Own the jobsite-uptime narrative for the new cordless platform.",
    objective: "Drive qualified leads for the cordless launch in DACH and the US.",
    messagingHierarchy: ["Uptime", "Durability", "Total cost of ownership"],
  }),
});

/**
 * Audience / Segmentation Agent — grounds segment sizing on the SFMC Data
 * Extension (read, MVP-1, spec §6.1): sizes come from Hilti's marketing-cloud
 * audience data via the governed connector, not a model's guess. Falls back to
 * qualitative sizing if the connector is unavailable.
 */
export const audienceAgent: Agent = {
  name: "Audience / Segmentation Agent",
  stage: Stage.CampaignPlanning,
  role,
  async propose(ctx) {
    const { citations } = await groundedGenerate(ctx, {
      system: "You are Hilti's Audience Agent. Define target segments, personas and sizing.",
      query: "professional trades segments personas market",
      buildPrompt: (context) => `Grounding:\n${context}\n\nTask: produce "Target audiences".`,
    });

    let segments: Record<string, unknown>[] = [
      { name: "General contractors", size: "large", priority: 1 },
      { name: "Electrical & MEP", size: "medium", priority: 2 },
    ];
    let sizedFrom = "market heuristics";
    if (ctx.connectors?.get("sfmc-data")) {
      try {
        const de = (await ctx.connectors.invoke(
          "sfmc-data",
          "read_data_extension",
          { key: "Audience_Segments" },
          {
            campaignId: ctx.campaignId,
            actor: { kind: "agent", id: "agent_audience", displayName: "Audience / Segmentation Agent" },
            grantedScopes: ctx.grantedScopes ?? [],
          },
        )) as { rows: { segment: string; market: string; contacts: number; consentedShare: number }[]; source: string };
        // Aggregate contacts per segment across the campaign's markets.
        const bySegment = new Map<string, { contacts: number; consented: number }>();
        for (const row of de.rows) {
          const agg = bySegment.get(row.segment) ?? { contacts: 0, consented: 0 };
          agg.contacts += row.contacts;
          agg.consented += Math.round(row.contacts * row.consentedShare);
          bySegment.set(row.segment, agg);
        }
        segments = [...bySegment.entries()]
          .sort((a, b) => b[1].contacts - a[1].contacts)
          .map(([name, agg], i) => ({
            name,
            contacts: agg.contacts,
            consentedReach: agg.consented,
            priority: i + 1,
          }));
        sizedFrom = de.source === "sfmc-live" ? "SFMC Data Extension (live)" : "SFMC Data Extension (local dataset)";
      } catch {
        // Governance denial / connector failure → keep the qualitative fallback.
      }
    }

    return {
      kind: ArtifactKind.Audience,
      stage: Stage.CampaignPlanning,
      title: "Target audiences",
      body: { segments, sizedFrom },
      rationale: `Defined target segments with sizing grounded in ${sizedFrom} — consented reach drives channel weighting downstream.`,
      citations,
      derivedFrom: findArtifactId(ctx, ArtifactKind.Brief),
    };
  },
};

export const valuePropAgent: Agent = defineAgent({
  name: "Value Proposition Agent",
  stage: Stage.CampaignPlanning,
  role,
  kind: ArtifactKind.ValueProp,
  title: "Value proposition",
  system: "You are Hilti's Value Proposition Agent. Sharpen the offer and differentiation per audience.",
  query: () => "value proposition differentiation uptime total cost of ownership",
  rationale: "Sharpened the offer around uptime and TCO — the strongest differentiators per grounding.",
  derivedFrom: briefLineage,
  body: () => ({
    core: "No downtime, no compromise — one battery platform that keeps the crew moving.",
    differentiators: ["Fleet-wide battery", "Active temperature management", "Lower total cost of ownership"],
  }),
});

export const messagingAgent: Agent = defineAgent({
  name: "Messaging Agent",
  stage: Stage.CampaignPlanning,
  role,
  kind: ArtifactKind.Messaging,
  title: "Message architecture",
  system: "You are Hilti's Messaging Agent. Produce the message architecture and proof points.",
  query: () => "message architecture proof points approved claim footnote",
  rationale: "Built the message architecture with substantiated proof points aligned to approved claims.",
  derivedFrom: briefLineage,
  body: () => ({
    pillars: [
      { message: "Maximum uptime", proof: "Extended runtime with active temperature management¹" },
      { message: "Built for the jobsite", proof: "Durability tested to Hilti standards" },
    ],
    note: "¹ Requires test-condition footnote in all customer-facing copy.",
  }),
});

export const mediaPlanAgent: Agent = defineAgent({
  name: "Media / Channel Plan Agent",
  stage: Stage.CampaignPlanning,
  role,
  kind: ArtifactKind.MediaPlan,
  title: "Channel & media plan",
  system: "You are Hilti's Media Plan Agent. Recommend channel mix, sequencing and budget split.",
  query: () => "channel mix paid social email landing sequencing budget",
  rationale: "Recommended an uptime-led paid-social lead, supported by email nurture and a landing page.",
  derivedFrom: briefLineage,
  body: (ctx) => ({
    channels: [
      { channel: "paid-social", role: "reach", budgetShare: 0.5 },
      { channel: "email", role: "nurture", budgetShare: 0.2 },
      { channel: "landing-page", role: "convert", budgetShare: 0.3 },
    ],
    totalBudget: ctx.campaign.campaign.budget,
    markets: ctx.campaign.campaign.markets,
  }),
});

export const budgetAgent: Agent = defineAgent({
  name: "Budget & Pacing Agent",
  stage: Stage.CampaignPlanning,
  role,
  kind: ArtifactKind.Budget,
  title: "Budget & pacing plan",
  system: "You are Hilti's Budget & Pacing Agent. Allocate and pace spend against objectives.",
  query: () => "budget pacing allocation guardrails spend cap",
  rationale: "Allocated spend across channels with a front-loaded launch pacing and a per-market cap guardrail.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.MediaPlan),
  body: (ctx) => ({
    total: ctx.campaign.campaign.budget,
    pacing: "front-loaded first 2 weeks, then even",
    guardrail: { perMarketDailyCap: Math.round(ctx.campaign.campaign.budget / 40) },
  }),
});

export const competitiveAgent: Agent = defineAgent({
  name: "Competitive Insights Agent",
  stage: Stage.CampaignPlanning,
  role,
  kind: ArtifactKind.CompetitiveInsight,
  title: "Competitive positioning",
  system: "You are Hilti's Competitive Insights Agent. Position against competitor activity and share of voice.",
  query: () => "competitor activity share of voice comparative advertising DACH",
  rationale: "Positioned against price-led competitors; comparative claims flagged as substantiation-required in DACH.",
  derivedFrom: briefLineage,
  body: () => ({
    competitorAngle: "Competitors lead on price; we lead on uptime and TCO.",
    regulatoryFlag: "DACH comparative advertising requires substantiation.",
  }),
});

export const kpiAgent: Agent = defineAgent({
  name: "Objective & KPI Agent",
  stage: Stage.CampaignPlanning,
  role,
  kind: ArtifactKind.Kpi,
  title: "Locked KPIs",
  system: "You are Hilti's Objective & KPI Agent. Lock measurable targets and guardrail metrics.",
  query: (ctx) => `${ctx.campaign.campaign.kpis.join(" ")} targets guardrail metrics`,
  rationale: "Locked measurable KPIs and guardrail metrics so Stage 5 optimises toward agreed targets, not invented ones.",
  derivedFrom: briefLineage,
  body: (ctx) => ({
    primary: ctx.campaign.campaign.kpis[0] ?? "Qualified leads",
    targets: { qualifiedLeads: 1200, paidSocialCtr: 0.018 },
    guardrails: { maxCpl: 45, minBrandSafetyScore: 0.9 },
  }),
});

export const planningAgents: Agent[] = [
  strategyAgent,
  audienceAgent,
  valuePropAgent,
  messagingAgent,
  mediaPlanAgent,
  budgetAgent,
  competitiveAgent,
  kpiAgent,
];
