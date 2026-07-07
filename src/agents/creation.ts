import { ArtifactKind, Stage } from "../domain/types";
import { defineAgent, findArtifactId, groundedGenerate, type Agent } from "../orchestration/agent";
import { figmaMappingAgent } from "./figmaAgents";

/**
 * Stage 3 · Content Creation producer agents (spec §6.3). The Brand/Tone,
 * Compliance and Accessibility "agents" of §6.3 are realised as the eval gate
 * (src/evals) — no asset advances until they pass. The Figma Mapping Agent is
 * built in the MCP/Figma step.
 */

const role = "creator";
const briefLineage = (ctx: Parameters<typeof findArtifactId>[0]) =>
  findArtifactId(ctx, ArtifactKind.CreativeBrief);

/** Approved-claim footnote every performance claim must carry (satisfies compliance eval). */
const FOOTNOTE = "¹ Runtime measured under standard test conditions; substantiation on file.";

export const copywritingAgent: Agent = defineAgent({
  name: "Copywriting / SEO Agent",
  stage: Stage.ContentCreation,
  role,
  kind: ArtifactKind.ContentItem,
  title: "Paid-social copy",
  system: "You are Hilti's Copywriting Agent. Draft on-brand, compliant channel copy with SEO metadata.",
  query: () => "cordless runtime uptime approved claim footnote tone paid social",
  rationale: "Uptime-led copy grounded in the approved claim, with a substantiation footnote for compliance.",
  derivedFrom: briefLineage,
  body: () => ({
    channel: "paid-social",
    headline: "Power through the workday. No downtime, no compromise.",
    body: "The new Hilti cordless platform delivers extended runtime¹ so your crew keeps moving.",
    footnote: FOOTNOTE,
    seo: { keywords: ["cordless platform", "jobsite uptime"] },
  }),
});

export const landingPageAgent: Agent = defineAgent({
  name: "Landing Page Agent",
  stage: Stage.ContentCreation,
  role,
  kind: ArtifactKind.ContentItem,
  title: "Landing page",
  system: "You are Hilti's Landing Page Agent. Assemble landing-page content and structure.",
  query: () => "landing page structure hero uptime proof cordless conversion",
  rationale: "Assembled a conversion-focused page from the Campaign Scope Brief and PDP plan.",
  derivedFrom: briefLineage,
  body: () => ({
    channel: "landing-page",
    hero: "No downtime, no compromise.",
    sections: ["Hero", "Uptime proof¹", "Fleet compatibility", "Request a demo"],
    footnote: FOOTNOTE,
  }),
});

export const emailAgent: Agent = defineAgent({
  name: "Email Creation Agent",
  stage: Stage.ContentCreation,
  role,
  kind: ArtifactKind.ContentItem,
  title: "Launch email",
  system: "You are Hilti's Email Agent. Build email copy and base files for SFMC.",
  query: () => "email hero jobsite imagery nurture uptime cordless",
  rationale: "Wrote a launch email whose hero leans on jobsite imagery — the strongest open-rate driver per grounding.",
  derivedFrom: briefLineage,
  body: () => ({
    channel: "email",
    subject: "Meet the platform that never quits",
    preheader: "Extended runtime¹ for the whole fleet",
    body: "One battery platform. Every job. No downtime, no compromise.",
    footnote: FOOTNOTE,
  }),
});

export const moduleAgent: Agent = defineAgent({
  name: "Module Creation Agent",
  stage: Stage.ContentCreation,
  role,
  kind: ArtifactKind.ContentItem,
  title: "Reusable proof module",
  system: "You are Hilti's Module Agent. Produce reusable content modules/blocks.",
  query: () => "reusable module proof point uptime block",
  rationale: "Produced a reusable uptime-proof module usable across landing and PDP.",
  derivedFrom: briefLineage,
  body: () => ({
    channel: "module",
    block: "uptime-proof",
    content: "Extended runtime with active temperature management¹.",
    footnote: FOOTNOTE,
  }),
});

/**
 * Image / Video Generation Agent — Anthropic-First creative path (spec §10.1):
 * when Claude Design is connected, the hero visual is created through its
 * governed MCP `create_design` tool (scope-checked, audited, result swept);
 * otherwise the built-in renderer produces the same on-brand artwork. Either
 * way the body carries a previewable URL, not an opaque file path.
 */
