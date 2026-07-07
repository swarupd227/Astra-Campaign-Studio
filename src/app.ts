import { newId, systemClock, type Clock } from "./domain/ids";
import { ArtifactKind, ArtifactStatus, Stage, type Actor, type Campaign } from "./domain/types";
import { CampaignRepository } from "./store/campaignRepository";
import { FileEventStore, InMemoryEventStore, type EventStore } from "./store/eventStore";
import { SqlEventStore } from "./store/sql/sqlEventStore";
import { createPgClient, createPgliteClient, type SqlClient } from "./store/sql/client";
import { ModelGateway } from "./gateway/modelGateway";
import {
  InMemoryVectorFabric,
  seedHiltiKnowledge,
  type KnowledgeDoc,
  type KnowledgeFabric,
} from "./grounding/knowledgeFabric";
import { PgVectorFabric } from "./grounding/pgVectorFabric";
import { mvp1EvalHarness } from "./evals/evaluators";
import { GoldenSetStore, hiltiGoldenSet } from "./evals/goldenSet";
import { PolicyEngine } from "./governance/policy";
import { AuditTrail, type AuditRecord } from "./governance/audit";
import { Orchestrator, type RunResult } from "./orchestration/orchestrator";
import { StageOrchestrator } from "./orchestration/stageOrchestrator";
import { ConnectorRegistry } from "./integrations/mcp";
import { FigmaConnector, FIGMA_SCOPES, type FigmaLiveConfig } from "./integrations/figma";
import { CLAUDE_DESIGN_SCOPE, ClaudeDesignConnector, type ClaudeDesignConfig } from "./integrations/claudeDesign";
import { TeamsConnector, type TeamsConfig } from "./integrations/teams";
import {
  AdNetworkConnector,
  ContentfulConnector,
  DamConnector,
  JiraConnector,
  SfmcConnector,
  PUBLISHING_SCOPES,
} from "./integrations/publishing";
import { AnalyticsConnector, ANALYTICS_SCOPES } from "./integrations/analytics";
import { AccessControl, getRole } from "./security/roles";
import { mergeHits, sanitiseUntrusted } from "./security/contentSafety";
import {
  campaignCanvas,
  localisationView,
  missionControlEntry,
  performanceView,
  portfolio,
  type CampaignCanvasView,
  type LocalisationView,
  type MissionControlEntry,
  type PerformanceView,
  type PortfolioView,
} from "./experience/projections";
import { GuestAccess } from "./security/guestAccess";

export interface AstraConfig {
  /**
   * Event-store backend:
   *  - "memory": in-process, ephemeral (tests)
   *  - "file":   JSON-per-campaign (simple local dev)
   *  - "sql":    Postgres — embedded PGlite by default, or real Postgres when
   *              DATABASE_URL is set. Pass dataDir ":memory:" for an ephemeral DB.
   */
  persistence?: "memory" | "file" | "sql";
  dataDir?: string;
  clock?: Clock;
  anthropicApiKey?: string;
  defaultModel?: string;
  campaignTokenBudget?: number;
  /** Override the Postgres connection string (defaults to process.env.DATABASE_URL). */
  databaseUrl?: string;
}

/**
 * The Astra foundation composition root — wires the six Common Foundation
 * services (spec §9) into a single runtime: model gateway, grounding, evals,
 * governance, the event-sourced campaign object, and the orchestrator.
 * The Experience layer and MVP-2 integrations build on this facade.
 */
export class Astra {
  readonly store: EventStore;
  readonly repo: CampaignRepository;
  readonly gateway: ModelGateway;
  readonly fabric: KnowledgeFabric;
  readonly policy: PolicyEngine;
  readonly orchestrator: Orchestrator;
  readonly connectors: ConnectorRegistry;
  readonly figma: FigmaConnector;
  readonly claudeDesign: ClaudeDesignConnector;
  readonly teams: TeamsConnector;
  readonly access: AccessControl;
  /** Campaign-scoped access for guest roles (spec §5.1 agency partner, §13). */
  readonly guests = new GuestAccess();
  /** Admin-tunable golden set + the eval feedback loop (spec §9.2). */
  readonly golden: GoldenSetStore;
  private readonly clock: Clock;
  /** Shared SQL client when the "sql" backend is active (event log + knowledge fabric). */
  private sqlClient?: SqlClient;

