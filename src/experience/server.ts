import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Astra } from "../app";
import { agentsForStage, getAgentByName } from "../agents/catalogue";
import { boardArtifact, figmaBoardAgent, figmaMappingAgent, figmaRoundTripAgent } from "../agents/figmaAgents";
import { ArtifactKind, ArtifactStatus, STAGE_ORDER, Stage, type Actor } from "../domain/types";
import type { FigmaFrame } from "../integrations/figma";
import { ROLE_CATALOGUE, getRole, type AccessDecision } from "../security/roles";
import { AUTONOMY_META, isAutonomyLevel } from "../governance/policy";
import { stageLabel } from "../domain/labels";
import { IntakeInterview, type CreateCampaignInput } from "./intakeInterview";
import { NotificationService, TeamsIntakeBridge } from "./notifications";
import { verifyTeamsSignature } from "../integrations/teams";
import { assetSvg, handleClaudeDesignRpc } from "../integrations/claudeDesignDemo";
import { listDeliverables, renderDeliverable } from "../rendering/deliverables";
import { validateDeliverable } from "../rendering/conformance";
import { changeToFields, diffMarcomPlan } from "../rendering/ingest";

/**
 * Experience-layer API (spec §8) — a zero-dependency HTTP server exposing the
 * Campaign Canvas / Mission Control / Review inbox projections and the human
 * actions (run stage, approve, request changes, advance) over the Astra runtime.
 * Every surface is a projection of the one event log; every action appends events.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SYSTEM: Actor = { kind: "system", id: "seed", displayName: "System" };

/** The persona the caller is acting as, from the on-screen role switcher (`x-astra-role`). */
function actorFor(req: IncomingMessage): Actor {
  const header = req.headers["x-astra-role"];
  const roleId = Array.isArray(header) ? header[0] : header;
  const role = getRole(roleId) ?? getRole("campaign-manager")!;
  return { kind: "human", id: `u_${role.id}`, displayName: role.label, role: role.id };
}

function viewerRole(req: IncomingMessage): string {
  const header = req.headers["x-astra-role"];
  return (Array.isArray(header) ? header[0] : header) ?? "campaign-manager";
}

function forbid(res: ServerResponse, decision: AccessDecision): void {
  json(res, 403, { error: decision.reason, forbidden: true });
}

// Postgres-backed runtime (embedded PGlite by default; real Postgres via DATABASE_URL).
// ASTRA_PG_DIR isolates the data dir (used by the Playwright e2e suite).
const astra = new Astra({
  persistence: "sql",
  dataDir: process.env.ASTRA_PG_DIR ?? ".data/pg",
  campaignTokenBudget: 500_000,
});

async function seedIfEmpty(): Promise<void> {
  const existing = await astra.store.listCampaigns();
  if (existing.length > 0) return;
  const id = await astra.createCampaign(
    {
      objective: "Launch the new Hilti cordless tool platform across DACH and the US",
      owner: SYSTEM.id,
      markets: ["DE", "AT", "CH", "US"],
      budget: 750_000,
      currency: "EUR",
      kpis: ["Qualified leads", "Paid-social CTR"],
    },
    SYSTEM,
  );
  // Run the first stage so reviewers open to a live queue of proposals.
  await runStage(id);
}

/** Run every agent for the campaign's current stage, leaving each awaiting human review. */
async function runStage(campaignId: string): Promise<void> {
  const obj = await astra.repo.load(campaignId);
  if (!obj) return;
  const agents = agentsForStage(obj.campaign.currentStage);
  const authored = new Set(
    Object.values(obj.artifacts)
      .filter((a) => a.status !== ArtifactStatus.Rejected)
      .map((a) => a.author.displayName),
  );
  // §11.3 precondition: the Figma board (Phase 1, placeholder frames) must exist
  // BEFORE any content agent fires — the orchestrator enforces the sequence.
  if (obj.campaign.currentStage === Stage.ContentCreation && !boardArtifact(obj)) {
    await astra.orchestrator.runAgent(campaignId, figmaBoardAgent);
  }
  for (const agent of agents) {
    // The Figma board is populated from APPROVED content (Phase 2), so it is not
    // part of the bulk run — it is triggered on approval (see maybeAssembleBoard).
    if (agent.name === figmaMappingAgent.name) continue;
    if (authored.has(agent.name)) continue; // idempotent: don't re-run an agent that already produced
    await astra.orchestrator.runAgent(campaignId, agent);
  }
}

/**
 * Phase 1 of the mapping contract (§11.3): the moment the Campaign Scope Brief
 * is approved, create the Figma board and its named placeholder frames — before
 * creation begins. Idempotent; runs at most once per campaign.
 */
async function maybeCreateBoard(campaignId: string): Promise<void> {
  const obj = await astra.repo.load(campaignId);
  if (!obj || obj.campaign.currentStage !== Stage.ContentPlanning) return;
  if (boardArtifact(obj)) return;
  const scopeBriefApproved = Object.values(obj.artifacts).some(
    (a) => a.kind === ArtifactKind.CreativeBrief && a.status === ArtifactStatus.Approved,
  );
  if (!scopeBriefApproved) return;
  await astra.orchestrator.runAgent(campaignId, figmaBoardAgent);
  await notifier.notify(
    campaignId,
    "created",
    "Figma board created",
    "The Campaign Scope Brief was approved — the board and its placeholder frames are ready for creation (§11.3 Phase 1).",
  );
}

