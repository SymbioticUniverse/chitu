/**
 * recovery.ts — 衰退兜底恢复引擎
 *
 * 启动时自动执行：
 * 1. 检查上一次运行是否有事故记录
 * 2. 如果有 → 自动回退到最近锚点
 * 3. 如果回退成功 → 记录回退日志
 * 4. 如果回退失败 → 标记为不可恢复，等待人工介入
 */

import {
  getLatestCrash,
  getLatestAnchor,
  getAnchorById,
  planRollback,
  executeRollback,
  recordCrash,
  createGitAnchor,
  createSnapshot,
  getAllAnchors,
  type CrashRecord,
  type RollbackPlan,
  type AnchorPoint,
} from "./anchor.js";

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// Types
// ============================================================

export type RecoveryStatus = "none" | "recovered" | "failed" | "manual";

export interface RecoveryResult {
  status: RecoveryStatus;
  crash: CrashRecord | null;
  plan: RollbackPlan | null;
  executedAt: string;
  message: string;
  anchor: AnchorPoint | null;
}

export interface HealthCheckResult {
  healthy: boolean;
  lastCrash: CrashRecord | null;
  lastAnchor: AnchorPoint | null;
  recoveryNeeded: boolean;
  recentAnchorCount: number;
}

// ============================================================
// 健康检查
// ============================================================

const HEALTH_FILE = ".chitu/health.json";

interface HealthRecord {
  lastHealthyAt: string;
  lastCrashAt: string | null;
  crashCount: number;
  recoveryCount: number;
}

function loadHealthRecord(): HealthRecord {
  const ws = process.cwd();
  const path = join(ws, HEALTH_FILE);
  if (!existsSync(path)) {
    return { lastHealthyAt: new Date().toISOString(), lastCrashAt: null, crashCount: 0, recoveryCount: 0 };
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { lastHealthyAt: new Date().toISOString(), lastCrashAt: null, crashCount: 0, recoveryCount: 0 };
  }
}

function saveHealthRecord(record: HealthRecord): void {
  const ws = process.cwd();
  const path = join(ws, HEALTH_FILE);
  const dir = join(ws, ".chitu");
  if (!existsSync(dir)) {
    // 静默失败——目录可能不存在
    return;
  }
  writeFileSync(path, JSON.stringify(record, null, 2), "utf-8");
}

/** 执行系统健康检查 */
export function healthCheck(): HealthCheckResult {
  const lastCrash = getLatestCrash();
  const lastAnchor = getLatestAnchor();
  const allAnchors = getAllAnchors();

  return {
    healthy: !lastCrash || lastCrash.recoverable === false
      ? lastCrash === null
      : lastAnchor !== null,
    lastCrash,
    lastAnchor,
    recoveryNeeded: lastCrash !== null && lastCrash.recoverable,
    recentAnchorCount: allAnchors.length,
  };
}

// ============================================================
// 自动恢复
// ============================================================

/** 执行自动恢复流程 */
export function autoRecover(): RecoveryResult {
  const now = new Date().toISOString();
  const health = loadHealthRecord();

  // 检查是否有事故需要恢复
  const lastCrash = getLatestCrash();
  if (!lastCrash) {
    return {
      status: "none",
      crash: null,
      plan: null,
      executedAt: now,
      message: "系统健康，无需恢复",
      anchor: getLatestAnchor(),
    };
  }

  // 检查事故是否可恢复
  if (!lastCrash.recoverable || !lastCrash.lastAnchorId) {
    return {
      status: "manual",
      crash: lastCrash,
      plan: null,
      executedAt: now,
      message: `事故 ${lastCrash.id} 不可自动恢复，需人工介入。原因: ${lastCrash.cause}`,
      anchor: getLatestAnchor(),
    };
  }

  // 获取目标锚点
  const targetAnchor = getAnchorById(lastCrash.lastAnchorId);
  if (!targetAnchor) {
    return {
      status: "failed",
      crash: lastCrash,
      plan: null,
      executedAt: now,
      message: `锚点 ${lastCrash.lastAnchorId} 已丢失，无法回滚`,
      anchor: null,
    };
  }

  // 生成并执行回滚方案
  const plan = planRollback(lastCrash.lastAnchorId);
  if (!plan) {
    return {
      status: "failed",
      crash: lastCrash,
      plan: null,
      executedAt: now,
      message: `无法为锚点 ${lastCrash.lastAnchorId} 生成回滚方案`,
      anchor: targetAnchor,
    };
  }

  // 执行回滚
  const success = executeRollback(plan);
  if (success) {
    // 更新健康记录
    health.recoveryCount++;
    health.lastCrashAt = lastCrash.happenedAt;
    saveHealthRecord(health);

    // 创建恢复后的新锚点
    const newAnchor = createGitAnchor("after-recovery", "warning");

    return {
      status: "recovered",
      crash: lastCrash,
      plan,
      executedAt: now,
      message: `✅ 已自动回退到锚点 "${targetAnchor.label}" (${lastCrash.lastAnchorId})`,
      anchor: newAnchor,
    };
  } else {
    return {
      status: "failed",
      crash: lastCrash,
      plan,
      executedAt: now,
      message: `❌ 回滚执行失败，需人工介入`,
      anchor: targetAnchor,
    };
  }
}

