import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { Agent } from "../agent.js";
import { writeMiniPlan, type MiniPlan } from "./plan.js";
import {
  updateInterfacesAfterIteration,
} from "./interface.js";
import { CONSTRAINT_INSTRUCTION, buildGraphNote, buildCompactState, markPlanItemsDone } from "./interface-graph.js";
import {
  verifyGates,
  verifyExpandReasons,
  snapshotExportState,
  type ExpandReasonEntry,
} from "./gates.js";
import type { ConstraintMode } from "../types.js";
import {
  recordAutonomous,
  recordExpandBoundary,
  recordBypassOrchestration,
} from "../score.js";

const COMPLETION_FILE = ".chitu/completions/latest.json";

export interface ConstraintExecOptions {
  onToken?: (text: string) => void;
  signal?: AbortSignal;
  onToolOutput?: (toolName: string, output: string) => void;
  onCompress?: (phase: string, progress: number) => void;
  onReasoning?: (text: string) => void;
}

export class ConstraintExecutor {
  static readonly MAX_FILES_PER_BOUNDARY = 10;
  static readonly MAX_EXPANDS_PER_ITERATION = 2;

  static validateScope(workspaceRoot: string, paths: string[]): { ok: true } | { ok: false; error: string } {
    if (paths.length === 0) return { ok: true };
    if (paths.length > ConstraintExecutor.MAX_FILES_PER_BOUNDARY) {
      return { ok: false, error: `Too many files (${paths.length} > ${ConstraintExecutor.MAX_FILES_PER_BOUNDARY}). Narrow the scope.` };
    }
    for (const p of paths) {
      if (p.includes("*") || p.includes("?")) {
        return { ok: false, error: `"${p}" contains wildcards. Declare exact file paths, not globs.` };
      }
      if (p.endsWith("/")) {
        return { ok: false, error: `"${p}" is a directory. Declare specific files.` };
      }
      try {
        if (fs.statSync(path.join(workspaceRoot, p)).isDirectory()) {
          return { ok: false, error: `"${p}" is a directory. Declare specific files within it.` };
        }
      } catch { /* doesn, OK */ }
    }
    return { ok: true };
  }

  private agent: Agent;
  private workspaceRoot: string;
  private project: string;
  private mode: ConstraintMode;
  private lockIntentUsed = false;
  private expandCount = 0;
  private expandReasons: ExpandReasonEntry[] = [];
  private targetFiles: string[] = [];
  private contextInjected = false;
  private planPath = "";
  private attempts = 0;
  readonly maxAttempts = 3;
  private headCommit = "";
  private originalSystemPrompt = "";
  private userGoal = "";

  constructor(agent: Agent, workspaceRoot: string, mode: ConstraintMode = "creation") {
    this.agent = agent;
    this.workspaceRoot = workspaceRoot;
    this.project = path.basename(workspaceRoot);
    this.mode = mode;
  }

  setup(): void {
    if (this.contextInjected) return;
    this.contextInjected = true;

    try {
      this.headCommit = execSync("git rev-parse HEAD", {
        cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
      }).trim();
    } catch { this.headCommit = ""; }

    this.lockAllCommitted();
    this.userGoal = this.readUserGoal();

    const sysMsg = this.agent.getMessages()[0];
    if (sysMsg && sysMsg.role === "system") {
      this.originalSystemPrompt = typeof sysMsg.content === "string" ? sysMsg.content : "";
      const graphNote = buildGraphNote(this.workspaceRoot);
      sysMsg.content = [this.originalSystemPrompt, CONSTRAINT_INSTRUCTION, graphNote].filter(Boolean).join("\n\n");
    }
  }

  refreshContext(): void {
    const sysMsg = this.agent.getMessages()[0];
    if (!sysMsg || sysMsg.role !== "system") return;
    const graphNote = buildGraphNote(this.workspaceRoot);
    sysMsg.content = [this.originalSystemPrompt || "", CONSTRAINT_INSTRUCTION, graphNote].filter(Boolean).join("\n\n");
  }

  resetForNextIteration(): void {
    this.lockIntentUsed = false;
    this.expandCount = 0;
    this.expandReasons = [];
    this.targetFiles = [];
    this.planPath = "";
    this.attempts = 0;
    this.headCommit = "";
    try {
      this.headCommit = execSync("git rev-parse HEAD", {
        cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
      }).trim();
    } catch { this.headCommit = ""; }
    this.lockAllCommitted();
    this.refreshContext();
  }

  reset(): void {
    this.lockIntentUsed = false;
    this.expandCount = 0;
    this.targetFiles = [];
    this.contextInjected = false;
    this.planPath = "";
    this.attempts = 0;
    this.headCommit = "";
  }