/**
 * The Figma Mapping Agent reads APPROVED copy and creative (spec §10.3). Once the
 * required source artifacts are approved, assemble the board — mirroring the real
 * UX where a human approves content first, then watches the board populate.
 */
async function maybeAssembleBoard(campaignId: string): Promise<void> {
  const obj = await astra.repo.load(campaignId);
  if (!obj || obj.campaign.currentStage !== Stage.ContentCreation) return;

  const approved = (kind: ArtifactKind, titleIncludes: string) =>
    Object.values(obj.artifacts).some(
      (a) => a.kind === kind && a.status === ArtifactStatus.Approved && a.title.includes(titleIncludes),
    );
  const sourcesReady =
    approved(ArtifactKind.ContentItem, "Paid-social copy") &&
    approved(ArtifactKind.Asset, "Hero image") &&
    approved(ArtifactKind.ContentItem, "Launch email") &&
    approved(ArtifactKind.ContentItem, "Landing page");
  if (!sourcesReady) return;

  // Skip if a POPULATED board already exists; a Phase-1 placeholder board is
  // exactly what Phase 2 fills (and supersedes — same title, §11.3).
  const board = boardArtifact(obj);
  if (board && Number((board.body as { filledFrames?: number }).filledFrames ?? 0) > 0) return;

  await astra.orchestrator.runAgent(campaignId, figmaMappingAgent);
}

// ── tiny router ───────────────────────────────────────────────────────────────
type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: any) => Promise<void>;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }
const routes: Route[] = [];

function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" + path.replace(/:([^/]+)/g, (_m, k) => { keys.push(k); return "([^/]+)"; }) + "$",
  );
  routes.push({ method, pattern, keys, handler });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

// ── API routes ──────────────────────────────────────────────────────────────

// The persona catalogue that populates the on-screen role switcher (spec §5.1).
route("GET", "/api/roles", async (_req, res) => {
  json(
    res,
    200,
    ROLE_CATALOGUE.map((r) => ({
      id: r.id,
      label: r.label,
      home: r.home,
      canRunAgents: r.canRunAgents,
      canAdvance: r.canAdvance,
      canAdmin: r.canAdmin,
      canCreateCampaign: r.canCreateCampaign,
    })),
  );
});

route("GET", "/api/mission-control", async (req, res) => {
  const role = viewerRole(req);
  const rows = (await astra.missionControl()).filter((r) => astra.guests.isAllowed(role, r.id));
  json(res, 200, rows);
});

// Portfolio rollup for the Mission Control surface (spec §5.1 / §8.2).
route("GET", "/api/portfolio", async (_req, res) => {
  json(res, 200, await astra.portfolio());
});

// Unified Review & Approvals inbox (spec §8.2): everything awaiting THIS role's
// sign-off, across every campaign the role can see — one queue, with context.
route("GET", "/api/review-inbox", async (req, res) => {
  const role = viewerRole(req);
  const ids = (await astra.store.listCampaigns()).filter((id) => astra.guests.isAllowed(role, id));
  const items: {
    campaignId: string;
    objective: string;
    stage: string;
    stageLabel: string;
    artifactId: string;
    title: string;
    kind: string;
    version: number;
    author: string;
  }[] = [];
  for (const id of ids) {
    const view = await astra.canvas(id, role);
    if (!view) continue;
    for (const artId of view.reviewQueue) {
      const a = view.artifacts.find((x) => x.id === artId);
      if (!a) continue;
      items.push({
        campaignId: id,
        objective: view.campaign.objective,
        stage: a.stage,
        stageLabel: stageLabel(a.stage as Stage),
        artifactId: a.id,
        title: a.title,
        kind: a.kind,
        version: a.version,
        author: a.author, // projected as a display name
      });
    }
  }
  json(res, 200, { items });
});

// ── Notifications (spec §8.4) — in-app feed + governed Teams delivery ─────────
const notifier = new NotificationService(astra.connectors);

/** Shared campaign-creation used by the wizard, the interview and the Teams bridge. */
async function createCampaignFrom(input: CreateCampaignInput, actor: Actor): Promise<string> {
  const id = await astra.createCampaign(
    {
      objective: input.objective,
      owner: actor.id,
      markets: input.markets,
      budget: input.budget,
      currency: "EUR",
      kpis: [input.successMetric],
      ...(input.mandatoryClaims ? { mandatoryClaims: input.mandatoryClaims } : {}),
    },
    actor,
  );
  if (astra.access.canRunAgents(actor.role).allowed) await runStage(id); // draft the brief
  await notifier.notify(id, "created", "New campaign created", `“${input.objective}” — requested by ${actor.displayName}. The intake brief is drafted and awaiting review.`);
  return id;
}

// ── Conversational brief intake (spec §6.0) ───────────────────────────────────
const interview = new IntakeInterview(astra.gateway);

