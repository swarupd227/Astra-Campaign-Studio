import { ArtifactKind, ArtifactStatus, Stage, type Artifact, type Citation } from "../domain/types";
import type { Agent, AgentContext } from "../orchestration/agent";
import { FIGMA_SCOPES, type FigmaBoard, type FigmaFrame, type MapContentInput } from "../integrations/figma";

/**
 * Figma Mapping Agent (spec §6.3, §10.3). Reads APPROVED copy and creative from
 * the campaign object and deterministically places them into the board's named
 * placeholder frames via the governed Figma MCP tool — resolving the "Figma
 * Mapping Agent dependency" as an engineered contract, not inference.
 */

const AGENT_ACTOR = { kind: "agent" as const, id: "Figma Mapping Agent", displayName: "Figma Mapping Agent" };

function approved(ctx: AgentContext, kind: ArtifactKind, titleIncludes?: string): Artifact | undefined {
  return Object.values(ctx.campaign.artifacts).find(
    (a) =>
      a.kind === kind &&
      a.status === ArtifactStatus.Approved &&
      (titleIncludes ? a.title.includes(titleIncludes) : true),
  );
}

/** Deterministic contract: which approved artifact populates which named frame. */
function buildMappings(ctx: AgentContext): {
  mappings: Partial<Record<FigmaFrame, string>>;
  sources: Artifact[];
} {
  const paid = approved(ctx, ArtifactKind.ContentItem, "Paid-social copy");
  const email = approved(ctx, ArtifactKind.ContentItem, "Launch email");
  const landing = approved(ctx, ArtifactKind.ContentItem, "Landing page");
  const hero = approved(ctx, ArtifactKind.Asset, "Hero image");
  const sources = [paid, email, landing, hero].filter((a): a is Artifact => Boolean(a));

  const withFootnote = (b: Record<string, unknown>): string =>
    [b.body, b.footnote].filter(Boolean).join(" ");

  const mappings: Partial<Record<FigmaFrame, string>> = {};
  if (paid) {
    mappings["paid-headline"] = String(paid.body.headline ?? "");
    mappings["paid-body"] = withFootnote(paid.body);
  }
  if (hero) mappings["hero-image"] = String(hero.body.imageUrl ?? "");
  if (email) {
    mappings["email-subject"] = String(email.body.subject ?? "");
    mappings["email-hero"] = withFootnote(email.body);
  }
  if (landing) mappings["landing-hero"] = String(landing.body.hero ?? "");

  return { mappings, sources };
}

export const figmaMappingAgent: Agent = {
  name: "Figma Mapping Agent",
  stage: Stage.ContentCreation,
  role: "creator",
  async propose(ctx) {
    const boardId = ctx.campaignId;
    const { mappings, sources } = buildMappings(ctx);

    let board: FigmaBoard | undefined;
    if (ctx.connectors) {
      const invokeOpts = {
        campaignId: ctx.campaignId,
        actor: AGENT_ACTOR,
        grantedScopes: ctx.grantedScopes ?? [FIGMA_SCOPES.read, FIGMA_SCOPES.write],
      };
      // 1. Fetch the placeholder template, 2. map content into named frames.
      await ctx.connectors.invoke("figma", "get_template", { boardId }, invokeOpts);
      board = (await ctx.connectors.invoke(
        "figma",
        "map_content",
        { boardId, mappings } satisfies MapContentInput,
        invokeOpts,
      )) as FigmaBoard;
    }

    // The board inherits the union of its source artifacts' grounding citations —
    // it is traceable to the same Hilti sources (spec §12 lineage).
    const citations = dedupeCitations(sources.flatMap((s) => s.citations));
    const filled = board ? Object.values(board.frames).filter((v) => v !== "").length : 0;

    return {
      kind: ArtifactKind.Asset,
      stage: Stage.ContentCreation,
      title: "Figma board (populated)",
      body: {
        boardId,
        frames: board?.frames ?? mappings,
        filledFrames: filled,
        boardVersion: board?.version ?? 1,
      },
      rationale: `Deterministically placed approved content into ${Object.keys(mappings).length} named frames via the governed Figma MCP tool.`,
      citations,
      derivedFrom: sources.map((s) => s.id),
    };
  },
};

/**
 * Figma Round-trip Sync Agent (spec §10.3). After a designer refines frames
 * directly in Figma, reads the board back and proposes a new version of the
 * board artifact — keeping the campaign object and the board in sync.
 */
export const figmaRoundTripAgent: Agent = {
  name: "Figma Round-trip Sync Agent",
  stage: Stage.ContentCreation,
  role: "creator",
  async propose(ctx) {
    const boardId = ctx.campaignId;
    const prevBoard = approved(ctx, ArtifactKind.Asset, "Figma board (populated)");

    let board: FigmaBoard | undefined;
    if (ctx.connectors) {
      board = (await ctx.connectors.invoke(
        "figma",
        "read_board",
        { boardId },
        {
          campaignId: ctx.campaignId,
          actor: AGENT_ACTOR,
          grantedScopes: ctx.grantedScopes ?? [FIGMA_SCOPES.read],
        },
      )) as FigmaBoard;
    }

    const filled = board ? Object.values(board.frames).filter((v) => v !== "").length : 0;
    return {
      kind: ArtifactKind.Asset,
      stage: Stage.ContentCreation,
      title: "Figma board (populated)", // same title → new version supersedes prior
      body: {
        boardId,
        frames: board?.frames ?? {},
        filledFrames: filled,
        boardVersion: board?.version ?? 1,
        syncedFromDesigner: true,
      },
      rationale: "Pulled designer refinements from Figma back into the campaign object as a new board version.",
      citations: prevBoard?.citations ?? [],
      derivedFrom: prevBoard ? [prevBoard.id] : [],
    };
  },
};

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Map<string, Citation>();
  for (const c of citations) seen.set(`${c.sourceId}@${c.version}`, c);
  return [...seen.values()];
}
