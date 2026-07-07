import { STAGE_ORDER, Stage, type Artifact, type ArtifactKind } from "../domain/types";
import { kindLabel, stageLabel } from "../domain/labels";

/**
 * Persona catalogue & role-based authority (spec §5). Access is governed by role
 * (and, in a fuller build, market × brand × campaign attributes). Here it is a
 * screen-level ROLE SWITCHER backed by real server-side enforcement: each persona
 * has a home surface, a capability set, and an approval authority derived from the
 * default RACI (§5.2). No external identity provider — roles are switched in the UI.
 */
export interface RoleDef {
  id: string;
  label: string;
  /** The persona's default landing surface (spec §5.1). */
  home: string;
  /** May trigger specialist agents to produce work. */
  canRunAgents: boolean;
  /** May directly edit an artifact's content (creates a new, re-evaluated version). */
  canEdit: boolean;
  /** May advance a campaign to the next stage once its gate is satisfied. */
  canAdvance: boolean;
  /** May configure agents, policies, integrations (Admin console). */
  canAdmin: boolean;
  /** May execute go-live: publishing/sending — irreversible external actions (§6.4). */
  canGoLive: boolean;
  /** May create new campaigns. */
  canCreateCampaign: boolean;
  /** Stages whose artifacts this role may approve (its RACI authority). */
  approvesStages: Stage[];
  /** If set, further restricts approvable artifacts to these kinds (e.g. Legal → claim-bearing). */
  approvesKinds?: ArtifactKind[];
}

// Artifact kinds a Legal/Compliance reviewer signs off on — the claim-bearing outputs.
const CLAIM_BEARING: ArtifactKind[] = ["content-item" as ArtifactKind, "asset" as ArtifactKind];

/** The MVP-1 persona catalogue (subset of §5.1), each mapped to its authority. */
export const ROLE_CATALOGUE: RoleDef[] = [
  {
    id: "campaign-manager",
    label: "Campaign Manager",
    home: "Campaign Canvas",
    canRunAgents: true,
    canEdit: true,
    canAdvance: true,
    canAdmin: false,
    canGoLive: false, // go-live is a Marketing Ops / Channel Specialist authority (§5.2)
    canCreateCampaign: true,
    // Accountable across the chain (§5.2) — may approve at every stage.
    approvesStages: [...STAGE_ORDER],
  },
  {
    id: "marketing-leader",
    label: "Marketing Leader / CMO",
    home: "Mission Control",
    canRunAgents: false,
    canEdit: false,
    canAdvance: false,
    canAdmin: false,
    canGoLive: false,
    canCreateCampaign: false,
    // Accountable at intake; signs off strategy at planning.
    approvesStages: [Stage.Intake, Stage.CampaignPlanning],
  },
  {
    id: "content-strategist",
    label: "Content Strategist",
    home: "Content Planning canvas",
    canRunAgents: true,
    canEdit: true,
    canAdvance: false,
    canAdmin: false,
    canGoLive: false,
    canCreateCampaign: false,
    // Also approves the refresh backlog at content optimisation (§6.6).
    approvesStages: [Stage.ContentPlanning, Stage.ContentOptimisation],
  },
  {
    id: "brand-guardian",
    label: "Brand Guardian",
    home: "Brand review queue",
    canRunAgents: false,
    canEdit: false,
    canAdvance: false,
    canAdmin: false,
    canGoLive: false,
    canCreateCampaign: false,
    // Enforces tone & identity — refreshed content re-enters the same gates (§6.6).
    approvesStages: [Stage.ContentPlanning, Stage.ContentCreation, Stage.ContentOptimisation],
  },
  {
    id: "legal",
    label: "Legal / Compliance",
    home: "Compliance review queue",
    canRunAgents: false,
    canEdit: false,
    canAdvance: false,
    canAdmin: false,
    canGoLive: false,
    canCreateCampaign: false,
    // Signs off regulated claims on the claim-bearing artifacts only.
    approvesStages: [Stage.ContentCreation, Stage.ContentOptimisation],
    approvesKinds: CLAIM_BEARING,
  },
  {
    id: "creator",
    label: "Creator / Designer",
    home: "Asset Studio",
    canRunAgents: true, // produces copy/imagery
    canEdit: true, // core Creator workflow — refine AI drafts inline
    canAdvance: false,
    canAdmin: false,
    canGoLive: false,
    canCreateCampaign: false,
    approvesStages: [], // creators produce and edit; they do not self-approve
  },
  {
    id: "localisation",
    label: "Localisation / Regional Marketer",
    home: "Localisation Workbench",
    canRunAgents: true, // runs localisation/transcreation agents
    canEdit: true, // adapts market copy directly in the workbench
    canAdvance: false,
    canAdmin: false,
    canGoLive: false,
    canCreateCampaign: false,
    // Signs off market variants at creation and the market-final pass at roll-out.
    approvesStages: [Stage.ContentCreation, Stage.Rollout],
    approvesKinds: ["content-item" as ArtifactKind],
  },
  {
    id: "analyst",
    label: "Data / Insights Analyst",
    home: "Analytics & learning workspace",
    canRunAgents: false,
    canEdit: false,
    canAdvance: false,
    canAdmin: false,
    canGoLive: false,
    canCreateCampaign: false,
    // Interrogates performance and signs off the distilled learnings (§5.1/§6.7).
    approvesStages: [Stage.ContentOptimisation],
    approvesKinds: ["learning" as ArtifactKind],
  },
  {
    id: "agency-partner",
    label: "External Agency Partner",
    home: "Guest workspace (scoped)",
    canRunAgents: false,
    canEdit: true, // collaborates on assigned creative
    canAdvance: false,
    canAdmin: false,
    canGoLive: false,
    canCreateCampaign: false,
    approvesStages: [], // guests contribute; internal roles approve
  },
  {
    id: "channel-specialist",
    label: "Channel Specialist",
    home: "Channel workspaces",
    canRunAgents: true, // channel assembly, QA and publishing prep (§6.4)
    canEdit: false,
    canAdvance: false,
    canAdmin: false,
    canGoLive: true, // gives the final go-live approval with Marketing Ops (§6.4)
    canCreateCampaign: false,
    approvesStages: [Stage.Rollout],
  },
  {
    id: "performance-marketer",
    label: "Performance Marketer",
    home: "Optimisation dashboards",
    canRunAgents: true, // monitors, reallocates, experiments (§6.5)
    canEdit: false,
    canAdvance: false,
    canAdmin: false,
    canGoLive: false,
    canCreateCampaign: false,
    approvesStages: [Stage.CampaignOptimisation, Stage.ContentOptimisation],
  },
  {
    id: "marketing-ops",
    label: "Marketing Ops / Admin",
    home: "Admin console",
    canRunAgents: true,
    canEdit: true,
    canAdvance: true,
    canAdmin: true,
    canGoLive: true, // accountable for roll-out (§5.2)
    canCreateCampaign: true,
    approvesStages: [...STAGE_ORDER],
  },
];

