/**
 * anchor.ts — Horsewhip 安全锚点系统
 *
 * 衰退兜底机制的核心：
 * 每次完美运行状态都被记录为"锚点"，
 * 任何故障都能回退到最近的安全锚点。
 *
 * 三层架构：
 *   L1 — Git Tag 锚点（秒级回退）
 *   L2 — 文件快照锚点（文件级备份）
 *   L3 — 审计链锚点（永久变更追溯）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";

// ============================================================
// Types
// ============================================================

export type AnchorSeverity = "safe" | "warning" | "critical";

export interface AnchorPoint {
  /** 唯一锚点 ID */
  id: string;
  /** 人类可读标签 */
  label: string;
  /** 创建时间 */
  createdAt: string;
  /** 锚点类型 */
  type: "git-tag" | "snapshot" | "milestone";
  /** 严重级别 */
  severity: AnchorSeverity;
  /** Git commit hash（如果有） */
  commitHash: string | null;
  /** Git tag 名称（如果有） */
  tagName: string | null;
  /** 快照目录路径（如果有） */
  snapshotDir: string | null;
  /** 关联的变更记录 ID */
  auditIds: string[];
  /** 元数据 */
  metadata: Record<string, string>;
}

export interface RollbackPlan {
  /** 回滚目标锚点 */
  targetId: string;
  /** 回滚方式 */
  method: "git-reset" | "git-revert" | "snapshot-restore" | "hybrid";
  /** 风险等级 */
  risk: "low" | "medium" | "high";
  /** 回滚步骤 */
  steps: string[];
  /** 预期影响 */
  impacts: string[];
}

export interface CrashRecord {
  /** 事故 ID */
  id: string;
  /** 发生时间 */
  happenedAt: string;
  /** 锚点 ID（事故发生前的最后一个锚点） */
  lastAnchorId: string | null;
  /** 事故描述 */
  description: string;
  /** 推测原因 */
  cause: string;
  /** 是否可回退 */
  recoverable: boolean;
  /** 推荐的回滚方案 */
  recommendedAction: string;
  /** 关联文件列表 */
  affectedFiles: string[];
  /** 事故时的 Changeset 内容 */
  changeset: string | null;
}

// ============================================================
// 锚点目录
// ============================================================

const SNAPSHOTS_DIR = ".chitu/snapshots";
const ANCHOR_DB = ".chitu/anchors.json";
const CRASH_DB = ".chitu/crashes.json";

