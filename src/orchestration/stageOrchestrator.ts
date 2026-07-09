import { Stage, type Actor } from "../domain/types";
import type { Orchestrator, RunResult } from "./orchestrator";
import type { CampaignRepository } from "../store/campaignRepository";
import { agentsForStage } from "../agents/catalogue";
import { boardArtifact, figmaBoardAgent } from "../agents/figmaAgents";
import { gateStatus } from "./stateMachine";

export interface StageAgentReport {
  agent: string;
  result: RunResult;
  approved: boolean;
}

export interface StageReport {
  stage: string;
  agentReports: StageAgentReport[];
  gateSatisfied: boolean;
  advancedTo: string | null;
}

/**
 * A stage orchestrator (spec §7.1): "one per lifecycle stage — coordinates its
 * specialist agents, enforces the stage's quality gate, and manages the human
 * checkpoint." It runs every agent registered for the current stage, routes each
 * proposal through the shared HITL approver, then attempts to advance the stage.
 */
export class StageOrchestrator {
  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly repo: CampaignRepository,
    /**
     * The human checkpoint. In production this resolves against a real reviewer
     * via the Review & Approvals inbox; here it is injected so callers (demo,
     * tests, later the UI) decide how approvals happen.
     */
    private readonly approver: (result: RunResult) => Promise<{ approve: boolean; actor: Actor; note?: string }>,
  ) {}

  /** Run the current stage end to end and try to advance. */
  async runCurrentStage(campaignId: string): Promise<StageReport> {
    const obj = await this.repo.load(campaignId);
    if (!obj) throw new Error(`Campaign ${campaignId} not found`);
    const stage = obj.campaign.currentStage;
    // §11.3 precondition: the board (Phase 1, placeholder frames) exists before
    // any content agent fires — a deterministic sequence, not a race.
    const agents =
      stage === Stage.ContentCreation && !boardArtifact(obj)
        ? [figmaBoardAgent, ...agentsForStage(stage)]
        : agentsForStage(stage);

    const agentReports: StageAgentReport[] = [];
    for (const agent of agents) {
      const result = await this.orchestrator.runAgent(campaignId, agent);
      let approved = result.autoApproved;

      if (result.pendingHumanApproval) {
        const decision = await this.approver(result);
        if (decision.approve) {
          await this.orchestrator.approve(campaignId, result.artifact.id, decision.actor, decision.note);
          approved = true;
        } else {
          await this.orchestrator.reject(
            campaignId,
            result.artifact.id,
            decision.actor,
            decision.note ?? "Rejected at human checkpoint",
          );
        }
      }
      agentReports.push({ agent: agent.name, result, approved });
    }

    const after = await this.repo.load(campaignId);
    const satisfied = after ? gateStatus(after).satisfied : false;
    let advancedTo: string | null = null;
    if (satisfied && (await this.orchestrator.advanceStage(campaignId))) {
      const advanced = await this.repo.load(campaignId);
      advancedTo = advanced?.campaign.currentStage ?? null;
    }

    return { stage, agentReports, gateSatisfied: satisfied, advancedTo };
  }
}
