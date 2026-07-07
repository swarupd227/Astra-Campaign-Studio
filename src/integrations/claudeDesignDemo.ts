import { heroArtSvg, type HeroArtOptions } from "./designArt";

/**
 * Bundled Claude Design demo MCP server (spec §10.1, local-first constraint).
 *
 * A minimal MCP-over-HTTP server that emulates Claude Design's surface so the
 * integration can be demonstrated end to end without Anthropic credentials:
 * the ClaudeDesignConnector performs the REAL protocol flow against it —
 * initialize → tools/list → tools/call — exactly as it would against
 * https://api.anthropic.com/v1/design/mcp. With a real token configured, the
 * same client talks to Anthropic's server instead; nothing else changes.
 *
 * Designs it produces are rendered SVGs served from /assets/design-<id>.svg,
 * so the Figma board and asset cards show actual artwork, not file paths.
 */

const PROTOCOL_VERSION = "2025-06-18";
export const DEMO_SERVER_NAME = "claude-design (local demo)";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: any;
}

interface DesignRecord {
  id: string;
  svg: string;
  brief: string;
  headline: string;
}

/** Designs created this session, addressable at /assets/design-<id>.svg. */
const designs = new Map<string, DesignRecord>();

/** Deterministic id from the design inputs (FNV-1a) — stable across re-runs. */
function designId(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const TOOLS = [
  {
    name: "create_design",
    description: "Turn a creative brief into an on-brand design. Returns the design id and a rendered preview URL.",
    inputSchema: {
      type: "object",
      properties: {
        brief: { type: "string", description: "What the design should convey." },
        headline: { type: "string", description: "Headline to set on the artwork." },
        subline: { type: "string", description: "Supporting line under the headline." },
        mood: { type: "string", enum: ["dawn", "dusk", "steel"], description: "Colour mood." },
      },
      required: ["brief"],
    },
  },
  {
    name: "refine_design",
    description: "Refine an existing design with new direction (headline, mood). Returns a new rendered variant.",
    inputSchema: {
      type: "object",
      properties: {
        designId: { type: "string" },
        headline: { type: "string" },
        mood: { type: "string", enum: ["dawn", "dusk", "steel"] },
      },
      required: ["designId"],
    },
  },
];

function createDesign(args: any): DesignRecord {
  const brief = String(args?.brief ?? "Campaign hero visual");
  const opts: HeroArtOptions = {
    ...(typeof args?.headline === "string" && args.headline.trim() ? { headline: args.headline.trim() } : {}),
    ...(typeof args?.subline === "string" && args.subline.trim() ? { subline: args.subline.trim() } : {}),
    ...(args?.mood === "dawn" || args?.mood === "dusk" || args?.mood === "steel" ? { mood: args.mood } : {}),
  };
  const id = designId(`${brief}|${opts.headline ?? ""}|${opts.subline ?? ""}|${opts.mood ?? "dawn"}`);
  const record: DesignRecord = {
    id,
    svg: heroArtSvg(opts),
    brief,
    headline: opts.headline ?? "No downtime, no compromise.",
  };
  designs.set(id, record);
  return record;
}

function toolResult(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export interface DemoRpcReply {
  status: number;
  body: unknown | null;
  sessionId?: string;
}

/** Handle one JSON-RPC message the way a streamable-HTTP MCP server would. */
export function handleClaudeDesignRpc(req: JsonRpcRequest): DemoRpcReply {
  const reply = (result: unknown): DemoRpcReply => ({
    status: 200,
    body: { jsonrpc: "2.0", id: req.id ?? null, result },
    sessionId: "astra-design-demo",
  });
  const fail = (code: number, message: string): DemoRpcReply => ({
    status: 200,
    body: { jsonrpc: "2.0", id: req.id ?? null, error: { code, message } },
  });

  switch (req.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: DEMO_SERVER_NAME, version: "0.1.0" },
      });
    case "notifications/initialized":
      return { status: 202, body: null }; // notification: acknowledged, no body
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const args = req.params?.arguments ?? {};
      if (name === "create_design") {
        const d = createDesign(args);
        return reply(
          toolResult({ designId: d.id, url: `/assets/design-${d.id}.svg`, format: "svg", headline: d.headline }),
        );
      }
      if (name === "refine_design") {
        const base = designs.get(String(args?.designId ?? ""));
        if (!base) return fail(-32602, `Unknown designId: ${args?.designId}`);
        const d = createDesign({ brief: base.brief, headline: args?.headline ?? base.headline, mood: args?.mood });
        return reply(
          toolResult({ designId: d.id, url: `/assets/design-${d.id}.svg`, format: "svg", refinedFrom: base.id }),
        );
      }
      return fail(-32602, `Unknown tool: ${name}`);
    }
    default:
      return fail(-32601, `Method not supported: ${req.method}`);
  }
}

/**
 * Resolve an /assets/ file to SVG content. Knows the built-in hero art names
 * (the Image Generation Agent's fallback path) and session-created designs.
 */
export function assetSvg(fileName: string): string | null {
  if (!/^[a-z0-9@._-]+\.svg$/i.test(fileName)) return null;
  if (fileName === "hero-jobsite-sunrise.svg") return heroArtSvg();
  if (fileName === "hero-jobsite-sunrise-crops.svg") return heroArtSvg({ mood: "steel" });
  const design = /^design-([a-z0-9]+)\.svg$/.exec(fileName);
  if (design) return designs.get(design[1]!)?.svg ?? null;
  return null;
}
