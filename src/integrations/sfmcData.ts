import type { Connector, McpTool } from "./mcp";

/**
 * SFMC Data Extension connector — READ ONLY, MVP-1 (spec §4.2, §6.1, §11.2):
 * "SFMC Data Extensions are readable for planning grounding in MVP-1; write
 * access follows in MVP-2." Audience and campaign data ground the planning
 * agents so segment sizing comes from Hilti's actual marketing-cloud data,
 * not a model's guess.
 *
 * Token-optional like every connector: configured (subdomain + client id/secret)
 * it calls the real SFMC REST API; unconfigured it serves a deterministic local
 * Data Extension so everything runs offline. Reads are governed the same way —
 * scope-checked, rate-limited, audited, result-swept.
 */

export const SFMC_DATA_SCOPES = {
  read: "sfmc:data.read",
} as const;

export interface SfmcLiveConfig {
  /** Tenant subdomain (from your SFMC REST base URI). */
  subdomain: string;
  clientId: string;
  clientSecret: string;
}

export interface SfmcStatus {
  mode: "mock" | "live";
  subdomain: string | null;
  clientIdHint: string | null;
}

export interface DataExtensionRow {
  segment: string;
  market: string;
  contacts: number;
  consentedShare: number;
  lastEngagementRate: number;
}

export interface DataExtensionResult {
  key: string;
  name: string;
  rows: DataExtensionRow[];
  source: "sfmc-live" | "local-mock";
}

const TOOLS: McpTool[] = [
  {
    name: "read_data_extension",
    description: "Read rows from an SFMC Data Extension (audience segments, sizes, consent, engagement).",
    scopes: [SFMC_DATA_SCOPES.read],
    effect: "read",
  },
];

/**
 * The bundled Data Extension (mock mode): audience segments for the professional
 * tools market. Deterministic — same numbers every run, so plans and tests are
 * reproducible.
 */
const LOCAL_DE: Record<string, DataExtensionRow[]> = {
  Audience_Segments: [
    { segment: "General contractors", market: "DACH", contacts: 48_200, consentedShare: 0.82, lastEngagementRate: 0.24 },
    { segment: "General contractors", market: "US", contacts: 61_500, consentedShare: 0.77, lastEngagementRate: 0.21 },
    { segment: "Electrical & MEP", market: "DACH", contacts: 27_900, consentedShare: 0.85, lastEngagementRate: 0.27 },
    { segment: "Electrical & MEP", market: "US", contacts: 33_400, consentedShare: 0.74, lastEngagementRate: 0.19 },
    { segment: "Interior finishing", market: "DACH", contacts: 15_300, consentedShare: 0.8, lastEngagementRate: 0.17 },
  ],
};

export class SfmcDataConnector implements Connector {
  readonly name = "sfmc-data";
  readonly tools = TOOLS;
  private live?: SfmcLiveConfig;
  private accessToken?: { token: string; expiresAt: number };

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Enable live mode or revert to the local Data Extension (null). In-memory only. */
  configure(cfg: SfmcLiveConfig | null): void {
    this.live =
      cfg && cfg.subdomain.trim() && cfg.clientId.trim() && cfg.clientSecret.trim()
        ? { subdomain: cfg.subdomain.trim(), clientId: cfg.clientId.trim(), clientSecret: cfg.clientSecret.trim() }
        : undefined;
    this.accessToken = undefined;
  }

  status(): SfmcStatus {
    return {
      mode: this.live ? "live" : "mock",
      subdomain: this.live?.subdomain ?? null,
      clientIdHint: this.live ? `••••${this.live.clientId.slice(-4)}` : null,
    };
  }

  async execute(tool: string, input: unknown): Promise<{ result: unknown; summary: string }> {
    if (tool !== "read_data_extension") throw new Error(`SFMC data connector has no tool ${tool}`);
    const { key = "Audience_Segments" } = (input ?? {}) as { key?: string };
    const result = this.live ? await this.readLive(key) : this.readLocal(key);
    return {
      result,
      summary: `Read Data Extension "${result.name}" — ${result.rows.length} row(s) from ${
        result.source === "sfmc-live" ? "SFMC" : "the local dataset"
      }.`,
    };
  }

  private readLocal(key: string): DataExtensionResult {
    const rows = LOCAL_DE[key];
    if (!rows) throw new Error(`Unknown Data Extension: ${key}`);
    return { key, name: key.replace(/_/g, " "), rows: rows.map((r) => ({ ...r })), source: "local-mock" };
  }

  // ── live mode (SFMC REST API) ────────────────────────────────────────────────

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 30_000) return this.accessToken.token;
    const res = await this.fetchImpl(`https://${this.live!.subdomain}.auth.marketingcloudapis.com/v2/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.live!.clientId,
        client_secret: this.live!.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`SFMC auth ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async readLive(key: string): Promise<DataExtensionResult> {
    const token = await this.token();
    const res = await this.fetchImpl(
      `https://${this.live!.subdomain}.rest.marketingcloudapis.com/data/v1/customobjectdata/key/${encodeURIComponent(key)}/rowset`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`SFMC data ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { items?: { values?: Record<string, unknown> }[] };
    const rows: DataExtensionRow[] = (body.items ?? []).map((item) => {
      const v = item.values ?? {};
      return {
        segment: String(v.segment ?? v.Segment ?? "Unknown"),
        market: String(v.market ?? v.Market ?? "—"),
        contacts: Number(v.contacts ?? v.Contacts ?? 0),
        consentedShare: Number(v.consentedshare ?? v.ConsentedShare ?? 0),
        lastEngagementRate: Number(v.lastengagementrate ?? v.LastEngagementRate ?? 0),
      };
    });
    return { key, name: key.replace(/_/g, " "), rows, source: "sfmc-live" };
  }
}
