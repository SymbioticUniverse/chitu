/**
 * input.ts — Input handling
 *
 * Extracted from app.ts startTUI closure.
 * Handles raw input consumption, history navigation, paste,
 * key bindings, and submit logic.
 */
import type { TUIState, HintItem } from "./state.js";
import { BRACKETED_PASTE_START, BRACKETED_PASTE_END } from "./state.js";
import { write, color, ansi } from "./screen.js";

// ── Pure text sanitization ──

export function sanitizeInputChunk(chunk: string): string {
  return chunk
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}

// ── Dependency interface ──

export interface InputDeps {
  drawPrompt: (returnToScrollArea?: boolean) => void;
  getHintMatches: () => HintItem[];
  clearInputBox: () => void;
  beginOutputBlock: () => void;
  updateScrollRegion: () => void;
  handleTask: (task: string) => void;
  cycleParadigm: () => void;
  detectImages: (task: string) => { cleanText: string; imagePaths: string[] };
  handleExpandSelect: (approved: boolean) => void;
  cleanup: () => void;
}

// ── Handler collection ──

export interface InputHandlers {
  handleHistoryUp: () => void;
  handleHistoryDown: () => void;
  handleUp: () => void;
  handleDown: () => void;
  handleBackspace: () => void;
  handleClearScreen: () => void;
  appendInputChunk: (chunk: string) => void;
  handleSubmit: () => void;
  consumeRawInput: () => void;
}

// ── Factory ──

export function createInputHandlers(
  state: TUIState,
  deps: InputDeps,
): InputHandlers {
  const {
    drawPrompt,
    getHintMatches,
    clearInputBox,
    beginOutputBlock,
    updateScrollRegion,
    handleTask,
    cycleParadigm,
    detectImages,
  } = deps;

  // ── History ──

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

  // ── Directional (hint-aware) ──

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

  // ── Editing ──

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

  // ── Submit ──

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

    if (raw.length === 0) {
      state.inputBuffer = "";
      state.historyIndex = -1;
      state.historyDraft = "";
      drawPrompt();
      return;
    }

    // Queue message if busy (LLM is working)
    if (state.busy) {
      state.messageQueue.push(raw);
      state.inputBuffer = "";
      state.historyIndex = -1;
      state.historyDraft = "";
      clearInputBox();
      drawPrompt();
      const n = state.messageQueue.length;
      write(color.dim(`\n  ⏳ Queued (${n} message${n > 1 ? "s" : ""} waiting...)`) + "\n");
      return;
    }

    state.inputBuffer = "";
    state.historyIndex = -1;
    state.historyDraft = "";
    if ((state.inputHistory.length === 0 || state.inputHistory[state.inputHistory.length - 1] !== raw) && raw.trim().length > 0) {
      state.inputHistory.push(raw);
    }

    const { cleanText, imagePaths } = detectImages(raw);
    state.pendingImages = imagePaths;

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

  // ── Raw input consumer (state machine) ──

  const consumeRawInput = () => {
    // Expand approval selection mode — intercept arrow keys + enter
    if (state.expandApproval) {
      while (state.pendingRawInput.length > 0) {
        if (state.pendingRawInput.startsWith("\x1b[A")) {
          state.pendingRawInput = state.pendingRawInput.slice(3);
          state.expandApproval.selectedIndex = 0;
          deps.drawPrompt();
          continue;
        }
        if (state.pendingRawInput.startsWith("\x1b[B")) {
          state.pendingRawInput = state.pendingRawInput.slice(3);
          state.expandApproval.selectedIndex = 1;
          deps.drawPrompt();
          continue;
        }
        if (state.pendingRawInput[0] === "\r" || state.pendingRawInput[0] === "\n") {
          state.pendingRawInput = state.pendingRawInput.slice(state.pendingRawInput[1] === "\n" ? 2 : 1);
          const approved = state.expandApproval.selectedIndex === 0;
          deps.handleExpandSelect(approved);
          return;
        }
        if (state.pendingRawInput[0] === "\x03" || state.pendingRawInput[0] === "\x1b") {
          state.pendingRawInput = state.pendingRawInput.slice(1);
          deps.handleExpandSelect(false);
          return;
        }
        // y/Y = approve, n/N = deny
        const ch = state.pendingRawInput[0];
        if (ch === "y" || ch === "Y") {
          state.pendingRawInput = state.pendingRawInput.slice(1);
          deps.handleExpandSelect(true);
          return;
        }
        if (ch === "n" || ch === "N") {
          state.pendingRawInput = state.pendingRawInput.slice(1);
          deps.handleExpandSelect(false);
          return;
        }
        // Discard other input while in selection mode
        const cp = state.pendingRawInput.codePointAt(0)!;
        state.pendingRawInput = state.pendingRawInput.slice(cp > 0xFFFF ? 2 : 1);
      }
      return;
    }

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
        if (state.busy) {
          state.taskAbort?.abort();
          continue;
        }
        state.running = false;
        deps.cleanup();
        process.exit(0);
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
        appendInputChunk("\n");
        drawPrompt();
        continue;
      }
      if (state.pendingRawInput[0] === "\x1b") {
        state.pendingRawInput = state.pendingRawInput.slice(1);
        if (state.busy || state.streaming) state.taskAbort?.abort();
        continue;
      }
      if (state.pendingRawInput[0] === "\x7f" || state.pendingRawInput[0] === "\b") {
        state.pendingRawInput = state.pendingRawInput.slice(1);
        handleBackspace();
        continue;
      }
      if (state.pendingRawInput[0] === "\r") {
        if (state.pendingRawInput[1] === "\n") {
          state.pendingRawInput = state.pendingRawInput.slice(2);
        } else {
          state.pendingRawInput = state.pendingRawInput.slice(1);
        }
        // Always handle /quit and /exit, even when busy
        const raw = state.inputBuffer.replace(/\r/g, "").trim();
        if (raw === "/quit" || raw === "/exit") {
          state.running = false;
          return;
        }
        handleSubmit();
        continue;
      }
      if (state.pendingRawInput[0] === "\n") {
        state.pendingRawInput = state.pendingRawInput.slice(1);
        appendInputChunk("\n");
        drawPrompt();
        continue;
      }

      const cp = state.pendingRawInput.codePointAt(0)!;
      const ch = String.fromCodePoint(cp);
      state.pendingRawInput = state.pendingRawInput.slice(cp > 0xFFFF ? 2 : 1);
      appendInputChunk(sanitizeInputChunk(ch));
      drawPrompt();
    }
  };

  return {
    handleHistoryUp,
    handleHistoryDown,
    handleUp,
    handleDown,
    handleBackspace,
    handleClearScreen,
    appendInputChunk,
    handleSubmit,
    consumeRawInput,
  };
}
