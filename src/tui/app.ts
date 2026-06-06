import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { execSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  ansi, color, write, getTermSize, enableRawMode,
  disableRawMode, setScrollRegion, resetScrollRegion,
  highlightLine, BG_RED_BASE, BG_GREEN_BASE, BG_GRAY_BASE,
} from "./screen.js";
import { Agent, buildUserContent } from "../agent.js";
import { SessionManager } from "../session.js";
import { MCPLoader } from "../mcp/loader.js";
import { HorsewhipGuardImpl } from "../horsewhip/guard.js";
import { MetricsEngine } from "../metrics.js";
import { logger } from "../logger.js";
import { charDisplayWidth, vlen, vtrunc } from "./visual.js";
import { FMT_BOLD, FMT_ITALIC, FMT_LINK, FMT_CODE, FMT_HEADER, FMT_MUTED, FMT_WHITE, applyInlineFmt, applyLineStartFmt } from "./formatting.js";
import { printStartupBanner } from "./banner.js";
import { loadPlanFile, savePlanFile, listPlanFiles } from "../target/plan.js";
import type { ProviderName } from "../providers/index.js";
import type { Paradigm } from "../types.js";
import { resolveApiKey, resolveModel } from "../global-config.js";

export interface TUIConfig {
  skipGuard?: boolean;
  dev?: boolean;
  yunchang?: boolean;
  paradigm?: string;
  thinking?: boolean;
  provider?: ProviderName;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export async function startTUI(config: TUIConfig = {}): Promise<void> {
  enableRawMode();
  write(ansi.bracketedPasteOn);

  const workspaceRoot = process.cwd();
  const sessions = new SessionManager(workspaceRoot);

  const mcpLoader = new MCPLoader(workspaceRoot);
  try { await mcpLoader.loadFromConfig(); } catch { /* offline OK */ }

  const mcpNames: string[] = mcpLoader.getLoadedServerNames();

  const skillNames: string[] = [];
  try {
    const skillsDir = join(workspaceRoot, ".chitu", "skills");
    if (existsSync(skillsDir)) {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const mdPath = join(skillsDir, entry.name, "SKILL.md");
        if (existsSync(mdPath)) {
          const raw = readFileSync(mdPath, "utf-8");
          const nameMatch = raw.match(/^---\n[\s\S]*?\nname:\s*(\S+)/m);
          if (nameMatch) skillNames.push(nameMatch[1]!);
          else skillNames.push(entry.name);
        }
      }
    }
  } catch { /* skip */ }

  const guard = config.skipGuard
    ? { checkWrite: async () => ({ allowed: true, path: "" }), recordWrite: async () => {}, getBoundary: async () => ({ locked: false, mode: "none" }), lockFiles: () => {} }
    : new HorsewhipGuardImpl(workspaceRoot, mcpLoader);

  let session: import("../types.js").Session | null = null;
  let agent: Agent | null = null;

  let running = true;
  let busy = false;
  let streaming = false;
  let streamQueue = "";
  let streamDrainInterval: ReturnType<typeof setInterval> | null = null;
  let taskAbort: AbortController | null = null;
  let cleanupDone = false;
  let inputBuffer = "";
  let inputBoxDrawn = false;
  let inputBoxTopRow = 0;
  let inputBoxHeight = 1;
  const inputHistory: string[] = [];
  let historyIndex = -1;
  let historyDraft = "";
  let hintFocus = 0;
  let prevHintCount = 0;
  let prevHintHeight = 0;
  let printingAssistant = false;
  let responseCodeBlock = false;
  let codeBlockLang = "";

