import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { execSync } from "node:child_process";
import type { AnchorPoint, RollbackPlan, CrashRecord } from "./anchor.js";

export const SNAPSHOTS_DIR = ".chitu/snapshots";
export const ANCHOR_DB = ".chitu/anchors.json";
export const CRASH_DB = ".chitu/crashes.json";

export function getWorkspaceRoot(): string { return process.cwd(); }
export function ensureDir(dir: string): void { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }

export function getCurrentCommit(): string | null {
  try { return execSync("git rev-parse HEAD 2>/dev/null", { encoding: "utf-8", timeout: 3000 }).trim(); }
  catch { return null; }
}

export function hasUncommittedChanges(): boolean {
  try { return execSync("git status --porcelain 2>/dev/null", { encoding: "utf-8", timeout: 3000 }).trim().length > 0; }
  catch { return false; }
}

export function getAnchorDbPath(): string { return join(getWorkspaceRoot(), ANCHOR_DB); }
export function getCrashDbPath(): string { return join(getWorkspaceRoot(), CRASH_DB); }

export function loadAnchors(): AnchorPoint[] {
  const p = getAnchorDbPath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return []; }
}

export function saveAnchors(anchors: AnchorPoint[]): void {
  ensureDir(join(getWorkspaceRoot(), ".chitu"));
  writeFileSync(getAnchorDbPath(), JSON.stringify(anchors, null, 2), "utf-8");
}

export function saveAnchor(anchor: AnchorPoint): void { const a = loadAnchors(); a.push(anchor); saveAnchors(a); }

export function loadCrashes(): CrashRecord[] {
  const p = getCrashDbPath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return []; }
}

export function saveCrashes(crashes: CrashRecord[]): void {
  ensureDir(join(getWorkspaceRoot(), ".chitu"));
  writeFileSync(getCrashDbPath(), JSON.stringify(crashes, null, 2), "utf-8");
}

export function createSnapshot(files: string[], label: string): AnchorPoint | null {
  const ws = getWorkspaceRoot();
  const id = `snap-${Date.now()}`, dir = join(ws, SNAPSHOTS_DIR, id);
  ensureDir(dir);
  const saved: string[] = [];
  for (const f of files) {
    const abs = resolve(ws, f);
    if (!existsSync(abs)) continue;
    const rel = relative(ws, abs);
    ensureDir(join(dir, relative(ws, abs).split("/").slice(0, -1).join("/")));
    copyFileSync(abs, join(dir, rel));
    saved.push(rel);
  }
  const a: AnchorPoint = {
    id, label, createdAt: new Date().toISOString(), type: "snapshot", severity: "safe",
    commitHash: getCurrentCommit(), tagName: null, snapshotDir: dir, auditIds: [],
    metadata: { fileCount: saved.length.toString(), files: saved.join(", ") },
  };
  saveAnchor(a); return a;
}

export function planSnapshotRestore(target: AnchorPoint): RollbackPlan | null {
  if (!target.snapshotDir || !existsSync(target.snapshotDir)) return null;
  const files = target.metadata.files?.split(", ") ?? [];
  return {
    targetId: target.id, method: "snapshot-restore", risk: "medium",
    steps: files.filter((f) => existsSync(join(target.snapshotDir!, f))).map((f) => `从快照恢复 ${f}`),
    impacts: ["只有快照中包含的文件会被恢复", "其他文件的变更不受影响"],
  };
}

export function executeSnapshotRestore(target: AnchorPoint): boolean {
  if (!target.snapshotDir || !existsSync(target.snapshotDir)) return false;
  const ws = getWorkspaceRoot();
  for (const f of target.metadata.files?.split(", ") ?? []) {
    const from = join(target.snapshotDir, f), to = join(ws, f);
    if (existsSync(from)) copyFileSync(from, to);
  }
  return true;
}
