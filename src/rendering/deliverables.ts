import { ArtifactKind, ArtifactStatus, Stage, type Artifact, type CampaignObject } from "../domain/types";
import { deliverableFileName, MIME, type LineageEntry } from "./brandTemplate";
import { renderDeck, type DeckSpec } from "./deckRenderer";
import { renderWorkbook, type WorkbookSpec } from "./workbookRenderer";

/**
 * The deliverable catalogue (spec §9.4): every artifact exists simultaneously as
 * structured data and as a document. These are rendered VIEWS of the campaign
 * object — generated on demand from the current object state, so they are in
 * sync by construction ("documents are rendered views of it", §9).
 */

export interface DeliverableInfo {
  key: string;
  title: string;
  format: "pptx" | "xlsx";
  stage: Stage;
  description: string;
  available: boolean;
  /** Source artifacts (id + version) this rendering is traceable to (§13). */
  sources: { id: string; title: string; version: number }[];
}

export interface RenderedDeliverable extends DeliverableInfo {
  fileName: string;
  mime: string;
  buffer: Buffer;
}

interface DeliverableDef {
  key: string;
  title: string;
  format: "pptx" | "xlsx";
  stage: Stage;
  description: string;
  sources: (obj: CampaignObject) => Artifact[];
  build: (obj: CampaignObject, sources: Artifact[]) => Promise<Buffer>;
}

/** Latest non-rejected artifact of a kind (optionally by title fragment). */
function latest(obj: CampaignObject, kind: ArtifactKind, titleIncludes?: string): Artifact | undefined {
  return Object.values(obj.artifacts)
    .filter(
      (a) =>
        a.kind === kind &&
        a.status !== ArtifactStatus.Rejected &&
        a.status !== ArtifactStatus.Superseded &&
        (titleIncludes ? a.title.includes(titleIncludes) : true),
    )
    .sort((a, b) => b.version - a.version)[0];
}

function lineage(sources: Artifact[]): LineageEntry[] {
  return sources.map((a) => ({
    artifactId: a.id,
    title: a.title,
    version: a.version,
    status: a.status,
    author: a.author.displayName,
    evals: a.passedEvals.length ? a.passedEvals.join(", ") : "—",
  }));
}

const str = (v: unknown): string =>
  v === null || v === undefined
    ? "—"
    : typeof v === "string"
      ? v
      : typeof v === "number"
        ? v.toLocaleString("en-US")
        : Array.isArray(v)
          ? v.map(str).join("; ")
          : Object.entries(v as Record<string, unknown>)
              .map(([k, x]) => `${k}: ${str(x)}`)
              .join(" · ");

const kvRows = (body: Record<string, unknown>): [string, string][] =>
  Object.entries(body).map(([k, v]) => [humanKey(k), str(v)]);

