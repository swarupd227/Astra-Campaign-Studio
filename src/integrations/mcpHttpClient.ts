/**
 * Minimal Model Context Protocol client over streamable HTTP — enough to
 * initialize a session, list tools, and call them. Used for remote MCP servers
 * such as Claude Design (https://api.anthropic.com/v1/design/mcp). No SDK
 * dependency; responses may arrive as JSON or as an SSE stream (both handled).
 */

export interface McpRemoteTool {
  name: string;
  description?: string;
}

interface JsonRpcResponse {
  id?: number;
  result?: any;
  error?: { code: number; message: string };
}

export class McpHttpClient {
  private sessionId?: string;
  private nextId = 1;

  constructor(
    private readonly endpoint: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
    };
  }

  private async post(body: unknown): Promise<{ payload: JsonRpcResponse | null; res: Response }> {
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`MCP server ${res.status}: ${detail || res.statusText}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (!text.trim()) return { payload: null, res };
    if (contentType.includes("text/event-stream")) {
      // Take the last data: line carrying a JSON-RPC response.
      let last: JsonRpcResponse | null = null;
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        try {
          const parsed = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
          if (parsed && (parsed.result !== undefined || parsed.error)) last = parsed;
        } catch {
          /* keep scanning */
        }
      }
      return { payload: last, res };
    }
    return { payload: JSON.parse(text) as JsonRpcResponse, res };
  }

  private async rpc(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const { payload } = await this.post({ jsonrpc: "2.0", id, method, params });
    if (!payload) throw new Error(`MCP ${method}: empty response`);
    if (payload.error) throw new Error(`MCP ${method}: ${payload.error.message}`);
    return payload.result;
  }

  /** Initialize the session and return the server's identity + tool list. */
  async connect(): Promise<{ serverName: string; tools: McpRemoteTool[] }> {
    const init = await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "astra-campaign-studio", version: "0.1.0" },
    });
    // Fire-and-forget per spec; some servers require it before further calls.
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await this.rpc("tools/list", {});
    const tools: McpRemoteTool[] = (listed?.tools ?? []).map((t: any) => ({
      name: String(t.name),
      description: typeof t.description === "string" ? t.description : undefined,
    }));
    return { serverName: init?.serverInfo?.name ?? "mcp-server", tools };
  }

  async callTool(name: string, args: unknown): Promise<any> {
    return this.rpc("tools/call", { name, arguments: args ?? {} });
  }
}
