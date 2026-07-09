import { describe, expect, it } from "vitest";
import { Astra } from "../src/app";
import { fixedClock } from "../src/domain/ids";
import { ArtifactKind, ArtifactStatus, Stage, type Actor } from "../src/domain/types";
import { agentsForStage } from "../src/agents/catalogue";
import { boardArtifact, figmaRoundTripAgent } from "../src/agents/figmaAgents";
import { FIGMA_FRAMES, FIGMA_SCOPES } from "../src/integrations/figma";
import {
  ConnectorRegistry,
  GovernanceError,
  RateLimitError,
  type Connector,
} from "../src/integrations/mcp";

const human: Actor = { kind: "human", id: "u1", displayName: "Tester" };

function newAstra() {
  return new Astra({ persistence: "memory", clock: fixedClock("2026-01-01T00:00:00Z"), campaignTokenBudget: 0 });
}

async function runToRollout(astra: Astra): Promise<string> {
  const id = await astra.createCampaign(
    { objective: "Launch cordless platform", owner: human.id, markets: ["DE", "US"], budget: 750_000, currency: "EUR", kpis: ["Qualified leads"] },
    human,
  );
  const orch = astra.stageOrchestrator(async () => ({ approve: true, actor: human }));
  for (let i = 0; i < 8; i++) {
    const obj = await astra.repo.load(id);
    // The board is assembled during content creation — stop once we're past it.
    if (obj!.campaign.currentStage === Stage.Rollout) break;
    if (agentsForStage(obj!.campaign.currentStage).length === 0) break;
    await orch.runCurrentStage(id);
  }
  return id;
}

describe("Figma mapping agent (spec §10.3, two-phase §11.3)", () => {
  it("populates every named placeholder frame from approved artifacts", async () => {
    const astra = newAstra();
    const id = await runToRollout(astra);
    const obj = await astra.repo.load(id);
    const board = boardArtifact(obj!);
    expect(board).toBeDefined();
    expect(board!.body.phase).toBe("populated");
    const frames = board!.body.frames as Record<string, string>;
    for (const frame of FIGMA_FRAMES) {
      expect(frames[frame], `frame ${frame} should be filled`).toBeTruthy();
    }
    expect(board!.kind).toBe(ArtifactKind.Asset);
  });

  it("Phase 1 creates the board BEFORE any content agent fires (§11.3 precondition)", async () => {
    const astra = newAstra();
    const id = await runToRollout(astra);
    const events = await astra.store.read(id);
    const proposals = events.flatMap((e) => (e.body.type === "ArtifactProposed" ? [e.body] : []));
    const boardIdx = proposals.findIndex(
      (p) => p.artifact.title === "Figma board" && p.artifact.body.phase === "placeholders",
    );
    const firstContentIdx = proposals.findIndex(
      (p) => p.artifact.kind === ArtifactKind.ContentItem && p.artifact.stage === Stage.ContentCreation,
    );
    expect(boardIdx).toBeGreaterThanOrEqual(0);
    expect(firstContentIdx).toBeGreaterThan(boardIdx); // board existence precedes content generation
  });

  it("the populated board supersedes the placeholder board and derives from it", async () => {
    const astra = newAstra();
    const id = await runToRollout(astra);
    const obj = await astra.repo.load(id);
    const versions = Object.values(obj!.artifacts).filter((a) => a.title === "Figma board");
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const placeholders = versions.find((a) => a.body.phase === "placeholders")!;
    const populated = boardArtifact(obj!)!;
    expect(placeholders.status).toBe(ArtifactStatus.Superseded);
    expect(populated.derivedFrom).toContain(placeholders.id);
  });

  it("records every Figma call as a governed, audited connector event", async () => {
    const astra = newAstra();
    const id = await runToRollout(astra);
    const events = await astra.store.read(id);
    const figmaCalls = events.filter(
      (e) => e.body.type === "ConnectorInvoked" && e.body.connector === "figma",
    );
    // get_template + map_content during mapping.
    expect(figmaCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("board artifact inherits grounding citations from its sources (lineage)", async () => {
    const astra = newAstra();
    const id = await runToRollout(astra);
    const obj = await astra.repo.load(id);
    const board = boardArtifact(obj!);
    expect(board!.citations.length).toBeGreaterThan(0);
    expect(board!.derivedFrom.length).toBeGreaterThan(0);
  });

  it("round-trip sync pulls a designer edit back as a new board version", async () => {
    const astra = newAstra();
    const id = await runToRollout(astra);
    astra.figma.simulateDesignerEdit(id, "paid-headline", "Zero downtime. Total control.");
    const rt = await astra.orchestrator.runAgent(id, figmaRoundTripAgent);
    if (rt.pendingHumanApproval) await astra.orchestrator.approve(id, rt.artifact.id, human);
    const frames = rt.artifact.body.frames as Record<string, string>;
    expect(frames["paid-headline"]).toBe("Zero downtime. Total control.");
    expect(rt.artifact.body.syncedFromDesigner).toBe(true);
  });
});

describe("MCP governance (spec §10.1)", () => {
  const irreversibleConnector: Connector = {
    name: "adnet",
    tools: [
      { name: "publish", description: "Push creative live", scopes: ["adnet:publish"], effect: "irreversible" },
      { name: "preview", description: "Read a preview", scopes: ["adnet:read"], effect: "read" },
    ],
    async execute(tool) {
      return { result: { ok: true }, summary: `ran ${tool}` };
    },
  };

  function registry() {
    return new ConnectorRegistry(async () => {});
  }

  const opts = (extra: Partial<{ grantedScopes: string[]; approved: boolean }> = {}) => ({
    campaignId: "c1",
    actor: human,
    grantedScopes: extra.grantedScopes ?? ["adnet:publish", "adnet:read"],
    ...(extra.approved !== undefined ? { approved: extra.approved } : {}),
  });

  it("blocks an irreversible action without explicit human approval", async () => {
    const reg = registry();
    reg.register(irreversibleConnector);
    await expect(reg.invoke("adnet", "publish", {}, opts())).rejects.toBeInstanceOf(GovernanceError);
  });

  it("allows an irreversible action when explicitly approved", async () => {
    const reg = registry();
    reg.register(irreversibleConnector);
    await expect(reg.invoke("adnet", "publish", {}, opts({ approved: true }))).resolves.toEqual({ ok: true });
  });

  it("enforces least-privilege scopes", async () => {
    const reg = registry();
    reg.register(irreversibleConnector);
    await expect(
      reg.invoke("adnet", "preview", {}, opts({ grantedScopes: [] })),
    ).rejects.toBeInstanceOf(GovernanceError);
  });

  it("enforces a per-campaign rate limit", async () => {
    const reg = registry();
    reg.register(irreversibleConnector, 1); // 1 call per campaign
    await reg.invoke("adnet", "preview", {}, opts());
    await expect(reg.invoke("adnet", "preview", {}, opts())).rejects.toBeInstanceOf(RateLimitError);
  });

  it("Figma write scope is required for map_content", async () => {
    const astra = newAstra();
    const id = await astra.createCampaign(
      { objective: "x", owner: human.id, markets: ["DE"], budget: 1, currency: "EUR", kpis: ["k"] },
      human,
    );
    await expect(
      astra.connectors.invoke("figma", "map_content", { boardId: id, mappings: {} }, {
        campaignId: id,
        actor: human,
        grantedScopes: [FIGMA_SCOPES.read], // missing write scope
      }),
    ).rejects.toBeInstanceOf(GovernanceError);
  });
});
