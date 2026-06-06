/**
 * rollback/index.ts — 衰退兜底机制统一入口
 *
 * 赤兔底层的安全锚系统。
 * 每次自编程操作前自动创建锚点，
 * 每次启动时自动检查事故并恢复。
 */

export {
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
  autoRecover as anchorAutoRecover,
  linkAudit,
} from "./anchor.js";

export type {
  AnchorPoint,
  AnchorSeverity,
  RollbackPlan,
  CrashRecord,
} from "./anchor.js";

export {
  healthCheck,
  autoRecover,
  beforeMutation,
  renderHealthReport,
  renderRecoveryResult,
} from "./recovery.js";

export type {
  RecoveryStatus,
  RecoveryResult,
  HealthCheckResult,
} from "./recovery.js";

export {
  safeMutation,
  renderMutationResult,
} from "./safe-mutation.js";

export type {
  MutationResult,
  MutationOptions,
} from "./safe-mutation.js";
