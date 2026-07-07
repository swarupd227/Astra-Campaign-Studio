import type { CampaignEvent } from "../domain/events";
import { evalLabel, kindLabel, stageLabel } from "../domain/labels";

export interface AuditRecord {
  seq: number;
  at: string;
  who: string;
  what: string;
  why: string;
}

/** Resolves an artifact id to its human title, so the feed never shows raw ids. */
export type TitleResolver = (artifactId: string) => string | undefined;

/**
 * The immutable audit trail (spec §9.1) is a projection over the event log:
 * because every state change is an event carrying actor + timestamp + payload,
 * the audit trail is reproducible and exportable by construction — who/what/
 * when/why on every action, with the grounding used.
 */
export class AuditTrail {
  static from(events: CampaignEvent[], resolveTitle: TitleResolver = () => undefined): AuditRecord[] {
    return events.map((e) => ({
      seq: e.seq,
      at: e.at,
      who: roleName(e.actor),
      what: describe(e, resolveTitle),
      why: reason(e),
    }));
  }
}

function roleName(actor: CampaignEvent["actor"]): string {
  if (actor.kind === "agent") return `${actor.displayName} (agent)`;
  if (actor.kind === "system") return "System";
  return actor.displayName; // humans display as their persona label
}

function title(id: string, resolve: TitleResolver): string {
  return resolve(id) ? `"${resolve(id)}"` : "an item";
}

function describe(e: CampaignEvent, resolve: TitleResolver): string {
  const b = e.body;
  switch (b.type) {
    case "CampaignCreated":
      return `Created campaign "${b.campaign.objective}"`;
    case "ArtifactProposed":
      return `Drafted ${kindLabel(b.artifact.kind).toLowerCase()} "${b.artifact.title}"`;
    case "ArtifactEvaluated":
      return `${evalLabel(b.evalName)} check ${b.passed ? "passed" : "failed"} on ${title(b.artifactId, resolve)}`;
    case "ArtifactApproved":
      return `Approved ${title(b.artifactId, resolve)}`;
    case "ArtifactRejected":
      return `Requested changes on ${title(b.artifactId, resolve)}`;
    case "StageAdvanced":
      return `Advanced from ${stageLabel(b.from)} to ${stageLabel(b.to)}`;
    case "StageGateBlocked":
      return `Stage gate not yet met at ${stageLabel(b.stage)}`;
    case "MentionAdded":
      return `Pulled ${roleLabelOf(b.toRole)} into ${title(b.artifactId, resolve)}`;
    case "MentionResolved":
      return `Closed a hand-off`;
    case "ConnectorInvoked":
      return `${cap(b.connector)}: ${b.tool.replace(/_/g, " ")}`;
  }
}

/** Best-effort persona label without importing the role catalogue (layering). */
function roleLabelOf(roleId: string): string {
  return roleId
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function reason(e: CampaignEvent): string {
  const b = e.body;
  switch (b.type) {
    case "ArtifactProposed":
      return b.rationale;
    case "ArtifactEvaluated":
      return b.detail;
    case "ArtifactRejected":
      return b.reason;
    case "StageGateBlocked":
      return b.reason;
    case "ArtifactApproved":
      return b.note ?? "";
    case "MentionAdded":
      return b.message;
    case "ConnectorInvoked":
      return b.summary;
    default:
      return "";
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
