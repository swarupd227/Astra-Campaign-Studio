import { Astra } from "../src/app";
import { agentsForStage, getAgentByName } from "../src/agents/catalogue";
import { figmaMappingAgent } from "../src/agents/figmaAgents";
import { ArtifactStatus, Stage, type Actor, type Artifact } from "../src/domain/types";

/**
 * One campaign, every role. This walks a single campaign end to end through all
 * seven personas — showing each role's authority, the human-in-the-loop review
 * loop, inline editing, request-changes redrafts, the Figma moment, the portfolio
 * view and the admin autonomy dial — with governance enforced at every step.
 *
 * Runs on the in-memory runtime (mock provider) — no server, no key needed:
 *     npm run walkthrough
 */

const CM: Actor = { kind: "human", id: "u_cm", displayName: "Dana · Campaign Manager", role: "campaign-manager" };
const CMO: Actor = { kind: "human", id: "u_cmo", displayName: "Priya · Marketing Leader", role: "marketing-leader" };
const STRAT: Actor = { kind: "human", id: "u_cs", displayName: "Sam · Content Strategist", role: "content-strategist" };
const BRAND: Actor = { kind: "human", id: "u_bg", displayName: "Ben · Brand Guardian", role: "brand-guardian" };
const LEGAL: Actor = { kind: "human", id: "u_lg", displayName: "Lena · Legal / Compliance", role: "legal" };
const CREATOR: Actor = { kind: "human", id: "u_cr", displayName: "Cara · Creator", role: "creator" };
const CHANNEL: Actor = { kind: "human", id: "u_ch", displayName: "Chris · Channel Specialist", role: "channel-specialist" };
const PERF: Actor = { kind: "human", id: "u_pm", displayName: "Petra · Performance Marketer", role: "performance-marketer" };
const OPS: Actor = { kind: "human", id: "u_op", displayName: "Omar · Marketing Ops", role: "marketing-ops" };

const astra = new Astra({ persistence: "memory", campaignTokenBudget: 2_000_000 });
let campaignId = "";

function banner(title: string): void {
  console.log(`\n${"━".repeat(72)}\n  ${title}\n${"━".repeat(72)}`);
}
function act(actor: Actor, msg: string): void {
  console.log(`  ▸ ${actor.displayName.padEnd(28)} ${msg}`);
}
function note(msg: string): void {
  console.log(`      ${msg}`);
}

async function load() {
  const obj = await astra.repo.load(campaignId);
  if (!obj) throw new Error("campaign not found");
  return obj;
}
async function runStage(stage: Stage, exclude: string[] = []): Promise<void> {
  for (const agent of agentsForStage(stage)) {
    if (exclude.includes(agent.name)) continue;
    await astra.orchestrator.runAgent(campaignId, agent);
  }
}
async function inReview(title: string): Promise<Artifact | undefined> {
  const obj = await load();
  return Object.values(obj.artifacts).find((a) => a.title === title && a.status === ArtifactStatus.InReview);
}
async function approveAll(actor: Actor, stage: Stage): Promise<number> {
  const obj = await load();
  let n = 0;
  for (const a of Object.values(obj.artifacts)) {
    if (a.status === ArtifactStatus.InReview && a.stage === stage) {
      try {
        await astra.orchestrator.approve(campaignId, a.id, actor);
        n += 1;
      } catch {
        /* not authorised for this item — skip */
      }
    }
  }
  return n;
}
async function tryApprove(actor: Actor, artifact: Artifact): Promise<boolean> {
  try {
    await astra.orchestrator.approve(campaignId, artifact.id, actor);
    return true;
  } catch (err) {
    note(`⛔ DENIED — ${(err as Error).message}`);
    return false;
  }
}
async function requestChanges(actor: Actor, artifact: Artifact, feedback: string): Promise<void> {
  await astra.orchestrator.reject(campaignId, artifact.id, actor, feedback);
  const producer = getAgentByName(artifact.author.displayName);
  if (producer) await astra.orchestrator.runAgent(campaignId, producer, { feedback, supersedes: artifact.id });
}
async function advance(actor: Actor): Promise<void> {
  const decision = astra.access.canAdvance(actor.role);
  if (!decision.allowed) { note(`⛔ ${decision.reason}`); return; }
  const ok = await astra.orchestrator.advanceStage(campaignId, actor);
  const obj = await load();
  note(ok ? `⏭  advanced → ${obj.campaign.currentStage}` : `gate not satisfied`);
}

