import type { Session, Paradigm } from "../types.js";
import type { Agent } from "../agent.js";
import type { MCPLoader } from "../mcp/loader.js";
import type { HorsewhipGuardImpl } from "../horsewhip/guard.js";
import { StringDecoder } from "node:string_decoder";

// ── Constants ──
export const STATUS_BAR_HEIGHT = 1;
export const MODE_BAR_HEIGHT = 1;
export const MAX_HINT_LINES = 5;
export const MAX_AUTO_CONTINUE = 20;
export const SCROLL_TOP = 1;

export const STATUS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp)$/i;

export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";

export const WATCHDOG_IDLE_MS = 60_000;

export type HintItem = { name: string; description: string };

export const COMMANDS: HintItem[] = [
  { name: "/quit", description: "Quit" },
  { name: "/exit", description: "Quit" },
  { name: "/clear", description: "Clear screen" },
  { name: "/compact", description: "Compress context" },
  { name: "/resume", description: "Resume session" },
  { name: "/help", description: "Help" },
  { name: "/metrics", description: "Metrics" },
  { name: "/health", description: "Health check" },
  { name: "/session", description: "Session info" },
  { name: "/model", description: "Switch model" },
  { name: "/deepthink", description: "Toggle deep think" },
  { name: "/plan-active", description: "Manage plans" },
  { name: "/soul", description: "View/update soul" },
];

export const PARADIGM_COLORS: Record<string, string> = {
  appraise: "green",
  constraint: "cyan",
  manual: "yellow",
};

export const PARADIGM_CYCLE: readonly Paradigm[] = ["appraise", "constraint", "manual"];

export const PARADIGM_DESC: Record<string, string> = {
  appraise: "Read-only Q&A — Horsewhip fully locked",
  constraint: "Autonomous iteration — Grow → Trim → Verify → Commit",
  manual: "Pure manual — no internal locks, follows prompts",
};

// ── Runtime state ──

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

export interface TUIState {
  workspaceRoot: string;

  // core references
  sessions: import("../session.js").SessionManager;
  mcpLoader: MCPLoader;
  guard: HorsewhipGuardImpl | {
    checkWrite: () => Promise<{ allowed: boolean; path: string }>;
    recordWrite: () => Promise<void>;
    getBoundary: () => Promise<{ locked: boolean; mode: string }>;
    lockFiles: () => void;
  };
  mcpNames: string[];
  skillNames: string[];

  // session / agent
  session: Session | null;
  agent: Agent | null;

  // lifecycle
  running: boolean;
  busy: boolean;
  streaming: boolean;
  taskAbort: AbortController | null;
  cleanupDone: boolean;

  // input
  inputBuffer: string;
  inputBoxDrawn: boolean;
  inputBoxTopRow: number;
  inputBoxHeight: number;
  inputHistory: string[];
  historyIndex: number;
  historyDraft: string;
  decoder: import("node:string_decoder").StringDecoder;
  pendingRawInput: string;
  inBracketedPaste: boolean;

  // hints
  hintFocus: number;
  prevHintCount: number;
  prevHintHeight: number;
  sessionHints: HintItem[];
  planHints: HintItem[];

  // output
  printingAssistant: boolean;
  responseCodeBlock: boolean;
  codeBlockLang: string;
  fmtLineStart: boolean;

  // stream
  streamQueue: string;
  streamDrainInterval: ReturnType<typeof setInterval> | null;

  // status bar
  statusBarDrawn: boolean;
  statusBarTopRow: number;
  taskStartTime: number | null;
  statusInterval: ReturnType<typeof setInterval> | null;
  statusFrameIdx: number;
  lastMetricsSnapshot: { humanInLoopCount: number } | null;
  livePromptChars: number;
  liveCompletionChars: number;
  thinkingActive: boolean;
  lastKnownUsage: TokenUsage | null;
  animTokens: number;
  animCacheRate: number;

  // layout
  lastScrollEnd: number;

  // paradigm
  tuiParadigm: Paradigm;

  // task
  pendingImages: string[];
  autoContinueCount: number;

  // config flags
  skipGuard: boolean;
  dev: boolean;
  yunchang: boolean;
  thinking: boolean;
  paradigmArg: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  apiKey: string | undefined;
  baseUrl: string | undefined;
}

export function createTUIState(
  workspaceRoot: string,
  sessions: TUIState["sessions"],
  mcpLoader: TUIState["mcpLoader"],
  mcpNames: TUIState["mcpNames"],
  skillNames: TUIState["skillNames"],
  guard: TUIState["guard"],
  config: {
    skipGuard?: boolean;
    dev?: boolean;
    yunchang?: boolean;
    paradigm?: string;
    thinking?: boolean;
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  },
  initialParadigm: Paradigm,
): TUIState {
  return {
    workspaceRoot,
    sessions,
    mcpLoader,
    guard,
    mcpNames,
    skillNames,

    session: null,
    agent: null,

    running: true,
    busy: false,
    streaming: false,
    taskAbort: null,
    cleanupDone: false,

    inputBuffer: "",
    inputBoxDrawn: false,
    inputBoxTopRow: 0,
    inputBoxHeight: 1,
    inputHistory: [],
    historyIndex: -1,
    historyDraft: "",
    decoder: new StringDecoder("utf8"),
    pendingRawInput: "",
    inBracketedPaste: false,

    hintFocus: 0,
    prevHintCount: 0,
    prevHintHeight: 0,
    sessionHints: [],
    planHints: [],

    printingAssistant: false,
    responseCodeBlock: false,
    codeBlockLang: "",
    fmtLineStart: true,

    streamQueue: "",
    streamDrainInterval: null,

    statusBarDrawn: false,
    statusBarTopRow: 0,
    taskStartTime: null,
    statusInterval: null,
    statusFrameIdx: 0,
    lastMetricsSnapshot: null,
    livePromptChars: 0,
    liveCompletionChars: 0,
    thinkingActive: false,
    lastKnownUsage: null,
    animTokens: 0,
    animCacheRate: 0,

    lastScrollEnd: -1,

    tuiParadigm: initialParadigm,

    pendingImages: [],
    autoContinueCount: 0,

    skipGuard: config.skipGuard ?? false,
    dev: config.dev ?? false,
    yunchang: config.yunchang ?? false,
    thinking: config.thinking ?? false,
    paradigmArg: config.paradigm,
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  };
}
