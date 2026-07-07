import { Stage, type ArtifactKind } from "./types";

/**
 * Human-readable labels for internal enums, used anywhere text is rendered to
 * users (audit feed, access messages, API replies). Keeps product copy free of
 * the internal slugs the code uses.
 */

const STAGE_LABELS: Record<Stage, string> = {
  [Stage.Intake]: "Intake",
  [Stage.CampaignPlanning]: "Campaign planning",
  [Stage.ContentPlanning]: "Content planning",
  [Stage.ContentCreation]: "Content creation",
  [Stage.Rollout]: "Roll-out",
  [Stage.CampaignOptimisation]: "Campaign optimisation",
  [Stage.ContentOptimisation]: "Content optimisation",
};

const KIND_LABELS: Record<string, string> = {
  brief: "Brief",
  strategy: "Strategy",
  audience: "Audience",
  "value-prop": "Value proposition",
  messaging: "Messaging",
  "media-plan": "Media plan",
  budget: "Budget",
  "competitive-insight": "Competitive insight",
  kpi: "KPIs",
  concept: "Concept",
  storyboard: "Storyboard",
  "content-calendar": "Content calendar",
  "creative-brief": "Creative brief",
  journey: "Journey",
  "pdp-plan": "PDP plan",
  "content-item": "Content",
  asset: "Asset",
  deployment: "Deployment",
  metric: "Metric",
  learning: "Learning",
  note: "Note",
};

const EVAL_LABELS: Record<string, string> = {
  grounding: "Sourced",
  "brand-tone": "On brand",
  compliance: "Compliant",
  accessibility: "Accessible",
  "localisation-equivalence": "Localised",
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage as Stage] ?? stage;
}

export function evalLabel(name: string): string {
  return EVAL_LABELS[name] ?? name;
}

export function kindLabel(kind: ArtifactKind | string): string {
  return KIND_LABELS[kind] ?? kind;
}
