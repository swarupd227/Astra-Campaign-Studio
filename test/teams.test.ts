import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TeamsConnector, verifyTeamsSignature } from "../src/integrations/teams";
import { ConnectorRegistry } from "../src/integrations/mcp";
import { NotificationService, TeamsIntakeBridge } from "../src/experience/notifications";
import { IntakeInterview, type CreateCampaignInput } from "../src/experience/intakeInterview";
import { ModelGateway } from "../src/gateway/modelGateway";

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => "1",
    json: async () => ({}),
  } as unknown as Response;
}

describe("Teams connector — token-optional", () => {
  it("records in-app when no webhook is configured", async () => {
    const teams = new TeamsConnector();
    expect(teams.status().mode).toBe("in-app");
    const { result, summary } = await teams.execute("post_notification", { title: "T", body: "B" });
    expect((result as { delivered: boolean }).delivered).toBe(false);
    expect(summary).toContain("in-app");
  });

  it("posts an Adaptive Card to the webhook when configured", async () => {
    const calls: { url: string; body: string }[] = [];
    const teams = new TeamsConnector((async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return okResponse();
    }) as typeof fetch);
    teams.configure({ webhookUrl: "https://example.webhook.office.com/hook/abc" });
    expect(teams.status().mode).toBe("live");

    const { result } = await teams.execute("post_notification", { title: "Stage advanced", body: "Details" });
    expect((result as { delivered: boolean }).delivered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain("AdaptiveCard");
    expect(calls[0]!.body).toContain("Stage advanced");
  });
});

describe("Teams outgoing-webhook signature (spec §13)", () => {
  const secret = Buffer.from("shared-secret-value").toString("base64");
  const body = JSON.stringify({ text: "new campaign" });
  const sig = createHmac("sha256", Buffer.from(secret, "base64")).update(body, "utf8").digest("base64");

  it("accepts a valid HMAC and rejects tampered bodies", () => {
    expect(verifyTeamsSignature(body, `HMAC ${sig}`, secret)).toBe(true);
    expect(verifyTeamsSignature(body + " ", `HMAC ${sig}`, secret)).toBe(false);
    expect(verifyTeamsSignature(body, `HMAC ${Buffer.from("wrong-signature-value-here12").toString("base64")}`, secret)).toBe(false);
    expect(verifyTeamsSignature(body, undefined, secret)).toBe(false);
  });
});

describe("NotificationService — notifications with a budget (spec §8.4)", () => {
  function harness() {
    const audits: string[] = [];
    const registry = new ConnectorRegistry(async (_c, record) => {
      audits.push(`${record.connector}.${record.tool}: ${record.summary}`);
    });
    registry.register(new TeamsConnector(), 1000);
    let nowMs = Date.parse("2026-07-06T10:00:00Z");
    const notifier = new NotificationService(registry, () => new Date(nowMs).toISOString());
    return { notifier, audits, tick: (ms: number) => (nowMs += ms) };
  }

  it("records to the feed and audits the governed connector call", async () => {
    const { notifier, audits } = harness();
    await notifier.notify("c1", "created", "New campaign created", "Details.");
    expect(notifier.list()).toHaveLength(1);
    expect(notifier.list()[0]!.delivered).toBe(false); // in-app mode
    expect(audits[0]).toContain("teams.post_notification");
  });

  it("coalesces identical consecutive notifications", async () => {
    const { notifier, tick } = harness();
    await notifier.notify("c1", "review", "3 items awaiting review", "Intake.");
    tick(1000);
    await notifier.notify("c1", "review", "3 items awaiting review", "Intake."); // duplicate burst
    expect(notifier.list()).toHaveLength(1);
  });

  it("caps sends per campaign per minute, then recovers", async () => {
    const { notifier, tick } = harness();
    for (let i = 0; i < 8; i++) {
      await notifier.notify("c1", "review", `Update ${i}`, "…");
      tick(1000);
    }
    expect(notifier.list()).toHaveLength(5); // budget
    tick(61_000);
    await notifier.notify("c1", "review", "After the window", "…");
    expect(notifier.list()[0]!.title).toBe("After the window");
  });

  it("priority kinds (go-live) bypass the budget — §8.4 'prioritised'", async () => {
    const { notifier, tick } = harness();
    for (let i = 0; i < 6; i++) {
      await notifier.notify("c1", "review", `Update ${i}`, "…");
      tick(1000);
    }
    expect(notifier.list()).toHaveLength(5); // routine kinds capped
    await notifier.notify("c1", "golive", "Campaign is live", "…");
    expect(notifier.list()[0]!.title).toBe("Campaign is live"); // still delivered
  });
});

describe("Teams intake bridge — brief interview from a channel (spec §6.0)", () => {
  function harness() {
    const created: { input: CreateCampaignInput; requester: string }[] = [];
    const interview = new IntakeInterview(new ModelGateway({ defaultModel: "claude-opus-4-8", campaignTokenBudget: 0 }));
    const bridge = new TeamsIntakeBridge(interview, async (input, requester) => {
      created.push({ input, requester });
      return "camp_teams1";
    });
    return { bridge, created };
  }

  it("greets, interviews, and creates the campaign on confirmation", async () => {
    const { bridge, created } = harness();
    const conversation = { id: "19:channel-thread" };
    const from = { name: "Dana" };

    const hello = await bridge.handle({ text: "<at>Astra</at> hi", from, conversation });
    expect(hello.text).toContain("trying to achieve");

    const rich = await bridge.handle({ text: "Launch the TE 60 in DACH with a €300k budget", from, conversation });
    expect(rich.text).toContain("success metric"); // skipped markets + budget

    await bridge.handle({ text: "demo requests", from, conversation });
    const summary = await bridge.handle({ text: "none", from, conversation });
    expect(summary.text).toContain("Shall I create the campaign?");

    const done = await bridge.handle({ text: "yes", from, conversation });
    expect(done.text).toContain("camp_teams1");
    expect(created[0]!.requester).toBe("Dana");
    expect(created[0]!.input.budget).toBe(300_000);
    expect(created[0]!.input.markets.sort()).toEqual(["AT", "CH", "DE"]);
  });

  it("keeps separate conversations on separate interview sessions", async () => {
    const { bridge } = harness();
    await bridge.handle({ text: "hi", from: { name: "A" }, conversation: { id: "conv-a" } });
    const a = await bridge.handle({ text: "Launch X in DACH, €200k, optimise for leads", from: { name: "A" }, conversation: { id: "conv-a" } });
    const b = await bridge.handle({ text: "hello", from: { name: "B" }, conversation: { id: "conv-b" } });
    expect(a.text).toContain("mandatory claims"); // conversation A is far along
    expect(b.text).toContain("trying to achieve"); // conversation B starts fresh
  });
});
