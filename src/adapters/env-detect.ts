/**
 * env-detect.ts — 环境检测模块
 *
 * 自适应能力的底层：检测运行环境、VS Code 插件状态、
 * Node.js 版本、操作系统、项目框架等。
 * 所有检测结果缓存在单例中，避免重复执行。
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, platform, arch, release } from "node:os";
import { join } from "node:path";
import { logger } from "../logger.js";

// ============================================================
// Types
// ============================================================

export interface EnvInfo {
  /** Node.js 版本 */
  nodeVersion: string;
  /** 操作系统 */
  os: (typeof process)["platform"];
  /** 架构 */
  osArch: string;
  /** 操作系统版本 */
  osRelease: string;
  /** 主机名 */
  hostname: string;
  /** 工作目录 */
  workspaceRoot: string;
  /** VS Code 是否可用 */
  vscodeAvailable: boolean;
  /** VS Code 版本 */
  vscodeVersion: string | null;
  /** Horsewhip 插件版本列表（已安装的所有版本） */
  horsewhipPluginVersions: string[];
  /** Horsewhip 插件最新版本 */
  horsewhipPluginLatest: string | null;
  /** MCP 配置中引用的 Horsewhip 版本 */
  horsewhipMCPVersion: string | null;
  /** Horsewhip MCP server hash */
  horsewhipMCPHash: string | null;
  /** 当前 Horsewhip 是否在活跃插件中 */
  horsewhipPluginActive: boolean;
  /** 项目 git 根目录 */
  gitRoot: string | null;
  /** 是否有 .chitu 目录 */
  hasChituDir: boolean;
  /** 首页路径 */
  homeDir: string;
}

// ============================================================
// Singleton
// ============================================================

let cached: EnvInfo | null = null;

/** 检测 VS Code CLI 是否可用 */
function checkVSCode(): { available: boolean; version: string | null } {
  try {
    const out = execSync("code --version", {
      encoding: "utf-8",
      timeout: 3000,
    });
    const lines = out.trim().split("\n");
    return { available: true, version: lines[0] ?? null };
  } catch {
    return { available: false, version: null };
  }
}

