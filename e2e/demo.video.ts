import { test, expect } from "@playwright/test";

/**
 * The recorded product demo (~4 min): one campaign end to end with captions
 * burned into the page (so they appear in the Playwright video). Run via
 * `npm run demo:video` — playwright.demo.config.ts records 720p video and
 * scripts/make-demo.ps1 converts it to MP4.
 */

test("ARTIZENT Astra Campaign Studio — recorded demo", async ({ page }) => {
  test.setTimeout(420_000);

  // ── helpers ────────────────────────────────────────────────────────────────
  const caption = async (text: string, holdMs: number) => {
    await page.evaluate((t) => {
      let el = document.getElementById("demo-caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "demo-caption";
        el.style.cssText =
          "position:fixed;left:0;right:0;bottom:0;z-index:99999;background:rgba(10,22,40,.94);color:#fff;" +
          "font:600 19px/1.4 'Segoe UI',Arial,sans-serif;padding:14px 40px;text-align:center;letter-spacing:.01em;" +
          "border-top:3px solid #B8913B";
        document.body.appendChild(el);
      }
      el.textContent = t;
    }, text);
    await page.waitForTimeout(holdMs);
  };

  let nextDialogText = "";
  page.on("dialog", (d) => d.accept(nextDialogText));

  const command = async (text: string) => {
    const before = await page.locator("#chatlog .msg.astra").count();
    await page.fill("#chatinput", text);
    await page.locator("#chatform button").click();
    await expect(page.locator("#chatlog .msg.astra")).toHaveCount(before + 1, { timeout: 60_000 });
  };

  const say = async (text: string) => {
    await page.locator("#wChatInput").pressSequentially(text, { delay: 16 });
    await page.waitForTimeout(300);
    await page.locator("#wChatForm button").click();
    await page.waitForTimeout(1100);
  };

  const setRole = async (role: string) => {
    await page.selectOption("#roleSel", role);
    await page.waitForTimeout(1100);
  };

  const noDrift = () => page.evaluate(() => window.scrollTo({ left: 0 }));
  const scrollTo = async (selector: string) => {
    const el = page.locator(selector).first();
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await noDrift(); // never drift horizontally — the brand stays in frame
  };
  const scrollToLoc = async (loc: ReturnType<typeof page.locator>) => {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await noDrift();
  };

  // ── Scene 1 · intro ────────────────────────────────────────────────────────
  await page.goto("/");
  await expect(page.locator("#rail .stage").first()).toBeVisible();
  await setRole("marketing-ops");
  await caption("This is Astra Campaign Studio by ARTIZENT. AI agents do the heavy lifting. People stay in charge.", 6000);
  await caption("Everything about a campaign lives on one screen: the stages, the work, and who needs to approve what.", 5500);

  // ── Scene 1b · connect Claude Design over MCP ──────────────────────────────
  const demoBtn = page.locator("#settings button", { hasText: "Use bundled demo server" });
  await demoBtn.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await noDrift();
  await caption("One quick stop first: connecting Claude Design. It plugs in over MCP with a single click.", 5000);
  await demoBtn.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.locator("#toast")).toContainText("design tools discovered");
  await caption("Connected. From here on, the agents create real artwork through Claude Design.", 5000);
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await noDrift();

  // ── Scene 2 · conversational intake ────────────────────────────────────────
  await page.click("#newBtn");
  await expect(page.locator("#wChatLog")).toContainText("trying to achieve");
  await caption("Starting a campaign is just a conversation. The agent asks, you answer.", 4000);
  await say("Launch the new Hilti cordless tool platform across DACH and the US with a €750k budget");
  await caption("It picked up the goal, the markets and the budget from one answer. So it only asks for what's missing.", 5500);
  await say("qualified leads");
  await say("Cordless performance claims require a test-condition footnote.");
  await caption("A quick summary, a yes, and the campaign exists.", 4000);
  await say("yes");
  await expect(page.locator("#wizard")).toBeHidden();
  await caption("The brief is already written, with sources to back it up.", 5000);

  // ── Scene 3 · review ───────────────────────────────────────────────────────
  await scrollTo("#artifacts .art");
  await caption("Nothing moves forward on its own. You read the work, then approve it.", 5500);
  await page.locator("#artifacts button.approve").first().click();
  await page.waitForTimeout(1000);
  await command("approve all");
  await command("advance");
  await caption("Each stage has to be signed off before the next one starts.", 4500);

  // ── Scene 4 · planning ─────────────────────────────────────────────────────
  await command("run stage");
  await caption("Eight agents build the plan: strategy, audiences, budget. And they lock the targets.", 5500);
  await command("approve all");
  await command("advance");

  // ── Scene 5 · content planning (brisk) ─────────────────────────────────────
  await command("run stage");
  await caption("Then the creative plan: concept, storyboard, calendar and channel briefs.", 4500);
  await command("approve all");
  await command("advance");

  // ── Scene 6 · creation + quality gates ─────────────────────────────────────
  await command("run stage");
  await caption("Now the actual content. Copy, email, landing page, imagery. Even a German version.", 5000);
  const copyCard = page.locator("#artifacts .art", { hasText: "Paid-social copy" }).first();
  await scrollToLoc(copyCard);
  await caption("Every asset is checked before a person even sees it: sources, brand, legal, accessibility, translation.", 5500);

  // ── Scene 6b · the hero, made by Claude Design ─────────────────────────────
  const heroCard = page.locator("#artifacts .art", { hasText: "Hero image" }).first();
  await scrollToLoc(heroCard);
  await caption("And the hero image? That's real artwork — Claude Design made it just now, on brief.", 6000);

  // ── Scene 7 · @mention a colleague ─────────────────────────────────────────
  await copyCard.locator(".linkbtn", { hasText: "Mention" }).click();
  await copyCard.locator("select[id^='menRole-']").selectOption("brand-guardian");
  await copyCard.locator("input[id^='menMsg-']").pressSequentially("Can you double-check the tone here?", { delay: 14 });
  await copyCard.locator("button", { hasText: "Send" }).click();
  await caption("Need a second opinion? Pull a colleague in, right on the work.", 5000);

  // ── Scene 8 · role lens + request changes ──────────────────────────────────
  await setRole("legal");
  await caption("Every role gets its own view. This is Legal's: only the things Legal signs off.", 5500);
  const legalCopy = page.locator("#artifacts .art", { hasText: "Paid-social copy" }).first();
  await scrollToLoc(legalCopy);
  nextDialogText = "Cite the runtime footnote explicitly next to the claim.";
  await legalCopy.locator("button.reject").click();
  await page.waitForTimeout(2200);
  await caption("Don't like something? Say why and send it back. The agent rewrites it and it's back in the queue.", 6000);

  // ── Scene 9 · inline edit + diff ───────────────────────────────────────────
  await setRole("marketing-ops");
  const redraft = page.locator("#artifacts .art", { hasText: "Paid-social copy" }).filter({ hasText: "Needs review" }).first();
  await scrollToLoc(redraft);
  await redraft.locator(".linkbtn", { hasText: "Edit" }).click();
  await caption("Or just edit it yourself. Every change becomes a new version.", 4000);
  await page.locator(".art.editing textarea").nth(1).fill("Zero downtime. Total control.");
  await page.locator(".art.editing button.approve", { hasText: "Save changes" }).click();
  await page.waitForTimeout(1300);
  const edited = page.locator("#artifacts .art", { hasText: "Zero downtime" }).first();
  await scrollToLoc(edited);
  await edited.locator(".linkbtn", { hasText: "View changes" }).click();
  await caption("And you can see exactly what changed, word by word.", 5000);

  // ── Scene 10 · Figma + localisation workbench ──────────────────────────────
  await command("approve all");
  await page.waitForTimeout(1200);
  await scrollTo("#figmaCard");
  await expect(page.locator("#figmaCard img.assetpreview").first()).toBeVisible();
  await caption("Everything approved lands on the Figma board — the artwork right there with the copy.", 6000);
  await page.click("#navLocalisation");
  await page.waitForTimeout(1200);
  await caption("Translations sit side by side with the original, checked for meaning, not just words.", 6000);
  await page.click("#navCampaign");
  await command("advance");

  // ── Scene 11 · roll-out + go-live ──────────────────────────────────────────
  await command("run stage");
  await caption("Time to publish. Everything gets prepared first. Nothing goes out yet.", 5000);
  await command("approve all");
  await scrollTo("#actions");
  await caption("Going live takes a human decision. And a passing consent check.", 4500);
  nextDialogText = "";
  await page.locator("#actions button", { hasText: "Go live" }).click();
  await expect(page.locator("#toast")).toContainText("Live — executed");
  await caption("Now it's live: website, assets, ads and email. Every step audited.", 5500);
  await command("advance");

  // ── Scene 12 · optimisation ────────────────────────────────────────────────
  await command("run stage");
  await page.click("#navPerformance");
  await page.waitForTimeout(1300);
  await caption("Once live, the agents watch the numbers. Small budget moves happen on their own. Big ones wait for you.", 6000);
  await scrollTo("#perfTrend");
  await caption("You can see the ads getting tired. And the A/B test already found a better headline.", 5500);
  nextDialogText = "CPL worsened after the shift — reverting.";
  await page.locator("#perfMoves button", { hasText: "Roll back" }).first().click();
  await page.waitForTimeout(1300);
  await caption("Changed your mind? Roll it back. One click, fully recorded.", 5000);
  await page.click("#navCampaign");
  await command("approve all");
  await command("advance");

  // ── Scene 13 · refresh + learning loop ─────────────────────────────────────
  await command("run stage");
  await caption("Tired content gets refreshed, then checked all over again. No shortcuts.", 5000);
  await command("approve all");
  await scrollTo("#notifs");
  await caption("And what worked gets remembered. The next campaign starts smarter.", 5500);

  // ── Scene 14 · close ───────────────────────────────────────────────────────
  await page.click("#navPortfolio");
  await page.waitForTimeout(1300);
  await caption("Leadership sees it all in one view: pipeline, speed, quality and spend.", 5500);
  await caption("Astra Campaign Studio by ARTIZENT. From idea to live campaign, end to end.", 7000);
});
