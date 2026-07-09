import type { CampaignEvent } from "../domain/events";
import {
  ArtifactStatus,
  STAGE_ORDER,
  Stage,
  type Artifact,
  type CampaignObject,
} from "../domain/types";
import { AuditTrail, type AuditRecord } from "../governance/audit";
import { gateStatus } from "../orchestration/stateMachine";
import { AccessControl, getRole } from "../security/roles";

/**
 * Read-model projections for the Experience layer (spec §8). Every surface —
 * Mission Control, the Campaign Canvas, the Review inbox — is a projection of the
 * one event log. No copies, no drift, one source of truth (§8.1).
 */

export interface EvalView {
  name: string;
  passed: boolean;
  score: number;
  detail: string;
}

/** An artifact enriched with its explainability data (rationale + evals) for the UI. */
export interface ArtifactView {
  id: string;
  kind: string;
  stage: Stage;
  title: string;
  version: number;
  status: ArtifactStatus;
  author: string;
  /** Provenance for EU AI Act transparency (§14): agent output vs human authorship. */
  authorKind: "human" | "agent" | "system";
  createdAt: string;
  /** Review SLA (§10.1): when an in-review item is due, and whether it's overdue. */
  reviewDueBy: string | null;
  reviewOverdue: boolean;
  body: Record<string, unknown>;
  citations: { sourceId: string; title: string; version: string }[];
  rationale: string;
  evals: EvalView[];
  derivedFrom: string[];
  /** Whether the current viewer's role may approve this artifact (spec §5.2). */
  canApprove: boolean;
  /** Hand-offs threaded on this artifact (§8.4 @mentions). */
  mentions: {
    id: string;
    from: string;
    toRole: string;
    toRoleLabel: string;
    message: string;
    resolved: boolean;
    /** Whether the current viewer may close this hand-off. */
    canResolve: boolean;
  }[];
}

/** The current viewer's persona lens (spec §5.1) — what this role may do here. */
export interface ViewerLens {
  role: string;
  label: string;
  home: string;
  canRunAgents: boolean;
  canEdit: boolean;
  canAdvance: boolean;
  canAdmin: boolean;
  canGoLive: boolean;
}

export interface StageRailEntry {
  stage: Stage;
  state: "done" | "active" | "upcoming";
  gate?: { satisfied: boolean; missing: string[] };
}

export interface CampaignCanvasView {
  campaign: {
    id: string;
    objective: string;
    currentStage: Stage;
    status: string;
    markets: string[];
    budget: number;
    currency: string;
    kpis: string[];
  };
  stageRail: StageRailEntry[];
  artifacts: ArtifactView[];
  reviewQueue: string[]; // artifact ids the current viewer may act on
  /** Open hand-offs targeting the current viewer's role (§8.4). */
  myMentions: { id: string; artifactId: string; artifactTitle: string; from: string; message: string; at: string }[];
  activity: AuditRecord[];
  telemetry: {
    artifacts: number;
    events: number;
    connectorCalls: number;
    evalPassRate: number;
    /** §14.1: rework rate — share of items a human sent back at least once. */
    reworkRate: number;
    /** §14.1: average human-edit distance (0..1) across human-edited versions. */
    humanEditDistance: number | null;
    /** §14.1: cost per approved item — model tokens / approved artifacts. */
    tokensSpent: number;
    costPerApprovedItem: number | null;
  };
  viewer: ViewerLens;
}

/** Normalised word-level edit distance between two artifact bodies (0 = identical). */
export function editDistanceRatio(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const words = (body: Record<string, unknown>) =>
    Object.values(body)
      .filter((v): v is string => typeof v === "string")
      .join(" ")
      .split(/\s+/)
      .filter(Boolean);
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 && wb.length === 0) return 0;
  // LCS length → distance = 1 - 2·LCS/(|a|+|b|)  (bodies are short; quadratic is fine).
  const dp = Array.from({ length: wa.length + 1 }, () => new Array<number>(wb.length + 1).fill(0));
  for (let i = wa.length - 1; i >= 0; i--)
    for (let j = wb.length - 1; j >= 0; j--)
      dp[i]![j] = wa[i] === wb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  return Math.round((1 - (2 * dp[0]![0]!) / (wa.length + wb.length)) * 100) / 100;
}

