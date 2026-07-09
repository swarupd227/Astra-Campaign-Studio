import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import pptxgen from "pptxgenjs";
import { Astra } from "../src/app";
import { fixedClock } from "../src/domain/ids";
import { ArtifactKind, ArtifactStatus, Stage, type Actor } from "../src/domain/types";
import { agentsForStage } from "../src/agents/catalogue";
import { listDeliverables, renderDeliverable } from "../src/rendering/deliverables";
import { validateDeck, validateWorkbook } from "../src/rendering/conformance";
import { changeToFields, diffMarcomPlan } from "../src/rendering/ingest";
import { templateConformanceEvaluator } from "../src/evals/templateConformance";
import { BRAND } from "../src/rendering/brandTemplate";

const human: Actor = { kind: "human", id: "u1", displayName: "Tester" };

function newAstra() {
  return new Astra({ persistence: "memory", clock: fixedClock("2026-01-01T00:00:00Z"), campaignTokenBudget: 0 });
}

async function seed(astra: Astra): Promise<string> {
  return astra.createCampaign(
    {
      objective: "Launch cordless platform",
      owner: human.id,
      markets: ["DE", "US"],
      budget: 750_000,
      currency: "EUR",
      kpis: ["Qualified leads"],
    },
    human,
  );
}

/** Drive the campaign through stages until `until` (exclusive), auto-approving. */
async function advanceTo(astra: Astra, id: string, until: Stage): Promise<void> {
  const orch = astra.stageOrchestrator(async () => ({ approve: true, actor: human, note: "ok" }));
  for (let i = 0; i < 8; i++) {
    const obj = await astra.repo.load(id);
    if (obj!.campaign.currentStage === until) return;
    if (agentsForStage(obj!.campaign.currentStage).length === 0) return;
    const report = await orch.runCurrentStage(id);
    if (!report.advancedTo) return;
  }
}

describe("deliverable catalogue (spec §9.4)", () => {
  it("availability tracks stage progress", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    const before = listDeliverables((await astra.repo.load(id))!);
    expect(before.find((d) => d.key === "marcom-strategy")!.available).toBe(false);

    await advanceTo(astra, id, Stage.ContentPlanning);
    const after = listDeliverables((await astra.repo.load(id))!);
    expect(after.find((d) => d.key === "campaign-brief")!.available).toBe(true);
    expect(after.find((d) => d.key === "marcom-strategy")!.available).toBe(true);
    expect(after.find((d) => d.key === "marcom-plan")!.available).toBe(true);
    expect(after.find((d) => d.key === "copy-matrix")!.available).toBe(false); // creation not run yet
  });

  it("renders a brand-conformant Marcom strategy deck with lineage", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.ContentPlanning);
    const rendered = await renderDeliverable((await astra.repo.load(id))!, "marcom-strategy");
    expect(rendered).not.toBeNull();
    expect(rendered!.fileName).toBe("astra-marcom-strategy.pptx");
    expect(rendered!.sources.length).toBeGreaterThanOrEqual(4);
    const conformance = await validateDeck(rendered!.buffer);
    expect(conformance.checks.map((c) => `${c.name}:${c.passed}`)).toEqual([
      "structure:true",
      "mandatory-footer:true",
      "brand-typography:true",
      "brand-palette:true",
      "lineage-slide:true",
    ]);
  });

  it("renders the Marcom Plan workbook with anchored structured regions", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.ContentPlanning);
    const rendered = await renderDeliverable((await astra.repo.load(id))!, "marcom-plan");
    const conformance = await validateWorkbook(rendered!.buffer);
    expect(conformance.passed, JSON.stringify(conformance.checks)).toBe(true);

    // Structured-region anchors present (§9.5).
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rendered!.buffer as unknown as ArrayBuffer);
    expect(wb.definedNames.getRanges("astra_channel_budget").ranges.length).toBeGreaterThan(0);
    expect(wb.definedNames.getRanges("astra_locked_kpis").ranges.length).toBeGreaterThan(0);
    expect(wb.getWorksheet("Lineage")).toBeDefined();
  });

  it("renders the copy matrix once creation has run", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.Rollout);
    const rendered = await renderDeliverable((await astra.repo.load(id))!, "copy-matrix");
    expect(rendered).not.toBeNull();
    const conformance = await validateWorkbook(rendered!.buffer);
    expect(conformance.passed).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rendered!.buffer as unknown as ArrayBuffer);
    const matrix = wb.getWorksheet("Copy matrix")!;
    expect(matrix.rowCount).toBeGreaterThan(4); // header + content rows
  });
});

