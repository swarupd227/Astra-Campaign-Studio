import { createHmac, timingSafeEqual } from "node:crypto";
import type { Connector, McpTool } from "./mcp";

/**
 * Microsoft Teams connector (spec §10.2 — notifications, approvals, hand-offs; MVP-1).
 * Token-optional:
 *  - **unconfigured**: notifications are recorded in-app only (the feed still works,
 *    and every send is still a governed, audited connector call).
 *  - **configured** (workflow/incoming-webhook URL): also POSTs an Adaptive Card to
 *    the channel — the current Microsoft-recommended Workflows webhook format.
 */

export const TEAMS_SCOPES = { notify: "teams:notify" } as const;

export interface TeamsConfig {
  webhookUrl: string;
}

export interface TeamsStatus {
  mode: "in-app" | "live";
  webhookHint: string | null;
}

export interface TeamsNotification {
  title: string;
  body: string;
}

const TOOLS: McpTool[] = [
  {
    name: "post_notification",
    description: "Post a workflow notification to the configured Teams channel.",
    scopes: [TEAMS_SCOPES.notify],
    effect: "write",
  },
];

export class TeamsConnector implements Connector {
  readonly name = "teams";
  readonly tools = TOOLS;
  private webhookUrl?: string;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  configure(cfg: TeamsConfig | null): void {
    this.webhookUrl = cfg?.webhookUrl?.trim() || undefined;
  }

  status(): TeamsStatus {
    return {
      mode: this.webhookUrl ? "live" : "in-app",
      webhookHint: this.webhookUrl ? `…${this.webhookUrl.slice(-18)}` : null,
    };
  }

  async execute(tool: string, input: unknown): Promise<{ result: unknown; summary: string }> {
    if (tool !== "post_notification") throw new Error(`Teams connector has no tool ${tool}`);
    const { title, body } = input as TeamsNotification;

    if (!this.webhookUrl) {
      return {
        result: { delivered: false, channel: "in-app" },
        summary: `Notification recorded in-app: "${title}" (no Teams webhook configured).`,
      };
    }

    const res = await this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(adaptiveCard(title, body)),
    });
    if (!res.ok) {
      throw new Error(`Teams webhook ${res.status}: ${(await res.text()).slice(0, 160)}`);
    }
    return {
      result: { delivered: true, channel: "teams" },
      summary: `Posted "${title}" to the Teams channel.`,
    };
  }
}

/** Workflows-webhook payload: a message wrapping one Adaptive Card. */
function adaptiveCard(title: string, body: string): unknown {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: title, weight: "Bolder", wrap: true },
            { type: "TextBlock", text: body, wrap: true, spacing: "Small" },
          ],
        },
      },
    ],
  };
}

/**
 * Verify a Teams outgoing-webhook signature (spec §13 — authenticated entry points).
 * Teams signs the raw request body with HMAC-SHA256 using the base64-decoded shared
 * secret and sends `Authorization: HMAC <base64 digest>`.
 */
export function verifyTeamsSignature(rawBody: string, authHeader: string | undefined, secretB64: string): boolean {
  const provided = /^HMAC\s+(.+)$/i.exec(authHeader ?? "")?.[1];
  if (!provided) return false;
  const digest = createHmac("sha256", Buffer.from(secretB64, "base64"))
    .update(Buffer.from(rawBody, "utf8"))
    .digest();
  let given: Buffer;
  try {
    given = Buffer.from(provided, "base64");
  } catch {
    return false;
  }
  return given.length === digest.length && timingSafeEqual(given, digest);
}
