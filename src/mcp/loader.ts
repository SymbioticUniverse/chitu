import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPClient } from "./client.js";
import type { MCPServerConfig, MCPToolDef, ToolDef, ToolHandler } from "../types.js";
import { logger } from "../logger.js";

interface MCPManifest {
  mcpServers?: Record<string, MCPServerConfig>;
}

interface SkillDef {
  name: string;
  description: string;
  toolDefs?: ToolDef[];
  handlers?: Record<string, ToolHandler>;
}

/** Find the latest horsewhip MCP from the VS Code extension */
function findExtensionMcp(): string {
  try {
    const extRoot = path.join(os.homedir(), ".vscode", "extensions");
    if (!fs.existsSync(extRoot)) return "";
    const entries = fs.readdirSync(extRoot, { withFileTypes: true });
    const versions: Array<{ version: string; mcpPath: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const m = entry.name.match(/^horsewhip\.horsewhip-(\d+\.\d+\.\d+)$/);
      if (!m?.[1]) continue;
      const mcpPath = path.join(extRoot, entry.name, "media", "mcp", "dist", "index.js");
      if (!fs.existsSync(mcpPath)) continue;
      versions.push({ version: m[1], mcpPath });
    }
    if (versions.length === 0) return "";
    versions.sort((a, b) => {
      const pa = a.version.split(".").map(Number);
      const pb = b.version.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) > (pb[i] ?? 0)) return -1;
        if ((pa[i] ?? 0) < (pb[i] ?? 0)) return 1;
      }
      return 0;
    });
    return versions[0]!.mcpPath;
  } catch {
    return "";
  }
}

export class MCPLoader {
  private clients: Map<string, MCPClient> = new Map();
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /** Load MCP servers: workspace .chitu/config.json → .mcp.json → ~/.chitu/mcp.json */
  async loadFromConfig(): Promise<void> {
    const home = process.env["HOME"] ?? "~";

    // Priority 1: workspace .chitu/config.json
    const wsConfigPath = path.join(this.workspaceRoot, ".chitu", "config.json");
    if (fs.existsSync(wsConfigPath)) {
      try {
        const wsConfig = JSON.parse(fs.readFileSync(wsConfigPath, "utf-8")) as { mcpServers?: Record<string, MCPServerConfig> };
        if (wsConfig.mcpServers && Object.keys(wsConfig.mcpServers).length > 0) {
          await this.loadServers(wsConfig.mcpServers);
          return;
        }
      } catch { /* fall through */ }
    }

    // Priority 2: workspace .mcp.json (legacy)
    const mcpJsonPath = path.join(this.workspaceRoot, ".mcp.json");
    if (fs.existsSync(mcpJsonPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8")) as MCPManifest;
        const servers = manifest.mcpServers ?? {};
        if (Object.keys(servers).length > 0) {
          await this.loadServers(servers);
          return;
        }
      } catch { /* fall through */ }
    }

    // Priority 3: global ~/.chitu/mcp.json
    const globalMcpPath = path.join(home, ".chitu", "mcp.json");
    if (fs.existsSync(globalMcpPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(globalMcpPath, "utf-8")) as MCPManifest;
        const servers = manifest.mcpServers ?? {};
        if (Object.keys(servers).length > 0) {
          await this.loadServers(servers);
          return;
        }
      } catch { /* fall through */ }
    }

    // Fallback: auto-load horsewhip MCP from external sources
    // Horsewhip lives OUTSIDE chitu so chitu can self-modify without self-locking.
    // Look in: workspace sync dir → global sync dir → VS Code extension
    const workspaceMcp = path.join(this.workspaceRoot, "horsewhip", "mcp", "index.js");
    const globalMcp = path.join(home, ".chitu", "horsewhip", "mcp", "index.js");
    const extMcp = findExtensionMcp();
    const candidates = [workspaceMcp, globalMcp, extMcp];
    const mcpPath = candidates.find((c) => c && fs.existsSync(c)) ?? "";