  constructor(config: AstraConfig = {}) {
    this.clock = config.clock ?? systemClock;
    this.store = this.buildStore(config);
    this.repo = new CampaignRepository(this.store);
    this.gateway = new ModelGateway({
      defaultModel: config.defaultModel ?? process.env.ASTRA_DEFAULT_MODEL ?? "claude-opus-4-8",
      campaignTokenBudget:
        config.campaignTokenBudget ?? Number(process.env.ASTRA_CAMPAIGN_TOKEN_BUDGET ?? 0),
      ...(config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY
        ? { anthropicApiKey: config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY }
        : {}),
    });
    // Knowledge fabric (spec §9.3): vector + lexical hybrid retrieval. On the SQL
    // backend it persists in Postgres/pgvector (shares the event-log database);
    // otherwise an in-memory vector index with the same pipeline.
    this.fabric = this.sqlClient
      ? new PgVectorFabric(this.sqlClient, seedHiltiKnowledge())
      : new InMemoryVectorFabric(seedHiltiKnowledge());
    this.policy = new PolicyEngine();

    // MCP-first integrations (spec §10.1). The registry records every connector
    // call in the same campaign audit trail as agent and human actions.
    this.connectors = new ConnectorRegistry(async (campaignId, record) => {
      await this.store.append(
        campaignId,
        { type: "ConnectorInvoked", ...record },
        { kind: "system", id: "mcp", displayName: "MCP Registry" },
        -1, // additive audit event; no optimistic-concurrency check
      );
    });
    this.figma = new FigmaConnector();
    // Token-optional live mode: real Figma REST API when credentials are provided.
    if (process.env.FIGMA_TOKEN && process.env.FIGMA_FILE_KEY) {
      this.figma.configure({ token: process.env.FIGMA_TOKEN, fileKey: process.env.FIGMA_FILE_KEY });
    }
    this.connectors.register(this.figma);
    // Claude Design (Anthropic Labs) via its MCP server — connected from Admin settings
    // (or CLAUDE_DESIGN_TOKEN at launch); unconfigured it simply reports not-connected.
    this.claudeDesign = new ClaudeDesignConnector();
    this.connectors.register(this.claudeDesign);
    // Teams notifications (spec §10.2, MVP-1) — token-optional: in-app feed always,
    // channel delivery when a Workflows webhook URL is configured.
    this.teams = new TeamsConnector();
    if (process.env.TEAMS_WEBHOOK_URL) this.teams.configure({ webhookUrl: process.env.TEAMS_WEBHOOK_URL });
    this.connectors.register(this.teams);
    // MVP-2 publishing & analytics stack (spec §10.2) — governed mocks with the
    // same live-API seams as Figma; irreversible tools stay behind go-live approval.
    for (const c of [
      new ContentfulConnector(),
      new DamConnector(),
      new SfmcConnector(),
      new AdNetworkConnector(),
      new JiraConnector(),
      new AnalyticsConnector(),
    ]) {
      this.connectors.register(c);
    }
    this.access = new AccessControl();
    this.golden = new GoldenSetStore(hiltiGoldenSet(), () => this.clock.now());

    this.orchestrator = new Orchestrator(
      this.store,
      this.gateway,
      this.fabric,
      mvp1EvalHarness(),
      this.policy,
      this.clock,
      {
        connectors: this.connectors,
        // Agents read/assemble via connectors; irreversible publish/send scopes are
        // NOT granted here — go-live executes those with explicit human approval.
        agentScopes: [FIGMA_SCOPES.read, FIGMA_SCOPES.write, ANALYTICS_SCOPES.read, CLAUDE_DESIGN_SCOPE],
        access: this.access,
        // §9.2 feedback loop: evals grade against the LIVE golden set, and human
        // rejections of gate-passing copy flow back as tuning suggestions.
        goldenSource: () => this.golden.current(),
        onReject: (artifact, reason) => {
          const body = artifact.body as { headline?: string; body?: string };
          const text = body.headline ?? body.body;
          if (artifact.kind === "content-item" && typeof text === "string" && text.trim()) {
            this.golden.suggest(text, reason, artifact.title);
          }
        },
      },
    );
  }

