import type { ModelProvider, ModelRequest, ModelResponse } from "../types";

/**
 * Real Claude provider (Anthropic-First, spec §9.4). The SDK is an optional
 * dependency and imported lazily, so the foundation runs with no key and no
 * SDK installed — the gateway simply falls back to the mock provider.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  private client: unknown | null = null;

  constructor(private readonly apiKey: string) {}

  supports(model: string): boolean {
    return model.startsWith("claude-");
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    // Lazy import keeps the SDK optional at install/runtime.
    const mod = await import("@anthropic-ai/sdk").catch(() => {
      throw new Error(
        "ANTHROPIC_API_KEY is set but @anthropic-ai/sdk is not installed. Run `npm install`.",
      );
    });
    const Anthropic = (mod as any).default ?? (mod as any).Anthropic;
    this.client = new Anthropic({ apiKey: this.apiKey });
    return this.client;
  }

  async complete(req: ModelRequest & { model: string }): Promise<ModelResponse> {
    const client = await this.getClient();
    const msg = await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
    });
    const text = (msg.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    return {
      text,
      model: req.model,
      provider: this.name,
      usage: {
        input: msg.usage?.input_tokens ?? 0,
        output: msg.usage?.output_tokens ?? 0,
      },
    };
  }
}
