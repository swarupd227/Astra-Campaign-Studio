import type { Connector, McpTool } from "./mcp";

/**
 * Analytics connector (spec §10.2 — GA4 / Adobe Analytics; MVP-2). Serves the
 * performance data Stage 5 optimises against. The mock generates deterministic,
 * plausible per-channel metrics (seeded by campaign id + observation number), so
 * optimisation runs are reproducible offline; a live GA4/Adobe client slots in
 * behind `execute` exactly like the other token-optional connectors.
 */

export const ANALYTICS_SCOPES = { read: "analytics:read" } as const;

export interface ChannelMetrics {
  channel: string;
  impressions: number;
  clicks: number;
  ctr: number;
  spend: number;
  leads: number;
  cpl: number;
}

export interface PerformanceSnapshot {
  observation: number;
  channels: ChannelMetrics[];
}

const TOOLS: McpTool[] = [
  {
    name: "fetch_performance",
    description: "Fetch current per-channel performance for a campaign.",
    scopes: [ANALYTICS_SCOPES.read],
    effect: "read",
  },
];

/** Deterministic pseudo-random in [0,1) from a string seed. */
function seeded(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

export class AnalyticsConnector implements Connector {
  readonly name = "analytics";
  readonly tools = TOOLS;
  private readonly observations = new Map<string, number>();

  async execute(tool: string, input: unknown): Promise<{ result: unknown; summary: string }> {
    if (tool !== "fetch_performance") throw new Error(`Analytics connector has no tool ${tool}`);
    const { campaignId } = input as { campaignId: string };
    const n = (this.observations.get(campaignId) ?? 0) + 1;
    this.observations.set(campaignId, n);

    const channels = ["paid-social", "email", "landing-page"].map((channel) => {
      const r = (k: string) => seeded(`${campaignId}|${channel}|${n}|${k}`);
      const rc = (k: string) => seeded(`${campaignId}|${channel}|${k}`); // observation-independent
      const impressions = Math.round(40_000 + r("imp") * 60_000);
      // Paid social starts strong then fatigues; email holds steady — gives the
      // optimisation agents something real to react to. The channel's base CTR is
      // fixed per campaign and per-observation jitter is kept below the fatigue
      // step, so the decay trend is monotone and reproducible.
      const fatigue = channel === "paid-social" ? Math.max(0.5, 1 - n * 0.12) : 1;
      const base = 0.012 + rc("ctr-base") * 0.012;
      const jitter = (r("ctr-jitter") - 0.5) * 0.001;
      const ctr = Number(Math.max(0.002, base * fatigue + jitter).toFixed(4));
      const clicks = Math.round(impressions * ctr);
      const spend = Math.round(8_000 + r("spend") * 7_000);
      const leads = Math.max(1, Math.round(clicks * (0.06 + r("cvr") * 0.05)));
      return { channel, impressions, clicks, ctr, spend, leads, cpl: Math.round(spend / leads) };
    });

    const snapshot: PerformanceSnapshot = { observation: n, channels };
    const totalLeads = channels.reduce((a, c) => a + c.leads, 0);
    return {
      result: snapshot,
      summary: `Fetched performance snapshot #${n}: ${totalLeads} leads across ${channels.length} channels.`,
    };
  }
}
