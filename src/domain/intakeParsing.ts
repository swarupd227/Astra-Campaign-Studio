/**
 * Deterministic intake-field extraction (spec §6.0). Used by the mock provider to
 * stand in for Claude on extraction prompts, so the conversational intake runs
 * offline and reproducibly. With a real key, Claude does the extraction and this
 * parser is simply the offline twin.
 */

export type IntakeFieldKey = "objective" | "markets" | "budget" | "successMetric" | "mandatoryClaims";

export interface IntakeFields {
  objective?: string;
  markets?: string[];
  budget?: number;
  successMetric?: string;
  /** null = the requester explicitly said there are none. */
  mandatoryClaims?: string | null;
}

const REGION_GROUPS: Record<string, string[]> = {
  dach: ["DE", "AT", "CH"],
  nordics: ["SE", "NO", "DK", "FI"],
  benelux: ["BE", "NL", "LU"],
};

const COUNTRY_NAMES: Record<string, string> = {
  germany: "DE",
  deutschland: "DE",
  austria: "AT",
  switzerland: "CH",
  "united states": "US",
  usa: "US",
  america: "US",
  "united kingdom": "GB",
  britain: "GB",
  france: "FR",
  italy: "IT",
  spain: "ES",
  poland: "PL",
  netherlands: "NL",
  belgium: "BE",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  finland: "FI",
};

const KNOWN_CODES = new Set(["DE", "AT", "CH", "US", "GB", "FR", "IT", "ES", "PL", "NL", "BE", "LU", "SE", "NO", "DK", "FI"]);

export function parseMarkets(text: string, targeted: boolean): string[] {
  const found = new Set<string>();
  const lower = text.toLowerCase();
  for (const [region, codes] of Object.entries(REGION_GROUPS)) {
    if (new RegExp(`\\b${region}\\b`).test(lower)) codes.forEach((c) => found.add(c));
  }
  for (const [name, code] of Object.entries(COUNTRY_NAMES)) {
    if (lower.includes(name)) found.add(code);
  }
  // Bare ISO codes: uppercase anywhere ("US", "DE"), any case when the question
  // being answered IS the markets question ("de, at, ch").
  const codeSource = targeted ? text.toUpperCase() : text;
  for (const m of codeSource.matchAll(/\b([A-Z]{2})\b/g)) {
    if (KNOWN_CODES.has(m[1]!)) found.add(m[1]!);
  }
  return [...found];
}

export function parseBudget(text: string, targeted: boolean): number | undefined {
  // e.g. "€750k", "750,000", "1.2m", "eur 500000", "300k"
  const re = /(€|\$|eur|usd)?\s*(\d{1,3}(?:[.,]\d{3})+|\d+(?:\.\d+)?)\s*(k|m|mio|million|thousand)?\b/gi;
  for (const m of text.matchAll(re)) {
    const [, currency, rawNum, suffix] = m;
    let n: number;
    if (/[.,]\d{3}(\D|$)/.test(rawNum! + " ")) {
      n = Number(rawNum!.replace(/[.,]/g, "")); // grouped thousands
    } else {
      n = Number(rawNum!.replace(",", "."));
    }
    if (!Number.isFinite(n) || n <= 0) continue;
    const s = (suffix ?? "").toLowerCase();
    if (s === "k" || s === "thousand") n *= 1_000;
    if (s === "m" || s === "mio" || s === "million") n *= 1_000_000;
    // Accept when clearly a money amount — currency, magnitude suffix, a large
    // number, or any number when the budget question is the one being answered.
    if (currency || s || n >= 10_000 || (targeted && n >= 100)) return Math.round(n);
  }
  return undefined;
}

const METRICS: [RegExp, string][] = [
  [/qualified leads/i, "Qualified leads"],
  [/demo requests?/i, "Demo requests"],
  [/\bleads?\b/i, "Qualified leads"],
  [/click.?through|(^|\W)ctr(\W|$)/i, "Paid-social CTR"],
  [/conversions?/i, "Conversions"],
  [/sign.?ups?/i, "Sign-ups"],
  [/\bsales\b|revenue/i, "Sales revenue"],
  [/awareness|reach\b/i, "Brand awareness"],
];

export function parseSuccessMetric(text: string, targeted: boolean): string | undefined {
  for (const [re, canonical] of METRICS) {
    if (re.test(text)) return canonical;
  }
  const trimmed = text.trim();
  if (targeted && trimmed.length >= 3 && trimmed.length <= 60) return trimmed;
  return undefined;
}

const NEGATIVE = /^(none|no|nothing|n\/a|nope|nein|not really)\b/i;

/**
 * Extract whatever fields the user's message provides. `lastAsked` is the field
 * the interviewer just asked about — its answer is interpreted in that context
 * ("asks only what's missing" relies on opportunistic extraction of the rest).
 */
export function extractIntakeFields(lastAsked: IntakeFieldKey | null, text: string): IntakeFields {
  const out: IntakeFields = {};
  const markets = parseMarkets(text, lastAsked === "markets");
  if (markets.length) out.markets = markets;
  const budget = parseBudget(text, lastAsked === "budget");
  if (budget !== undefined) out.budget = budget;
  const metric = parseSuccessMetric(text, lastAsked === "successMetric");
  if (metric) out.successMetric = metric;

  if (lastAsked === "objective" && text.trim().length >= 8) {
    out.objective = text.trim();
  }
  if (lastAsked === "mandatoryClaims") {
    out.mandatoryClaims = NEGATIVE.test(text.trim()) ? null : text.trim();
  }
  return out;
}
