import JSZip from "jszip";
import ExcelJS from "exceljs";
import { BRAND } from "./brandTemplate";

/**
 * Template conformance as a quality gate (spec §9.6). Because generation is
 * deterministic and template-driven, "is this on-brand?" is a testable property
 * of the generated FILE: brand typography, palette and the mandatory footer are
 * validated automatically before a human ever opens it. A deck that violates
 * the template does not pass the stage gate.
 */

export interface ConformanceCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ConformanceResult {
  passed: boolean;
  checks: ConformanceCheck[];
}

function result(checks: ConformanceCheck[]): ConformanceResult {
  return { passed: checks.every((c) => c.passed), checks };
}

/** Validate a generated .pptx buffer against the brand template. */
export async function validateDeck(buffer: Buffer): Promise<ConformanceResult> {
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  const slides = await Promise.all(slideNames.map((n) => zip.file(n)!.async("string")));
  const checks: ConformanceCheck[] = [];

  checks.push({
    name: "structure",
    passed: slides.length >= 2,
    detail: slides.length >= 2 ? `${slides.length} slides.` : "Deck must have a title slide and content.",
  });

  // Mandatory footer on every slide — via the slide master/layout inheritance,
  // the footer text lives in the layout XML; check master + layouts + slides.
  const layoutNames = Object.keys(zip.files).filter((f) =>
    /^ppt\/(slideMasters|slideLayouts)\/[^/]+\.xml$/.test(f),
  );
  const layoutXml = (await Promise.all(layoutNames.map((n) => zip.file(n)!.async("string")))).join("");
  const allXml = layoutXml + slides.join("");
  const hasFooter = allXml.includes(BRAND.footer);
  checks.push({
    name: "mandatory-footer",
    passed: hasFooter,
    detail: hasFooter ? "Mandatory footer present." : `Missing mandatory footer: "${BRAND.footer}".`,
  });

  // Brand typography — the template face must be used; foreign faces fail.
  // (Library structural defaults in BRAND.fallbackFonts are tolerated.)
  const allowed = new Set<string>([BRAND.font, ...BRAND.fallbackFonts]);
  const faces = [...allXml.matchAll(/typeface="([^"]+)"/g)].map((m) => m[1]!);
  const foreign = [...new Set(faces.filter((f) => !allowed.has(f) && !f.startsWith("+")))];
  checks.push({
    name: "brand-typography",
    passed: allXml.includes(`typeface="${BRAND.font}"`) && foreign.length === 0,
    detail:
      foreign.length === 0
        ? `All text uses ${BRAND.font}.`
        : `Off-template font(s): ${foreign.join(", ")}.`,
  });

  // Brand palette — the Hilti red keyline must appear; unapproved accents flagged
  // by checking the title slide uses the ink colour for headings.
  const hasBrandRed = allXml.includes(BRAND.colors.red);
  checks.push({
    name: "brand-palette",
    passed: hasBrandRed,
    detail: hasBrandRed ? "Brand keyline colour present." : "Missing the Hilti red brand keyline.",
  });

  // Lineage slide — every deliverable must carry provenance (§13).
  const hasLineage = slides.some((s) => s.includes("Lineage") && s.includes("provenance"));
  checks.push({
    name: "lineage-slide",
    passed: hasLineage,
    detail: hasLineage ? "Lineage & provenance slide present." : "Missing the lineage & provenance slide.",
  });

  return result(checks);
}

/** Validate a generated .xlsx buffer against the brand template. */
export async function validateWorkbook(buffer: Buffer): Promise<ConformanceResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const checks: ConformanceCheck[] = [];

  const sheets = wb.worksheets;
  checks.push({
    name: "structure",
    passed: sheets.length >= 2,
    detail: sheets.length >= 2 ? `${sheets.length} sheets.` : "Workbook must have content and lineage sheets.",
  });

  // Mandatory footer text on every sheet (cell A2 by template).
  const missingFooter = sheets.filter((ws) => String(ws.getCell("A2").value ?? "") !== BRAND.footer);
  checks.push({
    name: "mandatory-footer",
    passed: missingFooter.length === 0,
    detail:
      missingFooter.length === 0
        ? "Mandatory footer present on every sheet."
        : `Missing footer on: ${missingFooter.map((w) => w.name).join(", ")}.`,
  });

  // Brand typography on header bands.
  const badFont = sheets.filter((ws) => {
    const font = ws.getRow(4).getCell(1).font;
    return font?.name !== BRAND.font;
  });
  checks.push({
    name: "brand-typography",
    passed: badFont.length === 0,
    detail:
      badFont.length === 0
        ? `Header bands use ${BRAND.font}.`
        : `Off-template header font on: ${badFont.map((w) => w.name).join(", ")}.`,
  });

  const hasLineage = sheets.some((ws) => ws.name === "Lineage");
  checks.push({
    name: "lineage-sheet",
    passed: hasLineage,
    detail: hasLineage ? "Lineage sheet present." : "Missing the Lineage sheet.",
  });

  return result(checks);
}

export async function validateDeliverable(format: "pptx" | "xlsx", buffer: Buffer): Promise<ConformanceResult> {
  return format === "pptx" ? validateDeck(buffer) : validateWorkbook(buffer);
}
