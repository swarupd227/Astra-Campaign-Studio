import { ArtifactKind, Stage } from "../domain/types";
import { defineAgent, findArtifactId, type Agent } from "../orchestration/agent";

/**
 * Stage 6 · Content Optimisation agents (spec §6.6) + the learning loop (§6.7).
 * Refreshed content is still content: it re-enters the SAME brand, compliance and
 * accessibility gates as net-new work. The Learning Agent distils what won into a
 * Learning artifact — approved learnings are written back into the knowledge
 * fabric, so the next campaign starts smarter.
 */

const role = "performance-marketer";
const FOOTNOTE = "¹ Runtime measured under standard test conditions; substantiation on file.";

export const fatigueDetectionAgent: Agent = defineAgent({
  name: "Fatigue / Decay Detection Agent",
  stage: Stage.ContentOptimisation,
  role,
  kind: ArtifactKind.Note,
  title: "Fatigue & decay report",
  system: "You are Hilti's Fatigue Detection Agent. Identify tiring creative and decaying pages.",
  query: () => "creative fatigue decay ctr decline refresh",
  rationale: "Paid-social hero is fatiguing (CTR down across observations); landing page holds steady.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.Metric),
  body: () => ({
    fatigued: [{ item: "Paid-social copy", signal: "CTR decay across snapshots", priority: 1 }],
    healthy: ["Landing page", "Launch email"],
  }),
});

export const refreshAgent: Agent = defineAgent({
  name: "Refresh & Repurpose Agent",
  stage: Stage.ContentOptimisation,
  role: "creator", // reworking creative is a Creator-pattern task
  kind: ArtifactKind.ContentItem,
  title: "Paid-social copy — refresh",
  system: "You are Hilti's Refresh Agent. Rework high-potential content into new variants.",
  query: () => "refresh copy variant fatigue angle uptime tone",
  rationale: "Rotated the fatigued hero to a fresh crew-centred angle; same substantiated claim, new creative energy.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.ContentItem),
  body: () => ({
    channel: "paid-social",
    headline: "Your crew doesn't stop. Neither should your tools.",
    body: "One battery platform with extended runtime¹ — built for the shifts that run long.",
    footnote: FOOTNOTE,
  }),
});

export const adaptationAgent: Agent = defineAgent({
  name: "Channel / Persona Adaptation Agent",
  stage: Stage.ContentOptimisation,
  role: "creator",
  kind: ArtifactKind.ContentItem,
  title: "Refresh — MEP contractor variant",
  system: "You are Hilti's Adaptation Agent. Adapt assets to new channels and personas.",
  query: () => "persona adaptation electrical MEP contractor variant",
  rationale: "Adapted the refreshed hero for the MEP-contractor persona surfaced in planning.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.ContentItem),
  body: () => ({
    channel: "paid-social",
    persona: "Electrical & MEP",
    headline: "Conduit runs don't wait on chargers.",
    body: "Extended runtime¹ across one battery platform — from bender to band saw.",
    footnote: FOOTNOTE,
  }),
});

export const seoRefreshAgent: Agent = defineAgent({
  name: "SEO Refresh Agent",
  stage: Stage.ContentOptimisation,
  role,
  kind: ArtifactKind.Note,
  title: "SEO refresh plan",
  system: "You are Hilti's SEO Refresh Agent. Update content and metadata for search performance.",
  query: () => "seo refresh metadata search ranking keywords",
  rationale: "Refreshed title/description targets around rising 'battery platform' queries.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.Note),
  body: () => ({
    updates: [{ page: "Launch landing page", change: "Title + meta description refreshed for 'battery platform' queries" }],
  }),
});

export const contentOptimisationAgent: Agent = defineAgent({
  name: "Content Optimisation Agent",
  stage: Stage.ContentOptimisation,
  role,
  kind: ArtifactKind.Note,
  title: "Refresh backlog",
  system: "You are Hilti's Content Optimisation Agent. Prioritise and orchestrate the refresh backlog.",
  query: () => "refresh backlog prioritise fatigue decay orchestrate",
  rationale: "Prioritised the refresh backlog: fatigued hero first, persona variant second, SEO refresh third.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.Note),
  body: () => ({
    backlog: [
      { priority: 1, item: "Paid-social hero refresh" },
      { priority: 2, item: "MEP persona variant" },
      { priority: 3, item: "Landing page SEO refresh" },
    ],
  }),
});

/** §6.7 — distil what won; on approval this is written back to the knowledge fabric. */
export const learningAgent: Agent = defineAgent({
  name: "Learning Agent",
  stage: Stage.ContentOptimisation,
  role,
  kind: ArtifactKind.Learning,
  title: "Campaign learnings",
  system: "You are Hilti's Learning Agent. Distil outcomes into insight the next campaign starts from.",
  query: () => "learnings outcomes winning messages formats audiences",
  rationale: "Distilled the cycle's outcomes into planning priors — written back to the knowledge fabric on approval.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.Metric),
  body: () => ({
    insight:
      "Crew-centred creative outperformed product-centred as fatigue set in; email held the best CPL — substantiated by campaign analytics. Start the next cordless cycle with crew-led creative and a higher email share.",
    appliesTo: "cordless platform campaigns",
  }),
});

export const contentOptimisationAgents: Agent[] = [
  fatigueDetectionAgent,
  refreshAgent,
  adaptationAgent,
  seoRefreshAgent,
  contentOptimisationAgent,
  learningAgent,
];
