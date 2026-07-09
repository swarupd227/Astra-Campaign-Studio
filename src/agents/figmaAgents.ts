import { ArtifactKind, ArtifactStatus, Stage, type Artifact, type Citation } from "../domain/types";
import type { Agent, AgentContext } from "../orchestration/agent";
import { FIGMA_SCOPES, type FigmaBoard, type FigmaFrame, type MapContentInput } from "../integrations/figma";

/**
 * Figma Mapping Agent (spec §6.3, §10.3, §11.3) — TWO-PHASE, resolving the
 * "dependency on the Figma Mapping Agent to create the board" flagged on
 * Hilti's flow as a deterministic sequence rather than a race:
 *
 *  Phase 1 (figmaBoardAgent): on approval of the Campaign Scope Brief, create
 *  the board and its named placeholder frames — BEFORE any content agent fires.
 *  The board's existence is a precondition of content generation, enforced by
 *  the orchestrator.
 *
 *  Phase 2 (figmaMappingAgent): place APPROVED copy and creative into the
 *  matching frames. Same artifact title, so the populated board supersedes the
 *  placeholder board — one "Figma board" with full version history.
 */

const AGENT_ACTOR = { kind: "agent" as const, id: "Figma Mapping Agent", displayName: "Figma Mapping Agent" };

export const BOARD_TITLE = "Figma board";

/** The current (non-superseded) board artifact, whatever its phase. */
export function boardArtifact(obj: { artifacts: Record<string, Artifact> }): Artifact | undefined {
  return Object.values(obj.artifacts)
    .filter(
      (a) =>
        a.title === BOARD_TITLE &&
        a.status !== ArtifactStatus.Rejected &&
        a.status !== ArtifactStatus.Superseded,
    )
    .sort((a, b) => b.version - a.version)[0];
}

/**
 * Phase 1 — board creation (§11.3). Runs when the Campaign Scope Brief is
 * approved; creates the board with its named placeholder frames, all empty.
 */
export const figmaBoardAgent: Agent = {
  name: "Figma Mapping Agent",
  stage: Stage.ContentCreation,
  role: "creator",
  async propose(ctx) {
    const boardId = ctx.campaignId;
    const scopeBrief = approved(ctx, ArtifactKind.CreativeBrief);

    let board: FigmaBoard | undefined;
    if (ctx.connectors) {
      board = (await ctx.connectors.invoke("figma", "get_template", { boardId }, {
        campaignId: ctx.campaignId,
        actor: AGENT_ACTOR,
        grantedScopes: ctx.grantedScopes ?? [FIGMA_SCOPES.read],
      })) as FigmaBoard;
    }

    return {
      kind: ArtifactKind.Asset,
      stage: Stage.ContentCreation,
      title: BOARD_TITLE,
      body: {
        boardId,
        phase: "placeholders",
        frames: board?.frames ?? {},
        filledFrames: 0,
        boardVersion: board?.version ?? 1,
      },
      rationale:
        "Phase 1 of the mapping contract (§11.3): created the board and its named placeholder frames from the approved Campaign Scope Brief — before any content agent fires.",
      citations: scopeBrief?.citations ?? [],
      derivedFrom: scopeBrief ? [scopeBrief.id] : [],
    };
  },
};

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
    // Phase 2 derives from the Phase-1 placeholder board (§11.3 lineage).
    const placeholders = boardArtifact(ctx.campaign);

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
      title: BOARD_TITLE, // same title → the populated board supersedes the placeholders
      body: {
        boardId,
        phase: "populated",
        frames: board?.frames ?? mappings,
        filledFrames: filled,
        boardVersion: board?.version ?? 1,
      },
      rationale: `Phase 2 of the mapping contract (§11.3): deterministically placed approved content into ${Object.keys(mappings).length} named frames via the governed Figma MCP tool.`,
      citations,
      derivedFrom: [...(placeholders ? [placeholders.id] : []), ...sources.map((s) => s.id)],
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
    const prevBoard = approved(ctx, ArtifactKind.Asset, BOARD_TITLE);

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
      title: BOARD_TITLE, // same title → new version supersedes prior
      body: {
        boardId,
        phase: "populated",
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
