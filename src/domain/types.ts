import { z } from "zod";

/**
 * The six-stage campaign lifecycle (plus Stage 0 intake), per spec §4.1.
 * The learning loop (∞) is modelled as a post-optimisation feedback event, not a stage.
 */
export const Stage = {
  Intake: "intake",
  CampaignPlanning: "campaign-planning",
  ContentPlanning: "content-planning",
  ContentCreation: "content-creation",
  Rollout: "rollout",
  CampaignOptimisation: "campaign-optimisation",
  ContentOptimisation: "content-optimisation",
} as const;
export type Stage = (typeof Stage)[keyof typeof Stage];

/** Ordered stages — the orchestrator advances a campaign along this spine. */
export const STAGE_ORDER: Stage[] = [
  Stage.Intake,
  Stage.CampaignPlanning,
  Stage.ContentPlanning,
  Stage.ContentCreation,
  Stage.Rollout,
  Stage.CampaignOptimisation,
  Stage.ContentOptimisation,
];

/** MVP-1 covers stages 0–3 only (spec §4.2). */
export const MVP1_STAGES: Stage[] = [
  Stage.Intake,
  Stage.CampaignPlanning,
  Stage.ContentPlanning,
  Stage.ContentCreation,
];

/**
 * Autonomy dial (spec §7.2) — set per role/stage/action in policy, never hard-coded in an agent.
 * L0 assistive → L4 autonomous.
 */
export const AutonomyLevel = {
  Assistive: "L0",
  Draft: "L1",
  SupervisedAuto: "L2",
  BoundedAuto: "L3",
  Autonomous: "L4",
} as const;
export type AutonomyLevel = (typeof AutonomyLevel)[keyof typeof AutonomyLevel];

/** Lifecycle status of any artifact on the campaign object. */
export const ArtifactStatus = {
  Proposed: "proposed", // an agent proposed it; awaiting evals/approval
  InReview: "in-review", // passed evals, queued for a human
  Approved: "approved", // a human approved it
  Rejected: "rejected", // a human rejected it
  Superseded: "superseded", // replaced by a newer version
} as const;
export type ArtifactStatus = (typeof ArtifactStatus)[keyof typeof ArtifactStatus];

/**
 * The typed artifact kinds that live on the campaign object (spec §12 data model,
 * expanded to the granular outputs of the §7.3 agent catalogue so lineage is
 * first-class — each planning/creation agent contributes a distinct, cited artifact).
 */
export const ArtifactKind = {
  // Stage 0 · Intake
  Brief: "brief",
  // Stage 1 · Campaign Planning
  Strategy: "strategy",
  Audience: "audience",
  ValueProp: "value-prop",
  Messaging: "messaging",
  MediaPlan: "media-plan",
  Budget: "budget",
  CompetitiveInsight: "competitive-insight",
  Kpi: "kpi",
  // Stage 2 · Content Planning
  Concept: "concept",
  Storyboard: "storyboard",
  ContentCalendar: "content-calendar",
  CreativeBrief: "creative-brief",
  Journey: "journey",
  PdpPlan: "pdp-plan",
  // Stage 3 · Content Creation
  ContentItem: "content-item",
  Asset: "asset",
  // Later stages (spec §12)
  Deployment: "deployment",
  Metric: "metric",
  Learning: "learning",
  // Cross-cutting working artifact (supporting analysis that informs a primary output)
  Note: "note",
} as const;
export type ArtifactKind = (typeof ArtifactKind)[keyof typeof ArtifactKind];

/** A grounding citation attached to any generated artifact (spec §9.3). */
export const CitationSchema = z.object({
  sourceId: z.string(),
  title: z.string(),
  version: z.string(),
  snippet: z.string(),
});
export type Citation = z.infer<typeof CitationSchema>;

/** Author of a change — human or agent — recorded on every artifact for lineage. */
export const ActorSchema = z.object({
  kind: z.enum(["human", "agent", "system"]),
  id: z.string(),
  displayName: z.string(),
  /** The persona/role this actor is acting as (spec §5). Drives authority checks. */
  role: z.string().optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

/**
 * A single versioned artifact. Records author, grounding, evals passed and lineage
 * to upstream artifacts — the "content lineage is first-class" requirement (§12).
 */
export const ArtifactSchema = z.object({
  id: z.string(),
  kind: z.nativeEnum(ArtifactKind),
  stage: z.nativeEnum(Stage),
  version: z.number().int().positive(),
  status: z.nativeEnum(ArtifactStatus),
  title: z.string(),
  /** Free-form typed payload; each kind carries its own shape. */
  body: z.record(z.unknown()),
  author: ActorSchema,
  citations: z.array(CitationSchema).default([]),
  /** IDs of eval runs this artifact has passed (see evals module). */
  passedEvals: z.array(z.string()).default([]),
  /** IDs of upstream artifacts this was derived from. */
  derivedFrom: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/** Top-level campaign fields (spec §12 "Campaign" entity). */
export const CampaignSchema = z.object({
  id: z.string(),
  objective: z.string(),
  owner: z.string(),
  markets: z.array(z.string()),
  budget: z.number().nonnegative(),
  currency: z.string().default("EUR"),
  status: z.enum(["draft", "active", "paused", "completed", "archived"]),
  currentStage: z.nativeEnum(Stage),
  kpis: z.array(z.string()).default([]),
  /** Regulated claims captured at intake that every downstream asset must respect (spec §6.0). */
  mandatoryClaims: z.string().optional(),
  createdAt: z.string(),
});
export type Campaign = z.infer<typeof CampaignSchema>;

/** A hand-off pulled onto an artifact (@mention, spec §8.4). */
export interface MentionRecord {
  id: string;
  artifactId: string;
  from: string;
  fromRole?: string;
  toRole: string;
  message: string;
  at: string;
  resolved: boolean;
}

/** The materialised campaign object — a campaign plus all its artifacts, keyed by id. */
export interface CampaignObject {
  campaign: Campaign;
  artifacts: Record<string, Artifact>;
  /** Open + resolved hand-offs (@mentions), oldest first. */
  mentions: MentionRecord[];
  /** Version of the event stream this state was rebuilt from. */
  revision: number;
}
