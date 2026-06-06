import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { MCPServerConfig, MCPToolDef } from "../types.js";
import { logger } from "../logger.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class MCPClient {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private reqId = 0;
  private pending: Map<number, (res: JsonRpcResponse) => void> = new Map();
  private buffer = "";
  private config: MCPServerConfig;
  private name: string;
  private workspaceRoot: string;

  constructor(name: string, config: MCPServerConfig, workspaceRoot: string) {
    this.name = name;
    this.workspaceRoot = workspaceRoot;
    // Expand ${VAR} patterns — whitelist only safe env vars
    const ALLOWED_EXPAND_KEYS = new Set(["CHITU_PROJECT_DIR", "HOME", "PWD", "USER", "PATH", "workspaceRoot"]);
    const expandVar = (s: string): string =>
      s.replace(/\$\{(\w+)\}/g, (_, key: string) =>
        ALLOWED_EXPAND_KEYS.has(key) ? (process.env[key] ?? this.workspaceRoot) : `\${${key}}`);

    this.config = {
      ...config,
      command: expandVar(config.command),
      args: config.args.map(expandVar),
    };

    // Expand env var references
    if (this.config.env) {
      const projectDir = process.env["CHITU_PROJECT_DIR"] ?? this.workspaceRoot;
      for (const [k, v] of Object.entries(this.config.env)) {
        this.config.env[k] = v
          .replace(/\$\{CHITU_PROJECT_DIR\}/g, projectDir)
          .replace(/\$\{workspaceRoot\}/g, this.workspaceRoot);
      }
    }
  }

  async start(): Promise<void> {
    if (this.proc) return;

    const env = { ...process.env, ...this.config.env };

    return new Promise<void>((resolve, reject) => {
      const proc = spawn(this.config.command, this.config.args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: this.workspaceRoot,
        env,
      });

      let settled = false;

      const cleanup = (reason: string, err?: Error) => {
        if (settled) return;
        settled = true;
        if (this.rl) { this.rl.close(); this.rl = null; }
        // Reject pending requests
        for (const [id, resolvePending] of this.pending) {
          resolvePending({ jsonrpc: "2.0", id, error: { code: -1, message: `server ${reason}` } });
        }
        this.pending.clear();
        try { proc.kill(); } catch { /* already dead */ }
        this.proc = null;
        reject(err ?? new Error(`MCP server '${this.name}' ${reason}`));
      };

      proc.on("error", (err) => {
        cleanup("spawn failed", err);
      });

      proc.on("exit", (code, signal) => {
        if (code !== null && code !== 0 && !settled) {
          cleanup(`exited with code ${code}`);
        } else if (!settled) {
          this.proc = null;
        }
      });

      this.proc = proc;

      // Read stdout line by line (JSON-RPC messages)
      this.rl = createInterface({ input: proc.stdout! });
      this.rl.on("line", (line: string) => {
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          const resolvePending = this.pending.get(msg.id);
          if (resolvePending) {
            this.pending.delete(msg.id);
            resolvePending(msg);
          }
        } catch (e) {
          logger.warn("MCP non-JSON line", { error: String(e) });
        }
      });

      // Collect stderr for error diagnostics
      let stderrBuf = "";
      proc.stderr?.on("data", (d: Buffer) => { stderrBuf += d.toString(); });

      // Initialize
      this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "chitu", version: "0.1.0" },
      })
        .then(() => {
          this.sendNotification("notifications/initialized", {});
          resolve();
        })
        .catch((err) => {
          cleanup(`init failed: ${err instanceof Error ? err.message : String(err)}`, err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  async listTools(): Promise<MCPToolDef[]> {
    const res = await this.sendRequest("tools/list", {});
    const result = res.result as { tools?: MCPToolDef[] } | undefined;
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.sendRequest("tools/call", {
      name,
      arguments: args,
    });
    const result = res.result as { content?: Array<{ type: string; text?: string }> } | undefined;
    if (result?.content) {
      return result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
    }
    return JSON.stringify(res.result);
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const id = ++this.reqId;
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.pending.set(id, resolve);

      this.proc!.stdin!.write(JSON.stringify(req) + "\n");

      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request '${method}' timed out`));
        }
      }, 30000);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const notif = { jsonrpc: "2.0", method, params };
    this.proc?.stdin?.write(JSON.stringify(notif) + "\n");
  }

  async stop(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    // Reject all pending requests
    for (const [id, resolve] of this.pending) {
      resolve({ jsonrpc: "2.0", id, error: { code: -1, message: "server stopped" } });
    }
    this.pending.clear();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  getName(): string {
    return this.name;
  }

  isRunning(): boolean {
    return this.proc !== null;
  }
}