export interface MissionControlEntry {
  id: string;
  objective: string;
  currentStage: Stage;
  status: string;
  pendingApprovals: number;
  artifacts: number;
  approvedItems: number;
  evalPassRate: number;
  budget: number;
  currency: string;
  markets: string[];
  /** 0..1 — how far along the seven-stage lifecycle. */
  progress: number;
}

/** Portfolio rollup for the Mission Control surface (spec §5.1 CMO/Leader, §8.2). */
export interface PortfolioView {
  campaigns: MissionControlEntry[];
  totals: {
    campaigns: number;
    activeCampaigns: number;
    pendingApprovals: number;
    itemsProduced: number;
    approvedItems: number;
    avgQualityPass: number;
    totalBudget: number;
    currency: string;
    openRisks: number;
  };
  /** Number of campaigns currently in each stage (the pipeline). */
  pipeline: { stage: Stage; count: number }[];
  /** Average time each stage has taken across the portfolio, from the event log. */
  cycleTime: { stage: Stage; avgMs: number; samples: number }[];
  /** Whether live spend/ROI is connected (MVP-2: finance & analytics). */
  roiConnected: boolean;
}

// ── Performance & Optimisation surface (spec §8.2) ────────────────────────────

export interface PerformanceChannelRow {
  channel: string;
  impressions: number;
  clicks: number;
  ctr: number;
  spend: number;
  leads: number;
  cpl: number;
}

export interface PerformanceView {
  available: boolean;
  kpi: { primary: string | null; leadTarget: number | null; ctrTarget: number | null; maxCpl: number | null };
  totals: { leads: number; spend: number; blendedCpl: number | null; observations: number };
  latest: PerformanceChannelRow[];
  /** Per-channel CTR/CPL/leads across observations — the fatigue trend. */
  series: { channel: string; points: { observation: number; ctr: number; cpl: number; leads: number }[] }[];
  budgetMoves: {
    id: string;
    title: string;
    from: string;
    to: string;
    share: number;
    applied: boolean;
    reason: string;
    isRollback: boolean;
    rolledBack: boolean;
    /** Whether the current viewer may roll this applied action back (§6.5). */
    canRollback: boolean;
  }[];
  experiments: { title: string; hypothesis: string; split: string; readout: string }[];
  /** Experiment readouts (§6.5 "reads experiments") with the applied decision. */
  readouts: { title: string; winner: string; lift: string; confidence: string; decision: string }[];
  anomalies: { signal: string; severity: string; pattern: string }[];
}