// Teams / Copilot entry point: one interview per Teams conversation (spec §6.0).
const teamsBridge = new TeamsIntakeBridge(interview, (input, requesterName) =>
  createCampaignFrom(input, {
    kind: "human",
    id: "u_teams",
    displayName: `${requesterName} (Teams)`,
    role: "campaign-manager", // requester intake; approvals still happen in-app per RACI
  }),
);

route("POST", "/api/intake/start", async (req, res) => {
  const decision = astra.access.canCreateCampaign(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  json(res, 200, interview.start());
});

route("POST", "/api/intake/:sid/reply", async (req, res, p, body) => {
  const actor = actorFor(req);
  const decision = astra.access.canCreateCampaign(actor.role);
  if (!decision.allowed) return forbid(res, decision);
  try {
    const reply = await interview.reply(p.sid!, String(body.text ?? ""), (input) => createCampaignFrom(input, actor));
    json(res, 200, reply);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

// Teams outgoing-webhook / Copilot Studio entry point (spec §6.0, §10.2). When a
// shared secret is configured, the HMAC signature is verified against the raw body.
route("POST", "/api/inbound/teams", async (req, res, _p, body) => {
  const secret = process.env.TEAMS_OUTGOING_SECRET;
  if (secret) {
    const raw = (body as { __raw?: string }).__raw ?? "";
    if (!verifyTeamsSignature(raw, req.headers.authorization, secret)) {
      return json(res, 401, { type: "message", text: "Signature verification failed." });
    }
  }
  try {
    json(res, 200, await teamsBridge.handle(body));
  } catch (err) {
    json(res, 200, { type: "message", text: `Sorry — ${(err as Error).message}` });
  }
});

// In-app notification feed (spec §8.4).
route("GET", "/api/notifications", async (_req, res) => {
  json(res, 200, notifier.list());
});

// Configure the Teams webhook (Admin only; empty clears → in-app only).
route("POST", "/api/settings/teams", async (req, res, _p, body) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  const webhookUrl = typeof body.webhookUrl === "string" ? body.webhookUrl.trim() : "";
  if (webhookUrl && !/^https:\/\//.test(webhookUrl)) {
    return json(res, 400, { error: "The Teams webhook URL must be https." });
  }
  astra.configureTeams(webhookUrl ? { webhookUrl } : null);
  json(res, 200, astra.teamsStatus());
});

// ── Admin Settings (spec §9.4/§9.5) — Marketing Ops / Admin role only ─────────
route("GET", "/api/settings", async (req, res) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  // Status only — the key itself is never returned. Includes trust & safety counters.
  json(res, 200, { ...astra.gatewayStatus(), safety: astra.safetyReport() });
});

route("POST", "/api/settings/anthropic-key", async (req, res, _p, body) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (key && key.length < 12) {
    return json(res, 400, { error: "That doesn't look like a valid API key." });
  }
  astra.setAnthropicKey(key || null); // empty clears it; never logged
  json(res, 200, astra.gatewayStatus());
});

// Autonomy policy — view and adjust the autonomy dial per role/stage (spec §7.2/§9.1).
route("GET", "/api/admin/policy", async (req, res) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  json(res, 200, {
    levels: AUTONOMY_META,
    rules: astra.policy.list().map((r) => ({ ...r, stageLabel: stageLabel(r.stage) })),
  });
});

route("POST", "/api/admin/policy", async (req, res, _p, body) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  if (!isAutonomyLevel(body.autonomy)) return json(res, 400, { error: "Unknown autonomy level." });
  astra.policy.setAutonomy(String(body.role), body.stage as Stage, body.autonomy);
  json(res, 200, { rules: astra.policy.list().map((r) => ({ ...r, stageLabel: stageLabel(r.stage) })) });
});

// Golden set + eval feedback loop (spec §9.2) — Admin only.
route("GET", "/api/admin/golden", async (req, res) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  json(res, 200, { golden: astra.golden.current(), suggestions: astra.golden.listSuggestions() });
});

route("POST", "/api/admin/golden", async (req, res, _p, body) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  const text = String(body.text ?? "").trim();
  if (!text) return json(res, 400, { error: "Text is required." });
  switch (String(body.op ?? "")) {
    case "add-banned": astra.golden.addBannedTerm(text); break;
    case "remove-banned": astra.golden.removeBannedTerm(text); break;
    case "add-on-brand": astra.golden.addExemplar("onBrand", text); break;
    case "remove-on-brand": astra.golden.removeExemplar("onBrand", text); break;
    case "add-off-brand": astra.golden.addExemplar("offBrand", text); break;
    case "remove-off-brand": astra.golden.removeExemplar("offBrand", text); break;
    case "accept-suggestion": astra.golden.acceptSuggestion(text); break;
    case "dismiss-suggestion": astra.golden.dismissSuggestion(text); break;
    default: return json(res, 400, { error: "Unknown operation." });
  }
  json(res, 200, { golden: astra.golden.current(), suggestions: astra.golden.listSuggestions() });
});

// Knowledge fabric (spec §9.3) — list indexed sources and ingest new documents.
route("GET", "/api/admin/knowledge", async (req, res) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  json(res, 200, { sources: await astra.knowledgeSources() });
});

