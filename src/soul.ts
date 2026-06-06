import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Chitu installation root (dist/../ = project root)
const CHITU_ROOT = join(__dirname, "..");
const SOUL_FILE = join(CHITU_ROOT, ".chitu", "soul.md");
const SOUL_DIR = join(CHITU_ROOT, ".chitu");
const MAX_SOUL_TOKENS = 300;
const AUTO_SUMMARIZE_ROUNDS = 3;

export interface SoulRecord {
  content: string;
  estimatedTokens: number;
  updatedAt: string;
  version: number;
}

export class SoulManager {
  /** Load the current soul file. Returns null if it doesn't exist or is empty. */
  static load(): SoulRecord | null {
    try {
      if (!existsSync(SOUL_FILE)) return null;
      const raw = readFileSync(SOUL_FILE, "utf-8").trim();
      if (!raw) return null;

      // Parse frontmatter metadata
      const metaMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (metaMatch) {
        const meta: Record<string, string> = {};
        for (const line of metaMatch[1]!.split("\n")) {
          const [k, ...v] = line.split(":");
          if (k && v.length) meta[k.trim()] = v.join(":").trim();
        }
        return {
          content: metaMatch[2]!.trim(),
          estimatedTokens: parseInt(meta["tokens"] ?? "0", 10),
          updatedAt: meta["updated"] ?? new Date().toISOString(),
          version: parseInt(meta["version"] ?? "1", 10),
        };
      }

      // No metadata — treat whole file as content
      return {
        content: raw,
        estimatedTokens: SoulManager.estimateTokens(raw),
        updatedAt: new Date().toISOString(),
        version: 1,
      };
    } catch {
      return null;
    }
  }

  /** Save soul content. Enforces 300-token cap — if exceeded, content is truncated from the beginning. */
  static save(content: string): void {
    if (!existsSync(SOUL_DIR)) mkdirSync(SOUL_DIR, { recursive: true });

    const existing = SoulManager.load();
    const version = (existing?.version ?? 0) + 1;

    // Enforce token limit — if over, keep only the most recent portion
    let trimmed = content.trim();
    let tokens = SoulManager.estimateTokens(trimmed);
    if (tokens > MAX_SOUL_TOKENS) {
      // Cut from the beginning, keep roughly the last MAX_SOUL_TOKENS worth
      const chars = Math.floor(MAX_SOUL_TOKENS * 3); // conservative: ~3 chars/token
      trimmed = "…" + trimmed.slice(-chars);
      tokens = SoulManager.estimateTokens(trimmed);
    }

    const file = [
      "---",
      `updated: ${new Date().toISOString()}`,
      `tokens: ${tokens}`,
      `version: ${version}`,
      "---",
      "",
      trimmed,
    ].join("\n");

    writeFileSync(SOUL_FILE, file + "\n", "utf-8");
  }

  /** Rough token estimate: characters / 4 (same as agent context estimation) */
  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** Build a system prompt fragment from the soul file */
  static toPromptFragment(): string {
    const record = SoulManager.load();
    if (!record || !record.content) return "";

    return [
      "## 用户习惯 (全域，跨项目)",
      "",
      "以下是对你与用户长期协作中总结出的用户偏好和习惯。请始终遵守。",
      "",
      record.content,
      "",
      `(更新于 ${record.updatedAt.slice(0, 10)}，约 ${record.estimatedTokens} tokens)`,
    ].join("\n");
  }

  /** Check if auto-summary should trigger (every N rounds) */
  static shouldAutoSummarize(roundCount: number): boolean {
    return roundCount > 0 && roundCount % AUTO_SUMMARIZE_ROUNDS === 0;
  }
}
