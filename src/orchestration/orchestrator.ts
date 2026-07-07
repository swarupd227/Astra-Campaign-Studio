import { newId, type Clock } from "../domain/ids";
import {
  ArtifactStatus,
  type Actor,
  type Artifact,
} from "../domain/types";
import type { EventStore } from "../store/eventStore";
import { CampaignRepository } from "../store/campaignRepository";
import type { ModelGateway } from "../gateway/modelGateway";
import type { KnowledgeFabric } from "../grounding/knowledgeFabric";
import type { EvalHarness } from "../evals/evalHarness";
import { hiltiGoldenSet, type GoldenSet } from "../evals/goldenSet";
import { PolicyEngine } from "../governance/policy";
import { canAdvance, gateStatus, nextStage } from "./stateMachine";
import type { Agent } from "./agent";
import type { ConnectorRegistry } from "../integrations/mcp";
import { AccessControl, AccessDeniedError } from "../security/roles";

export interface RunAgentOptions {
  /** Reviewer feedback to fold into the redraft (revision runs). */
  feedback?: string;
  /** Id of the artifact this run supersedes, recorded as lineage. */
  supersedes?: string;
}

export interface OrchestratorDeps {
  /** Governed MCP connectors made available to agents. */
  connectors?: ConnectorRegistry;
  /** Scopes granted to agents for connector calls. */
  agentScopes?: string[];
  /** Golden set anchoring the model-graded evaluators (spec §9.2). */
  golden?: GoldenSet;
  /** Live golden-set source (admin-tunable); takes precedence over `golden`. */
  goldenSource?: () => GoldenSet;
  /** Feedback-loop hook (§9.2): called when a human rejects work that passed the gates. */
  onReject?: (artifact: Artifact, reason: string) => void;
  /** Role authority enforcement (spec §5.2). Enforced when an approver carries a role. */
  access?: AccessControl;
}

const SYSTEM_ACTOR: Actor = { kind: "system", id: "orchestrator", displayName: "Orchestrator" };

export interface RunResult {
  artifact: Artifact;
  evals: { name: string; passed: boolean; score: number; detail: string }[];
  autoApproved: boolean;
  pendingHumanApproval: boolean;
  reason: string;
}

/**
 * The orchestrator (spec §7.1). Every agent action follows one contract —
 * propose → evaluate → (policy) → approve → execute — so governance is uniform
 * across the whole agent catalogue. It is the only component that appends the
 * approval/eval/stage events; agents merely propose.
 */
export class Orchestrator {
  private readonly repo: CampaignRepository;

  constructor(
    private readonly store: EventStore,
    private readonly gateway: ModelGateway,
    private readonly fabric: KnowledgeFabric,
    private readonly evals: EvalHarness,
    private readonly policy: PolicyEngine,
    private readonly clock: Clock,
    private readonly deps: OrchestratorDeps = {},
  ) {
    this.repo = new CampaignRepository(store);
  }

  /** Run one specialist agent through the full propose→evaluate→gate contract. */
  async runAgent(campaignId: string, agent: Agent, opts: RunAgentOptions = {}): Promise<RunResult> {
    const campaign = await this.mustLoad(campaignId);
    const agentActor: Actor = { kind: "agent", id: agent.name, displayName: agent.name };

    // 1. Propose — the agent generates against grounded context. Agents may call
    // governed connectors here (which append their own audit events), so the
    // revision is re-read from the store afterwards before we append.
    const proposal = await agent.propose({
      campaignId,
      campaign,
      gateway: this.gateway,
      fabric: this.fabric,
      ...(this.deps.connectors ? { connectors: this.deps.connectors } : {}),
      ...(this.deps.agentScopes ? { grantedScopes: this.deps.agentScopes } : {}),
      ...(opts.feedback ? { feedback: opts.feedback } : {}),
    });
    const artifact: Artifact = {
      id: newId("art"),
      kind: proposal.kind,
      stage: proposal.stage,
      version: this.nextVersion(campaign, proposal.kind, proposal.title),
      status: ArtifactStatus.Proposed,
      title: proposal.title,
      body: proposal.body,
      author: agentActor,
      citations: proposal.citations,
      passedEvals: [],
      derivedFrom: [...(proposal.derivedFrom ?? []), ...(opts.supersedes ? [opts.supersedes] : [])],
      createdAt: this.clock.now(),
    };
    // Re-read revision: propose() may have appended connector audit events.
    let rev = await this.repo.revision(campaignId);
    await this.store.append(
      campaignId,
      { type: "ArtifactProposed", artifact, rationale: proposal.rationale },
      agentActor,
      rev,
    );
    rev += 1;

    // 2. Evaluate — automated stage gates score first (spec §9.2). Model-graded
    // evaluators grade against the golden set via the gateway.
    const outcomes = await this.evals.run(artifact, {
      campaignId,
      gateway: this.gateway,
      golden: this.deps.goldenSource?.() ?? this.deps.golden ?? hiltiGoldenSet(),
      campaign,
    });
    for (const o of outcomes) {
      await this.store.append(
        campaignId,
        {
          type: "ArtifactEvaluated",
          artifactId: artifact.id,
          evalId: newId("eval"),
          evalName: o.name,
          passed: o.passed,
          score: o.score,
          detail: o.detail,
        },
        SYSTEM_ACTOR,
        rev,
      );
      rev += 1;
    }
    const allPassed = outcomes.every((o) => o.passed);

    // 3. Gate — evals must pass before any approval is even possible.
    if (!allPassed) {
      return {
        artifact,
        evals: outcomes,
        autoApproved: false,
        pendingHumanApproval: false,
        reason: "Blocked at quality gate — one or more evals failed; agent must revise.",
      };
    }

    // 4. Policy — decide whether a human must approve before it takes effect.
    const decision = this.policy.decide({
      role: agent.role,
      stage: agent.stage,
      artifactKind: artifact.kind,
      ...(proposal.exceedsGuardrails !== undefined
        ? { exceedsGuardrails: proposal.exceedsGuardrails }
        : {}),
    });

    if (!decision.requiresHumanApproval) {
      await this.store.append(
        campaignId,
        { type: "ArtifactApproved", artifactId: artifact.id, approver: SYSTEM_ACTOR, note: decision.reason },
        SYSTEM_ACTOR,
        rev,
      );
      return {
        artifact,
        evals: outcomes,
        autoApproved: true,
        pendingHumanApproval: false,
        reason: decision.reason,
      };
    }

    return {
      artifact,
      evals: outcomes,
      autoApproved: false,
      pendingHumanApproval: true,
      reason: decision.reason,
    };
  }