route("POST", "/api/admin/knowledge", async (req, res, _p, body) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  const title = String(body.title ?? "").trim();
  const text = String(body.text ?? "").trim();
  const domain = String(body.domain ?? "product");
  if (!title || !text) return json(res, 400, { error: "Title and document text are required." });
  if (!["brand", "product", "market", "history"].includes(domain)) {
    return json(res, 400, { error: "Domain must be brand, product, market or history." });
  }
  const id =
    typeof body.id === "string" && body.id.trim()
      ? body.id.trim()
      : `${domain}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;
  const source = await astra.ingestKnowledge({
    id,
    title,
    domain: domain as "brand" | "product" | "market" | "history",
    version: String(body.version ?? "1.0").trim() || "1.0",
    text,
  });
  json(res, 200, { ingested: source, sources: await astra.knowledgeSources() });
});

// Agent catalogue status (spec §7.3) — read-only.
route("GET", "/api/admin/agents", async (req, res) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  json(res, 200, {
    stages: STAGE_ORDER.filter((s) => agentsForStage(s).length > 0).map((stage) => ({
      stage,
      stageLabel: stageLabel(stage),
      agents: agentsForStage(stage).map((a) => a.name),
    })),
  });
});

// Configure Figma live mode (token + file key) or revert to mock. In-memory only.
route("POST", "/api/settings/figma", async (req, res, _p, body) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const fileKey = typeof body.fileKey === "string" ? body.fileKey.trim() : "";
  if (token && !fileKey) return json(res, 400, { error: "A Figma file key is required with the token." });
  astra.configureFigma(token && fileKey ? { token, fileKey } : null);
  json(res, 200, astra.figmaStatus());
});

// Bundled Claude Design demo MCP server (local-first): the ClaudeDesignConnector
// speaks the real protocol against this endpoint when no Anthropic token is set,
// so the integration is demonstrable end to end — initialize, tools/list,
// tools/call — with designs rendered at /assets/design-<id>.svg.
route("POST", "/mcp/claude-design", async (_req, res, _p, body) => {
  const reply = handleClaudeDesignRpc(body);
  if (reply.sessionId) res.setHeader("mcp-session-id", reply.sessionId);
  if (reply.body === null) {
    res.writeHead(reply.status);
    res.end();
    return;
  }
  json(res, reply.status, reply.body);
});

// Rendered campaign artwork (hero art + Claude Design outputs) — actual images
// for the asset cards and the Figma board, not opaque file paths.
route("GET", "/assets/:file", async (_req, res, p) => {
  const svg = assetSvg(p.file!);
  if (!svg) return json(res, 404, { error: `No such asset: ${p.file}` });
  res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
  res.end(svg);
});

// Configure SFMC Data Extension read (subdomain + client credentials) or revert
// to the bundled local dataset. In-memory only — never persisted.
route("POST", "/api/settings/sfmc", async (req, res, _p, body) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  const subdomain = typeof body.subdomain === "string" ? body.subdomain.trim() : "";
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
  if ((subdomain || clientId || clientSecret) && !(subdomain && clientId && clientSecret)) {
    return json(res, 400, { error: "SFMC live mode needs subdomain, client id and client secret together." });
  }
  astra.configureSfmc(subdomain ? { subdomain, clientId, clientSecret } : null);
  json(res, 200, astra.sfmcStatus());
});

// Connect Claude Design via its MCP server, or disconnect (empty token).
route("POST", "/api/settings/claude-design", async (req, res, _p, body) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  try {
    const status = await astra.configureClaudeDesign(token ? { endpoint, token } : null);
    json(res, 200, status);
  } catch (err) {
    json(res, 400, { error: `Could not connect to Claude Design: ${(err as Error).message}` });
  }
});

// Integration status (spec §10.2) — connected connectors + the MVP-2 roadmap.
route("GET", "/api/admin/integrations", async (req, res) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  json(res, 200, {
    connected: astra.connectors.describe(),
    figma: astra.figmaStatus(),
    claudeDesign: astra.claudeDesignStatus(),
    sfmc: astra.sfmcStatus(),
    teams: astra.teamsStatus(),
    planned: [
      { name: "Salesforce Marketing Cloud", phase: "MVP-2" },
      { name: "Contentful", phase: "MVP-2" },
      { name: "DAM (Aprimo / Bynder / AEM)", phase: "MVP-2" },
      { name: "Jira", phase: "MVP-2" },
      { name: "Ad networks (Google / Meta / LinkedIn)", phase: "MVP-2" },
      { name: "GA4 / Adobe Analytics", phase: "MVP-2" },
    ],
  });
});

route("GET", "/api/campaigns/:id", async (req, res, p) => {
  const view = await astra.canvas(p.id!, viewerRole(req));
  if (!view) return json(res, 404, { error: "not found" });
  json(res, 200, view);
});

route("POST", "/api/campaigns", async (req, res, _p, body) => {
  const actor = actorFor(req);
  const decision = astra.access.canCreateCampaign(actor.role);
  if (!decision.allowed) return forbid(res, decision);
  // Accept the structured intake wizard fields (spec §6.0).
  const successMetric = typeof body.successMetric === "string" ? body.successMetric.trim() : "";
  const kpis = successMetric
    ? [successMetric]
    : Array.isArray(body.kpis) && body.kpis.length
      ? body.kpis
      : ["Qualified leads"];
  const markets =
    typeof body.markets === "string"
      ? body.markets.split(",").map((m: string) => m.trim()).filter(Boolean)
      : Array.isArray(body.markets) && body.markets.length
        ? body.markets
        : ["DE", "US"];
  const id = await astra.createCampaign(
    {
      objective: String(body.objective ?? "Untitled campaign"),
      owner: actor.id,
      markets,
      budget: Number(body.budget) > 0 ? Number(body.budget) : 250_000,
      currency: typeof body.currency === "string" && body.currency ? body.currency : "EUR",
      kpis,
      ...(typeof body.mandatoryClaims === "string" && body.mandatoryClaims.trim()
        ? { mandatoryClaims: body.mandatoryClaims.trim() }
        : {}),
    },
    actor,
  );
  // The creator can run agents, so draft the intake brief immediately from the inputs.
  if (astra.access.canRunAgents(actor.role).allowed) await runStage(id);
  await notifier.notify(id, "created", "New campaign created", `“${String(body.objective ?? "Untitled campaign")}” — created by ${actor.displayName}.`);
  json(res, 201, { id });
});

route("POST", "/api/campaigns/:id/run-stage", async (req, res, p) => {
  const actor = actorFor(req);
  const decision = astra.access.canRunAgents(actor.role);
  if (!decision.allowed) return forbid(res, decision);
  await runStage(p.id!);
  const view = await astra.canvas(p.id!, viewerRole(req));
  const pending = view?.artifacts.filter((a) => a.status === "in-review").length ?? 0;
  if (pending > 0) {
    await notifier.notify(
      p.id!,
      "review",
      `${pending} item${pending === 1 ? "" : "s"} awaiting review`,
      `${stageLabel(view!.campaign.currentStage)} · “${view!.campaign.objective}”.`,
    );
  }
  json(res, 200, view);
});

route("POST", "/api/campaigns/:id/approve", async (req, res, p, body) => {
  try {
    // Authority is enforced in the orchestrator via the role-carrying actor.
    await astra.orchestrator.approve(p.id!, String(body.artifactId), actorFor(req), body.note);
    await maybeCreateBoard(p.id!); // §11.3 Phase 1: board on Scope Brief approval
    await maybeAssembleBoard(p.id!); // §11.3 Phase 2: populate once sources are approved
    await maybeHarvestLearning(p.id!, String(body.artifactId)); // §6.7 learning loop
    json(res, 200, await astra.canvas(p.id!, viewerRole(req)));
  } catch (err) {
    const forbidden = (err as Error).name === "AccessDeniedError";
    json(res, forbidden ? 403 : 400, { error: (err as Error).message, forbidden });
  }
});

/** The learning loop hook (spec §6.7) — delegates to the runtime, then notifies. */
async function maybeHarvestLearning(campaignId: string, artifactId: string): Promise<void> {
  const harvested = await astra.harvestLearning(campaignId, artifactId);
  if (!harvested) return;
  await notifier.notify(
    campaignId,
    "advanced",
    "Learnings written back to the knowledge fabric",
    "The next campaign's planning agents will retrieve these insights automatically.",
  );
}

// Localisation Workbench (spec §8.2) — side-by-side source/target per market.
route("GET", "/api/campaigns/:id/localisation", async (req, res, p) => {
  const view = await astra.localisation(p.id!, viewerRole(req));
  if (!view) return json(res, 404, { error: "not found" });
  json(res, 200, view);
});

// Guest workspace assignments (Admin only, spec §5.1/§13).
route("GET", "/api/admin/guest-access", async (req, res) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  json(res, 200, { assigned: astra.guests.list(), campaigns: await astra.missionControl() });
});

route("POST", "/api/admin/guest-access", async (req, res, _p, body) => {
  const decision = astra.access.canAdmin(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  const campaignId = String(body.campaignId ?? "");
  if (!campaignId) return json(res, 400, { error: "campaignId is required." });
  if (body.allowed) astra.guests.assign(campaignId);
  else astra.guests.revoke(campaignId);
  json(res, 200, { assigned: astra.guests.list() });
});

// Performance & Optimisation surface (spec §8.2).
route("GET", "/api/campaigns/:id/performance", async (req, res, p) => {
  const view = await astra.performance(p.id!, viewerRole(req));
  if (!view) return json(res, 404, { error: "not found" });
  json(res, 200, view);
});

// Pull a fresh analytics snapshot (Performance Management Agent, L3 bounded-auto).
route("POST", "/api/campaigns/:id/refresh-metrics", async (req, res, p) => {
  const actor = actorFor(req);
  const decision = astra.access.canRunAgents(actor.role);
  if (!decision.allowed) return forbid(res, decision);
  const { performanceManagementAgent } = await import("../agents/optimisation");
  await astra.orchestrator.runAgent(p.id!, performanceManagementAgent);
  json(res, 200, await astra.performance(p.id!, viewerRole(req)));
});

// Roll back an applied optimisation action (spec §6.5 — reversible, human-initiated).
route("POST", "/api/campaigns/:id/rollback", async (req, res, p, body) => {
  const actor = actorFor(req);
  try {
    const rollback = await astra.rollbackAction(
      p.id!,
      String(body.artifactId),
      actor,
      String(body.reason ?? "Rolled back by the reviewer."),
    );
    await notifier.notify(
      p.id!,
      "changes",
      "Optimisation rolled back",
      `${actor.displayName} reversed “${rollback.title.replace("Rollback — ", "")}” — ${String(body.reason ?? "")}`,
    );
    json(res, 200, await astra.performance(p.id!, viewerRole(req)));
  } catch (err) {
    const forbidden = (err as Error).name === "AccessDeniedError";
    json(res, forbidden ? 403 : 400, { error: (err as Error).message, forbidden });
  }
});

// @mentions / hand-offs (spec §8.4): pull a persona into an artifact or decision.
route("POST", "/api/campaigns/:id/mention", async (req, res, p, body) => {
  const actor = actorFor(req);
  try {
    await astra.addMention(p.id!, String(body.artifactId), String(body.toRole), String(body.message ?? ""), actor);
    const obj = await astra.repo.load(p.id!);
    const artifactTitle = obj?.artifacts[String(body.artifactId)]?.title ?? "an item";
    const toLabel = getRole(String(body.toRole))?.label ?? String(body.toRole);
    await notifier.notify(
      p.id!,
      "mention",
      `${toLabel}, you're needed`,
      `${actor.displayName} pulled you into “${artifactTitle}”: “${String(body.message ?? "").trim()}”`,
    );
    json(res, 200, await astra.canvas(p.id!, viewerRole(req)));
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route("POST", "/api/campaigns/:id/mention/:mid/resolve", async (req, res, p) => {
  try {
    await astra.resolveMention(p.id!, p.mid!, actorFor(req));
    json(res, 200, await astra.canvas(p.id!, viewerRole(req)));
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

// Go-live (spec §6.4): explicit human authorisation for the irreversible publishes.
route("POST", "/api/campaigns/:id/golive", async (req, res, p) => {
  const actor = actorFor(req);
  const decision = astra.access.canGoLive(actor.role);
  if (!decision.allowed) return forbid(res, decision);
  try {
    const { executed } = await astra.goLive(p.id!, actor);
    await notifier.notify(
      p.id!,
      "golive",
      "Campaign is live",
      `${actor.displayName} authorised go-live: ${executed.map((e) => `${e.system} · ${e.title}`).join("; ")}.`,
    );
    json(res, 200, { executed, view: await astra.canvas(p.id!, viewerRole(req)) });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

route("POST", "/api/campaigns/:id/reject", async (req, res, p, body) => {
  // Requesting changes needs the same authority as approving (a reviewer action).
  const obj = await astra.repo.load(p.id!);
  const artifact = obj?.artifacts[String(body.artifactId)];
  if (artifact) {
    const decision = astra.access.canApprove(actorFor(req).role, artifact);
    if (!decision.allowed) return forbid(res, decision);
  }
  try {
    await astra.orchestrator.reject(p.id!, String(body.artifactId), actorFor(req), String(body.reason ?? "Requested changes"));
    json(res, 200, await astra.canvas(p.id!, viewerRole(req)));
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

// ── Deliverables (spec §9): rendered PPTX/XLSX views of the campaign object ──

// The deliverable catalogue for this campaign — availability tracks stage progress.
route("GET", "/api/campaigns/:id/deliverables", async (req, res, p) => {
  const obj = await astra.repo.load(p.id!);
  if (!obj) return json(res, 404, { error: "not found" });
  json(res, 200, { deliverables: listDeliverables(obj) });
});

// Download: rendered on demand from the CURRENT object (in sync by construction),
// validated against the brand template before it leaves the platform (§9.6).
route("GET", "/api/campaigns/:id/deliverables/:key", async (req, res, p) => {
  const obj = await astra.repo.load(p.id!);
  if (!obj) return json(res, 404, { error: "not found" });
  const rendered = await renderDeliverable(obj, p.key!);
  if (!rendered) return json(res, 404, { error: `No deliverable "${p.key}" available yet.` });
  const conformance = await validateDeliverable(rendered.format, rendered.buffer);
  res.writeHead(200, {
    "content-type": rendered.mime,
    "content-length": rendered.buffer.length,
    "content-disposition": `attachment; filename="${rendered.fileName}"`,
    "x-astra-template-conformance": conformance.passed ? "pass" : "fail",
  });
  res.end(rendered.buffer);
});

// Office round-trip (§9.5): upload the edited Marcom Plan → diff structured
// regions → confirm → apply as attributed human edits. Never a silent overwrite.
route("POST", "/api/campaigns/:id/deliverables/marcom-plan/ingest", async (req, res, p, body) => {
  const actor = actorFor(req);
  const decision = astra.access.canEdit(actor.role);
  if (!decision.allowed) return forbid(res, decision);
  const b64 = typeof body.fileBase64 === "string" ? body.fileBase64 : "";
  if (!b64) return json(res, 400, { error: "Attach the edited workbook (base64)." });
  let report;
  try {
    report = await diffMarcomPlan((await astra.repo.load(p.id!))!, Buffer.from(b64, "base64"));
  } catch {
    return json(res, 400, { error: "That file could not be read as an Excel workbook (.xlsx)." });
  }
  if (body.apply !== true) return json(res, 200, { ...report, applied: false });

  // Confirmed: each change becomes a human-authored version through the normal
  // versioning + eval machinery, attributed to the uploader (§9.5 provenance).
  const applied: string[] = [];
  for (const change of report.changes) {
    await astra.orchestrator.editArtifact(p.id!, change.artifactId, changeToFields(change), actor);
    applied.push(change.summary);
  }
  if (applied.length) {
    await notifier.notify(
      p.id!,
      "changes",
      "Marcom Plan reconciled from Excel",
      `${actor.displayName} edited the workbook offline — ${applied.join(" ")}`,
    );
  }
  json(res, 200, { ...report, applied: true, view: await astra.canvas(p.id!, viewerRole(req)) });
});

// Inline edit → a human-authored new version that re-runs the quality gates.
route("POST", "/api/campaigns/:id/edit", async (req, res, p, body) => {
  const actor = actorFor(req);
  const decision = astra.access.canEdit(actor.role);
  if (!decision.allowed) return forbid(res, decision);
  const fields = body.fields && typeof body.fields === "object" ? body.fields : {};
  try {
    const result = await astra.orchestrator.editArtifact(p.id!, String(body.artifactId), fields, actor);
    json(res, 200, {
      blocked: result.pendingHumanApproval === false && !result.autoApproved,
      reason: result.reason,
      view: await astra.canvas(p.id!, viewerRole(req)),
    });
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

// Request changes → record the feedback, then redraft with the producing agent.
route("POST", "/api/campaigns/:id/revise", async (req, res, p, body) => {
  const actor = actorFor(req);
  const obj = await astra.repo.load(p.id!);
  const artifact = obj?.artifacts[String(body.artifactId)];
  if (!artifact) return json(res, 404, { error: "Item not found." });

  const decision = astra.access.canApprove(actor.role, artifact);
  if (!decision.allowed) return forbid(res, decision);

  const feedback = String(body.feedback ?? "").trim() || "Please revise this item.";
  const agent = getAgentByName(artifact.author.displayName);
  try {
    await astra.orchestrator.reject(p.id!, artifact.id, actor, feedback);
    if (agent) {
      // Re-run the same agent with the feedback folded in; new draft supersedes the old.
      await astra.orchestrator.runAgent(p.id!, agent, { feedback, supersedes: artifact.id });
    }
    await notifier.notify(
      p.id!,
      "changes",
      `Changes requested on “${artifact.title}”`,
      `${actor.displayName}: “${feedback}”${agent ? " — a redraft is back in the review queue." : ""}`,
    );
    json(res, 200, { revised: Boolean(agent), view: await astra.canvas(p.id!, viewerRole(req)) });
  } catch (err) {
    const forbidden = (err as Error).name === "AccessDeniedError";
    json(res, forbidden ? 403 : 400, { error: (err as Error).message, forbidden });
  }
});

route("POST", "/api/campaigns/:id/advance", async (req, res, p) => {
  const actor = actorFor(req);
  const decision = astra.access.canAdvance(actor.role);
  if (!decision.allowed) return forbid(res, decision);
  const advanced = await astra.orchestrator.advanceStage(p.id!, actor);
  if (advanced) {
    const obj = await astra.repo.load(p.id!);
    await notifier.notify(
      p.id!,
      "advanced",
      `Campaign advanced to ${stageLabel(obj!.campaign.currentStage)}`,
      `“${obj!.campaign.objective}” — moved on by ${actor.displayName}.`,
    );
  }
  json(res, 200, { advanced, view: await astra.canvas(p.id!, viewerRole(req)) });
});

// Simulate a designer editing a Figma frame, then sync it back (spec §10.3).
// In live mode the simulate step is skipped: designers edit in Figma itself and
// the round-trip agent syncs the real file.
route("POST", "/api/campaigns/:id/figma-edit", async (req, res, p, body) => {
  const decision = astra.access.canRunAgents(actorFor(req).role);
  if (!decision.allowed) return forbid(res, decision);
  try {
    if (astra.figmaStatus().mode === "mock") {
      astra.figma.simulateDesignerEdit(p.id!, body.frame as FigmaFrame, String(body.content ?? ""));
    }
    await astra.orchestrator.runAgent(p.id!, figmaRoundTripAgent);
    json(res, 200, await astra.canvas(p.id!, viewerRole(req)));
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
  }
});

// Conversational rail (spec §8.4): a few natural commands routed to the orchestrator.
route("POST", "/api/campaigns/:id/command", async (req, res, p, body) => {
  const actor = actorFor(req);
  const text = String(body.text ?? "").toLowerCase();
  let reply = "";
  if (text.includes("run") && text.includes("stage")) {
    const d = astra.access.canRunAgents(actor.role);
    reply = d.allowed ? (await runStage(p.id!), "Ran the current stage — new proposals are in your review queue.") : d.reason;
  } else if (text.includes("approve all")) {
    // Only the items this role is authorised to approve (role-scoped queue).
    const view = await astra.canvas(p.id!, actor.role);
    let n = 0;
    for (const artId of view?.reviewQueue ?? []) {
      await astra.orchestrator.approve(p.id!, artId, actor, "Approved via command");
      await maybeHarvestLearning(p.id!, artId);
      n += 1;
    }
    await maybeCreateBoard(p.id!); // §11.3 Phase 1 (Scope Brief just approved?)
    await maybeAssembleBoard(p.id!); // §11.3 Phase 2 (sources just approved?)
    reply = `Approved ${n} item(s) in your review queue.`;
  } else if (text.includes("advance")) {
    const d = astra.access.canAdvance(actor.role);
    if (!d.allowed) reply = d.reason;
    else {
      const ok = await astra.orchestrator.advanceStage(p.id!, actor);
      reply = ok ? "Advanced to the next stage." : "Cannot advance yet — the stage gate isn't satisfied.";
    }
  // §8.3 natural language: "add a LinkedIn variant for the DACH market" — intent
  // maps to the specialist agent; authority and gates apply exactly as always.
  } else if (/linkedin/.test(text) && /(variant|version|post|copy|adapt|add|create|draft)/.test(text)) {
    const d = astra.access.canRunAgents(actor.role);
    if (!d.allowed) reply = d.reason;
    else {
      const agent = getAgentByName("Content Multiplier Agent")!;
      const result = await astra.orchestrator.runAgent(p.id!, agent);
      reply = `Drafted “${result.artifact.title}” with the Content Multiplier Agent — it's in the review queue, gates already run.`;
    }
  } else if (/\b(de|german|germany|dach)\b/.test(text) && /(variant|market|localis|translat|transcreat|adapt)/.test(text)) {
    const d = astra.access.canRunAgents(actor.role);
    if (!d.allowed) reply = d.reason;
    else {
      const agent = getAgentByName("Localisation / Transcreation Agent")!;
      const result = await astra.orchestrator.runAgent(p.id!, agent);
      reply = `Drafted “${result.artifact.title}” with the Localisation Agent — transcreated for the market, awaiting review (localisation-equivalence gate already run).`;
    }
  } else if (/(status|where are we|summary|progress|how far)/.test(text)) {
    const view = await astra.canvas(p.id!, actor.role);
    if (!view) reply = "I can't find that campaign.";
    else {
      const active = view.stageRail.find((s) => s.state === "active");
      const gate = active?.gate?.satisfied
        ? "the stage gate is satisfied — ready to advance"
        : `still needed: ${(active?.gate?.missing ?? []).join(", ") || "nothing"}`;
      reply =
        `“${view.campaign.objective}” is in ${stageLabel(view.campaign.currentStage)}: ` +
        `${view.artifacts.length} item(s) so far, ${view.reviewQueue.length} awaiting your sign-off, and ${gate}.`;
    }
  } else {
    reply =
      "Try: “run stage”, “approve all”, “advance”, “status” — or instruct me, e.g. “add a LinkedIn variant for the DACH market”.";
  }
  json(res, 200, { reply, view: await astra.canvas(p.id!, actor.role) });
});

// ── static + dispatch ─────────────────────────────────────────────────────────
async function serveIndex(res: ServerResponse): Promise<void> {
  try {
    const html = await readFile(join(HERE, "public", "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    res.writeHead(500);
    res.end("index.html not found");
  }
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      let parsed: any = {};
      if (data) {
        try { parsed = JSON.parse(data); } catch { parsed = {}; }
      }
      if (parsed && typeof parsed === "object") {
        // Raw body retained (non-enumerable) for HMAC signature verification.
        Object.defineProperty(parsed, "__raw", { value: data, enumerable: false });
      }
      resolve(parsed);
    });
  });
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0]!;
  const method = req.method ?? "GET";

  if (method === "GET" && (url === "/" || url === "/index.html")) return serveIndex(res);

  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(url);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
    // Guest scoping (spec §5.1/§13): agency partners may only touch campaigns an
    // admin assigned to them — enforced centrally for every campaign-scoped route.
    if (params.id && url.startsWith("/api/campaigns/") && !astra.guests.isAllowed(viewerRole(req), params.id)) {
      return json(res, 403, { error: "This campaign isn’t shared with your agency workspace.", forbidden: true });
    }
    const body = method === "GET" ? {} : await readBody(req);
    try {
      return await r.handler(req, res, params, body);
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  }
  json(res, 404, { error: `No route for ${method} ${url}` });
});

const PORT = Number(process.env.PORT ?? 4000);
// Optional boot-time Claude Design connect (async — can't run in the constructor).
if (process.env.CLAUDE_DESIGN_TOKEN) {
  astra
    .configureClaudeDesign({
      endpoint: process.env.CLAUDE_DESIGN_MCP_URL ?? "",
      token: process.env.CLAUDE_DESIGN_TOKEN,
    })
    .then((s) => console.log(`  Claude Design connected: ${s.serverName} (${s.tools.length} tools)`))
    .catch((err) => console.warn(`  Claude Design connect failed: ${(err as Error).message}`));
}
seedIfEmpty().then(() => {
  server.listen(PORT, () => {
    console.log(`\n  Astra Campaign Studio — Experience layer`);
    console.log(`  ▸ open  http://localhost:${PORT}\n`);
  });
});
