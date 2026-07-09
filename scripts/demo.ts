import { Astra } from "../src/app";
import { agentsForStage } from "../src/agents/catalogue";
import { figmaRoundTripAgent } from "../src/agents/figmaAgents";
import type { Actor } from "../src/domain/types";

/**
 * End-to-end M0/M1 demo — the §16 narrative on the real runtime, now driven by
 * the full Stage 0–3 agent catalogue (spec §7.3) through stage orchestrators
 * (§7.1). Every artifact is grounded+cited, cleared by stage-appropriate evals,
 * and approved at a human-in-the-loop checkpoint, with a full audit trail.
 *
 * Runs with no API key (mock provider). Set ANTHROPIC_API_KEY to route to Claude.
 */

const human: Actor = { kind: "human", id: "u_cm", displayName: "Dana (Campaign Manager)" };

function banner(title: string): void {
  console.log(`\n${"─".repeat(68)}\n${title}\n${"─".repeat(68)}`);
}

async function main(): Promise<void> {
  const usingClaude = Boolean(process.env.ANTHROPIC_API_KEY);
  banner("ASTRA CAMPAIGN STUDIO · Stage 0–3 catalogue demo");
  console.log(`Model routing: ${usingClaude ? "Claude (via gateway)" : "mock provider (no key set)"}`);

  const astra = new Astra({ persistence: "memory", campaignTokenBudget: 500_000 });

  const campaignId = await astra.createCampaign(
    {
      objective: "Launch the new Hilti cordless tool platform across DACH and the US",
      owner: human.id,
      markets: ["DE", "AT", "CH", "US"],
      budget: 750_000,
      currency: "EUR",
      kpis: ["Qualified leads", "Paid-social CTR"],
    },
    human,
  );
  console.log(`Created campaign ${campaignId}`);

  // The human checkpoint: auto-approve on-brief work (a real UI resolves a reviewer).
  const stageOrch = astra.stageOrchestrator(async () => ({
    approve: true,
    actor: human,
    note: "On-brief. Approved.",
  }));

  // Walk the lifecycle: run each stage's full agent set, then advance.
  for (let guard = 0; guard < 8; guard++) {
    const obj = await astra.repo.load(campaignId);
    const stage = obj!.campaign.currentStage;
    if (agentsForStage(stage).length === 0) break; // reached end of MVP-1 scope

    banner(`STAGE: ${stage}  (${agentsForStage(stage).length} agents)`);
    const report = await stageOrch.runCurrentStage(campaignId);
    for (const r of report.agentReports) {
      const evals = r.result.evals.map((e) => `${e.name}:${e.passed ? "✓" : "✗"}`).join(" ");
      const mark = r.approved ? "✅" : "⛔";
      console.log(`  ${mark} ${r.agent}`);
      console.log(`       “${r.result.artifact.title}”  ·  evals [${evals || "—"}]`);
    }
    if (report.advancedTo) {
      console.log(`  ⏭  gate satisfied → advanced to ${report.advancedTo}`);
    } else {
      console.log(`  ⏸  gate not satisfied — staying in ${report.stage}`);
    }
  }

  // The Figma moment (spec §10.3): a placeholder board becomes a real, on-brand board.
  banner("FIGMA MOMENT (spec §10.3)");
  const boardBefore = astra.figma;
  const afterCreation = await astra.repo.load(campaignId);
  const board = Object.values(afterCreation!.artifacts).find(
    (a) => a.title === "Figma board" && a.body.phase === "populated",
  );
  if (board) {
    const frames = board.body.frames as Record<string, string>;
    console.log(`  Board populated deterministically from approved artifacts:`);
    for (const [frame, content] of Object.entries(frames)) {
      const shown = content ? `“${content.slice(0, 52)}${content.length > 52 ? "…" : ""}”` : "· placeholder ·";
      console.log(`    ${frame.padEnd(14)} ← ${shown}`);
    }
    console.log(`  Governed via MCP: every Figma call is scope-checked and audited (spec §10.1).`);

    // Round-trip: a designer refines a frame in Figma; the change syncs back (§10.3).
    boardBefore.simulateDesignerEdit(campaignId, "paid-headline", "Zero downtime. Total control.");
    const rt = await astra.orchestrator.runAgent(campaignId, figmaRoundTripAgent);
    if (rt.pendingHumanApproval) {
      await astra.orchestrator.approve(campaignId, rt.artifact.id, human, "Designer refinement approved.");
    }
    const synced = (rt.artifact.body.frames as Record<string, string>)["paid-headline"];
    console.log(`\n  ↩ Round-trip sync: designer edited paid-headline in Figma →`);
    console.log(`    campaign object now shows: “${synced}” (new board version, HITL-approved)`);
  }

  // Content lineage (spec §12): trace the DE transcreation back through the object.
  banner("CONTENT LINEAGE (spec §12)");
  const finalObj = await astra.repo.load(campaignId);
  const artifacts = finalObj!.artifacts;
  const de = Object.values(artifacts).find((a) => a.title.includes("DE (transcreation)"));
  if (de) {
    const chain: string[] = [];
    let current = de;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(`${current.kind}:“${current.title}”`);
      const parentId = current.derivedFrom[0];
      current = parentId ? artifacts[parentId]! : (undefined as never);
    }
    console.log(`  ${chain.join("  ⟵  ")}`);
    console.log(`  Grounded in: ${de.citations.map((c) => `${c.sourceId} v${c.version}`).join(", ")}`);
  }

  banner("TELEMETRY (spec §9.4 / §14)");
  console.log(`  Tokens spent on campaign: ${astra.gateway.spent(campaignId)}`);
  console.log(`  Final stage: ${finalObj!.campaign.currentStage}`);
  console.log(`  Artifacts on campaign object: ${Object.keys(artifacts).length}`);
  const events = await astra.store.read(campaignId);
  const connectorCalls = events.filter((e) => e.body.type === "ConnectorInvoked").length;
  console.log(`  Audit-trail events: ${events.length}  (of which ${connectorCalls} governed connector calls)`);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
