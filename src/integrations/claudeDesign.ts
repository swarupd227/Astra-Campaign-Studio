import type { Connector, McpTool } from "./mcp";
import { McpHttpClient, type McpRemoteTool } from "./mcpHttpClient";

export const CLAUDE_DESIGN_DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/design/mcp";
export const CLAUDE_DESIGN_SCOPE = "claude-design:use";

export interface ClaudeDesignConfig {
  endpoint: string;
  /** Bearer token for the MCP server (in-memory only, never persisted). */
  token: string;
}

export interface ClaudeDesignStatus {
  configured: boolean;
  endpoint: string;
  tokenHint: string | null;
  serverName: string | null;
  tools: string[];
}

/**
 * Claude Design connector (Anthropic Labs) — an MCP-over-HTTP client behind the
 * same governed Connector contract as every other integration (spec §10.1).
 * Anthropic-First extended to the creative layer: Claude Design turns briefs into
 * on-brand designs/prototypes and exposes its capabilities as MCP tools, which we
 * discover at connect time (tools/list) and expose through the governed registry.
 *
 * Token-optional: unconfigured, the connector reports "not connected" and the
 * creative agents keep their default path. Every call remains scope-checked,
 * rate-limited and audited by the registry.
 */
export class ClaudeDesignConnector implements Connector {
  readonly name = "claude-design";
  /** Populated from the server's tools/list at connect time. */
  tools: McpTool[] = [];

  private client?: McpHttpClient;
  private config?: ClaudeDesignConfig;
  private serverName: string | null = null;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Connect (endpoint + token) or disconnect (null). Discovers remote tools. */
  async configure(cfg: ClaudeDesignConfig | null): Promise<ClaudeDesignStatus> {
    if (!cfg || !cfg.token.trim()) {
      this.client = undefined;
      this.config = undefined;
      this.serverName = null;
      this.tools = [];
      return this.status();
    }
    const endpoint = cfg.endpoint.trim() || CLAUDE_DESIGN_DEFAULT_ENDPOINT;
    const client = new McpHttpClient(endpoint, cfg.token.trim(), this.fetchImpl);
    const { serverName, tools } = await client.connect(); // throws on auth/network failure
    this.client = client;
    this.config = { endpoint, token: cfg.token.trim() };
    this.serverName = serverName;
    this.tools = tools.map((t: McpRemoteTool) => ({
      name: t.name,
      description: t.description ?? "Claude Design tool",
      scopes: [CLAUDE_DESIGN_SCOPE],
      // External mutation by default: creating/updating designs is reversible but real.
      effect: "write",
    }));
    return this.status();
  }

  status(): ClaudeDesignStatus {
    return {
      configured: Boolean(this.client),
      endpoint: this.config?.endpoint ?? CLAUDE_DESIGN_DEFAULT_ENDPOINT,
      tokenHint: this.config ? `••••${this.config.token.slice(-4)}` : null,
      serverName: this.serverName,
      tools: this.tools.map((t) => t.name),
    };
  }

  async execute(tool: string, input: unknown): Promise<{ result: unknown; summary: string }> {
    if (!this.client) {
      throw new Error("Claude Design is not connected — configure it in Admin settings first.");
    }
    const result = await this.client.callTool(tool, input);
    return { result, summary: `Claude Design · ${tool.replace(/_/g, " ")}` };
  }
}
