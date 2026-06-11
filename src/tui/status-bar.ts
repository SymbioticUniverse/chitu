/**
 * status-bar.ts — Status bar, mode bar, hint panel, metrics helpers
 *
 * Extracted from app.ts startTUI closure.
 */
import { write, color, ansi, getTermSize } from "./screen.js";
import {
  STATUS_BAR_HEIGHT, MODE_BAR_HEIGHT, MAX_HINT_LINES,
  STATUS_FRAMES, PARADIGM_COLORS, PARADIGM_CYCLE, PARADIGM_DESC,
} from "./state.js";
import type { TUIState, HintItem } from "./state.js";
import { vtrunc } from "./visual.js";
import { MetricsEngine } from "../metrics.js";
import type { Paradigm } from "../types.js";

// ── Deps interface ──

export interface StatusBarDeps {
  scrollRegionBottom: () => number;
  getMaxInputLines: (rows: number) => number;
  getHintMatches: () => HintItem[];
}

// ── Formatting helpers ──

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

export function fmtTokensLive(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(3)}K` : String(n);
}

export function fmtCacheRate(cached: number, prompt: number): string {
  if (prompt <= 0) return "";
  return `cache:${Math.round((cached / prompt) * 100)}%`;
}

export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// ── Token animation ──

export function tickAnimTokens(state: TUIState, target: number, targetRate: number): void {
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
}

// ── Live metrics ──

export function getLiveMetrics(workspaceRoot: string): { humanInLoopCount: number } {
  try {
    const engine = new MetricsEngine(workspaceRoot);
    const report = engine.compute();
    if (report) return { humanInLoopCount: report.humanInLoopCount };
  } catch { /* skip */ }
  return { humanInLoopCount: 0 };
}

// ── Paradigm ──

export function getActiveParadigm(state: TUIState): Paradigm {
  if (state.agent) return state.agent.getParadigmState().active;
  return state.tuiParadigm;
}

// ── Mode bar ──

export function drawModeBar(state: TUIState): void {
  const { rows } = getTermSize();
  const modeBarRow = rows - STATUS_BAR_HEIGHT - 1;

  const active = getActiveParadigm(state);
  const c = (PARADIGM_COLORS as Record<string, string>)[active] ?? "dim";
  const pc = (s: string) => {
    if (c === "green") return color.green(s);
    if (c === "magenta") return color.magenta(s);
    if (c === "yellow") return color.yellow(s);
    if (c === "cyan") return color.cyan(s);
    return color.dim(s);
  };

  const desc = PARADIGM_DESC[active] ?? "";
  const label = active === "appraise" ? "Ask" : active === "constraint" ? "Constraint" : "Manual";
  const cycleHint = PARADIGM_CYCLE.includes(active) ? " (shift+tab to cycle · ctrl+j to newline)" : "";
  const thinkingOn = state.agent?.getThinking();
  const thinkingTag = thinkingOn ? " " + color.yellow("[thinking]") : "";
  const line = " " + pc(`<${label}>`) + thinkingTag + color.dim(` --${desc}${cycleHint}`);

  write(ansi.moveTo(modeBarRow, 0) + ansi.clearLine + line);
}

// ── Status bar ──

export function drawStatusBar(state: TUIState, deps: StatusBarDeps): void {
  const { cols, rows } = getTermSize();
  const barRow = rows - STATUS_BAR_HEIGHT;

  const sep = color.dim("│");
  const isDeepSeek = state.agent ? state.agent.getProviderName() === "deepseek" : false;

  if (state.busy) {
    const spinner = STATUS_FRAMES[state.statusFrameIdx % STATUS_FRAMES.length]!;
    state.statusFrameIdx++;

    const now = Date.now();
    const elapsed = state.taskStartTime ? fmtElapsed(now - state.taskStartTime) : "00:00";

    const m = state.lastMetricsSnapshot ?? getLiveMetrics(state.workspaceRoot);
    if (!state.lastMetricsSnapshot) state.lastMetricsSnapshot = m;

    const workingPart = `${spinner} Chitu working · ${elapsed}`;

    const u = state.agent?.getUsage() ?? state.lastKnownUsage;
    const liveComp = Math.ceil(state.liveCompletionChars / 4);
    const liveTotal = state.livePromptChars + liveComp;
    const target = u?.totalTokens ?? (state.streaming ? liveTotal : state.animTokens);
    const targetRate = (u && u.promptTokens > 0) ? Math.round((u.cachedTokens / u.promptTokens) * 100) : state.animCacheRate;
    tickAnimTokens(state, target, targetRate);

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

    write(
      ansi.saveCursor +
      ansi.moveTo(barRow, 0) + ansi.clearLine + color.dim(trimmed) +
      ansi.restoreCursor);
  } else {
    const u = state.agent?.getUsage() ?? state.lastKnownUsage;
    const target = u?.totalTokens ?? 0;
    const targetRate = (u && u.promptTokens > 0) ? Math.round((u.cachedTokens / u.promptTokens) * 100) : state.animCacheRate;
    tickAnimTokens(state, target, targetRate);

    const m = state.lastMetricsSnapshot;
    const parts: string[] = [];
    const cacheStr = isDeepSeek ? `  cache:${state.animCacheRate}%` : "";
    parts.push(`${fmtTokens(state.animTokens)} tokens${cacheStr}`);
    const ctxPct = state.agent?.getContextUsage().percentage ?? 0;
    parts.push(`ctx:${ctxPct}%`);
    if (m) parts.push(`HITL:${m.humanInLoopCount}`);
    const fullLine = parts.join(`  ${sep}  `);
    const trimmed = vtrunc(fullLine, cols);

    write(
      ansi.saveCursor +
      ansi.moveTo(barRow, 0) + ansi.clearLine + color.dim(trimmed) +
      ansi.restoreCursor);
  }
  state.statusBarDrawn = true;
  state.statusBarTopRow = barRow;
}

export function clearStatusBar(state: TUIState, deps: StatusBarDeps): void {
  if (!state.statusBarDrawn) return;
  write(ansi.saveCursor + ansi.moveTo(state.statusBarTopRow, 0) + ansi.clearLine + ansi.restoreCursor);
  state.statusBarDrawn = false;
}

export function startStatusBar(state: TUIState, deps: StatusBarDeps): void {
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
  drawStatusBar(state, deps);
  state.statusInterval = setInterval(() => {
    try {
      if (state.busy && state.statusFrameIdx % 4 === 0) {
        state.lastMetricsSnapshot = getLiveMetrics(state.workspaceRoot);
      }
      clearStatusBar(state, deps);
      drawStatusBar(state, deps);
    } catch {
      // prevent interval death from transient errors (e.g. terminal resize race)
    }
  }, 150);
}

export function stopStatusBar(state: TUIState, deps: StatusBarDeps): void {
  if (state.statusInterval) {
    clearInterval(state.statusInterval);
    state.statusInterval = null;
  }
  const u = state.agent?.getUsage() ?? state.lastKnownUsage;
  const isDeepSeek = state.agent ? state.agent.getProviderName() === "deepseek" : false;
  const { cols } = getTermSize();
  const m = state.lastMetricsSnapshot ?? getLiveMetrics(state.workspaceRoot);

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
  write(ansi.saveCursor + ansi.moveTo(state.statusBarTopRow, 0) + ansi.clearLine + color.dim(vtrunc(fullLine, cols)) + ansi.restoreCursor);
  state.statusBarDrawn = true;
  state.taskStartTime = null;
}

// ── Hint panel ──

export function drawHintPanel(state: TUIState, deps: StatusBarDeps): void {
  const matches = deps.getHintMatches();
  if (matches.length === 0) return;

  if (matches.length !== state.prevHintCount) {
    state.hintFocus = 0;
    state.prevHintCount = matches.length;
  }

  const { rows } = getTermSize();
  const gap = deps.getMaxInputLines(rows) - state.inputBoxHeight;
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
  const scrBot = deps.scrollRegionBottom();

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
}
