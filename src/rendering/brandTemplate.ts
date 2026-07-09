/**
 * Hilti-brand template constants for the artifact rendering layer (spec §9.3).
 * Generation is deterministic and template-driven, which is what makes template
 * conformance a TESTABLE property (§9.6): the validator checks generated files
 * against these same constants — fonts, palette, mandatory footer — so an
 * off-template deck fails the gate before a human ever opens it.
 */

export const BRAND = {
  /** Typography — every text run in a generated file uses this face. */
  font: "Segoe UI",
  /** Faces tolerated in generated files (library structural defaults only). */
  fallbackFonts: ["Arial"],
  /** Palette (hex, no #): Hilti red, ink navy, gold accent, muted slate, paper. */
  colors: {
    red: "D2051E",
    ink: "0B1626",
    gold: "B8913B",
    muted: "5A6B7C",
    paper: "FFFFFF",
    panel: "F4F6F8",
    line: "D8DEE4",
  },
  /** Mandatory footer — its absence is a conformance failure (§9.6). */
  footer: "Astra Campaign Studio · ARTIZENT · Confidential",
} as const;

/** File-name-safe stamp for a campaign deliverable. */
export function deliverableFileName(key: string, ext: "pptx" | "xlsx"): string {
  return `astra-${key}.${ext}`;
}

export const MIME = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

/** Lineage row embedded in every deliverable (spec §13 Rendering entity). */
export interface LineageEntry {
  artifactId: string;
  title: string;
  version: number;
  status: string;
  author: string;
  evals: string;
}
