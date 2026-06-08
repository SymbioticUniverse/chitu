import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ToolContext, ToolHandler, ToolDef } from "../types.js";

const SERVERS_DIR = ".chitu/mcp-servers";
const SKILLS_DIR = ".chitu/skills";

const RESERVED_NAMES = ["horsewhip"];
const RESERVED_PREFIXES = ["horsewhip__", "mcp__horsewhip__", "chitu_", "mcp_auto_", "skill_auto_"];

function validateName(name: string, kind: string): string | null {
  const lower = name.toLowerCase();
  if (RESERVED_NAMES.some((r) => lower === r)) {
    return `Name '${name}' is reserved. Choose a different ${kind} name.`;
  }
  if (RESERVED_PREFIXES.some((p) => lower.startsWith(p))) {
    return `Name '${name}' conflicts with reserved prefix. Choose a different ${kind} name.`;
  }
  return null;
}

function scanForFileBypass(dir: string): string[] {
  const dangerous: string[] = [];
  const patterns = [
    /\breadFile(Sync)?\s*\(/,
    /\bwriteFile(Sync)?\s*\(/,
    /\bappendFile(Sync)?\s*\(/,
    /\bunlink(Sync)?\s*\(/,
    /\brmdir(Sync)?\s*\(/,
    /\bmkdir(Sync)?\s*\(/,
    /\bchmod(Sync)?\s*\(/,
    /\bchown(Sync)?\s*\(/,
    /\brename(Sync)?\s*\(/,
    /\bcopyFile(Sync)?\s*\(/,
    /\bexec(Sync)?\s*\(/,
    /\bspawn\s*\(/,
    /\bexecSync\s*\(/,
    /\bexecFile(Sync)?\s*\(/,
    /\bopen(Sync)?\s*\(/,
    /\bcreateWriteStream\s*\(/,
    /\bcreateReadStream\s*\(/,
  ];

  function scanFile(filePath: string): void {
    if (filePath.includes("node_modules") || filePath.includes(".git")) return;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const p of patterns) {
        if (p.test(content)) {
          const rel = path.relative(dir, filePath);
          dangerous.push(`${rel}: ${content.match(p)?.[0] ?? p.source}`);
          break;
        }
      }
    } catch { /* binary or unreadable */ }
  }

  function walk(d: string): void {
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (!e.name.startsWith(".") || e.name === ".chitu") walk(full); }
        else if (e.isFile() && /\.(js|ts|jsx|tsx|mjs|cjs|py|sh|bash|zsh|rb|go|rs|java)$/.test(e.name)) {
          scanFile(full);
        }
      }
    } catch { /* permission */ }
  }

  walk(dir);
  return dangerous;
}

function rollback(dir: string, workspaceRoot: string, configKey?: string): void {
  try { run(`rm -rf ${dir}`, workspaceRoot); } catch { /* best-effort */ }
  if (configKey) {
    try {
      const config = ensureConfig(workspaceRoot);
      if (config.mcpServers) delete config.mcpServers[configKey];
      saveConfig(workspaceRoot, config);
    } catch { /* best-effort */ }
  }
}

function validateSkillTools(skillDir: string): string | null {
  const skillJsonPath = path.join(skillDir, "skill.json");
  if (!fs.existsSync(skillJsonPath)) return null;
  try {
    const skill = JSON.parse(fs.readFileSync(skillJsonPath, "utf-8"));
    const toolDefs = (skill.toolDefs ?? []) as { name: string }[];
    for (const t of toolDefs) {
      const lower = t.name.toLowerCase();
      if (RESERVED_PREFIXES.some((p) => lower.startsWith(p))) {
        return `Skill tool '${t.name}' conflicts with reserved prefix. Skill rejected.`;
      }
    }
  } catch { return "Invalid skill.json format."; }
  return null;
}

function run(cmd: string, cwd: string): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd, encoding: "utf-8", timeout: 120_000, stdio: "pipe" });
    return { ok: true, output: output.trim() };
  } catch (e: any) {
    return { ok: false, output: e.stderr ?? e.message ?? String(e) };
  }
}

function detectEntryPoint(serverDir: string): string | null {
  // 1. Check package.json main/bin
  const pkgPath = path.join(serverDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.bin) {
        const binPath = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin)[0];
        if (binPath && fs.existsSync(path.join(serverDir, binPath))) return binPath;
      }
      if (pkg.main && fs.existsSync(path.join(serverDir, pkg.main))) return pkg.main;
    } catch { /* fall through */ }
  }

  // 2. Look for common entry points
  for (const candidate of ["index.js", "index.mjs", "server.js", "main.js", "src/index.js"]) {
    if (fs.existsSync(path.join(serverDir, candidate))) return candidate;
  }

  return null;
}

function ensureConfig(workspaceRoot: string): Record<string, any> {
  const configDir = path.join(workspaceRoot, ".chitu");
  const configPath = path.join(configDir, "config.json");
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  if (fs.existsSync(configPath)) {
    try { return JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { /* reset */ }
  }
  return {};
}

function saveConfig(workspaceRoot: string, config: Record<string, any>): void {
  const configPath = path.join(workspaceRoot, ".chitu", "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export function createAutoInstallTools(ctx: ToolContext): Record<string, ToolHandler> {
  return {
    mcp_auto_install: async (args) => {
      const url = args["url"] as string;
      const serverName = (args["name"] as string) ?? extractRepoName(url);

      if (!url) return "Error: `url` is required (GitHub repository URL).";
      if (!isValidGitUrl(url)) return `Error: invalid Git URL '${url}'. Provide a GitHub repo URL.`;

      const nameErr = validateName(serverName, "MCP server");
      if (nameErr) return `Error: ${nameErr}`;

      const serversDir = path.join(ctx.workspaceRoot, SERVERS_DIR);
      const serverDir = path.join(serversDir, serverName);

      if (fs.existsSync(serverDir)) {
        return `Error: server '${serverName}' already exists at ${serverDir}. Remove it first or use a different name.`;
      }

      // Step 1: Clone
      const cloneResult = run(`git clone ${url} ${serverDir}`, ctx.workspaceRoot);
      if (!cloneResult.ok) return `Git clone failed:\n${cloneResult.output}`;

      // Step 2: Install dependencies
      if (fs.existsSync(path.join(serverDir, "package.json"))) {
        const installResult = run("npm install --production", serverDir);
        if (!installResult.ok) return `npm install failed for '${serverName}':\n${installResult.output}`;
      }

      // Step 3: Scan for file bypass patterns
      const bypassPatterns = scanForFileBypass(serverDir);
      if (bypassPatterns.length > 0) {
        rollback(serverDir, ctx.workspaceRoot);
        return [
          `MCP server '${serverName}' REJECTED — bypasses Horsewhip file guards.`,
          `Detected ${bypassPatterns.length} file operation pattern(s):`,
          ...bypassPatterns.slice(0, 5).map((p) => `  - ${p}`),
          ``,
          `MCP servers must NOT directly read/write files. Use Chitu's built-in tools which enforce boundary locks.`,
          `Installation rolled back.`,
        ].join("\n");
      }

      // Step 4: Detect entry point
      const entry = detectEntryPoint(serverDir);
      if (!entry) {
        rollback(serverDir, ctx.workspaceRoot);
        return [
          `MCP server '${serverName}' cloned to ${SERVERS_DIR}/${serverName}/`,
          `But could not detect an entry point. Check the server's documentation.`,
          `Expected: package.json with "main" or "bin", or index.js / server.js.`,
          `Installation rolled back.`,
        ].join("\n");
      }

      // Step 4: Determine command (use node for .js, or the file directly if executable)
      const absEntry = path.join(serverDir, entry);
      const command = entry.endsWith(".js") || entry.endsWith(".mjs") ? "node" : absEntry;
      const cmdArgs = entry.endsWith(".js") || entry.endsWith(".mjs") ? [absEntry] : [];

      // Step 5: Write config
      const config = ensureConfig(ctx.workspaceRoot);
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers[serverName] = {
        command,
        args: cmdArgs,
        alwaysLoad: args["alwaysLoad"] === true,
      };
      saveConfig(ctx.workspaceRoot, config);

      return [
        `MCP server '${serverName}' installed successfully.`,
        `  Directory: ${SERVERS_DIR}/${serverName}/`,
        `  Entry: ${entry}`,
        `  Command: ${command} ${cmdArgs.join(" ")}`,
        ``,
        `Restart Chitu or reload MCP to use it (\`/mcp-reload\`).`,
      ].join("\n");
    },

    skill_auto_install: async (args) => {
      const url = args["url"] as string;
      const skillName = (args["name"] as string) ?? extractRepoName(url);

      if (!url) return "Error: `url` is required (GitHub repository URL).";
      if (!isValidGitUrl(url)) return `Error: invalid Git URL '${url}'.`;

      const nameErr = validateName(skillName, "skill");
      if (nameErr) return `Error: ${nameErr}`;

      const skillsDir = path.join(ctx.workspaceRoot, SKILLS_DIR);
      const skillDir = path.join(skillsDir, skillName);

      if (fs.existsSync(skillDir)) {
        return `Error: skill '${skillName}' already exists at ${skillDir}.`;
      }

      const cloneResult = run(`git clone ${url} ${skillDir}`, ctx.workspaceRoot);
      if (!cloneResult.ok) return `Git clone failed:\n${cloneResult.output}`;

      if (fs.existsSync(path.join(skillDir, "package.json"))) {
        const installResult = run("npm install --production", skillDir);
        if (!installResult.ok) return `npm install failed:\n${installResult.output}`;
      }

      // Scan for file bypass patterns
      const bypassPatterns = scanForFileBypass(skillDir);
      if (bypassPatterns.length > 0) {
        run(`rm -rf ${skillDir}`, ctx.workspaceRoot);
        return [
          `Skill '${skillName}' REJECTED — bypasses Horsewhip file guards.`,
          `Detected ${bypassPatterns.length} file operation pattern(s):`,
          ...bypassPatterns.slice(0, 5).map((p) => `  - ${p}`),
          ``,
          `Skills must NOT directly read/write files. Use Chitu's built-in tools which enforce boundary locks.`,
          `Installation rolled back.`,
        ].join("\n");
      }

      if (!fs.existsSync(path.join(skillDir, "skill.json"))) {
        run(`rm -rf ${skillDir}`, ctx.workspaceRoot);
        return [
          `Skill '${skillName}' cloned to ${SKILLS_DIR}/${skillName}/`,
          `But no skill.json found. Skills require a skill.json manifest.`,
          `Installation rolled back.`,
        ].join("\n");
      }

      const toolErr = validateSkillTools(skillDir);
      if (toolErr) {
        run(`rm -rf ${skillDir}`, ctx.workspaceRoot);
        return `Error: ${toolErr} Installation rolled back.`;
      }

      return [
        `Skill '${skillName}' installed successfully.`,
        `  Directory: ${SKILLS_DIR}/${skillName}/`,
        ``,
        `Restart Chitu to load the skill.`,
      ].join("\n");
    },

    chitu_install: async (args) => {
      const url = args["url"] as string;
      const scope = (args["scope"] as string) ?? "project";

      if (!url) return "Error: `url` is required (raw URL to a CHITU.md file, or a GitHub repo URL).";
      if (!["global", "project"].includes(scope)) return "Error: `scope` must be 'global' or 'project'.";

      // Determine target path
      const home = process.env["HOME"] ?? "~";
      const targetDir = scope === "global"
        ? path.join(home, ".chitu")
        : path.join(ctx.workspaceRoot, ".chitu");
      const targetPath = path.join(targetDir, "CHITU.md");

      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

      // Fetch content
      let content: string;
      try {
        content = await fetchText(url);
      } catch (e: any) {
        // Fallback: try git clone if it's a repo URL
        if (isValidGitUrl(url)) {
          const tmpDir = path.join(ctx.workspaceRoot, ".chitu", ".tmp-chitu-install");
          const cloneResult = run(`git clone --depth=1 ${url} ${tmpDir}`, ctx.workspaceRoot);
          if (!cloneResult.ok) return `Git clone failed:\n${cloneResult.output}`;

          const mdPath = findChituMd(tmpDir);
          if (!mdPath) {
            run(`rm -rf ${tmpDir}`, ctx.workspaceRoot);
            return `No CHITU.md found in the repository.`;
          }
          content = fs.readFileSync(mdPath, "utf-8");
          run(`rm -rf ${tmpDir}`, ctx.workspaceRoot);
        } else {
          return `Failed to fetch URL: ${e.message}`;
        }
      }

      if (!content?.trim()) return "Error: empty content.";

      fs.writeFileSync(targetPath, content.trim() + "\n", "utf-8");

      const scopeLabel = scope === "global" ? "global (~/.chitu/CHITU.md)" : "project (.chitu/CHITU.md)";
      return [
        `CHITU.md installed at ${scopeLabel}.`,
        `  Path: ${targetPath}`,
        `  Size: ${content.length} bytes`,
        ``,
        `The rules will take effect on the next message.`,
      ].join("\n");
    },
  };
}

function extractRepoName(url: string): string {
  const match = url.match(/\/([^/]+?)(?:\.git)?$/);
  return match?.[1] ?? "mcp-server";
}

function isValidGitUrl(url: string): boolean {
  return /^https?:\/\//.test(url) || /^git@/.test(url);
}

function findChituMd(dir: string): string | null {
  for (const candidate of ["CHITU.md", "chitu.md", ".chitu/CHITU.md", "README.md"]) {
    const p = path.join(dir, candidate);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function fetchText(url: string): Promise<string> {
  const httpModule = url.startsWith("https") ? await import("node:https") : await import("node:http");
  return new Promise((resolve, reject) => {
    httpModule.get(url, { timeout: 30_000 }, (res: any) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchText(res.headers.location));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

export function autoInstallToolDefs(): ToolDef[] {
  return [
    {
      name: "mcp_auto_install",
      description:
        "Automatically install an MCP server from a GitHub URL. Clones the repo, installs dependencies, detects the entry point, and registers it in .chitu/config.json.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "GitHub repository URL to clone" },
          name: { type: "string", description: "Short server name (auto-detected from URL if omitted)" },
          alwaysLoad: { type: "boolean", description: "Auto-load on startup (default: false)" },
        },
        required: ["url"],
      },
      category: "write",
    },
    {
      name: "skill_auto_install",
      description:
        "Automatically install a Chitu skill from a GitHub URL. Clones the repo to .chitu/skills/, installs dependencies. A valid skill repo must contain a skill.json manifest.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "GitHub repository URL to clone" },
          name: { type: "string", description: "Short skill name (auto-detected from URL if omitted)" },
        },
        required: ["url"],
      },
      category: "write",
    },
    {
      name: "chitu_install",
      description:
        "Install a CHITU.md rules file from a URL. Use `ask_user` first to ask the user whether to install at 'global' (~/.chitu/CHITU.md, applies to all projects) or 'project' (.chitu/CHITU.md, this project only). The URL should point to a raw markdown file or a GitHub repo containing CHITU.md.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Raw URL to a CHITU.md file, or a GitHub repo URL" },
          scope: { type: "string", description: "'global' or 'project' — ask the user first", enum: ["global", "project"] },
        },
        required: ["url", "scope"],
      },
      category: "write",
    },
  ];
}
