import type { CampaignEvent } from "../domain/events";
import { ArtifactStatus, type Artifact, type CampaignObject, type MentionRecord } from "../domain/types";
import type { EventStore } from "./eventStore";

/**
 * Rebuilds the materialised campaign object by folding the event stream —
 * the "shared campaign object (blackboard)" of spec §7.1. Agents and humans
 * never mutate state directly; they append events, and state is derived.
 */
export class CampaignRepository {
  constructor(private readonly store: EventStore) {}

  async load(campaignId: string): Promise<CampaignObject | null> {
    const events = await this.store.read(campaignId);
    if (events.length === 0) return null;
    return CampaignRepository.fold(events);
  }

  /** Current revision (event count) — used for optimistic concurrency on append. */
  async revision(campaignId: string): Promise<number> {
    return (await this.store.read(campaignId)).length;
  }

  static fold(events: CampaignEvent[]): CampaignObject {
    let campaign: CampaignObject["campaign"] | null = null;
    const artifacts: Record<string, Artifact> = {};
    const mentions: MentionRecord[] = [];

    for (const event of events) {
      const b = event.body;
      switch (b.type) {
        case "CampaignCreated":
          campaign = { ...b.campaign };
          break;

        case "ArtifactProposed": {
          // A new version supersedes any prior ACTIVE artifact of the same kind+title
          // (approved, in-review or proposed) — e.g. a human edit or a redraft. Rejected
          // versions are left as-is so the change history stays intact.
          const active: ArtifactStatus[] = [
            ArtifactStatus.Approved,
            ArtifactStatus.InReview,
            ArtifactStatus.Proposed,
          ];
          for (const existing of Object.values(artifacts)) {
            if (
              existing.id !== b.artifact.id &&
              existing.kind === b.artifact.kind &&
              existing.title === b.artifact.title &&
              active.includes(existing.status)
            ) {
              existing.status = ArtifactStatus.Superseded;
            }
          }
          artifacts[b.artifact.id] = { ...b.artifact };
          break;
        }

        case "ArtifactEvaluated": {
          const a = artifacts[b.artifactId];
          if (a && b.passed && !a.passedEvals.includes(b.evalId)) {
            a.passedEvals = [...a.passedEvals, b.evalId];
            a.status = ArtifactStatus.InReview;
          }
          break;
        }

        case "ArtifactApproved": {
          const a = artifacts[b.artifactId];
          if (a) a.status = ArtifactStatus.Approved;
          break;
        }

        case "ArtifactRejected": {
          const a = artifacts[b.artifactId];
          if (a) a.status = ArtifactStatus.Rejected;
          break;
        }

        case "StageAdvanced":
          if (campaign) campaign.currentStage = b.to;
          break;

        case "MentionAdded":
          mentions.push({
            id: b.mentionId,
            artifactId: b.artifactId,
            from: event.actor.displayName,
            ...(event.actor.role ? { fromRole: event.actor.role } : {}),
            toRole: b.toRole,
            message: b.message,
            at: event.at,
            resolved: false,
          });
          break;

        case "MentionResolved": {
          const m = mentions.find((x) => x.id === b.mentionId);
          if (m) m.resolved = true;
          break;
        }

        case "StageGateBlocked":
        case "ConnectorInvoked":
          // Informational; recorded in the audit trail, no state mutation.
          break;
      }
    }

    if (!campaign) {
      throw new Error("Event stream does not begin with CampaignCreated");
    }
    return { campaign, artifacts, mentions, revision: events.length };
  }
}
