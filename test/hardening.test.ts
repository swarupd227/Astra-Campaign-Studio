import { describe, expect, it } from "vitest";
import { BodySchemas, firstIssue, RateLimiter } from "../src/experience/schemas";
import { EVENT_SCHEMA_VERSION, eventVersion, type CampaignEvent } from "../src/domain/events";
import { InMemoryEventStore } from "../src/store/eventStore";
import { Stage, type Actor } from "../src/domain/types";

const actor: Actor = { kind: "system", id: "t", displayName: "Test" };

describe("event-log schema versioning (§11.2)", () => {
  it("stamps every new event with the current schema version", async () => {
    const store = new InMemoryEventStore(() => "2026-01-01T00:00:00Z");
    const e = await store.append(
      "c1",
      { type: "StageGateBlocked", stage: Stage.Intake, reason: "test" },
      actor,
      -1,
    );
    expect(e.v).toBe(EVENT_SCHEMA_VERSION);
    expect(eventVersion(e)).toBe(EVENT_SCHEMA_VERSION);
  });

  it("legacy events without a version fold as v1 (replayable forever)", () => {
    const legacy = {
      seq: 1,
      campaignId: "c1",
      at: "2025-01-01T00:00:00Z",
      actor,
      body: { type: "StageGateBlocked", stage: Stage.Intake, reason: "old" },
    } as CampaignEvent;
    expect(legacy.v).toBeUndefined();
    expect(eventVersion(legacy)).toBe(1);
  });
});

describe("API request validation (§14 hardening)", () => {
  it("rejects malformed bodies with a readable message", () => {
    const bad = BodySchemas.approve.safeParse({ artifactId: 42 });
    expect(bad.success).toBe(false);
    expect(firstIssue(bad.error!)).toContain("artifactId");

    const missing = BodySchemas.mention.safeParse({ artifactId: "a1", toRole: "legal" });
    expect(missing.success).toBe(false);
    expect(firstIssue(missing.error!)).toContain("message");
  });

  it("accepts the shapes the UI actually sends", () => {
    expect(BodySchemas.approve.safeParse({ artifactId: "art_1", note: "ok" }).success).toBe(true);
    expect(BodySchemas.createCampaign.safeParse({ objective: "Launch X", markets: "DE, US", budget: "500000" }).success).toBe(true);
    expect(BodySchemas.command.safeParse({ text: "run stage" }).success).toBe(true);
    expect(BodySchemas.teams.safeParse({}).success).toBe(true); // clearing is a valid call
    expect(BodySchemas.inboundEmail.safeParse({ from: "Maren", body: "Launch the DD 350" }).success).toBe(true);
  });

  it("bounds oversized payloads", () => {
    expect(BodySchemas.command.safeParse({ text: "x".repeat(3_000) }).success).toBe(false);
    expect(BodySchemas.mention.safeParse({ artifactId: "a", toRole: "legal", message: "x".repeat(3_000) }).success).toBe(false);
  });
});

describe("inbound rate limiter (§14)", () => {
  it("allows up to the limit within a window, then rejects", () => {
    const limiter = new RateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(limiter.allow("ip1", t0)).toBe(true);
    expect(limiter.allow("ip1", t0 + 1)).toBe(true);
    expect(limiter.allow("ip1", t0 + 2)).toBe(true);
    expect(limiter.allow("ip1", t0 + 3)).toBe(false); // over budget
    expect(limiter.allow("ip2", t0 + 3)).toBe(true); // independent callers
  });

  it("resets after the window elapses", () => {
    const limiter = new RateLimiter(1, 60_000);
    const t0 = 1_000_000;
    expect(limiter.allow("ip1", t0)).toBe(true);
    expect(limiter.allow("ip1", t0 + 30_000)).toBe(false);
    expect(limiter.allow("ip1", t0 + 60_001)).toBe(true); // new window
  });
});
