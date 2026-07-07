/** A single model request routed through the gateway. */
export interface ModelRequest {
  system: string;
  prompt: string;
  /** Scopes token accounting + budget enforcement to a campaign (spec §9.4). */
  campaignId: string;
  maxTokens?: number;
  /** Optional model override; otherwise the gateway routes by policy/default. */
  model?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface ModelResponse {
  text: string;
  model: string;
  provider: string;
  usage: TokenUsage;
}

/** A provider is a concrete model backend (Anthropic, a mock, later others). */
export interface ModelProvider {
  readonly name: string;
  /** Which model ids this provider can serve. */
  supports(model: string): boolean;
  complete(req: ModelRequest & { model: string }): Promise<ModelResponse>;
}
