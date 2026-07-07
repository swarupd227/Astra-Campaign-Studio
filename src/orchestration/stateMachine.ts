import {
  ArtifactKind,
  ArtifactStatus,
  STAGE_ORDER,
  Stage,
  type CampaignObject,
} from "../domain/types";

/**
 * The campaign state machine (spec §7.1/§11.2): each stage declares the artifact
 * kinds that must be approved before the campaign can advance. Transitions
 * require passing gates and, where policy demands, human approval — this is what
 * makes "human-in-the-loop" structural rather than decorative.
 */
const STAGE_EXIT_REQUIREMENTS: Partial<Record<Stage, ArtifactKind[]>> = {
  // The "primary output" of each stage (spec §4.1) — the artifacts that must be
  // human-approved before the campaign can advance. Not every agent's output
  // gates the stage; these are the contract deliverables.
  [Stage.Intake]: [ArtifactKind.Brief],
  [Stage.CampaignPlanning]: [ArtifactKind.Strategy, ArtifactKind.MediaPlan, ArtifactKind.Kpi],
  [Stage.ContentPlanning]: [
    ArtifactKind.Concept,
    ArtifactKind.CreativeBrief,
    ArtifactKind.ContentCalendar,
  ],
  [Stage.ContentCreation]: [ArtifactKind.ContentItem],
  // MVP-2 — the full chain (spec §6.4–§6.6).
  [Stage.Rollout]: [ArtifactKind.Deployment],
  [Stage.CampaignOptimisation]: [ArtifactKind.Metric],
  [Stage.ContentOptimisation]: [ArtifactKind.ContentItem, ArtifactKind.Learning],
};

export interface GateStatus {
  stage: Stage;
  satisfied: boolean;
  missing: ArtifactKind[];
}

export function nextStage(current: Stage): Stage | null {
  const i = STAGE_ORDER.indexOf(current);
  return i >= 0 && i < STAGE_ORDER.length - 1 ? STAGE_ORDER[i + 1]! : null;
}

/** Which required artifact kinds for the current stage are not yet approved. */
export function gateStatus(obj: CampaignObject): GateStatus {
  const stage = obj.campaign.currentStage;
  const required = STAGE_EXIT_REQUIREMENTS[stage] ?? [];
  // Stage-scoped: only artifacts PRODUCED IN this stage satisfy its gate — a
  // stage-3 content item can't satisfy stage 6's refreshed-content requirement.
  const approvedKinds = new Set(
    Object.values(obj.artifacts)
      .filter((a) => a.status === ArtifactStatus.Approved && a.stage === stage)
      .map((a) => a.kind),
  );
  const missing = required.filter((k) => !approvedKinds.has(k));
  return { stage, satisfied: missing.length === 0, missing };
}

export function canAdvance(obj: CampaignObject): boolean {
  return gateStatus(obj).satisfied && nextStage(obj.campaign.currentStage) !== null;
}
