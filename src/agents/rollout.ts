import { ArtifactKind, Stage } from "../domain/types";
import { defineAgent, findArtifactId, type Agent } from "../orchestration/agent";

/**
 * Stage 4 · Campaign Roll-out / Publishing agents (spec §6.4). Publishing agents
 * PREPARE deployments as reviewable artifacts; nothing touches an external
 * channel here. The irreversible connector calls (publish, send, launch) happen
 * only at the explicit human go-live step, which also requires a passing consent
 * check — the §6.4 non-negotiable.
 */

const role = "channel-specialist";
const contentLineage = (ctx: Parameters<typeof findArtifactId>[0]) =>
  findArtifactId(ctx, ArtifactKind.ContentItem);

export const finalLocalisationAgent: Agent = defineAgent({
  name: "Localization Agent",
  stage: Stage.Rollout,
  role,
  kind: ArtifactKind.ContentItem,
  title: "Market-final localisations",
  system: "You are Hilti's Localization Agent. Finalise language and cultural adaptation per market.",
  query: () => "transcreation market adaptation DACH localisation final",
  rationale: "Locked the market-final copy variants; DACH transcreation checked against market rules.",
  derivedFrom: contentLineage,
  body: () => ({
    markets: ["DE", "AT", "CH", "US"],
    status: "final",
    note: "All market variants carry the substantiated claim footnote¹.",
    footnote: "¹ Runtime measured under standard test conditions; substantiation on file.",
  }),
});

export const metadataAgent: Agent = defineAgent({
  name: "Metadata / SEO Agent",
  stage: Stage.Rollout,
  role,
  kind: ArtifactKind.Note,
  title: "Publishing metadata",
  system: "You are Hilti's Metadata Agent. Add structured metadata, tags and SEO fields.",
  query: () => "metadata seo tags publishing structured fields",
  rationale: "Generated SEO titles, descriptions and taxonomy tags for every publishable item.",
  derivedFrom: contentLineage,
  body: () => ({
    seoTitle: "Hilti cordless platform — one battery, every job",
    tags: ["cordless", "battery-platform", "launch"],
    ogImage: "hero-jobsite-sunrise",
  }),
});

export const qaAgent: Agent = defineAgent({
  name: "QA Agent",
  stage: Stage.Rollout,
  role,
  kind: ArtifactKind.Note,
  title: "Pre-flight QA report",
  system: "You are Hilti's QA Agent. Run pre-flight checks against channel specs and links.",
  query: () => "preflight qa channel specs links check",
  rationale: "Validated channel specs, link targets and asset dimensions across every deliverable.",
  derivedFrom: contentLineage,
  body: () => ({
    checks: [
      { check: "Channel specs (sizes/ratios)", result: "pass" },
      { check: "Link targets resolve", result: "pass" },
      { check: "Substantiation footnotes present", result: "pass" },
    ],
    status: "pass",
  }),
});

export const consentAgent: Agent = defineAgent({
  name: "Consent / Preference Agent",
  stage: Stage.Rollout,
  role,
  kind: ArtifactKind.Note,
  title: "Consent & preference check",
  system: "You are Hilti's Consent Agent. Enforce consent and preference rules before any send.",
  query: () => "consent preference gdpr send suppression audience",
  rationale: "Verified the send audience against consent records and suppression lists (GDPR).",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.Audience),
  body: () => ({
    audienceChecked: true,
    suppressionApplied: true,
    status: "pass",
  }),
});

export const cmsPublishingAgent: Agent = defineAgent({
  name: "CMS Publishing Agent",
  stage: Stage.Rollout,
  role,
  kind: ArtifactKind.Deployment,
  title: "Deployment — landing page (Contentful)",
  system: "You are Hilti's CMS Publishing Agent. Prepare content publishing to Contentful.",
  query: () => "cms publish landing page entry contentful",
  rationale: "Staged the landing page entry; publishing executes only at human go-live.",
  derivedFrom: contentLineage,
  body: () => ({
    system: "contentful",
    tool: "publish_entry",
    channel: "landing-page",
    title: "Cordless platform launch page",
  }),
});

export const damUploadAgent: Agent = defineAgent({
  name: "DAM Upload Agent",
  stage: Stage.Rollout,
  role,
  kind: ArtifactKind.Deployment,
  title: "Deployment — final assets (DAM)",
  system: "You are Hilti's DAM Upload Agent. File final assets with taxonomy and rights.",
  query: () => "dam asset taxonomy rights upload final",
  rationale: "Packaged the approved assets with taxonomy and rights metadata for the DAM.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.Asset),
  body: () => ({
    system: "dam",
    tool: "upload_asset",
    title: "Launch asset pack",
    rights: "global, 24 months",
  }),
});

export const adUploadAgent: Agent = defineAgent({
  name: "Ad Network Upload Agent",
  stage: Stage.Rollout,
  role,
  kind: ArtifactKind.Deployment,
  title: "Deployment — paid campaign (ad networks)",
  system: "You are Hilti's Ad Network Upload Agent. Load creatives to Google, Meta and LinkedIn.",
  query: () => "ad network creative upload paid social launch",
  rationale: "Prepared the paid-social creatives and campaign structure; delivery starts at go-live.",
  derivedFrom: contentLineage,
  body: () => ({
    system: "ads",
    tool: "launch_campaign",
    channel: "paid-social",
    title: "Cordless launch — DACH & US",
  }),
});

export const marketingAutomationAgent: Agent = defineAgent({
  name: "Marketing Automation Agent",
  stage: Stage.Rollout,
  role,
  kind: ArtifactKind.Deployment,
  title: "Deployment — email journey (SFMC)",
  system: "You are Hilti's Marketing Automation Agent. Configure SFMC journeys, audiences and sends.",
  query: () => "sfmc journey audience email nurture configure",
  rationale: "Configured the three-touch nurture journey; activation (customer sends) waits for go-live.",
  derivedFrom: (ctx) => findArtifactId(ctx, ArtifactKind.Journey),
  body: () => ({
    system: "sfmc",
    tool: "activate_journey",
    name: "Cordless launch nurture",
    audience: "Qualified trade professionals (consent-checked)",
  }),
});

export const schedulingAgent: Agent = defineAgent({
  name: "Scheduling / Trafficking Agent",
  stage: Stage.Rollout,
  role,
  kind: ArtifactKind.Note,
  title: "Launch schedule",
  system: "You are Hilti's Scheduling Agent. Sequence and schedule the launch.",
  query: () => "launch schedule sequencing channels pacing",
  rationale: "Sequenced the launch: paid + landing on day 1, nurture activates day 2, DAM archive same day.",
  derivedFrom: contentLineage,
  body: () => ({
    sequence: [
      { day: 1, action: "Landing page live + paid delivery starts" },
      { day: 2, action: "Nurture journey activates" },
    ],
  }),
});

export const rolloutAgents: Agent[] = [
  finalLocalisationAgent,
  metadataAgent,
  qaAgent,
  consentAgent,
  cmsPublishingAgent,
  damUploadAgent,
  adUploadAgent,
  marketingAutomationAgent,
  schedulingAgent,
];
