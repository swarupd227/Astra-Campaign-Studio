import pptxgen from "pptxgenjs";
import { BRAND, type LineageEntry } from "./brandTemplate";

// pptxgenjs ships CJS; under ESM interop the constructor may arrive as `.default`.
const PptxCtor: typeof pptxgen =
  (pptxgen as unknown as { default?: typeof pptxgen }).default ?? pptxgen;

/**
 * Deterministic PPTX generation (spec §9.3): a typed DeckSpec — built from the
 * campaign object, never from prose — renders to a brand-templated deck. Every
 * slide carries the mandatory footer and brand typography via the slide master,
 * so conformance is structural, not stylistic discipline.
 */

export interface DeckKv {
  kind: "kv";
  rows: [string, string][];
}
export interface DeckBullets {
  kind: "bullets";
  items: string[];
}
export interface DeckTable {
  kind: "table";
  header: string[];
  rows: string[][];
}
export type DeckBlock = DeckKv | DeckBullets | DeckTable;

export interface DeckSlide {
  heading: string;
  blocks: DeckBlock[];
}

export interface DeckSpec {
  title: string;
  subtitle: string;
  slides: DeckSlide[];
  lineage: LineageEntry[];
}

const MASTER = "ASTRA_BRAND";

export async function renderDeck(spec: DeckSpec): Promise<Buffer> {
  const pptx = new PptxCtor();
  pptx.layout = "LAYOUT_16x9";
  pptx.defineSlideMaster({
    title: MASTER,
    background: { color: BRAND.colors.paper },
    objects: [
      // Brand keyline + mandatory footer on every slide (conformance checks these).
      { rect: { x: 0, y: 5.32, w: "100%", h: 0.02, fill: { color: BRAND.colors.gold } } },
      {
        text: {
          text: BRAND.footer,
          options: {
            x: 0.35, y: 5.36, w: 9.3, h: 0.26,
            fontFace: BRAND.font, fontSize: 8, color: BRAND.colors.muted, align: "left",
          },
        },
      },
    ],
    slideNumber: { x: 9.35, y: 5.36, fontFace: BRAND.font, fontSize: 8, color: BRAND.colors.muted },
  });

  // Title slide.
  const title = pptx.addSlide({ masterName: MASTER });
  title.addShape("rect", { x: 0.35, y: 1.32, w: 0.09, h: 1.5, fill: { color: BRAND.colors.red } });
  title.addText(spec.title, {
    x: 0.62, y: 1.3, w: 8.9, h: 1.0,
    fontFace: BRAND.font, fontSize: 30, bold: true, color: BRAND.colors.ink, align: "left",
  });
  title.addText(spec.subtitle, {
    x: 0.62, y: 2.3, w: 8.9, h: 0.5,
    fontFace: BRAND.font, fontSize: 14, color: BRAND.colors.muted, align: "left",
  });

  for (const s of spec.slides) addContentSlide(pptx, s);

  addContentSlide(pptx, {
    heading: "Lineage & provenance",
    blocks: [
      {
        kind: "table",
        header: ["Artifact", "Version", "Status", "Author", "Quality gates"],
        rows: spec.lineage.map((l) => [l.title, `v${l.version}`, l.status, l.author, l.evals]),
      },
    ],
  });

  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}

function addContentSlide(pptx: pptxgen, slide: DeckSlide): void {
  const s = pptx.addSlide({ masterName: MASTER });
  s.addText(slide.heading, {
    x: 0.35, y: 0.28, w: 9.3, h: 0.55,
    fontFace: BRAND.font, fontSize: 20, bold: true, color: BRAND.colors.ink,
  });
  s.addShape("rect", { x: 0.37, y: 0.86, w: 1.15, h: 0.045, fill: { color: BRAND.colors.red } });

  let y = 1.1;
  for (const block of slide.blocks) {
    // Deliverables render at ANY object state (§9: documents are live views), so
    // a section whose source artifact hasn't been produced yet renders as pending.
    const empty =
      (block.kind === "bullets" && block.items.length === 0) ||
      (block.kind === "kv" && block.rows.length === 0) ||
      (block.kind === "table" && block.rows.length === 0);
    if (empty) {
      s.addText("— not yet produced —", {
        x: 0.5, y, w: 9.0, h: 0.3,
        fontFace: BRAND.font, fontSize: 12, italic: true, color: BRAND.colors.muted,
      });
      y += 0.44;
      continue;
    }
    if (block.kind === "bullets") {
      s.addText(
        block.items.map((t) => ({ text: t, options: { bullet: { code: "2022" }, breakLine: true } })),
        { x: 0.5, y, w: 9.0, h: 0.34 * block.items.length, fontFace: BRAND.font, fontSize: 13, color: BRAND.colors.ink },
      );
      y += 0.34 * block.items.length + 0.18;
    } else if (block.kind === "kv") {
      s.addTable(
        block.rows.map(([k, v]) => [
          { text: k, options: { bold: true, color: BRAND.colors.muted } },
          { text: v, options: { color: BRAND.colors.ink } },
        ]),
        {
          x: 0.5, y, w: 9.0, colW: [2.6, 6.4],
          fontFace: BRAND.font, fontSize: 12,
          border: { type: "solid", color: BRAND.colors.line, pt: 0.5 },
          margin: 0.06, valign: "top",
        },
      );
      y += 0.32 * block.rows.length + 0.24;
    } else {
      s.addTable(
        [
          block.header.map((h) => ({
            text: h,
            options: { bold: true, color: BRAND.colors.paper, fill: { color: BRAND.colors.ink } },
          })),
          ...block.rows.map((r) => r.map((c) => ({ text: c, options: { color: BRAND.colors.ink } }))),
        ],
        {
          x: 0.5, y, w: 9.0,
          fontFace: BRAND.font, fontSize: 11,
          border: { type: "solid", color: BRAND.colors.line, pt: 0.5 },
          margin: 0.05, valign: "top",
        },
      );
      y += 0.3 * (block.rows.length + 1) + 0.24;
    }
  }
}
