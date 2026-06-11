/**
 * render-stream.ts — Stream rendering
 *
 * Extracted from app.ts startTUI closure.
 * Functions for streaming output rendering, assistant block printing,
 * banner redraw, and terminal resize handling.
 */
import {
  write, color, ansi,
  highlightLine, BG_RED_BASE, BG_GREEN_BASE, BG_GRAY_BASE,
} from "./screen.js";
import { applyInlineFmt, applyLineStartFmt } from "./formatting.js";
import { printStartupBanner } from "./banner.js";
import type { TUIState } from "./state.js";
import { COMMANDS } from "./state.js";
import { detectProvider } from "../providers/types.js";
import { resolveModel } from "../global-config.js";

// ── Pure text sanitization ──

export function sanitizeAssistantText(text: string): string {
  return text
    .replace(/\r/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

// ── Stream drain control ──

export function stopStreamDrain(state: TUIState): void {
  if (state.streamDrainInterval) {
    clearInterval(state.streamDrainInterval);
    state.streamDrainInterval = null;
  }
}

export function startStreamDrain(state: TUIState): void {
  if (state.streamDrainInterval) return;
  state.streamDrainInterval = setInterval(() => {
    if (!state.streamQueue) {
      if (!state.streaming) stopStreamDrain(state);
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
}

export async function waitForStreamDrain(state: TUIState): Promise<void> {
  while (state.streamQueue.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

// ── Assistant block ──

export function printAssistantBlock(
  text: string,
  scrollRegionBottom: () => number,
): void {
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
}

// ── Banner ──

const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  deepseek: "deepseek-v4-pro",
  claude: "claude-sonnet-4-6",
  openai: "gpt-4o",
};

export function redrawBanner(state: TUIState): number {
  const agent = state.agent;
  const providerName = agent?.getProviderName() ?? state.provider ?? detectProvider();
  const modelName = agent?.getModel() ?? resolveModel(state.model) ?? PROVIDER_DEFAULT_MODEL[providerName] ?? "default";
  return printStartupBanner({
    skipGuard: state.skipGuard,
    dev: state.dev,
    mcpNames: state.mcpNames,
    skillNames: state.skillNames,
    commands: COMMANDS,
    session: !!state.session,
    providerName,
    modelName,
  });
}

// ── Resize handler ──

export interface ResizeDeps {
  updateScrollRegion: () => void;
  drawPrompt: (returnToScrollArea?: boolean) => void;
  drawStatusBar: () => void;
  getTermSize: () => { cols: number; rows: number };
  vtrunc: (text: string, maxWidth: number) => string;
  fmtTokens: (n: number) => string;
  fmtCacheRate: (cached: number, prompt: number) => string;
}

export function handleResize(state: TUIState, deps: ResizeDeps): void {
  const {
    updateScrollRegion, drawPrompt, drawStatusBar,
    getTermSize, vtrunc, fmtTokens, fmtCacheRate,
  } = deps;

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
      state.statusBarTopRow = rows - 1; // STATUS_BAR_HEIGHT is 1
      write(ansi.saveCursor + ansi.moveTo(state.statusBarTopRow, 0) + ansi.clearLine + color.dim(vtrunc(fullLine, cols)) + ansi.restoreCursor);
    }
    drawPrompt(false);
  } else if (state.busy && state.statusBarDrawn) {
    state.statusBarTopRow = getTermSize().rows - 1; // STATUS_BAR_HEIGHT is 1
    drawStatusBar();
  }
}