  /** Select the event-store backend (spec §11.2 — the one seam that swaps for Postgres). */
  private buildStore(config: AstraConfig): EventStore {
    const now = () => this.clock.now();
    if (config.persistence === "sql") {
      const connectionString = config.databaseUrl ?? process.env.DATABASE_URL;
      const client = connectionString
        ? createPgClient(connectionString)
        : createPgliteClient(config.dataDir ?? ".data/pg"); // embedded Postgres (WASM)
      this.sqlClient = client; // shared with the pgvector knowledge fabric
      return new SqlEventStore(client, now);
    }
    if (config.persistence === "file") {
      return new FileEventStore(config.dataDir ?? ".data", now);
    }
    return new InMemoryEventStore(now);
  }

  /** Create a new campaign object (the first event on its stream). */
  async createCampaign(input: Omit<Campaign, "id" | "status" | "currentStage" | "createdAt">, creator: Actor): Promise<string> {
    const campaign: Campaign = {
      ...input,
      id: newId("camp"),
      status: "active",
      currentStage: Stage.Intake,
      createdAt: this.clock.now(),
    };
    await this.store.append(campaign.id, { type: "CampaignCreated", campaign }, creator, 0);
    return campaign.id;
  }

  /**
   * Build a stage orchestrator wired to this runtime. The caller supplies the
   * human checkpoint (the demo auto-approves; the UI resolves a real reviewer).
   */
  stageOrchestrator(
    approver: (result: RunResult) => Promise<{ approve: boolean; actor: Actor; note?: string }>,
  ): StageOrchestrator {
    return new StageOrchestrator(this.orchestrator, this.repo, approver);
  }

  /**
   * Go-live (spec §6.4): executes the approved deployments' irreversible connector
   * calls (publish, send, launch). Refuses unless (a) the campaign is at Roll-out,
   * (b) the consent & preference check is approved and passing, and (c) there is at
   * least one approved deployment. The connector registry additionally requires the
   * explicit approval flag on every irreversible tool — enforced twice, by design.
   */
  async goLive(campaignId: string, actor: Actor): Promise<{ executed: { system: string; tool: string; title: string }[] }> {
    const obj = await this.repo.load(campaignId);
    if (!obj) throw new Error(`Campaign ${campaignId} not found`);
    if (obj.campaign.currentStage !== Stage.Rollout) {
      throw new Error("Go-live is only available at the Roll-out stage.");
    }

    const consent = Object.values(obj.artifacts).find(
      (a) => a.title === "Consent & preference check" && a.stage === Stage.Rollout,
    );
    if (!consent || consent.status !== "approved" || (consent.body as { status?: string }).status !== "pass") {
      throw new Error("Go-live blocked: the consent & preference check must be approved and passing first.");
    }

    const deployments = Object.values(obj.artifacts).filter(
      (a) => a.kind === "deployment" && a.stage === Stage.Rollout && a.status === "approved",
    );
    if (deployments.length === 0) {
      throw new Error("Go-live blocked: no approved deployments yet.");
    }

    const executed: { system: string; tool: string; title: string }[] = [];
    for (const d of deployments) {
      const body = d.body as { system?: string; tool?: string; title?: string; name?: string };
      if (!body.system || !body.tool) continue;
      await this.connectors.invoke(body.system, body.tool, d.body, {
        campaignId,
        actor,
        grantedScopes: PUBLISHING_SCOPES,
        approved: true, // the explicit human go-live approval (spec §6.4)
      });
      executed.push({ system: body.system, tool: body.tool, title: body.title ?? body.name ?? d.title });
    }
    return { executed };
  }

