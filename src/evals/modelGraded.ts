import type { Artifact } from "../domain/types";
import type { EvalContext, EvalOutcome, Evaluator } from "./evalHarness";

/**
 * A model-graded evaluator (spec §9.2). It scores an artifact by asking the model
 * (Claude-first, via the gateway) to judge it against a rubric and the golden-set
 * exemplars, returning a 0–1 score with a rationale. Objective "signals" the
 * evaluator can compute cheaply are passed alongside so the grader is anchored and
 * the deterministic mock provider can return a stable verdict with no API key.
 */
export interface ModelGradedSpec {
  name: string;
  threshold: number;
  /** The grading rubric shown to the model. */
  rubric: string;
  /** Golden exemplars (few-shot anchors) for this dimension. */
  exemplars(ctx: EvalContext): { onBrand?: string[]; offBrand?: string[]; notes?: string[] };
  /** The text under evaluation plus objective signals for the grader. */
  subject(artifact: Artifact, ctx: EvalContext): { text: string; signals: Record<string, unknown> };
}

/** Sentinel the mock provider keys on to return a verdict instead of prose. */
export const EVAL_SENTINEL = "[[ASTRA_EVAL]]";

export function modelGradedEvaluator(spec: ModelGradedSpec): Evaluator {
  return {
    name: spec.name,
    threshold: spec.threshold,
    async evaluate(artifact: Artifact, ctx: EvalContext): Promise<EvalOutcome> {
      const { text, signals } = spec.subject(artifact, ctx);
      const ex = spec.exemplars(ctx);
      const system = `You are Astra's marketing quality evaluator for the "${spec.name}" dimension. Grade strictly against the rubric and the golden exemplars. Respond ONLY with JSON: {"score": <0..1>, "pass": <bool>, "rationale": "<short>"}.`;
      const prompt = [
        EVAL_SENTINEL,
        `DIMENSION=${spec.name}`,
        `RUBRIC: ${spec.rubric}`,
        ex.onBrand?.length ? `ON-BRAND EXEMPLARS:\n- ${ex.onBrand.join("\n- ")}` : "",
        ex.offBrand?.length ? `OFF-BRAND EXEMPLARS:\n- ${ex.offBrand.join("\n- ")}` : "",
        ex.notes?.length ? `NOTES:\n- ${ex.notes.join("\n- ")}` : "",
        `SIGNALS=${JSON.stringify(signals)}`,
        `SUBJECT:\n${text}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      const res = await ctx.gateway.complete({ campaignId: ctx.campaignId, system, prompt });
      const verdict = parseVerdict(res.text);
      // Keep the surfaced detail clean; provider provenance lives in Admin settings.
      return {
        name: spec.name,
        score: verdict.score,
        passed: verdict.score >= spec.threshold,
        detail: verdict.rationale,
      };
    },
  };
}

interface Verdict {
  score: number;
  rationale: string;
}

/** Robustly extract the verdict JSON from a model response. */
function parseVerdict(text: string): Verdict {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]) as { score?: number; rationale?: string };
      const score = typeof obj.score === "number" ? clamp01(obj.score) : 0;
      return { score, rationale: obj.rationale ?? "No rationale provided." };
    }
  } catch {
    // fall through to conservative default
  }
  // If the grader didn't return parseable JSON, fail closed (nothing ships on ambiguity).
  return { score: 0, rationale: "Grader returned no parseable verdict; failing closed." };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
