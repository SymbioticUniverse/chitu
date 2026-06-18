import { readFileSync, readdirSync } from "node:fs";
import { existsSync, mkdirSync, writeFileSync, readFileSync as fsRead, unlinkSync } from "node:fs";
import { join as pathJoin } from "node:path";
import * as path from "node:path";
import * as fs from "node:fs";
import type { Message } from "../types.js";
import { getContentText } from "../types.js";

// ── Constants ──

export const SYSTEM_PROMPT = `You are Chitu (赤兔), a terminal-based AI agent. You help users with software engineering tasks.

## Your capabilities
- Read, write, edit, and delete files (guarded by Horsewhip boundary lock)
- Execute shell commands
- Search the web and fetch URLs
- Manage tasks and track progress
- Remember information across sessions
- Load MCP servers and skills

## Working principles
- Be concise and direct in your responses
- Use tools proactively to complete tasks
- When a task is done, summarize what was accomplished
- If you encounter a boundary block (Horsewhip), explain what needs to be unlocked
- Prefer creating new files over modifying existing ones

## Output format
When you complete a task, end with a brief summary. Don't narrate your internal process — just state results.`;

export const MAX_CONTEXT_TOKENS = 80000;
export const COMPRESS_THRESHOLD = 0.8;
export const MAX_PHASED_ROUNDS = 5;
export const PATH_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_./\\-]*$/;

export const PROGRESS_NOTE = [
  "## Progress Reporting",
  "Call `report_progress` when you enter a new working phase to keep the user informed.",
  "The `message` parameter describes your current phase, e.g.:",
  '  report_progress({ message: "Clarify：澄清需求 — 第1轮" })',
  '  report_progress({ message: "Grow：生成记账页面" })',
  '  report_progress({ message: "Trim：修正耦合指标" })',
  "Use concise Chinese. The message will be shown directly to the user as a progress indicator.",
].join("\n");

// ── Token estimation ──

/** CJK-aware token estimation. CJK chars ≈1.5 tokens, ASCII ≈0.25 tokens. */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4E00 && code <= 0x9FFF) {
      tokens += 1.5; // CJK Unified Ideographs
    } else if (code >= 0x3400 && code <= 0x4DBF) {
      tokens += 1.5; // CJK Extension A
    } else if (code >= 0x20000 && code <= 0x2A6DF) {
      tokens += 1.5; // CJK Extension B
    } else if (code >= 0x3000 && code <= 0x303F) {
      tokens += 1; // CJK punctuation
    } else if (code >= 0xFF00 && code <= 0xFFEF) {
      tokens += 1; // Fullwidth forms
    } else if (code >= 0x80) {
      tokens += 1; // Other non-ASCII
    } else if (code === 0x20) {
      tokens += 0;
    } else {
      tokens += 0.25; // ASCII
    }
  }
  return Math.ceil(tokens);
}

// ── User content builder ──

/** Build user message content — text only, or text + images if image paths given. */
export function buildUserContent(
  text: string,
  imagePaths?: string[],
): string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> {
  if (!imagePaths || imagePaths.length === 0) return text;

  const blocks: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
  if (text) blocks.push({ type: "text", text });

  for (const p of imagePaths) {
    try {
      const buf = readFileSync(p);
      const ext = (p.split(".").pop() ?? "png").toLowerCase();
      const mime = ext === "jpg" ? "jpeg" : ext;
      blocks.push({ type: "image_url", image_url: { url: `data:image/${mime};base64,${buf.toString("base64")}` } });
    } catch { /* skip */ }
  }

  return blocks;
}

// ── Context usage ──

export function getContextUsage(messages: Message[]): { estimatedTokens: number; maxTokens: number; percentage: number } {
  let totalChars = 0;
  for (const m of messages) {
    totalChars += (m.content?.length ?? 0) + 200;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        totalChars += tc.function?.arguments?.length ?? 0;
      }
    }
  }
  const estimatedTokens = Math.ceil(totalChars / 4);
  return {
    estimatedTokens,
    maxTokens: MAX_CONTEXT_TOKENS,
    percentage: Math.round((estimatedTokens / MAX_CONTEXT_TOKENS) * 100),
  };
}

export function getContextCharCount(messages: Message[]): number {
  let totalChars = 0;
  for (const m of messages) {
    totalChars += (m.content?.length ?? 0) + 200;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        totalChars += tc.function?.arguments?.length ?? 0;
      }
    }
  }
  return totalChars;
}

