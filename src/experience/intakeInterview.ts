import { newId } from "../domain/ids";
import type { ModelGateway } from "../gateway/modelGateway";
import type { IntakeFieldKey, IntakeFields } from "../domain/intakeParsing";

/**
 * Conversational brief intake (spec §6.0): interviews the requester, extracts
 * fields from free-text answers via the gateway (Claude when keyed; the mock
 * provider's deterministic parser otherwise), and — the §6.0 requirement —
 * ASKS ONLY WHAT'S MISSING. One opening answer that already contains markets and
 * a budget skips those questions entirely. Ends with a summary the requester
 * confirms before anything is created; ambiguities are asked, never assumed.
 */

/** Sentinel the mock provider keys on to run deterministic extraction. */
export const INTAKE_SENTINEL = "[[ASTRA_INTAKE]]";

const ORDER: IntakeFieldKey[] = ["objective", "markets", "budget", "successMetric", "mandatoryClaims"];

const QUESTIONS: Record<IntakeFieldKey, string> = {
  objective: "What is this campaign trying to achieve? One or two sentences is plenty.",
  markets: "Which markets is it for? (e.g. DACH, US, Nordics, or country codes)",
  budget: "What's the working budget? (e.g. €750k)",
  successMetric: "What's the single success metric we should optimise for? (e.g. qualified leads, demo requests, CTR)",
  mandatoryClaims: "Any mandatory claims or constraints every asset must respect? Say “none” if there aren't any.",
};

const AFFIRM = /^\s*(y(es)?|yep|yeah|confirm(ed)?|create( it)?|go( ahead)?|ok(ay)?|looks good|do it|ship it)\b/i;

export interface InterviewReply {
  sessionId: string;
  message: string;
  fields: IntakeFields;
  missing: IntakeFieldKey[];
  awaitingConfirm: boolean;
  done: boolean;
  campaignId?: string;
}

interface Session {
  id: string;
  fields: IntakeFields;
  lastAsked: IntakeFieldKey | null;
  awaitingConfirm: boolean;
  done: boolean;
}

export interface CreateCampaignInput {
  objective: string;
  markets: string[];
  budget: number;
  successMetric: string;
  mandatoryClaims?: string;
}

export class IntakeInterview {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly gateway: ModelGateway) {}

  start(): InterviewReply {
    const session: Session = { id: newId("intake"), fields: {}, lastAsked: "objective", awaitingConfirm: false, done: false };
    this.sessions.set(session.id, session);
    return this.toReply(session, `Let's shape the brief. ${QUESTIONS.objective}`);
  }

  /**
   * Process one requester message. `createCampaign` is supplied per call so the
   * confirming user's identity/role governs the actual creation.
   */
  async reply(
    sessionId: string,
    text: string,
    createCampaign: (input: CreateCampaignInput) => Promise<string>,
  ): Promise<InterviewReply> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Interview session not found — start a new one.");
    if (session.done) return this.toReply(session, "This brief is already confirmed.");

    if (session.awaitingConfirm && AFFIRM.test(text)) {
      const f = session.fields;
      const campaignId = await createCampaign({
        objective: f.objective!,
        markets: f.markets!,
        budget: f.budget!,
        successMetric: f.successMetric!,
        ...(typeof f.mandatoryClaims === "string" && f.mandatoryClaims ? { mandatoryClaims: f.mandatoryClaims } : {}),
      });
      session.done = true;
      return { ...this.toReply(session, "Campaign created — the Intake Agent has drafted the brief for review."), campaignId };
    }

    // Extract whatever the message provides (during confirm this doubles as
    // "tell me what to change" — e.g. "make the budget 400k").
    const extracted = await this.extract(session, text);
    mergeFields(session.fields, extracted);

    const missing = this.missing(session);
    if (missing.length > 0) {
      session.awaitingConfirm = false;
      const next = missing[0]!;
      // If the answer to the question just asked didn't land, re-ask with a nudge.
      const prefix = session.lastAsked === next && !fieldPresent(session.fields, next)
        ? "Sorry, I didn't catch that. "
        : acknowledge(extracted);
      session.lastAsked = next;
      return this.toReply(session, `${prefix}${QUESTIONS[next]}`);
    }

    session.lastAsked = null;
    session.awaitingConfirm = true;
    return this.toReply(session, this.summary(session.fields));
  }

  private async extract(session: Session, text: string): Promise<IntakeFields> {
    const res = await this.gateway.complete({
      campaignId: "intake-interview",
      system:
        "You are Hilti's Intake Agent conducting a brief interview. From the user's latest message, extract ONLY newly provided fields. Respond ONLY with JSON: {\"objective\"?: string, \"markets\"?: string[] (2-letter codes), \"budget\"?: number, \"successMetric\"?: string, \"mandatoryClaims\"?: string | null (null when the user says there are none)}.",
      prompt: [
        INTAKE_SENTINEL,
        `LASTASKED=${session.lastAsked ?? "null"}`,
        `KNOWN=${JSON.stringify(session.fields)}`,
        `USER: ${text}`,
      ].join("\n"),
    });
    try {
      const match = res.text.match(/\{[\s\S]*\}/);
      return match ? sanitise(JSON.parse(match[0]) as IntakeFields) : {};
    } catch {
      return {}; // unparseable extraction → ask again rather than assume (spec §6.0)
    }
  }

  private missing(session: Session): IntakeFieldKey[] {
    return ORDER.filter((f) => !fieldPresent(session.fields, f));
  }

  private summary(f: IntakeFields): string {
    const claims = typeof f.mandatoryClaims === "string" && f.mandatoryClaims ? f.mandatoryClaims : "none";
    return (
      `Here's the brief so far — objective: “${f.objective}” · markets: ${f.markets!.join(", ")} · ` +
      `budget: EUR ${f.budget!.toLocaleString("en-US")} · success metric: ${f.successMetric} · mandatory claims: ${claims}. ` +
      `Shall I create the campaign? (yes — or tell me what to change)`
    );
  }

  private toReply(session: Session, message: string): InterviewReply {
    return {
      sessionId: session.id,
      message,
      fields: { ...session.fields },
      missing: this.missing(session),
      awaitingConfirm: session.awaitingConfirm,
      done: session.done,
    };
  }
}