  /**
   * A human edits an artifact's content (spec §8.1 "edit anything, lose nothing").
   * Produces a new, human-authored version that re-runs the quality gates and lands
   * back in review — so an edit that breaks brand/compliance is caught, not shipped.
   * The prior version is superseded but retained in full history.
   */
  async editArtifact(
    campaignId: string,
    artifactId: string,
    fields: Record<string, unknown>,
    editor: Actor,
  ): Promise<RunResult> {
    const obj = await this.mustLoad(campaignId);
    const prior = obj.artifacts[artifactId];
    if (!prior) throw new Error(`Unknown artifact ${artifactId}`);

    const artifact: Artifact = {
      id: newId("art"),
      kind: prior.kind,
      stage: prior.stage,
      version: this.nextVersion(obj, prior.kind, prior.title),
      status: ArtifactStatus.Proposed,
      title: prior.title,
      body: { ...prior.body, ...fields },
      author: editor,
      citations: prior.citations, // grounding is preserved across a human edit
      passedEvals: [],
      derivedFrom: [artifactId],
      createdAt: this.clock.now(),
    };

    let rev = await this.repo.revision(campaignId);
    await this.store.append(
      campaignId,
      { type: "ArtifactProposed", artifact, rationale: `Edited by ${editor.displayName}.` },
      editor,
      rev,
    );
    rev += 1;

    const outcomes = await this.evals.run(artifact, {
      campaignId,
      gateway: this.gateway,
      golden: this.deps.goldenSource?.() ?? this.deps.golden ?? hiltiGoldenSet(),
      campaign: obj,
    });
    for (const o of outcomes) {
      await this.store.append(
        campaignId,
        {
          type: "ArtifactEvaluated",
          artifactId: artifact.id,
          evalId: newId("eval"),
          evalName: o.name,
          passed: o.passed,
          score: o.score,
          detail: o.detail,
        },
        SYSTEM_ACTOR,
        rev,
      );
      rev += 1;
    }

    const allPassed = outcomes.every((o) => o.passed);
    if (!allPassed) {
      return {
        artifact,
        evals: outcomes,
        autoApproved: false,
        pendingHumanApproval: false,
        reason: "Edit blocked at the quality gate — fix the flagged checks and save again.",
      };
    }
    return {
      artifact,
      evals: outcomes,
      autoApproved: false,
      pendingHumanApproval: true,
      reason: "Edited — awaiting approval.",
    };
  }