export function getRole(roleId: string | undefined): RoleDef | undefined {
  return ROLE_CATALOGUE.find((r) => r.id === roleId);
}

export interface AccessDecision {
  allowed: boolean;
  reason: string;
}

export class AccessDeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AccessDeniedError";
  }
}

/**
 * The access-control service (spec §5.2, §9.1). Enforces role authority at
 * runtime — approvals, agent runs and stage advances are all checked, so the UI
 * role switcher is a real permission boundary, not a cosmetic filter.
 */
export class AccessControl {
  canApprove(roleId: string | undefined, artifact: Artifact): AccessDecision {
    const role = getRole(roleId);
    if (!role) return deny(`Unknown role.`);
    if (!role.approvesStages.includes(artifact.stage)) {
      return deny(`The ${role.label} role can’t approve items at the ${stageLabel(artifact.stage)} stage.`);
    }
    if (role.approvesKinds && !role.approvesKinds.includes(artifact.kind)) {
      const kinds = role.approvesKinds.map(kindLabel).join(" and ");
      return deny(`The ${role.label} role only signs off ${kinds}.`);
    }
    return allow(`${role.label} can approve this item.`);
  }

  canRunAgents(roleId: string | undefined): AccessDecision {
    const role = getRole(roleId);
    if (!role) return deny(`Unknown role.`);
    return role.canRunAgents
      ? allow(`${role.label} can run agents.`)
      : deny(`The ${role.label} role can’t run agents. Switch to a role that owns this stage.`);
  }

  canAdvance(roleId: string | undefined): AccessDecision {
    const role = getRole(roleId);
    if (!role) return deny(`Unknown role.`);
    return role.canAdvance
      ? allow(`${role.label} can advance the campaign.`)
      : deny(`The ${role.label} role can’t advance the campaign to the next stage.`);
  }

  canCreateCampaign(roleId: string | undefined): AccessDecision {
    const role = getRole(roleId);
    if (!role) return deny(`Unknown role.`);
    return role.canCreateCampaign
      ? allow(`${role.label} can create campaigns.`)
      : deny(`The ${role.label} role can’t create campaigns.`);
  }

  canAdmin(roleId: string | undefined): AccessDecision {
    const role = getRole(roleId);
    if (!role) return deny(`Unknown role.`);
    return role.canAdmin
      ? allow(`${role.label} can open Admin settings.`)
      : deny(`Admin settings are limited to the Marketing Ops / Admin role.`);
  }

  canEdit(roleId: string | undefined): AccessDecision {
    const role = getRole(roleId);
    if (!role) return deny(`Unknown role.`);
    return role.canEdit
      ? allow(`${role.label} can edit content.`)
      : deny(`The ${role.label} role reviews content but doesn’t edit it directly.`);
  }

  canGoLive(roleId: string | undefined): AccessDecision {
    const role = getRole(roleId);
    if (!role) return deny(`Unknown role.`);
    return role.canGoLive
      ? allow(`${role.label} can authorise go-live.`)
      : deny(`Go-live is limited to Marketing Ops and Channel Specialists (§6.4).`);
  }
}

function allow(reason: string): AccessDecision {
  return { allowed: true, reason };
}
function deny(reason: string): AccessDecision {
  return { allowed: false, reason };
}