export const imageAgent: Agent = {
  name: "Image / Video Generation Agent",
  stage: Stage.ContentCreation,
  role,
  async propose(ctx) {
    const { citations } = await groundedGenerate(ctx, {
      system: "You are Hilti's Image Generation Agent. Create visual assets to brief, with alt text.",
      query: "hero image jobsite crew cordless sunrise brand",
      buildPrompt: (context) => `Grounding:\n${context}\n\nTask: produce "Hero image".`,
    });

    let imageUrl = "/assets/hero-jobsite-sunrise.svg";
    let generatedVia = "built-in renderer";
    const claudeDesign = ctx.connectors?.get("claude-design");
    if (claudeDesign?.tools.some((t) => t.name === "create_design")) {
      try {
        const result = (await ctx.connectors!.invoke(
          "claude-design",
          "create_design",
          {
            brief: "Campaign hero: a construction crew starting at sunrise on a jobsite, cordless platform launch.",
            headline: "No downtime, no compromise.",
            subline: "The new cordless platform. One battery. Every job.",
            mood: "dawn",
          },
          {
            campaignId: ctx.campaignId,
            actor: { kind: "agent", id: "agent_image", displayName: "Image / Video Generation Agent" },
            grantedScopes: ctx.grantedScopes ?? [],
          },
        )) as { content?: { type: string; text?: string }[] };
        const text = result?.content?.find((c) => c.type === "text")?.text;
        const design = text ? (JSON.parse(text) as { url?: string }) : undefined;
        if (design?.url) {
          imageUrl = design.url;
          generatedVia = "Claude Design";
        }
      } catch {
        // Governance denial / server unavailable → keep the built-in path.
      }
    }

    return {
      kind: ArtifactKind.Asset,
      stage: Stage.ContentCreation,
      title: "Hero image",
      body: {
        imageUrl,
        altText: "A Hilti crew gearing up with cordless tools on a jobsite at sunrise.",
        spec: { ratio: "16:10", format: "svg" },
        generatedVia,
      },
      rationale:
        generatedVia === "Claude Design"
          ? "Generated the hero via Claude Design (governed MCP), to the storyboard, with WCAG alt text."
          : "Generated an on-brand hero image to the storyboard, with WCAG alt text.",
      citations,
      derivedFrom: findArtifactId(ctx, ArtifactKind.Storyboard),
    };
  },
};

export const assetEditingAgent: Agent = defineAgent({
  name: "Asset Editing Agent",
  stage: Stage.ContentCreation,
  role,
  kind: ArtifactKind.Asset,
  title: "Hero image — channel crops",
  system: "You are Hilti's Asset Editing Agent. Retouch, resize and reformat for channel specs.",
  query: () => "resize reformat channel specs paid social email",
  rationale: "Reformatted the hero image into per-channel crops while preserving alt text.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.Asset),
  body: () => ({
    imageUrl: "/assets/hero-jobsite-sunrise-crops.svg",
    altText: "A Hilti crew gearing up with cordless tools on a jobsite at sunrise.",
    crops: [
      { channel: "paid-social", ratio: "4:5" },
      { channel: "email", ratio: "16:9" },
    ],
  }),
});

export const contentMultiplierAgent: Agent = defineAgent({
  name: "Content Multiplier Agent",
  stage: Stage.ContentCreation,
  role,
  kind: ArtifactKind.ContentItem,
  title: "Paid-social copy — LinkedIn variant",
  system: "You are Hilti's Content Multiplier Agent. Fan one asset into channel/format variants.",
  query: () => "linkedin variant professional tone uptime cordless",
  rationale: "Fanned the paid-social copy into a LinkedIn variant, preserving the compliance footnote.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.ContentItem),
  body: () => ({
    channel: "linkedin",
    headline: "Uptime is productivity. Meet the platform that never quits.",
    body: "Extended runtime¹ across one battery platform — engineered for the professional jobsite.",
    footnote: FOOTNOTE,
  }),
});

export const localisationAgent: Agent = defineAgent({
  name: "Localisation / Transcreation Agent",
  stage: Stage.ContentCreation,
  role,
  kind: ArtifactKind.ContentItem,
  title: "Paid-social copy — DE (transcreation)",
  system: "You are Hilti's Localisation Agent. Adapt, don't translate, per market.",
  query: () => "DACH german transcreation uptime cultural adaptation",
  rationale: "Transcreated the paid-social copy for DE — adapted meaning, not literal words, per DACH market rules.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.ContentItem),
  body: () => ({
    channel: "paid-social",
    market: "DE",
    headline: "Kraftvoll durch den Arbeitstag. Keine Ausfallzeit, keine Kompromisse.",
    body: "Die neue Hilti Akku-Plattform liefert lange Laufzeit¹ — damit Ihr Team in Bewegung bleibt.",
    footnote: "¹ Laufzeit unter Standard-Testbedingungen gemessen; Nachweis liegt vor.",
  }),
});

export const creationAgents: Agent[] = [
  copywritingAgent,
  landingPageAgent,
  emailAgent,
  moduleAgent,
  imageAgent,
  assetEditingAgent,
  contentMultiplierAgent,
  localisationAgent,
  // Runs last: maps the now-approved copy & imagery onto the Figma board (§10.3).
  figmaMappingAgent,
];
