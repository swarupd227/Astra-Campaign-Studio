import { describe, expect, it } from "vitest";
import { BodySchemas, firstIssue, RateLimiter } from "../src/experience/schemas";

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
