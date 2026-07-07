import { ArtifactKind, Stage } from "../domain/types";
import { defineAgent, findArtifactId, type Agent } from "../orchestration/agent";

/** Stage 2 · Content Planning agents (spec §6.2). */

const role = "content-strategist";

export const conceptAgent: Agent = defineAgent({
  name: "Concept / Ideator Agent",
  stage: Stage.ContentPlanning,
  role,
  kind: ArtifactKind.Concept,
  title: "Selected concept",
  system: "You are Hilti's Concept Agent. Generate and rank creative concepts from the strategy.",
  query: () => "concept uptime no compromise brand tone narrative",
  rationale: "Highest fit to the locked KPI and brand tone; strongest differentiation among ranked options.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.Strategy),
  body: () => ({
    selected: "No downtime, no compromise",
    narrative: "Follow a crew through a demanding jobsite day where the tools never quit.",
    rankedAlternatives: ["One platform, every job", "Built to outlast the shift"],
  }),
});

export const storyboardAgent: Agent = defineAgent({
  name: "Storyboard Agent",
  stage: Stage.ContentPlanning,
  role,
  kind: ArtifactKind.Storyboard,
  title: "Hero storyboard",
  system: "You are Hilti's Storyboard Agent. Build visual/narrative storyboards for hero content.",
  query: () => "storyboard jobsite hero imagery narrative sequence",
  rationale: "Sequenced a hero narrative that pays off the selected concept across three beats.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.Concept),
  body: () => ({
    frames: [
      { beat: "Sunrise on site", note: "Crew gears up; batteries charged." },
      { beat: "Peak load", note: "Tools run hard through the toughest cut." },
      { beat: "End of shift", note: "Still going — no downtime, no compromise." },
    ],
  }),
});

export const calendarAgent: Agent = defineAgent({
  name: "Content Calendar Agent",
  stage: Stage.ContentPlanning,
  role,
  kind: ArtifactKind.ContentCalendar,
  title: "Content calendar",
  system: "You are Hilti's Content Calendar Agent. Sequence deliverables across channels and dates.",
  query: () => "content calendar channels sequencing launch schedule",
  rationale: "Mapped deliverables to the media plan's channels and a front-loaded launch cadence.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.MediaPlan),
  body: () => ({
    entries: [
      { week: 1, channel: "paid-social", deliverable: "Launch hero + 2 variants" },
      { week: 1, channel: "landing-page", deliverable: "Launch landing page" },
      { week: 2, channel: "email", deliverable: "Nurture #1" },
    ],
  }),
});

export const briefingAgent: Agent = defineAgent({
  name: "Briefing Agent",
  stage: Stage.ContentPlanning,
  role,
  kind: ArtifactKind.CreativeBrief,
  title: "Campaign Scope Brief",
  system: "You are Hilti's Briefing Agent. Write precise, brand-grounded briefs per channel/asset.",
  query: () => "channel brief paid social email landing DACH transcreation regulation",
  rationale: "Formalised the Campaign Scope Brief per channel — the versioned contract between planning and creation.",
  derivedFrom: (ctx) => [
    ...findArtifactId(ctx, ArtifactKind.Concept),
    ...findArtifactId(ctx, ArtifactKind.Messaging),
  ],
  body: () => ({
    channels: ["paid-social", "email", "landing-page"],
    mandatoryElements: ["Approved claim with test-condition footnote", "Hilti logo & red brand system"],
    toneNotes: "Confident, expert, direct. DACH requires transcreation, not literal translation.",
  }),
});

export const journeyAgent: Agent = defineAgent({
  name: "Journey / Nurture Design Agent",
  stage: Stage.ContentPlanning,
  role,
  kind: ArtifactKind.Journey,
  title: "Nurture journey",
  system: "You are Hilti's Journey Agent. Design multi-touch journeys, especially for email/nurture.",
  query: () => "nurture journey email multi-touch sequence lead",
  rationale: "Designed a three-touch nurture that moves a lead from awareness to demo request.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.Audience),
  body: () => ({
    touches: [
      { step: 1, channel: "email", goal: "awareness", trigger: "form submit" },
      { step: 2, channel: "email", goal: "consideration", trigger: "+3 days" },
      { step: 3, channel: "email", goal: "demo request", trigger: "+7 days" },
    ],
  }),
});

export const pdpAgent: Agent = defineAgent({
  name: "PDP Agent",
  stage: Stage.ContentPlanning,
  role,
  kind: ArtifactKind.PdpPlan,
  title: "PDP content plan",
  system: "You are Hilti's PDP Agent. Plan product-detail-page content for product-led campaigns.",
  query: () => "product detail page content specs claims cordless platform",
  rationale: "Planned PDP sections around approved specs and the uptime proof points.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.ValueProp),
  body: () => ({
    sections: ["Hero", "Key specs", "Uptime proof", "Fleet compatibility", "Buy / request demo"],
  }),
});

export const contentPlanningAgents: Agent[] = [
  conceptAgent,
  storyboardAgent,
  calendarAgent,
  briefingAgent,
  journeyAgent,
  pdpAgent,
];
