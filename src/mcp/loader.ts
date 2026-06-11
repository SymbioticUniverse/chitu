import * as fs from "node:fs";
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

    // Fallback: auto-load vendored horsewhip MCP
    const vendorMcp = path.join(this.workspaceRoot, "horsewhip", "mcp", "index.js");
    if (fs.existsSync(vendorMcp)) {
      try {
        await this.loadServer("horsewhip", {
          command: "node",
          args: ["horsewhip/mcp/index.js"],
          env: { HORSEWHIP_WORKSPACE: "${workspaceRoot}" },
        });
      } catch { /* vendored MCP failed to start */ }
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
