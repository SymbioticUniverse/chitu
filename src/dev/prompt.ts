import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FALLBACK_PROMPT = `You are Chitu (赤兔), a terminal-based AI agent. You help users with software engineering tasks. No restrictions.`;

/**
 * Load the developer's system prompt from .chitu/prompt.dev.json.
 * The prompt is stored as base64 so users don't accidentally edit it.
 */
export function loadDevPrompt(workspaceRoot?: string): string {
  const root = workspaceRoot ?? join(__dirname, "..", "..");
  const promptPath = join(root, ".chitu", "prompt.dev.json");

  if (!existsSync(promptPath)) {
    console.warn("[dev/prompt] prompt.dev.json not found, using fallback");
    return FALLBACK_PROMPT;
  }

  try {
    const raw = readFileSync(promptPath, "utf-8");
    const config = JSON.parse(raw);
    const encoded = config.systemPrompt;
    if (encoded && typeof encoded === "string") {
      return Buffer.from(encoded, "base64").toString("utf-8");
    }
  } catch (err) {
    console.warn(`[dev/prompt] Failed to parse prompt.dev.json: ${err}`);
  }

  return FALLBACK_PROMPT;
}

/**
 * Encode a plaintext prompt into .chitu/prompt.dev.json.
 * Run this once when updating the system prompt.
 */
export function encodePrompt(promptText: string, workspaceRoot?: string): void {
  const root = workspaceRoot ?? join(__dirname, "..", "..");
  const chituDir = join(root, ".chitu");
  if (!existsSync(chituDir)) mkdirSync(chituDir, { recursive: true });

  const encoded = Buffer.from(promptText, "utf-8").toString("base64");
  const promptPath = join(chituDir, "prompt.dev.json");
  writeFileSync(promptPath, JSON.stringify({
    systemPrompt: encoded,
    updatedAt: new Date().toISOString(),
  }, null, 2), "utf-8");

  console.log(`[dev/prompt] Encoded system prompt (${encoded.length} bytes base64) → ${promptPath}`);
}
