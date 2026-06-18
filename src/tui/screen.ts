// ANSI terminal control — raw mode, cursor, colors, drawing
import * as readline from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

// --- ANSI escape sequences ---

export const CSI = "\x1b[";

export const ansi = {
  clear: `${CSI}2J`,
  clearLine: `${CSI}2K`,
  clearToEnd: `${CSI}0J`,
  moveTo: (row: number, col: number) => `${CSI}${row + 1};${col + 1}H`,  // ANSI cursor is 1-based
  moveUp: (n: number) => `${CSI}${n}A`,
  moveDown: (n: number) => `${CSI}${n}B`,
  moveRight: (n: number) => `${CSI}${n}C`,
  moveLeft: (n: number) => `${CSI}${n}D`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  bracketedPasteOn: `${CSI}?2004h`,
  bracketedPasteOff: `${CSI}?2004l`,
  saveCursor: `\x1b7`,   // DECSC — more reliable than ANSI CSI s inside scroll regions
  restoreCursor: `\x1b8`, // DECRC — restores cursor position saved by DECSC
  saveCursorANSI: `${CSI}s`,   // CSI s — ANSI standard, more portable
  restoreCursorANSI: `${CSI}u`, // CSI u — ANSI standard
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  underline: `${CSI}4m`,
  reset: `${CSI}0m`,
};

// --- 8-bit color shortcuts ---

