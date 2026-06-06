import * as fs from "node:fs";
import * as path from "node:path";

export interface MiniPlan {
  project: string;
  goal: string;
  targetFiles: string[];
  steps: string[];
  createdAt: string;
}

const PLANS_DIR = ".chitu/plans";

export function getConstraintPlansDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, PLANS_DIR);
}

/** Generate next iteration plan filename. */
function nextPlanPath(workspaceRoot: string, project: string): string {
  const dir = getConstraintPlansDir(workspaceRoot);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Count existing iterations
  let n = 1;
  for (const entry of fs.readdirSync(dir)) {
    const m = entry.match(new RegExp(`^${project}-iter(\\d+)\\.json$`));
    if (m) n = Math.max(n, parseInt(m[1]!, 10) + 1);
  }
  return path.join(dir, `${project}-iter${String(n).padStart(3, "0")}.json`);
}

/** Write a mini plan for the current iteration. Returns the file path. */
export function writeMiniPlan(workspaceRoot: string, plan: MiniPlan): string {
  const filePath = nextPlanPath(workspaceRoot, plan.project);
  fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), "utf-8");
  return filePath;
}

/** Read the latest mini plan for a project. */
export function readLatestMiniPlan(workspaceRoot: string, project: string): MiniPlan | null {
  const dir = getConstraintPlansDir(workspaceRoot);
  if (!fs.existsSync(dir)) return null;
  let latest: { path: string; mtime: number } | null = null;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(`${project}-iter`) || !entry.endsWith(".json")) continue;
    const stat = fs.statSync(path.join(dir, entry));
    if (!latest || stat.mtimeMs > latest.mtime) {
      latest = { path: path.join(dir, entry), mtime: stat.mtimeMs };
    }
  }
  if (!latest) return null;
  try {
    return JSON.parse(fs.readFileSync(latest.path, "utf-8")) as MiniPlan;
  } catch {
    return null;
  }
}

/** List all iteration plans for a project, ordered by iteration number. */
export function listMiniPlans(workspaceRoot: string, project: string): { file: string; plan: MiniPlan }[] {
  const dir = getConstraintPlansDir(workspaceRoot);
  if (!fs.existsSync(dir)) return [];
  const results: { file: string; plan: MiniPlan }[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(`${project}-iter`) || !entry.endsWith(".json")) continue;
    try {
      const plan = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf-8")) as MiniPlan;
      results.push({ file: entry, plan });
    } catch { /* skip */ }
  }
  results.sort((a, b) => a.file.localeCompare(b.file));
  return results;
}
