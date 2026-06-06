import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { execSync } from "node:child_process";
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
import {
  createTUIState, type TUIState, type HintItem,
  STATUS_BAR_HEIGHT, MODE_BAR_HEIGHT, MAX_HINT_LINES, MAX_AUTO_CONTINUE, SCROLL_TOP,
  STATUS_FRAMES, IMAGE_EXTS, BRACKETED_PASTE_START, BRACKETED_PASTE_END,
  WATCHDOG_IDLE_MS, COMMANDS, PARADIGM_COLORS, PARADIGM_CYCLE, PARADIGM_DESC,
} from "./state.js";

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

  // Load persisted paradigm (CLI flag takes precedence)
  let tuiParadigm: Paradigm = (config.paradigm as Paradigm | undefined) ?? "appraise";
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
  if (!config.paradigm) {
    const persisted = loadParadigmPref();
    if (persisted) tuiParadigm = persisted as Paradigm;
  }

  const s = createTUIState(
    workspaceRoot, sessions, mcpLoader, mcpNames, skillNames, guard, config, tuiParadigm,
  );
  // Alias for brevity in large closure functions
  const state = s;

  // ── Image detection ──

  const detectImages = (task: string): { cleanText: string; imagePaths: string[] } => {
    const words = task.split(/(\s+)/);
    const imagePaths: string[] = [];
    const cleanParts: string[] = [];

    for (const w of words) {
      const trimmed = w.trim();
      if (trimmed && IMAGE_EXTS.test(trimmed)) {
        const resolved = trimmed.startsWith("/") ? trimmed : join(workspaceRoot, trimmed);
        const normalized = resolved.startsWith(workspaceRoot + sep)
          ? resolved
          : (resolved.startsWith("/") && !resolved.includes(".."))
            ? resolved
            : null;
        if (!normalized) continue;
        if (existsSync(normalized)) {
          try {
            const buf = readFileSync(resolved);
            const head = buf[0]!;
            if (head === 0x89 || head === 0xFF || head === 0x47 || head === 0x42 || head === 0x52) {
              imagePaths.push(resolved);
              continue;
            }
          } catch { /* not an image */ }
        }
      }
      cleanParts.push(w);
    }

    return { cleanText: cleanParts.join(""), imagePaths };
  };

  // ── Text utilities ──

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
      if (!logicalLine) { wrapped.push(""); continue; }
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
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
  };

  // ── Layout helpers ──

  const getMaxInputLines = (rows: number): number =>
    Math.max(1, Math.min(8, rows - STATUS_BAR_HEIGHT - MODE_BAR_HEIGHT - SCROLL_TOP));

  const clearInputBox = () => {
    if (!state.inputBoxDrawn) return;
    const { rows } = getTermSize();
    const maxLines = getMaxInputLines(rows);
    const bottomRow = rows - STATUS_BAR_HEIGHT - MODE_BAR_HEIGHT - 1;
    const topRow = Math.max(0, bottomRow - maxLines + 1);
    for (let i = 0; i < maxLines; i++) {
      write(ansi.moveTo(topRow + i, 0) + ansi.clearLine);
    }
    state.inputBoxDrawn = false;
  };

  const scrollRegionBottom = (): number => {
    const { rows } = getTermSize();
    const maxLines = getMaxInputLines(rows);
    const reserved = STATUS_BAR_HEIGHT + MODE_BAR_HEIGHT + maxLines;
    return Math.max(SCROLL_TOP - 1, rows - reserved - 1);
  };

  const updateScrollRegion = () => {
    const { rows } = getTermSize();
    const maxLines = getMaxInputLines(rows);
    const reserved = STATUS_BAR_HEIGHT + MODE_BAR_HEIGHT + maxLines;
    const scrollEnd = Math.max(SCROLL_TOP, rows - reserved);
    if (scrollEnd === state.lastScrollEnd) return;
    if (state.streaming) return;
    state.lastScrollEnd = scrollEnd;
    setScrollRegion(SCROLL_TOP, scrollEnd);
  };

  const beginOutputBlock = () => {
    write(ansi.moveTo(scrollRegionBottom(), 0) + ansi.clearLine + "\n");
  };

  // ── Hint system ──

  const loadSessionHints = () => {
    const all = state.sessions.list();
    state.sessionHints = all.slice(0, 20).map((s) => ({
      name: s.id,
      description: `${s.createdAt.slice(0, 10)}  ${s.task.slice(0, 60)}`,
    }));
  };

  const loadPlanHints = () => {
    const all = listPlanFiles(workspaceRoot);
    state.planHints = all.map((p) => {
      const icon = p.phase === "abandoned" ? "○" : p.phase === "done" ? "✓" : "●";
      return {
        name: p.id,
        description: `${icon} [${p.phase}] ${p.completedSubGoals}/${p.subGoalCount}  ${p.goal.slice(0, 50)}`,
      };
    });
  };

  const getHintMatches = (): HintItem[] => {
    if (state.busy) return [];
    if (!state.inputBuffer.startsWith("/")) return [];
    const partial = state.inputBuffer.trim().toLowerCase();

    if (partial === "/resume" || partial.startsWith("/resume ")) {
      if (state.sessionHints.length === 0) loadSessionHints();
      const filter = state.inputBuffer.toLowerCase().slice(8).trim();
      if (!filter) return state.sessionHints;
      return state.sessionHints.filter((s) => s.name.startsWith(filter) || s.description.includes(filter));
    }

    if (partial === "/plan-active" || partial.startsWith("/plan-active ")) {
      if (state.planHints.length === 0) loadPlanHints();
      const filter = state.inputBuffer.toLowerCase().slice(13).trim();
      if (!filter) return state.planHints;
      return state.planHints.filter((p) => p.name.includes(filter) || p.description.includes(filter));
    }

    if (!partial) return COMMANDS;
    return COMMANDS.filter((c) => c.name.startsWith(partial) || c.name.includes(partial));
  };

  const getHintHeight = (): number => {
    if (state.busy) return 0;
    if (!state.inputBuffer.startsWith("/")) return 0;
    const matches = getHintMatches();
    if (matches.length === 0) return 0;
    const { rows } = getTermSize();
    const maxLines = getMaxInputLines(rows);
    const gap = maxLines - state.inputBoxHeight;
    if (gap < 2) return 0;
    return Math.min(MAX_HINT_LINES, gap);
  };

  // ── Prompt rendering ──

  const drawPrompt = (returnToScrollArea = false) => {
    const { cols, rows } = getTermSize();
    const contentWidth = Math.max(1, cols - 2);
    const allInputLines = splitInputLinesToWidth(state.inputBuffer, contentWidth);
    const maxInputLines = getMaxInputLines(rows);
    const visibleLines = allInputLines.slice(-maxInputLines);
    const wasTrimmed = allInputLines.length > visibleLines.length;

    const prevInputBoxHeight = state.inputBoxHeight;
    clearInputBox();
    state.inputBoxHeight = visibleLines.length;

    if (state.inputBoxHeight > prevInputBoxHeight && prevInputBoxHeight > 0) {
      const diff = state.inputBoxHeight - prevInputBoxHeight;
      for (let i = 0; i < diff; i++) {
        write(ansi.moveTo(scrollRegionBottom(), 0) + "\n");
      }
    }

    updateScrollRegion();

    const curHintH = getHintHeight();
    if (state.prevHintHeight > curHintH) {
      const { rows: r2 } = getTermSize();
      const promptBottom = r2 - STATUS_BAR_HEIGHT - MODE_BAR_HEIGHT - 1;
      const inputBoxTop = promptBottom - state.inputBoxHeight + 1;
      const hintEnd = inputBoxTop - 1;
      for (let i = curHintH; i < state.prevHintHeight; i++) {
        const row = hintEnd - i;
        if (row > scrollRegionBottom()) write(ansi.moveTo(row, 0) + ansi.clearLine);
      }
    }
    state.prevHintHeight = curHintH;

    write(ansi.saveCursor);
    drawHintPanel();
    drawModeBar();
    write(ansi.restoreCursor);

    const isCommand = state.inputBuffer.startsWith("/");
    const USER_INPUT_BG = "\x1b[48;5;236m";

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

    const lastVisibleLine = visibleLines[visibleLines.length - 1] ?? "";
    const cursorRow = Math.min(rows - 1, promptBottom);
    const cursorCol = Math.min(Math.max(0, cols - 1), 2 + vlen(lastVisibleLine));
    if (!returnToScrollArea) {
      write(ansi.moveTo(cursorRow, 0) + ansi.moveRight(cursorCol));
    } else {
      write(ansi.moveTo(scrollRegionBottom(), 0));
    }
    state.inputBoxDrawn = true;
    state.inputBoxTopRow = Math.max(0, promptBottom - state.inputBoxHeight + 1);
  };

  // ── Hint panel ──

  const drawHintPanel = () => {
    const matches = getHintMatches();
    if (matches.length === 0) return;

    if (matches.length !== state.prevHintCount) {
      state.hintFocus = 0;
      state.prevHintCount = matches.length;
    }

    const { rows } = getTermSize();
    const gap = getMaxInputLines(rows) - state.inputBoxHeight;
    const hintH = Math.min(MAX_HINT_LINES, gap);
    if (hintH < 2) return;

    if (state.hintFocus >= matches.length) state.hintFocus = matches.length - 1;
    if (state.hintFocus < 0) state.hintFocus = 0;

    const needsPaging = matches.length > hintH;
    const itemsPerPage = needsPaging ? hintH - 1 : hintH;
    const totalPages = Math.ceil(matches.length / itemsPerPage);
    const page = Math.floor(state.hintFocus / itemsPerPage);
    const pageStart = page * itemsPerPage;
    const pageItems = matches.slice(pageStart, pageStart + itemsPerPage);

    const promptBottom = rows - STATUS_BAR_HEIGHT - MODE_BAR_HEIGHT - 1;
    const inputBoxTop = promptBottom - state.inputBoxHeight + 1;
    const hintEnd = inputBoxTop - 1;
    const hintStart = hintEnd - hintH + 1;
    const scrBot = scrollRegionBottom();

    let r = 0;
    for (const item of pageItems) {
      const row = hintStart + r;
      r++;
      if (row <= scrBot) continue;
      const isFocused = (pageStart + pageItems.indexOf(item)) === state.hintFocus;
      const prefix = isFocused ? color.bold(color.cyan("▶")) : " ";
      const namePart = isFocused ? color.bold(color.cyan(item.name)) : color.cyan(item.name);
      const descPart = color.dim(` — ${item.description}`);
      write(ansi.moveTo(row, 0) + ansi.clearLine + color.dim(` ${prefix} ${namePart}${descPart}`));
    }

    for (let i = r; i < (needsPaging ? hintH - 1 : hintH); i++) {
      const row = hintStart + i;
      if (row > scrBot) write(ansi.moveTo(row, 0) + ansi.clearLine);
    }

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

  // ── Metrics & Status Bar ──

  const getLiveMetrics = (): { humanInLoopCount: number } => {
    try {
      const engine = new MetricsEngine(workspaceRoot);
      const report = engine.compute();
      if (report) return { humanInLoopCount: report.humanInLoopCount };
    } catch { /* skip */ }
    return { humanInLoopCount: 0 };
  };

  const fmtTokens = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  const fmtTokensLive = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(3)}K` : String(n);
  const fmtCacheRate = (cached: number, prompt: number): string => {
    if (prompt <= 0) return "";
    return `cache:${Math.round((cached / prompt) * 100)}%`;
  };
  const fmtElapsed = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  const tickAnimTokens = (target: number, targetRate: number) => {
    const gap = target - state.animTokens;
    if (gap <= 0) {
      state.animTokens = target;
    } else {
      const range = Math.min(gap, gap > 1000 ? 200 : gap > 100 ? 50 : 10);
      const step = Math.max(1, Math.floor(Math.random() * range + 1));
      state.animTokens = Math.min(state.animTokens + step, target);
    }
    if (state.animCacheRate < targetRate) {
      state.animCacheRate = Math.min(state.animCacheRate + 1, targetRate);
    } else if (state.animCacheRate > targetRate) {
      state.animCacheRate = targetRate;
    }
  };

  const getActiveParadigm = (): Paradigm => {
    if (state.agent) return state.agent.getParadigmState().active;
    return state.tuiParadigm;
  };

  const cycleParadigm = () => {
    const current = getActiveParadigm();
    const idx = PARADIGM_CYCLE.indexOf(current);
    const next = PARADIGM_CYCLE[(idx + 1) % PARADIGM_CYCLE.length]!;
    state.tuiParadigm = next;
    saveParadigmPref(next);
    if (state.agent) {
      state.agent.setParadigm(next);
      state.agent.rebuildSystemPrompt();
    }
    drawModeBar();
  };

  const drawModeBar = () => {
    const { cols, rows } = getTermSize();
    const modeBarRow = rows - STATUS_BAR_HEIGHT - 1;

    const active = getActiveParadigm();
    const c = (PARADIGM_COLORS as any)[active] ?? color.dim;
    const pc = (s: string) => { const fn = c === "green" ? color.green : c === "magenta" ? color.magenta : c === "yellow" ? color.yellow : color.dim; return fn(s); };

    const desc = PARADIGM_DESC[active] ?? "";
    const label = active === "appraise" ? "Ask" : active === "ride" ? "Target" : "Modify";
    const cycleHint = PARADIGM_CYCLE.includes(active) ? " (shift+tab to cycle · ctrl+j to newline)" : "";
    const thinkingOn = state.agent?.getThinking();
    const thinkingTag = thinkingOn ? " " + color.yellow("[thinking]") : "";
    const line = " " + pc(`<${label}>`) + thinkingTag + color.dim(` --${desc}${cycleHint}`);

    write(ansi.moveTo(modeBarRow, 0) + ansi.clearLine + line);
  };

  const drawStatusBar = () => {
    const { cols, rows } = getTermSize();
    const barRow = rows - STATUS_BAR_HEIGHT;

    const sep = color.dim("│");
    const isDeepSeek = state.agent ? state.agent.getProviderName() === "deepseek" : false;

    if (state.busy) {
      const spinner = STATUS_FRAMES[state.statusFrameIdx % STATUS_FRAMES.length]!;
      state.statusFrameIdx++;

      const now = Date.now();
      const elapsed = state.taskStartTime ? fmtElapsed(now - state.taskStartTime) : "00:00";

      const m = state.lastMetricsSnapshot ?? getLiveMetrics();
      if (!state.lastMetricsSnapshot) state.lastMetricsSnapshot = m;

      const workingPart = `${spinner} 赤兔工作中 · ${elapsed}`;

      const u = state.agent?.getUsage() ?? state.lastKnownUsage;
      const liveComp = Math.ceil(state.liveCompletionChars / 4);
      const liveTotal = state.livePromptChars + liveComp;
      const target = u?.totalTokens ?? (state.streaming ? liveTotal : state.animTokens);
      const targetRate = (u && u.promptTokens > 0) ? Math.round((u.cachedTokens / u.promptTokens) * 100) : state.animCacheRate;
      tickAnimTokens(target, targetRate);

      let tokenSection = "";
      if (state.streaming || state.animTokens > 0) {
        const cacheStr = isDeepSeek ? `  cache:${state.animCacheRate}%` : "";
        tokenSection = `${fmtTokensLive(state.animTokens)} tokens${cacheStr}`;
      }

      const ctxPct = state.agent?.getContextUsage().percentage ?? 0;
      const ctxPart = `ctx:${ctxPct}%`;
      const hitlPart = `HITL:${m.humanInLoopCount}`;
      const parts = [workingPart, tokenSection, ctxPart, hitlPart].filter(Boolean);
      const fullLine = parts.join(`  ${sep}  `);
      const trimmed = vtrunc(fullLine, cols);

      write(ansi.saveCursor);
      write(ansi.moveTo(barRow, 0) + ansi.clearLine + color.dim(trimmed));
      write(ansi.restoreCursor);
    } else {
      const u = state.agent?.getUsage() ?? state.lastKnownUsage;
      const target = u?.totalTokens ?? 0;
      const targetRate = (u && u.promptTokens > 0) ? Math.round((u.cachedTokens / u.promptTokens) * 100) : state.animCacheRate;
      tickAnimTokens(target, targetRate);

      const m = state.lastMetricsSnapshot;
      const parts: string[] = [];
      const cacheStr = isDeepSeek ? `  cache:${state.animCacheRate}%` : "";
      parts.push(`${fmtTokens(state.animTokens)} tokens${cacheStr}`);
      const ctxPct = state.agent?.getContextUsage().percentage ?? 0;
      parts.push(`ctx:${ctxPct}%`);
      if (m) parts.push(`HITL:${m.humanInLoopCount}`);
      const fullLine = parts.join(`  ${sep}  `);
      const trimmed = vtrunc(fullLine, cols);

      write(ansi.saveCursor);
      write(ansi.moveTo(barRow, 0) + ansi.clearLine + color.dim(trimmed));
      write(ansi.restoreCursor);
    }
    state.statusBarDrawn = true;
    state.statusBarTopRow = barRow;
  };

  const clearStatusBar = () => {
    if (!state.statusBarDrawn) return;
    write(ansi.saveCursor);
    write(ansi.moveTo(state.statusBarTopRow, 0) + ansi.clearLine);
    write(ansi.restoreCursor);
    state.statusBarDrawn = false;
  };

  const startStatusBar = () => {
    state.taskStartTime = Date.now();
    state.statusFrameIdx = 0;
    state.lastMetricsSnapshot = null;
    state.liveCompletionChars = 0;
    if (state.agent) {
      let chars = 0;
      for (const m of state.agent.getMessages()) {
        chars += (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? "").length;
      }
      state.livePromptChars = Math.ceil(chars / 4);
    }
    state.animCacheRate = 0;
    drawStatusBar();
    state.statusInterval = setInterval(() => {
      if (state.busy && state.statusFrameIdx % 4 === 0) state.lastMetricsSnapshot = getLiveMetrics();
      clearStatusBar();
      drawStatusBar();
    }, 150);
  };

  const stopStatusBar = () => {
    if (state.statusInterval) {
      clearInterval(state.statusInterval);
      state.statusInterval = null;
    }
    const u = state.agent?.getUsage() ?? state.lastKnownUsage;
    const isDeepSeek = state.agent ? state.agent.getProviderName() === "deepseek" : false;
    const { cols } = getTermSize();
    const m = state.lastMetricsSnapshot ?? getLiveMetrics();

    const sep = color.dim("│");
    const parts: string[] = [];

    if (u && u.totalTokens > 0) {
      const cacheStr = isDeepSeek ? `  ${fmtCacheRate(u.cachedTokens, u.promptTokens)}` : "";
      parts.push(`${fmtTokens(u.totalTokens)} tokens${cacheStr}`);
    }

    const ctxPct = state.agent?.getContextUsage().percentage ?? 0;
    parts.push(`ctx:${ctxPct}%`);
    if (m) parts.push(`HITL:${m.humanInLoopCount}`);
    const fullLine = parts.join(`  ${sep}  `);

    state.statusBarTopRow = getTermSize().rows - STATUS_BAR_HEIGHT;
    write(ansi.moveTo(state.statusBarTopRow, 0) + ansi.clearLine + color.dim(vtrunc(fullLine, cols)));
    write(ansi.moveTo(scrollRegionBottom(), 0));
    state.statusBarDrawn = true;
    state.taskStartTime = null;
  };

  // ── Stream rendering ──

  const stopStreamDrain = () => {
    if (state.streamDrainInterval) {
      clearInterval(state.streamDrainInterval);
      state.streamDrainInterval = null;
    }
  };

  const startStreamDrain = () => {
    if (state.streamDrainInterval) return;
    state.streamDrainInterval = setInterval(() => {
      if (!state.streamQueue) {
        if (!state.streaming) stopStreamDrain();
        return;
      }

      const markerRe = /(?:^|\n)```[^\n]*\n/;
      const match = markerRe.exec(state.streamQueue);

      if (match && match.index < 128) {
        const markerText = match[0];
        const langMatch = /```([^\n]*)\n/.exec(markerText);
        const lang = langMatch?.[1]?.trim() ?? "";

        if (match.index === 0) {
          state.responseCodeBlock = !state.responseCodeBlock;
          state.codeBlockLang = state.responseCodeBlock ? lang : "";
          state.streamQueue = state.streamQueue.slice(match[0].length);
          state.fmtLineStart = true;
        } else {
          let before = state.streamQueue.slice(0, match.index + 1);
          before = before.replace(/\n/g, "\n  ");
          before = applyInlineFmt(before);
          if (state.fmtLineStart) { before = applyLineStartFmt(before); }
          state.fmtLineStart = before.endsWith("\n");
          write(color.white(before));
          state.responseCodeBlock = !state.responseCodeBlock;
          state.codeBlockLang = state.responseCodeBlock ? lang : "";
          state.streamQueue = state.streamQueue.slice(match.index + match[0].length);
        }
      } else if (state.responseCodeBlock) {
        let drained = 0;
        while (drained < 2 && state.streamQueue.length > 0) {
          const nlIdx = state.streamQueue.indexOf("\n");
          if (nlIdx < 0) break;
          const line = state.streamQueue.slice(0, nlIdx + 1);
          state.streamQueue = state.streamQueue.slice(nlIdx + 1);
          if (state.codeBlockLang === "diff") {
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
        const nlIdx = state.streamQueue.indexOf("\n");
        const chunkLen = nlIdx >= 0 ? nlIdx + 1 : Math.min(state.streamQueue.length, 128);
        let chunk = state.streamQueue.slice(0, chunkLen);
        state.streamQueue = state.streamQueue.slice(chunkLen);
        chunk = chunk.replace(/\n/g, "\n  ");
        chunk = applyInlineFmt(chunk);
        if (state.fmtLineStart) { chunk = applyLineStartFmt(chunk); }
        state.fmtLineStart = chunk.endsWith("\n");
        write(color.white(chunk));
      }
    }, 16);
  };

  const waitForStreamDrain = async (): Promise<void> => {
    while (state.streamQueue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  };

  const printAssistantBlock = (text: string) => {
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
      skipGuard: state.skipGuard,
      dev: state.dev,
      mcpNames: state.mcpNames,
      skillNames: state.skillNames,
      commands: COMMANDS,
      session: !!state.session,
    });
  };

  // ── Resize handler ──

  if (!process.stdin.isTTY) enableRawMode();

  process.stdout.on("resize", () => {
    updateScrollRegion();
    drawPrompt(state.busy);
    if (!state.busy && state.statusBarDrawn) {
      const { cols, rows } = getTermSize();
      const u = state.lastKnownUsage;
      const isDeepSeek = state.agent ? state.agent.getProviderName() === "deepseek" : false;
      const m = state.lastMetricsSnapshot;
      const sep = color.dim("│");
      const parts: string[] = [];
      if (u && u.totalTokens > 0) {
        const cacheStr = isDeepSeek ? `  ${fmtCacheRate(u.cachedTokens, u.promptTokens)}` : "";
        parts.push(`${fmtTokens(u.totalTokens)} tokens${cacheStr}`);
      }
      const ctxPct = state.agent?.getContextUsage().percentage ?? 0;
      parts.push(`ctx:${ctxPct}%`);
      if (m) parts.push(`HITL:${m.humanInLoopCount}`);
      if (parts.length > 0) {
        const fullLine = parts.join(`  ${sep}  `);
        state.statusBarTopRow = rows - STATUS_BAR_HEIGHT;
        write(ansi.moveTo(state.statusBarTopRow, 0) + ansi.clearLine + color.dim(vtrunc(fullLine, cols)));
      }
      drawPrompt(false);
    } else if (state.busy && state.statusBarDrawn) {
      state.statusBarTopRow = getTermSize().rows - STATUS_BAR_HEIGHT;
      drawStatusBar();
    }
  });

  redrawBanner();
  updateScrollRegion();

  // ── Task handler ──

  const handleTask = async (task: string) => {
    if (task === "/quit" || task === "/exit") {
      state.running = false;
      cleanup();
      return;
    }

    if (task === "/clear") {
      clearInputBox();
      clearStatusBar();
      state.statusBarDrawn = false;
      write(ansi.clear + ansi.moveTo(0, 0));
      updateScrollRegion();
      redrawBanner();
      drawPrompt();
      drawStatusBar();
      return;
    }

    // ── Command handlers ──

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
      if (!compressAnimTimer) {
        compressAnimProgress = 0;
        drawCompressBar(0, "保存归档...", false);
        compressAnimTimer = setInterval(() => {
          compressAnimProgress += 1;
          if (compressAnimProgress >= 90) {
            compressAnimProgress = 90;
            clearInterval(compressAnimTimer!);
            compressAnimTimer = null;
          }
          const labels: Record<string, string> = { archive: "保存归档...", summarize: "压缩消息..." };
          const label = labels[phase] ?? "压缩中...";
          drawCompressBar(compressAnimProgress, label, false);
        }, 30);
      }
      const labels: Record<string, string> = { archive: "保存归档...", summarize: "压缩消息..." };
      const label = labels[phase] ?? phase;
      if (progress > compressAnimProgress) {
        compressAnimProgress = progress;
        drawCompressBar(progress, label, false);
      }
    };

    if (task === "/help") {
      const cmdList = COMMANDS.filter((c) => !c.name.startsWith("/exit"))
        .map((c) => `${c.name} — ${c.description}`).join("\n");
      printAssistantBlock(`可用指令（输入 / 查看提示）：\n${cmdList}\n\n直接输入任务开始对话。ESC 取消当前运行。`);
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
      if (state.agent) {
        const h = state.agent.health();
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
      if (state.session) {
        printAssistantBlock(`Session: ${state.session.id}\nTask: ${state.session.task}\nMessages: ${state.agent?.getMessages().length ?? 0}`);
      } else {
        printAssistantBlock("No active session.");
      }
      drawPrompt();
      return;
    }

    if (task === "/resume") {
      const all = state.sessions.list();
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
      const all = state.sessions.list();
      const match = all.find((s) => s.id.startsWith(idPart));
      if (!match) {
        printAssistantBlock(`未找到会话: ${idPart}\n输入 /resume 查看列表。`);
      } else {
        state.session = match;
        if (state.session.usage) {
          state.lastKnownUsage = {
            promptTokens: state.session.usage.prompt_tokens,
            completionTokens: state.session.usage.completion_tokens,
            totalTokens: state.session.usage.total_tokens,
            cachedTokens: state.session.usage.cached_tokens ?? 0,
          };
        } else {
          state.lastKnownUsage = null;
        }
        state.agent = new Agent(workspaceRoot, state.session.id, state.mcpLoader, state.guard, {
          provider: state.provider as any,
          model: resolveModel(state.session.model ?? state.model),
          apiKey: resolveApiKey(state.apiKey),
          baseUrl: state.baseUrl,
          thinking: state.thinking,
          yunchang: state.yunchang,
        });
        state.agent.setParadigm(state.tuiParadigm);
        state.agent.restoreMessages(state.session.messages);
        state.agent.rebuildSystemPrompt();
        printAssistantBlock(
          `已恢复会话 ${state.session.id.slice(0, 8)}\n` +
          `任务：${state.session.task}\n` +
          `消息数：${state.session.messages.length}\n` +
          `Token 估算：${fmtTokens(state.agent.getContextUsage().estimatedTokens)} (${state.agent.getContextUsage().percentage}%)` +
          (state.session.usage ? `\n上次用量：${fmtTokensLive(state.session.usage.total_tokens)} tokens` : ``),
        );
      }
      drawPrompt();
      return;
    }

    if (task === "/model") {
      if (state.agent) {
        const models = state.agent.getDefaultModels();
        const current = state.agent.getModel();
        const lines = models.map((m) => m === current ? `  * ${m} (当前)` : `  - ${m}`).join("\n");
        printAssistantBlock(`可用模型：\n${lines}\n\n输入模型名切换，如 deepseek-v4-flash`);
      } else {
        printAssistantBlock("无活跃会话。");
      }
      drawPrompt();
      return;
    }

    if (task === "/deepthink" || task === "/deepthink on" || task === "/deepthink off") {
      if (state.agent) {
        const enable = task === "/deepthink on" || (task === "/deepthink" && !state.agent.getThinking());
        state.agent.setThinking(enable);
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
      if (state.agent) {
        write(ansi.moveTo(scrollRegionBottom(), 0) + "\n");
        write(color.yellow("⏳ 正在总结用户习惯...") + "\r");
        const content = await state.agent.summarizeSoul();
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
    if (state.agent && state.agent.getDefaultModels().includes(task.trim())) {
      state.agent.setModel(task.trim());
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
            const phase = (planData as Record<string, unknown>).phase as string ?? "execute";
            if (phase === "done") (planData as Record<string, unknown>).phase = "review";
            if (phase === "abandoned") (planData as Record<string, unknown>).phase = "execute";
            savePlanFile(workspaceRoot, match.id, planData as Record<string, unknown>);

            state.tuiParadigm = "ride";
            saveParadigmPref("ride");

            if (!state.session) {
              state.session = state.sessions.create(match.goal);
              state.lastKnownUsage = null;
              state.agent = new Agent(workspaceRoot, state.session.id, state.mcpLoader, state.guard, {
                provider: state.provider as any,
                model: resolveModel(state.model),
                apiKey: resolveApiKey(state.apiKey),
                baseUrl: state.baseUrl,
                thinking: state.thinking,
                yunchang: state.yunchang,
              });
              state.agent.setParadigm("ride");
              state.agent.setTask(match.goal);
            } else {
              if (!state.agent) {
                state.agent = new Agent(workspaceRoot, state.session.id, state.mcpLoader, state.guard, {
                  provider: state.provider as any,
                  model: resolveModel(state.model),
                  apiKey: resolveApiKey(state.apiKey),
                  baseUrl: state.baseUrl,
                  thinking: state.thinking,
                  yunchang: state.yunchang,
                });
              }
              state.agent.setParadigm("ride");
              state.agent.rebuildSystemPrompt();
              state.agent.getMessages().push({ role: "user", content: match.goal });
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
      if (state.agent) {
        const beforeLen = state.agent.getMessages().length;
        const beforeCtx = state.agent.getContextUsage();
        const compressed = await state.agent.compressContext(onCompress);
        const afterLen = state.agent.getMessages().length;
        const afterCtx = state.agent.getContextUsage();
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

    // ── Task execution ──

    state.busy = true;
    updateScrollRegion();
    state.streaming = true;
    state.taskAbort = new AbortController();
    startStatusBar();
    drawPrompt(true);

    if (!state.session) {
      state.session = state.sessions.create(task);
      state.lastKnownUsage = null;
      state.agent = new Agent(workspaceRoot, state.session.id, state.mcpLoader, state.guard, {
        provider: state.provider as any,
        model: resolveModel(state.model),
        apiKey: resolveApiKey(state.apiKey),
        baseUrl: state.baseUrl,
        thinking: state.thinking,
        yunchang: state.yunchang,
      });
      state.agent.setParadigm(state.tuiParadigm);
      state.agent.setTask(task, state.pendingImages);
    } else {
      if (!state.agent) {
        state.lastKnownUsage = null;
        state.agent = new Agent(workspaceRoot, state.session.id, state.mcpLoader, state.guard, {
          provider: state.provider as any,
          model: resolveModel(state.model),
          apiKey: resolveApiKey(state.apiKey),
          baseUrl: state.baseUrl,
          thinking: state.thinking,
          yunchang: state.yunchang,
        });
      }
      state.agent.setParadigm(state.tuiParadigm);
      state.agent.restoreMessages(state.agent.getMessages().concat([{ role: "user", content: buildUserContent(task, state.pendingImages) }]));
      state.agent.rebuildSystemPrompt();
      state.session.messages = state.agent.getMessages();
    }
    const currentAgent = state.agent;
    if (!currentAgent) throw new Error("Agent initialization failed");

    let streamOpened = false;

    const onReasoning = (_text: string) => {
      resetWatchdog();
      if (!streamOpened) {
        beginOutputBlock();
        write(color.red("chitu: ") + color.dim("思考中..."));
        streamOpened = true;
        state.printingAssistant = true;
        state.thinkingActive = true;
      }
    };

    const onToken = (text: string) => {
      resetWatchdog();
      const normalized = sanitizeAssistantText(text);
      if (!normalized) return;
      state.liveCompletionChars += text.length;

      if (state.thinkingActive) {
        write("\r" + ansi.clearLine + color.red("chitu: ") + color.dim("[thinked]") + "\n");
        state.thinkingActive = false;
      }

      if (!streamOpened) {
        beginOutputBlock();
        write(color.red("chitu: "));
        streamOpened = true;
        state.printingAssistant = true;
      }
      state.streamQueue += normalized;
      startStreamDrain();
    };

    const onToolOutput = (toolName: string, output: string) => {
      resetWatchdog();
      if (toolName === "phase") {
        if (!streamOpened) {
          beginOutputBlock();
          write(color.red("chitu: "));
          streamOpened = true;
          state.printingAssistant = true;
        }
        write(color.dim(output) + "\n");
        return;
      }

      if (!streamOpened) {
        beginOutputBlock();
        write(color.red("chitu: "));
        streamOpened = true;
        state.printingAssistant = true;
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

    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    const resetWatchdog = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        const dumpPath = join(workspaceRoot, ".chitu", "watchdog.json");
        try {
          if (!existsSync(dirname(dumpPath))) mkdirSync(dirname(dumpPath), { recursive: true });
          const msgs = state.agent?.getMessages() ?? [];
          const tail = msgs.slice(-5).map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content.slice(0, 500) : "(non-string)",
            tool_calls: m.tool_calls?.map((tc: any) => tc.function?.name ?? "?"),
          }));
          const agentState = state.agent ? { paradigm: (state.agent as any).paradigmState, model: state.agent.getModel?.() } : {};
          writeFileSync(dumpPath, JSON.stringify({
            stuckAt: new Date().toISOString(),
            sessionId: state.session?.id,
            messageCount: msgs.length,
            lastMessages: tail,
            agentState,
          }, null, 2), "utf-8");
        } catch { /* best-effort */ }
      }, WATCHDOG_IDLE_MS);
    };
    resetWatchdog();

    try {
      lastResponse = await currentAgent.execute(onToken, state.taskAbort!.signal, onToolOutput, onCompress, onReasoning);
      const usage = currentAgent.getUsage();
      if (usage) {
        state.lastKnownUsage = usage;
        if (state.session) {
          state.session.usage = {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
            cached_tokens: usage.cachedTokens,
          };
          state.session.model = currentAgent.getModel();
        }
      }
      await waitForStreamDrain();
      state.streaming = false;
      stopStreamDrain();
      state.printingAssistant = false;
      state.responseCodeBlock = false; state.codeBlockLang = "";

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
        if (lastResponse) { printAssistantBlock(lastResponse); }
        else { printAssistantBlock(""); }
      }

      if (state.session) {
        state.session.messages = currentAgent.getMessages();
        state.sessions.save(state.session);
      }
    } catch (e) {
      state.streaming = false;
      state.streamQueue = "";
      stopStreamDrain();
      state.printingAssistant = false;
      state.responseCodeBlock = false; state.codeBlockLang = "";
      clearInputBox();
      const cancelled = state.taskAbort?.signal.aborted;
      if (cancelled) {
        beginOutputBlock();
        write(color.yellow("[cancelled]") + "\n");
      } else {
        beginOutputBlock();
        write(color.red(`[error] ${String(e).slice(0, 120)}`) + "\n");
      }
      if (state.session) {
        state.session.messages = currentAgent.getMessages();
        state.sessions.save(state.session);
      }
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      state.streamQueue = "";
      stopStreamDrain();
      stopStatusBar();
      state.busy = false;
      state.streaming = false;
      state.printingAssistant = false;
      state.responseCodeBlock = false; state.codeBlockLang = "";
      state.taskAbort = null;
      state.pendingImages = [];
      updateScrollRegion();
      drawPrompt();

      // YunChang auto-continuation + auto-commit
      if (state.yunchang && lastResponse && state.agent) {
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
        if (shouldContinue && state.autoContinueCount < MAX_AUTO_CONTINUE) {
          state.autoContinueCount++;
          setImmediate(() => handleTask("continue"));
        } else {
          state.autoContinueCount = 0;
        }
      } else {
        state.autoContinueCount = 0;
      }
    }
  };

  // ── Input handlers ──

  const handleHistoryUp = () => {
    if (state.inputHistory.length === 0) return;
    if (state.historyIndex === -1) {
      state.historyDraft = state.inputBuffer;
      state.historyIndex = state.inputHistory.length - 1;
    } else if (state.historyIndex > 0) {
      state.historyIndex--;
    }
    state.inputBuffer = state.inputHistory[state.historyIndex] ?? "";
    drawPrompt();
  };

  const handleHistoryDown = () => {
    if (state.historyIndex === -1) return;
    if (state.historyIndex < state.inputHistory.length - 1) {
      state.historyIndex++;
      state.inputBuffer = state.inputHistory[state.historyIndex] ?? "";
    } else {
      state.historyIndex = -1;
      state.inputBuffer = state.historyDraft;
    }
    drawPrompt();
  };

  const handleUp = () => {
    const matches = getHintMatches();
    if (matches.length > 0 && state.inputBuffer.startsWith("/")) {
      if (state.hintFocus > 0) {
        state.hintFocus--;
        drawPrompt();
      }
    } else {
      handleHistoryUp();
    }
  };

  const handleDown = () => {
    const matches = getHintMatches();
    if (matches.length > 0 && state.inputBuffer.startsWith("/")) {
      if (state.hintFocus < matches.length - 1) {
        state.hintFocus++;
        drawPrompt();
      }
    } else {
      handleHistoryDown();
    }
  };

  const handleBackspace = () => {
    if (state.inputBuffer.length === 0) return;
    const lastCode = state.inputBuffer.charCodeAt(state.inputBuffer.length - 1);
    if (lastCode >= 0xDC00 && lastCode <= 0xDFFF && state.inputBuffer.length > 1) {
      state.inputBuffer = state.inputBuffer.slice(0, -2);
    } else {
      state.inputBuffer = state.inputBuffer.slice(0, -1);
    }
    drawPrompt();
  };

  const handleClearScreen = () => {
    clearInputBox();
    write(ansi.clear + ansi.moveTo(0, 0));
    updateScrollRegion();
    drawPrompt();
  };

  const appendInputChunk = (chunk: string): void => {
    if (!chunk) return;
    state.inputBuffer = state.inputBuffer + chunk;
  };

  const handleSubmit = () => {
    const raw = state.inputBuffer.replace(/\r/g, "");

    // Hint interaction on Enter
    const matches = getHintMatches();
    if (matches.length > 0 && raw.startsWith("/") && !state.busy) {
      const focused = matches[state.hintFocus];
      if (focused) {
        if ((raw.trim() === "/resume" || raw.startsWith("/resume ")) && focused.name.length >= 8) {
          const sid = focused.name;
          state.inputBuffer = "";
          state.hintFocus = 0;
          state.prevHintCount = 0;
          state.sessionHints = [];
          state.historyIndex = -1;
          state.historyDraft = "";
          clearInputBox();
          beginOutputBlock();
          write(color.bold(color.white(`> /resume ${sid.slice(0, 8)}`)) + "\n");
          void handleTask(`/resume ${sid}`);
          return;
        }

        if ((raw.trim() === "/plan-active" || raw.startsWith("/plan-active ")) && focused.name.startsWith("plan-")) {
          const pid = focused.name;
          state.inputBuffer = "";
          state.hintFocus = 0;
          state.prevHintCount = 0;
          state.planHints = [];
          state.historyIndex = -1;
          state.historyDraft = "";
          clearInputBox();
          beginOutputBlock();
          write(color.bold(color.white(`> /plan-active ${pid.slice(5)}`)) + "\n");
          void handleTask(`/plan-active ${pid}`);
          return;
        }

        if (raw === focused.name) {
          // exact match, fall through to submit
        } else if (raw.trim().length > 0) {
          state.inputBuffer = focused.name + " ";
          state.hintFocus = 0;
          state.prevHintCount = 0;
          drawPrompt();
          return;
        }
      }
    }

    state.inputBuffer = "";
    state.historyIndex = -1;
    state.historyDraft = "";
    if (raw.length === 0) {
      drawPrompt();
      return;
    }

    const { cleanText, imagePaths } = detectImages(raw);
    state.pendingImages = imagePaths;

    if ((state.inputHistory.length === 0 || state.inputHistory[state.inputHistory.length - 1] !== raw) && raw.trim().length > 0) {
      state.inputHistory.push(raw);
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

  // ── Raw input consumer ──

  const consumeRawInput = () => {
    while (state.pendingRawInput.length > 0) {
      if (state.inBracketedPaste) {
        const end = state.pendingRawInput.indexOf(BRACKETED_PASTE_END);
        if (end === -1) {
          appendInputChunk(sanitizeInputChunk(state.pendingRawInput));
          state.pendingRawInput = "";
          drawPrompt();
          return;
        }
        appendInputChunk(sanitizeInputChunk(state.pendingRawInput.slice(0, end)));
        state.pendingRawInput = state.pendingRawInput.slice(end + BRACKETED_PASTE_END.length);
        state.inBracketedPaste = false;
        drawPrompt();
        continue;
      }

      if (state.pendingRawInput.startsWith(BRACKETED_PASTE_START)) {
        state.inBracketedPaste = true;
        state.pendingRawInput = state.pendingRawInput.slice(BRACKETED_PASTE_START.length);
        continue;
      }

      if (state.pendingRawInput.startsWith("\x1b[A")) { state.pendingRawInput = state.pendingRawInput.slice(3); if (!state.busy) handleUp(); continue; }
      if (state.pendingRawInput.startsWith("\x1b[B")) { state.pendingRawInput = state.pendingRawInput.slice(3); if (!state.busy) handleDown(); continue; }
      if (state.pendingRawInput.startsWith("\x1b[C") || state.pendingRawInput.startsWith("\x1b[D")) { state.pendingRawInput = state.pendingRawInput.slice(3); continue; }
      if (state.pendingRawInput.startsWith("\x1b[3~")) { state.pendingRawInput = state.pendingRawInput.slice(4); if (!state.busy) handleBackspace(); continue; }

      if (state.pendingRawInput[0] === "\x03") {
        state.pendingRawInput = state.pendingRawInput.slice(1);
        state.running = false;
        cleanup();
        return;
      }
      if (state.pendingRawInput[0] === "\x0c") {
        state.pendingRawInput = state.pendingRawInput.slice(1);
        if (!state.busy) handleClearScreen();
        continue;
      }
      if (state.pendingRawInput.startsWith("\x1b[Z")) {
        state.pendingRawInput = state.pendingRawInput.slice(3);
        if (!state.busy) cycleParadigm();
        continue;
      }
      if (state.pendingRawInput.startsWith("\x1b[27;2;13~")) {
        state.pendingRawInput = state.pendingRawInput.slice(10);
        if (!state.busy) { appendInputChunk("\n"); drawPrompt(); }
        continue;
      }
      if (state.pendingRawInput[0] === "\x1b") {
        state.pendingRawInput = state.pendingRawInput.slice(1);
        if (state.streaming) state.taskAbort?.abort();
        continue;
      }
      if (state.pendingRawInput[0] === "\x7f" || state.pendingRawInput[0] === "\b") {
        state.pendingRawInput = state.pendingRawInput.slice(1);
        if (!state.busy) handleBackspace();
        continue;
      }
      if (state.pendingRawInput[0] === "\r") {
        if (state.pendingRawInput[1] === "\n") {
          state.pendingRawInput = state.pendingRawInput.slice(2);
        } else {
          state.pendingRawInput = state.pendingRawInput.slice(1);
        }
        if (!state.busy) handleSubmit();
        continue;
      }
      if (state.pendingRawInput[0] === "\n") {
        state.pendingRawInput = state.pendingRawInput.slice(1);
        if (!state.busy) {
          appendInputChunk("\n");
          drawPrompt();
        }
        continue;
      }

      const cp = state.pendingRawInput.codePointAt(0)!;
      const ch = String.fromCodePoint(cp);
      state.pendingRawInput = state.pendingRawInput.slice(cp > 0xFFFF ? 2 : 1);
      if (!state.busy) {
        appendInputChunk(sanitizeInputChunk(ch));
        drawPrompt();
      }
    }
  };

  // ── Event loop ──

  process.stdin.on("data", (buf: Buffer) => {
    state.pendingRawInput += state.decoder.write(buf);
    consumeRawInput();
  });

  drawPrompt();
  drawStatusBar();

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!state.running) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });

  function cleanup() {
    if (state.cleanupDone) return;
    state.cleanupDone = true;

    state.taskAbort?.abort();
    state.taskAbort = null;

    if (state.agent) state.agent.abort();

    stopStreamDrain();
    stopStatusBar();
    state.decoder.end();
    disableRawMode();
    write(ansi.bracketedPasteOff);
    resetScrollRegion();
    write(ansi.showCursor);
    write("\n\n" + color.dim("  赤兔已停。再见。") + "\n\n");

    mcpLoader.stopAll().catch((e) => { logger.warn("MCP stopAll failed", { error: String(e) }); });
  }

  process.once("SIGINT", () => { cleanup(); process.exit(0); });
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });
}