    if (mcpPath) {
      try {
        await this.loadServer("horsewhip", {
          command: "node",
          args: [mcpPath],
          env: { HORSEWHIP_WORKSPACE: "${workspaceRoot}" },
          alwaysLoad: true,
        });
      } catch (e) {
        logger.warn("vendored horsewhip MCP failed", { path: mcpPath, error: String(e) });
      }
    } else {
      try {
        const logLine = [
          `[${new Date().toISOString()}] MCP fallback miss`,
          `  workspaceRoot=${this.workspaceRoot}`,
          `  argv[1]=${process.argv[1] ?? "none"}`,
          `  candidates=[${candidates.map((c) => (c || "(empty)") + " exists=" + (c ? fs.existsSync(c) : false)).join(", ")}]`,
          "",
        ].join("\n");
        fs.appendFileSync("/tmp/chitu-mcp-debug.log", logLine);
      } catch { /* silent */ }
    }
  }

  /** Internal: load a map of server configs */
  private async loadServers(servers: Record<string, MCPServerConfig>): Promise<void> {
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg.alwaysLoad || process.env["CHITU_LOAD_MCP"]?.includes(name)) {
        try {
          await this.loadServer(name, cfg);
        } catch (e) {
          console.error(`MCP loader: failed to start '${name}':`, e);
        }
      }
    }
  }

  /** Load a single MCP server */
  async loadServer(name: string, config: MCPServerConfig): Promise<MCPClient> {
    const client = new MCPClient(name, config, this.workspaceRoot);
    await client.start();
    this.clients.set(name, client);
    return client;
  }

  /** Get all tools from all loaded MCP servers */
  async getAllMCPTools(): Promise<ToolDef[]> {
    const tools: ToolDef[] = [];
    for (const [serverName, client] of this.clients) {
      try {
        const mcpTools = await client.listTools();
        for (const mt of mcpTools) {
          tools.push({
            name: `mcp__${serverName}__${mt.name}`,
            description: mt.description ?? `MCP tool: ${mt.name}`,
            parameters: {
              type: "object",
              properties: (mt.inputSchema?.properties ?? {}) as Record<string, import("../types.js").ToolParamProp>,
              required: mt.inputSchema?.required,
            },
            category: "write",
          });
        }
      } catch (e) {
        logger.warn("MCP tool listing failed", { error: String(e) });
      }
    }
    return tools;
  }

  /** Create handlers for all MCP tools */
  createMCPHandlers(): Record<string, ToolHandler> {
    const handlers: Record<string, ToolHandler> = {};

    for (const [serverName, client] of this.clients) {
      // We need to wrap each tool name — we'll do this lazily via a proxy pattern
      handlers[`__mcp_${serverName}`] = async (args: Record<string, unknown>) => {
        const toolName = args["__tool"] as string;
        const toolArgs = (args["__args"] as Record<string, unknown>) ?? {};
        return client.callTool(toolName, toolArgs);
      };
    }

    return handlers;
  }

  /** Lookup and call an MCP tool by its full name (mcp__server__tool) */
  async callMCPTool(fullName: string, args: Record<string, unknown>): Promise<string> {
    // Parse mcp__<server>__<tool>
    const parts = fullName.split("__");
    if (parts.length < 3 || parts[0] !== "mcp") {
      throw new Error(`Invalid MCP tool name: ${fullName}`);
    }
    const serverName = parts[1] ?? "";
    const toolName = parts.slice(2).join("__");

    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server '${serverName}' not loaded`);
    }

    return client.callTool(toolName, args);
  }

  /** Load skills from config-defined skillsPath (default: .chitu/skills/) */
  loadSkills(): SkillDef[] {
    const skills: SkillDef[] = [];
    let skillsRelPath = ".chitu/skills/";
    // Read skillsPath from workspace config
    const wsConfigPath = path.join(this.workspaceRoot, ".chitu", "config.json");
    if (fs.existsSync(wsConfigPath)) {
      try {
        const wsConfig = JSON.parse(fs.readFileSync(wsConfigPath, "utf-8")) as { skillsPath?: string };
        if (wsConfig.skillsPath) skillsRelPath = wsConfig.skillsPath;
      } catch { /* use default */ }
    }
    const skillsDir = path.join(this.workspaceRoot, skillsRelPath);
    if (!fs.existsSync(skillsDir)) return skills;

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(skillsDir, entry.name);
      const skillYaml = path.join(skillPath, "skill.yaml");
      const skillJson = path.join(skillPath, "skill.json");

      let def: SkillDef | null = null;
      if (fs.existsSync(skillJson)) {
        def = JSON.parse(fs.readFileSync(skillJson, "utf-8")) as SkillDef;
      } else if (fs.existsSync(skillYaml)) {
        // Basic YAML parsing would go here; skip for now
        continue;
      }

      if (def) {
        def.name = def.name ?? entry.name;
        skills.push(def);
      }
    }

    return skills;
  }

  /** Get names of all loaded MCP servers */
  getLoadedServerNames(): string[] {
    return Array.from(this.clients.keys());
  }

  async stopAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.stop();
    }
    this.clients.clear();
  }
}
