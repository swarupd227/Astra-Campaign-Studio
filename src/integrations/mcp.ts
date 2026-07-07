/**
 * MCP-first integration layer (spec §10.1). Every external system is exposed to
 * agents as a governed set of Model Context Protocol tools with scoped
 * permissions, rate limits and an audit hook — an agent can act in Figma or SFMC
 * only within what policy allows, and every such action is recorded.
 */
import { mergeHits, sweepValue, totalHits } from "../security/contentSafety";

export type ToolEffect = "read" | "write" | "irreversible";

export interface McpTool {
  name: string;
  description: string;
  /** Permission scopes this tool requires (e.g. "figma:board.write"). */
  scopes: string[];
  /** read = safe; write = external mutation (audited); irreversible = publish/send/spend. */
  effect: ToolEffect;
}

export interface Connector {
  readonly name: string;
  readonly tools: McpTool[];
  /** Execute a tool. The registry — not the connector — enforces governance. */
  execute(tool: string, input: unknown): Promise<{ result: unknown; summary: string }>;
}

export interface InvokeOptions {
  campaignId: string;
  actor: { kind: "human" | "agent" | "system"; id: string; displayName: string };
  /** Scopes granted to this actor (least-privilege by default, spec §13). */
  grantedScopes: string[];
  /**
   * Explicit human approval token. Required for irreversible effects
   * (publish/send/spend) — a governance non-negotiable (spec §6.4, §10.1).
   */
  approved?: boolean;
}

/** A sink the registry calls to record each invocation in the campaign audit trail. */
export type ConnectorAuditSink = (
  campaignId: string,
  record: { connector: string; tool: string; effect: ToolEffect; summary: string },
) => Promise<void>;

export class GovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernanceError";
  }
}

export class RateLimitError extends Error {
  constructor(connector: string, tool: string) {
    super(`Rate limit exceeded for ${connector}.${tool}`);
    this.name = "RateLimitError";
  }
}

interface ConnectorRegistration {
  connector: Connector;
  /** Max calls per connector per campaign within this process (simple governor). */
  rateLimitPerCampaign: number;
}

/**
 * The governed connector registry. Agents never call a connector directly; they
 * call the registry, which checks scopes, enforces the external-write/irreversible
 * approval rule, applies a rate limit, executes, sweeps the result for
 * instruction-like content (spec §13 — external content is data, never
 * directives), and audits — so governance is structural, exactly like the model
 * gateway for reasoning.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, ConnectorRegistration>();
  private readonly callCounts = new Map<string, number>();
  /** Trust & safety counters: neutralised content in connector results (§14.1). */
  private safetyHits: Record<string, number> = {};

  constructor(private readonly audit: ConnectorAuditSink) {}

  register(connector: Connector, rateLimitPerCampaign = 100): void {
    this.connectors.set(connector.name, { connector, rateLimitPerCampaign });
  }

  get(name: string): Connector | undefined {
    return this.connectors.get(name)?.connector;
  }

  /** Non-secret summary of registered connectors and their governed tools (Admin console). */
  describe(): { name: string; tools: { name: string; effect: ToolEffect; scopes: string[] }[] }[] {
    return [...this.connectors.values()].map((reg) => ({
      name: reg.connector.name,
      tools: reg.connector.tools.map((t) => ({ name: t.name, effect: t.effect, scopes: t.scopes })),
    }));
  }

  async invoke(
    connectorName: string,
    toolName: string,
    input: unknown,
    opts: InvokeOptions,
  ): Promise<unknown> {
    const reg = this.connectors.get(connectorName);
    if (!reg) throw new GovernanceError(`Unknown connector: ${connectorName}`);
    const tool = reg.connector.tools.find((t) => t.name === toolName);
    if (!tool) throw new GovernanceError(`Connector ${connectorName} has no tool ${toolName}`);

    // 1. Scope check — least privilege (spec §13).
    const missing = tool.scopes.filter((s) => !opts.grantedScopes.includes(s));
    if (missing.length > 0) {
      throw new GovernanceError(
        `Missing scopes for ${connectorName}.${toolName}: ${missing.join(", ")}`,
      );
    }

    // 2. Irreversible actions require explicit human approval (spec §6.4/§10.1).
    if (tool.effect === "irreversible" && !opts.approved) {
      throw new GovernanceError(
        `${connectorName}.${toolName} is irreversible (publish/send/spend) and requires explicit human approval.`,
      );
    }

    // 3. Rate limit per connector per campaign.
    const key = `${opts.campaignId}:${connectorName}`;
    const count = (this.callCounts.get(key) ?? 0) + 1;
    if (count > reg.rateLimitPerCampaign) throw new RateLimitError(connectorName, toolName);
    this.callCounts.set(key, count);

    // 4. Execute, then sweep the result: anything an external system returns is
    // data — instruction-like content is neutralised before agents can read it.
    const { result, summary } = await reg.connector.execute(toolName, input);
    const swept = sweepValue(result);
    const flagged = totalHits(swept.hits);
    if (flagged > 0) this.safetyHits = mergeHits(this.safetyHits, swept.hits);

    await this.audit(opts.campaignId, {
      connector: connectorName,
      tool: toolName,
      effect: tool.effect,
      summary: flagged > 0 ? `${summary} · guardrail: ${flagged} instruction-like fragment(s) neutralised` : summary,
    });
    return swept.value;
  }

  /** Trust & safety counters for connector results (spec §14.1). */
  safety(): Record<string, number> {
    return { ...this.safetyHits };
  }
}
