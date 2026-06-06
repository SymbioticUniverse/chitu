import * as fs from "node:fs";
import * as path from "node:path";
import type { Agent } from "../agent.js";
import type { TargetState } from "../types.js";
import { getContentText } from "../types.js";
import { loadPlanFile, savePlanFile, getPlansDir, planId as toPlanId } from "./plan.js";

// ── State persistence ───────────────────────────────────────────

/** Simple string hash for temp plan ID during clarify phase (before a real plan exists). */
export function goalToTempId(goal: string): string {
  let hash = 0;
  for (let i = 0; i < goal.length; i++) {
    hash = ((hash << 5) - hash) + goal.charCodeAt(i);
    hash |= 0;
  }
  return `clarify-${Math.abs(hash).toString(36).slice(0, 8)}`;
}

export function loadState(workspaceRoot: string, planId: string): TargetState | null {
  const raw = loadPlanFile(workspaceRoot, planId);
  if (!raw) return null;
  try {
    const state = raw as unknown as TargetState;
    // Backward compat
    if (!Array.isArray(state.previousSubGoalFiles)) state.previousSubGoalFiles = [];
    if (typeof state.humanInLoopCount !== "number") state.humanInLoopCount = 0;
    if (typeof state.planConfirmed !== "boolean") state.planConfirmed = false;
    if (!Array.isArray(state.commits)) state.commits = [];
    if (!Array.isArray(state.violations)) state.violations = [];
    if (typeof state.initialHead !== "string") state.initialHead = "";
    if (typeof state.subGoalHead !== "string") state.subGoalHead = "";
    // Reconstruct plan from top-level fields if nested plan is missing
    if (!state.plan && (raw as any).subGoals && (raw as any).project) {
      state.plan = {
        project: (raw as any).project as string,
        goal: ((raw as any).goal as string) ?? "",
        createdAt: ((raw as any).createdAt as string) ?? new Date().toISOString(),
        subGoals: (raw as any).subGoals as any[] ?? [],
      };
    }
    return state;
  } catch {
    return null;
  }
}

export function saveState(workspaceRoot: string, planId: string, state: TargetState): void {
  const existing = loadPlanFile(workspaceRoot, planId) ?? {};
  const merged = { ...existing, ...state };
  savePlanFile(workspaceRoot, planId, merged);
}

/** Check if two goals are essentially the same task. */
export function isSameGoal(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
  const na = norm(a);
  const nb = norm(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** Mark stale plan as abandoned. Files preserved — 只增不减. */
export function discardState(workspaceRoot: string, state: TargetState): void {
  const pid = state.plan ? toPlanId(state.plan.project) : null;
  if (pid) {
    state.phase = "abandoned";
    saveState(workspaceRoot, pid, state);
  }
}

// ── Active state discovery ───────────────────────────────────────

export function loadActiveState(workspaceRoot: string): TargetState | null {
  const plansDir = getPlansDir(workspaceRoot);
  if (!fs.existsSync(plansDir)) return null;
  let bestActive: { id: string; mtime: number } | null = null;
  let bestAbandoned: { id: string; mtime: number } | null = null;
  for (const entry of fs.readdirSync(plansDir)) {
    const entryPath = path.join(plansDir, entry);
    // Folder format: plan-xxx/plan.json
    if (fs.statSync(entryPath).isDirectory() && entry.startsWith("plan-")) {
      const planFile = path.join(entryPath, "plan.json");
      if (!fs.existsSync(planFile)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(planFile, "utf-8"));
        if (raw.phase === "done") continue;
        const stat = fs.statSync(planFile);
        const candidate = { id: entry, mtime: stat.mtimeMs };
        if (raw.phase === "abandoned") {
          if (!bestAbandoned || stat.mtimeMs > bestAbandoned.mtime) {
            bestAbandoned = candidate;
          }
        } else {
          if (!bestActive || stat.mtimeMs > bestActive.mtime) {
            bestActive = candidate;
          }
        }
      } catch { /* skip corrupt */ }
    }
    // Legacy flat format: plan-xxx.json
    if (entry.endsWith(".json")) {
      const planId = entry.replace(/\.json$/, "");
      try {
        const raw = JSON.parse(fs.readFileSync(entryPath, "utf-8"));
        if (raw.phase === "done") continue;
        const stat = fs.statSync(entryPath);
        const candidate = { id: planId, mtime: stat.mtimeMs };
        if (raw.phase === "abandoned") {
          if (!bestAbandoned || stat.mtimeMs > bestAbandoned.mtime) {
            bestAbandoned = candidate;
          }
        } else {
          if (!bestActive || stat.mtimeMs > bestActive.mtime) {
            bestActive = candidate;
          }
        }
      } catch { /* skip corrupt */ }
    }
  }
  // Prefer active plans, fall back to abandoned (for reactivation)
  const best = bestActive ?? bestAbandoned;
  if (!best) return null;
  return loadState(workspaceRoot, best.id);
}

export function readUserGoal(agent: Agent): string {
  const userMsgs = agent.getMessages().filter((m) => m.role === "user");
  for (const m of userMsgs) {
    const text = getContentText(m.content) ?? "";
    if (text && !text.startsWith("## Target Plan:") && text.length > 0) {
      return text;
    }
  }
  return "";
}

/** Mark old project plan as abandoned when project name changes. */
export function cleanupOldState(workspaceRoot: string, oldProject: string, newProject: string): void {
  if (oldProject === newProject) return;
  const oldId = toPlanId(oldProject);
  const oldState = loadState(workspaceRoot, oldId);
  if (oldState) {
    oldState.phase = "abandoned";
    saveState(workspaceRoot, oldId, oldState);
  }
}