  rollback(): void {
    if (!this.headCommit) return;
    try {
      execSync("git reset --hard HEAD", { cwd: this.workspaceRoot, timeout: 10000, stdio: "pipe" });
      execSync("git clean -fd -e .chitu/ -e .git/", { cwd: this.workspaceRoot, timeout: 10000, stdio: "pipe" });
    } catch { /* best-effort */ }
  }

  checkBoundary(): string[] {
    if (this.lockIntentUsed) return this.targetFiles;

    try {
      const guard = this.agent.getGuard();
      if (!guard) return [];

      const state = guard.getBoundaryState();
      if (!state.locked) return [];

      if (state.mode === "pasture" && state.allowed.length > 0) {
        this.targetFiles = [...new Set([...state.allowed, ...(state.strict ?? []), ...(state.warn ?? [])])];
      } else {
        try {
          const untracked = execSync("git ls-files --others --exclude-standard 2>/dev/null", {
            cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
          }).trim().split("\n").filter(Boolean);
          const newFiles = untracked.filter((f) =>
            !f.startsWith(".chitu/") && !f.startsWith(".horsewhip/") &&
            f !== ".DS_Store" && f !== "Thumbs.db",
          );
          if (newFiles.length > 0) { this.targetFiles = newFiles; } else { return []; }
        } catch { return []; }
      }

      if (this.targetFiles.length === 0) return [];
      this.lockIntentUsed = true;

      if (!this.planPath) {
        const plan: MiniPlan = {
          project: this.project, goal: this.readUserGoal(),
          targetFiles: this.targetFiles, steps: [], createdAt: new Date().toISOString(),
        };
        this.planPath = writeMiniPlan(this.workspaceRoot, plan);
      }
      return this.targetFiles;
    } catch { return []; }
  }

  verifyGates(exports: string[] | Record<string, string[]>, imports: string[] | Record<string, string[]>): { ok: boolean; feedback: string } {
    return verifyGates(this.workspaceRoot, this.targetFiles, exports, imports);
  }

  verifyExpandReasons(): { expandScore: number; expandLabels: string[] } {
    return verifyExpandReasons(this.workspaceRoot, this.mode, this.project, this.expandReasons);
  }

  buildCompactState(_latestCapability: string): string {
    return buildCompactState(this.userGoal, this.workspaceRoot);
  }

  finalize(capability: string): string {
    const hints: Record<string, string> = {};
    for (const f of this.targetFiles) hints[f] = capability;
    updateInterfacesAfterIteration(this.workspaceRoot, this.targetFiles, hints);

    const commitResult = this.commit(capability);
    if (!commitResult.ok) {
      return `## Commit failed\n${commitResult.error}\n\nResolve and re-run.`;
    }

    if (this.planPath && fs.existsSync(this.planPath)) {
      try {
        const plan: MiniPlan = JSON.parse(fs.readFileSync(this.planPath, "utf-8"));
        plan.steps = this.targetFiles.map((f) => {
          const action = fs.existsSync(path.join(this.workspaceRoot, f)) ? "modified" : "created";
          return `${action}: ${f}`;
        });
        plan.steps.push(`capability: ${capability}`);
        fs.writeFileSync(this.planPath, JSON.stringify(plan, null, 2), "utf-8");
      } catch { /* best-effort */ }
    }

    markPlanItemsDone(this.workspaceRoot, this.targetFiles);

    const verified = this.verifyExpandReasons();
    let totalScore = 0;
    const scoreParts: string[] = [];

    if (this.expandCount === 0) {
      if (this.mode === "creation") {
        totalScore = 2; scoreParts.push("+2 autonomous");
        recordAutonomous(this.project, capability, 2);
      } else {
        totalScore = 1; scoreParts.push("+1 precise");
        recordAutonomous(this.project, capability, 1);
      }
    } else {
      totalScore = verified.expandScore;
      scoreParts.push(...verified.expandLabels);
    }

    const scoreLabel = `${totalScore >= 0 ? "+" : ""}${totalScore} (${scoreParts.join(", ")})`;
    const attemptLabel = this.attempts > 1 ? ` (${this.attempts} attempts)` : "";
    const compactState = this.buildCompactState(capability);
    this.resetForNextIteration();
    this.agent.compactMessages(compactState);

    return [
      `## Iteration Complete${attemptLabel}`,
      `  Commit: \`${commitResult.hash}\``,
      `  Score: ${scoreLabel}`,
      `  Interface graph updated. Ready for next iteration.`,
    ].join("\n");
  }

  nextAttempt(): boolean { this.attempts++; return this.attempts <= this.maxAttempts; }