export const color = {
  red: (text: string) => `\x1b[31m${text}\x1b[0m`,
  green: (text: string) => `\x1b[32m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
  blue: (text: string) => `\x1b[34m${text}\x1b[0m`,
  magenta: (text: string) => `\x1b[35m${text}\x1b[0m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
  white: (text: string) => `\x1b[37m${text}\x1b[0m`,
  gray: (text: string) => `\x1b[90m${text}\x1b[0m`,
  dim: (text: string) => `\x1b[2m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  brightRed: (text: string) => `\x1b[91m\x1b[1m${text}\x1b[0m`,
  brightYellow: (text: string) => `\x1b[93m\x1b[1m${text}\x1b[0m`,
  brightWhite: (text: string) => `\x1b[97m\x1b[1m${text}\x1b[0m`,
  bgRed: (text: string) => `\x1b[48;5;52m\x1b[37m${text}\x1b[0m`,
  bgGreen: (text: string) => `\x1b[48;5;22m\x1b[37m${text}\x1b[0m`,
  bgGray: (text: string) => `\x1b[48;5;235m\x1b[37m${text}\x1b[0m`,
};

// --- Terminal detection ---

export function isVSCodeTerminal(): boolean {
  return process.env.TERM_PROGRAM === "vscode" ||
         process.env.TERM_PROGRAM === "vscode-terminal";
}

// --- Terminal size ---

export function getTermSize(): { cols: number; rows: number } {
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;
  return {
    cols: Number.isFinite(cols) && cols > 0 ? cols : 80,
    rows: Number.isFinite(rows) && rows > 0 ? rows : 24,
  };
}

// --- Raw mode ---

let rawMode = false;

export function enableRawMode(stream: ReadStream | WriteStream = process.stdin): void {
  if (rawMode) return;
  if ("setRawMode" in stream && typeof stream.setRawMode === "function") {
    stream.setRawMode(true);
  }
  rawMode = true;
}

export function disableRawMode(stream: ReadStream | WriteStream = process.stdin): void {
  if (!rawMode) return;
  if ("setRawMode" in stream && typeof stream.setRawMode === "function") {
    stream.setRawMode(false);
  }
  rawMode = false;
}

// --- Output helpers ---

export function write(text: string): void {
  process.stdout.write(text);
}

export function clearScreen(): void {
  write(ansi.clear);
  write(ansi.moveTo(0, 0));
}

export function drawHR(cols: number, char = "─"): string {
  return color.dim(char.repeat(cols));
}

// --- Scroll region ---
// ANSI scroll region: CSI top;bottom r (1-based, inclusive).
// Constrains scrolling (newlines, scroll-up/down) to this range.
// Content outside the region stays fixed — used for status bars etc.

export function setScrollRegion(top: number, bottom: number): void {
  write(`${CSI}${top};${bottom}r`);
}

export function resetScrollRegion(): void {
  write(`${CSI}r`); // CSI r with no args resets to full screen
}

// --- Read key ---

export function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (buf: Buffer) => {
      process.stdin.removeListener("data", onData);
      resolve(buf.toString());
    };
    process.stdin.on("data", onData);
  });
}

// --- Spinner ---

const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(index: number): string {
  return SPIN_FRAMES[index % SPIN_FRAMES.length]!;
}

// --- Syntax highlighting ---

const SYN: Record<string, string> = {
  keyword: "\x1b[35m",  // magenta
  string: "\x1b[32m",   // green
  comment: "\x1b[90m",  // gray
  number: "\x1b[33m",   // yellow
  type: "\x1b[36m",     // cyan
};

export const BG_RED_BASE = "\x1b[48;5;52m\x1b[37m";
export const BG_GREEN_BASE = "\x1b[48;5;22m\x1b[37m";
export const BG_GRAY_BASE = "\x1b[48;5;235m\x1b[37m";

const JS_KEYWORDS = new Set([
  "const", "let", "var", "function", "class", "if", "else", "return",
  "import", "export", "from", "async", "await", "try", "catch", "throw",
  "new", "this", "type", "interface", "enum", "extends", "implements",
  "for", "while", "do", "switch", "case", "break", "continue", "default",
  "yield", "of", "in", "typeof", "instanceof", "void", "never", "any",
  "unknown", "boolean", "string", "number", "null", "undefined", "true", "false",
  "static", "public", "private", "protected", "readonly", "abstract",
  "get", "set", "as", "is", "keyof", "infer", "declare", "module",
  "namespace", "require", "assert", "asserts", "satisfies",
]);

const TOKEN_RE = /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|(`(?:[^`\\]|\\.)*`)|([a-zA-Z_$][a-zA-Z0-9_$]*)|(\d+(?:\.\d+)?)/g;

export function highlightLine(line: string, opts?: { bg?: "red" | "green" | "gray"; fullWidth?: boolean; prefix?: string; indent?: number }): string {
  const bgOpen = opts?.bg === "green" ? BG_GREEN_BASE
    : opts?.bg === "red" ? BG_RED_BASE
    : opts?.bg === "gray" ? BG_GRAY_BASE
    : "";
  const baseReset = bgOpen || "\x1b[0m";

  // For full-width background, strip trailing \n — caller adds \x1b[K\x1b[0m\n
  let content = line;
  if (opts?.fullWidth && bgOpen && content.endsWith("\n")) {
    content = content.slice(0, -1);
  }

  let result = bgOpen + (opts?.prefix ?? "") + " ".repeat(opts?.indent ?? 0);
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(content)) !== null) {
    result += content.slice(lastIdx, match.index);
    const text = match[0];

    if (match[1] || match[2]) {
      result += SYN.comment + text + baseReset;
    } else if (match[3] || match[4] || match[5]) {
      result += SYN.string + text + baseReset;
    } else if (match[6]) {
      if (JS_KEYWORDS.has(text)) {
        result += SYN.keyword + text + baseReset;
      } else if (/^[A-Z]/.test(text)) {
        result += SYN.type + text + baseReset;
      } else {
        result += text;
      }
    } else if (match[7]) {
      result += SYN.number + text + baseReset;
    } else {
      result += text;
    }

    lastIdx = match.index + text.length;
  }

  result += content.slice(lastIdx);
  // fullWidth: leave bg open for \x1b[K to fill the rest of the line
  if (bgOpen && !opts?.fullWidth) result += "\x1b[0m";
  return result;
}