async function main(): Promise<void> {
  banner("ASTRA CAMPAIGN STUDIO · one campaign, every role");
  console.log(`  Reasoning: ${process.env.ANTHROPIC_API_KEY ? "Claude (via gateway)" : "mock provider (no key)"}`);

  // ── Stage 0 · Intake — Campaign Manager ─────────────────────────────────────
  banner("STAGE 0 · INTAKE — Campaign Manager owns the brief");
  campaignId = await astra.createCampaign(
    {
      objective: "Launch the new Hilti cordless tool platform across DACH and the US",
      owner: CM.id,
      markets: ["DE", "AT", "CH", "US"],
      budget: 750_000,
      currency: "EUR",
      kpis: ["Qualified leads"],
      mandatoryClaims: "Cordless performance claims require a test-condition footnote.",
    },
    CM,
  );
  act(CM, "created the campaign from a structured brief (markets, budget, KPI, mandatory claims)");
  await runStage(Stage.Intake);
  act(CM, "ran the intake agents (Intake · Research · Prioritisation)");

  const brief = await inReview("Campaign brief");
  act(LEGAL, "tries to approve the brief…");
  await tryApprove(LEGAL, brief!); // authority denied at intake
  act(CM, "approves the brief (accountable at intake)");
  await tryApprove(CM, brief!);
  await approveAll(CM, Stage.Intake);
  await advance(CM);

  // ── Stage 1 · Planning — Strategist proposes, Leader/Manager approve ─────────
  banner("STAGE 1 · CAMPAIGN PLANNING — strategy, media plan, locked KPIs");
  await runStage(Stage.CampaignPlanning);
  act(CM, "ran the 8 planning agents (strategy, audience, messaging, media, budget, KPIs…)");
  const strategy = await inReview("Campaign strategy");
  act(CMO, "approves the strategy (accountable at intake, consulted on plan)");
  await tryApprove(CMO, strategy!);
  const n1 = await approveAll(CM, Stage.CampaignPlanning);
  act(CM, `approved the remaining planning outputs (${n1} items) and locked KPIs`);
  await advance(CM);

  // ── Stage 2 · Content Planning — Strategist + Brand Guardian ────────────────
  banner("STAGE 2 · CONTENT PLANNING — concept, storyboard, calendar, briefs");
  await runStage(Stage.ContentPlanning);
  act(STRAT, "ran the content-planning agents (concept, storyboard, calendar, briefing…)");
  const concept = await inReview("Selected concept");
  act(BRAND, "approves the creative concept (on-brand)");
  await tryApprove(BRAND, concept!);
  const n2 = await approveAll(STRAT, Stage.ContentPlanning);
  act(STRAT, `approved the remaining content-planning outputs (${n2} items)`);
  await advance(CM);

  // ── Stage 3 · Content Creation — Creator, Legal, Brand, + the Figma moment ──
  banner("STAGE 3 · CONTENT CREATION — draft, review, edit, redraft, assemble");
  await runStage(Stage.ContentCreation, [figmaMappingAgent.name]);
  act(CREATOR, "generated the assets (copy, landing, email, module, imagery, variants, localisation)");

  const copy = await inReview("Paid-social copy");
  act(LEGAL, "requests changes on the paid-social copy → agent redrafts");
  note(`feedback: "Lead with jobsite uptime and cite the runtime footnote explicitly."`);
  await requestChanges(LEGAL, copy!, "Lead with jobsite uptime and cite the runtime footnote explicitly.");

  const redraft = await inReview("Paid-social copy");
  act(CREATOR, "edits the redraft inline → new version (edit anything, lose nothing)");
  await astra.orchestrator.editArtifact(campaignId, redraft!.id, { headline: "Zero downtime. Total control." }, CREATOR);

  const finalCopy = await inReview("Paid-social copy");
  act(LEGAL, "signs off the copy (regulated claim + substantiation)");
  await tryApprove(LEGAL, finalCopy!);
  const n3 = await approveAll(BRAND, Stage.ContentCreation);
  act(BRAND, `approved the remaining on-brand assets (${n3} items)`);

  act(CREATOR, "runs the Figma Mapping Agent — approved content lands on the board");
  await astra.orchestrator.runAgent(campaignId, figmaMappingAgent);
  const board = await inReview("Figma board (populated)");
  if (board) {
    const frames = board.body.frames as Record<string, string>;
    const filled = Object.values(frames).filter(Boolean).length;
    note(`Figma board populated: ${filled}/${Object.keys(frames).length} frames filled from approved content`);
    await tryApprove(BRAND, board);
  }
  await advance(CM);

  // ── Stage 4 · Roll-out — Channel Specialist prepares, Ops authorises go-live ─
  banner("STAGE 4 · ROLL-OUT — publish is prepared, go-live is a human decision");
  await runStage(Stage.Rollout);
  act(CHANNEL, "ran the 9 roll-out agents (localisation-final, metadata, QA, consent, CMS/DAM/ads/SFMC prep, schedule)");

  const qa = await inReview("Pre-flight QA report");
  act(LEGAL, "tries to approve the QA report…");
  await tryApprove(LEGAL, qa!); // Legal has no roll-out authority — denied

  act(OPS, "tries to go live BEFORE anything is approved…");
  try {
    await astra.goLive(campaignId, OPS);
  } catch (err) {
    note(`⛔ BLOCKED — ${(err as Error).message}`);
  }

  const n4 = await approveAll(OPS, Stage.Rollout);
  act(OPS, `approved the roll-out package (${n4} items, incl. the consent check)`);
  const { executed } = await astra.goLive(campaignId, OPS);
  act(OPS, `authorised GO-LIVE → ${executed.map((e) => `${e.system}·${e.tool}`).join(", ")}`);
  note("each publish/send/launch is an audited, irreversible connector call — doubly gated");
  await advance(CM);

  // ── Stage 5 · Campaign Optimisation — bounded autonomy earns its keep ────────
  banner("STAGE 5 · OPTIMISATION — within guardrails: automatic; material: human");
  for (const agent of agentsForStage(Stage.CampaignOptimisation)) {
    const r = await astra.orchestrator.runAgent(campaignId, agent);
    if (r.autoApproved) act(PERF, `${agent.name} → applied automatically (L3, within guardrails)`);
    else if (r.pendingHumanApproval) act(PERF, `${agent.name} → QUEUED for approval (${r.reason.slice(0, 60)}…)`);
  }
  const material = await inReview("Budget move — needs approval");
  if (material) {
    act(PERF, "reviews the material 25% budget shift and approves it");
    await tryApprove(PERF, material);
  }
  const perf = await astra.performance(campaignId);
  note(`performance: ${perf!.totals.leads} leads · blended CPL EUR ${perf!.totals.blendedCpl} (guardrail ≤ EUR ${perf!.kpi.maxCpl}) · ${perf!.budgetMoves.length} budget moves`);
  await advance(CM);

  // ── Stage 6 · Content Optimisation + the learning loop ───────────────────────
  banner("STAGE 6 · CONTENT OPTIMISATION — refresh re-enters the gates; learnings compound");
  await runStage(Stage.ContentOptimisation);
  act(PERF, "ran the content-optimisation agents (fatigue, refresh, persona variant, SEO, backlog, learnings)");
  const refreshed = await inReview("Paid-social copy — refresh");
  act(BRAND, "re-approves the refreshed creative — same brand/compliance gates as net-new");
  await tryApprove(BRAND, refreshed!);
  const n6 = await approveAll(PERF, Stage.ContentOptimisation);
  act(PERF, `approved the remaining optimisation outputs (${n6} items)`);

  const learningObj = await load();
  const learning = Object.values(learningObj.artifacts).find(
    (a) => a.kind === "learning" && a.status === "approved",
  );
  if (learning) {
    await astra.harvestLearning(campaignId, learning.id);
    act(PERF, "approved learnings written back to the knowledge fabric (§6.7)");
    const recall = await astra.fabric.retrieve("crew creative email share cordless campaign learnings");
    note(`next campaign's planning agents will retrieve: “${recall.citations[0]?.title}”`);
  }

  // ── Marketing Leader · portfolio ────────────────────────────────────────────
  banner("MISSION CONTROL — Marketing Leader's portfolio view");
  const p = await astra.portfolio();
  const t = p.totals;
  act(CMO, "opens Mission Control");
  note(`campaigns ${t.campaigns} · items ${t.approvedItems}/${t.itemsProduced} approved · quality ${Math.round(t.avgQualityPass * 100)}% · budget ${t.currency} ${t.totalBudget.toLocaleString("en-US")} · open risks ${t.openRisks}`);
  note(`pipeline: ${p.pipeline.filter((s) => s.count).map((s) => `${s.stage}=${s.count}`).join(", ")}`);

  // ── Marketing Ops · admin ───────────────────────────────────────────────────
  banner("ADMIN — Marketing Ops configures the platform");
  act(OPS, `model gateway: ${astra.gatewayStatus().activeProvider} (default ${astra.gatewayStatus().defaultModel})`);
  astra.policy.setAutonomy("creator", Stage.ContentCreation, "L3");
  act(OPS, "turned the autonomy dial to L3 for creators at content creation (bounded-auto within guardrails)");

  // ── Wrap-up ─────────────────────────────────────────────────────────────────
  banner("RESULT");
  const finalObj = await load();
  const audit = await astra.auditTrail(campaignId);
  console.log(`  Final stage:        ${finalObj.campaign.currentStage}`);
  console.log(`  Artifacts on object: ${Object.keys(finalObj.artifacts).length}`);
  console.log(`  Audit-trail events:  ${audit.length}`);
  console.log(`  Tokens spent:        ${astra.gateway.spent(campaignId)}`);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
