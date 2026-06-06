/**
 * safe-mutation.ts — 安全自编程包装器
 *
 * 每次自编程操作自动执行：
 * 1. 创建快照锚点（L2）
 * 2. 执行操作
 * 3. 如果失败 → 记录事故 → 自动回滚
 * 4. 如果成功 → 创建 Git 锚点（L1）
 */

import {
  createSnapshot,
  createGitAnchor,
  recordCrash,
  getLatestAnchor,
  planRollback,
  executeRollback,
  getAllAnchors,
  type AnchorPoint,
  type CrashRecord,
} from "./anchor.js";

// ============================================================
// Types
// ============================================================

export interface MutationResult<T> {
  success: boolean;
  data: T | null;
  anchor: AnchorPoint | null;
  crash: CrashRecord | null;
  error: string | null;
  rolledBack: boolean;
  duration: number;
}

export interface MutationOptions {
  /** 操作标签 */
  label: string;
  /** 涉及的文件列表（自动快照） */
  files: string[];
  /** 超时时间 (ms) */
  timeout?: number;
  /** 失败时是否自动回滚 */
  autoRollback?: boolean;
}

// ============================================================
// 安全执行
// ============================================================

/**
 * 安全执行自编程操作
 *
 * 用法：
 * ```ts
 * const result = await safeMutation({
 *   label: "优化上下文管理",
 *   files: ["src/agent.ts"],
 *   autoRollback: true,
 * }, async () => {
 *   // 执行自编程操作
 *   await editAgentContext();
 * });
 * ```
 */
export async function safeMutation<T>(
  options: MutationOptions,
  fn: () => Promise<T> | T
): Promise<MutationResult<T>> {
  const { label, files, autoRollback = true } = options;
  const startTime = Date.now();

  // 1. 创建快照锚点
  const snapshotAnchor = createSnapshot(files, `snapshot-before-${label}`);
  if (!snapshotAnchor) {
    return {
      success: false,
      data: null,
      anchor: null,
      crash: null,
      error: "创建快照锚点失败",
      rolledBack: false,
      duration: Date.now() - startTime,
    };
  }

  try {
    // 2. 执行操作
    const data = await fn();

    // 3. 成功 → 创建 Git 锚点
    const anchor = createGitAnchor(`after-${label}`);

    return {
      success: true,
      data,
      anchor: anchor ?? snapshotAnchor,
      crash: null,
      error: null,
      rolledBack: false,
      duration: Date.now() - startTime,
    };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);

    // 4. 记录事故
    const crash = recordCrash(
      `自编程操作 "${label}" 失败`,
      errorMsg,
      files
    );

    // 5. 自动回滚
    let rolledBack = false;
    if (autoRollback && snapshotAnchor.id) {
      const plan = planRollback(snapshotAnchor.id);
      if (plan) {
        rolledBack = executeRollback(plan);
      }
    }

    return {
      success: false,
      data: null,
      anchor: snapshotAnchor,
      crash,
      error: errorMsg,
      rolledBack,
      duration: Date.now() - startTime,
    };
  }
}

// ============================================================
// 渲染
// ============================================================

export function renderMutationResult<T>(
  result: MutationResult<T>,
  label: string
): string {
  const lines: string[] = [
    "╔══════════════════════════════════════════╗",
    `║  自编程: ${label.padEnd(32)} ║`,
    "╠══════════════════════════════════════════╣",
    `║  状态     ${result.success ? "✅ 成功".padEnd(28) : "❌ 失败".padEnd(28)} ║`,
    `║  耗时     ${result.duration.toString().padEnd(6)}ms${" ".repeat(22)} ║`,
  ];

  if (result.rolledBack) {
    lines.push(`║  已回滚   ✅ 已安全回退到锚点           ║`);
  }

  if (result.crash) {
    lines.push(
      `║                                          ║`,
      `║  事故ID   ${result.crash.id.padEnd(30)} ║`,
      `║  原因     ${result.crash.cause.slice(0, 26).padEnd(30)} ║`,
    );
  }

  if (result.error) {
    lines.push(
      `║                                          ║`,
      `║  错误:                                   ║`,
      `║  ${result.error.slice(0, 40).padEnd(40)} ║`,
    );
  }

  lines.push(`╚══════════════════════════════════════════╝`);

  return lines.join("\n");
}

export default {
  safeMutation,
  renderMutationResult,
};
