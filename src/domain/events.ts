import { z } from "zod";
import { ActorSchema, ArtifactSchema, CampaignSchema, Stage } from "./types";

/**
 * The campaign object is event-sourced (spec §11.2): a single, versioned,
 * append-only event log is the source of truth. Materialised state is a fold
 * over these events, so every run is auditable and replayable.
 */

export const CampaignCreated = z.object({
  type: z.literal("CampaignCreated"),
  campaign: CampaignSchema,
});

export const ArtifactProposed = z.object({
  type: z.literal("ArtifactProposed"),
  artifact: ArtifactSchema,
  /** Human-readable rationale the reviewer sees (spec §7.4 explainability). */
  rationale: z.string(),
});

export const ArtifactEvaluated = z.object({
  type: z.literal("ArtifactEvaluated"),
  artifactId: z.string(),
  evalId: z.string(),
  evalName: z.string(),
  passed: z.boolean(),
  score: z.number(),
  detail: z.string(),
});

export const ArtifactApproved = z.object({
  type: z.literal("ArtifactApproved"),
  artifactId: z.string(),
  approver: ActorSchema,
  note: z.string().optional(),
});

export const ArtifactRejected = z.object({
  type: z.literal("ArtifactRejected"),
  artifactId: z.string(),
  approver: ActorSchema,
  reason: z.string(),
});

export const StageAdvanced = z.object({
  type: z.literal("StageAdvanced"),
  from: z.nativeEnum(Stage),
  to: z.nativeEnum(Stage),
});

export const StageGateBlocked = z.object({
  type: z.literal("StageGateBlocked"),
  stage: z.nativeEnum(Stage),
  reason: z.string(),
});

/**
 * @mention / hand-off (spec §8.4): a human pulls a colleague or agency partner
 * into an artifact or decision. Event-sourced like everything else, so hand-offs
 * are auditable and replayable.
 */
export const MentionAdded = z.object({
  type: z.literal("MentionAdded"),
  mentionId: z.string(),
  artifactId: z.string(),
  /** Persona the hand-off targets (role id from the catalogue). */
  toRole: z.string(),
  message: z.string(),
});

export const MentionResolved = z.object({
  type: z.literal("MentionResolved"),
  mentionId: z.string(),
});

/**
 * A governed MCP connector action (spec §10.1) — every call an agent makes into
 * an external system (Figma, SFMC, DAM…) is recorded, so external effects are
 * fully audited alongside agent and human actions.
 */
export const ConnectorInvoked = z.object({
  type: z.literal("ConnectorInvoked"),
  connector: z.string(),
  tool: z.string(),
  effect: z.enum(["read", "write", "irreversible"]),
  summary: z.string(),
});

/** Discriminated union of every domain event. */
export const CampaignEventBody = z.discriminatedUnion("type", [
  CampaignCreated,
  ArtifactProposed,
  ArtifactEvaluated,
  ArtifactApproved,
  ArtifactRejected,
  StageAdvanced,
  StageGateBlocked,
  MentionAdded,
  MentionResolved,
  ConnectorInvoked,
]);
export type CampaignEventBody = z.infer<typeof CampaignEventBody>;

/**
 * Current event-envelope schema version. Bump when the envelope or a body shape
 * changes incompatibly; the fold upcasts older versions on read, so historical
 * campaigns stay replayable forever (spec §11.2 "auditable and replayable").
 */
export const EVENT_SCHEMA_VERSION = 1;

/** An envelope wrapping each event with ordering + provenance metadata. */
export interface CampaignEvent {
  /** Monotonic per-campaign sequence number (1-based). */
  seq: number;
  campaignId: string;
  /** Envelope schema version. Absent on pre-versioning events → treated as 1. */
  v?: number;
  at: string;
  actor: { kind: "human" | "agent" | "system"; id: string; displayName: string; role?: string };
  body: CampaignEventBody;
}

/** The version an event was written under (legacy events predate the field). */
export function eventVersion(e: CampaignEvent): number {
  return e.v ?? 1;
}
