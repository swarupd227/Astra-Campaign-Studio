/**
 * Golden sets (spec §9.2). Hilti's approved exemplars anchor what "on-brand" and
 * "correct" mean, so quality is measured against real standards rather than a
 * generic rubric. Model-graded evaluators few-shot on these; the human-adjudicated
 * decisions that refine them would be written back here over time.
 */
export interface GoldenSet {
  brandVoice: {
    descriptor: string;
    /** Approved, on-brand exemplars. */
    onBrand: string[];
    /** Known off-brand phrasings to steer away from. */
    offBrand: string[];
  };
  /** Approved product claims and whether each needs a substantiation footnote. */
  approvedClaims: { claim: string; requiresFootnote: boolean }[];
  /** Terms that are never acceptable in Hilti marketing copy. */
  bannedTerms: string[];
}

/** A reviewer decision offered to the admin as a golden-set candidate (§9.2). */
export interface TuningSuggestion {
  text: string;
  reason: string;
  source: string;
  at: string;
}

/**
 * Admin-manageable golden set + the eval feedback loop (spec §9.2: "humans
 * adjudicate borderline cases; decisions feed back to tune the evals"). Reviewer
 * rejections of copy that PASSED the automated gates become suggestions here;
 * accepting one adds it as an off-brand exemplar, so future model-graded runs
 * few-shot on the newly adjudicated standard. Admins can also curate exemplars
 * and banned terms directly.
 */
export class GoldenSetStore {
  private readonly suggestions: TuningSuggestion[] = [];

  constructor(
    private golden: GoldenSet,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  current(): GoldenSet {
    return {
      brandVoice: {
        descriptor: this.golden.brandVoice.descriptor,
        onBrand: [...this.golden.brandVoice.onBrand],
        offBrand: [...this.golden.brandVoice.offBrand],
      },
      approvedClaims: this.golden.approvedClaims.map((c) => ({ ...c })),
      bannedTerms: [...this.golden.bannedTerms],
    };
  }

  addBannedTerm(term: string): void {
    const t = term.trim().toLowerCase();
    if (t && !this.golden.bannedTerms.includes(t)) this.golden.bannedTerms.push(t);
  }

  removeBannedTerm(term: string): void {
    this.golden.bannedTerms = this.golden.bannedTerms.filter((t) => t !== term.trim().toLowerCase());
  }

  addExemplar(kind: "onBrand" | "offBrand", text: string): void {
    const t = text.trim();
    if (t && !this.golden.brandVoice[kind].includes(t)) this.golden.brandVoice[kind].push(t);
  }

  removeExemplar(kind: "onBrand" | "offBrand", text: string): void {
    this.golden.brandVoice[kind] = this.golden.brandVoice[kind].filter((x) => x !== text);
  }

  /** The feedback loop's inbox: a human overruled the automated gates. */
  suggest(text: string, reason: string, source: string): void {
    const t = text.trim();
    if (!t || this.suggestions.some((s) => s.text === t)) return;
    this.suggestions.unshift({ text: t, reason, source, at: this.now() });
    if (this.suggestions.length > 20) this.suggestions.length = 20;
  }

  listSuggestions(): TuningSuggestion[] {
    return [...this.suggestions];
  }

  /** Accept: the rejected copy becomes an off-brand exemplar anchoring future grading. */
  acceptSuggestion(text: string): boolean {
    const idx = this.suggestions.findIndex((s) => s.text === text);
    if (idx === -1) return false;
    this.addExemplar("offBrand", this.suggestions[idx]!.text);
    this.suggestions.splice(idx, 1);
    return true;
  }

  dismissSuggestion(text: string): boolean {
    const idx = this.suggestions.findIndex((s) => s.text === text);
    if (idx === -1) return false;
    this.suggestions.splice(idx, 1);
    return true;
  }
}

export function hiltiGoldenSet(): GoldenSet {
  return {
    brandVoice: {
      descriptor:
        "Confident, expert, direct. Speaks to professional trades. Leads with proof, not hype. Emphasises productivity, durability and jobsite uptime.",
      onBrand: [
        "Power through the workday. No downtime, no compromise.",
        "One battery platform. Every job. Engineered to outlast the shift.",
        "Extended runtime, so your crew keeps moving.",
      ],
      offBrand: [
        "The world's best, most revolutionary tool — guaranteed!",
        "Unbelievable cheap prices you won't find anywhere else!!!",
      ],
    },
    approvedClaims: [
      { claim: "Extended runtime with active temperature management", requiresFootnote: true },
      { claim: "One battery platform across the fleet", requiresFootnote: false },
      { claim: "Durability tested to Hilti standards", requiresFootnote: false },
    ],
    bannedTerms: ["cheap", "revolutionary", "world's best", "guaranteed", "miracle"],
  };
}