function humanKey(k: string): string {
  return k
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

// ── Catalogue (§9.4) ──────────────────────────────────────────────────────────

const CATALOGUE: DeliverableDef[] = [
  {
    key: "campaign-brief",
    title: "Campaign brief",
    format: "pptx",
    stage: Stage.Intake,
    description: "The approved intake brief with research grounding and portfolio fit.",
    sources: (obj) =>
      [
        latest(obj, ArtifactKind.Brief),
        latest(obj, ArtifactKind.Note, "Intake research pack"),
        latest(obj, ArtifactKind.Note, "Portfolio fit score"),
      ].filter((a): a is Artifact => Boolean(a)),
    build: async (obj, sources) => {
      const [brief, research, fit] = [
        sources.find((s) => s.kind === ArtifactKind.Brief),
        sources.find((s) => s.title.includes("research")),
        sources.find((s) => s.title.includes("Portfolio")),
      ];
      const spec: DeckSpec = {
        title: "Campaign brief",
        subtitle: obj.campaign.objective,
        slides: [
          { heading: "The brief", blocks: [{ kind: "kv", rows: brief ? kvRows(brief.body) : [] }] },
          ...(research
            ? [{ heading: "Research grounding", blocks: [{ kind: "kv" as const, rows: kvRows(research.body) }] }]
            : []),
          ...(fit
            ? [{ heading: "Portfolio fit", blocks: [{ kind: "kv" as const, rows: kvRows(fit.body) }] }]
            : []),
        ],
        lineage: lineage(sources),
      };
      return renderDeck(spec);
    },
  },
  {
    key: "marcom-strategy",
    title: "Marcom strategy",
    format: "pptx",
    stage: Stage.CampaignPlanning,
    description: "Positioning, messaging architecture, value proposition and competitive stance.",
    sources: (obj) =>
      [
        latest(obj, ArtifactKind.Strategy),
        latest(obj, ArtifactKind.ValueProp),
        latest(obj, ArtifactKind.Messaging),
        latest(obj, ArtifactKind.CompetitiveInsight),
        latest(obj, ArtifactKind.Audience),
      ].filter((a): a is Artifact => Boolean(a)),
    build: async (obj, sources) => {
      const strategy = sources.find((s) => s.kind === ArtifactKind.Strategy);
      const valueProp = sources.find((s) => s.kind === ArtifactKind.ValueProp);
      const messaging = sources.find((s) => s.kind === ArtifactKind.Messaging);
      const competitive = sources.find((s) => s.kind === ArtifactKind.CompetitiveInsight);
      const audience = sources.find((s) => s.kind === ArtifactKind.Audience);
      const pillars = (messaging?.body.pillars ?? []) as { message: string; proof: string }[];
      const segments = (audience?.body.segments ?? []) as {
        name: string;
        size?: string;
        contacts?: number;
        consentedReach?: number;
        priority: number;
      }[];
      const spec: DeckSpec = {
        title: "Marcom strategy",
        subtitle: obj.campaign.objective,
        slides: [
          { heading: "Strategy & objective", blocks: [{ kind: "kv", rows: strategy ? kvRows(strategy.body) : [] }] },
          {
            heading: "Message architecture",
            blocks: [
              {
                kind: "table",
                header: ["Message pillar", "Proof point"],
                rows: pillars.map((p) => [p.message, p.proof]),
              },
            ],
          },
          {
            heading: "Value proposition",
            blocks: [{ kind: "kv", rows: valueProp ? kvRows(valueProp.body) : [] }],
          },
          {
            heading: "Audiences",
            blocks: [
              {
                kind: "table",
                header: ["Segment", "Contacts", "Consented reach", "Priority"],
                rows: segments.map((s) => [
                  s.name,
                  s.contacts != null ? s.contacts.toLocaleString("en-US") : (s.size ?? "—"),
                  s.consentedReach != null ? s.consentedReach.toLocaleString("en-US") : "—",
                  String(s.priority),
                ]),
              },
              ...(audience?.body.sizedFrom
                ? [{ kind: "bullets" as const, items: [`Sizing source: ${String(audience.body.sizedFrom)}`] }]
                : []),
            ],
          },
          {
            heading: "Competitive positioning",
            blocks: [{ kind: "kv", rows: competitive ? kvRows(competitive.body) : [] }],
          },
        ],
        lineage: lineage(sources),
      };
      return renderDeck(spec);
    },
  },
  {
    key: "marcom-plan",
    title: "Marcom Plan — channel & media",
    format: "xlsx",
    stage: Stage.CampaignPlanning,
    description:
      "Consolidated channel & media plan with budget, pacing and locked KPIs. Editable in Excel and re-ingestible (§9.5).",
    sources: (obj) =>
      [
        latest(obj, ArtifactKind.MediaPlan),
        latest(obj, ArtifactKind.Budget),
        latest(obj, ArtifactKind.Kpi),
        latest(obj, ArtifactKind.ContentCalendar),
      ].filter((a): a is Artifact => Boolean(a)),
    build: async (obj, sources) => {
      const media = sources.find((s) => s.kind === ArtifactKind.MediaPlan);
      const budget = sources.find((s) => s.kind === ArtifactKind.Budget);
      const kpi = sources.find((s) => s.kind === ArtifactKind.Kpi);
      const calendar = sources.find((s) => s.kind === ArtifactKind.ContentCalendar);
      const channels = (media?.body.channels ?? []) as { channel: string; role: string; budgetShare: number }[];
      const total = Number(media?.body.totalBudget ?? obj.campaign.budget);
      const targets = (kpi?.body.targets ?? {}) as Record<string, number>;
      const guardrails = (kpi?.body.guardrails ?? {}) as Record<string, number>;
      const entries = (calendar?.body.entries ?? []) as { week: number; channel: string; deliverable: string }[];
      const spec: WorkbookSpec = {
        title: "Marcom Plan",
        sheets: [
          {
            name: "Channel & budget",
            header: ["Channel", "Role", "Budget share", `Budget (${obj.campaign.currency})`],
            rows: channels.map((c) => [c.channel, c.role, c.budgetShare, Math.round(c.budgetShare * total)]),
            anchor: "astra_channel_budget",
            widths: [22, 16, 14, 18],
          },
          {
            name: "Pacing & guardrails",
            header: ["Field", "Value"],
            rows: budget ? Object.entries(budget.body).map(([k, v]) => [humanKey(k), str(v)]) : [],
            widths: [28, 46],
          },
          {
            name: "Locked KPIs",
            header: ["Metric", "Value", "Type"],
            rows: [
              ...Object.entries(targets).map(([k, v]): (string | number)[] => [humanKey(k), v, "target"]),
              ...Object.entries(guardrails).map(([k, v]): (string | number)[] => [humanKey(k), v, "guardrail"]),
            ],
            anchor: "astra_locked_kpis",
            widths: [28, 16, 14],
          },
          ...(entries.length
            ? [
                {
                  name: "Calendar",
                  header: ["Week", "Channel", "Deliverable"],
                  rows: entries.map((e): (string | number)[] => [e.week, e.channel, e.deliverable]),
                  widths: [10, 18, 40],
                },
              ]
            : []),
        ],
        lineage: lineage(sources),
      };
      return renderWorkbook(spec);
    },
  },
  {
    key: "concept-deck",
    title: "Creative concept",
    format: "pptx",
    stage: Stage.ContentPlanning,
    description: "The selected concept, ranked alternatives and the hero storyboard.",
    sources: (obj) =>
      [latest(obj, ArtifactKind.Concept), latest(obj, ArtifactKind.Storyboard)].filter((a): a is Artifact =>
        Boolean(a),
      ),
    build: async (obj, sources) => {
      const concept = sources.find((s) => s.kind === ArtifactKind.Concept);
      const storyboard = sources.find((s) => s.kind === ArtifactKind.Storyboard);
      const frames = (storyboard?.body.frames ?? []) as { beat: string; note: string }[];
      const spec: DeckSpec = {
        title: "Creative concept",
        subtitle: String(concept?.body.selected ?? obj.campaign.objective),
        slides: [
          { heading: "Selected concept", blocks: [{ kind: "kv", rows: concept ? kvRows(concept.body) : [] }] },
          {
            heading: "Hero storyboard",
            blocks: [
              { kind: "table", header: ["Beat", "Direction"], rows: frames.map((f) => [f.beat, f.note]) },
            ],
          },
        ],
        lineage: lineage(sources),
      };
      return renderDeck(spec);
    },
  },
  {
    key: "scope-brief",
    title: "Campaign Scope Brief",
    format: "pptx",
    stage: Stage.ContentPlanning,
    description: "The versioned contract between planning and creation (§6.2).",
    sources: (obj) =>
      [
        latest(obj, ArtifactKind.CreativeBrief),
        latest(obj, ArtifactKind.Journey),
        latest(obj, ArtifactKind.PdpPlan),
        latest(obj, ArtifactKind.Kpi),
      ].filter((a): a is Artifact => Boolean(a)),
    build: async (obj, sources) => {
      const brief = sources.find((s) => s.kind === ArtifactKind.CreativeBrief);
      const journey = sources.find((s) => s.kind === ArtifactKind.Journey);
      const pdp = sources.find((s) => s.kind === ArtifactKind.PdpPlan);
      const kpi = sources.find((s) => s.kind === ArtifactKind.Kpi);
      const touches = (journey?.body.touches ?? []) as { step: number; channel: string; goal: string; trigger: string }[];
      const spec: DeckSpec = {
        title: "Campaign Scope Brief",
        subtitle: obj.campaign.objective,
        slides: [
          { heading: "Scope & mandatories", blocks: [{ kind: "kv", rows: brief ? kvRows(brief.body) : [] }] },
          ...(kpi ? [{ heading: "Locked KPIs", blocks: [{ kind: "kv" as const, rows: kvRows(kpi.body) }] }] : []),
          {
            heading: "Nurture journey",
            blocks: [
              {
                kind: "table",
                header: ["Step", "Channel", "Goal", "Trigger"],
                rows: touches.map((t) => [String(t.step), t.channel, t.goal, t.trigger]),
              },
            ],
          },
          ...(pdp ? [{ heading: "PDP content plan", blocks: [{ kind: "kv" as const, rows: kvRows(pdp.body) }] }] : []),
        ],
        lineage: lineage(sources),
      };
      return renderDeck(spec);
    },
  },
  {
    key: "copy-matrix",
    title: "Content summary & copy matrix",
    format: "xlsx",
    stage: Stage.ContentCreation,
    description: "Every content item and asset across channels — the hand-off workbook (§9.4).",
    sources: (obj) =>
      Object.values(obj.artifacts).filter(
        (a) =>
          (a.kind === ArtifactKind.ContentItem || a.kind === ArtifactKind.Asset) &&
          a.stage === Stage.ContentCreation &&
          a.status !== ArtifactStatus.Rejected &&
          a.status !== ArtifactStatus.Superseded,
      ),
    build: async (_obj, sources) => {
      const items = sources.filter((s) => s.kind === ArtifactKind.ContentItem);
      const assets = sources.filter((s) => s.kind === ArtifactKind.Asset);
      const spec: WorkbookSpec = {
        title: "Content summary",
        sheets: [
          {
            name: "Copy matrix",
            header: ["Item", "Channel", "Market", "Status", "Headline / subject", "Body", "Footnote"],
            rows: items.map((a) => {
              const b = a.body as Record<string, unknown>;
              return [
                a.title,
                str(b.channel),
                str(b.market ?? "all"),
                a.status,
                str(b.headline ?? b.subject ?? b.hero),
                str(b.body ?? b.content ?? b.sections),
                str(b.footnote),
              ];
            }),
            widths: [34, 14, 10, 14, 40, 50, 40],
          },
          {
            name: "Assets",
            header: ["Asset", "Status", "Preview URL", "Alt text", "Generated via"],
            rows: assets.map((a) => {
              const b = a.body as Record<string, unknown>;
              return [a.title, a.status, str(b.imageUrl ?? b.boardId), str(b.altText), str(b.generatedVia ?? "—")];
            }),
            widths: [34, 14, 34, 40, 18],
          },
        ],
        lineage: lineage(sources),
      };
      return renderWorkbook(spec);
    },
  },
  {
    key: "launch-runbook",
    title: "Launch runbook & QA checklist",
    format: "xlsx",
    stage: Stage.Rollout,
    description: "Prepared deployments, pre-flight QA and the consent check (§9.4, MVP-2).",
    sources: (obj) =>
      Object.values(obj.artifacts).filter(
        (a) =>
          a.stage === Stage.Rollout &&
          a.status !== ArtifactStatus.Rejected &&
          a.status !== ArtifactStatus.Superseded,
      ),
    build: async (_obj, sources) => {
      const deployments = sources.filter((s) => s.kind === ArtifactKind.Deployment);
      const qa = sources.find((s) => s.title.includes("Pre-flight QA"));
      const consent = sources.find((s) => s.title.includes("Consent"));
      const checks = (qa?.body.checks ?? []) as { check: string; result: string }[];
      const spec: WorkbookSpec = {
        title: "Launch runbook",
        sheets: [
          {
            name: "Deployments",
            header: ["Deployment", "System", "Channel", "Status"],
            rows: deployments.map((d) => {
              const b = d.body as Record<string, unknown>;
              return [d.title, str(b.system), str(b.channel), d.status];
            }),
            widths: [42, 16, 16, 14],
          },
          {
            name: "QA checklist",
            header: ["Check", "Result"],
            rows: [
              ...checks.map((c): (string | number)[] => [c.check, c.result]),
              ...(consent ? [["Consent & preference check", str(consent.body.status)] as (string | number)[]] : []),
            ],
            widths: [50, 14],
          },
        ],
        lineage: lineage(sources),
      };
      return renderWorkbook(spec);
    },
  },
  {
    key: "performance-report",
    title: "Performance & learning report",
    format: "pptx",
    stage: Stage.CampaignOptimisation,
    description: "KPIs, budget moves, experiment readout and harvested learnings (§9.4, MVP-2).",
    sources: (obj) =>
      Object.values(obj.artifacts).filter(
        (a) =>
          (a.stage === Stage.CampaignOptimisation || a.stage === Stage.ContentOptimisation) &&
          a.status !== ArtifactStatus.Rejected &&
          a.status !== ArtifactStatus.Superseded,
      ),
    build: async (obj, sources) => {
      const slides = sources.slice(0, 8).map((a) => ({
        heading: a.title,
        blocks: [{ kind: "kv" as const, rows: kvRows(a.body) }],
      }));
      const spec: DeckSpec = {
        title: "Performance & learning report",
        subtitle: obj.campaign.objective,
        slides,
        lineage: lineage(sources),
      };
      return renderDeck(spec);
    },
  },
];

// ── Public API ────────────────────────────────────────────────────────────────

export function listDeliverables(obj: CampaignObject): DeliverableInfo[] {
  return CATALOGUE.map((def) => {
    const sources = def.sources(obj);
    return {
      key: def.key,
      title: def.title,
      format: def.format,
      stage: def.stage,
      description: def.description,
      available: sources.length > 0,
      sources: sources.map((a) => ({ id: a.id, title: a.title, version: a.version })),
    };
  });
}

export async function renderDeliverable(obj: CampaignObject, key: string): Promise<RenderedDeliverable | null> {
  const def = CATALOGUE.find((d) => d.key === key);
  if (!def) return null;
  const sources = def.sources(obj);
  if (sources.length === 0) return null;
  const buffer = await def.build(obj, sources);
  return {
    key: def.key,
    title: def.title,
    format: def.format,
    stage: def.stage,
    description: def.description,
    available: true,
    sources: sources.map((a) => ({ id: a.id, title: a.title, version: a.version })),
    fileName: deliverableFileName(def.key, def.format),
    mime: MIME[def.format],
    buffer,
  };
}
