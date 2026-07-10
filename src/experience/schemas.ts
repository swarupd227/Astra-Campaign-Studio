import { z } from "zod";

/**
 * Request-body validation for the mutating API routes (spec §14 — hardened
 * inputs are part of the security posture, not an afterthought). Schemas are
 * deliberately tolerant of extra keys (clients evolve) but strict on the types
 * and presence of the fields a route actually acts on.
 */

const str = z.string();
const optStr = z.string().optional();

export const BodySchemas = {
  // Settings (admin)
  anthropicKey: z.object({ apiKey: optStr.nullable() }),
  teams: z.object({ webhookUrl: optStr }),
  figma: z.object({ token: optStr, fileKey: optStr }),
  claudeDesign: z.object({ endpoint: optStr, token: optStr }),
  sfmc: z.object({ subdomain: optStr, clientId: optStr, clientSecret: optStr }),
  policy: z.object({ role: str.min(1), stage: str.min(1), autonomy: str.min(1) }),
  golden: z.object({ op: str.min(1), text: str.min(1) }),
  knowledge: z.object({
    title: str.min(1).max(200),
    text: str.min(1).max(200_000),
    domain: optStr,
    version: z.union([z.string(), z.number()]).optional(),
    id: optStr,
  }),
  guestAccess: z.object({ campaignId: str.min(1), allowed: z.boolean() }),

  // Campaign lifecycle
  createCampaign: z.object({
    objective: str.min(1).max(500),
    markets: z.union([z.string(), z.array(z.string())]).optional(),
    budget: z.union([z.number(), z.string()]).optional(),
    currency: optStr,
    successMetric: optStr,
    mandatoryClaims: optStr,
    kpis: z.array(z.string()).optional(),
  }),
  approve: z.object({ artifactId: str.min(1), note: optStr }),
  reject: z.object({ artifactId: str.min(1), reason: optStr }),
  revise: z.object({ artifactId: str.min(1), feedback: optStr }),
  edit: z.object({ artifactId: str.min(1), fields: z.record(z.unknown()) }),
  rollback: z.object({ artifactId: str.min(1), reason: optStr }),
  mention: z.object({ artifactId: str.min(1), toRole: str.min(1), message: str.min(1).max(2_000) }),
  figmaEdit: z.object({ frame: str.min(1), content: str.max(5_000) }),
  command: z.object({ text: str.min(1).max(2_000) }),
  intakeReply: z.object({ text: str.min(1).max(4_000) }),
  ingest: z.object({ fileBase64: str.min(1).max(30_000_000), apply: z.boolean().optional() }),

  // Inbound (public entry points)
  inboundEmail: z.object({
    from: str.min(1).max(200),
    subject: z.string().max(500).optional(),
    body: z.string().max(20_000).optional(),
    sessionId: optStr,
  }),
} as const;

/** First human-readable problem in a Zod error. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid request body";
}

/**
 * Fixed-window rate limiter for the public inbound endpoints (§14 hardening).
 * In-memory by design — one process, local-first; swap for a shared store when
 * the platform runs multi-instance.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** True if the caller is within budget; false → reject with 429. */
  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count += 1;
    if (this.hits.size > 10_000) this.hits.clear(); // bounded
    return entry.count <= this.limit;
  }
}
