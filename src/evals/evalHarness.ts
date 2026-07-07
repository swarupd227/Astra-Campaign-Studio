import { Stage, type Artifact, type CampaignObject } from "../domain/types";
import type { ModelGateway } from "../gateway/modelGateway";
import type { GoldenSet } from "./goldenSet";

export interface EvalOutcome {
  name: string;
  passed: boolean;
  score: number; // 0..1
  detail: string;
}

/**
 * What an evaluator is given to score an artifact. Model-graded evaluators use
 * the gateway (Claude-first) and golden set; the campaign object is available so
 * evals like localisation-equivalence can reach the upstream source artifact.
 */
export interface EvalContext {
  campaignId: string;
  gateway: ModelGateway;
  golden: GoldenSet;
  campaign: CampaignObject;
}

/** An evaluator scores one artifact against one quality dimension (spec §9.2). */
export interface Evaluator {
  name: string;
  /** Minimum score to pass; below this the artifact cannot advance. */
  threshold: number;
  evaluate(artifact: Artifact, ctx: EvalContext): Promise<EvalOutcome>;
}

/**
 * Stage quality gates (spec §9.2): nothing ships until evals pass. Each stage
 * declares which evaluators apply; an artifact must clear all of them to advance.
 * Automated evals score first; humans adjudicate borderline cases downstream.
 */
export class EvalHarness {
  constructor(private readonly gates: Partial<Record<Stage, Evaluator[]>>) {}

  evaluatorsFor(stage: Stage): Evaluator[] {
    return this.gates[stage] ?? [];
  }

  /** Run every evaluator for the artifact's stage; returns per-eval outcomes. */
  async run(artifact: Artifact, ctx: EvalContext): Promise<EvalOutcome[]> {
    const evaluators = this.evaluatorsFor(artifact.stage);
    const outcomes = await Promise.all(
      evaluators.map(async (e) => {
        const outcome = await e.evaluate(artifact, ctx);
        return { ...outcome, passed: outcome.score >= e.threshold };
      }),
    );
    return outcomes;
  }

  /** True only if every applicable gate passes. */
  async passes(artifact: Artifact, ctx: EvalContext): Promise<boolean> {
    return (await this.run(artifact, ctx)).every((o) => o.passed);
  }
}
