import { ArtifactKind, type Artifact } from "../domain/types";
import type { Evaluator } from "./evalHarness";
import { renderDeliverable } from "../rendering/deliverables";
import { validateDeliverable } from "../rendering/conformance";

/**
 * Template conformance as a quality gate (spec §9.6): when an artifact is the
 * source of a rendered deliverable, the ACTUAL generated file is validated
 * against the brand template — typography, palette, mandatory footer, lineage.
 * A deck that violates the Hilti template does not pass the gate. Artifacts
 * with no rendered deliverable are not applicable and pass.
 */

/** Which deliverable an artifact kind anchors (only anchor kinds trigger a render). */
const ANCHOR_DELIVERABLE: Partial<Record<ArtifactKind, string>> = {
  [ArtifactKind.Brief]: "campaign-brief",
  [ArtifactKind.Strategy]: "marcom-strategy",
  [ArtifactKind.MediaPlan]: "marcom-plan",
  [ArtifactKind.Kpi]: "marcom-plan",
  [ArtifactKind.Concept]: "concept-deck",
  [ArtifactKind.CreativeBrief]: "scope-brief",
};

/**
 * Deterministic rendering means identical inputs give an identical verdict —
 * memoise per (deliverable, source versions) so evaluating several anchor
 * artifacts of one deliverable validates the file once, not once each.
 */
const verdictCache = new Map<string, { passed: boolean; detail: string }>();

export const templateConformanceEvaluator: Evaluator = {
  name: "template-conformance",
  threshold: 1,
  async evaluate(artifact: Artifact, ctx) {
    const key = ANCHOR_DELIVERABLE[artifact.kind];
    if (!key) {
      return {
        name: "template-conformance",
        passed: true,
        score: 1,
        detail: "No rendered deliverable anchored to this artifact — not applicable.",
      };
    }
    // Render against the live object PLUS this artifact (it may not be folded in
    // yet while the eval runs pre-append). Fails CLOSED: a rendering error is a
    // gate failure, not a crash (§9.2 precedent — quality gates never assume).
    const obj = {
      ...ctx.campaign,
      artifacts: { ...ctx.campaign.artifacts, [artifact.id]: artifact },
    };
    let verdict: { passed: boolean; detail: string };
    try {
      const rendered = await renderDeliverable(obj, key);
      if (!rendered) {
        return {
          name: "template-conformance",
          passed: true,
          score: 1,
          detail: "Deliverable not yet renderable — not applicable.",
        };
      }
      const cacheKey = `${key}|${rendered.sources.map((s) => `${s.id}:${s.version}`).join(",")}`;
      const cached = verdictCache.get(cacheKey);
      if (cached) {
        verdict = cached;
      } else {
        const result = await validateDeliverable(rendered.format, rendered.buffer);
        const failed = result.checks.filter((c) => !c.passed);
        verdict = {
          passed: result.passed,
          detail: result.passed
            ? `${rendered.fileName} conforms to the brand template (${result.checks.length} checks).`
            : `${rendered.fileName} violates the template: ${failed.map((c) => c.detail).join(" ")}`,
        };
        if (verdictCache.size > 500) verdictCache.clear(); // bounded
        verdictCache.set(cacheKey, verdict);
      }
    } catch (err) {
      return {
        name: "template-conformance",
        passed: false,
        score: 0,
        detail: `Deliverable rendering failed: ${(err as Error).message}`,
      };
    }
    return {
      name: "template-conformance",
      passed: verdict.passed,
      score: verdict.passed ? 1 : 0,
      detail: verdict.detail,
    };
  },
};
