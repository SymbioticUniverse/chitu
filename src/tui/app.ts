import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { execSync } from "node:child_process";
import {
  ansi, color, write, getTermSize, enableRawMode,
  disableRawMode, setScrollRegion, resetScrollRegion,
  isVSCodeTerminal,
} from "./screen.js";
import { Agent, buildUserContent } from "../agent.js";
import { SessionManager } from "../session.js";
import { MCPLoader } from "../mcp/loader.js";
import { HorsewhipGuardImpl } from "../horsewhip/guard.js";
import { logger } from "../logger.js";
import { charDisplayWidth, vlen, vtrunc } from "./visual.js";
import { FMT_BOLD, FMT_ITALIC, FMT_LINK, FMT_CODE, FMT_HEADER, FMT_MUTED, FMT_WHITE } from "./formatting.js";
import { loadPlanFile, savePlanFile, listPlanFiles } from "../target/plan.js";
import type { ProviderName } from "../providers/index.js";
import type { Paradigm } from "../types.js";
import { resolveApiKey, resolveModel } from "../global-config.js";
import {
  createTUIState, type TUIState, type HintItem,
  STATUS_BAR_HEIGHT, MODE_BAR_HEIGHT, MAX_HINT_LINES, MAX_AUTO_CONTINUE, SCROLL_TOP,
  IMAGE_EXTS,
  WATCHDOG_IDLE_MS, COMMANDS, PARADIGM_CYCLE,
} from "./state.js";
import {
  sanitizeAssistantText, stopStreamDrain, startStreamDrain, waitForStreamDrain,
  printAssistantBlock, redrawBanner, handleResize, type ResizeDeps,
} from "./render-stream.js";
import {
  sanitizeInputChunk, createInputHandlers, type InputDeps, type InputHandlers,
} from "./input.js";
import {
  fmtTokens, fmtTokensLive, fmtCacheRate, fmtElapsed,
  tickAnimTokens, getHorsewhipStats, getActiveParadigm,
  drawStatusBar, clearStatusBar, startStatusBar, stopStatusBar,
  drawModeBar, drawHintPanel,
  type StatusBarDeps,
} from "./status-bar.js";

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
  let tuiParadigm: Paradigm = (config.paradigm as Paradigm | undefined) ?? "constraint";
  const paradigmPrefFile = join(workspaceRoot, ".chitu", "paradigm.json");
  const loadParadigmPref = (): string | null => {
    try {
      if (existsSync(paradigmPrefFile)) {
        const data = JSON.parse(readFileSync(paradigmPrefFile, "utf-8"));
        if (data.paradigm && ["appraise", "constraint", "manual"].includes(data.paradigm)) {
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
    if (isVSCodeTerminal()) return; // VS Code: skip scroll regions
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
    if (isVSCodeTerminal()) {
      // Manual scroll: move to bottom, insert a newline to push content up
      write(ansi.saveCursor + ansi.moveTo(scrollRegionBottom(), 0) + ansi.clearLine + "\n" + ansi.restoreCursor);
    } else {
      write(ansi.moveTo(scrollRegionBottom(), 0) + ansi.clearLine + "\n");
    }
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

    // ── Expand approval selection UI ──
    if (state.expandApproval) {
      updateScrollRegion();
      write(ansi.saveCursor);
      drawHintPanel(state, statusBarDeps);
      drawModeBar(state);
      write(ansi.restoreCursor);

      const promptBottom = Math.max(0, rows - STATUS_BAR_HEIGHT - MODE_BAR_HEIGHT - 1);
      const approveSelected = state.expandApproval.selectedIndex === 0;
      const denySelected = state.expandApproval.selectedIndex === 1;
      const HL = "\x1b[48;5;240m";
      const SEL = "\x1b[48;5;28m";
      const DEN = "\x1b[48;5;88m";

      // Line 1: approve option
      const approveBg = approveSelected ? SEL : HL;
      write(ansi.moveTo(promptBottom - 1, 0) + approveBg + ansi.clearLine +
        color.white("  " + (approveSelected ? "▶ " : "  ") + "Approve — allow modifying additional files") + "\x1b[K" + ansi.reset);
      // Line 0: deny option
      const denyBg = denySelected ? DEN : HL;
      write(ansi.moveTo(promptBottom, 0) + denyBg + ansi.clearLine +
        color.white("  " + (denySelected ? "▶ " : "  ") + "Deny — keep original boundary") + "\x1b[K" + ansi.reset);

      // Extra line for file info
      const filesText = state.expandApproval.paths.join(", ");
      write(ansi.moveTo(promptBottom - 2, 0) + ansi.clearLine + color.dim(`  Files: ${filesText.slice(0, cols - 10)}`) + ansi.reset);

      write(ansi.moveTo(promptBottom, 0));
      state.inputBoxDrawn = true;
      state.inputBoxHeight = 2;
      state.inputBoxTopRow = Math.max(0, promptBottom - 1);
      return;
    }

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
        if (isVSCodeTerminal()) {
          write(ansi.saveCursor + ansi.moveTo(scrollRegionBottom(), 0) + ansi.clearLine + "\n" + ansi.restoreCursor);
        } else {
          write(ansi.moveTo(scrollRegionBottom(), 0) + "\n");
        }
      }
    }

    updateScrollRegion();

    const curHintH = getHintHeight();
    if (state.prevHintHeight > curHintH) {
      const { rows: r2 } = getTermSize();
      const promptBottom2 = r2 - STATUS_BAR_HEIGHT - MODE_BAR_HEIGHT - 1;
      const inputBoxTop = promptBottom2 - state.inputBoxHeight + 1;
      const hintEnd = inputBoxTop - 1;
      for (let i = curHintH; i < state.prevHintHeight; i++) {
        const row = hintEnd - i;
        if (row > scrollRegionBottom()) write(ansi.moveTo(row, 0) + ansi.clearLine);
      }
    }
    state.prevHintHeight = curHintH;

    write(ansi.saveCursor);
    drawHintPanel(state, statusBarDeps);
    drawModeBar(state);
    write(ansi.restoreCursor);

    const isCommand = state.inputBuffer.startsWith("/");
    const USER_INPUT_BG = "\x1b[48;5;236m";

    const promptBottom3 = Math.max(0, rows - STATUS_BAR_HEIGHT - MODE_BAR_HEIGHT - 1);
    for (let i = 0; i < visibleLines.length; i++) {
      const lineIdx = visibleLines.length - 1 - i;
      const isFirstVisibleLine = lineIdx === 0;
      const prefix = isFirstVisibleLine
        ? (wasTrimmed ? "… " : "> ")
        : "  ";
      const line = visibleLines[lineIdx] ?? "";
      const contentColor = isCommand ? color.red : color.white;
      const rendered = color.bold(color.white(prefix)) + contentColor(trimLeftToWidth(line, contentWidth));
      write(ansi.moveTo(promptBottom3 - i, 0) + USER_INPUT_BG + ansi.clearLine + rendered + "\x1b[K" + ansi.reset);
    }

    const lastVisibleLine = visibleLines[visibleLines.length - 1] ?? "";
    const cursorRow = Math.min(rows - 1, promptBottom3);
    const cursorCol = Math.min(Math.max(0, cols - 1), 2 + vlen(lastVisibleLine));
    if (!returnToScrollArea) {
      write(ansi.moveTo(cursorRow, 0) + ansi.moveRight(cursorCol));
    } else {
      write(ansi.moveTo(scrollRegionBottom(), 0));
    }
    state.inputBoxDrawn = true;
    state.inputBoxTopRow = Math.max(0, promptBottom3 - state.inputBoxHeight + 1);
  };

  // ── Status bar deps (closure-scoped functions used by status-bar.ts) ──

  const statusBarDeps: StatusBarDeps = {
    scrollRegionBottom,
    getMaxInputLines,
    getHintMatches,
  };

  // Wrappers for ResizeDeps (which expects () => void signatures)
  const drawStatusBarWrapped = () => drawStatusBar(state, statusBarDeps);

  // ── Paradigm ──

  const cycleParadigm = () => {
    const current = getActiveParadigm(state);
    const idx = PARADIGM_CYCLE.indexOf(current);
    const next = PARADIGM_CYCLE[(idx + 1) % PARADIGM_CYCLE.length]!;
    state.tuiParadigm = next;
    saveParadigmPref(next);
    if (state.agent) {
      state.agent.setParadigm(next);
      state.agent.rebuildSystemPrompt();
    }
    drawModeBar(state);
  };

  // ── Resize handler ──

  const resizeDeps: ResizeDeps = {
    updateScrollRegion,
    drawPrompt,
    drawStatusBar: drawStatusBarWrapped,
    getTermSize,
    vtrunc,
    fmtTokens,
    fmtCacheRate,
  };

  if (!process.stdin.isTTY) enableRawMode();

  process.stdout.on("resize", () => {
    handleResize(state, resizeDeps);
  });

  redrawBanner(state);
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
      clearStatusBar(state, statusBarDeps);
      state.statusBarDrawn = false;
      write(ansi.clear + ansi.moveTo(0, 0));
      updateScrollRegion();
      redrawBanner(state);
      drawPrompt();
      drawStatusBarWrapped();
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
      write(`\x1b[2K\r${icon} Compressing context [${bar}] ${p}% — ${label}`);
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
        drawCompressBar(100, "Done", true);
        return;
      }
      if (!compressAnimTimer) {
        compressAnimProgress = 0;
        drawCompressBar(0, "Archiving...", false);
        compressAnimTimer = setInterval(() => {
          compressAnimProgress += 1;
          if (compressAnimProgress >= 90) {
            compressAnimProgress = 90;
            clearInterval(compressAnimTimer!);
            compressAnimTimer = null;
          }
          const labels: Record<string, string> = { archive: "Archiving...", summarize: "Compressing..." };
          const label = labels[phase] ?? "Compressing...";
          drawCompressBar(compressAnimProgress, label, false);
        }, 30);
      }
      const labels: Record<string, string> = { archive: "Archiving...", summarize: "Compressing..." };
      const label = labels[phase] ?? phase;
      if (progress > compressAnimProgress) {
        compressAnimProgress = progress;
        drawCompressBar(progress, label, false);
      }
    };

    if (task === "/help") {
      const cmdList = COMMANDS.filter((c) => !c.name.startsWith("/exit"))
        .map((c) => `${c.name} — ${c.description}`).join("\n");
      printAssistantBlock(`Available commands (type / for hints):\n${cmdList}\n\nType a task to start. ESC to cancel.`, scrollRegionBottom);
      drawPrompt();
      return;
    }


    if (task === "/health") {
      if (state.agent) {
        const h = state.agent.health();
        printAssistantBlock(
          `OK: ${h.ok}\nSession: ${h.session}\nMessages: ${h.messageCount}\nShutdown: ${h.shutdown}\n`
          + `Rate limits:\n${h.rateLimit.map((r) => `${r.tool}: ${r.used}/${r.limit} per ${r.windowMs / 1000}s`).join("\n")}`,
          scrollRegionBottom,
        );
      } else {
        printAssistantBlock("No active session.", scrollRegionBottom);
      }
      drawPrompt();
      return;
    }

    if (task === "/session") {
      if (state.session) {
        printAssistantBlock(`Session: ${state.session.id}\nTask: ${state.session.task}\nMessages: ${state.agent?.getMessages().length ?? 0}`, scrollRegionBottom);
      } else {
        printAssistantBlock("No active session.", scrollRegionBottom);
      }
      drawPrompt();
      return;
    }

    if (task === "/resume") {
      const all = state.sessions.list();
      if (all.length === 0) {
        printAssistantBlock("No session history.", scrollRegionBottom);
      } else {
        const recent = all.slice(0, 8);
        const lines = recent.map((s) => {
          const shortId = s.id.slice(0, 8);
          const date = new Date(s.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
          return `  ${shortId}  ${date}  ${s.task.slice(0, 50)}`;
        }).join("\n");
        printAssistantBlock(`Session history (type /resume <id> to restore):\n${lines}`, scrollRegionBottom);
      }
      drawPrompt();
      return;
    }

    if (task.startsWith("/resume ")) {
      const idPart = task.slice(8).trim();
      const all = state.sessions.list();
      const match = all.find((s) => s.id.startsWith(idPart));
      if (!match) {
        printAssistantBlock(`Session not found: ${idPart}\nType /resume to list sessions.`, scrollRegionBottom);
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
          `Session restored: ${state.session.id.slice(0, 8)}\n` +
          `Task: ${state.session.task}\n` +
          `Messages: ${state.session.messages.length}\n` +
          `Token est.: ${fmtTokens(state.agent.getContextUsage().estimatedTokens)} (${state.agent.getContextUsage().percentage}%)` +
          (state.session.usage ? `\nLast usage: ${fmtTokensLive(state.session.usage.total_tokens)} tokens` : ``),
          scrollRegionBottom,
        );
      }
      drawPrompt();
      return;
    }

    if (task === "/model") {
      if (state.agent) {
        const models = state.agent.getDefaultModels();
        const current = state.agent.getModel();
        const lines = models.map((m) => m === current ? `  * ${m} (current)` : `  - ${m}`).join("\n");
        printAssistantBlock(`Available models:\n${lines}\n\nType a model name to switch, e.g. deepseek-v4-flash`, scrollRegionBottom);
      } else {
        printAssistantBlock("No active session.", scrollRegionBottom);
      }
      drawPrompt();
      return;
    }

    if (task === "/deepthink" || task === "/deepthink on" || task === "/deepthink off") {
      if (state.agent) {
        const enable = task === "/deepthink on" || (task === "/deepthink" && !state.agent.getThinking());
        state.agent.setThinking(enable);
        drawModeBar(state);
        const status = enable ? "enabled" : "disabled";
        printAssistantBlock(`Deep thinking: ${status}\nThe model will${enable ? "" : " NOT"} think deeply before answering.`, scrollRegionBottom);
      } else {
        printAssistantBlock("No active session.", scrollRegionBottom);
      }
      drawPrompt();
      return;
    }

    if (task === "/soul") {
      if (state.agent) {
        write(ansi.moveTo(scrollRegionBottom(), 0) + "\n");
        write(color.yellow("⏳ Summarizing soul...") + "\r");
        const content = await state.agent.summarizeSoul();
        if (content) {
          const record = (await import("../soul.js")).SoulManager.load();
          printAssistantBlock(
            `🧠 Soul updated (v${record?.version ?? "?"}, ~${record?.estimatedTokens ?? 0} tokens):\n\n${content}`,
            scrollRegionBottom,
          );
        } else {
          printAssistantBlock("Unable to summarize soul. Try again after a few more conversation rounds.", scrollRegionBottom);
        }
      } else {
        printAssistantBlock("No active session.", scrollRegionBottom);
      }
      drawPrompt();
      return;
    }

    if (task === "/soul-show") {
      const record = (await import("../soul.js")).SoulManager.load();
      if (record) {
        printAssistantBlock(`🧠 Soul (v${record.version}, ~${record.estimatedTokens} tokens):\n\n${record.content}`, scrollRegionBottom);
      } else {
        printAssistantBlock("No soul record yet. It will be generated after a few conversation rounds, or type /soul to force update.", scrollRegionBottom);
      }
      drawPrompt();
      return;
    }

    if (task === "/update") {
      import("../update.js").then(({ updateChitu }) => {
        updateChitu().then(() => {
          write(color.green("\n✅ Update completed. Restart Chitu to use the new version.") + "\n");
          drawPrompt(true);
        }).catch((e) => {
          write(color.red(`\n❌ Update failed: ${String(e).slice(0, 200)}`) + "\n");
          drawPrompt(true);
        });
      }).catch((e) => {
        write(color.red(`\n❌ Update module not available: ${String(e).slice(0, 200)}`) + "\n");
        drawPrompt(true);
      });
      return;
    }

    // Switch model by name
    if (state.agent && state.agent.getDefaultModels().includes(task.trim())) {
      state.agent.setModel(task.trim());
      printAssistantBlock(`Model switched to: ${task.trim()}`, scrollRegionBottom);
      drawPrompt();
      return;
    }

    if (task === "/plan-active") {
      const all = listPlanFiles(workspaceRoot);
      if (all.length === 0) {
        printAssistantBlock("No active plans. Start a Target task to create one.", scrollRegionBottom);
      } else {
        const lines = all.map((p) => {
          const icon = p.phase === "abandoned" ? "⬜" : p.phase === "done" ? "✅" : "●";
          const shortId = p.id.startsWith("plan-") ? p.id.slice(5) : p.id;
          return `  ${icon} ${shortId}  [${p.phase}] ${p.completedSubGoals}/${p.subGoalCount}  ${p.goal.slice(0, 55)}`;
        }).join("\n");
        printAssistantBlock(`Active plans (↑↓ to select, Enter to activate):\n${lines}`, scrollRegionBottom);
      }
      drawPrompt();
      return;
    }

    if (task.startsWith("/plan-active ")) {
      const idPart = task.slice(13).trim();
      const all = listPlanFiles(workspaceRoot);
      const match = all.find((p) => p.id === idPart || p.id.startsWith(idPart));
      if (!match) {
        printAssistantBlock(`Plan not found: ${idPart}\nType /plan-active to list plans.`, scrollRegionBottom);
      } else {
        try {
          const planData = loadPlanFile(workspaceRoot, match.id);
          if (!planData) {
            printAssistantBlock(`Plan file corrupted: ${match.id}`, scrollRegionBottom);
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

            drawModeBar(state);
            printAssistantBlock(
              `Plan activated: ${match.id.slice(5)}\n` +
              `Goal: ${match.goal}\n` +
              `Progress: ${match.completedSubGoals}/${match.subGoalCount}\n\n` +
              `Type anything to continue.`,
              scrollRegionBottom,
            );
          }
        } catch (e) {
          printAssistantBlock(`Failed to activate plan: ${String(e).slice(0, 100)}`, scrollRegionBottom);
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
            `Context compressed: ${beforeLen} → ${afterLen} messages\n` +
            `Token est.: ${fmtTokens(beforeCtx.estimatedTokens)} → ${fmtTokens(afterCtx.estimatedTokens)} ` +
            `(${beforeCtx.percentage}% → ${afterCtx.percentage}%)`,
            scrollRegionBottom,
          );
        } else {
          printAssistantBlock(
            `Context usage ${beforeCtx.percentage}%, below compression threshold (80%). No compression needed.`,
            scrollRegionBottom,
          );
        }
      } else {
        printAssistantBlock("No active session.", scrollRegionBottom);
      }
      drawPrompt();
      return;
    }

    // ── Task execution ──

    state.busy = true;
    updateScrollRegion();
    state.streaming = true;
    state.taskAbort = new AbortController();
    startStatusBar(state, statusBarDeps);
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
        write(color.red("chitu: ") + color.dim("thinking..."));
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
        write("\r" + ansi.clearLine + color.red("chitu: "));
        state.thinkingActive = false;
        streamOpened = true;
        state.printingAssistant = true;
      }

      if (!streamOpened) {
        beginOutputBlock();
        write(color.red("chitu: "));
        streamOpened = true;
        state.printingAssistant = true;
      }
      state.streamQueue += normalized;
      startStreamDrain(state);
    };

    // Redact API keys, secrets, and system noise from tool output
    const redactSecrets = (s: string | null | undefined): string => {
      if (!s && s !== "") return "(empty)";
      return s
        .replace(/sk-(?:ant-)?[a-zA-Z0-9_-]{20,}/g, "sk-***REDACTED***")
        .replace(/apiKey["\s:]+["']([^"']{10,})["']/gi, 'apiKey": "***REDACTED***"')
        .replace(/Bearer\s+[a-zA-Z0-9._-]{20,}/g, "Bearer ***REDACTED***")
        // Strip macOS system noise
        .split("\n").filter((l) => !l.includes("could not open directory") && !l.includes("Operation not permitted")).join("\n");
    };

    const onToolOutput = (toolName: string, output: string | null | undefined) => {
      resetWatchdog();
      const sanitized = redactSecrets(output);
      if (toolName === "phase") {
        if (!streamOpened) {
          beginOutputBlock();
          write(color.red("chitu: "));
          streamOpened = true;
          state.printingAssistant = true;
        }
        write(color.dim(sanitized) + "\n");
        return;
      }

      if (toolName === "expand_approval") {
        if (!streamOpened) {
          beginOutputBlock();
          write(color.red("chitu: "));
          streamOpened = true;
          state.printingAssistant = true;
        }
        try {
          const data = JSON.parse(sanitized);
          state.expandApproval = { paths: data.paths ?? [], reason: data.reason ?? "", selectedIndex: 0 };
          write("\n" + color.brightYellow("⚠ 边界扩展需要确认 — ") + color.brightWhite(`AI 想修改 ${(data.paths as string[]).length} 个额外文件`) + "\n");
          write(color.dim(`  文件: ${(data.paths as string[]).join(", ")}`) + "\n");
          write(color.dim(`  原因: ${data.reason ?? ""}`) + "\n\n");
        } catch { /* ignore parse errors */ }
        return;
      }

      if (toolName === "ask_user") {
        if (!streamOpened) {
          beginOutputBlock();
          streamOpened = true;
          state.printingAssistant = true;
        }
        write("\n" + color.brightYellow("⚠ AI 需要你的输入 — ") + color.brightWhite(sanitized) + "\n\n");
        return;
      }

      if (!streamOpened) {
        beginOutputBlock();
        write(color.red("chitu: "));
        streamOpened = true;
        state.printingAssistant = true;
      }
      const fileOpIcon = toolName === "write_file" ? "+" : toolName === "edit_file" ? "~" : toolName === "delete_file" ? "-" : "";
      // read-only tools: just a one-liner, no content dump
      if (!fileOpIcon) {
        write(color.dim(`  (${toolName})`) + "\n");
      } else {
        const headerColor = fileOpIcon ? color.yellow : color.dim;
        const lines = sanitized.split("\n");
        const maxLines = 15;
        const truncated = lines.length > maxLines;
        const displayLines = lines.slice(0, maxLines);
        write(headerColor(`── ${fileOpIcon} tool: ${toolName} · ${lines.length} lines ──`) + "\n");
        for (const line of displayLines) {
          write(color.dim("  ") + color.dim(line.slice(0, 200)) + "\n");
        }
        if (truncated) {
          write(color.dim(`  ... ${lines.length - maxLines} more lines not shown`) + "\n");
        }
      }
    };

    let lastResponse = "";

    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdogFired = false;
    const resetWatchdog = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogFired = false;
      watchdogTimer = setTimeout(() => {
        watchdogFired = true;
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
        // Show visible warning in TUI
        if (!streamOpened) { beginOutputBlock(); streamOpened = true; state.printingAssistant = true; }
        write("\n" + color.brightRed("⚠ 已 60 秒无工具调用，AI 可能卡住了。") + "\n");
        write(color.dim("  按 ESC 或 Ctrl+C 可中断当前任务，然后输入新指令。") + "\n\n");
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
      await waitForStreamDrain(state);
      state.streaming = false;
      stopStreamDrain(state);
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
        if (lastResponse) { printAssistantBlock(lastResponse, scrollRegionBottom); }
        else { printAssistantBlock("", scrollRegionBottom); }
      }

      if (state.session) {
        state.session.messages = currentAgent.getMessages();
        state.sessions.save(state.session);
      }
    } catch (e) {
      state.streaming = false;
      state.streamQueue = "";
      stopStreamDrain(state);
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
      stopStreamDrain(state);
      stopStatusBar(state, statusBarDeps);
      state.busy = false;
      state.streaming = false;
      state.printingAssistant = false;
      state.responseCodeBlock = false; state.codeBlockLang = "";
      state.taskAbort = null;
      state.pendingImages = [];
      updateScrollRegion();
      drawPrompt();

      // Process queued messages (user typed while busy)
      let queuedNext: { task: string } | null = null;
      if (state.messageQueue.length > 0) {
        const nextTask = state.messageQueue.shift()!;
        const { cleanText, imagePaths } = detectImages(nextTask);
        state.pendingImages = imagePaths;
        clearInputBox();
        beginOutputBlock();
        const taskLines = nextTask.split("\n");
        write(color.bold(color.white(`> ${taskLines[0] ?? ""}`)) + "\n");
        for (let i = 1; i < taskLines.length; i++) {
          write(color.bold(color.white(`  ${taskLines[i] ?? ""}`)) + "\n");
        }
        queuedNext = { task: cleanText };
      }

      // YunChang auto-continuation + auto-commit
      if (!queuedNext) {
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
              write(color.dim("  [auto] committed\n"));
            }
          } catch (e) {
            write(color.dim(`  [auto] commit failed: ${String(e).slice(0, 80)}\n`));
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
      } // end if (!queuedNext)

      if (queuedNext) {
        setImmediate(() => handleTask(queuedNext.task));
      }
    }
  };

  // ── Expand approval handler ──

  const handleExpandSelect = (approved: boolean) => {
    if (state.agent) {
      state.agent.pendingExpandApproved = approved;
    }
    state.expandApproval = null;
    state.inputBuffer = "";
    state.historyIndex = -1;
    state.historyDraft = "";
    clearInputBox();
    beginOutputBlock();
    write(color.dim(approved ? "  [Approved] boundary expanded." : "  [Denied] boundary expansion rejected.") + "\n");
    drawPrompt();
    setImmediate(() => handleTask("continue"));
  };

  // ── Input handlers ──

  const inputDeps: InputDeps = {
    drawPrompt,
    getHintMatches,
    clearInputBox,
    beginOutputBlock,
    updateScrollRegion,
    handleTask,
    cycleParadigm,
    detectImages,
    handleExpandSelect,
  };
  const inputHandlers: InputHandlers = createInputHandlers(state, inputDeps);
  const {
    handleHistoryUp, handleHistoryDown, handleUp, handleDown,
    handleBackspace, handleClearScreen, appendInputChunk,
    handleSubmit, consumeRawInput,
  } = inputHandlers;

  function cleanup() {
    if (state.cleanupDone) return;
    state.cleanupDone = true;

    state.taskAbort?.abort();
    state.taskAbort = null;

    if (state.agent) state.agent.abort();

    // Delete TUI session — TUI is ephemeral
    if (state.session) {
      try { state.sessions.delete(state.session.id); } catch { /* best effort */ }
    }
    // If running inside the Chitu project itself, purge runtime junk but keep installed tools
    try {
      const isChituProject = existsSync(join(workspaceRoot, "src", "agent.ts")) &&
                             existsSync(join(workspaceRoot, "dist", "index.js")) &&
                             existsSync(join(workspaceRoot, "src", "tui", "app.ts"));
      if (isChituProject) {
        const chituDir = join(workspaceRoot, ".chitu");
        if (existsSync(chituDir)) {
          // Runtime junk to purge — sessions, plans, context, memory, logs
          const transient = ["sessions", "plans", "memory", "context", "interfaces", "completions", "backups"];
          for (const name of transient) {
            const p = join(chituDir, name);
            try { if (existsSync(p)) rmSync(p, { recursive: true, force: true }); } catch { /* skip */ }
          }
          // Transient files
          for (const name of ["paradigm.json", "checkpoint.json", "watchdog.json", "soul.md"]) {
            const p = join(chituDir, name);
            try { if (existsSync(p)) rmSync(p, { force: true }); } catch { /* skip */ }
          }
          // KEEP: config.json (MCP), skills/, mcp-servers/
        }
      }
    } catch { /* best effort */ }

    stopStreamDrain(state);
    stopStatusBar(state, statusBarDeps);
    state.decoder.end();
    disableRawMode();
    write(ansi.bracketedPasteOff);
    if (!isVSCodeTerminal()) resetScrollRegion();
    write(ansi.showCursor);
    write("\n\n" + color.dim("  Chitu stopped. Goodbye.") + "\n\n");

    mcpLoader.stopAll().catch((e) => { logger.warn("MCP stopAll failed", { error: String(e) }); });
  }

  // Register signal handlers before the event loop
  process.on("SIGINT", () => { state.running = false; cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { state.running = false; cleanup(); process.exit(0); });

  // ── Event loop ──

  process.stdin.on("data", (buf: Buffer) => {
    state.pendingRawInput += state.decoder.write(buf);
    consumeRawInput();
  });

  drawPrompt();
  drawStatusBarWrapped();

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!state.running) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });

  cleanup();
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
}
