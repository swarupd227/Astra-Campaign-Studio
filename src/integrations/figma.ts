import type { Connector, McpTool } from "./mcp";

/**
 * Figma connector (spec §10.3) — the demo integration, token-optional.
 *
 * A campaign's board is a template of NAMED PLACEHOLDER FRAMES; mapping approved
 * content into frames is a deterministic contract, not guesswork.
 *
 * Modes:
 *  - **mock** (default, no credentials): an in-memory board with the same tool
 *    surface, so the mapping agent and round-trip sync run with zero dependencies.
 *  - **live** (token + file key configured): real calls to the Figma REST API —
 *    `get_template`/`read_board` read the actual file (named frames + their text),
 *    and `map_content` posts the mapped copy as comments on the file. Note: the
 *    Figma REST API is read-only for canvas content, so true in-canvas placement
 *    is the plugin/MCP write path; comments make the mapping visible in Figma today.
 */

/** The placeholder frames a campaign board template exposes. */
export const FIGMA_FRAMES = [
  "paid-headline",
  "paid-body",
  "hero-image",
  "email-subject",
  "email-hero",
  "landing-hero",
] as const;
export type FigmaFrame = (typeof FIGMA_FRAMES)[number];

export const FIGMA_SCOPES = {
  read: "figma:board.read",
  write: "figma:board.write",
} as const;

export interface FigmaBoard {
  boardId: string;
  /** frame name → placed content ("" means still a placeholder). */
  frames: Record<string, string>;
  version: number;
}

export interface MapContentInput {
  boardId: string;
  mappings: Partial<Record<FigmaFrame, string>>;
}

export interface FigmaLiveConfig {
  /** Personal access token (X-Figma-Token). */
  token: string;
  /** The file key of the campaign board template (from the Figma file URL). */
  fileKey: string;
}

export interface FigmaStatus {
  mode: "mock" | "live";
  fileKey: string | null;
  tokenHint: string | null;
}

const FIGMA_TOOLS: McpTool[] = [
  {
    name: "get_template",
    description: "Return the campaign board template with its named placeholder frames.",
    scopes: [FIGMA_SCOPES.read],
    effect: "read",
  },
  {
    name: "map_content",
    description: "Deterministically place approved content into named placeholder frames.",
    scopes: [FIGMA_SCOPES.write],
    effect: "write",
  },
  {
    name: "read_board",
    description: "Read the current board state (used for designer round-trip sync).",
    scopes: [FIGMA_SCOPES.read],
    effect: "read",
  },
];

/** Minimal shape of the Figma file-nodes tree we walk. */
interface FigmaNode {
  name?: string;
  type?: string;
  characters?: string;
  children?: FigmaNode[];
}

export class FigmaConnector implements Connector {
  readonly name = "figma";
  readonly tools = FIGMA_TOOLS;
  /** Mock board store + live overlay of mapped content, keyed by boardId. */
  private readonly boards = new Map<string, FigmaBoard>();
  private live?: FigmaLiveConfig;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Enable live mode (token + file key) or revert to mock (null). In-memory only. */
  configure(cfg: FigmaLiveConfig | null): void {
    this.live = cfg && cfg.token.trim() && cfg.fileKey.trim()
      ? { token: cfg.token.trim(), fileKey: cfg.fileKey.trim() }
      : undefined;
  }

  status(): FigmaStatus {
    return {
      mode: this.live ? "live" : "mock",
      fileKey: this.live?.fileKey ?? null,
      tokenHint: this.live ? `••••${this.live.token.slice(-4)}` : null,
    };
  }

  async execute(tool: string, input: unknown): Promise<{ result: unknown; summary: string }> {
    return this.live ? this.executeLive(tool, input) : this.executeMock(tool, input);
  }

  // ── mock mode ────────────────────────────────────────────────────────────────

  private template(boardId: string): FigmaBoard {
    const frames: Record<string, string> = {};
    for (const f of FIGMA_FRAMES) frames[f] = "";
    return { boardId, frames, version: 1 };
  }

  private board(boardId: string): FigmaBoard {
    let b = this.boards.get(boardId);
    if (!b) {
      b = this.template(boardId);
      this.boards.set(boardId, b);
    }
    return b;
  }

