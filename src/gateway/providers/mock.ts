import type { ModelProvider, ModelRequest, ModelResponse } from "../types";
import { extractIntakeFields, type IntakeFieldKey } from "../../domain/intakeParsing";

/**
 * Deterministic mock provider — the default when no ANTHROPIC_API_KEY is set.
 * It lets the entire foundation run, be tested and be demoed with zero network
 * calls or cost. Responses are shaped by lightweight heuristics on the prompt so
 * the orchestration/eval/governance flow exercises realistic content.
 */
export class MockProvider implements ModelProvider {
  readonly name = "mock";

  supports(): boolean {
    return true; // last-resort fallback for any model id
  }

  async complete(req: ModelRequest & { model: string }): Promise<ModelResponse> {
    const text = synthesise(req);
    return {
      text,
      model: req.model,
      provider: this.name,
      usage: { input: estimateTokens(req.system + req.prompt), output: estimateTokens(text) },
    };
  }
}

/** ~4 chars per token — good enough for budget accounting in the mock. */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Deterministic stand-in for an LLM grader. Reads DIMENSION and SIGNALS from the
 * grading prompt and returns a plausible {score, pass, rationale} verdict. This
 * mirrors what a real Claude grader would conclude from the same objective signals.
 */
function gradeVerdict(prompt: string): string {
  const dimension = /DIMENSION=([\w-]+)/.exec(prompt)?.[1] ?? "unknown";
  let signals: Record<string, unknown> = {};
  const sig = /SIGNALS=(\{.*\})/.exec(prompt)?.[1];
  if (sig) {
    try { signals = JSON.parse(sig); } catch { /* keep empty */ }
  }

  let score = 0.9;
  let rationale = "Meets the rubric.";
  switch (dimension) {
    case "brand-tone": {
      const hits = (signals.bannedHits as string[] | undefined) ?? [];
      if (hits.length > 0) { score = 0.25; rationale = `Off-brand term(s): ${hits.join(", ")}.`; }
      else { score = 0.95; rationale = "Confident, proof-led, on-brand voice."; }
      break;
    }
    case "compliance": {
      const makesClaim = Boolean(signals.makesClaim);
      const hasFootnote = Boolean(signals.hasFootnote);
      if (makesClaim && !hasFootnote) { score = 0.2; rationale = "Performance claim lacks a substantiation footnote."; }
      else { score = 0.95; rationale = makesClaim ? "Claim is substantiated." : "No regulated claim present."; }
      break;
    }
    case "localisation-equivalence": {
      if (signals.applicable === false) { score = 1; rationale = "Not a localised asset — not applicable."; }
      else if (signals.equivalent) { score = 0.9; rationale = "Transcreation preserves the source meaning."; }
      else { score = 0.4; rationale = "Localised meaning drifts from the source."; }
      break;
    }
    case "regression": {
      if (signals.applicable === false) { score = 1; rationale = "Not a refreshed asset — not applicable."; }
      else if (signals.preservesCore) { score = 0.9; rationale = "Refresh renews the creative while keeping the winning core."; }
      else { score = 0.3; rationale = "Refresh drops the winning core message — would degrade a proven asset."; }
      break;
    }
  }
  return JSON.stringify({ score, pass: score >= 0.7, rationale });
}

function synthesise(req: ModelRequest & { model: string }): string {
  // Grading requests (from model-graded evaluators) get a deterministic verdict
  // derived from the objective SIGNALS embedded in the prompt — so evals are
  // stable and cost-free without an API key. Real Claude does genuine grading.
  if (req.prompt.includes("[[ASTRA_EVAL]]")) {
    return gradeVerdict(req.prompt);
  }

  // Intake-interview extraction: the deterministic parser stands in for Claude.
  if (req.prompt.includes("[[ASTRA_INTAKE]]")) {
    const lastAsked = (/LASTASKED=([\w-]+)/.exec(req.prompt)?.[1] ?? null) as IntakeFieldKey | null;
    const userText = /USER:\s*([\s\S]*)$/.exec(req.prompt)?.[1]?.trim() ?? "";
    return JSON.stringify(extractIntakeFields(lastAsked === ("null" as never) ? null : lastAsked, userText));
  }

  const p = req.prompt.toLowerCase();
  if (p.includes("brief")) {
    return JSON.stringify({
      summary: "Structured brief drafted from the request; gaps flagged as questions.",
      openQuestions: ["Confirm primary success metric", "Confirm mandatory product claims"],
    });
  }
  if (p.includes("strateg")) {
    return JSON.stringify({
      positioning: "Own the 'jobsite uptime' narrative for the new cordless platform.",
      messagingHierarchy: ["Uptime", "Durability", "Total cost of ownership"],
    });
  }
  if (p.includes("concept")) {
    return JSON.stringify({
      selected: "No downtime, no compromise",
      rationale: "Highest fit to the locked KPI and brand tone; strongest differentiation.",
    });
  }
  if (p.includes("copy") || p.includes("headline")) {
    return JSON.stringify({
      headline: "Power through the workday. No downtime, no compromise.",
      body: "The new Hilti cordless platform keeps your crew moving.",
    });
  }
  return `MOCK[${req.model}] response to: ${req.prompt.slice(0, 120)}`;
}