/** Build the §8.2 Performance surface from the campaign's Metric/KPI/Note artifacts. */
export function performanceView(
  obj: CampaignObject,
  access?: AccessControl,
  viewerRole?: string,
): PerformanceView {
  const all = Object.values(obj.artifacts);

  const kpiArtifact = all.find((a) => a.kind === "kpi" && a.status === ArtifactStatus.Approved);
  const kpiBody = (kpiArtifact?.body ?? {}) as {
    primary?: string;
    targets?: { qualifiedLeads?: number; paidSocialCtr?: number };
    guardrails?: { maxCpl?: number };
  };

  const snapshots = all
    .filter((a) => a.title === "Performance snapshot" && a.status !== ArtifactStatus.Rejected)
    .map((a) => a.body as { observation?: number; channels?: PerformanceChannelRow[]; totals?: { leads: number; spend: number } })
    .filter((b) => Array.isArray(b.channels) && b.channels.length > 0)
    .sort((a, b) => (a.observation ?? 0) - (b.observation ?? 0));

  const totals = snapshots.reduce(
    (acc, s) => ({ leads: acc.leads + (s.totals?.leads ?? 0), spend: acc.spend + (s.totals?.spend ?? 0) }),
    { leads: 0, spend: 0 },
  );

  const channels = [...new Set(snapshots.flatMap((s) => s.channels!.map((c) => c.channel)))];
  const series = channels.map((channel) => ({
    channel,
    points: snapshots.map((s) => {
      const row = s.channels!.find((c) => c.channel === channel);
      return { observation: s.observation ?? 0, ctr: row?.ctr ?? 0, cpl: row?.cpl ?? 0, leads: row?.leads ?? 0 };
    }),
  }));

  const rolledBackIds = new Set(
    all
      .filter((a) => a.status !== ArtifactStatus.Rejected)
      .map((a) => (a.body as { rollbackOf?: string }).rollbackOf)
      .filter((id): id is string => Boolean(id)),
  );

  const budgetMoves = all
    .filter((a) => {
      const action = (a.body as { action?: string }).action;
      return (action === "reallocate" || action === "rollback") && a.status !== ArtifactStatus.Rejected;
    })
    .map((a) => {
      const b = a.body as { action?: string; from?: string; to?: string; share?: number; reason?: string; reversible?: boolean };
      const applied = a.status === ArtifactStatus.Approved;
      const isRollback = b.action === "rollback";
      const rolledBack = rolledBackIds.has(a.id);
      return {
        id: a.id,
        title: a.title,
        from: b.from ?? "",
        to: b.to ?? "",
        share: b.share ?? 0,
        applied,
        reason: b.reason ?? "",
        isRollback,
        rolledBack,
        canRollback:
          applied &&
          !isRollback &&
          !rolledBack &&
          b.reversible === true &&
          Boolean(access && viewerRole && access.canApprove(viewerRole, a).allowed),
      };
    });

  const experiments = all
    .filter((a) => (a.body as { hypothesis?: string }).hypothesis)
    .map((a) => {
      const b = a.body as { hypothesis: string; split?: string; readout?: string };
      return { title: a.title, hypothesis: b.hypothesis, split: b.split ?? "", readout: b.readout ?? "" };
    });

  const readouts = all
    .filter((a) => (a.body as { winner?: string }).winner && a.status !== ArtifactStatus.Rejected)
    .map((a) => {
      const b = a.body as { winner: string; lift?: string; confidence?: string; decision?: string };
      return { title: a.title, winner: b.winner, lift: b.lift ?? "", confidence: b.confidence ?? "", decision: b.decision ?? "" };
    });

  const anomalies = all
    .filter((a) => Array.isArray((a.body as { findings?: unknown[] }).findings))
    .flatMap((a) => (a.body as { findings: { signal?: string; severity?: string; pattern?: string }[] }).findings)
    .map((f) => ({ signal: f.signal ?? "", severity: f.severity ?? "", pattern: f.pattern ?? "" }));

  return {
    available: snapshots.length > 0,
    kpi: {
      primary: kpiBody.primary ?? null,
      leadTarget: kpiBody.targets?.qualifiedLeads ?? null,
      ctrTarget: kpiBody.targets?.paidSocialCtr ?? null,
      maxCpl: kpiBody.guardrails?.maxCpl ?? null,
    },
    totals: {
      ...totals,
      blendedCpl: totals.leads ? Math.round(totals.spend / totals.leads) : null,
      observations: snapshots.length,
    },
    latest: snapshots.length ? snapshots[snapshots.length - 1]!.channels! : [],
    series,
    budgetMoves,
    experiments,
    readouts,
    anomalies,
  };
}

// ── Localisation Workbench (spec §8.2 — side-by-side source/target) ───────────

export interface LocalisationPair {
  market: string;
  target: { id: string; title: string; status: ArtifactStatus; stage: Stage; body: Record<string, unknown>; canApprove: boolean };
  source: { id: string; title: string; body: Record<string, unknown> } | null;
  /** The localisation-equivalence outcome for the target, when it has run. */
  equivalence: { passed: boolean; detail: string } | null;
}

export interface LocalisationView {
  pairs: LocalisationPair[];
  markets: string[];
}

/** Market-by-market adaptation view: every artifact carrying a `market` body field,
 * paired with the source it derives from (spec §8.2 Localisation Workbench). */
export function localisationView(
  obj: CampaignObject,
  events: CampaignEvent[],
  access: AccessControl = new AccessControl(),
  viewerRole = "localisation",
): LocalisationView {
  const evalIndex = new Map<string, { passed: boolean; detail: string }>();
  for (const e of events) {
    if (e.body.type === "ArtifactEvaluated" && e.body.evalName === "localisation-equivalence") {
      evalIndex.set(e.body.artifactId, { passed: e.body.passed, detail: e.body.detail });
    }
  }

  const pairs: LocalisationPair[] = Object.values(obj.artifacts)
    .filter((a) => typeof (a.body as { market?: unknown }).market === "string" && a.status !== ArtifactStatus.Rejected)
    .map((a) => {
      const source = a.derivedFrom.map((id) => obj.artifacts[id]).find((s) => s && s.kind === a.kind) ?? null;
      return {
        market: String((a.body as { market: string }).market),
        target: {
          id: a.id,
          title: a.title,
          status: a.status,
          stage: a.stage,
          body: a.body,
          canApprove: a.status === ArtifactStatus.InReview && access.canApprove(viewerRole, a).allowed,
        },
        source: source ? { id: source.id, title: source.title, body: source.body } : null,
        equivalence: evalIndex.get(a.id) ?? null,
      };
    })
    .sort((a, b) => a.market.localeCompare(b.market));

  return { pairs, markets: [...new Set(pairs.map((p) => p.market))] };
}

