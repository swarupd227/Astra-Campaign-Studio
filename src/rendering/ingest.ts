import ExcelJS from "exceljs";
import { ArtifactKind, ArtifactStatus, type Artifact, type CampaignObject } from "../domain/types";

/**
 * Office round-trip ingestion (spec §9.5). A human edits the generated Marcom
 * Plan in Excel — a budget line, a KPI target — and re-uploads it. We parse the
 * STRUCTURED REGIONS (the anchored sheets the rendering layer wrote), diff them
 * against the campaign object, and surface the changes for confirmation. Nothing
 * is silently overwritten; confirmed changes apply as attributed human edits
 * through the normal versioning + eval machinery.
 */

export interface IngestChange {
  /** The artifact this change reconciles into. */
  artifactId: string;
  artifactTitle: string;
  /** Body field to update and its before/after values. */
  field: string;
  before: unknown;
  after: unknown;
  /** Human-readable one-liner for the confirmation UI. */
  summary: string;
}

export interface IngestReport {
  changes: IngestChange[];
  /** Sheets we recognised and reconciled. */
  reconciledSheets: string[];
  /** Notes on anything we deliberately left alone (free-form is preserved, §9.5). */
  notes: string[];
}

function latest(obj: CampaignObject, kind: ArtifactKind): Artifact | undefined {
  return Object.values(obj.artifacts)
    .filter((a) => a.kind === kind && a.status !== ArtifactStatus.Rejected && a.status !== ArtifactStatus.Superseded)
    .sort((a, b) => b.version - a.version)[0];
}

const HEADER_ROW = 4; // template contract: headers on row 4, data below (workbookRenderer)

function sheetRows(ws: ExcelJS.Worksheet): Record<string, unknown>[] {
  const header: string[] = [];
  ws.getRow(HEADER_ROW).eachCell({ includeEmpty: false }, (cell, col) => {
    header[col] = String(cell.value ?? "").trim();
  });
  const rows: Record<string, unknown>[] = [];
  for (let r = HEADER_ROW + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const rec: Record<string, unknown> = {};
    let any = false;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      if (!header[col]) return;
      rec[header[col]!] = cell.value;
      any = true;
    });
    if (any) rows.push(rec);
  }
  return rows;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  // exceljs formula cells: { formula, result }
  if (v && typeof v === "object" && "result" in v) return num((v as { result: unknown }).result);
  return null;
};

const camel = (label: string): string =>
  label
    .trim()
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join("");

/**
 * Diff an uploaded Marcom Plan workbook against the campaign object.
 * Structured regions reconciled: "Channel & budget" → MediaPlan channels;
 * "Locked KPIs" → Kpi targets/guardrails. Everything else is preserved as-is.
 */
export async function diffMarcomPlan(obj: CampaignObject, uploaded: Buffer): Promise<IngestReport> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(uploaded as unknown as ArrayBuffer);

  const changes: IngestChange[] = [];
  const reconciledSheets: string[] = [];
  const notes: string[] = [];

  // ── Channel & budget → MediaPlan.channels[].budgetShare ─────────────────────
  const media = latest(obj, ArtifactKind.MediaPlan);
  const budgetSheet = wb.getWorksheet("Channel & budget");
  if (media && budgetSheet) {
    reconciledSheets.push(budgetSheet.name);
    const rows = sheetRows(budgetSheet);
    const channels = (media.body.channels ?? []) as { channel: string; role: string; budgetShare: number }[];
    const total = Number(media.body.totalBudget ?? obj.campaign.budget) || 1;

    const updated = channels.map((c) => ({ ...c }));
    for (const row of rows) {
      const name = String(row["Channel"] ?? "").trim();
      const target = updated.find((c) => c.channel === name);
      if (!target) {
        if (name) notes.push(`Unknown channel "${name}" left for manual review (no matching plan row).`);
        continue;
      }
      // The human may edit the share OR the absolute amount; amount wins if both changed.
      const share = num(row["Budget share"]);
      const amountHeader = Object.keys(row).find((h) => h.startsWith("Budget ("));
      const amount = amountHeader ? num(row[amountHeader]) : null;
      let newShare = target.budgetShare;
      if (amount !== null && Math.abs(amount - Math.round(target.budgetShare * total)) > 0.5) {
        newShare = amount / total;
      } else if (share !== null && Math.abs(share - target.budgetShare) > 0.0005) {
        newShare = share;
      }
      if (Math.abs(newShare - target.budgetShare) > 0.0005) {
        target.budgetShare = Number(newShare.toFixed(4));
      }
    }
    const changed = updated.some((c, i) => Math.abs(c.budgetShare - channels[i]!.budgetShare) > 0.0005);
    if (changed) {
      const summary = updated
        .map((c, i) =>
          Math.abs(c.budgetShare - channels[i]!.budgetShare) > 0.0005
            ? `${c.channel}: ${Math.round(channels[i]!.budgetShare * 100)}% → ${Math.round(c.budgetShare * 100)}%`
            : null,
        )
        .filter(Boolean)
        .join(", ");
      changes.push({
        artifactId: media.id,
        artifactTitle: media.title,
        field: "channels",
        before: channels,
        after: updated,
        summary: `Budget split changed — ${summary}.`,
      });
      const sum = updated.reduce((s, c) => s + c.budgetShare, 0);
      if (Math.abs(sum - 1) > 0.01) {
        notes.push(`Edited budget shares sum to ${Math.round(sum * 100)}% — confirm the split is intentional.`);
      }
    }
  }

  // ── Locked KPIs → Kpi.targets / Kpi.guardrails ──────────────────────────────
  const kpi = latest(obj, ArtifactKind.Kpi);
  const kpiSheet = wb.getWorksheet("Locked KPIs");
  if (kpi && kpiSheet) {
    reconciledSheets.push(kpiSheet.name);
    const rows = sheetRows(kpiSheet);
    const targets = { ...((kpi.body.targets ?? {}) as Record<string, number>) };
    const guardrails = { ...((kpi.body.guardrails ?? {}) as Record<string, number>) };
    let touched: string[] = [];
    for (const row of rows) {
      const metric = camel(String(row["Metric"] ?? ""));
      const value = num(row["Value"]);
      const type = String(row["Type"] ?? "").trim();
      if (!metric || value === null) continue;
      const bucket = type === "guardrail" ? guardrails : targets;
      const existingKey = Object.keys(bucket).find((k) => k.toLowerCase() === metric.toLowerCase());
      if (existingKey && bucket[existingKey] !== value) {
        touched.push(`${existingKey}: ${bucket[existingKey]} → ${value}`);
        bucket[existingKey] = value;
      }
    }
    if (touched.length) {
      changes.push({
        artifactId: kpi.id,
        artifactTitle: kpi.title,
        field: "targets+guardrails",
        before: { targets: kpi.body.targets, guardrails: kpi.body.guardrails },
        after: { targets, guardrails },
        summary: `KPI values changed — ${touched.join(", ")}.`,
      });
    }
  }

  notes.push("Free-form sheets and formatting were preserved as authored (§9.5).");
  return { changes, reconciledSheets, notes };
}

/** The body-field patch a confirmed change applies (used with orchestrator.editArtifact). */
export function changeToFields(change: IngestChange): Record<string, unknown> {
  if (change.field === "targets+guardrails") {
    const after = change.after as { targets: unknown; guardrails: unknown };
    return { targets: after.targets, guardrails: after.guardrails };
  }
  return { [change.field]: change.after };
}