// ── Checkpoint management ──

export function writeCheckpoint(workspaceRoot: string, messages: Message[], reason: string): void {
  try {
    const dir = path.join(workspaceRoot, ".chitu");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const cpFile = path.join(dir, "checkpoint.json");
    const userMsg = messages.find((m) => m.role === "user");
    fs.writeFileSync(cpFile, JSON.stringify({
      task: userMsg ? getContentText(userMsg.content) : "",
      reason,
      messages: messages.slice(-20),
      savedAt: new Date().toISOString(),
    }, null, 2), "utf-8");
  } catch { /* best-effort */ }
}

export function loadCheckpoint(workspaceRoot: string): { task: string; reason: string; messages: Message[] } | null {
  try {
    const cpFile = path.join(workspaceRoot, ".chitu", "checkpoint.json");
    if (!fs.existsSync(cpFile)) return null;
    const data = JSON.parse(fs.readFileSync(cpFile, "utf-8"));
    if (!data || !data.messages) return null;
    return { task: data.task ?? "", reason: data.reason ?? "unknown", messages: data.messages };
  } catch { return null; }
}

export function deleteCheckpoint(workspaceRoot: string): void {
  try {
    const cpFile = path.join(workspaceRoot, ".chitu", "checkpoint.json");
    if (fs.existsSync(cpFile)) fs.unlinkSync(cpFile);
  } catch { /* ok */ }
}

// ── Source file counting ──

export function countSourceFiles(workspaceRoot: string): number {
  let count = 0;
  try {
    const MAX_DEPTH = 4;
    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_DEPTH) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        if (entry.isDirectory()) { walk(pathJoin(dir, entry.name), depth + 1); }
        else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) { count++; }
      }
    };
    walk(workspaceRoot, 0);
  } catch { /* ignore */ }
  return count;
}

// ── Extraction helpers ──

export function extractBlockedFiles(text: string): string[] {
  const re = /BLOCKED by Horsewhip[:.].*?File:\s*(\S+)/gi;
  const files: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) files.push(m[1]);
  }
  return [...new Set(files)];
}

export function detectTestFailure(text: string): boolean {
  const failRe = /(?:FAIL|FAILED|failed|\d+ failing|Test (?:failed|error)|AssertionError|assert\.\w+ failed)/i;
  const noTestRe = /no tests? (?:configured|found|specified)/i;
  return failRe.test(text) && !noTestRe.test(text);
}

export function extractNewFiles(text: string): string[] {
  const files: string[] = [];
  const patterns = [
    /(?:created|wrote|new file)[:\s]+(\S+\.(?:ts|js|tsx|jsx|json|md|css|html))/gi,
    /Wrote (?:contents )?to (\S+)/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[1]) files.push(m[1]);
    }
  }
  return [...new Set(files)];
}

export function extractAllTouchedFiles(text: string): string[] {
  const files: string[] = [];
  const re = /(?:reading|editing|modifying|opening|writing)\s+["']?(\S+\.(?:ts|js|tsx|jsx|json|md|css|html))["']?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) files.push(m[1]);
  }
  return [...new Set(files)];
}

export function isValidPath(s: string): boolean {
  return PATH_RE.test(s) && s.includes(".");
}

export function extractFilePaths(text: string): string[] {
  const paths: string[] = [];
  const re = /(?:^|\s)(\.{0,2}\/)?(?:[\w-]+\/)*[\w-]+\.(?:ts|js|tsx|jsx|json|css|html|md|py|go|rs|java|rb)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[0].trim();
    if (p && !paths.includes(p)) paths.push(p);
  }
  return paths;
}

// ── anySignal helper ──

export function anySignal(signals: AbortSignal[]): AbortSignal {
  // Use native AbortSignal.any() if available (Node 20.3+), which handles
  // listener cleanup properly and avoids MaxListenersExceededWarning.
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any(signals);
  }
  // Fallback for older Node versions
  const controller = new AbortController();
  const cleanup = () => {
    for (const { sig, fn } of listeners) sig.removeEventListener("abort", fn);
    listeners.length = 0;
  };
  const listeners: Array<{ sig: AbortSignal; fn: () => void }> = [];
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    const fn = () => { controller.abort(sig.reason); cleanup(); };
    listeners.push({ sig, fn });
    sig.addEventListener("abort", fn, { once: true });
  }
  return controller.signal;
}