/** Index rationale + per-eval outcomes from the event stream, keyed by artifact id. */
function explainability(events: CampaignEvent[]): {
  rationale: Map<string, string>;
  evals: Map<string, EvalView[]>;
} {
  const rationale = new Map<string, string>();
  const evals = new Map<string, EvalView[]>();
  for (const e of events) {
    if (e.body.type === "ArtifactProposed") {
      rationale.set(e.body.artifact.id, e.body.rationale);
    } else if (e.body.type === "ArtifactEvaluated") {
      const list = evals.get(e.body.artifactId) ?? [];
      list.push({ name: e.body.evalName, passed: e.body.passed, score: e.body.score, detail: e.body.detail });
      evals.set(e.body.artifactId, list);
    }
  }
  return { rationale, evals };
}

/**
 * Review SLAs per stage (spec §10.1 "approval workflows with clear owners and
 * SLAs") — hours an item may sit in review before it counts as overdue.
 */
const REVIEW_SLA_HOURS: Record<Stage, number> = {
  [Stage.Intake]: 24,
  [Stage.CampaignPlanning]: 48,
  [Stage.ContentPlanning]: 48,
  [Stage.ContentCreation]: 24,
  [Stage.Rollout]: 12,
  [Stage.CampaignOptimisation]: 24,
  [Stage.ContentOptimisation]: 48,
};

function reviewSla(a: Artifact): { dueBy: string | null; overdue: boolean } {
  if (a.status !== ArtifactStatus.InReview) return { dueBy: null, overdue: false };
  const due = Date.parse(a.createdAt) + REVIEW_SLA_HOURS[a.stage] * 3_600_000;
  return { dueBy: new Date(due).toISOString(), overdue: Date.now() > due };
}

function toArtifactView(
  a: Artifact,
  rationale: string,
  evals: EvalView[],
  canApprove: boolean,
  mentions: ArtifactView["mentions"] = [],
): ArtifactView {
  const sla = reviewSla(a);
  return {
    mentions,
    id: a.id,
    kind: a.kind,
    stage: a.stage,
    title: a.title,
    version: a.version,
    status: a.status,
    author: a.author.displayName,
    authorKind: a.author.kind,
    createdAt: a.createdAt,
    reviewDueBy: sla.dueBy,
    reviewOverdue: sla.overdue,
    body: a.body,
    citations: a.citations.map((c) => ({ sourceId: c.sourceId, title: c.title, version: c.version })),
    rationale,
    evals,
    derivedFrom: a.derivedFrom,
    canApprove,
  };
}

function evalPassRate(evals: Map<string, EvalView[]>): number {
  let total = 0;
  let passed = 0;
  for (const list of evals.values()) {
    for (const e of list) {
      total += 1;
      if (e.passed) passed += 1;
    }
  }
  return total === 0 ? 1 : Math.round((passed / total) * 100) / 100;
}

const DEFAULT_ROLE = "campaign-manager";

