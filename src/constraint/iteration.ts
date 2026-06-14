import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { Agent } from "../agent.js";
import { recordBypassOrchestration } from "../score.js";

const COMPLETION_FILE = ".chitu/completions/latest.json";

/** Commit target files + auto-include untracked + plan/interfaces dirs. */
export function commitIteration(
  workspaceRoot: string,
  targetFiles: string[],
  message: string,
): { ok: boolean; hash?: string; error?: string } {
  try {
    const toAdd = [...targetFiles];
    try {
      const untracked = execSync("git ls-files --others --exclude-standard 2>/dev/null", {
        cwd: workspaceRoot, encoding: "utf-8", timeout: 5000,
      }).trim().split("\n").filter(Boolean);
      for (const f of untracked) {
        if (f.startsWith(".chitu/") || f.startsWith(".horsewhip/") || f.startsWith(".git/")) continue;
        if (f === ".DS_Store" || f === "Thumbs.db" || f.endsWith("~") || f.endsWith(".swp")) continue;
        if (!toAdd.includes(f)) toAdd.push(f);
      }
    } catch { /* skip */ }

    for (const dir of [".chitu/plans", ".chitu/interfaces"]) {
      const full = path.join(workspaceRoot, dir);
      if (fs.existsSync(full)) toAdd.push(dir + "/");
    }

    for (const f of toAdd) {
      try { execSync(`git add -- "${f}"`, { cwd: workspaceRoot, timeout: 5000, stdio: "pipe" }); }
      catch { /* file may not exist */ }
    }

    const safeMsg = message.replace(/"/g, '\\"');
    const output = execSync(`git commit -m "chitu: ${safeMsg}"`, {
      cwd: workspaceRoot, encoding: "utf-8", timeout: 10000, stdio: "pipe",
    }).trim();

    if (output.includes("nothing to commit")) return { ok: true, hash: "unchanged" };
    const shortHash = output.match(/\[[\w-]+\s+(\w+)\]/)?.[1] ?? output.slice(0, 7);
    return { ok: true, hash: shortHash };
  } catch (e: any) {
    const stderr = String(e?.stderr ?? e?.message ?? e);
    if (stderr.includes("nothing to commit")) return { ok: true, hash: "unchanged" };
    return { ok: false, error: stderr.slice(0, 500) || "Unknown commit error" };
  }
}

/** Update mini-plan steps with actual file actions. */
export function updatePlanSteps(
  workspaceRoot: string,
  planPath: string,
  targetFiles: string[],
  capability: string,
): void {
  if (!planPath || !fs.existsSync(planPath)) return;
  try {
    const plan: { steps: string[] } = JSON.parse(fs.readFileSync(planPath, "utf-8"));
    plan.steps = targetFiles.map((f) => {
      const action = fs.existsSync(path.join(workspaceRoot, f)) ? "modified" : "created";
      return `${action}: ${f}`;
    });
    plan.steps.push(`capability: ${capability}`);
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
  } catch { /* best-effort */ }
}

/** Detect files modified outside lock_intent boundary. */
export function checkBypass(
  workspaceRoot: string,
  targetFiles: string[],
  project: string,
): void {
  try {
    const diff = execSync("git diff --name-only HEAD 2>/dev/null", {
      cwd: workspaceRoot, encoding: "utf-8", timeout: 5000,
    }).trim();
    if (!diff) return;
    const modified = diff.split("\n").filter(Boolean);
    const outside = modified.filter((f) =>
      !f.startsWith(".chitu/") && !targetFiles.includes(f),
    );
    for (const f of outside) {
      recordBypassOrchestration(project, `modified "${f}" outside lock_intent boundary`);
    }
  } catch { /* can't check */ }
}

/** Read completion data from .chitu/completions/latest.json. Does NOT delete. */
export function readCompletion(workspaceRoot: string): {
  exports: string[] | Record<string, string[]>;
  imports: string[] | Record<string, string[]>;
  capability: string;
} | null {
  try {
    const compPath = path.join(workspaceRoot, COMPLETION_FILE);
    if (!fs.existsSync(compPath)) return null;
    const raw = fs.readFileSync(compPath, "utf-8");
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    if (!data || !data.exports) return null;
    return { exports: data.exports ?? [], imports: data.imports ?? [], capability: data.capability ?? "" };
  } catch { return null; }
}

/** Delete the completion file after a successful commit. */
export function deleteCompletion(workspaceRoot: string): void {
  try {
    const compPath = path.join(workspaceRoot, COMPLETION_FILE);
    if (fs.existsSync(compPath)) fs.unlinkSync(compPath);
  } catch { /* ok */ }
}

/** Extract user goal from agent messages. */
export function readUserGoal(agent: Agent): string {
  for (const m of agent.getMessages()) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text && !text.startsWith("## ") && text.length > 0) return text.slice(0, 200);
    }
  }
  return "unknown";
}
