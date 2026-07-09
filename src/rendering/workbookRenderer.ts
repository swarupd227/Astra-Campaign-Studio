import ExcelJS from "exceljs";
import { BRAND, type LineageEntry } from "./brandTemplate";

/**
 * Deterministic XLSX generation (spec §9.3). Workbooks are built from typed
 * sheet specs; structured regions carry machine-readable anchors (defined
 * names) so the ingestion layer (§9.5) can reconcile human edits against the
 * campaign object — never by guessing at cell positions.
 */

export interface SheetSpec {
  name: string;
  header: string[];
  rows: (string | number)[][];
  /**
   * Structured-region anchor (§9.5): registers `<anchor>` as a defined name
   * covering the data rows, marking this sheet as machine-reconcilable.
   */
  anchor?: string;
  /** Column widths (chars). Defaults derived from header length. */
  widths?: number[];
}

export interface WorkbookSpec {
  title: string;
  sheets: SheetSpec[];
  lineage: LineageEntry[];
}

export async function renderWorkbook(spec: WorkbookSpec): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Astra Campaign Studio";

  for (const sheet of spec.sheets) addSheet(wb, sheet);
  addSheet(wb, {
    name: "Lineage",
    header: ["Artifact", "Version", "Status", "Author", "Quality gates", "Artifact id"],
    rows: spec.lineage.map((l) => [l.title, `v${l.version}`, l.status, l.author, l.evals, l.artifactId]),
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function addSheet(wb: ExcelJS.Workbook, spec: SheetSpec): void {
  const ws = wb.addWorksheet(spec.name);

  // Row 1: workbook title band; Row 2: mandatory footer text (conformance, §9.6).
  ws.getCell("A1").value = spec.name;
  ws.getCell("A1").font = { name: BRAND.font, size: 14, bold: true, color: { argb: `FF${BRAND.colors.ink}` } };
  ws.getCell("A2").value = BRAND.footer;
  ws.getCell("A2").font = { name: BRAND.font, size: 8, color: { argb: `FF${BRAND.colors.muted}` } };

  // Header band: ink fill, paper text, brand font, gold keyline.
  const headerRowIdx = 4;
  const headerRow = ws.getRow(headerRowIdx);
  spec.header.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { name: BRAND.font, size: 10, bold: true, color: { argb: `FF${BRAND.colors.paper}` } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${BRAND.colors.ink}` } };
    cell.border = { bottom: { style: "thin", color: { argb: `FF${BRAND.colors.gold}` } } };
  });

  spec.rows.forEach((row, r) => {
    const wsRow = ws.getRow(headerRowIdx + 1 + r);
    row.forEach((v, c) => {
      const cell = wsRow.getCell(c + 1);
      cell.value = v;
      cell.font = { name: BRAND.font, size: 10, color: { argb: `FF${BRAND.colors.ink}` } };
    });
  });

  const widths = spec.widths ?? spec.header.map((h) => Math.max(16, h.length + 6));
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  // Structured-region anchor: a defined name spanning header + data rows (§9.5).
  if (spec.anchor && spec.rows.length > 0) {
    const lastCol = ws.getColumn(spec.header.length).letter;
    const range = `'${spec.name}'!$A$${headerRowIdx}:$${lastCol}$${headerRowIdx + spec.rows.length}`;
    wb.definedNames.add(range, spec.anchor);
  }
}