  private async executeMock(tool: string, input: unknown): Promise<{ result: unknown; summary: string }> {
    switch (tool) {
      case "get_template": {
        const { boardId } = input as { boardId: string };
        const b = this.board(boardId);
        return {
          result: b,
          summary: `Fetched board template with ${FIGMA_FRAMES.length} placeholder frames.`,
        };
      }
      case "map_content": {
        const { boardId, mappings } = input as MapContentInput;
        const b = this.board(boardId);
        const placed: string[] = [];
        for (const [frame, content] of Object.entries(mappings)) {
          if (frame in b.frames && content) {
            b.frames[frame] = content;
            placed.push(frame);
          }
        }
        b.version += 1;
        const filled = Object.values(b.frames).filter((v) => v !== "").length;
        return {
          result: { ...b, frames: { ...b.frames } },
          summary: `Placed content into ${placed.length} frame(s): ${placed.join(", ")} — board now ${filled}/${FIGMA_FRAMES.length} filled.`,
        };
      }
      case "read_board": {
        const { boardId } = input as { boardId: string };
        const b = this.board(boardId);
        return { result: { ...b, frames: { ...b.frames } }, summary: `Read board (v${b.version}).` };
      }
      default:
        throw new Error(`Figma connector has no tool ${tool}`);
    }
  }

  /**
   * Test/demo helper simulating a designer refining a frame — mock mode only.
   * In live mode designers edit in Figma itself and `read_board` syncs the file.
   */
  simulateDesignerEdit(boardId: string, frame: FigmaFrame, content: string): void {
    if (this.live) {
      throw new Error("Figma is connected live — edit the frame in Figma itself, then sync.");
    }
    const b = this.board(boardId);
    b.frames[frame] = content;
    b.version += 1;
  }

  // ── live mode (Figma REST API) ───────────────────────────────────────────────

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`https://api.figma.com${path}`, {
      ...init,
      headers: {
        "X-Figma-Token": this.live!.token,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(`Figma API ${res.status}: ${detail}`);
    }
    return (await res.json()) as T;
  }

  /** Walk the file tree and collect text content of frames named after our placeholders. */
  private collectFrames(node: FigmaNode, out: Record<string, string>): void {
    if (node.name && (FIGMA_FRAMES as readonly string[]).includes(node.name)) {
      out[node.name] = extractText(node).trim();
    }
    for (const child of node.children ?? []) this.collectFrames(child, out);
  }

  private async readLiveBoard(boardId: string): Promise<FigmaBoard> {
    const file = await this.api<{ document: FigmaNode; version?: string }>(
      `/v1/files/${encodeURIComponent(this.live!.fileKey)}`,
    );
    const found: Record<string, string> = {};
    this.collectFrames(file.document, found);
    const overlay = this.board(boardId); // mapped content posted as comments
    const frames: Record<string, string> = {};
    for (const f of FIGMA_FRAMES) frames[f] = found[f] || overlay.frames[f] || "";
    const version = Number(file.version) || overlay.version;
    return { boardId, frames, version };
  }

  private async executeLive(tool: string, input: unknown): Promise<{ result: unknown; summary: string }> {
    switch (tool) {
      case "get_template": {
        const { boardId } = input as { boardId: string };
        const board = await this.readLiveBoard(boardId);
        const present = Object.values(board.frames).filter(Boolean).length;
        return {
          result: board,
          summary: `Read Figma file ${this.live!.fileKey}: ${present}/${FIGMA_FRAMES.length} named frames carry content.`,
        };
      }
      case "read_board": {
        const { boardId } = input as { boardId: string };
        const board = await this.readLiveBoard(boardId);
        return { result: board, summary: `Synced board from Figma file ${this.live!.fileKey} (v${board.version}).` };
      }
      case "map_content": {
        const { boardId, mappings } = input as MapContentInput;
        const overlay = this.board(boardId);
        const placed: string[] = [];
        for (const [frame, content] of Object.entries(mappings)) {
          if (!(frame in overlay.frames) || !content) continue;
          overlay.frames[frame] = content;
          placed.push(frame);
          await this.api(`/v1/files/${encodeURIComponent(this.live!.fileKey)}/comments`, {
            method: "POST",
            body: JSON.stringify({ message: `Astra · ${frame}:\n${content}` }),
          });
        }
        overlay.version += 1;
        const board = await this.readLiveBoard(boardId);
        return {
          result: board,
          summary: `Mapped ${placed.length} frame(s) and posted them as comments on the Figma file (REST canvas writes need the plugin/MCP path).`,
        };
      }
      default:
        throw new Error(`Figma connector has no tool ${tool}`);
    }
  }
}

function extractText(node: FigmaNode): string {
  if (node.type === "TEXT" && node.characters) return node.characters;
  return (node.children ?? []).map(extractText).filter(Boolean).join(" ");
}
