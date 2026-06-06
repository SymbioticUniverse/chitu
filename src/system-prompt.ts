import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const FALLBACK_PROMPT = `You are Chitu (赤兔), a terminal AI agent. Be concise and direct. Use tools to complete tasks.`;

export interface ProjectConfig {
  techStack?: Record<string, string>;
  architecture?: Record<string, string>;
  keyFiles?: {
    core?: string[];
    adaptive?: string[];
    rollback?: string[];
  };
  metrics?: Record<string, { limit: number; description: string }>;
  skillsPath?: string;
  commandsPath?: string;
  mcpServers?: Record<string, unknown>;
}

function loadPromptFile(name: string): string {
  const p = join(__dirname, "prompts", name);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf-8").trim();
}

export function loadConfig(): ProjectConfig {
  try {
    const root = join(__dirname, "..");
    const configPath = join(root, ".chitu", "config.json");
    if (!existsSync(configPath)) return {};
    return JSON.parse(readFileSync(configPath, "utf-8")) as ProjectConfig;
  } catch {
    return {};
  }
}

function configToPromptAppendix(config: ProjectConfig): string {
  const parts: string[] = [];
  if (config.techStack) {
    parts.push("## Tech stack");
    for (const [k, v] of Object.entries(config.techStack)) parts.push(`- ${k}: ${v}`);
    parts.push("");
  }
  if (config.architecture) {
    parts.push("## Architecture");
    for (const [k, v] of Object.entries(config.architecture)) {
      parts.push(`### ${k}`); parts.push(v); parts.push("");
    }
  }
  if (config.keyFiles) {
    parts.push("## Key files");
    for (const [cat, files] of Object.entries(config.keyFiles)) {
      if (files?.length) { for (const f of files) parts.push(`- ${f}`); parts.push(""); }
    }
  }
  return parts.join("\n");
}

/**
 * Load the full system prompt. All modules always loaded — boundary determinism
 * over token micro-optimization.
 *
 * Layers:
 *   1. base.md        — identity, discipline, output rules
 *   2. engineering.md — architecture, workflow, metrics
 *   3. company.md     — company/product info
 *   4. <workspace>/.chitu/CHITU.md — user project rules
 *   5. <chitu>/.chitu/soul.md      — cross-project user habits
 *   6. .chitu/config.json appendix  — techStack, architecture, keyFiles
 */
export function loadSystemPrompt(workspaceRoot?: string): string {
  try {
    const parts: string[] = [];

    // Layer 1: Base — always loaded
    const base = loadPromptFile("base.md");
    parts.push(base || loadDevFallback());

    // Layer 2: Engineering — always loaded
    const eng = loadPromptFile("engineering.md");
    if (eng) parts.push(eng);

    // Layer 3: Company — always loaded
    const company = loadPromptFile("company.md");
    if (company) parts.push(company);

    // Layer 4: User project rules
    if (workspaceRoot) {
      const userPath = join(workspaceRoot, ".chitu", "CHITU.md");
      if (existsSync(userPath)) {
        const userContent = readFileSync(userPath, "utf-8").trim();
        if (userContent) parts.push("---\n# 用户项目规则\n\n" + userContent);
      }
    }

    // Layer 5: Soul (cross-project)
    try {
      const soulPath = join(__dirname, "..", ".chitu", "soul.md");
      if (existsSync(soulPath)) {
        const soulRaw = readFileSync(soulPath, "utf-8");
        const soulMatch = soulRaw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
        if (soulMatch && soulMatch[1]?.trim()) {
          parts.push("## 用户习惯\n\n" + soulMatch[1].trim());
        }
      }
    } catch { /* skip */ }

    // Layer 6: Config appendix
    const config = loadConfig();
    const appendix = configToPromptAppendix(config);
    if (appendix) parts.push(appendix);

    return parts.join("\n\n") || FALLBACK_PROMPT;
  } catch {
    return FALLBACK_PROMPT;
  }
}

/** Estimate token count from text (char/4). Used for baseline calculation. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Fallback: try base64-encoded prompt for backward compat, or use hardcoded fallback */
function loadDevFallback(): string {
  try {
    const promptPath = join(__dirname, "..", ".chitu", "prompt.dev.json");
    if (existsSync(promptPath)) {
      const raw = readFileSync(promptPath, "utf-8");
      const encoded = JSON.parse(raw).systemPrompt;
      if (encoded) return Buffer.from(encoded, "base64").toString("utf-8");
    }
  } catch { /* skip */ }
  return FALLBACK_PROMPT;
}

export function loadProjectConfig(): ProjectConfig {
  return loadConfig();
}
