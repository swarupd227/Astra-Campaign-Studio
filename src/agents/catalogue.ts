import { Stage } from "../domain/types";
import type { Agent } from "../orchestration/agent";
import { intakeAgents } from "./intake";
import { planningAgents } from "./planning";
import { contentPlanningAgents } from "./contentPlanning";
import { creationAgents } from "./creation";
import { rolloutAgents } from "./rollout";
import { optimisationAgents } from "./optimisation";
import { contentOptimisationAgents } from "./contentOptimisation";

/**
 * The full-chain agent catalogue (spec §7.3), grouped by lifecycle stage. A Stage
 * Orchestrator runs the agents for its stage; the set is extensible — Hilti can
 * add market- or product-specific skills without touching the runtime.
 */
export const STAGE_AGENTS: Partial<Record<Stage, Agent[]>> = {
  [Stage.Intake]: intakeAgents,
  [Stage.CampaignPlanning]: planningAgents,
  [Stage.ContentPlanning]: contentPlanningAgents,
  [Stage.ContentCreation]: creationAgents,
  // MVP-2 — the full chain (spec §6.4–§6.6).
  [Stage.Rollout]: rolloutAgents,
  [Stage.CampaignOptimisation]: optimisationAgents,
  [Stage.ContentOptimisation]: contentOptimisationAgents,
};

/** Every stage-0–3 agent, flattened in lifecycle order (MVP-1 scope). */
export const mvp1Agents: Agent[] = [
  ...intakeAgents,
  ...planningAgents,
  ...contentPlanningAgents,
  ...creationAgents,
];

/** The complete catalogue across the full chain. */
export const allAgents: Agent[] = [
  ...mvp1Agents,
  ...rolloutAgents,
  ...optimisationAgents,
  ...contentOptimisationAgents,
];

export function agentsForStage(stage: Stage): Agent[] {
  return STAGE_AGENTS[stage] ?? [];
}

// Every agent that can author an artifact, including the Figma round-trip agent
// (which isn't part of a stage's default run). Used to find the producer of an
// artifact when a reviewer requests changes.
import { figmaRoundTripAgent } from "./figmaAgents";
const ALL_AGENTS: Agent[] = [...allAgents, figmaRoundTripAgent];

/** Resolve the agent that produced an artifact, by its author name. */
export function getAgentByName(name: string): Agent | undefined {
  return ALL_AGENTS.find((a) => a.name === name);
}

export * from "./intake";
export * from "./planning";
export * from "./contentPlanning";
export * from "./creation";
export * from "./figmaAgents";
