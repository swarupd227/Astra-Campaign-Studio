import { ArtifactKind, Stage } from "../domain/types";
import { defineAgent, type Agent } from "../orchestration/agent";

/** Stage 0 · Demand & Brief Intake agents (spec §6.0). */

export const intakeAgent: Agent = defineAgent({
  name: "Intake Agent",
  stage: Stage.Intake,
  role: "campaign-manager",
  kind: ArtifactKind.Brief,
  title: "Campaign brief",
  system: "You are Hilti's Intake Agent. Structure a campaign brief; ask only what is missing.",
  query: (ctx) => `${ctx.campaign.campaign.objective} product market audience budget`,
  rationale: "Structured the brief from the request; grounded product/market facts; gaps flagged as questions.",
  body: (ctx) => ({
    objective: ctx.campaign.campaign.objective,
    markets: ctx.campaign.campaign.markets,
    budget: ctx.campaign.campaign.budget,
    successMetric: ctx.campaign.campaign.kpis[0] ?? "TBD",
    mandatoryClaims:
      ctx.campaign.campaign.mandatoryClaims ??
      "Cordless performance claims require a test-condition footnote.",
    openQuestions: ["Confirm primary success metric", "Confirm launch window per market"],
  }),
});

export const researchAgent: Agent = defineAgent({
  name: "Research Agent",
  stage: Stage.Intake,
  role: "campaign-manager",
  kind: ArtifactKind.Note,
  title: "Intake research pack",
  system: "You are Hilti's Research Agent. Pull product facts, prior campaigns and market context to pre-fill the brief.",
  query: () => "prior cordless launch performance market context product facts",
  rationale: "Pre-filled the brief with product facts and prior-campaign performance to reduce interview burden.",
  body: () => ({
    priorPerformance: "Uptime-led messaging outperformed price-led by 34% CTR in paid social.",
    productFacts: "Nuron 22V — one battery platform; extended runtime with active temperature management.",
  }),
});

export const prioritisationAgent: Agent = defineAgent({
  name: "Prioritisation Agent",
  stage: Stage.Intake,
  role: "campaign-manager",
  kind: ArtifactKind.Note,
  title: "Portfolio fit score",
  system: "You are Hilti's Prioritisation Agent. Score the request against portfolio capacity and strategic fit.",
  query: (ctx) => `${ctx.campaign.campaign.objective} strategic fit priority`,
  rationale: "Scored the request against portfolio capacity and strategic fit; flagged no conflicts with in-flight campaigns.",
  body: (ctx) => ({
    strategicFit: "high",
    capacity: "available",
    duplicateCheck: "no overlapping in-flight campaign detected",
    recommendedPriority: ctx.campaign.campaign.budget > 500_000 ? "P1" : "P2",
  }),
});

export const intakeAgents: Agent[] = [intakeAgent, researchAgent, prioritisationAgent];