/** 扫描 VS Code 扩展目录中的 Horsewhip 插件版本 */
function scanHorsewhipVersions(): {
  versions: string[];
  latest: string | null;
} {
  const extensionsDirs = [
    join(homedir(), ".vscode", "extensions"),
    join(homedir(), ".vscode-insiders", "extensions"),
    join(homedir(), ".vscode-server", "extensions"),
  ];

  const versions: string[] = [];

  for (const dir of extensionsDirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = execSync(`ls -d "${dir}/horsewhip.horsewhip-*" 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 2000,
      });
      for (const entry of entries.trim().split("\n")) {
        const match = entry.match(/horsewhip-(\d+\.\d+\.\d+)/);
        if (match && match[1]) {
          versions.push(match[1]);
        }
      }
    } catch (e) {
      logger.warn("Horsewhip version scan failed", { error: String(e) });
    }
  }

  // 去重并按 semver 排序
  const unique = [...new Set(versions)].sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
    return 0;
  });

  return { versions: unique, latest: unique[unique.length - 1] ?? null };
}

/** 检查 Horsewhip 是否在活跃 VS Code 扩展列表中 */
function checkHorsewhipActive(): boolean {
  try {
    const out = execSync("code --list-extensions 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    });
    return out.toLowerCase().includes("horsewhip");
  } catch {
    return false;
  }
}

/** 读取 Horsewhip MCP 版本信息（优先 .chitu/config.json，fallback .mcp.json） */
function readMCPConfig(workspaceRoot: string): {
  version: string | null;
  hash: string | null;
} {
  // Priority 1: .chitu/config.json
  const chituCfgPath = join(workspaceRoot, ".chitu", "config.json");
  if (existsSync(chituCfgPath)) {
    try {
      const raw = readFileSync(chituCfgPath, "utf-8");
      const config = JSON.parse(raw);
      const env = config?.mcpServers?.horsewhip?.env ?? {};
      if (env.HORSEWHIP_MCP_VERSION) {
        return {
          version: env.HORSEWHIP_MCP_VERSION ?? null,
          hash: env.HORSEWHIP_MCP_HASH ?? null,
        };
      }
    } catch { /* fall through */ }
  }

  // Priority 2: .mcp.json (legacy)
  const mcpPath = join(workspaceRoot, ".mcp.json");
  if (!existsSync(mcpPath)) return { version: null, hash: null };

  try {
    const raw = readFileSync(mcpPath, "utf-8");
    const config = JSON.parse(raw);
    const horsewhipEnv = config?.mcpServers?.horsewhip?.env ?? {};
    return {
      version: horsewhipEnv.HORSEWHIP_MCP_VERSION ?? null,
      hash: horsewhipEnv.HORSEWHIP_MCP_HASH ?? null,
    };
  } catch {
    return { version: null, hash: null };
  }
}

/** 获取 git 根目录 */
function getGitRoot(workspaceRoot: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel 2>/dev/null", {
      encoding: "utf-8",
      cwd: workspaceRoot,
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

/** 执行完整环境检测 */
export function detectEnv(workspaceRoot?: string): EnvInfo {
  if (cached) return cached;

  const ws = workspaceRoot ?? process.cwd();
  const vscode = checkVSCode();
  const { versions, latest } = scanHorsewhipVersions();
  const mcp = readMCPConfig(ws);

  cached = {
    nodeVersion: process.version,
    os: platform(),
    osArch: arch(),
    osRelease: release(),
    hostname: hostname(),
    workspaceRoot: ws,
    vscodeAvailable: vscode.available,
    vscodeVersion: vscode.version,
    horsewhipPluginVersions: versions,
    horsewhipPluginLatest: latest,
    horsewhipMCPVersion: mcp.version,
    horsewhipMCPHash: mcp.hash,
    horsewhipPluginActive: checkHorsewhipActive(),
    gitRoot: getGitRoot(ws),
    hasChituDir: existsSync(join(ws, ".chitu")),
    homeDir: homedir(),
  };

  return cached;
}

/** 刷新缓存（在环境可能变化后调用） */
export function refreshEnv(workspaceRoot?: string): EnvInfo {
  cached = null;
  return detectEnv(workspaceRoot);
}

/** 检查 Horsewhip MCP 版本是否与最新插件版本一致 */
export function checkHorsewhipVersionMatch(env?: EnvInfo): {
  match: boolean;
  mcpVersion: string | null;
  pluginLatest: string | null;
  message: string;
} {
  const e = env ?? detectEnv();
  const mcpVer = e.horsewhipMCPVersion;
  const pluginLatest = e.horsewhipPluginLatest;

  if (!mcpVer || !pluginLatest) {
    return {
      match: true, // 无法判断时默认匹配
      mcpVersion: mcpVer,
      pluginLatest,
      message: !mcpVer
        ? "无法读取 MCP 配置中的 Horsewhip 版本"
        : "未检测到已安装的 Horsewhip 插件",
    };
  }

  const match = mcpVer === pluginLatest;
  return {
    match,
    mcpVersion: mcpVer,
    pluginLatest,
    message: match
      ? `✅ Horsewhip MCP (v${mcpVer}) 与最新插件版本一致`
      : `⚠️ Horsewhip MCP 引用 v${mcpVer}，但已安装 v${pluginLatest}。运行 chitu sync 更新`,
  };
}

/** 渲染环境报告 */
export function renderEnvReport(env?: EnvInfo): string {
  const e = env ?? detectEnv();
  const lines: string[] = [
    "╔══════════════════════════════════════════╗",
    "║  Chitu 环境检测报告                       ║",
    "╠══════════════════════════════════════════╣",
    `║  Node.js    ${e.nodeVersion.padEnd(30)} ║`,
    `║  OS         ${(e.os + " " + e.osArch + " " + e.osRelease).padEnd(30)} ║`,
    `║  主机        ${e.hostname.padEnd(30)} ║`,
    `║  工作目录    ${e.workspaceRoot.padEnd(30)} ║`,
    `║  Git 根目录  ${(e.gitRoot ?? "N/A").padEnd(30)} ║`,
    `║                                          ║`,
    `║  VS Code    ${e.vscodeAvailable ? `v${e.vscodeVersion ?? "?"}`.padEnd(30) : "不可用".padEnd(30)} ║`,
    `║  Horsewhip  ${e.horsewhipPluginActive ? "活跃".padEnd(30) : "未激活".padEnd(30)} ║`,
    `║  插件版本    ${(e.horsewhipPluginLatest ?? "未安装").padEnd(30)} ║`,
    `║  MCP 版本    ${(e.horsewhipMCPVersion ?? "未配置").padEnd(30)} ║`,
    `║  已安装版本  ${(e.horsewhipPluginVersions.join(", ") || "无").padEnd(30)} ║`,
    `║                                          ║`,
    `║  有 .chitu   ${e.hasChituDir ? "✅".padEnd(30) : "❌".padEnd(30)} ║`,
    `╚══════════════════════════════════════════╝`,
  ];

  // 版本一致性检查
  if (e.horsewhipMCPVersion && e.horsewhipPluginLatest) {
    const check = checkHorsewhipVersionMatch(e);
    if (!check.match) {
      lines.push(`\n⚠️  ${check.message}`);
    }
  }

  return lines.join("\n");
}

export default { detectEnv, refreshEnv, checkHorsewhipVersionMatch, renderEnvReport };