  /**
   * The learning loop (spec §6.7): write an APPROVED Learning artifact's insight
   * back into the knowledge fabric so the next campaign's planning agents retrieve
   * it like any other grounded source. Returns null when there is nothing to harvest.
   */
  async harvestLearning(campaignId: string, artifactId: string) {
    const obj = await this.repo.load(campaignId);
    const a = obj?.artifacts[artifactId];
    if (!a || a.kind !== ArtifactKind.Learning || a.status !== ArtifactStatus.Approved) return null;
    const body = a.body as { insight?: string; appliesTo?: string };
    if (!body.insight) return null;
    return this.ingestKnowledge({
      id: `learning-${campaignId}`,
      title: `Campaign learnings — ${obj!.campaign.objective.slice(0, 60)}`,
      domain: "history",
      version: "1.0",
      text: `${body.insight}${body.appliesTo ? ` Applies to: ${body.appliesTo}.` : ""}`,
    });
  }

  /**
   * @mention / hand-off (spec §8.4): pull a persona into an artifact or decision.
   * Recorded as an event — auditable, replayable, and surfaced in the target
   * role's inbox. Returns the mention id.
   */
  async addMention(campaignId: string, artifactId: string, toRole: string, message: string, actor: Actor): Promise<string> {
    const obj = await this.repo.load(campaignId);
    if (!obj) throw new Error(`Campaign ${campaignId} not found`);
    if (!obj.artifacts[artifactId]) throw new Error(`Unknown artifact ${artifactId}`);
    if (!getRole(toRole)) throw new Error(`Unknown role "${toRole}".`);
    const text = message.trim();
    if (!text) throw new Error("A hand-off needs a message.");
    const mentionId = newId("men");
    await this.store.append(
      campaignId,
      { type: "MentionAdded", mentionId, artifactId, toRole, message: text },
      actor,
      obj.revision,
    );
    return mentionId;
  }

  /** Close a hand-off — the mentioned role (or an admin) marks it done. */
  async resolveMention(campaignId: string, mentionId: string, actor: Actor): Promise<void> {
    const obj = await this.repo.load(campaignId);
    if (!obj) throw new Error(`Campaign ${campaignId} not found`);
    const mention = obj.mentions.find((m) => m.id === mentionId);
    if (!mention) throw new Error("Unknown hand-off.");
    if (mention.resolved) throw new Error("This hand-off is already closed.");
    const isTarget = actor.role === mention.toRole;
    const isAdmin = actor.role ? this.access.canAdmin(actor.role).allowed : false;
    if (actor.role && !isTarget && !isAdmin) {
      throw new Error(`Only the ${getRole(mention.toRole)?.label ?? mention.toRole} (or an admin) can close this hand-off.`);
    }
    await this.store.append(campaignId, { type: "MentionResolved", mentionId }, actor, obj.revision);
  }

  /** Trust & safety counters at ingestion time (secrets redacted, injections neutralised). */
  private knowledgeSafetyHits: Record<string, number> = {};

  /**
   * Ingest (or replace) a knowledge document: sanitise → chunk → embed → index.
   * Documents are untrusted input (spec §13): secrets are redacted and
   * instruction-like content neutralised BEFORE anything is indexed, so a
   * poisoned document can't steer agents or leak credentials via retrieval.
   */
  async ingestKnowledge(doc: KnowledgeDoc) {
    const swept = sanitiseUntrusted(doc.text);
    this.knowledgeSafetyHits = mergeHits(this.knowledgeSafetyHits, swept.hits);
    const info = await this.fabric.ingest({ ...doc, text: swept.text });
    return { ...info, safety: swept.hits };
  }