describe("template conformance gate (spec §9.6)", () => {
  it("fails an off-template deck (foreign font, missing footer)", async () => {
    const Ctor = (pptxgen as unknown as { default?: typeof pptxgen }).default ?? pptxgen;
    const pptx = new Ctor();
    pptx.layout = "LAYOUT_16x9";
    const s1 = pptx.addSlide();
    s1.addText("Rogue deck", { x: 1, y: 1, fontFace: "Comic Sans MS", fontSize: 30 });
    const s2 = pptx.addSlide();
    s2.addText("No footer here", { x: 1, y: 1, fontFace: "Comic Sans MS", fontSize: 20 });
    const buffer = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;

    const result = await validateDeck(buffer);
    expect(result.passed).toBe(false);
    const byName = Object.fromEntries(result.checks.map((c) => [c.name, c.passed]));
    expect(byName["mandatory-footer"]).toBe(false);
    expect(byName["brand-typography"]).toBe(false);
    expect(byName["lineage-slide"]).toBe(false);
  });

  it("the evaluator gates anchor artifacts and skips others", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.ContentPlanning);
    const obj = (await astra.repo.load(id))!;
    const ctx = { campaignId: id, gateway: astra.gateway, golden: astra.golden.current(), campaign: obj };

    const strategy = Object.values(obj.artifacts).find((a) => a.kind === ArtifactKind.Strategy)!;
    const outcome = await templateConformanceEvaluator.evaluate(strategy, ctx);
    expect(outcome.passed).toBe(true);
    expect(outcome.detail).toContain("conforms to the brand template");

    const note = Object.values(obj.artifacts).find((a) => a.kind === ArtifactKind.Note)!;
    const na = await templateConformanceEvaluator.evaluate(note, ctx);
    expect(na.passed).toBe(true);
    expect(na.detail).toContain("not applicable");
  });
});

describe("Office round-trip ingestion (spec §9.5)", () => {
  async function editedWorkbook(astra: Astra, id: string): Promise<Buffer> {
    const rendered = await renderDeliverable((await astra.repo.load(id))!, "marcom-plan");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rendered!.buffer as unknown as ArrayBuffer);
    // A manager reworks the split: paid-social 50% → 40% (absolute amount edit)…
    const budget = wb.getWorksheet("Channel & budget")!;
    budget.getCell("D5").value = 300_000; // paid-social row (was 375,000 = 50% of 750k)
    // …and tightens a KPI guardrail: max CPL 45 → 40.
    const kpis = wb.getWorksheet("Locked KPIs")!;
    for (let r = 5; r <= kpis.rowCount; r++) {
      if (String(kpis.getCell(`A${r}`).value) === "Max Cpl") kpis.getCell(`B${r}`).value = 40;
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it("diffs edited structured regions against the object — nothing silent", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.ContentPlanning);
    const report = await diffMarcomPlan((await astra.repo.load(id))!, await editedWorkbook(astra, id));

    expect(report.reconciledSheets).toEqual(["Channel & budget", "Locked KPIs"]);
    expect(report.changes).toHaveLength(2);
    const budgetChange = report.changes.find((c) => c.field === "channels")!;
    expect(budgetChange.summary).toContain("paid-social: 50% → 40%");
    const after = budgetChange.after as { channel: string; budgetShare: number }[];
    expect(after.find((c) => c.channel === "paid-social")!.budgetShare).toBeCloseTo(0.4);
    // The sum no longer reaches 100% — the report says so instead of silently normalising.
    expect(report.notes.some((n) => n.includes("sum to 90%"))).toBe(true);

    const kpiChange = report.changes.find((c) => c.field === "targets+guardrails")!;
    expect(kpiChange.summary).toContain("maxCpl: 45 → 40");
  });

  it("an unedited workbook produces zero changes", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.ContentPlanning);
    const rendered = await renderDeliverable((await astra.repo.load(id))!, "marcom-plan");
    const report = await diffMarcomPlan((await astra.repo.load(id))!, rendered!.buffer);
    expect(report.changes).toHaveLength(0);
  });

  it("confirmed changes apply as attributed human versions through the gates", async () => {
    const astra = newAstra();
    const id = await seed(astra);
    await advanceTo(astra, id, Stage.ContentPlanning);
    const report = await diffMarcomPlan((await astra.repo.load(id))!, await editedWorkbook(astra, id));

    for (const change of report.changes) {
      await astra.orchestrator.editArtifact(id, change.artifactId, changeToFields(change), human);
    }
    const obj = (await astra.repo.load(id))!;
    const mediaVersions = Object.values(obj.artifacts).filter((a) => a.kind === ArtifactKind.MediaPlan);
    expect(mediaVersions.length).toBe(2); // v1 superseded by the human's v2
    const latest = mediaVersions.sort((a, b) => b.version - a.version)[0]!;
    expect(latest.author.id).toBe(human.id); // §9.5 provenance
    const channels = latest.body.channels as { channel: string; budgetShare: number }[];
    expect(channels.find((c) => c.channel === "paid-social")!.budgetShare).toBeCloseTo(0.4);
    // Prior version is superseded, history intact.
    const prior = mediaVersions.find((a) => a.version === 1)!;
    expect(prior.status).toBe(ArtifactStatus.Superseded);
    // The rendered workbook now reflects the human's numbers (documents = views).
    const rerendered = await renderDeliverable(obj, "marcom-plan");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rerendered!.buffer as unknown as ArrayBuffer);
    expect(Number(wb.getWorksheet("Channel & budget")!.getCell("D5").value)).toBe(300_000);
  });
});

describe("brand constants", () => {
  it("footer names ARTIZENT and the product (no legacy branding)", () => {
    expect(BRAND.footer).toContain("ARTIZENT");
    expect(BRAND.footer).toContain("Astra");
  });
});