// ============================================================
// 自编程钩子
// ============================================================

/**
 * 自编程开始前调用——创建安全锚点
 * 应在任何自我修改前执行
 */
export function beforeMutation(files: string[], taskLabel: string): AnchorPoint {
  // 先检查健康状态
  const health = healthCheck();
  if (!health.healthy && health.recoveryNeeded) {
    console.warn(`⚠️  检测到未恢复的事故，建议先执行 autoRecover()`);
  }

  createGitAnchor(`before-${taskLabel}`);
  return createSnapshot(files, `snapshot-before-${taskLabel}`) ?? {
    id: `fallback-${Date.now()}`,
    label: taskLabel,
    type: "snapshot" as const,
    severity: "warning" as const,
    createdAt: new Date().toISOString(),
    commitHash: null,
    tagName: null,
    snapshotDir: null,
    auditIds: [],
    metadata: { reason: "fallback-no-snapshot" },
  };
}

// ============================================================
// 渲染
// ============================================================

/** 渲染健康状况报告 */
export function renderHealthReport(result?: HealthCheckResult): string {
  const h = result ?? healthCheck();

  const lines = [
    "╔══════════════════════════════════════════╗",
    "║  Chitu 健康检查报告                       ║",
    "╠══════════════════════════════════════════╣",
    `║  状态        ${h.healthy ? "✅ 健康".padEnd(28) : "❌ 异常".padEnd(28)} ║`,
  ];

  if (h.lastCrash) {
    lines.push(
      `║  最近事故    ${h.lastCrash.id.padEnd(30)} ║`,
      `║  事故原因    ${h.lastCrash.cause.slice(0, 26).padEnd(30)} ║`,
      `║  可恢复      ${h.lastCrash.recoverable ? "✅".padEnd(30) : "❌ 需人工".padEnd(30)} ║`,
    );
  }

  lines.push(
    `║  锚点数量    ${h.recentAnchorCount.toString().padEnd(30)} ║`,
    `║  需恢复      ${h.recoveryNeeded ? "⚠️ 是".padEnd(28) : "✅ 否".padEnd(28)} ║`,
  );

  if (h.lastAnchor) {
    lines.push(
      `║  最近锚点    ${h.lastAnchor.label.slice(0, 26).padEnd(30)} ║`,
      `║  锚点时间    ${h.lastAnchor.createdAt.slice(0, 19).padEnd(30)} ║`,
    );
  }

  lines.push(`╚══════════════════════════════════════════╝`);

  return lines.join("\n");
}

/** 渲染恢复结果 */
export function renderRecoveryResult(result: RecoveryResult): string {
  const statusEmoji: Record<RecoveryStatus, string> = {
    none: "✅",
    recovered: "🔄",
    failed: "❌",
    manual: "⚠️",
  };

  const lines = [
    "╔══════════════════════════════════════════╗",
    "║  衰退兜底恢复报告                         ║",
    "╠══════════════════════════════════════════╣",
    `║  状态   ${statusEmoji[result.status]} ${result.status.padEnd(27)} ║`,
    `║  时间   ${result.executedAt.slice(0, 19).padEnd(30)} ║`,
    `║                                          ║`,
    `║  ${result.message.slice(0, 42).padEnd(42)} ║`,
  ];

  if (result.plan) {
    lines.push(
      `║                                          ║`,
      `║  回滚方案:                                ║`,
      ...result.plan.steps.map((s, i) => `║  ${(i + 1)}. ${s.slice(0, 38).padEnd(39)} ║`),
      `║  风险: ${result.plan!.risk.padEnd(36)} ║`,
    );
  }

  lines.push(`╚══════════════════════════════════════════╝`);

  return lines.join("\n");
}

export default {
  healthCheck,
  autoRecover,
  beforeMutation,
  renderHealthReport,
  renderRecoveryResult,
};
