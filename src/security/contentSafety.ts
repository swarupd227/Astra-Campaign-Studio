/**
 * Content safety (spec §9.5 data protection, §13 injection posture) — three
 * dependency-free detectors applied at the platform's structural seams:
 *
 *  - PII redaction   → outbound model prompts (nothing personal reaches a provider)
 *  - Secret scanning → outbound prompts + ingested documents
 *  - Injection defence → inbound connector results + ingested documents
 *    ("everything the platform reads from external systems is data, not instructions")
 *
 * Detectors favour precision: money amounts ("€750,000") and product codes must
 * never be redacted, so phone matching requires international/parenthesised forms
 * and card matching requires a Luhn pass.
 */

export interface SweepResult {
  text: string;
  /** Redaction/neutralisation counts by type, e.g. { email: 1, secret: 2 }. */
  hits: Record<string, number>;
}

// ── PII ────────────────────────────────────────────────────────────────────────

const EMAIL = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
// International (+49 …) or parenthesised-area-code forms only — plain digit runs
// like budgets are deliberately NOT treated as phone numbers.
const PHONE = /(?:\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,5}){2,4})|(?:\(0?\d{2,4}\)\s?\d{3,5}[\s-]?\d{3,5})/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/g;
const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

function luhnValid(digits: string): boolean {
  const ds = digits.replace(/\D/g, "");
  if (ds.length < 13 || ds.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = ds.length - 1; i >= 0; i--) {
    let d = Number(ds[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redactPii(text: string): SweepResult {
  const hits: Record<string, number> = {};
  const count = (type: string, n: number) => {
    if (n > 0) hits[type] = (hits[type] ?? 0) + n;
  };

  let out = text;
  const emails = out.match(EMAIL)?.length ?? 0;
  out = out.replace(EMAIL, "[redacted:email]");
  count("email", emails);

  const phones = out.match(PHONE)?.length ?? 0;
  out = out.replace(PHONE, "[redacted:phone]");
  count("phone", phones);

  const ibans = out.match(IBAN)?.length ?? 0;
  out = out.replace(IBAN, "[redacted:iban]");
  count("iban", ibans);

  let cards = 0;
  out = out.replace(CARD_CANDIDATE, (m) => {
    if (!luhnValid(m)) return m; // budgets/ids fail Luhn → untouched
    cards += 1;
    return "[redacted:card]";
  });
  count("card", cards);

  return { text: out, hits };
}

// ── Secrets ────────────────────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /\bsk-[A-Za-z0-9]{20,}/g, // generic sk- keys
  /\bAKIA[A-Z0-9]{16}\b/g, // AWS access key
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bfigd_[A-Za-z0-9_-]{10,}/g, // Figma PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactSecrets(text: string): SweepResult {
  let out = text;
  let n = 0;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      n += 1;
      return "[redacted:secret]";
    });
  }
  return { text: out, hits: n ? { secret: n } : {} };
}

// ── Prompt injection ───────────────────────────────────────────────────────────

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules)/gi,
  /disregard\s+(?:the|all|your|any)\s+(?:above|previous|prior|system)\s*(?:instructions?|prompts?|rules)?/gi,
  /forget\s+(?:everything|all previous|your instructions)/gi,
  /reveal\s+(?:your|the)\s+(?:system|hidden)\s+(?:prompt|instructions)/gi,
  /(?:^|\n)\s*(?:system|assistant)\s*:\s*/gi, // role-injection inside content
  /\bnew instructions?\s*:/gi,
  /you are now(?:\s+an?)?\s+(?:unrestricted|jailbroken|developer mode)/gi,
  /\bDAN mode\b/gi,
];

/** Neutralise instruction-like content inside untrusted text (data, not directives). */
export function neutraliseInjection(text: string): SweepResult {
  let out = text;
  let n = 0;
  for (const re of INJECTION_PATTERNS) {
    out = out.replace(re, () => {
      n += 1;
      return "[blocked: instruction-like content]";
    });
  }
  return { text: out, hits: n ? { injection: n } : {} };
}

/** Full outbound sweep for model prompts: PII + secrets. */
export function sanitiseOutbound(text: string): SweepResult {
  const pii = redactPii(text);
  const secrets = redactSecrets(pii.text);
  return { text: secrets.text, hits: mergeHits(pii.hits, secrets.hits) };
}

/** Full inbound sweep for external content: secrets + injection neutralisation. */
export function sanitiseUntrusted(text: string): SweepResult {
  const secrets = redactSecrets(text);
  const inj = neutraliseInjection(secrets.text);
  return { text: inj.text, hits: mergeHits(secrets.hits, inj.hits) };
}

/** Deep-sweep every string in an arbitrary value (connector results). */
export function sweepValue(value: unknown, depth = 0): { value: unknown; hits: Record<string, number> } {
  if (depth > 8) return { value, hits: {} };
  if (typeof value === "string") {
    const r = sanitiseUntrusted(value);
    return { value: r.text, hits: r.hits };
  }
  if (Array.isArray(value)) {
    const hits: Record<string, number> = {};
    const out = value.map((v) => {
      const r = sweepValue(v, depth + 1);
      Object.assign(hits, mergeHits(hits, r.hits));
      return r.value;
    });
    return { value: out, hits };
  }
  if (value && typeof value === "object") {
    const hits: Record<string, number> = {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = sweepValue(v, depth + 1);
      Object.assign(hits, mergeHits(hits, r.hits));
      out[k] = r.value;
    }
    return { value: out, hits };
  }
  return { value, hits: {} };
}

export function mergeHits(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

export function totalHits(hits: Record<string, number>): number {
  return Object.values(hits).reduce((x, y) => x + y, 0);
}
