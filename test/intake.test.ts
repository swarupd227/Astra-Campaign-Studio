import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/gateway/modelGateway";
import { IntakeInterview, type CreateCampaignInput } from "../src/experience/intakeInterview";
import { parseBudget, parseMarkets, parseSuccessMetric } from "../src/domain/intakeParsing";

function gateway() {
  return new ModelGateway({ defaultModel: "claude-opus-4-8", campaignTokenBudget: 0 });
}

describe("intake field parsing", () => {
  it("parses region groups, country names and codes into markets", () => {
    expect(parseMarkets("Launch across DACH and the US", false).sort()).toEqual(["AT", "CH", "DE", "US"]);
    expect(parseMarkets("germany and france please", false).sort()).toEqual(["DE", "FR"]);
    expect(parseMarkets("de, at, ch", true).sort()).toEqual(["AT", "CH", "DE"]);
    expect(parseMarkets("let us discuss it", false)).toEqual([]); // lowercase "us" is not a market
  });

  it("parses budgets in common money shapes", () => {
    expect(parseBudget("around €750k", false)).toBe(750_000);
    expect(parseBudget("300,000 euros", false)).toBe(300_000);
    expect(parseBudget("1.2m total", false)).toBe(1_200_000);
    expect(parseBudget("the SF 6H drill", false)).toBeUndefined(); // product codes are not budgets
    expect(parseBudget("500", true)).toBe(500); // targeted answer to the budget question
  });

  it("canonicalises success metrics", () => {
    expect(parseSuccessMetric("we care about demo requests", false)).toBe("Demo requests");
    expect(parseSuccessMetric("CTR mostly", false)).toBe("Paid-social CTR");
    expect(parseSuccessMetric("store visits", true)).toBe("store visits"); // free text when asked directly
  });
});

describe("conversational intake (spec §6.0 — asks only what's missing)", () => {
  function harness() {
    const created: CreateCampaignInput[] = [];
    const interview = new IntakeInterview(gateway());
    const create = async (input: CreateCampaignInput) => {
      created.push(input);
      return "camp_test123";
    };
    return { interview, create, created };
  }

  it("a rich first answer skips the questions it already answered", async () => {
    const { interview, create } = harness();
    const start = interview.start();
    expect(start.message).toContain("trying to achieve");

    const r1 = await interview.reply(start.sessionId, "Launch the TE 60 rotary hammer in DACH with a €300k budget", create);
    // Objective, markets and budget all captured from one message…
    expect(r1.fields.objective).toContain("TE 60");
    expect(r1.fields.markets?.sort()).toEqual(["AT", "CH", "DE"]);
    expect(r1.fields.budget).toBe(300_000);
    // …so the next question is the success metric, not markets or budget.
    expect(r1.missing[0]).toBe("successMetric");
    expect(r1.message).toContain("success metric");
  });

  it("runs to summary, applies a change request, then creates on confirmation", async () => {
    const { interview, create, created } = harness();
    const start = interview.start();
    await interview.reply(start.sessionId, "Launch the TE 60 in DACH with a €300k budget", create);
    await interview.reply(start.sessionId, "demo requests", create);
    const summary = await interview.reply(start.sessionId, "none", create);
    expect(summary.awaitingConfirm).toBe(true);
    expect(summary.message).toContain("Shall I create the campaign?");
    expect(summary.message).toContain("300,000");

    // Not a confirmation — a change request; the summary is refreshed, nothing created.
    const changed = await interview.reply(start.sessionId, "actually make the budget 400k", create);
    expect(changed.fields.budget).toBe(400_000);
    expect(changed.awaitingConfirm).toBe(true);
    expect(created).toHaveLength(0);

    const done = await interview.reply(start.sessionId, "yes, create it", create);
    expect(done.done).toBe(true);
    expect(done.campaignId).toBe("camp_test123");
    expect(created[0]).toMatchObject({ budget: 400_000, successMetric: "Demo requests" });
    expect(created[0]!.markets.sort()).toEqual(["AT", "CH", "DE"]);
    expect(created[0]!.mandatoryClaims).toBeUndefined(); // "none" → omitted
  });

  it("re-asks with a nudge when an answer doesn't parse (never silently assumes)", async () => {
    const { interview, create } = harness();
    const start = interview.start();
    await interview.reply(start.sessionId, "Launch the TE 60 in DACH", create); // no budget yet
    const asked = await interview.reply(start.sessionId, "hmm not sure", create); // budget question unanswered
    expect(asked.message).toContain("didn't catch");
    expect(asked.message.toLowerCase()).toContain("budget");
    const ok = await interview.reply(start.sessionId, "500k", create);
    expect(ok.fields.budget).toBe(500_000);
  });

  it("captures mandatory claims text when provided", async () => {
    const { interview, create, created } = harness();
    const start = interview.start();
    await interview.reply(start.sessionId, "Launch the TE 60 in DACH, €300k, optimise for leads", create);
    await interview.reply(start.sessionId, "Runtime claims require an EN 62841 footnote.", create);
    const done = await interview.reply(start.sessionId, "yes", create);
    expect(done.done).toBe(true);
    expect(created[0]!.mandatoryClaims).toContain("EN 62841");
  });
});
