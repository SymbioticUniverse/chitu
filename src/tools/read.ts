import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import type { ToolContext, ToolHandler } from "../types.js";
import { resolvePath } from "./utils.js";

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0 ||
    ip === "169.254.169.254"
  );
}

export function createReadTools(ctx: ToolContext): Record<string, ToolHandler> {
  const root = ctx.workspaceRoot;
  const resolve = (p: string) => resolvePath(root, p);

  return {
    read_file: async (args) => {
      const filePath = resolve(args["path"] as string);
      const offset = (args["offset"] as number) ?? 0;
      const limit = args["limit"] as number | undefined;

      if (!fs.existsSync(filePath)) {
        return `Error: file not found: ${filePath}`;
      }
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        return `Error: path is a directory: ${filePath}`;
      }
      if (stat.size > 5 * 1024 * 1024) {
        return `Error: file too large (${formatSize(stat.size)}). Use offset/limit to read portions.`;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      const start = offset > 0 ? offset - 1 : 0;
      const end = limit ? start + limit : lines.length;
      const slice = lines.slice(start, end);

      const numbered = slice
        .map((line, i) => `${String(start + i + 1).padStart(6, " ")}\t${line}`)
        .join("\n");

      const ext = path.extname(filePath).slice(1).toLowerCase();
      const langMap: Record<string, string> = {
        ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
        py: "python", rs: "rust", go: "go", java: "java",
        c: "c", cpp: "cpp", h: "c", hpp: "cpp",
        sh: "bash", bash: "bash", zsh: "bash",
        json: "json", yml: "yaml", yaml: "yaml", toml: "toml",
        md: "markdown", markdown: "markdown",
        html: "html", css: "css", scss: "scss", less: "less",
        sql: "sql", xml: "xml", svg: "xml",
        rb: "ruby", php: "php", swift: "swift", kt: "kotlin",
        vue: "vue", svelte: "svelte",
        dockerfile: "dockerfile", makefile: "makefile",
      };
      const lang = langMap[ext] || ext;
      const langTag = lang || "";

      return `\`\`\`${langTag}\n${numbered}\n\`\`\``;
    },

    list_directory: async (args) => {
      const dirPath = resolve(args["path"] as string);

      if (!fs.existsSync(dirPath)) {
        return `Error: directory not found: ${dirPath}`;
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const lines: string[] = [];

      for (const e of entries) {
        const suffix = e.isDirectory() ? "/" : "";
        const size = e.isFile() ? formatSize(fs.statSync(path.join(dirPath, e.name)).size) : "";
        lines.push(`${e.name}${suffix} ${size}`.trimEnd());
      }

      return lines.join("\n");
    },

    search_code: async (args) => {
      const pattern = args["pattern"] as string;
      const searchPath = args["path"] ? resolve(args["path"] as string) : root;
      const fileTypes = args["fileTypes"] as string | undefined;

      try {
        // Build args array for spawnSync — no shell, no injection
        const grepArgs: string[] = ["-rn", "--color=never"];
        if (fileTypes) {
          for (const ft of fileTypes.split(",")) {
            grepArgs.push("--include", ft.trim());
          }
        }
        grepArgs.push(pattern, searchPath);

        const result = spawnSync("grep", grepArgs, {
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: 10000,
        });

        if (result.status === 1 && !result.stdout) return "(no matches)";
        if (result.error) return `Error: ${result.error.message}`;
        return result.stdout || "(no matches)";
      } catch (e: unknown) {
        return `Error: ${String(e)}`;
      }
    },

    git_status: async () => {
      try {
        const result = execSync("git status --short", {
          encoding: "utf-8",
          cwd: root,
          maxBuffer: 1024 * 1024,
        });
        return result || "(clean working tree)";
      } catch (e: unknown) {
        return `Error: ${String(e)}`;
      }
    },

    git_diff: async (args) => {
      try {
        const diffArgs = ["diff"];
        if (args["staged"]) diffArgs.push("--staged");
        if (args["commit"] && /^[a-zA-Z0-9_./^~-]+$/.test(args["commit"] as string)) {
          diffArgs.push(args["commit"] as string);
        }
        const result = spawnSync("git", diffArgs, {
          encoding: "utf-8",
          cwd: root,
          maxBuffer: 10 * 1024 * 1024,
        });
        return result.stdout || "(no changes)";
      } catch (e: unknown) {
        return `Error: ${String(e)}`;
      }
    },

    git_log: async (args) => {
      try {
        const count = Math.min(args["count"] as number ?? 10, 100);
        const file = args["file"] as string | undefined;
        const logArgs = ["log", "--oneline", `-${count}`];
        if (file && /^[a-zA-Z0-9_./\\-]+$/.test(file)) {
          logArgs.push("--", file);
        }
        const result = spawnSync("git", logArgs, {
          encoding: "utf-8",
          cwd: root,
          maxBuffer: 1024 * 1024,
        });
        return result.stdout || "(no commits)";
      } catch (e: unknown) {
        return `Error: ${String(e)}`;
      }
    },

    web_search: async (args) => {
      const query = args["query"] as string;
      // Use DuckDuckGo HTML search (no API key needed, no JS)
      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "Chitu/0.1" },
          signal: AbortSignal.timeout(15000),
        });
        const html = await resp.text();
        // Extract result snippets
        const snippets: string[] = [];
        const re = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*?>([\s\S]*?)<\/a>/gi;
        let match: RegExpExecArray | null;
        while ((match = re.exec(html)) !== null && snippets.length < 10) {
          const title = stripHtml(match[1] ?? "");
          const snippet = stripHtml(match[2] ?? "");
          if (title && snippet) {
            snippets.push(`${snippets.length + 1}. ${title}\n   ${snippet}`);
          }
        }
        return snippets.length > 0
          ? snippets.join("\n\n")
          : `No results found for: ${query}`;
      } catch (e: unknown) {
        return `Web search error: ${String(e)}`;
      }
    },

    web_fetch: async (args) => {
      const url = args["url"] as string;
      try {
        const parsed = new URL(url);

        // Block dangerous protocols
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return `SSRF blocked: protocol '${parsed.protocol}' is not allowed. Only http/https URLs are supported.`;
        }

        // Block internal/private IP addresses
        const hostname = parsed.hostname.toLowerCase();
        const localhosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
        if (localhosts.has(hostname)) {
          return `SSRF blocked: '${hostname}' is not accessible.`;
        }

        // Check for IPv4-mapped IPv6 addresses (e.g., [::ffff:127.0.0.1])
        const ipv4Mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
        if (ipv4Mapped) {
          const mappedHost = ipv4Mapped[1]!;
          if (localhosts.has(mappedHost) || isPrivateIPv4(mappedHost)) {
            return `SSRF blocked: '${hostname}' maps to private address '${mappedHost}'.`;
          }
        }

        // Parse hostname as IP to check private ranges
        const { isIP } = await import("node:net");
        if (isIP(hostname)) {
          if (isIP(hostname) === 4) {
            if (isPrivateIPv4(hostname)) {
              return `SSRF blocked: '${hostname}' is a private/internal IP address.`;
            }
          }
          // Block IPv6 loopback / link-local / unique-local
          if (isIP(hostname) === 6) {
            if (hostname === "::1" || hostname.startsWith("fe80:") || hostname.startsWith("fc") || hostname.startsWith("fd")) {
              return `SSRF blocked: '${hostname}' is a private IPv6 address.`;
            }
          }
        }

        const resp = await fetch(url, {
          headers: { "User-Agent": "Chitu/0.1" },
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        });
        const contentType = resp.headers.get("content-type") ?? "";
        const text = await resp.text();

        if (contentType.includes("text/html")) {
          // Simple HTML-to-text
          const stripped = stripHtml(text)
            .replace(/\n{3,}/g, "\n\n")
            .trim()
            .slice(0, 8000);
          return `URL: ${url}\nStatus: ${resp.status}\n\n${stripped}`;
        }

        return `URL: ${url}\nStatus: ${resp.status}\n\n${text.slice(0, 8000)}`;
      } catch (e: unknown) {
        return `Web fetch error: ${String(e)}`;
      }
    },
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
