import { describe, expect, it } from "vitest";
import { Astra } from "../src/app";
import { fixedClock } from "../src/domain/ids";
import type { Actor } from "../src/domain/types";
import { audienceAgent } from "../src/agents/planning";
import { SfmcDataConnector, SFMC_DATA_SCOPES } from "../src/integrations/sfmcData";
import { ConnectorRegistry, GovernanceError } from "../src/integrations/mcp";

const human: Actor = { kind: "human", id: "u1", displayName: "Tester" };

function newAstra() {
  return new Astra({ persistence: "memory", clock: fixedClock("2026-01-01T00:00:00Z"), campaignTokenBudget: 0 });
}

describe("SFMC Data Extension connector — read, MVP-1 (spec §6.1)", () => {
  it("serves the deterministic local Data Extension by default", async () => {
    const sfmc = new SfmcDataConnector();
    expect(sfmc.status().mode).toBe("mock");
    const { result } = await sfmc.execute("read_data_extension", { key: "Audience_Segments" });
    const de = result as { rows: { segment: string; contacts: number }[]; source: string };
    expect(de.source).toBe("local-mock");
    expect(de.rows.length).toBeGreaterThanOrEqual(4);
    expect(de.rows[0]!.contacts).toBeGreaterThan(0);
  });

  it("is governed: the read scope is required and calls are audited", async () => {
    const audits: string[] = [];
    const registry = new ConnectorRegistry(async (_id, r) => {
      audits.push(`${r.connector}.${r.tool}`);
    });
    const sfmc = new SfmcDataConnector();
    registry.register(sfmc);

    await expect(
      registry.invoke("sfmc-data", "read_data_extension", {}, { campaignId: "c1", actor: human, grantedScopes: [] }),
    ).rejects.toBeInstanceOf(GovernanceError);

    await registry.invoke("sfmc-data", "read_data_extension", {}, {
      campaignId: "c1",
      actor: human,
      grantedScopes: [SFMC_DATA_SCOPES.read],
    });
    expect(audits).toEqual(["sfmc-data.read_data_extension"]);
  });

  it("live mode authenticates and parses the SFMC rowset (masked status)", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = (async (url: any, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes("auth.marketingcloudapis.com")) {
        expect(JSON.parse(String(init?.body)).grant_type).toBe("client_credentials");
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({ access_token: "tok_live", expires_in: 3600 }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          items: [
            { values: { segment: "General contractors", market: "DACH", contacts: "1000", consentedshare: "0.9", lastengagementrate: "0.2" } },
          ],
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const sfmc = new SfmcDataConnector(fakeFetch);
    sfmc.configure({ subdomain: "mc123", clientId: "client_abcd", clientSecret: "s3cret" });
    expect(sfmc.status()).toEqual({ mode: "live", subdomain: "mc123", clientIdHint: "••••abcd" });
    expect(JSON.stringify(sfmc.status())).not.toContain("s3cret");

    const { result } = await sfmc.execute("read_data_extension", { key: "Audience_Segments" });
    const de = result as { rows: { segment: string; contacts: number }[]; source: string };
    expect(de.source).toBe("sfmc-live");
    expect(de.rows).toEqual([
      { segment: "General contractors", market: "DACH", contacts: 1000, consentedShare: 0.9, lastEngagementRate: 0.2 },
    ]);
    expect(calls[0]).toContain("mc123.auth.marketingcloudapis.com/v2/token");
    expect(calls[1]).toContain("/data/v1/customobjectdata/key/Audience_Segments/rowset");
  });

  it("the Audience Agent sizes segments from the Data Extension (grounded planning)", async () => {
    const astra = newAstra();
    const id = await astra.createCampaign(
      { objective: "Launch cordless platform", owner: human.id, markets: ["DE", "US"], budget: 750_000, currency: "EUR", kpis: ["Leads"] },
      human,
    );
    const result = await astra.orchestrator.runAgent(id, audienceAgent);
    const body = result.artifact.body as {
      segments: { name: string; contacts: number; consentedReach: number; priority: number }[];
      sizedFrom: string;
    };
    expect(body.sizedFrom).toContain("SFMC Data Extension");
    // Aggregated across markets, largest first: General contractors 48,200 + 61,500.
    expect(body.segments[0]).toMatchObject({ name: "General contractors", contacts: 109_700, priority: 1 });
    expect(body.segments[0]!.consentedReach).toBeGreaterThan(0);
    expect(body.segments[0]!.consentedReach).toBeLessThan(body.segments[0]!.contacts);
    // The read is on the campaign's audit trail like every governed call.
    const events = await astra.store.read(id);
    expect(
      events.some((e) => e.body.type === "ConnectorInvoked" && e.body.connector === "sfmc-data"),
    ).toBe(true);
  });
});