function getWorkspaceRoot(): string {
  return process.cwd();
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================
// L1 — Git Tag 锚点
// ============================================================

/** 获取当前 Git commit hash */
function getCurrentCommit(): string | null {
  try {
    return execSync("git rev-parse HEAD 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

/** 获取当前 Git 是否有未提交的变更 */
function hasUncommittedChanges(): boolean {
  try {
    const status = execSync("git status --porcelain 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

/** 创建 Git tag 锚点 */
export function createGitAnchor(label: string, severity: AnchorSeverity = "safe"): AnchorPoint | null {
  const commitHash = getCurrentCommit();
  if (!commitHash) return null;

  const ws = getWorkspaceRoot();
  const tagName = `anchor/${label}-${Date.now()}`;

  // 只有无未提交变更时才打 tag
  if (!hasUncommittedChanges()) {
    try {
      execSync(`git tag -f "${tagName}" "${commitHash}" -m "Chitu anchor: ${label}"`, {
        encoding: "utf-8",
        cwd: ws,
        timeout: 3000,
      });
    } catch (e) {
      logger.warn("Failed to create git tag", { error: String(e) });
    }
  }

  const anchor: AnchorPoint = {
    id: `anchor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    label,
    createdAt: new Date().toISOString(),
    type: commitHash ? "git-tag" : "milestone",
    severity,
    commitHash,
    tagName: hasUncommittedChanges() ? null : tagName,
    snapshotDir: null,
    auditIds: [],
    metadata: {},
  };

  saveAnchor(anchor);
  return anchor;
}

// ============================================================
// L2 — 文件快照锚点
// ============================================================

/** 创建关键文件的快照备份 */
export function createSnapshot(files: string[], label: string): AnchorPoint | null {
  const ws = getWorkspaceRoot();
  const snapshotId = `snap-${Date.now()}`;
  const snapshotDir = join(ws, SNAPSHOTS_DIR, snapshotId);

  ensureDir(snapshotDir);

  const savedFiles: string[] = [];
  for (const file of files) {
    const absPath = resolve(ws, file);
    if (!existsSync(absPath)) continue;

    const relPath = relative(ws, absPath);
    const targetPath = join(snapshotDir, relPath);
    const targetDir = join(snapshotDir, relative(ws, absPath).split("/").slice(0, -1).join("/"));

    ensureDir(targetDir);
    copyFileSync(absPath, targetPath);
    savedFiles.push(relPath);
  }

  const anchor: AnchorPoint = {
    id: snapshotId,
    label,
    createdAt: new Date().toISOString(),
    type: "snapshot",
    severity: "safe",
    commitHash: getCurrentCommit(),
    tagName: null,
    snapshotDir,
    auditIds: [],
    metadata: {
      fileCount: savedFiles.length.toString(),
      files: savedFiles.join(", "),
    },
  };

  saveAnchor(anchor);
  return anchor;
}

// ============================================================
// L3 — 审计链
// ============================================================

/** 记录一次变更到锚点的审计链 */
export function linkAudit(anchorId: string, auditId: string): void {
  const anchors = loadAnchors();
  const anchor = anchors.find((a) => a.id === anchorId);
  if (anchor) {
    if (!anchor.auditIds.includes(auditId)) {
      anchor.auditIds.push(auditId);
      saveAnchors(anchors);
    }
  }
}

// ============================================================
// 持久化
// ============================================================

function getAnchorDbPath(): string {
  return join(getWorkspaceRoot(), ANCHOR_DB);
}

function getCrashDbPath(): string {
  return join(getWorkspaceRoot(), CRASH_DB);
}

function loadAnchors(): AnchorPoint[] {
  const dbPath = getAnchorDbPath();
  if (!existsSync(dbPath)) return [];
  try {
    return JSON.parse(readFileSync(dbPath, "utf-8"));
  } catch {
    return [];
  }
}

function saveAnchors(anchors: AnchorPoint[]): void {
  const dbPath = getAnchorDbPath();
  ensureDir(join(getWorkspaceRoot(), ".chitu"));
  writeFileSync(dbPath, JSON.stringify(anchors, null, 2), "utf-8");
}

function saveAnchor(anchor: AnchorPoint): void {
  const anchors = loadAnchors();
  anchors.push(anchor);
  saveAnchors(anchors);
}

function loadCrashes(): CrashRecord[] {
  const dbPath = getCrashDbPath();
  if (!existsSync(dbPath)) return [];
  try {
    return JSON.parse(readFileSync(dbPath, "utf-8"));
  } catch {
    return [];
  }
}

function saveCrashes(crashes: CrashRecord[]): void {
  const dbPath = getCrashDbPath();
  ensureDir(join(getWorkspaceRoot(), ".chitu"));
  writeFileSync(dbPath, JSON.stringify(crashes, null, 2), "utf-8");
}

// ============================================================
// 锚点查询
// ============================================================

/** 获取最近的安全锚点 */
export function getLatestAnchor(severity?: AnchorSeverity): AnchorPoint | null {
  const anchors = loadAnchors();
  if (severity) {
    return anchors.filter((a) => a.severity === severity).pop() ?? null;
  }
  return anchors.pop() ?? null;
}

/** 获取所有锚点 */
export function getAllAnchors(): AnchorPoint[] {
  return loadAnchors();
}

/** 按 ID 获取锚点 */
export function getAnchorById(id: string): AnchorPoint | null {
  return loadAnchors().find((a) => a.id === id) ?? null;
}

// ============================================================
// 回滚
// ============================================================

/** 生成回滚方案 */
export function planRollback(targetId: string): RollbackPlan | null {
  const target = getAnchorById(targetId);
  if (!target) return null;

  const ws = getWorkspaceRoot();
  const steps: string[] = [];
  const impacts: string[] = [];

  if (target.commitHash) {
    if (target.tagName && existsSync(join(ws, ".git", "refs", "tags", target.tagName))) {
      // Git tag 回滚 — 最安全
      steps.push(`git checkout ${target.commitHash}`);
      steps.push(`验证代码状态`);
      impacts.push("所有未提交的变更将丢失");
      impacts.push("工作目录将被重置到锚点状态");

      return {
        targetId,
        method: "git-reset",
        risk: "low",
        steps: [
          ...steps,
          `git reset --hard ${target.commitHash}`,
          `确认回滚到 ${target.label} (${target.commitHash.slice(0, 8)})`,
        ],
        impacts,
      };
    }
  }

  if (target.snapshotDir && existsSync(target.snapshotDir)) {
    // 快照回滚
    const files = target.metadata.files?.split(", ") ?? [];
    for (const file of files) {
      const from = join(target.snapshotDir, file);
      const to = join(ws, file);
      if (existsSync(from)) {
        steps.push(`从快照恢复 ${file}`);
      }
    }

    return {
      targetId,
      method: "snapshot-restore",
      risk: "medium",
      steps,
      impacts: ["只有快照中包含的文件会被恢复", "其他文件的变更不受影响"],
    };
  }

  return null;
}

/** 执行回滚 */
export function executeRollback(plan: RollbackPlan): boolean {
  const ws = getWorkspaceRoot();

  try {
    switch (plan.method) {
      case "git-reset": {
        const target = getAnchorById(plan.targetId);
        if (target?.commitHash) {
          execSync(`git reset --hard ${target.commitHash}`, {
            encoding: "utf-8",
            cwd: ws,
            timeout: 10000,
          });
          return true;
        }
        return false;
      }

      case "git-revert": {
        const target = getAnchorById(plan.targetId);
        if (target?.commitHash) {
          execSync(`git revert --no-edit ${target.commitHash}..HEAD`, {
            encoding: "utf-8",
            cwd: ws,
            timeout: 15000,
          });
          return true;
        }
        return false;
      }

      case "snapshot-restore": {
        const target = getAnchorById(plan.targetId);
        if (target?.snapshotDir && existsSync(target.snapshotDir)) {
          const files = target.metadata.files?.split(", ") ?? [];
          for (const file of files) {
            const from = join(target.snapshotDir, file);
            const to = join(ws, file);
            if (existsSync(from)) {
              copyFileSync(from, to);
            }
          }
          return true;
        }
        return false;
      }

      case "hybrid": {
        // 先 git-reset，再 snapshot-restore 补充
        const target = getAnchorById(plan.targetId);
        if (target?.commitHash) {
          execSync(`git reset --hard ${target.commitHash}`, {
            encoding: "utf-8",
            cwd: ws,
            timeout: 10000,
          });
        }
        if (target?.snapshotDir && existsSync(target.snapshotDir)) {
          const files = target.metadata.files?.split(", ") ?? [];
          for (const file of files) {
            const from = join(target.snapshotDir, file);
            const to = join(ws, file);
            if (existsSync(from)) {
              copyFileSync(from, to);
            }
          }
        }
        return true;
      }
    }
  } catch (e) {
    console.error(`Rollback failed: ${e}`);
    return false;
  }

  return false;
}

// ============================================================
// 事故记录
// ============================================================

/** 记录一次事故 */
export function recordCrash(
  description: string,
  cause: string,
  affectedFiles: string[],
  changeset?: string
): CrashRecord {
  const lastAnchor = getLatestAnchor();

  const crash: CrashRecord = {
    id: `crash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    happenedAt: new Date().toISOString(),
    lastAnchorId: lastAnchor?.id ?? null,
    description,
    cause,
    recoverable: lastAnchor !== null,
    recommendedAction: lastAnchor
      ? `回退到锚点 "${lastAnchor.label}" (${lastAnchor.id})`
      : "无可用锚点，需手动修复",
    affectedFiles,
    changeset: changeset ?? null,
  };

  const crashes = loadCrashes();
  crashes.push(crash);
  saveCrashes(crashes);

  return crash;
}

/** 获取所有事故记录 */
export function getCrashHistory(): CrashRecord[] {
  return loadCrashes();
}

/** 获取最近的事故 */
export function getLatestCrash(): CrashRecord | null {
  const crashes = loadCrashes();
  return crashes.pop() ?? null;
}

// ============================================================
// 自编程安全包装
// ============================================================

/**
 * 在自编程操作前自动创建锚点
 * 在自编程操作后记录变更
 */
export function beforeSelfEdit(files: string[], label: string): AnchorPoint {
  // L1: Git 锚点
  const gitAnchor = createGitAnchor(`before-${label}`);

  // L2: 快照锚点
  const snapAnchor = createSnapshot(files, `snapshot-before-${label}`);

  // 返回快照锚点（更精确）
  return snapAnchor ?? gitAnchor ?? {
    id: `manual-${Date.now()}`,
    label,
    createdAt: new Date().toISOString(),
    type: "milestone",
    severity: "warning",
    commitHash: getCurrentCommit(),
    tagName: null,
    snapshotDir: null,
    auditIds: [],
    metadata: { note: "锚点创建失败" },
  };
}

/**
 * 事故恢复入口
 * 自动找到最近锚点并执行回滚
 */
export function autoRecover(): {
  recovered: boolean;
  crash: CrashRecord | null;
  plan: RollbackPlan | null;
} {
  const lastCrash = getLatestCrash();
  if (!lastCrash) {
    return { recovered: false, crash: null, plan: null };
  }

  if (!lastCrash.recoverable || !lastCrash.lastAnchorId) {
    return { recovered: false, crash: lastCrash, plan: null };
  }

  const plan = planRollback(lastCrash.lastAnchorId);
  if (!plan) {
    return { recovered: false, crash: lastCrash, plan: null };
  }

  const success = executeRollback(plan);
  return { recovered: success, crash: lastCrash, plan };
}

export default {
  createGitAnchor,
  createSnapshot,
  getLatestAnchor,
  getAllAnchors,
  getAnchorById,
  planRollback,
  executeRollback,
  recordCrash,
  getCrashHistory,
  getLatestCrash,
  beforeSelfEdit,
  autoRecover,
};
