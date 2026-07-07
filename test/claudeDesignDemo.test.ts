import { describe, expect, it } from "vitest";
import { Astra } from "../src/app";
import { fixedClock } from "../src/domain/ids";
import type { Actor } from "../src/domain/types";
import { imageAgent } from "../src/agents/creation";
import { ClaudeDesignConnector, CLAUDE_DESIGN_SCOPE } from "../src/integrations/claudeDesign";
import { ConnectorRegistry } from "../src/integrations/mcp";
import { assetSvg, DEMO_SERVER_NAME, handleClaudeDesignRpc } from "../src/integrations/claudeDesignDemo";
import { heroArtSvg } from "../src/integrations/designArt";

const human: Actor = { kind: "human", id: "u1", displayName: "Tester" };

/** Loopback fetch: routes the connector's HTTP calls straight into the demo server. */
const loopbackFetch: typeof fetch = (async (_url: any, init?: RequestInit) => {
  const reply = handleClaudeDesignRpc(JSON.parse(String(init?.body ?? "{}")));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(reply.sessionId ? { "mcp-session-id": reply.sessionId } : {}),
  };
  return {
    ok: true,
    status: reply.status,
    statusText: "OK",
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => (reply.body === null ? "" : JSON.stringify(reply.body)),
  } as unknown as Response;
}) as typeof fetch;

describe("bundled Claude Design demo MCP server", () => {
  it("speaks the MCP handshake: initialize → initialized → tools/list", async () => {
    const cd = new ClaudeDesignConnector(loopbackFetch);
    const status = await cd.configure({ endpoint: "http://localhost:4000/mcp/claude-design", token: "demo-local" });
    expect(status.configured).toBe(true);
    expect(status.serverName).toBe(DEMO_SERVER_NAME);
    expect(status.tools).toEqual(["create_design", "refine_design"]);
  });

  it("create_design renders artwork addressable under /assets/", () => {
    const reply = handleClaudeDesignRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "create_design", arguments: { brief: "sunrise jobsite", headline: "Test headline" } },
    });
    const body = reply.body as { result: { content: { text: string }[] } };
    const design = JSON.parse(body.result.content[0]!.text) as { designId: string; url: string };
    expect(design.url).toBe(`/assets/design-${design.designId}.svg`);
    const svg = assetSvg(`design-${design.designId}.svg`);
    expect(svg).toContain("<svg");
    expect(svg).toContain("Test headline");
  });

  it("serves the built-in hero art and rejects traversal-ish names", () => {
    expect(assetSvg("hero-jobsite-sunrise.svg")).toBe(heroArtSvg());
    expect(assetSvg("../secrets.svg")).toBeNull();
    expect(assetSvg("nope.svg")).toBeNull();
  });

  it("unknown methods and tools return JSON-RPC errors, not crashes", () => {
    const method = handleClaudeDesignRpc({ id: 1, method: "resources/list" }).body as any;
    expect(method.error.code).toBe(-32601);
    const tool = handleClaudeDesignRpc({ id: 2, method: "tools/call", params: { name: "delete_everything" } }).body as any;
    expect(tool.error.code).toBe(-32602);
  });
});

describe("Image Generation Agent — Anthropic-First creative path", () => {
  async function contextFor(astra: Astra, connectors?: ConnectorRegistry) {
    const id = await astra.createCampaign(
      { objective: "Launch cordless platform", owner: human.id, markets: ["DE"], budget: 500_000, currency: "EUR", kpis: ["Leads"] },
      human,
    );
    const obj = (await astra.repo.load(id))!;
    return {
      campaignId: id,
      campaign: obj,
      gateway: astra.gateway,
      fabric: astra.fabric,
      ...(connectors ? { connectors, grantedScopes: [CLAUDE_DESIGN_SCOPE] } : {}),
    };
  }

  it("falls back to the built-in renderer when Claude Design is not connected", async () => {
    const astra = new Astra({ persistence: "memory", clock: fixedClock("2026-01-01T00:00:00Z"), campaignTokenBudget: 0 });
    const proposal = await imageAgent.propose(await contextFor(astra));
    expect(proposal.body.imageUrl).toBe("/assets/hero-jobsite-sunrise.svg");
    expect(proposal.body.generatedVia).toBe("built-in renderer");
  });

  it("creates the hero via the governed create_design call when connected — and audits it", async () => {
    const astra = new Astra({ persistence: "memory", clock: fixedClock("2026-01-01T00:00:00Z"), campaignTokenBudget: 0 });
    const audits: string[] = [];
    const registry = new ConnectorRegistry(async (_id, r) => {
      audits.push(`${r.connector}.${r.tool}`);
    });
    const cd = new ClaudeDesignConnector(loopbackFetch);
    await cd.configure({ endpoint: "http://localhost:4000/mcp/claude-design", token: "demo-local" });
    registry.register(cd);

    const proposal = await imageAgent.propose(await contextFor(astra, registry));
    expect(String(proposal.body.imageUrl)).toMatch(/^\/assets\/design-[a-z0-9]+\.svg$/);
    expect(proposal.body.generatedVia).toBe("Claude Design");
    expect(proposal.rationale).toContain("Claude Design");
    expect(audits).toContain("claude-design.create_design");
    // The URL resolves to real artwork.
    const file = String(proposal.body.imageUrl).replace("/assets/", "");
    expect(assetSvg(file)).toContain("<svg");
  });

  it("keeps the fallback when the scope is not granted (governance holds)", async () => {
    const astra = new Astra({ persistence: "memory", clock: fixedClock("2026-01-01T00:00:00Z"), campaignTokenBudget: 0 });
    const registry = new ConnectorRegistry(async () => {});
    const cd = new ClaudeDesignConnector(loopbackFetch);
    await cd.configure({ endpoint: "http://localhost:4000/mcp/claude-design", token: "demo-local" });
    registry.register(cd);
    const ctx = { ...(await contextFor(astra, registry)), grantedScopes: [] };
    const proposal = await imageAgent.propose(ctx);
    expect(proposal.body.imageUrl).toBe("/assets/hero-jobsite-sunrise.svg");
    expect(proposal.body.generatedVia).toBe("built-in renderer");
  });
});
