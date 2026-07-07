import { MockProvider } from "./providers/mock";
import { AnthropicProvider } from "./providers/anthropic";
import type { ModelProvider, ModelRequest, ModelResponse } from "./types";
import { mergeHits, sanitiseOutbound } from "../security/contentSafety";

export interface GatewayConfig {
  defaultModel: string;
  /** Per-campaign output+input token budget; 0 = unlimited (spec §9.4 cost governance). */
  campaignTokenBudget: number;
  anthropicApiKey?: string;
}

export class TokenBudgetExceededError extends Error {
  constructor(campaignId: string, spent: number, budget: number) {
    super(`Token budget exceeded for campaign ${campaignId}: ${spent}/${budget}`);
    this.name = "TokenBudgetExceededError";
  }
}

/**
 * The model gateway (spec §9.4). Every agent calls the gateway, never a provider
 * directly — so routing, fallback, and cost governance are structural, and Hilti
 * is never locked to one model. Anthropic-First: Claude is the default; the mock
 * provider is the resilient last-resort fallback (and the no-key default).
 */
export interface GatewayStatus {
  /** Whether a Claude API key is configured (never exposes the key itself). */
  hasAnthropicKey: boolean;
  /** Which provider agent calls route to right now. */
  activeProvider: "anthropic" | "mock";
  defaultModel: string;
  /** Masked hint of the configured key (last 4 chars) — safe to display. */
  keyHint: string | null;
}

export class ModelGateway {
  private providers: ModelProvider[] = [];
  private readonly spentByCampaign = new Map<string, number>();
  private anthropicApiKey: string | undefined;
  /** Trust & safety counters (spec §14.1): redactions applied to outbound prompts. */
  private safetyHits: Record<string, number> = {};

  constructor(private readonly config: GatewayConfig) {
    this.anthropicApiKey = config.anthropicApiKey;
    this.rebuildProviders();
  }

  /** (Re)build the provider chain. Anthropic first when keyed; mock is always the fallback. */
  private rebuildProviders(): void {
    const providers: ModelProvider[] = [];
    if (this.anthropicApiKey) providers.push(new AnthropicProvider(this.anthropicApiKey));
    providers.push(new MockProvider());
    this.providers = providers;
  }

  /**
   * Set or clear the Claude API key at runtime (from the Admin Settings page).
   * Held in memory only — never persisted to disk or logged (spec §9.5).
   */
  setAnthropicKey(key: string | null): void {
    const trimmed = key?.trim();
    this.anthropicApiKey = trimmed ? trimmed : undefined;
    this.rebuildProviders();
  }

  /** Non-secret gateway status for the Settings page. */
  status(): GatewayStatus {
    return {
      hasAnthropicKey: Boolean(this.anthropicApiKey),
      activeProvider: this.anthropicApiKey ? "anthropic" : "mock",
      defaultModel: this.config.defaultModel,
      keyHint: this.anthropicApiKey ? `••••${this.anthropicApiKey.slice(-4)}` : null,
    };
  }

  /** Total tokens spent so far on a campaign (for telemetry/§14 and budget checks). */
  spent(campaignId: string): number {
    return this.spentByCampaign.get(campaignId) ?? 0;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const model = req.model ?? this.config.defaultModel;
    this.assertBudget(req.campaignId);

    // Outbound sweep (spec §9.5): PII and secrets are redacted before any prompt
    // leaves the platform toward a model provider — structural, not per-agent.
    const system = sanitiseOutbound(req.system);
    const prompt = sanitiseOutbound(req.prompt);
    this.safetyHits = mergeHits(this.safetyHits, mergeHits(system.hits, prompt.hits));
    const safeReq = { ...req, system: system.text, prompt: prompt.text };

    const candidates = this.providers.filter((p) => p.supports(model));
    // Guarantee at least the mock as a fallback even for unknown model ids.
    if (!candidates.some((p) => p.name === "mock")) {
      candidates.push(new MockProvider());
    }

    let lastError: unknown;
    for (const provider of candidates) {
      try {
        const res = await provider.complete({ ...safeReq, model });
        this.charge(req.campaignId, res.usage.input + res.usage.output);
        return res;
      } catch (err) {
        lastError = err;
        // Fall through to the next provider (resilient fallback, §9.4).
      }
    }
    throw new Error(
      `All providers failed for model ${model}: ${(lastError as Error)?.message ?? "unknown error"}`,
    );
  }

  private assertBudget(campaignId: string): void {
    const budget = this.config.campaignTokenBudget;
    if (budget > 0 && this.spent(campaignId) >= budget) {
      throw new TokenBudgetExceededError(campaignId, this.spent(campaignId), budget);
    }
  }

  private charge(campaignId: string, tokens: number): void {
    this.spentByCampaign.set(campaignId, this.spent(campaignId) + tokens);
  }

  /** Trust & safety counters: redactions applied to outbound prompts (spec §14.1). */
  safety(): Record<string, number> {
    return { ...this.safetyHits };
  }
}
