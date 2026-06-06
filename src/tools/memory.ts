import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolContext, ToolHandler, MemoryEntry } from "../types.js";

function getMemoryDir(root: string): string {
  const dir = path.join(root, ".chitu", "memory");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getIndexPath(memDir: string): string {
  return path.join(memDir, "MEMORY.md");
}

function readIndex(memDir: string): string[] {
  const indexPath = getIndexPath(memDir);
  if (!fs.existsSync(indexPath)) return [];
  return fs.readFileSync(indexPath, "utf-8").split("\n").filter(Boolean);
}

function writeIndex(memDir: string, lines: string[]): void {
  fs.writeFileSync(getIndexPath(memDir), lines.join("\n") + "\n", "utf-8");
}

const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function memoryPath(memDir: string, name: string): string {
  if (!SAFE_NAME_RE.test(name) || name.length > 64) {
    throw new Error(`Invalid memory name: "${name}". Use kebab-case.`);
  }
  return path.join(memDir, `${name}.md`);
}

function sanitizeYaml(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export function createMemoryTools(ctx: ToolContext): Record<string, ToolHandler> {
  const memDir = getMemoryDir(ctx.workspaceRoot);

  return {
    memory_save: async (args) => {
      const entryType = args["type"] as MemoryEntry["type"];
      const name = args["name"] as string;
      const description = args["description"] as string;
      const content = args["content"] as string;

      if (!SAFE_NAME_RE.test(name) || name.length > 64) {
        return `Error: invalid memory name "${name}". Use kebab-case (a-z, 0-9, -, _).`;
      }

      const now = new Date().toISOString();
      const frontmatter = [
        "---",
        `name: ${sanitizeYaml(name)}`,
        `description: ${sanitizeYaml(description)}`,
        `metadata:`,
        `  type: ${sanitizeYaml(entryType)}`,
        `  createdAt: ${now}`,
        "---",
      ].join("\n");

      const fullContent = `${frontmatter}\n\n${content}\n`;
      fs.writeFileSync(memoryPath(memDir, name), fullContent, "utf-8");

      // Update index
      const index = readIndex(memDir);
      const entry = `- [${name}](${name}.md) — ${description}`;
      const existingIdx = index.findIndex((l) => l.includes(`(${name}.md)`));
      if (existingIdx >= 0) {
        index[existingIdx] = entry;
      } else {
        index.push(entry);
      }
      writeIndex(memDir, index);

      return `Memory saved: ${name}`;
    },

    memory_recall: async (args) => {
      const query = (args["query"] as string)?.toLowerCase() ?? "";
      const filterType = args["type"] as string | undefined;

      const results: string[] = [];
      const index = readIndex(memDir);

      for (const line of index) {
        if (query && !line.toLowerCase().includes(query)) continue;

        const match = line.match(/- \[(.+?)\]\((.+?)\)/);
        if (!match) continue;
        const [, entryName, fileName] = match;
        // Prevent path traversal via index poisoning
        if (!fileName || !SAFE_NAME_RE.test(fileName.replace(/\.md$/, ""))) continue;
        const filePath = path.join(memDir, fileName);

        if (fs.existsSync(filePath)) {
          const fileContent = fs.readFileSync(filePath, "utf-8");

          if (filterType) {
            const typeMatch = fileContent.match(/type:\s*(\w+)/);
            if (!typeMatch || typeMatch[1] !== filterType) continue;
          }

          // Extract content after frontmatter
          const parts = fileContent.split("---\n");
          const body = parts.length >= 3 ? parts.slice(2).join("---\n").trim() : fileContent;
          results.push(`## ${entryName}\n${body.slice(0, 500)}`);
        }
      }

      return results.length > 0 ? results.join("\n\n---\n\n") : "(no memories found)";
    },

    memory_forget: async (args) => {
      const name = args["name"] as string;
      const filePath = memoryPath(memDir, name);

      if (!fs.existsSync(filePath)) {
        return `Error: memory '${name}' not found`;
      }

      fs.unlinkSync(filePath);

      // Update index
      const index = readIndex(memDir).filter(
        (l) => !l.includes(`(${name}.md)`)
      );
      writeIndex(memDir, index);

      return `Memory deleted: ${name}`;
    },
  };
}