  /**
   * Roll back an applied optimisation action (spec §6.5 — "every optimisation is
   * explained and reversible; the human can roll back"). Appends a compensating
   * artifact (from/to swapped) with lineage to the original; the reversal itself
   * passes the stage gates and is recorded as the acting human's decision.
   */
  async rollbackArtifact(campaignId: string, artifactId: string, actor: Actor, reason: string): Promise<Artifact> {
    const obj = await this.mustLoad(campaignId);
    const prior = obj.artifacts[artifactId];
    if (!prior) throw new Error(`Unknown artifact ${artifactId}`);
    if (prior.status !== ArtifactStatus.Approved) throw new Error("Only applied actions can be rolled back.");
    const b = prior.body as { action?: string; reversible?: boolean; from?: string; to?: string; share?: number };
    if (b.action === "rollback") throw new Error("A rollback can’t be rolled back — apply a new action instead.");
    if (!b.action || b.reversible !== true) throw new Error("This item is not a reversible action.");
    const already = Object.values(obj.artifacts).some(
      (a) => (a.body as { rollbackOf?: string }).rollbackOf === artifactId && a.status !== ArtifactStatus.Rejected,
    );
    if (already) throw new Error("This action has already been rolled back.");
    if (actor.role && this.deps.access) {
      const decision = this.deps.access.canApprove(actor.role, prior);
      if (!decision.allowed) throw new AccessDeniedError(decision.reason);
    }

    const artifact: Artifact = {
      id: newId("art"),
      kind: prior.kind,
      stage: prior.stage,
      version: this.nextVersion(obj, prior.kind, `Rollback — ${prior.title}`),
      status: ArtifactStatus.Proposed,
      title: `Rollback — ${prior.title}`,
      body: {
        action: "rollback",
        rollbackOf: artifactId,
        from: b.to,
        to: b.from,
        share: b.share,
        reversible: false,
        reason,
      },
      author: actor,
      citations: [],
      passedEvals: [],
      derivedFrom: [artifactId],
      createdAt: this.clock.now(),
    };

    let rev = await this.repo.revision(campaignId);
    await this.store.append(
      campaignId,
      { type: "ArtifactProposed", artifact, rationale: `Rolled back “${prior.title}” — ${reason}` },
      actor,
      rev,
    );
    rev += 1;

    const outcomes = await this.evals.run(artifact, {
      campaignId,
      gateway: this.gateway,
      golden: this.deps.goldenSource?.() ?? this.deps.golden ?? hiltiGoldenSet(),
      campaign: obj,
    });
    for (const o of outcomes) {
      await this.store.append(
        campaignId,
        {
          type: "ArtifactEvaluated",
          artifactId: artifact.id,
          evalId: newId("eval"),
          evalName: o.name,
          passed: o.passed,
          score: o.score,
          detail: o.detail,
        },
        SYSTEM_ACTOR,
        rev,
      );
      rev += 1;
    }
    if (!outcomes.every((o) => o.passed)) {
      throw new Error("Rollback blocked at the quality gate — see the flagged checks.");
    }
    // The rollback is the human's explicit decision — it applies immediately.
    await this.store.append(
      campaignId,
      { type: "ArtifactApproved", artifactId: artifact.id, approver: actor, note: `Rollback: ${reason}` },
      actor,
      rev,
    );
    return artifact;
  }

  /** A human approves an artifact that has cleared its evals (HITL checkpoint). */
  async approve(campaignId: string, artifactId: string, approver: Actor, note?: string): Promise<void> {
    const obj = await this.mustLoad(campaignId);
    const artifact = obj.artifacts[artifactId];
    if (!artifact) throw new Error(`Unknown artifact ${artifactId}`);
    if (artifact.status !== ArtifactStatus.InReview) {
      throw new Error(
        `Artifact ${artifactId} is "${artifact.status}", not "in-review" — cannot approve until evals pass.`,
      );
    }
    // Enforce role authority when the approver acts as a persona (spec §5.2).
    if (approver.role && this.deps.access) {
      const decision = this.deps.access.canApprove(approver.role, artifact);
      if (!decision.allowed) throw new AccessDeniedError(decision.reason);
    }
    await this.store.append(
      campaignId,
      { type: "ArtifactApproved", artifactId, approver, ...(note ? { note } : {}) },
      approver,
      obj.revision,
    );
  }

  async reject(campaignId: string, artifactId: string, approver: Actor, reason: string): Promise<void> {
    const obj = await this.mustLoad(campaignId);
    await this.store.append(
      campaignId,
      { type: "ArtifactRejected", artifactId, approver, reason },
      approver,
      obj.revision,
    );
    // §9.2 feedback loop: a human overruled work that had passed the automated
    // gates — surface it as an eval-tuning suggestion.
    const artifact = obj.artifacts[artifactId];
    if (artifact && approver.kind === "human") this.deps.onReject?.(artifact, reason);
  }

  /** Advance to the next stage iff the current stage's gate is satisfied. */
  async advanceStage(campaignId: string, actor: Actor = SYSTEM_ACTOR): Promise<boolean> {
    const obj = await this.mustLoad(campaignId);
    const status = gateStatus(obj);
    const to = nextStage(obj.campaign.currentStage);

    if (!canAdvance(obj) || !to) {
      await this.store.append(
        campaignId,
        {
          type: "StageGateBlocked",
          stage: obj.campaign.currentStage,
          reason: to
            ? `Missing approved artifacts: ${status.missing.join(", ")}`
            : "No further stage (end of lifecycle).",
        },
        actor,
        obj.revision,
      );
      return false;
    }

    await this.store.append(
      campaignId,
      { type: "StageAdvanced", from: obj.campaign.currentStage, to },
      actor,
      obj.revision,
    );
    return true;
  }

  private async mustLoad(campaignId: string) {
    const obj = await this.repo.load(campaignId);
    if (!obj) throw new Error(`Campaign ${campaignId} not found`);
    return obj;
  }

  private nextVersion(
    obj: { artifacts: Record<string, Artifact> },
    kind: Artifact["kind"],
    title: string,
  ): number {
    const prior = Object.values(obj.artifacts).filter((a) => a.kind === kind && a.title === title);
    return prior.length + 1;
  }
}
