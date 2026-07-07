import { describe, expect, it } from "vitest";
import { FigmaConnector } from "../src/integrations/figma";
import { ClaudeDesignConnector } from "../src/integrations/claudeDesign";
import { McpHttpClient } from "../src/integrations/mcpHttpClient";
import { ConnectorRegistry, GovernanceError } from "../src/integrations/mcp";
import type { Actor } from "../src/domain/types";

const human: Actor = { kind: "human", id: "u1", displayName: "Tester" };

/** Minimal Response stand-in for the injected fetch. */
function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  const all: Record<string, string> = { "content-type": "application/json", ...headers };
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (k: string) => all[k.toLowerCase()] ?? all[k] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

// ── Figma live mode ────────────────────────────────────────────────────────────

/** A fake Figma file: two named placeholder frames, one with designer text. */
const FIGMA_FILE = {
  version: "42",
  document: {
    name: "Page 1",
    children: [
      {
        name: "paid-headline",
        type: "FRAME",
        children: [{ type: "TEXT", characters: "Zero downtime. Total control." }],
      },
      { name: "hero-image", type: "FRAME", children: [] },
      { name: "unrelated-frame", type: "FRAME", children: [{ type: "TEXT", characters: "ignore me" }] },
    ],
  },
};

function fakeFigmaFetch(calls: { url: string; init?: RequestInit }[]): typeof fetch {
  return (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/comments")) return jsonResponse({ id: "c1" });
    return jsonResponse(FIGMA_FILE);
  }) as typeof fetch;
}

describe("Figma connector — token-optional live mode", () => {
  it("defaults to mock and reports live once configured (masked token)", () => {
    const figma = new FigmaConnector(fakeFigmaFetch([]));
    expect(figma.status().mode).toBe("mock");
    figma.configure({ token: "figd_secret_9876", fileKey: "FILE123" });
    const s = figma.status();
    expect(s.mode).toBe("live");
    expect(s.fileKey).toBe("FILE123");
    expect(s.tokenHint).toBe("••••9876");
    expect(JSON.stringify(s)).not.toContain("secret");
    figma.configure(null);
    expect(figma.status().mode).toBe("mock");
  });

  it("read_board pulls named frames and their text from the real file", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const figma = new FigmaConnector(fakeFigmaFetch(calls));
    figma.configure({ token: "figd_t", fileKey: "FILE123" });
    const { result } = await figma.execute("read_board", { boardId: "b1" });
    const board = result as { frames: Record<string, string>; version: number };
    expect(board.frames["paid-headline"]).toBe("Zero downtime. Total control.");
    expect(board.frames["hero-image"]).toBe(""); // empty frame stays a placeholder
    expect(board.frames["unrelated-frame"]).toBeUndefined(); // only the contract frames
    expect(board.version).toBe(42);
    expect(calls[0]!.url).toContain("/v1/files/FILE123");
    expect((calls[0]!.init?.headers as Record<string, string>)["X-Figma-Token"]).toBe("figd_t");
  });

  it("map_content posts each mapping as a comment on the file (REST is read-only for canvas)", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const figma = new FigmaConnector(fakeFigmaFetch(calls));
    figma.configure({ token: "figd_t", fileKey: "FILE123" });
    const { summary } = await figma.execute("map_content", {
      boardId: "b1",
      mappings: { "email-subject": "Meet the platform that never quits" },
    });
    const commentCalls = calls.filter((c) => c.url.includes("/comments"));
    expect(commentCalls).toHaveLength(1);
    expect(String(commentCalls[0]!.init?.body)).toContain("email-subject");
    expect(summary).toContain("comments");
  });

  it("simulateDesignerEdit is refused in live mode (edits happen in Figma)", () => {
    const figma = new FigmaConnector(fakeFigmaFetch([]));
    figma.configure({ token: "figd_t", fileKey: "FILE123" });
    expect(() => figma.simulateDesignerEdit("b1", "paid-headline", "x")).toThrow(/edit the frame in Figma/i);
  });
});

