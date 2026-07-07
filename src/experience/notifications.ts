import type { ConnectorRegistry } from "../integrations/mcp";
import { TEAMS_SCOPES } from "../integrations/teams";
import type { IntakeInterview, CreateCampaignInput } from "./intakeInterview";

/**
 * Workflow notifications (spec §8.4 — "notifications with a budget: batched,
 * prioritised, routed to email/Teams/mobile"). Every notification lands in the
 * in-app feed and is sent through the GOVERNED Teams connector (audited like any
 * other external call; delivered to a channel when a webhook is configured).
 *
 * The budget: identical consecutive messages are coalesced and each campaign is
 * capped per minute, so agent bursts don't spam the channel.
 */

export interface NotificationItem {
  at: string;
  campaignId: string;
  kind: "created" | "review" | "advanced" | "changes" | "golive" | "mention";
  title: string;
  body: string;
  /** Whether it reached a real Teams channel (false = in-app only). */
  delivered: boolean;
}

const FEED_MAX = 50;
const BUDGET_PER_MINUTE = 5; // per campaign, for routine kinds
/** §8.4 "prioritised": critical/personal notifications always go out; routine ones are budgeted. */
const PRIORITY_KINDS = new Set<NotificationItem["kind"]>(["golive", "created", "changes", "mention"]);

const SYSTEM_ACTOR = { kind: "system" as const, id: "notifier", displayName: "Notifier" };

export class NotificationService {
  private readonly feed: NotificationItem[] = [];
  private readonly recent = new Map<string, number[]>(); // campaignId -> send timestamps
  private lastKey = "";

  constructor(
    private readonly connectors: ConnectorRegistry,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(limit = 12): NotificationItem[] {
    return this.feed.slice(0, limit);
  }

  async notify(campaignId: string, kind: NotificationItem["kind"], title: string, body: string): Promise<void> {
    // Coalesce identical consecutive notifications (agent bursts).
    const key = `${campaignId}|${kind}|${title}|${body}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    // Per-campaign budget for routine kinds: at most N sends per rolling minute.
    // Priority kinds (go-live, created, changes-requested) always go out (§8.4).
    const nowMs = Date.parse(this.now());
    if (!PRIORITY_KINDS.has(kind)) {
      const stamps = (this.recent.get(campaignId) ?? []).filter((t) => nowMs - t < 60_000);
      if (stamps.length >= BUDGET_PER_MINUTE) return;
      stamps.push(nowMs);
      this.recent.set(campaignId, stamps);
    }

    let delivered = false;
    try {
      const result = (await this.connectors.invoke(
        "teams",
        "post_notification",
        { title, body },
        { campaignId, actor: SYSTEM_ACTOR, grantedScopes: [TEAMS_SCOPES.notify] },
      )) as { delivered?: boolean };
      delivered = Boolean(result?.delivered);
    } catch {
      // A failing webhook must never break the workflow — the feed still records it.
    }
    this.feed.unshift({ at: this.now(), campaignId, kind, title, body, delivered });
    if (this.feed.length > FEED_MAX) this.feed.length = FEED_MAX;
  }
}

// ── Teams / Copilot entry point (spec §6.0 — intake from a Teams message) ──────

/** The subset of a Teams outgoing-webhook payload we consume. */
export interface TeamsInboundMessage {
  text?: string;
  from?: { name?: string };
  conversation?: { id?: string };
}

/**
 * Bridges Teams (or Copilot Studio calling the same HTTP surface) into the
 * conversational intake: each Teams conversation maps to one interview session,
 * so a requester can run the whole brief interview from a channel. Replies use
 * the Teams outgoing-webhook response shape ({type:"message", text}).
 */
export class TeamsIntakeBridge {
  private readonly sessions = new Map<string, string>(); // conversationId -> interview session

  constructor(
    private readonly interview: IntakeInterview,
    private readonly createCampaign: (input: CreateCampaignInput, requesterName: string) => Promise<string>,
  ) {}

  async handle(msg: TeamsInboundMessage): Promise<{ type: "message"; text: string }> {
    const conversationId = msg.conversation?.id ?? msg.from?.name ?? "teams-default";
    const requester = msg.from?.name ?? "Teams requester";
    // Teams prefixes messages with the bot @mention (<at>Bot</at>) — remove the
    // mention including its inner text, then any residual markup.
    const text = (msg.text ?? "")
      .replace(/<at>[\s\S]*?<\/at>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    let sessionId = this.sessions.get(conversationId);
    if (!sessionId) {
      const started = this.interview.start();
      sessionId = started.sessionId;
      this.sessions.set(conversationId, sessionId);
      if (!text || /^(hi|hello|hey|new campaign|start)\b/i.test(text)) {
        return { type: "message", text: started.message };
      }
    }

    const reply = await this.interview.reply(sessionId, text, (input) => this.createCampaign(input, requester));
    if (reply.done && reply.campaignId) {
      this.sessions.delete(conversationId); // conversation can start a fresh brief next time
      return {
        type: "message",
        text: `${reply.message} Open it in Astra Campaign Studio to review the drafted brief (campaign ${reply.campaignId}).`,
      };
    }
    return { type: "message", text: reply.message };
  }
}
