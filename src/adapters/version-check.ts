/**
 * version-check.ts — 版本感知模块
 *
 * 自适应能力：检测赤兔自身版本、MCP 工具版本、
 * VS Code 插件版本，并提供版本对比和更新建议。
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// Types
// ============================================================

export interface ChituVersion {
  /** 版本号 */
  version: string;
  /** 名称 */
  name: string;
  /** 描述 */
  description: string;
  /** package.json 路径 */
  packagePath: string;
}

export interface VersionDiff {
  /** 组件名称 */
  component: string;
  /** 当前版本 */
  current: string;
  /** 最新版本 */
  latest: string | null;
  /** 是否一致 */
  match: boolean;
  /** 是否需要升级 */
  needsUpgrade: boolean;
}

export interface VersionReport {
  /** 赤兔自身版本 */
  chitu: ChituVersion | null;
  /** 版本差异列表 */
  diffs: VersionDiff[];
  /** 总版本数 */
  total: number;
  /** 匹配数 */
  matched: number;
  /** 不匹配数 */
  mismatched: number;
}

// ============================================================
// 赤兔版本
// ============================================================

/** 获取赤兔自身版本信息 */
export function getChituVersion(): ChituVersion | null {
  // 尝试从 package.json 读取
  const tryPaths = [
    join(process.cwd(), "package.json"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json"),
  ];

  for (const pkgPath of tryPaths) {
    if (!existsSync(pkgPath)) continue;
    try {
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg.name && pkg.version) {
        return {
          version: pkg.version,
          name: pkg.name,
          description: pkg.description ?? "",
          packagePath: pkgPath,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

// ============================================================
// MCP 版本检查
// ============================================================

/** 读取 Horsewhip MCP 版本（优先 .chitu/config.json，fallback .mcp.json） */
export function getMCPVersion(workspaceRoot?: string): string | null {
  const root = workspaceRoot ?? process.cwd();

  // Priority 1: .chitu/config.json
  const chituCfgPath = join(root, ".chitu", "config.json");
  if (existsSync(chituCfgPath)) {
    try {
      const raw = readFileSync(chituCfgPath, "utf-8");
      const config = JSON.parse(raw);
      const ver = config?.mcpServers?.horsewhip?.env?.HORSEWHIP_MCP_VERSION;
      if (ver) return ver;
    } catch { /* fall through */ }
  }

  // Priority 2: .mcp.json (legacy)
  const mcpPath = join(root, ".mcp.json");
  if (!existsSync(mcpPath)) return null;

  try {
    const raw = readFileSync(mcpPath, "utf-8");
    const config = JSON.parse(raw);
    return config?.mcpServers?.horsewhip?.env?.HORSEWHIP_MCP_VERSION ?? null;
  } catch {
    return null;
  }
}

// ============================================================
// 版本对比
// ============================================================

/**
 * 对比多个组件的版本
 * @param components 组件名称和当前版本
 * @param latestMap 最新版本映射
 */
export function compareVersions(
  components: Array<{ component: string; current: string }>,
  latestMap: Record<string, string | null>
): VersionDiff[] {
  return components.map(({ component, current }) => {
    const latest = latestMap[component] ?? null;
    return {
      component,
      current,
      latest,
      match: latest ? current === latest : true,
      needsUpgrade: latest ? current !== latest : false,
    };
  });
}

// ============================================================
// 渲染
// ============================================================

/** 渲染版本报告 */
export function renderVersionReport(report: VersionReport): string {
  const lines: string[] = [
    "╔══════════════════════════════════════════╗",
    "║  Chitu 版本报告                          ║",
    "╠══════════════════════════════════════════╣",
  ];

  if (report.chitu) {
    lines.push(
      `║  赤兔        v${report.chitu.version.padEnd(30)} ║`,
      `║  名称        ${report.chitu.name.padEnd(30)} ║`,
      `║  描述        ${report.chitu.description.slice(0, 28).padEnd(30)} ║`,
    );
  } else {
    lines.push(`║  赤兔        (未检测到 package.json)    ║`);
  }

  lines.push(`║                                          ║`);

  if (report.diffs.length > 0) {
    lines.push(`║  组件版本对比:                           ║`);
    for (const d of report.diffs) {
      const status = d.match ? "✅" : "⚠️";
      const ver = d.latest
        ? `${d.current} → ${d.latest}`
        : d.current;
      lines.push(`║  ${status} ${d.component.padEnd(12)} ${ver.padEnd(28)} ║`);
    }
  }

  lines.push(
    `║                                          ║`,
    `║  总组件      ${report.total.toString().padEnd(30)} ║`,
    `║  匹配        ${report.matched.toString().padEnd(30)} ║`,
    `║  不匹配      ${report.mismatched.toString().padEnd(30)} ║`,
    `╚══════════════════════════════════════════╝`,
  );

  return lines.join("\n");
}

export default {
  getChituVersion,
  getMCPVersion,
  compareVersions,
  renderVersionReport,
};
