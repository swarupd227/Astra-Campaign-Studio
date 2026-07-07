import type { Connector, McpTool } from "./mcp";

/**
 * MVP-2 publishing stack (spec §10.2): Contentful, DAM, SFMC, ad networks and
 * Jira as governed connectors. These are high-fidelity mocks behind the same
 * Connector contract as Figma/Teams — the live APIs slot in behind `execute`
 * exactly like Figma's live mode did (token-optional seam, one class each).
 *
 * The governance is real either way: publish/send/launch tools are marked
 * `irreversible`, so the registry refuses them without an explicit human
 * go-live approval (spec §6.4 — "the platform never sends or publishes without
 * a human go-live approval and a passing consent check").
 */

function tool(name: string, description: string, scope: string, effect: McpTool["effect"]): McpTool {
  return { name, description, scopes: [scope], effect };
}

/** A tiny in-memory ledger so demos/tests can inspect what "went live". */
export interface PublishRecord {
  system: string;
  tool: string;
  detail: string;
}

abstract class MockPublisher implements Connector {
  abstract readonly name: string;
  abstract readonly tools: McpTool[];
  readonly ledger: PublishRecord[] = [];

  async execute(toolName: string, input: unknown): Promise<{ result: unknown; summary: string }> {
    const t = this.tools.find((x) => x.name === toolName);
    if (!t) throw new Error(`${this.name} connector has no tool ${toolName}`);
    const detail = summarise(input);
    this.ledger.push({ system: this.name, tool: toolName, detail });
    return {
      result: { ok: true, system: this.name, tool: toolName },
      summary: `${cap(this.name)}: ${toolName.replace(/_/g, " ")} — ${detail}`,
    };
  }
}

export class ContentfulConnector extends MockPublisher {
  readonly name = "contentful";
  readonly tools = [
    tool("stage_entry", "Stage a page/module entry for publishing.", "contentful:write", "write"),
    tool("publish_entry", "Publish an entry to the live CMS.", "contentful:publish", "irreversible"),
  ];
}

export class DamConnector extends MockPublisher {
  readonly name = "dam";
  readonly tools = [
    tool("upload_asset", "File a final asset with taxonomy and rights metadata.", "dam:write", "write"),
  ];
}

export class SfmcConnector extends MockPublisher {
  readonly name = "sfmc";
  readonly tools = [
    tool("configure_journey", "Configure a journey, audience and send windows.", "sfmc:write", "write"),
    tool("activate_journey", "Activate the journey — customer sends begin.", "sfmc:send", "irreversible"),
  ];
}

export class AdNetworkConnector extends MockPublisher {
  readonly name = "ads";
  readonly tools = [
    tool("upload_creative", "Upload creatives to Google/Meta/LinkedIn.", "ads:write", "write"),
    tool("launch_campaign", "Launch paid delivery — spend begins.", "ads:launch", "irreversible"),
  ];
}

export class JiraConnector extends MockPublisher {
  readonly name = "jira";
  readonly tools = [
    tool("create_release_ticket", "Track the launch in the release board.", "jira:write", "write"),
  ];
}

/** Every scope the go-live executor needs, in one place. */
export const PUBLISHING_SCOPES = [
  "contentful:write",
  "contentful:publish",
  "dam:write",
  "sfmc:write",
  "sfmc:send",
  "ads:write",
  "ads:launch",
  "jira:write",
];

function summarise(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const bits = ["title", "channel", "market", "name", "audience"]
      .filter((k) => typeof o[k] === "string")
      .map((k) => String(o[k]));
    if (bits.length) return bits.join(" · ");
  }
  return "payload accepted";
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