/** The signature Campaign Canvas surface (spec §8.3), rendered through a role lens (§5.1). */
export function campaignCanvas(
  obj: CampaignObject,
  events: CampaignEvent[],
  access: AccessControl = new AccessControl(),
  viewerRole: string = DEFAULT_ROLE,
  tokensSpent = 0,
): CampaignCanvasView {
  const { rationale, evals } = explainability(events);
  const currentIndex = STAGE_ORDER.indexOf(obj.campaign.currentStage);
  const role = getRole(viewerRole) ?? getRole(DEFAULT_ROLE)!;

  const stageRail: StageRailEntry[] = STAGE_ORDER.map((stage, i) => {
    const state: StageRailEntry["state"] = i < currentIndex ? "done" : i === currentIndex ? "active" : "upcoming";
    if (state === "active") {
      const g = gateStatus(obj);
      return { stage, state, gate: { satisfied: g.satisfied, missing: g.missing.map(String) } };
    }
    return { stage, state };
  });

  const canAdminRole = access.canAdmin(role.id).allowed;
  const mentionViews = (artifactId: string) =>
    obj.mentions
      .filter((m) => m.artifactId === artifactId)
      .map((m) => ({
        id: m.id,
        from: m.from,
        toRole: m.toRole,
        toRoleLabel: getRole(m.toRole)?.label ?? m.toRole,
        message: m.message,
        resolved: m.resolved,
        canResolve: !m.resolved && (m.toRole === role.id || canAdminRole),
      }));

  const artifacts = Object.values(obj.artifacts).map((a) =>
    toArtifactView(
      a,
      rationale.get(a.id) ?? "",
      evals.get(a.id) ?? [],
      access.canApprove(role.id, a).allowed,
      mentionViews(a.id),
    ),
  );
  artifacts.sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));

  // The review queue is role-scoped: a Brand Guardian sees brand items, Legal sees
  // claim-bearing ones, etc. — "one object, many lenses" (spec §8.1).
  const reviewQueue = artifacts
    .filter((a) => a.status === ArtifactStatus.InReview && a.canApprove)
    .map((a) => a.id);
  const connectorCalls = events.filter((e) => e.body.type === "ConnectorInvoked").length;

  // §14.1 delivery telemetry — computed from the event log, not self-reported.
  const allArtifacts = Object.values(obj.artifacts);
  const rejectedIds = new Set(
    events.filter((e) => e.body.type === "ArtifactRejected").map((e) => (e.body as { artifactId: string }).artifactId),
  );
  const reworkedTitles = new Set(
    allArtifacts.filter((a) => rejectedIds.has(a.id)).map((a) => `${a.kind}|${a.title}`),
  );
  const distinctTitles = new Set(allArtifacts.map((a) => `${a.kind}|${a.title}`));
  const reworkRate = distinctTitles.size ? Math.round((reworkedTitles.size / distinctTitles.size) * 100) / 100 : 0;

  // Human-edit distance: human-authored versions vs. the predecessor they edited.
  const editDistances = allArtifacts
    .filter((a) => a.author.kind === "human" && a.derivedFrom.length > 0)
    .map((a) => {
      const prev = a.derivedFrom.map((id) => obj.artifacts[id]).find((p) => p && p.kind === a.kind && p.title === a.title);
      return prev ? editDistanceRatio(prev.body, a.body) : null;
    })
    .filter((d): d is number => d !== null);
  const humanEditDistance = editDistances.length
    ? Math.round((editDistances.reduce((x, y) => x + y, 0) / editDistances.length) * 100) / 100
    : null;

  const approvedCount = allArtifacts.filter((a) => a.status === ArtifactStatus.Approved).length;
  const costPerApprovedItem = approvedCount > 0 && tokensSpent > 0 ? Math.round(tokensSpent / approvedCount) : null;

  return {
    campaign: {
      id: obj.campaign.id,
      objective: obj.campaign.objective,
      currentStage: obj.campaign.currentStage,
      status: obj.campaign.status,
      markets: obj.campaign.markets,
      budget: obj.campaign.budget,
      currency: obj.campaign.currency,
      kpis: obj.campaign.kpis,
    },
    stageRail,
    artifacts,
    reviewQueue,
    myMentions: obj.mentions
      .filter((m) => !m.resolved && m.toRole === role.id)
      .map((m) => ({
        id: m.id,
        artifactId: m.artifactId,
        artifactTitle: obj.artifacts[m.artifactId]?.title ?? "an item",
        from: m.from,
        message: m.message,
        at: m.at,
      })),
    // Resolve artifact ids to their titles so the feed reads in plain language.
    activity: AuditTrail.from(events, (id) => obj.artifacts[id]?.title).reverse(),
    telemetry: {
      artifacts: artifacts.length,
      events: events.length,
      connectorCalls,
      evalPassRate: evalPassRate(evals),
      reworkRate,
      humanEditDistance,
      tokensSpent,
      costPerApprovedItem,
    },
    viewer: {
      role: role.id,
      label: role.label,
      home: role.home,
      canRunAgents: role.canRunAgents,
      canEdit: role.canEdit,
      canAdvance: role.canAdvance,
      canAdmin: role.canAdmin,
      canGoLive: role.canGoLive,
    },
  };
}