// ── MCP-over-HTTP client + Claude Design ─────────────────────────────────────

function fakeMcpFetch(calls: { body: any; headers: Record<string, string> }[]): typeof fetch {
  return (async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (body.method === "initialize") {
      return jsonResponse(
        { jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "claude-design" }, protocolVersion: "2025-06-18" } },
        { "mcp-session-id": "sess-1" },
      );
    }
    if (body.method === "notifications/initialized") return jsonResponse({});
    if (body.method === "tools/list") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "create_design", description: "Create a design from a brief" }, { name: "edit_design" }] },
      });
    }
    if (body.method === "tools/call") {
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "design_url: https://claude.ai/design/d1" }] } });
    }
    return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown method" } });
  }) as typeof fetch;
}

describe("MCP-over-HTTP client", () => {
  it("initialises, adopts the session id, and lists tools", async () => {
    const calls: { body: any; headers: Record<string, string> }[] = [];
    const client = new McpHttpClient("https://api.anthropic.com/v1/design/mcp", "tok_123", fakeMcpFetch(calls));
    const { serverName, tools } = await client.connect();
    expect(serverName).toBe("claude-design");
    expect(tools.map((t) => t.name)).toEqual(["create_design", "edit_design"]);
    // Session id from initialize is echoed on subsequent requests; bearer token sent.
    const listCall = calls.find((c) => c.body.method === "tools/list")!;
    expect(listCall.headers["mcp-session-id"]).toBe("sess-1");
    expect(listCall.headers["authorization"]).toBe("Bearer tok_123");
  });
});

describe("Claude Design connector (governed MCP integration)", () => {
  it("is not configured by default and refuses calls with a clear message", async () => {
    const cd = new ClaudeDesignConnector(fakeMcpFetch([]));
    expect(cd.status().configured).toBe(false);
    await expect(cd.execute("create_design", {})).rejects.toThrow(/not connected/i);
  });

  it("discovers remote tools at connect time and exposes them as governed tools", async () => {
    const cd = new ClaudeDesignConnector(fakeMcpFetch([]));
    const status = await cd.configure({ endpoint: "", token: "tok_abcd" });
    expect(status.configured).toBe(true);
    expect(status.tools).toEqual(["create_design", "edit_design"]);
    expect(status.tokenHint).toBe("••••abcd");
    expect(cd.tools.every((t) => t.effect === "write" && t.scopes.includes("claude-design:use"))).toBe(true);
  });

  it("registry governance applies: scope required, calls audited", async () => {
    const audits: { connector: string; tool: string }[] = [];
    const registry = new ConnectorRegistry(async (_id, record) => {
      audits.push({ connector: record.connector, tool: record.tool });
    });
    const cd = new ClaudeDesignConnector(fakeMcpFetch([]));
    await cd.configure({ endpoint: "", token: "tok_abcd" });
    registry.register(cd);

    // Missing scope → denied by the registry, not the connector.
    await expect(
      registry.invoke("claude-design", "create_design", { brief: "hero" }, { campaignId: "c1", actor: human, grantedScopes: [] }),
    ).rejects.toBeInstanceOf(GovernanceError);

    // With the scope → executes and is audited.
    const result = await registry.invoke("claude-design", "create_design", { brief: "hero" }, {
      campaignId: "c1",
      actor: human,
      grantedScopes: ["claude-design:use"],
    });
    expect(JSON.stringify(result)).toContain("design/d1");
    expect(audits).toEqual([{ connector: "claude-design", tool: "create_design" }]);
  });

  it("disconnect clears tools and status", async () => {
    const cd = new ClaudeDesignConnector(fakeMcpFetch([]));
    await cd.configure({ endpoint: "", token: "tok_abcd" });
    await cd.configure(null);
    expect(cd.status().configured).toBe(false);
    expect(cd.tools).toHaveLength(0);
  });
});