  ensureBoundary(): { exports: string[] | Record<string, string[]>; imports: string[] | Record<string, string[]>; capability: string; feedback?: string } | null {
    if (!this.lockIntentUsed) this.checkBoundary();

    const completed = this.readCompletion();
    if (!completed) { this.checkBypass(); return null; }

    if (this.targetFiles.length === 0) {
      return {
        exports: {}, imports: {}, capability: "empty",
        feedback: `## Boundary required\nYou called \`complete_sub_goal\` without declaring a boundary. Call \`horsewhip_lock_intent\` first — declare which files you will touch, then do the work, then call \`complete_sub_goal\`.`,
      };
    }
    return completed;
  }

  canExpand(paths: string[]): { ok: true } | { ok: false; error: string } {
    if (this.expandCount >= ConstraintExecutor.MAX_EXPANDS_PER_ITERATION) {
      return { ok: false, error: `Max expands per iteration reached (${this.expandCount}/${ConstraintExecutor.MAX_EXPANDS_PER_ITERATION}).` };
    }
    const currentCount = this.targetFiles.length + this.expandReasons.reduce((sum, er) => sum + er.paths.length, 0);
    if (currentCount + paths.length > ConstraintExecutor.MAX_FILES_PER_BOUNDARY) {
      return { ok: false, error: `Expand would exceed boundary limit (${currentCount} + ${paths.length} > ${ConstraintExecutor.MAX_FILES_PER_BOUNDARY}).` };
    }
    return { ok: true };
  }

  recordExpand(paths: string[], reason?: string): void {
    this.expandCount++;
    const resolvedReason = reason || "unspecified";
    const snapshots = snapshotExportState(this.workspaceRoot, paths);
    this.expandReasons.push({ paths, reason: resolvedReason, exportSnapshot: snapshots });
    recordExpandBoundary(this.project, `expanded by ${paths.length} file(s): ${paths.join(", ")} (${resolvedReason})`);
  }

  // ── Internal ──

  private lockAllCommitted(): void {
    const guard = this.agent.getGuard();
    if (!guard) return;
    try {
      guard.lockDecouple(`constraint:${this.project}`, { writablePaths: [], allowNewFiles: true, allowShellWrite: false });
    } catch { /* fallback */ }
  }

  private checkBypass(): void {
    try {
      const diff = execSync("git diff --name-only HEAD 2>/dev/null", {
        cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
      }).trim();
      if (!diff) return;
      const modified = diff.split("\n").filter(Boolean);
      const outside = modified.filter((f) =>
        !f.startsWith(".chitu/") && !this.targetFiles.includes(f),
      );
      for (const f of outside) {
        recordBypassOrchestration(this.project, `modified "${f}" outside lock_intent boundary`);
      }
    } catch { /* can't check */ }
  }

  private readCompletion(): { exports: string[] | Record<string, string[]>; imports: string[] | Record<string, string[]>; capability: string } | null {
    try {
      const compPath = path.join(this.workspaceRoot, COMPLETION_FILE);
      if (!fs.existsSync(compPath)) return null;
      const raw = fs.readFileSync(compPath, "utf-8");
      if (!raw.trim()) return null;
      const data = JSON.parse(raw);
      if (!data || !data.exports) return null;
      fs.unlinkSync(compPath);
      return { exports: data.exports ?? [], imports: data.imports ?? [], capability: data.capability ?? "" };
    } catch { return null; }
  }

  private commit(message: string): { ok: boolean; hash?: string; error?: string } {
    try {
      const toAdd = [...this.targetFiles];
      try {
        const untracked = execSync("git ls-files --others --exclude-standard 2>/dev/null", {
          cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
        }).trim().split("\n").filter(Boolean);
        for (const f of untracked) {
          if (f.startsWith(".chitu/") || f.startsWith(".horsewhip/") || f.startsWith(".git/")) continue;
          if (f === ".DS_Store" || f === "Thumbs.db" || f.endsWith("~") || f.endsWith(".swp")) continue;
          if (!toAdd.includes(f)) toAdd.push(f);
        }
      } catch { /* skip */ }

      for (const dir of [".chitu/plans", ".chitu/interfaces"]) {
        const full = path.join(this.workspaceRoot, dir);
        if (fs.existsSync(full)) toAdd.push(dir + "/");
      }

      for (const f of toAdd) {
        try { execSync(`git add -- "${f}"`, { cwd: this.workspaceRoot, timeout: 5000, stdio: "pipe" }); }
        catch { /* file may not exist */ }
      }

      const safeMsg = message.replace(/"/g, '\\"');
      const output = execSync(`git commit -m "chitu: ${safeMsg}"`, {
        cwd: this.workspaceRoot, encoding: "utf-8", timeout: 10000, stdio: "pipe",
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

  private readUserGoal(): string {
    for (const m of this.agent.getMessages()) {
      if (m.role === "user") {
        const text = typeof m.content === "string" ? m.content : "";
        if (text && !text.startsWith("## ") && text.length > 0) return text.slice(0, 200);
      }
    }
    return "unknown";
  }
}