function fieldPresent(fields: IntakeFields, key: IntakeFieldKey): boolean {
  if (key === "mandatoryClaims") return fields.mandatoryClaims !== undefined; // null = "none", counts as answered
  const v = fields[key];
  return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== "";
}

function mergeFields(target: IntakeFields, extra: IntakeFields): void {
  if (extra.objective) target.objective = extra.objective;
  if (extra.markets?.length) target.markets = extra.markets;
  if (typeof extra.budget === "number" && extra.budget > 0) target.budget = extra.budget;
  if (extra.successMetric) target.successMetric = extra.successMetric;
  if (extra.mandatoryClaims !== undefined) target.mandatoryClaims = extra.mandatoryClaims;
}

/** Trust nothing from the extractor blindly — coerce to the expected shapes. */
function sanitise(raw: IntakeFields): IntakeFields {
  const out: IntakeFields = {};
  if (typeof raw.objective === "string" && raw.objective.trim()) out.objective = raw.objective.trim();
  if (Array.isArray(raw.markets)) {
    const markets = raw.markets.filter((m) => typeof m === "string" && /^[A-Za-z]{2}$/.test(m)).map((m) => m.toUpperCase());
    if (markets.length) out.markets = markets;
  }
  if (typeof raw.budget === "number" && Number.isFinite(raw.budget) && raw.budget > 0) out.budget = Math.round(raw.budget);
  if (typeof raw.successMetric === "string" && raw.successMetric.trim()) out.successMetric = raw.successMetric.trim();
  if (raw.mandatoryClaims === null) out.mandatoryClaims = null;
  else if (typeof raw.mandatoryClaims === "string" && raw.mandatoryClaims.trim()) out.mandatoryClaims = raw.mandatoryClaims.trim();
  return out;
}

function acknowledge(extracted: IntakeFields): string {
  const got: string[] = [];
  if (extracted.objective) got.push("objective");
  if (extracted.markets?.length) got.push(`markets (${extracted.markets.join(", ")})`);
  if (extracted.budget) got.push(`budget (EUR ${extracted.budget.toLocaleString("en-US")})`);
  if (extracted.successMetric) got.push(`metric (${extracted.successMetric})`);
  return got.length ? `Got it — ${got.join(", ")}. ` : "";
}
