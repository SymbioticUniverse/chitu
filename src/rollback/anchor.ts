import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";
import {
  getWorkspaceRoot, getCurrentCommit, hasUncommittedChanges,
  loadAnchors, loadCrashes, saveCrashes, saveAnchors, saveAnchor,
  createSnapshot, planSnapshotRestore, executeSnapshotRestore,
} from "./snapshot.js";

export { createSnapshot };

export type AnchorSeverity = "safe" | "warning" | "critical";

export interface AnchorPoint {
  id: string; label: string; createdAt: string;
  type: "git-tag" | "snapshot" | "milestone"; severity: AnchorSeverity;
  commitHash: string | null; tagName: string | null; snapshotDir: string | null;
  auditIds: string[]; metadata: Record<string, string>;
}

export interface RollbackPlan {
  targetId: string; method: "git-reset" | "git-revert" | "snapshot-restore" | "hybrid";
  risk: "low" | "medium" | "high"; steps: string[]; impacts: string[];
}

export interface CrashRecord {
  id: string; happenedAt: string; lastAnchorId: string | null;
  description: string; cause: string; recoverable: boolean;
  recommendedAction: string; affectedFiles: string[]; changeset: string | null;
}

export function createGitAnchor(label: string, severity: AnchorSeverity = "safe"): AnchorPoint | null {
  const ch = getCurrentCommit();
  if (!ch) return null;
  const ws = getWorkspaceRoot(), tag = `anchor/${label}-${Date.now()}`;
  if (!hasUncommittedChanges()) {
    try { execSync(`git tag -f "${tag}" "${ch}" -m "Chitu anchor: ${label}"`, { encoding: "utf-8", cwd: ws, timeout: 3000 }); }
    catch (e) { logger.warn("Failed to create git tag", { error: String(e) }); }
  }
  const a: AnchorPoint = {
    id: `anchor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, label,
    createdAt: new Date().toISOString(), type: ch ? "git-tag" : "milestone", severity,
    commitHash: ch, tagName: hasUncommittedChanges() ? null : tag,
    snapshotDir: null, auditIds: [], metadata: {},
  };
  saveAnchor(a); return a;
}

export function linkAudit(anchorId: string, auditId: string): void {
  const anchors = loadAnchors();
  const a = anchors.find((x) => x.id === anchorId);
  if (a && !a.auditIds.includes(auditId)) { a.auditIds.push(auditId); saveAnchors(anchors); }
}

export function getLatestAnchor(severity?: AnchorSeverity): AnchorPoint | null {
  const anchors = loadAnchors();
  return severity ? (anchors.filter((a) => a.severity === severity).pop() ?? null) : (anchors.pop() ?? null);
}

export function getAllAnchors(): AnchorPoint[] { return loadAnchors(); }

export function getAnchorById(id: string): AnchorPoint | null {
  return loadAnchors().find((a) => a.id === id) ?? null;
}

export function planRollback(targetId: string): RollbackPlan | null {
  const t = getAnchorById(targetId);
  if (!t) return null;
  if (t.commitHash && t.tagName && existsSync(join(getWorkspaceRoot(), ".git", "refs", "tags", t.tagName))) {
    return {
      targetId, method: "git-reset", risk: "low",
      steps: [`git checkout ${t.commitHash}`, "验证代码状态", `git reset --hard ${t.commitHash}`, `确认回滚到 ${t.label} (${t.commitHash.slice(0, 8)})`],
      impacts: ["所有未提交的变更将丢失", "工作目录将被重置到锚点状态"],
    };
  }
  return planSnapshotRestore(t);
}

export function executeRollback(plan: RollbackPlan): boolean {
  const ws = getWorkspaceRoot();
  try {
    switch (plan.method) {
      case "git-reset": { const t = getAnchorById(plan.targetId); if (!t?.commitHash) return false; execSync(`git reset --hard ${t.commitHash}`, { encoding: "utf-8", cwd: ws, timeout: 10000 }); return true; }
      case "git-revert": { const t = getAnchorById(plan.targetId); if (!t?.commitHash) return false; execSync(`git revert --no-edit ${t.commitHash}..HEAD`, { encoding: "utf-8", cwd: ws, timeout: 15000 }); return true; }
      case "snapshot-restore": { const t = getAnchorById(plan.targetId); return t ? executeSnapshotRestore(t) : false; }
      case "hybrid": { const t = getAnchorById(plan.targetId); if (t?.commitHash) execSync(`git reset --hard ${t.commitHash}`, { encoding: "utf-8", cwd: ws, timeout: 10000 }); if (t) executeSnapshotRestore(t); return true; }
    }
  } catch (e) { console.error(`Rollback failed: ${e}`); return false; }
  return false;
}

export function recordCrash(desc: string, cause: string, affectedFiles: string[], changeset?: string): CrashRecord {
  const la = getLatestAnchor();
  const c: CrashRecord = {
    id: `crash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    happenedAt: new Date().toISOString(), lastAnchorId: la?.id ?? null,
    description: desc, cause, recoverable: la !== null,
    recommendedAction: la ? `回退到锚点 "${la.label}" (${la.id})` : "无可用锚点，需手动修复",
    affectedFiles, changeset: changeset ?? null,
  };
  const crashes = loadCrashes(); crashes.push(c); saveCrashes(crashes); return c;
}

export function getCrashHistory(): CrashRecord[] { return loadCrashes(); }
export function getLatestCrash(): CrashRecord | null { return loadCrashes().pop() ?? null; }

export function beforeSelfEdit(files: string[], label: string): AnchorPoint {
  const ga = createGitAnchor(`before-${label}`);
  const sa = createSnapshot(files, `snapshot-before-${label}`);
  return sa ?? ga ?? {
    id: `manual-${Date.now()}`, label, createdAt: new Date().toISOString(),
    type: "milestone", severity: "warning", commitHash: getCurrentCommit(), tagName: null,
    snapshotDir: null, auditIds: [], metadata: { note: "锚点创建失败" },
  };
}

export function autoRecover(): { recovered: boolean; crash: CrashRecord | null; plan: RollbackPlan | null } {
  const lc = getLatestCrash();
  if (!lc) return { recovered: false, crash: null, plan: null };
  if (!lc.recoverable || !lc.lastAnchorId) return { recovered: false, crash: lc, plan: null };
  const p = planRollback(lc.lastAnchorId);
  if (!p) return { recovered: false, crash: lc, plan: null };
  return { recovered: executeRollback(p), crash: lc, plan: p };
}

export default { createGitAnchor, createSnapshot, getLatestAnchor, getAllAnchors, getAnchorById, planRollback, executeRollback, recordCrash, getCrashHistory, getLatestCrash, beforeSelfEdit, autoRecover };