/** A single Mission Control row for a campaign (spec §8.2). */
export function missionControlEntry(obj: CampaignObject, events: CampaignEvent[]): MissionControlEntry {
  const { evals } = explainability(events);
  const all = Object.values(obj.artifacts);
  const pending = all.filter((a) => a.status === ArtifactStatus.InReview).length;
  const approved = all.filter((a) => a.status === ArtifactStatus.Approved).length;
  const idx = STAGE_ORDER.indexOf(obj.campaign.currentStage);
  return {
    id: obj.campaign.id,
    objective: obj.campaign.objective,
    currentStage: obj.campaign.currentStage,
    status: obj.campaign.status,
    pendingApprovals: pending,
    artifacts: all.length,
    approvedItems: approved,
    evalPassRate: evalPassRate(evals),
    budget: obj.campaign.budget,
    currency: obj.campaign.currency,
    markets: obj.campaign.markets,
    progress: idx / (STAGE_ORDER.length - 1),
  };
}

/** Count of items currently signalling risk: rejected (changes requested) or gate-blocked. */
function openRiskCount(obj: CampaignObject): number {
  return Object.values(obj.artifacts).filter(
    (a) => a.status === ArtifactStatus.Rejected || a.status === ArtifactStatus.Proposed,
  ).length;
}

/** Per-stage durations for one campaign, derived from stage-entry timestamps. */
function stageDurations(events: CampaignEvent[]): { stage: Stage; ms: number }[] {
  const entries: { stage: Stage; atMs: number }[] = [];
  for (const e of events) {
    if (e.body.type === "CampaignCreated") entries.push({ stage: Stage.Intake, atMs: Date.parse(e.at) });
    else if (e.body.type === "StageAdvanced") entries.push({ stage: e.body.to, atMs: Date.parse(e.at) });
  }
  const out: { stage: Stage; ms: number }[] = [];
  for (let i = 0; i < entries.length - 1; i++) {
    out.push({ stage: entries[i]!.stage, ms: entries[i + 1]!.atMs - entries[i]!.atMs });
  }
  return out;
}

/** The Mission Control portfolio rollup (spec §5.1 CMO/Leader). */
export function portfolio(items: { obj: CampaignObject; events: CampaignEvent[] }[]): PortfolioView {
  const campaigns = items.map(({ obj, events }) => missionControlEntry(obj, events));
  const currency = campaigns[0]?.currency ?? "EUR";

  const totals = {
    campaigns: campaigns.length,
    activeCampaigns: campaigns.filter((c) => c.status === "active").length,
    pendingApprovals: sum(campaigns.map((c) => c.pendingApprovals)),
    itemsProduced: sum(campaigns.map((c) => c.artifacts)),
    approvedItems: sum(campaigns.map((c) => c.approvedItems)),
    avgQualityPass: campaigns.length
      ? Math.round((sum(campaigns.map((c) => c.evalPassRate)) / campaigns.length) * 100) / 100
      : 1,
    totalBudget: sum(campaigns.map((c) => c.budget)),
    currency,
    openRisks: sum(items.map(({ obj }) => openRiskCount(obj))),
  };

  const pipeline = STAGE_ORDER.map((stage) => ({
    stage,
    count: campaigns.filter((c) => c.currentStage === stage).length,
  }));

  // Average time in each stage across every campaign that has left that stage.
  const acc = new Map<Stage, { total: number; n: number }>();
  for (const { events } of items) {
    for (const d of stageDurations(events)) {
      const cur = acc.get(d.stage) ?? { total: 0, n: 0 };
      cur.total += d.ms;
      cur.n += 1;
      acc.set(d.stage, cur);
    }
  }
  const cycleTime = STAGE_ORDER.filter((s) => acc.has(s)).map((stage) => {
    const { total, n } = acc.get(stage)!;
    return { stage, avgMs: Math.round(total / n), samples: n };
  });

  return { campaigns, totals, pipeline, cycleTime, roiConnected: false };
}

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}