  /** Consolidated Trust & safety report (spec §14.1) across all three seams. */
  safetyReport() {
    return {
      modelPrompts: this.gateway.safety(), // PII/secrets redacted before providers
      connectorResults: this.connectors.safety(), // injections neutralised in tool results
      knowledgeIngestion: { ...this.knowledgeSafetyHits },
    };
  }

  /** Indexed knowledge sources (Admin console → Knowledge fabric). */
  async knowledgeSources() {
    return this.fabric.listSources();
  }

  /** Figma connection status + runtime configuration (Admin only, enforced at the API). */
  figmaStatus() {
    return this.figma.status();
  }
  configureFigma(cfg: FigmaLiveConfig | null): void {
    this.figma.configure(cfg);
  }

  /** Teams connection status + runtime configuration (Admin only). */
  teamsStatus() {
    return this.teams.status();
  }
  configureTeams(cfg: TeamsConfig | null): void {
    this.teams.configure(cfg);
  }

  /** Claude Design connection status + runtime configuration (Admin only). */
  claudeDesignStatus() {
    return this.claudeDesign.status();
  }
  async configureClaudeDesign(cfg: ClaudeDesignConfig | null) {
    return this.claudeDesign.configure(cfg);
  }

  /** Non-secret model-gateway status for the Admin Settings page (spec §9.4/§9.5). */
  gatewayStatus() {
    return this.gateway.status();
  }

  /** Set/clear the Claude API key at runtime (Admin only, enforced at the API). */
  setAnthropicKey(key: string | null): void {
    this.gateway.setAnthropicKey(key);
  }

  async auditTrail(campaignId: string): Promise<AuditRecord[]> {
    const obj = await this.repo.load(campaignId);
    const events = await this.store.read(campaignId);
    return AuditTrail.from(events, (id) => obj?.artifacts[id]?.title);
  }

  /** Campaign Canvas view model for the Experience layer (spec §8.3), through a role lens (§5.1). */
  async canvas(campaignId: string, viewerRole?: string): Promise<CampaignCanvasView | null> {
    const obj = await this.repo.load(campaignId);
    if (!obj) return null;
    return campaignCanvas(
      obj,
      await this.store.read(campaignId),
      this.access,
      viewerRole,
      this.gateway.spent(campaignId), // §14.1 cost-per-asset input
    );
  }

  /** Mission Control rows for the campaign picker (spec §8.2). */
  async missionControl(): Promise<MissionControlEntry[]> {
    const ids = await this.store.listCampaigns();
    const rows: MissionControlEntry[] = [];
    for (const id of ids) {
      const obj = await this.repo.load(id);
      if (obj) rows.push(missionControlEntry(obj, await this.store.read(id)));
    }
    return rows;
  }

  /** The Localisation Workbench (spec §8.2 — side-by-side source/target per market). */
  async localisation(campaignId: string, viewerRole?: string): Promise<LocalisationView | null> {
    const obj = await this.repo.load(campaignId);
    if (!obj) return null;
    return localisationView(obj, await this.store.read(campaignId), this.access, viewerRole);
  }

  /** The Performance & Optimisation surface (spec §8.2) for one campaign. */
  async performance(campaignId: string, viewerRole?: string): Promise<PerformanceView | null> {
    const obj = await this.repo.load(campaignId);
    return obj ? performanceView(obj, this.access, viewerRole) : null;
  }

  /** Roll back an applied optimisation action (spec §6.5). */
  async rollbackAction(campaignId: string, artifactId: string, actor: Actor, reason: string) {
    return this.orchestrator.rollbackArtifact(campaignId, artifactId, actor, reason);
  }

  /** The Mission Control portfolio rollup (spec §5.1 CMO/Leader). */
  async portfolio(): Promise<PortfolioView> {
    const ids = await this.store.listCampaigns();
    const items = [];
    for (const id of ids) {
      const obj = await this.repo.load(id);
      if (obj) items.push({ obj, events: await this.store.read(id) });
    }
    return portfolio(items);
  }
}
