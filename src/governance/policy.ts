import { AutonomyLevel, Stage, type ArtifactKind } from "../domain/types";

/** A policy key: an action by a role at a stage resolves to an autonomy level. */
export interface PolicyRule {
  role: string;
  stage: Stage;
  autonomy: AutonomyLevel;
}

/** The autonomy dial (spec §7.2) — for the Admin console selector. */
export const AUTONOMY_META: { level: AutonomyLevel; name: string; behaviour: string }[] = [
  { level: AutonomyLevel.Assistive, name: "L0 · Assistive", behaviour: "Suggests; the human does everything." },
  { level: AutonomyLevel.Draft, name: "L1 · Draft", behaviour: "Produces drafts; the human edits and decides." },
  { level: AutonomyLevel.SupervisedAuto, name: "L2 · Supervised", behaviour: "Acts, but every action is queued for approval." },
  { level: AutonomyLevel.BoundedAuto, name: "L3 · Bounded", behaviour: "Acts within guardrails; logged and reversible." },
  { level: AutonomyLevel.Autonomous, name: "L4 · Autonomous", behaviour: "Always-on within tight guardrails." },
];

export function isAutonomyLevel(v: unknown): v is AutonomyLevel {
  return typeof v === "string" && AUTONOMY_META.some((m) => m.level === v);
}

export interface PolicyDecision {
  autonomy: AutonomyLevel;
  /** Whether the action requires an explicit human approval before it takes effect. */
  requiresHumanApproval: boolean;
  reason: string;
}

/**
 * Central policy engine (spec §9.1) — autonomy is resolved from policy at
 * runtime, never hard-coded in an agent. Also enforces hard guardrails that the
 * platform cannot cross regardless of instruction (§9.1 guardrails).
 */
export class PolicyEngine {
  private rules: PolicyRule[];

  constructor(rules: PolicyRule[] = defaultPolicy()) {
    this.rules = rules;
  }

  /** Resolve the autonomy level for a role acting at a stage. */
  resolve(role: string, stage: Stage): AutonomyLevel {
    const rule = this.rules.find((r) => r.role === role && r.stage === stage);
    return rule?.autonomy ?? AutonomyLevel.Draft; // safe default: human decides
  }

  /** The current policy rules (for the Admin console). */
  list(): PolicyRule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  /** Set the autonomy level for a role/stage (Admin console — the autonomy dial, §7.2). */
  setAutonomy(role: string, stage: Stage, autonomy: AutonomyLevel): void {
    const existing = this.rules.find((r) => r.role === role && r.stage === stage);
    if (existing) existing.autonomy = autonomy;
    else this.rules = [...this.rules, { role, stage, autonomy }];
  }

  /**
   * Decide whether an action needs human approval.
   * Brand-critical artifacts and any externally-irreversible action always do —
   * a governance non-negotiable (spec §6.4, §9.1), regardless of autonomy level.
   */
  decide(params: {
    role: string;
    stage: Stage;
    artifactKind: ArtifactKind;
    externalIrreversible?: boolean;
    /** From the proposing agent: does this action exceed pre-approved guardrails (§6.5)? */
    exceedsGuardrails?: boolean;
  }): PolicyDecision {
    const autonomy = this.resolve(params.role, params.stage);

    if (params.externalIrreversible) {
      return {
        autonomy,
        requiresHumanApproval: true,
        reason: "External/irreversible action (publish, send, spend) always requires human approval.",
      };
    }

    // Bounded autonomy is bounded: above-guardrail moves need a human regardless
    // of the dial (spec §6.5 — "material spend shifts stay human-approved").
    if (params.exceedsGuardrails) {
      return {
        autonomy,
        requiresHumanApproval: true,
        reason: "Exceeds the pre-approved guardrails — human approval required regardless of autonomy level.",
      };
    }

    // L3/L4 may act within guardrails without a per-action approval.
    const boundedOrAbove =
      autonomy === AutonomyLevel.BoundedAuto || autonomy === AutonomyLevel.Autonomous;

    if (boundedOrAbove) {
      return {
        autonomy,
        requiresHumanApproval: false,
        reason: `Autonomy ${autonomy}: acts within guardrails; logged and reversible.`,
      };
    }

    return {
      autonomy,
      requiresHumanApproval: true,
      reason: `Autonomy ${autonomy}: human review required before the action takes effect.`,
    };
  }
}

/**
 * A sensible default RACI-derived policy for MVP-1 (spec §5.2). Planning runs
 * supervised-auto; brand-sensitive creation always needs explicit approval.
 */
export function defaultPolicy(): PolicyRule[] {
  return [
    { role: "campaign-manager", stage: Stage.Intake, autonomy: AutonomyLevel.SupervisedAuto },
    { role: "strategist", stage: Stage.CampaignPlanning, autonomy: AutonomyLevel.SupervisedAuto },
    { role: "content-strategist", stage: Stage.ContentPlanning, autonomy: AutonomyLevel.Draft },
    { role: "creator", stage: Stage.ContentCreation, autonomy: AutonomyLevel.Draft },
    // MVP-2 (spec §6.4–§6.6): publishing prep queues for approval; optimisation
    // runs bounded-auto — within-guardrail moves apply automatically, anything
    // above the threshold still needs a human (enforced via Proposal.guardrail).
    { role: "channel-specialist", stage: Stage.Rollout, autonomy: AutonomyLevel.SupervisedAuto },
    { role: "performance-marketer", stage: Stage.CampaignOptimisation, autonomy: AutonomyLevel.BoundedAuto },
    { role: "performance-marketer", stage: Stage.ContentOptimisation, autonomy: AutonomyLevel.SupervisedAuto },
  ];
}