  // --- Status bar state ---
  let statusBarDrawn = false;
  let statusBarTopRow = 0;
  const STATUS_BAR_HEIGHT = 1;
  const MODE_BAR_HEIGHT = 1;
  const MAX_HINT_LINES = 5;
  let taskStartTime: number | null = null;
  let statusInterval: ReturnType<typeof setInterval> | null = null;
  let statusFrameIdx = 0;
  const STATUS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let lastMetricsSnapshot: { humanInLoopCount: number } | null = null;
  let livePromptChars = 0;
  let liveCompletionChars = 0;
  let thinkingActive = false; // true while still in "思考中..." phase
  let lastKnownUsage: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens: number } | null = null;
  // Animated display values for token counter effect
  let animTokens = 0;
  let animCacheRate = 0;
  // --- Image detection ---

  const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp)$/i;

  const detectImages = (task: string): { cleanText: string; imagePaths: string[] } => {
    const words = task.split(/(\s+)/);
    const imagePaths: string[] = [];
    const cleanParts: string[] = [];

    for (const w of words) {
      const trimmed = w.trim();
      if (trimmed && IMAGE_EXTS.test(trimmed)) {
        // Resolve relative / absolute path with path traversal protection
        const resolved = trimmed.startsWith("/") ? trimmed : join(workspaceRoot, trimmed);
        const normalized = resolved.startsWith(workspaceRoot + sep)
          ? resolved
          : (resolved.startsWith("/") && !resolved.includes(".."))
            ? resolved
            : null;
        if (!normalized) continue; // path traversal blocked
        if (existsSync(normalized)) {
          try {
            const buf = readFileSync(resolved);
            // Basic image signature check
            const head = buf[0]!;
            if (head === 0x89 || head === 0xFF || head === 0x47 || head === 0x42 || head === 0x52) {
              imagePaths.push(resolved);
              continue; // skip adding path to clean text
            }
          } catch { /* not an image — include path as text */ }
        }
      }
      cleanParts.push(w);
    }

    return { cleanText: cleanParts.join(""), imagePaths };
  };

  let tuiParadigm: Paradigm = (config.paradigm as Paradigm | undefined) ?? "appraise";

  // ── Paradigm persistence: remember last used paradigm across sessions ──
  const paradigmPrefFile = join(workspaceRoot, ".chitu", "paradigm.json");
  const loadParadigmPref = (): string | null => {
    try {
      if (existsSync(paradigmPrefFile)) {
        const data = JSON.parse(readFileSync(paradigmPrefFile, "utf-8"));
        if (data.paradigm && ["appraise", "ride", "spur"].includes(data.paradigm)) {
          return data.paradigm;
        }
      }
    } catch { /* ignore */ }
    return null;
  };
  const saveParadigmPref = (p: string) => {
    try {
      const dir = join(workspaceRoot, ".chitu");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(paradigmPrefFile, JSON.stringify({ paradigm: p, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
    } catch { /* ignore */ }
  };

  // Load persisted paradigm (CLI flag takes precedence)
  if (!config.paradigm) {
    const persisted = loadParadigmPref();
    if (persisted) tuiParadigm = persisted as Paradigm;
  }

  const sanitizeAssistantText = (text: string): string =>
    text
      .replace(/\r/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b/g, "")
      .replace(/\n{3,}/g, "\n\n");

  const trimLeftToWidth = (text: string, maxWidth: number): string => {
    if (maxWidth <= 0) return "";
    let width = 0;
    let start = text.length;
    for (let i = text.length - 1; i >= 0; i--) {
      const cp = text.codePointAt(i)!;
      if (cp >= 0xDC00 && cp <= 0xDFFF && i > 0) continue;
      const cw = charDisplayWidth(cp);
      if (width + cw > maxWidth) break;
      width += cw;
      start = i;
      if (cp > 0xFFFF) i--;
    }
    return text.slice(start);
  };

  const splitInputLinesToWidth = (text: string, maxWidth: number): string[] => {
    if (maxWidth <= 0) return [""];
    const logicalLines = text.replace(/\r/g, "").split("\n");
    const wrapped: string[] = [];

    for (const logicalLine of logicalLines) {
      if (!logicalLine) {
        wrapped.push("");
        continue;
      }

      let current = "";
      let currentWidth = 0;
      for (let i = 0; i < logicalLine.length; i++) {
        const cp = logicalLine.codePointAt(i)!;
        const ch = cp > 0xFFFF ? String.fromCodePoint(cp) : logicalLine[i]!;
        const cw = charDisplayWidth(cp);

        if (currentWidth + cw > maxWidth) {
          wrapped.push(current);
          current = ch;
          currentWidth = cw;
        } else {
          current += ch;
          currentWidth += cw;
        }

        if (cp > 0xFFFF) i++;
      }

      wrapped.push(current);
    }

    return wrapped.length > 0 ? wrapped : [""];
  };

  const sanitizeInputChunk = (chunk: string): string => {
    return chunk
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // Strip ANSI escapes from pasted content so they cannot mutate terminal rendering.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b/g, "")
      // Keep \n and \t, drop other control chars (including backspace).
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
  };

  // Bottom reservation: STATUS_BAR_HEIGHT + max input lines (always reserved).
  const scrollTop = 1;

  const getMaxInputLines = (rows: number): number =>
    Math.max(1, Math.min(8, rows - STATUS_BAR_HEIGHT - MODE_BAR_HEIGHT - scrollTop));

  const clearInputBox = () => {
    if (!inputBoxDrawn) return;
    const { rows } = getTermSize();
    const maxLines = getMaxInputLines(rows);
    // Prompt is bottom-anchored above mode bar and status bar
    const bottomRow = rows - STATUS_BAR_HEIGHT - MODE_BAR_HEIGHT - 1;
    const topRow = Math.max(0, bottomRow - maxLines + 1);
    for (let i = 0; i < maxLines; i++) {
      write(ansi.moveTo(topRow + i, 0) + ansi.clearLine);
    }
    inputBoxDrawn = false;
  };

  const COMMANDS = [
    { name: "/quit", description: "退出" },
    { name: "/exit", description: "退出" },
    { name: "/clear", description: "清屏" },
    { name: "/compact", description: "压缩上下文" },
    { name: "/resume", description: "恢复历史会话" },
    { name: "/help", description: "帮助" },
    { name: "/metrics", description: "六维指标" },
    { name: "/health", description: "健康检查" },
    { name: "/session", description: "会话信息" },
    { name: "/model", description: "模型切换" },
    { name: "/deepthink", description: "深度思考开关" },
    { name: "/plan-active", description: "目标计划管理" },
    { name: "/soul", description: "查看/更新用户习惯" },
  ];

  type HintItem = { name: string; description: string };

  let sessionHints: HintItem[] = [];

  const loadSessionHints = () => {
    const all = sessions.list();
    sessionHints = all.slice(0, 20).map((s) => ({
      name: s.id,
      description: `${s.createdAt.slice(0, 10)}  ${s.task.slice(0, 60)}`,
    }));
  };

  let planHints: HintItem[] = [];

  const loadPlanHints = () => {
    const all = listPlanFiles(workspaceRoot);
    planHints = all.map((p) => {
      const icon = p.phase === "abandoned" ? "○" : p.phase === "done" ? "✓" : "●";
      return {
        name: p.id,
        description: `${icon} [${p.phase}] ${p.completedSubGoals}/${p.subGoalCount}  ${p.goal.slice(0, 50)}`,
      };
    });
  };

  const getHintMatches = (): HintItem[] => {
    if (busy) return [];
    if (!inputBuffer.startsWith("/")) return [];
    const partial = inputBuffer.trim().toLowerCase();

    // When input matches /resume, show session list directly
    if (partial === "/resume" || partial.startsWith("/resume ")) {
      if (sessionHints.length === 0) loadSessionHints();
      const filter = inputBuffer.toLowerCase().slice(8).trim();
      if (!filter) return sessionHints;
      return sessionHints.filter((s) => s.name.startsWith(filter) || s.description.includes(filter));
    }

    // When input matches /plan-active, show plan list directly
    if (partial === "/plan-active" || partial.startsWith("/plan-active ")) {
      if (planHints.length === 0) loadPlanHints();
      const filter = inputBuffer.toLowerCase().slice(13).trim();
      if (!filter) return planHints;
      return planHints.filter((p) => p.name.includes(filter) || p.description.includes(filter));
    }

    if (!partial) return COMMANDS;
    return COMMANDS.filter((c) => c.name.startsWith(partial) || c.name.includes(partial));
  };

  let lastScrollEnd = -1;

  const getHintHeight = (): number => {
    if (busy) return 0;
    if (!inputBuffer.startsWith("/")) return 0;
    const matches = getHintMatches();
    if (matches.length === 0) return 0;
    const { rows } = getTermSize();
    const maxLines = getMaxInputLines(rows);
    const gap = maxLines - inputBoxHeight;
    if (gap < 2) return 0; // need at least 2 rows (1 hint + 1 arrow)
    return Math.min(MAX_HINT_LINES, gap);
  };

  const updateScrollRegion = () => {
    const { rows } = getTermSize();
    const maxLines = getMaxInputLines(rows);
    const reserved = STATUS_BAR_HEIGHT + MODE_BAR_HEIGHT + maxLines;
    const scrollEnd = Math.max(scrollTop, rows - reserved);
    if (scrollEnd === lastScrollEnd) return;
    // Don't change scroll region while content is streaming — it can cause
    // cursor position drift and status bar text bleeding into the content area.
    if (streaming) return;
    lastScrollEnd = scrollEnd;
    setScrollRegion(scrollTop, scrollEnd);
  };

  // Bottom row (0-based) of the scroll region.
  const scrollRegionBottom = (): number => {
    const { rows } = getTermSize();
    const maxLines = getMaxInputLines(rows);
    const reserved = STATUS_BAR_HEIGHT + MODE_BAR_HEIGHT + maxLines;
    return Math.max(scrollTop - 1, rows - reserved - 1);
  };

  const beginOutputBlock = () => {
    // Start each user/error block from a fresh line in scroll area.
    write(ansi.moveTo(scrollRegionBottom(), 0) + ansi.clearLine + "\n");
  };

  const drawPrompt = (returnToScrollArea = false) => {
    const { cols, rows } = getTermSize();
    const contentWidth = Math.max(1, cols - 2);
    const allInputLines = splitInputLinesToWidth(inputBuffer, contentWidth);
    const maxInputLines = getMaxInputLines(rows);
    const visibleLines = allInputLines.slice(-maxInputLines);
    const wasTrimmed = allInputLines.length > visibleLines.length;

    const prevInputBoxHeight = inputBoxHeight;
    clearInputBox();
    inputBoxHeight = visibleLines.length;

    // 输入框长高时，先滚动内容腾出空间，避免向上抢占 AI 输出区域
    if (inputBoxHeight > prevInputBoxHeight && prevInputBoxHeight > 0) {
      const diff = inputBoxHeight - prevInputBoxHeight;
      for (let i = 0; i < diff; i++) {
        write(ansi.moveTo(scrollRegionBottom(), 0) + "\n");
      }
    }

    updateScrollRegion();

    // Clear stale hint area when panel disappears or shrinks
    const curHintH = getHintHeight();
    if (prevHintHeight > curHintH) {
      const { rows } = getTermSize();
      const promptBottom = rows - STATUS_BAR_HEIGHT - MODE_BAR_HEIGHT - 1;
      const inputBoxTop = promptBottom - inputBoxHeight + 1;
      const hintEnd = inputBoxTop - 1;
      for (let i = curHintH; i < prevHintHeight; i++) {
        const row = hintEnd - i;
        if (row > scrollRegionBottom()) write(ansi.moveTo(row, 0) + ansi.clearLine);
      }
    }
    prevHintHeight = curHintH;

    write(ansi.saveCursor);
    drawHintPanel();
    drawModeBar();
    write(ansi.restoreCursor);

    const isCommand = inputBuffer.startsWith("/");
    const USER_INPUT_BG = "\x1b[48;5;236m";

    // Anchor prompt above mode bar and status bar.
    const promptBottom = Math.max(0, rows - STATUS_BAR_HEIGHT - MODE_BAR_HEIGHT - 1);
    for (let i = 0; i < visibleLines.length; i++) {
      const lineIdx = visibleLines.length - 1 - i;
      const isFirstVisibleLine = lineIdx === 0;
      const prefix = isFirstVisibleLine
        ? (wasTrimmed ? "… " : "> ")
        : "  ";
      const line = visibleLines[lineIdx] ?? "";
      const contentColor = isCommand ? color.red : color.white;
      const rendered = color.bold(color.white(prefix)) + contentColor(trimLeftToWidth(line, contentWidth));
      write(ansi.moveTo(promptBottom - i, 0) + USER_INPUT_BG + ansi.clearLine + rendered + "\x1b[K" + ansi.reset);
    }

    // Cursor always at the bottommost line
    const lastVisibleLine = visibleLines[visibleLines.length - 1] ?? "";
    const cursorRow = Math.min(rows - 1, promptBottom);
    const cursorCol = Math.min(Math.max(0, cols - 1), 2 + vlen(lastVisibleLine));
    if (!returnToScrollArea) {
      write(ansi.moveTo(cursorRow, 0) + ansi.moveRight(cursorCol));
    } else {
      write(ansi.moveTo(scrollRegionBottom(), 0));
    }
    inputBoxDrawn = true;
    inputBoxTopRow = Math.max(0, promptBottom - inputBoxHeight + 1);
  };

  // --- Lightweight live metrics ---
  const getLiveMetrics = (): { humanInLoopCount: number } => {
    try {
      const engine = new MetricsEngine(workspaceRoot);
      const report = engine.compute();
      if (report) return { humanInLoopCount: report.humanInLoopCount };
    } catch { /* skip */ }
    return { humanInLoopCount: 0 };
  };

  const fmtTokens = (n: number): string => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  };

  const fmtTokensLive = (n: number): string => {
    if (n >= 1000) return `${(n / 1000).toFixed(3)}K`;
    return String(n);
  };

  const fmtCacheRate = (cached: number, prompt: number): string => {
    if (prompt <= 0) return "";
    return `cache:${Math.round((cached / prompt) * 100)}%`;
  };

  const PARADIGM_COLORS: Record<string, (s: string) => string> = {
    appraise: color.green,
    ride: color.magenta,
    spur: color.yellow,
  };

  const PARADIGM_CYCLE = ["appraise", "ride", "spur", "constraint"] as const;

  const PARADIGM_DESC: Record<string, string> = {
    appraise: "Read-only Q&A — Horsewhip fully locked",
    ride: "Goal-driven full workflow — Horsewhip per sub-goal",
    spur: "Single-file surgical edit — Horsewhip whip-bound",
  };

  const getActiveParadigm = (): Paradigm => {
    if (agent) return agent.getParadigmState().active;
    return tuiParadigm;
  };

  const cycleParadigm = () => {
    const current = getActiveParadigm();
    const idx = PARADIGM_CYCLE.indexOf(current);
    const next = PARADIGM_CYCLE[(idx + 1) % PARADIGM_CYCLE.length]!;
    tuiParadigm = next;
    saveParadigmPref(next);
    if (agent) {
      agent.setParadigm(next);
      agent.rebuildSystemPrompt();
    }
    drawModeBar();
  };

  const drawModeBar = () => {
    const { cols, rows } = getTermSize();
    const modeBarRow = rows - STATUS_BAR_HEIGHT - 1;

    const active = getActiveParadigm();
    const c = PARADIGM_COLORS[active] ?? color.dim;

    const desc = PARADIGM_DESC[active] ?? "";
    const label = active === "appraise" ? "Ask" : active === "ride" ? "Target" : "Modify";
    const cycleHint = PARADIGM_CYCLE.includes(active) ? " (shift+tab to cycle · ctrl+j to newline)" : "";
    const thinkingOn = agent?.getThinking();
    const thinkingTag = thinkingOn ? " " + color.yellow("[thinking]") : "";
    const line = " " + c(`<${label}>`) + thinkingTag + color.dim(` --${desc}${cycleHint}`);

    write(ansi.moveTo(modeBarRow, 0) + ansi.clearLine + line);
  };

  // --- Command hint panel ---

  const drawHintPanel = () => {
    const matches = getHintMatches();
    if (matches.length === 0) return;

    // Reset focus when match count changes
    if (matches.length !== prevHintCount) {
      hintFocus = 0;
      prevHintCount = matches.length;
    }

    const { rows } = getTermSize();
    const gap = getMaxInputLines(rows) - inputBoxHeight;
    const hintH = Math.min(MAX_HINT_LINES, gap);
    if (hintH < 2) return;

    // Clamp focus
    if (hintFocus >= matches.length) hintFocus = matches.length - 1;
    if (hintFocus < 0) hintFocus = 0;

    // Pagination: 1 row reserved for nav arrow when items exceed available rows
    const needsPaging = matches.length > hintH;
    const itemsPerPage = needsPaging ? hintH - 1 : hintH;
    const totalPages = Math.ceil(matches.length / itemsPerPage);
    const page = Math.floor(hintFocus / itemsPerPage);
    const pageStart = page * itemsPerPage;
    const pageItems = matches.slice(pageStart, pageStart + itemsPerPage);

    // Position: bottom-up from input box top
    const promptBottom = rows - STATUS_BAR_HEIGHT - MODE_BAR_HEIGHT - 1;
    const inputBoxTop = promptBottom - inputBoxHeight + 1;
    const hintEnd = inputBoxTop - 1;
    const hintStart = hintEnd - hintH + 1;
    const scrBot = scrollRegionBottom();

    let r = 0;

    // Hint items
    for (const item of pageItems) {
      const row = hintStart + r;
      r++;
      if (row <= scrBot) continue;
      const isFocused = (pageStart + pageItems.indexOf(item)) === hintFocus;
      const prefix = isFocused ? color.bold(color.cyan("▶")) : " ";
      const namePart = isFocused ? color.bold(color.cyan(item.name)) : color.cyan(item.name);
      const descPart = color.dim(` — ${item.description}`);
      write(ansi.moveTo(row, 0) + ansi.clearLine + color.dim(` ${prefix} ${namePart}${descPart}`));
    }

    // Fill unused rows below the items (within the hint area, above the nav row)
    for (let i = r; i < (needsPaging ? hintH - 1 : hintH); i++) {
      const row = hintStart + i;
      if (row > scrBot) write(ansi.moveTo(row, 0) + ansi.clearLine);
    }

    // Navigation row (last row of hint panel)
    if (needsPaging) {
      const navRow = hintStart + hintH - 1;
      if (navRow > scrBot) {
        const hasAbove = page > 0;
        const hasBelow = page < totalPages - 1;
        const nav = hasAbove
          ? (hasBelow ? `  ↑ page ${page + 1}/${totalPages}  ↓` : `  ↑ page ${page + 1}/${totalPages}`)
          : `  ↓ page ${page + 1}/${totalPages}`;
        write(ansi.moveTo(navRow, 0) + ansi.clearLine + color.dim(nav));
      }
    }
  };

  /** Odometer-style rolling animation. Lower digits spin rapidly toward target. */
  const tickAnimTokens = (target: number, targetRate: number) => {
    const gap = target - animTokens;
    if (gap <= 0) {
      animTokens = target;
    } else {
      // Random step size — creates the visual blur of spinning digits
      const range = Math.min(gap, gap > 1000 ? 200 : gap > 100 ? 50 : 10);
      const step = Math.max(1, Math.floor(Math.random() * range + 1));
      animTokens = Math.min(animTokens + step, target);
    }
    if (animCacheRate < targetRate) {
      animCacheRate = Math.min(animCacheRate + 1, targetRate);
    } else if (animCacheRate > targetRate) {
      animCacheRate = targetRate;
    }
  };

  const fmtElapsed = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  // Draw status bar at the very last row (always reserved).
  // Explicitly repositions cursor to the content area bottom after drawing,
  // avoiding DECSC/DECRC save/restore which is unreliable inside scroll regions.
  const drawStatusBar = () => {
    const { cols, rows } = getTermSize();
    const barRow = rows - STATUS_BAR_HEIGHT;

    if (busy) {
      const spinner = STATUS_FRAMES[statusFrameIdx % STATUS_FRAMES.length]!;
      statusFrameIdx++;

      const now = Date.now();
      const elapsed = taskStartTime ? fmtElapsed(now - taskStartTime) : "00:00";

      const m = lastMetricsSnapshot ?? getLiveMetrics();
      if (!lastMetricsSnapshot) lastMetricsSnapshot = m;

      const workingPart = `${spinner} 赤兔工作中 · ${elapsed}`;

      const sep = color.dim("│");

      // Animate token counter
      const u = agent?.getUsage() ?? lastKnownUsage;
      const liveComp = Math.ceil(liveCompletionChars / 4);
      const liveTotal = livePromptChars + liveComp;
      const target = u?.totalTokens ?? (streaming ? liveTotal : animTokens);
      const targetRate = (u && u.promptTokens > 0) ? Math.round((u.cachedTokens / u.promptTokens) * 100) : animCacheRate;
      tickAnimTokens(target, targetRate);

      let tokenSection = "";
      const isDeepSeek = agent ? agent?.getProviderName() === "deepseek" : false;
      if (streaming || animTokens > 0) {
        const cacheStr = isDeepSeek ? `  cache:${animCacheRate}%` : "";
        tokenSection = `${fmtTokensLive(animTokens)} tokens${cacheStr}`;
      }

      const ctxPct = agent?.getContextUsage().percentage ?? 0;
      const ctxPart = `ctx:${ctxPct}%`;
      const hitlPart = `HITL:${m.humanInLoopCount}`;
      const parts = [workingPart, tokenSection, ctxPart, hitlPart].filter(Boolean);
      const fullLine = parts.join(`  ${sep}  `);
      const trimmed = vtrunc(fullLine, cols);

      write(ansi.saveCursor);
      write(ansi.moveTo(barRow, 0) + ansi.clearLine + color.dim(trimmed));
      write(ansi.restoreCursor);
      statusBarDrawn = true;
      statusBarTopRow = barRow;
    } else {
      // Idle: always show tokens + cache rate
      const u = agent?.getUsage() ?? lastKnownUsage;
      const target = u?.totalTokens ?? 0;
      const targetRate = (u && u.promptTokens > 0) ? Math.round((u.cachedTokens / u.promptTokens) * 100) : animCacheRate;
      tickAnimTokens(target, targetRate);

      const m = lastMetricsSnapshot;
      const isDeepSeek = agent ? agent?.getProviderName() === "deepseek" : false;

      const sep = color.dim("│");
      const parts: string[] = [];
      const cacheStr = isDeepSeek ? `  cache:${animCacheRate}%` : "";
      parts.push(`${fmtTokens(animTokens)} tokens${cacheStr}`);
      const ctxPct = agent?.getContextUsage().percentage ?? 0;
      parts.push(`ctx:${ctxPct}%`);
      if (m) parts.push(`HITL:${m.humanInLoopCount}`);
      const fullLine = parts.join(`  ${sep}  `);
      const trimmed = vtrunc(fullLine, cols);

      write(ansi.saveCursor);
      write(ansi.moveTo(barRow, 0) + ansi.clearLine + color.dim(trimmed));
      write(ansi.restoreCursor);
      statusBarDrawn = true;
      statusBarTopRow = barRow;
    }
  };

  const clearStatusBar = () => {
    if (!statusBarDrawn) return;
    write(ansi.saveCursor);
    write(ansi.moveTo(statusBarTopRow, 0) + ansi.clearLine);
    write(ansi.restoreCursor);
    statusBarDrawn = false;
  };

  const startStatusBar = () => {
    taskStartTime = Date.now();
    statusFrameIdx = 0;
    lastMetricsSnapshot = null;
    liveCompletionChars = 0;
    // Recalculate prompt chars from current message context (grows each round)
    if (agent) {
      let chars = 0;
      for (const m of agent.getMessages()) {
        chars += (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? "").length;
      }
      livePromptChars = Math.ceil(chars / 4);
    }
    // Keep lastKnownUsage and animTokens from previous rounds — don't reset to zero
    animCacheRate = 0;
    drawStatusBar();
    statusInterval = setInterval(() => {
      if (busy && statusFrameIdx % 4 === 0) lastMetricsSnapshot = getLiveMetrics();
      clearStatusBar();
      drawStatusBar();
    }, 150);
  };

  const stopStatusBar = () => {
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
    // Draw final persistent status line: metrics → tokens → HITL
    const u = agent?.getUsage() ?? lastKnownUsage;
    const isDeepSeek = agent ? agent?.getProviderName() === "deepseek" : false;
    const { cols } = getTermSize();
    const m = lastMetricsSnapshot ?? getLiveMetrics();

    const sep = color.dim("│");
    const parts: string[] = [];

    if (u && u.totalTokens > 0) {
      const cacheStr = isDeepSeek ? `  ${fmtCacheRate(u.cachedTokens, u.promptTokens)}` : "";
      parts.push(`${fmtTokens(u.totalTokens)} tokens${cacheStr}`);
    }

    const ctxPct = agent?.getContextUsage().percentage ?? 0;
    parts.push(`ctx:${ctxPct}%`);
    if (m) parts.push(`HITL:${m.humanInLoopCount}`);
    const fullLine = parts.join(`  ${sep}  `);

    statusBarTopRow = getTermSize().rows - STATUS_BAR_HEIGHT;
    write(ansi.moveTo(statusBarTopRow, 0) + ansi.clearLine + color.dim(vtrunc(fullLine, cols)));
    write(ansi.moveTo(scrollRegionBottom(), 0));
    statusBarDrawn = true;
    taskStartTime = null;
  };

  const canAppendInput = (_next: string): boolean => true;

  const appendInputChunk = (chunk: string): void => {
    if (!chunk) return;
    const next = inputBuffer + chunk;
    if (canAppendInput(next)) {
      inputBuffer = next;
    }
  };

  const stopStreamDrain = () => {
    if (streamDrainInterval) {
      clearInterval(streamDrainInterval);
      streamDrainInterval = null;
    }
  };

  // ── Markdown formatting ──
  let fmtLineStart = true; // true at beginning of line (after \n or at stream start)

  const startStreamDrain = () => {
    if (streamDrainInterval) return;
    streamDrainInterval = setInterval(() => {
      if (!streamQueue) {
        if (!streaming) stopStreamDrain();
        return;
      }

      // Detect markdown code block markers: ^``` or \n```
      const markerRe = /(?:^|\n)```[^\n]*\n/;
      const match = markerRe.exec(streamQueue);

      if (match && match.index < 128) {
        const markerText = match[0];
        const langMatch = /```([^\n]*)\n/.exec(markerText);
        const lang = langMatch?.[1]?.trim() ?? "";

        if (match.index === 0) {
          responseCodeBlock = !responseCodeBlock;
          codeBlockLang = responseCodeBlock ? lang : "";
          streamQueue = streamQueue.slice(match[0].length);
          fmtLineStart = true;
        } else {
          let before = streamQueue.slice(0, match.index + 1);
          before = before.replace(/\n/g, "\n  ");
          before = applyInlineFmt(before);
          if (fmtLineStart) { before = applyLineStartFmt(before); }
          fmtLineStart = before.endsWith("\n");
          write(color.white(before));
          responseCodeBlock = !responseCodeBlock;
          codeBlockLang = responseCodeBlock ? lang : "";
          streamQueue = streamQueue.slice(match.index + match[0].length);
        }
      } else if (responseCodeBlock) {
        // Drain at most 2 lines per tick for smooth scrolling
        let drained = 0;
        while (drained < 2 && streamQueue.length > 0) {
          const nlIdx = streamQueue.indexOf("\n");
          if (nlIdx < 0) break;
          const line = streamQueue.slice(0, nlIdx + 1);
          streamQueue = streamQueue.slice(nlIdx + 1);
          if (codeBlockLang === "diff") {
            const ch0 = line[0];
            if (ch0 === "+" && line[1] !== "+") {
              write(highlightLine(line.slice(1), { bg: "green", prefix: "+", indent: 4 }) + "\x1b[K\x1b[0m\n");
            } else if (ch0 === "-" && line[1] !== "-") {
              write(highlightLine(line.slice(1), { bg: "red", prefix: "-", indent: 4 }) + "\x1b[K\x1b[0m\n");
            } else {
              const content = line.endsWith("\n") ? line.slice(0, -1) : line;
              write(BG_GRAY_BASE + "    " + "\x1b[2m" + content + "\x1b[K\x1b[0m\n");
            }
          } else {
            write(highlightLine(line, { bg: "gray", indent: 4 }) + "\x1b[K\x1b[0m\n");
          }
          drained++;
        }
      } else {
        // Drain one line per tick at 60fps for smooth terminal scrolling
        const nlIdx = streamQueue.indexOf("\n");
        const chunkLen = nlIdx >= 0 ? nlIdx + 1 : Math.min(streamQueue.length, 128);
        let chunk = streamQueue.slice(0, chunkLen);
        streamQueue = streamQueue.slice(chunkLen);
        chunk = chunk.replace(/\n/g, "\n  ");
        chunk = applyInlineFmt(chunk);
        if (fmtLineStart) { chunk = applyLineStartFmt(chunk); }
        fmtLineStart = chunk.endsWith("\n");
        write(color.white(chunk));
      }
    }, 16);
  };

  const waitForStreamDrain = async (): Promise<void> => {
    while (streamQueue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  };

  const printAssistantBlock = (text: string) => {
    // Do not clear/rewind again here, otherwise the just-printed user line can
    // be visually pushed out in short viewports.
    write(ansi.moveTo(scrollRegionBottom(), 0) + "\n");
    const normalized = sanitizeAssistantText(text).trimEnd();
    if (!normalized) {
      write(color.red("chitu:") + "\n");
      return;
    }
    const lines = normalized.split("\n");
    write(color.red("chitu: ") + color.white(lines[0] ?? "") + "\n");
    for (let i = 1; i < lines.length; i++) {
      write("  " + color.white(lines[i] ?? "") + "\n");
    }
  };

  const redrawBanner = (): number => {
    return printStartupBanner({
      skipGuard: config.skipGuard,
      dev: config.dev,
      mcpNames,
      skillNames,
      commands: COMMANDS,
      session: !!session,
    });
  };

  if (!process.stdin.isTTY) enableRawMode();

  process.stdout.on("resize", () => {
    updateScrollRegion();
    drawPrompt(busy);
    if (!busy && statusBarDrawn) {
      const { cols, rows } = getTermSize();
      const u = lastKnownUsage;
      const isDeepSeek = agent ? agent?.getProviderName() === "deepseek" : false;
      const m = lastMetricsSnapshot;
      const sep = color.dim("│");
      const parts: string[] = [];

      if (u && u.totalTokens > 0) {
        const cacheStr = isDeepSeek ? `  ${fmtCacheRate(u.cachedTokens, u.promptTokens)}` : "";
        parts.push(`${fmtTokens(u.totalTokens)} tokens${cacheStr}`);
      }

      const ctxPct = agent?.getContextUsage().percentage ?? 0;
      parts.push(`ctx:${ctxPct}%`);
      if (m) parts.push(`HITL:${m.humanInLoopCount}`);

      if (parts.length > 0) {
        const fullLine = parts.join(`  ${sep}  `);
        statusBarTopRow = rows - STATUS_BAR_HEIGHT;
        write(ansi.moveTo(statusBarTopRow, 0) + ansi.clearLine + color.dim(vtrunc(fullLine, cols)));
      }
      drawPrompt(false);
    } else if (busy && statusBarDrawn) {
      statusBarTopRow = getTermSize().rows - STATUS_BAR_HEIGHT;
      drawStatusBar();
    }
  });

  redrawBanner();
  updateScrollRegion();

  const handleTask = async (task: string) => {
    if (task === "/quit" || task === "/exit") {
      running = false;
      cleanup();
      return;
    }

    if (task === "/clear") {
      clearInputBox();
      clearStatusBar();
      statusBarDrawn = false;
      write(ansi.clear + ansi.moveTo(0, 0));
      updateScrollRegion(); // must come before redrawBanner which writes to scroll area
      redrawBanner();
      drawPrompt();
      drawStatusBar();
      return;
    }

    let compressAnimTimer: ReturnType<typeof setInterval> | null = null;
    let compressAnimProgress = 0;

    const drawCompressBar = (progress: number, label: string, done: boolean) => {
      const barW = 20;
      const p = Math.min(100, Math.max(0, Math.round(progress)));
      const filled = Math.round((p / 100) * barW);
      const bar = "█".repeat(filled) + "░".repeat(barW - filled);
      const icon = done ? "✅" : "⏳";
      write(`\x1b[2K\r${icon} 压缩上下文 [${bar}] ${p}% — ${label}`);
      if (done) write("\n");
    };

    const stopCompressAnim = () => {
      if (compressAnimTimer) {
        clearInterval(compressAnimTimer);
        compressAnimTimer = null;
      }
    };

    const onCompress = (phase: string, progress: number) => {
      if (phase === "done") {
        stopCompressAnim();
        drawCompressBar(100, "完成", true);
        return;
      }

      // Start animation on first call
      if (!compressAnimTimer) {
        compressAnimProgress = 0;
        drawCompressBar(0, "保存归档...", false);
        compressAnimTimer = setInterval(() => {
          compressAnimProgress += 1;
          // Cap at 90% — wait for real "done" signal
          if (compressAnimProgress >= 90) {
            compressAnimProgress = 90;
            clearInterval(compressAnimTimer!);
            compressAnimTimer = null;
          }
          const labels: Record<string, string> = {
            archive: "保存归档...",
            summarize: "压缩消息...",
          };
          const label = labels[phase] ?? "压缩中...";
          drawCompressBar(compressAnimProgress, label, false);
        }, 30);
      }

      // Sync phase label
      const labels: Record<string, string> = {
        archive: "保存归档...",
        summarize: "压缩消息...",
      };
      const label = labels[phase] ?? phase;
      // Jump to real progress if ahead of animation
      if (progress > compressAnimProgress) {
        compressAnimProgress = progress;
        drawCompressBar(progress, label, false);
      }
    };

    if (task === "/help") {
      const cmdList = COMMANDS.filter((c) => !c.name.startsWith("/exit")) // skip alias
        .map((c) => `${c.name} — ${c.description}`).join("\n");
      printAssistantBlock(
        `可用指令（输入 / 查看提示）：\n${cmdList}\n\n直接输入任务开始对话。ESC 取消当前运行。`,
      );
      drawPrompt();
      return;
    }

    if (task === "/metrics") {
      const engine = new MetricsEngine(workspaceRoot);
      const report = engine.compute();
      if (report) {
        const { renderMetricsReport } = await import("../metrics-renderer.js");
        printAssistantBlock(renderMetricsReport(report));
      } else {
        printAssistantBlock("No metrics data. Run a task first.");
      }
      drawPrompt();
      return;
    }

    if (task === "/health") {
      if (agent) {
        const h = agent.health();
        printAssistantBlock(
          `OK: ${h.ok}\nSession: ${h.session}\nMessages: ${h.messageCount}\nShutdown: ${h.shutdown}\n`
          + `Rate limits:\n${h.rateLimit.map((r) => `${r.tool}: ${r.used}/${r.limit} per ${r.windowMs / 1000}s`).join("\n")}`,
        );
      } else {
        printAssistantBlock("No active session.");
      }
      drawPrompt();
      return;
    }

    if (task === "/session") {
      if (session) {
        printAssistantBlock(`Session: ${session.id}\nTask: ${session.task}\nMessages: ${agent?.getMessages().length ?? 0}`);
      } else {
        printAssistantBlock("No active session.");
      }
      drawPrompt();
      return;
    }

    if (task === "/resume") {
      const all = sessions.list();
      if (all.length === 0) {
        printAssistantBlock("无历史会话。");
      } else {
        const recent = all.slice(0, 8);
        const lines = recent.map((s) => {
          const shortId = s.id.slice(0, 8);
          const date = new Date(s.updatedAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
          return `  ${shortId}  ${date}  ${s.task.slice(0, 50)}`;
        }).join("\n");
        printAssistantBlock(`历史会话（输入 /resume <id> 恢复）：\n${lines}`);
      }
      drawPrompt();
      return;
    }

    if (task.startsWith("/resume ")) {
      const idPart = task.slice(8).trim();
      const all = sessions.list();
      const match = all.find((s) => s.id.startsWith(idPart));
      if (!match) {
        printAssistantBlock(`未找到会话: ${idPart}\n输入 /resume 查看列表。`);
      } else {
        session = match;
        // Restore usage from saved session (non-DeepSeek models default cached_tokens to 0)
        if (session.usage) {
          lastKnownUsage = {
            promptTokens: session.usage.prompt_tokens,
            completionTokens: session.usage.completion_tokens,
            totalTokens: session.usage.total_tokens,
            cachedTokens: session.usage.cached_tokens ?? 0,
          };
        } else {
          lastKnownUsage = null;
        }
        agent = new Agent(workspaceRoot, session.id, mcpLoader, guard, {
          provider: config.provider,
          model: resolveModel(session.model ?? config.model),
          apiKey: resolveApiKey(config.apiKey),
          baseUrl: config.baseUrl,
          thinking: config.thinking,
          yunchang: config.yunchang,
        });
        agent.setParadigm(tuiParadigm);
        agent.restoreMessages(session.messages);
        agent.rebuildSystemPrompt();
        printAssistantBlock(
          `已恢复会话 ${session.id.slice(0, 8)}\n` +
          `任务：${session.task}\n` +
          `消息数：${session.messages.length}\n` +
          `Token 估算：${fmtTokens(agent.getContextUsage().estimatedTokens)} (${agent.getContextUsage().percentage}%)` +
          (session.usage ? `\n上次用量：${fmtTokensLive(session.usage.total_tokens)} tokens` : ``),
        );
      }
      drawPrompt();
      return;
    }

    if (task === "/model") {
      if (agent) {
        const models = agent.getDefaultModels();
        const current = agent.getModel();
        const lines = models.map((m) => m === current ? `  * ${m} (当前)` : `  - ${m}`).join("\n");
        printAssistantBlock(`可用模型：\n${lines}\n\n输入模型名切换，如 deepseek-v4-flash`);
      } else {
        printAssistantBlock("无活跃会话。");
      }
      drawPrompt();
      return;
    }

    if (task === "/deepthink" || task === "/deepthink on" || task === "/deepthink off") {
      if (agent) {
        const enable = task === "/deepthink on" || (task === "/deepthink" && !agent.getThinking());
        agent.setThinking(enable);
        drawModeBar();
        const status = enable ? "启用" : "关闭";
        printAssistantBlock(`深度思考：${status}\n大模型将${enable ? "" : "不"}在回答前进行深度思考。`);
      } else {
        printAssistantBlock("无活跃会话。");
      }
      drawPrompt();
      return;
    }

    if (task === "/soul") {
      if (agent) {
        write(ansi.moveTo(scrollRegionBottom(), 0) + "\n");
        write(color.yellow("⏳ 正在总结用户习惯...") + "\r");
        const content = await agent.summarizeSoul();
        if (content) {
          const record = (await import("../soul.js")).SoulManager.load();
          printAssistantBlock(
            `🧠 用户习惯已更新 (v${record?.version ?? "?"}，约 ${record?.estimatedTokens ?? 0} tokens):\n\n${content}`,
          );
        } else {
          printAssistantBlock("无法总结用户习惯，请再对话几轮后重试。");
        }
      } else {
        printAssistantBlock("无活跃会话。");
      }
      drawPrompt();
      return;
    }

    if (task === "/soul-show") {
      const record = (await import("../soul.js")).SoulManager.load();
      if (record) {
        printAssistantBlock(`🧠 用户习惯 (v${record.version}，约 ${record.estimatedTokens} tokens):\n\n${record.content}`);
      } else {
        printAssistantBlock("尚无用户习惯记录。对话几轮后自动生成，或输入 /soul 强制更新。");
      }
      drawPrompt();
      return;
    }

    // Switch model by name
    if (agent && agent.getDefaultModels().includes(task.trim())) {
      agent.setModel(task.trim());
      printAssistantBlock(`模型已切换为：${task.trim()}`);
      drawPrompt();
      return;
    }

    if (task === "/plan-active") {
      const all = listPlanFiles(workspaceRoot);
      if (all.length === 0) {
        printAssistantBlock("无目标计划。启动一个 Target 任务来创建计划。");
      } else {
        const lines = all.map((p) => {
          const icon = p.phase === "abandoned" ? "⬜" : p.phase === "done" ? "✅" : "●";
          const shortId = p.id.startsWith("plan-") ? p.id.slice(5) : p.id;
          return `  ${icon} ${shortId}  [${p.phase}] ${p.completedSubGoals}/${p.subGoalCount}  ${p.goal.slice(0, 55)}`;
        }).join("\n");
        printAssistantBlock(`目标计划（↑↓ 选择，Enter 激活）：\n${lines}`);
      }
      drawPrompt();
      return;
    }

    if (task.startsWith("/plan-active ")) {
      const idPart = task.slice(13).trim();
      const all = listPlanFiles(workspaceRoot);
      const match = all.find((p) => p.id === idPart || p.id.startsWith(idPart));
      if (!match) {
        printAssistantBlock(`未找到计划: ${idPart}\n输入 /plan-active 查看列表。`);
      } else {
        try {
          const planData = loadPlanFile(workspaceRoot, match.id);
          if (!planData) {
            printAssistantBlock(`计划文件损坏: ${match.id}`);
          } else {
            // Restore phase to resume execution
            const phase = (planData as Record<string, unknown>).phase as string ?? "execute";
            if (phase === "done") {
              (planData as Record<string, unknown>).phase = "review";
            }
            if (phase === "abandoned") {
              (planData as Record<string, unknown>).phase = "execute";
            }
            savePlanFile(workspaceRoot, match.id, planData as Record<string, unknown>);

            // Switch to target paradigm and inject goal
            tuiParadigm = "ride";
            saveParadigmPref("ride");

            if (!session) {
              session = sessions.create(match.goal);
              lastKnownUsage = null;
              agent = new Agent(workspaceRoot, session.id, mcpLoader, guard, {
                provider: config.provider,
                model: resolveModel(config.model),
                apiKey: resolveApiKey(config.apiKey),
                baseUrl: config.baseUrl,
                thinking: config.thinking,
                yunchang: config.yunchang,
              });
              agent.setParadigm("ride");
              agent.setTask(match.goal);
            } else {
              if (!agent) {
                agent = new Agent(workspaceRoot, session.id, mcpLoader, guard, {
                  provider: config.provider,
                  model: resolveModel(config.model),
                  apiKey: resolveApiKey(config.apiKey),
                  baseUrl: config.baseUrl,
                  thinking: config.thinking,
                  yunchang: config.yunchang,
                });
              }
              agent.setParadigm("ride");
              agent.rebuildSystemPrompt();
              agent.getMessages().push({ role: "user", content: match.goal });
            }

            drawModeBar();

            printAssistantBlock(
              `已激活计划: ${match.id.slice(5)}\n` +
              `目标: ${match.goal}\n` +
              `进度: ${match.completedSubGoals}/${match.subGoalCount}\n\n` +
              `输入任意内容继续执行。`,
            );
          }
        } catch (e) {
          printAssistantBlock(`激活计划失败: ${String(e).slice(0, 100)}`);
        }
      }
      drawPrompt();
      return;
    }

    if (task === "/compact") {
      if (agent) {
        const beforeLen = agent.getMessages().length;
        const beforeCtx = agent.getContextUsage();
        const compressed = await agent.compressContext(onCompress);
        const afterLen = agent.getMessages().length;
        const afterCtx = agent.getContextUsage();
        if (compressed) {
          printAssistantBlock(
            `上下文已压缩：${beforeLen} → ${afterLen} 条消息\n` +
            `Token 估算：${fmtTokens(beforeCtx.estimatedTokens)} → ${fmtTokens(afterCtx.estimatedTokens)} ` +
            `(${beforeCtx.percentage}% → ${afterCtx.percentage}%)`,
          );
        } else {
          printAssistantBlock(
            `上下文使用率 ${beforeCtx.percentage}%，未达到压缩阈值 (80%)，无需压缩。`,
          );
        }
      } else {
        printAssistantBlock("无活跃会话，无需压缩。");
      }
      drawPrompt();
      return;
    }

    busy = true;
    updateScrollRegion();
    streaming = true;
    taskAbort = new AbortController();
    startStatusBar();
    drawPrompt(true);

    if (!session) {
      session = sessions.create(task);
      lastKnownUsage = null;
      agent = new Agent(workspaceRoot, session.id, mcpLoader, guard, {
        provider: config.provider,
        model: resolveModel(config.model),
        apiKey: resolveApiKey(config.apiKey),
        baseUrl: config.baseUrl,
        thinking: config.thinking,
        yunchang: config.yunchang,
      });
      agent.setParadigm(tuiParadigm);
      agent.setTask(task, pendingImages);
    } else {
      if (!agent) {
        lastKnownUsage = null;
        agent = new Agent(workspaceRoot, session.id, mcpLoader, guard, {
          provider: config.provider,
          model: resolveModel(config.model),
          apiKey: resolveApiKey(config.apiKey),
          baseUrl: config.baseUrl,
          thinking: config.thinking,
          yunchang: config.yunchang,
        });
      }
      agent.setParadigm(tuiParadigm);
      agent.restoreMessages(agent.getMessages().concat([{ role: "user", content: buildUserContent(task, pendingImages) }]));
      agent.rebuildSystemPrompt();
      session.messages = agent.getMessages();
    }
    const currentAgent = agent;
    if (!currentAgent) {
      throw new Error("Agent initialization failed");
    }

    let streamOpened = false;

    const onReasoning = (_text: string) => {
      resetWatchdog();
      if (!streamOpened) {
        beginOutputBlock();
        write(color.red("chitu: ") + color.dim("思考中..."));
        streamOpened = true;
        printingAssistant = true;
        thinkingActive = true;
      }
    };

    const onToken = (text: string) => {
      resetWatchdog();
      const normalized = sanitizeAssistantText(text);
      if (!normalized) return;
      liveCompletionChars += text.length;

      // Replace "思考中..." with "[thinked]" when first real content arrives
      if (thinkingActive) {
        write("\r" + ansi.clearLine + color.red("chitu: ") + color.dim("[thinked]") + "\n");
        thinkingActive = false;
      }

      if (!streamOpened) {
        beginOutputBlock();
        write(color.red("chitu: "));
        streamOpened = true;
        printingAssistant = true;
      }
      streamQueue += normalized;
      startStreamDrain();
    };

    const onToolOutput = (toolName: string, output: string) => {
      resetWatchdog();
      // Phase progress indicators — render as dim text without tool header
      if (toolName === "phase") {
        if (!streamOpened) {
          beginOutputBlock();
          write(color.red("chitu: "));
          streamOpened = true;
          printingAssistant = true;
        }
        write(color.dim(output) + "\n");
        return;
      }

      // Display tool output directly so the user can see it
      if (!streamOpened) {
        beginOutputBlock();
        write(color.red("chitu: "));
        streamOpened = true;
        printingAssistant = true;
      }
      const lines = output.split("\n");
      const maxLines = 15;
      const truncated = lines.length > maxLines;
      const displayLines = lines.slice(0, maxLines);
      const lineCount = lines.length;
      const sizeStr = output.length > 1024 ? `${(output.length / 1024).toFixed(1)}KB` : `${output.length}B`;

      const fileOpIcon = toolName === "write_file" ? "+" : toolName === "edit_file" ? "~" : toolName === "delete_file" ? "-" : "";
      const headerColor = fileOpIcon ? color.yellow : color.dim;
      write(headerColor(`── ${fileOpIcon ? fileOpIcon + " " : ""}tool: ${toolName} · ${lineCount} lines · ${sizeStr} ──`) + "\n");
      for (const line of displayLines) {
        write(color.dim("  ") + color.dim(line.slice(0, 200)) + "\n");
      }
      if (truncated) {
        write(color.dim(`  ... ${lineCount - maxLines} more lines not shown`) + "\n");
      }
    };

    let lastResponse = "";

    // Watchdog: if no output for 60s, dump agent state to diagnose where it's stuck
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    const WATCHDOG_IDLE_MS = 60_000;
    const resetWatchdog = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        const dumpPath = join(workspaceRoot, ".chitu", "watchdog.json");
        try {
          if (!existsSync(dirname(dumpPath))) mkdirSync(dirname(dumpPath), { recursive: true });
          const msgs = agent?.getMessages() ?? [];
          const tail = msgs.slice(-5).map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content.slice(0, 500) : "(non-string)",
            tool_calls: m.tool_calls?.map((tc: any) => tc.function?.name ?? "?"),
          }));
          const state = agent ? { paradigm: (agent as any).paradigmState, model: agent.getModel?.() } : {};
          writeFileSync(dumpPath, JSON.stringify({
            stuckAt: new Date().toISOString(),
            sessionId: session?.id,
            messageCount: msgs.length,
            lastMessages: tail,
            agentState: state,
          }, null, 2), "utf-8");
        } catch { /* best-effort */ }
      }, WATCHDOG_IDLE_MS);
    };
    resetWatchdog();

    try {
      lastResponse = await currentAgent.execute(onToken, taskAbort.signal, onToolOutput, onCompress, onReasoning);
      // Capture real API usage for persistent token display
      const usage = currentAgent.getUsage();
      if (usage) {
        lastKnownUsage = usage;
        if (session) {
          session.usage = {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
            cached_tokens: usage.cachedTokens,
          };
          session.model = currentAgent.getModel();
        }
      }
      await waitForStreamDrain();
      streaming = false;
      stopStreamDrain();
      printingAssistant = false;
      responseCodeBlock = false; codeBlockLang = "";

      try {
        const changed = execSync("git status --short", { encoding: "utf-8", cwd: workspaceRoot }).trim();
        if (changed) {
          const lines = changed.split("\n");
          let modified = 0, added = 0, deleted = 0;
          for (const line of lines) {
            const st = line.slice(0, 2).trim();
            if (st === "M" || st.startsWith("M")) modified++;
            else if (st === "A" || st === "??") added++;
            else if (st === "D") deleted++;
          }
          const parts: string[] = [];
          if (modified) parts.push(`${modified} modified`);
          if (added) parts.push(`${added} added`);
          if (deleted) parts.push(`${deleted} deleted`);
          write(color.dim(`  ${parts.join(", ")}`) + "\n");
        }
      } catch { /* ignore */ }

      if (streamOpened) {
        write("\n");
      } else {
        // No streaming output — display the final response directly
        if (lastResponse) {
          printAssistantBlock(lastResponse);
        } else {
          printAssistantBlock("");
        }
      }

      if (session) {
        session.messages = currentAgent.getMessages();
        sessions.save(session);
      }

      // ride metrics are handled internally by TargetExecutor
    } catch (e) {
      streaming = false;
      streamQueue = "";
      stopStreamDrain();
      printingAssistant = false;
      responseCodeBlock = false; codeBlockLang = "";
      clearInputBox();
      const cancelled = taskAbort?.signal.aborted;
      if (cancelled) {
        beginOutputBlock();
        write(color.yellow("[cancelled]") + "\n");
      } else {
        beginOutputBlock();
        write(color.red(`[error] ${String(e).slice(0, 120)}`) + "\n");
      }
      if (session) {
        session.messages = currentAgent.getMessages();
        sessions.save(session);
      }
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      streamQueue = "";
      stopStreamDrain();
      stopStatusBar();
      busy = false;
      streaming = false;
      printingAssistant = false;
      responseCodeBlock = false; codeBlockLang = "";
      taskAbort = null;
      pendingImages = [];
      updateScrollRegion();
      drawPrompt();

      // YunChang auto-continuation + auto-commit
      if (config.yunchang && lastResponse && agent) {
        // Auto-commit on sub-goal completion or final target completion
        const subGoalDone = /Sub-goal\s+\S+\s+complete/i.test(lastResponse);
        const targetDone = /Target Complete/i.test(lastResponse);
        if (subGoalDone || targetDone) {
          try {
            const changed = execSync("git status --short", { encoding: "utf-8", cwd: workspaceRoot }).trim();
            if (changed) {
              execSync("git add -A", { cwd: workspaceRoot, timeout: 10000 });
              const msg = targetDone
                ? "chitu: Target complete — all sub-goals done, review gates passed"
                : `chitu: ${lastResponse.split("\n")[0]?.trim() ?? "Sub-goal complete"}`;
              execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd: workspaceRoot, timeout: 10000 });
              write(color.dim("  [yunchang] auto-committed\n"));
            }
          } catch (e) {
            write(color.dim(`  [yunchang] commit failed: ${String(e).slice(0, 80)}\n`));
          }
        }

        const shouldContinue = lastResponse.includes("Type anything to continue")
          && !lastResponse.includes("All sub-goals done");
        if (shouldContinue && autoContinueCount < MAX_AUTO_CONTINUE) {
          autoContinueCount++;
          // Use setImmediate to let the UI flush before next task
          setImmediate(() => handleTask("continue"));
        } else {
          autoContinueCount = 0;
        }
      } else {
        autoContinueCount = 0;
      }
    }
  };

  const MAX_AUTO_CONTINUE = 20;
  let autoContinueCount = 0;

  const handleHistoryUp = () => {
    if (inputHistory.length === 0) return;
    if (historyIndex === -1) {
      historyDraft = inputBuffer;
      historyIndex = inputHistory.length - 1;
    } else if (historyIndex > 0) {
      historyIndex--;
    }
    inputBuffer = inputHistory[historyIndex] ?? "";
    drawPrompt();
  };

  const handleHistoryDown = () => {
    if (historyIndex === -1) return;
    if (historyIndex < inputHistory.length - 1) {
      historyIndex++;
      inputBuffer = inputHistory[historyIndex] ?? "";
    } else {
      historyIndex = -1;
      inputBuffer = historyDraft;
    }
    drawPrompt();
  };

  let pendingImages: string[] = [];

  const handleUp = () => {
    const matches = getHintMatches();
    if (matches.length > 0 && inputBuffer.startsWith("/")) {
      if (hintFocus > 0) {
        hintFocus--;
        drawPrompt();
      }
    } else {
      handleHistoryUp();
    }
  };

  const handleDown = () => {
    const matches = getHintMatches();
    if (matches.length > 0 && inputBuffer.startsWith("/")) {
      if (hintFocus < matches.length - 1) {
        hintFocus++;
        drawPrompt();
      }
    } else {
      handleHistoryDown();
    }
  };

  const handleSubmit = () => {
    const raw = inputBuffer.replace(/\r/g, "");

    // Hint interaction on Enter
    const matches = getHintMatches();
    if (matches.length > 0 && raw.startsWith("/") && !busy) {
      const focused = matches[hintFocus];
      if (focused) {
        // Session selection mode: input is /resume or /resume <filter>
        if ((raw.trim() === "/resume" || raw.startsWith("/resume ")) && focused.name.length >= 8) {
          const sid = focused.name; // session id
          inputBuffer = "";
          hintFocus = 0;
          prevHintCount = 0;
          sessionHints = [];
          historyIndex = -1;
          historyDraft = "";
          clearInputBox();
          beginOutputBlock();
          write(color.bold(color.white(`> /resume ${sid.slice(0, 8)}`)) + "\n");
          void handleTask(`/resume ${sid}`);
          return;
        }

        // Plan selection mode: input is /plan-active or /plan-active <filter>
        if ((raw.trim() === "/plan-active" || raw.startsWith("/plan-active ")) && focused.name.startsWith("plan-")) {
          const pid = focused.name;
          inputBuffer = "";
          hintFocus = 0;
          prevHintCount = 0;
          planHints = [];
          historyIndex = -1;
          historyDraft = "";
          clearInputBox();
          beginOutputBlock();
          write(color.bold(color.white(`> /plan-active ${pid.slice(5)}`)) + "\n");
          void handleTask(`/plan-active ${pid}`);
          return;
        }

        // Regular command — exact match submits, partial auto-completes
        if (raw === focused.name) {
          // exact match, fall through to submit
        } else if (raw.trim().length > 0) {
          inputBuffer = focused.name + " ";
          hintFocus = 0;
          prevHintCount = 0;
          drawPrompt();
          return;
        }
      }
    }

    inputBuffer = "";
    historyIndex = -1;
    historyDraft = "";
    if (raw.length === 0) {
      drawPrompt();
      return;
    }

    const { cleanText, imagePaths } = detectImages(raw);
    pendingImages = imagePaths;

    if ((inputHistory.length === 0 || inputHistory[inputHistory.length - 1] !== raw) && raw.trim().length > 0) {
      inputHistory.push(raw);
    }
    clearInputBox();
    beginOutputBlock();
    const taskLines = raw.split("\n");
    write(color.bold(color.white(`> ${taskLines[0] ?? ""}`)) + "\n");
    for (let i = 1; i < taskLines.length; i++) {
      write(color.bold(color.white(`  ${taskLines[i] ?? ""}`)) + "\n");
    }
    if (imagePaths.length > 0) {
      write(color.dim(`  📎 ${imagePaths.length} image(s) attached`) + "\n");
    }
    void handleTask(cleanText);
  };

  const handleBackspace = () => {
    if (inputBuffer.length === 0) return;
    const lastCode = inputBuffer.charCodeAt(inputBuffer.length - 1);
    if (lastCode >= 0xDC00 && lastCode <= 0xDFFF && inputBuffer.length > 1) {
      inputBuffer = inputBuffer.slice(0, -2);
    } else {
      inputBuffer = inputBuffer.slice(0, -1);
    }
    drawPrompt();
  };

  const handleClearScreen = () => {
    clearInputBox();
    write(ansi.clear + ansi.moveTo(0, 0));
    updateScrollRegion(); // re-apply scroll region after clear
    drawPrompt();
  };

  const decoder = new StringDecoder("utf8");
  const BRACKETED_PASTE_START = "\x1b[200~";
  const BRACKETED_PASTE_END = "\x1b[201~";
  let pendingRawInput = "";
  let inBracketedPaste = false;

  const consumeRawInput = () => {
    while (pendingRawInput.length > 0) {
      if (inBracketedPaste) {
        const end = pendingRawInput.indexOf(BRACKETED_PASTE_END);
        if (end === -1) {
          appendInputChunk(sanitizeInputChunk(pendingRawInput));
          pendingRawInput = "";
          drawPrompt();
          return;
        }
        appendInputChunk(sanitizeInputChunk(pendingRawInput.slice(0, end)));
        pendingRawInput = pendingRawInput.slice(end + BRACKETED_PASTE_END.length);
        inBracketedPaste = false;
        drawPrompt();
        continue;
      }

      if (pendingRawInput.startsWith(BRACKETED_PASTE_START)) {
        inBracketedPaste = true;
        pendingRawInput = pendingRawInput.slice(BRACKETED_PASTE_START.length);
        continue;
      }

      // Arrows — legacy sequences
      if (pendingRawInput.startsWith("\x1b[A")) { pendingRawInput = pendingRawInput.slice(3); if (!busy) handleUp(); continue; }
      if (pendingRawInput.startsWith("\x1b[B")) { pendingRawInput = pendingRawInput.slice(3); if (!busy) handleDown(); continue; }
      if (pendingRawInput.startsWith("\x1b[C") || pendingRawInput.startsWith("\x1b[D")) { pendingRawInput = pendingRawInput.slice(3); continue; }
      if (pendingRawInput.startsWith("\x1b[3~")) { pendingRawInput = pendingRawInput.slice(4); if (!busy) handleBackspace(); continue; }

      if (pendingRawInput[0] === "\x03") {
        pendingRawInput = pendingRawInput.slice(1);
        running = false;
        cleanup();
        return;
      }
      if (pendingRawInput[0] === "\x0c") {
        pendingRawInput = pendingRawInput.slice(1);
        if (!busy) handleClearScreen();
        continue;
      }
      if (pendingRawInput.startsWith("\x1b[Z")) {
        pendingRawInput = pendingRawInput.slice(3);
        if (!busy) cycleParadigm();
        continue;
      }
      // Shift+Enter → newline (xterm modifyOtherKeys format; may not work in all terminals)
      if (pendingRawInput.startsWith("\x1b[27;2;13~")) {
        pendingRawInput = pendingRawInput.slice(10);
        if (!busy) { appendInputChunk("\n"); drawPrompt(); }
        continue;
      }
      if (pendingRawInput[0] === "\x1b") {
        pendingRawInput = pendingRawInput.slice(1);
        if (streaming) taskAbort?.abort();
        continue;
      }
      // Backspace — legacy sequences
      if (pendingRawInput[0] === "\x7f" || pendingRawInput[0] === "\b") {
        pendingRawInput = pendingRawInput.slice(1);
        if (!busy) handleBackspace();
        continue;
      }
      // Enter (CR) → submit
      if (pendingRawInput[0] === "\r") {
        if (pendingRawInput[1] === "\n") {
          pendingRawInput = pendingRawInput.slice(2);
        } else {
          pendingRawInput = pendingRawInput.slice(1);
        }
        if (!busy) handleSubmit();
        continue;
      }
      // Ctrl+J (LF) → also insert newline (fallback for terminal quirks)
      if (pendingRawInput[0] === "\n") {
        pendingRawInput = pendingRawInput.slice(1);
        if (!busy) {
          appendInputChunk("\n");
          drawPrompt();
        }
        continue;
      }

      const cp = pendingRawInput.codePointAt(0)!;
      const ch = String.fromCodePoint(cp);
      pendingRawInput = pendingRawInput.slice(cp > 0xFFFF ? 2 : 1);
      if (!busy) {
        appendInputChunk(sanitizeInputChunk(ch));
        drawPrompt();
      }
    }
  };

  process.stdin.on("data", (buf: Buffer) => {
    pendingRawInput += decoder.write(buf);
    consumeRawInput();
  });

  drawPrompt();
  drawStatusBar();

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!running) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });

  function cleanup() {
    if (cleanupDone) return;
    cleanupDone = true;

    taskAbort?.abort();
    taskAbort = null;

    if (agent) agent.abort();

    stopStreamDrain();
    stopStatusBar();
    decoder.end();
    disableRawMode();
    write(ansi.bracketedPasteOff);
    resetScrollRegion();
    write(ansi.showCursor);
    write("\n\n" + color.dim("  赤兔已停。再见。") + "\n\n");

    mcpLoader.stopAll().catch((e) => { logger.warn("MCP stopAll failed", { error: String(e) }); });
  }

  // Ensure cleanup on forced exit — prevents terminal from staying in raw mode
  process.once("SIGINT", () => { cleanup(); process.exit(0); });
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });
}
