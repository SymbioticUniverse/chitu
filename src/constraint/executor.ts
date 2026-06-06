import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { Agent } from "../agent.js";
import { writeMiniPlan, type MiniPlan } from "./plan.js";
import {
  loadAllFileInterfaces,
  buildInterfaceMapContext,
  updateInterfacesAfterIteration,
  parseFileExportsAndImports,
} from "./interface.js";
import type { ConstraintMode } from "../types.js";
import {
  recordAutonomous,
  recordExpandBoundary,
  recordBypassOrchestration,
  recordValidExpand,
  recordInvalidExpand,
  recordImpreciseModify,
} from "../score.js";

const COMPLETION_FILE = ".chitu/completions/latest.json";

export interface ConstraintExecOptions {
  onToken?: (text: string) => void;
  signal?: AbortSignal;
  onToolOutput?: (toolName: string, output: string) => void;
  onCompress?: (phase: string, progress: number) => void;
  onReasoning?: (text: string) => void;
}

const CONSTRAINT_INSTRUCTION = [
  "",
  "## Constraint Mode",
  "",
  "You operate under **constraint mode**. Work iteratively — one module per iteration. After each `complete_sub_goal`, context is compacted. Plan documents (`.chitu/plans/`) and interface documents (`.chitu/interfaces/`) are your only memory across iterations.",
  "",
  "### Starting Each Iteration",
  "",
  "1. **Check interfaces**: Read `.chitu/interfaces/`. What modules already exist and what do they export?",
  "   - Empty & project has code → summarize existing code into interface docs first.",
  "   - Empty & no code → fresh project, proceed to step 2.",
  "",
  "2. **Check plan**: Read `.chitu/plans/`. Is there a plan for this task?",
  "   - **No plan** → create one as `{plan-name}.md`. Break the task into sub-tasks, one module each:",
  "     ```",
  "     - [ ] module-file.js — what it does, what it depends on",
  "     - [ ] another-file.js — what it does, what it depends on",
  "     ```",
  "   - **Has plan** → read it. `[x]` = done (interface doc exists), `[ ]` = not done.",
  "",
  "3. **Three-way alignment**: Cross-reference plan, interface docs, and disk files.",
  "   - File on disk + plan unchecked + no interface doc → **orphan** (interrupted iteration). Priority: lock it, review/complete it, export its interface.",
  "   - Plan checked + interface exists → already done, skip.",
  "",
  "### Each Iteration",
  "",
  "4. **Pick ONE unchecked item** from the plan (ONE file, not a whole phase). Call `horsewhip_lock_intent` with ONLY that item's files. If the item depends on 1-2 existing files (e.g. HTML for a JS module), include them. Never declare files for other modules — they'll be handled in later iterations.",
  "",
  "5. **Work** within the boundary. Import from existing modules via their documented interfaces. Prefer new files over modifying locked ones.",
  "",
  "6. **If blocked**: `horsewhip_expand_boundary` with `reason`: `architecture` (interface/export change), `bugfix`, or `omission`. Expand only for genuine dependencies (e.g. need HTML to load the JS module). Never expand just to add more modules — those belong in later iterations. Max 2 expands per iteration, cumulative boundary ≤ 10 files.",
  "",
  "7. **Complete**: Call `complete_sub_goal` with this iteration's exports and imports. Gates verify: changes exist, exports match, imports match, expand reasons valid, tests pass.",
  "",
  "8. **On success** (gates pass, commit happens):",
  "   - Plan checkboxes and interface docs are auto-updated by the framework — you do NOT need to edit them.",
  "   - Context compacts automatically.",
  "   - Next iteration starts fresh from step 1 — the plan and interfaces tell you what's left.",
  "",
  "### Scoring",
  "  Creation: +2 autonomous | +1 valid architecture expand | -1 bugfix/omission | -2 architecture fraud | -3 bypass",
  "  Modify:   +1 precise | -1 expand | -3 bypass",
  "",
].join("\n");

export class ConstraintExecutor {
  static readonly MAX_FILES_PER_BOUNDARY = 10;
  static readonly MAX_EXPANDS_PER_ITERATION = 2;

  /** Validate boundary scope: reject directories, globs, and excessive file counts. */
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
      } catch { /* doesn't exist yet — new file, OK */ }
    }
    return { ok: true };
  }

  private agent: Agent;
  private workspaceRoot: string;
  private project: string;
  private mode: ConstraintMode;
  private lockIntentUsed = false;
  private expandCount = 0;
  private expandReasons: { paths: string[]; reason: string; exportSnapshot: Record<string, string[]> }[] = [];
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

  /** Setup constraint context before the AI runs.
   *  Idempotent — only injects context and locks files on first call. */
  setup(): void {
    if (this.contextInjected) return;
    this.contextInjected = true;

    // Record HEAD so we can rollback on failure
    try {
      this.headCommit = execSync("git rev-parse HEAD", {
        cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
      }).trim();
    } catch {
      this.headCommit = "";
    }

    // Lock all committed files
    this.lockAllCommitted();

    // Capture user's original task goal
    this.userGoal = this.readUserGoal();

    // Inject constraint instruction and interface graph into system prompt
    const sysMsg = this.agent.getMessages()[0];
    if (sysMsg && sysMsg.role === "system") {
      this.originalSystemPrompt = typeof sysMsg.content === "string" ? sysMsg.content : "";
      const graphNote = this.buildGraphNote();
      sysMsg.content = [this.originalSystemPrompt, CONSTRAINT_INSTRUCTION, graphNote].filter(Boolean).join("\n\n");
    }
  }

  /** Refresh interface graph in system prompt for the next iteration. */
  refreshContext(): void {
    const sysMsg = this.agent.getMessages()[0];
    if (!sysMsg || sysMsg.role !== "system") return;
    const graphNote = this.buildGraphNote();
    sysMsg.content = [this.originalSystemPrompt || "", CONSTRAINT_INSTRUCTION, graphNote].filter(Boolean).join("\n\n");
  }

  /** Reset per-iteration state for the next iteration, re-lock files, refresh context. */
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
    } catch {
      this.headCommit = "";
    }
    this.lockAllCommitted();
    this.refreshContext();
  }

  /** Reset for the next iteration (after commit). */
  reset(): void {
    this.lockIntentUsed = false;
    this.expandCount = 0;
    this.targetFiles = [];
    this.contextInjected = false;
    this.planPath = "";
    this.attempts = 0;
    this.headCommit = "";
  }

  /** Rollback all working-tree changes on failure. */
  rollback(): void {
    if (!this.headCommit) return;
    try {
      execSync("git reset --hard HEAD", { cwd: this.workspaceRoot, timeout: 10000, stdio: "pipe" });
      execSync("git clean -fd -e .chitu/ -e .git/", { cwd: this.workspaceRoot, timeout: 10000, stdio: "pipe" });
    } catch { /* best-effort */ }
  }

  /** Check if the AI set a boundary and record the mini-plan.
   *  Call this after agent.run() returns. */
  checkBoundary(): string[] {
    if (this.lockIntentUsed) return this.targetFiles;

    try {
      const guard = this.agent.getGuard();
      if (!guard) return [];

      const state = guard.getBoundaryState();
      if (!state.locked) return [];

      // In pasture mode, allowed/strict/warn are the writable files
      if (state.mode === "pasture" && state.allowed.length > 0) {
        this.targetFiles = [...new Set([...state.allowed, ...(state.strict ?? []), ...(state.warn ?? [])])];
      } else {
        // New-file-only iteration: AI didn't call lock_intent but may have created new files
        try {
          const untracked = execSync("git ls-files --others --exclude-standard 2>/dev/null", {
            cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
          }).trim().split("\n").filter(Boolean);
          const newFiles = untracked.filter((f) =>
            !f.startsWith(".chitu/") && !f.startsWith(".horsewhip/") &&
            f !== ".DS_Store" && f !== "Thumbs.db",
          );
          if (newFiles.length > 0) {
            this.targetFiles = newFiles;
          } else {
            return []; // Nothing to commit
          }
        } catch {
          return [];
        }
      }

      if (this.targetFiles.length === 0) return [];

      this.lockIntentUsed = true;

      // Write mini-plan on first attempt only
      if (!this.planPath) {
        const plan: MiniPlan = {
          project: this.project,
          goal: this.readUserGoal(),
          targetFiles: this.targetFiles,
          steps: [],
          createdAt: new Date().toISOString(),
        };
        this.planPath = writeMiniPlan(this.workspaceRoot, plan);
      }

      return this.targetFiles;
    } catch {
      return [];
    }
  }

  /** Verify exports and tests. Returns feedback for the AI on failure. */
  verifyGates(exports: string[] | Record<string, string[]>, imports: string[] | Record<string, string[]>): { ok: boolean; feedback: string } {
    // Gate 0: actual changes — AI must have modified or created something
    const changes = this.getChanges();
    if (changes.length === 0) {
      return {
        ok: false,
        feedback: [
          `## No changes detected`,
          `You declared a boundary but didn't modify any files. Make the requested changes, then call \`complete_sub_goal\` again.`,
        ].join("\n"),
      };
    }

    // Gate 1: export verification
    const exportIssues = this.verifyExports(this.targetFiles, exports);
    if (exportIssues.length > 0) {
      return {
        ok: false,
        feedback: [
          `## Export verification failed`,
          ...exportIssues.map((e) => `  - ${e}`),
          `Fix the issues above, then call \`complete_sub_goal\` again.`,
        ].join("\n"),
      };
    }

    // Gate 1.5: import verification — declared imports must exist in target files
    const importIssues = this.verifyImports(this.targetFiles, imports);
    if (importIssues.length > 0) {
      return {
        ok: false,
        feedback: [
          `## Import verification failed`,
          ...importIssues.map((e) => `  - ${e}`),
          `Fix the issues above, then call \`complete_sub_goal\` again.`,
        ].join("\n"),
      };
    }

    // Gate 2: tests
    const testResult = this.runTests();
    if (!testResult.ok) {
      return {
        ok: false,
        feedback: [
          `## Tests failed`,
          testResult.output.slice(0, 2000),
          `Fix the tests, then call \`complete_sub_goal\` again.`,
        ].join("\n"),
      };
    }

    return { ok: true, feedback: "" };
  }

  /** Gate 1.6: Verify expand reasons against actual interface changes.
   *  Returns score delta and human-readable labels. */
  verifyExpandReasons(): { expandScore: number; expandLabels: string[] } {
    const labels: string[] = [];
    let score = 0;

    if (this.mode === "modification") {
      // Modify mode: every expand is a miss
      for (const er of this.expandReasons) {
        score -= 1;
        labels.push(`expand(-1 modify imprecise): ${er.paths.join(", ")}`);
        recordImpreciseModify(this.project, `expanded: ${er.paths.join(", ")} (${er.reason})`);
      }
      return { expandScore: score, expandLabels: labels };
    }

    // Creation mode: verify each expand reason
    for (const er of this.expandReasons) {
      // Only explicit bugfix/omission get -1. Everything else (architecture or
      // unrecognized descriptions) is treated as architecture and verified.
      if (er.reason === "bugfix" || er.reason === "omission") {
        score -= 1;
        labels.push(`expand(-1 ${er.reason}): ${er.paths.join(", ")}`);
        // Already recorded via recordExpandBoundary with -1
      } else {
        // architecture (explicit or assumed)
        // Check if exports actually changed (non-code files like CSS/HTML always count as valid)
        let anyChanged = false;
        let hasNonCodeFile = false;
        for (const p of er.paths) {
          const fullPath = path.join(this.workspaceRoot, p);
          const before = er.exportSnapshot[p] ?? [];
          if (!fs.existsSync(fullPath)) continue;
          const ext = path.extname(p).toLowerCase();
          // CSS/HTML/MD/JSON files don't have parseable exports — count as valid if they exist
          if ([".css", ".html", ".md", ".json"].includes(ext)) {
            hasNonCodeFile = true;
            continue;
          }
          try {
            const content = fs.readFileSync(fullPath, "utf-8");
            const parsed = parseFileExportsAndImports(content, p);
            const after = parsed.exports;
            // Compare: did the export set change? (additions, removals, renames)
            const beforeSet = new Set(before);
            const afterSet = new Set(after);
            if (beforeSet.size !== afterSet.size || [...beforeSet].some((e) => !afterSet.has(e)) || [...afterSet].some((e) => !beforeSet.has(e))) {
              anyChanged = true;
              break;
            }
          } catch { /* skip */ }
        }
        if (anyChanged || hasNonCodeFile) {
          score += 1;
          labels.push(`expand(+1 valid): ${er.paths.join(", ")}`);
          recordValidExpand(this.project, `expand: ${er.paths.join(", ")} (${er.reason})`);
        } else {
          score -= 2;
          labels.push(`expand(-2 fraud): exports unchanged in ${er.paths.join(", ")}`);
          recordInvalidExpand(this.project, `claimed expand but exports unchanged: ${er.paths.join(", ")}`);
        }
      }
    }

    return { expandScore: score, expandLabels: labels };
  }

  /** Build a compact state message for the next iteration.
   *  Discards all conversation history, keeps only task + progress.
   *  Interface graph lives in the system prompt (refreshed by resetForNextIteration). */
  buildCompactState(_latestCapability: string): string {
    const modules = this.getCompletedCapabilities();

    const parts = [
      "## Task",
      this.userGoal || "(no goal recorded)",
      "",
    ];

    if (modules.length > 0) {
      parts.push(`*${modules.length} module(s) completed so far*`);
      parts.push("");
    }

    parts.push("## Next Steps");
    parts.push("1. Read `.chitu/plans/` to see the plan and what's checked off.");
    parts.push("2. Read `.chitu/interfaces/` to see available modules and their exports.");
    parts.push("3. Cross-reference with disk files to detect orphans (interrupted iterations).");
    parts.push("4. Pick the next unchecked plan item, lock its boundary, and continue.");

    return parts.join("\n");
  }

  /** Scan plan markdown files and mark checkboxes matching target files as done. */
  private markPlanItemsDone(): void {
    const plansDir = path.join(this.workspaceRoot, ".chitu", "plans");
    if (!fs.existsSync(plansDir)) return;
    try {
      for (const entry of fs.readdirSync(plansDir)) {
        if (!entry.endsWith(".md")) continue;
        const planPath = path.join(plansDir, entry);
        let content = fs.readFileSync(planPath, "utf-8");
        let changed = false;
        for (const tf of this.targetFiles) {
          const escaped = tf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const pattern = new RegExp(`(-\\s+\\[\\s*\\]\\s+.*?${escaped}.*)`, "g");
          const updated = content.replace(pattern, (match) => match.replace(/\[ \]/, "[x]"));
          if (updated !== content) {
            content = updated;
            changed = true;
          }
        }
        if (changed) {
          fs.writeFileSync(planPath, content, "utf-8");
        }
      }
    } catch { /* best-effort */ }
  }

  /** Collect completed module info from interface docs. */
  private getCompletedCapabilities(): { file: string; capability: string; exports: string[] }[] {
    const interfaces = loadAllFileInterfaces(this.workspaceRoot);
    return interfaces.map((i) => ({
      file: i.file,
      capability: i.capability,
      exports: i.exports,
    }));
  }

  /** Finalize: update interfaces, commit, score, reset. Only called when gates pass. */
  finalize(capability: string): string {
    // Update interface graph
    const hints: Record<string, string> = {};
    for (const f of this.targetFiles) hints[f] = capability;
    updateInterfacesAfterIteration(this.workspaceRoot, this.targetFiles, hints);

    // Commit
    const commitResult = this.commit(capability);
    if (!commitResult.ok) {
      return `## Commit failed\n${commitResult.error}\n\nResolve and re-run.`;
    }

    // Update mini-plan with actual steps
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

    // Auto-mark plan checkboxes for completed files
    this.markPlanItemsDone();

    // Score — verify expand reasons first, then compute total
    const verified = this.verifyExpandReasons();
    let totalScore = 0;
    const scoreParts: string[] = [];

    if (this.expandCount === 0) {
      if (this.mode === "creation") {
        totalScore = 2;
        scoreParts.push("+2 autonomous");
        recordAutonomous(this.project, capability, 2);
      } else {
        totalScore = 1;
        scoreParts.push("+1 precise");
        recordAutonomous(this.project, capability, 1);
      }
    } else {
      // expandCount > 0: base score from verified expands
      totalScore = verified.expandScore;
      scoreParts.push(...verified.expandLabels);
    }

    const scoreLabel = `${totalScore >= 0 ? "+" : ""}${totalScore} (${scoreParts.join(", ")})`;
    const attemptLabel = this.attempts > 1 ? ` (${this.attempts} attempts)` : "";

    // Context compaction: build compact state BEFORE reset (reads current interface docs)
    const compactState = this.buildCompactState(capability);

    // Reset internal state and refresh system prompt with updated interface graph
    this.resetForNextIteration();

    // Truncate messages: keep system prompt, replace everything else with compact state
    this.agent.compactMessages(compactState);

    return [
      `## Iteration Complete${attemptLabel}`,
      `  Commit: \`${commitResult.hash}\``,
      `  Score: ${scoreLabel}`,
      `  Interface graph updated. Ready for next iteration.`,
    ].join("\n");
  }

  /** Increment attempt counter. Returns true if more attempts are allowed. */
  nextAttempt(): boolean {
    this.attempts++;
    return this.attempts <= this.maxAttempts;
  }

  /** Ensure boundary is set and completion data is read.
   *  Returns null if the loop should break (no completion, abort).
   *  Returns with feedback if the AI should retry (e.g. no boundary declared). */
  ensureBoundary(): { exports: string[] | Record<string, string[]>; imports: string[] | Record<string, string[]>; capability: string; feedback?: string } | null {
    if (!this.lockIntentUsed) {
      this.checkBoundary();
    }

    const completed = this.readCompletion();
    if (!completed) {
      this.checkBypass();
      return null;
    }

    if (this.targetFiles.length === 0) {
      return {
        exports: {},
        imports: {},
        capability: "empty",
        feedback: [
          `## Boundary required`,
          `You called \`complete_sub_goal\` without declaring a boundary. Call \`horsewhip_lock_intent\` first — declare which files you will touch, then do the work, then call \`complete_sub_goal\`.`,
        ].join("\n"),
      };
    }

    return completed;
  }

  /** Check if an expand is allowed: respects cumulative boundary size and per-iteration expand limit. */
  canExpand(paths: string[]): { ok: true } | { ok: false; error: string } {
    if (this.expandCount >= ConstraintExecutor.MAX_EXPANDS_PER_ITERATION) {
      return { ok: false, error: `Max expands per iteration reached (${this.expandCount}/${ConstraintExecutor.MAX_EXPANDS_PER_ITERATION}). Complete this iteration first.` };
    }
    // Count current boundary size: targetFiles from lock_intent + all previously expanded paths
    const currentCount = this.targetFiles.length + this.expandReasons.reduce((sum, er) => sum + er.paths.length, 0);
    const newCount = currentCount + paths.length;
    if (newCount > ConstraintExecutor.MAX_FILES_PER_BOUNDARY) {
      return { ok: false, error: `Expand would exceed boundary limit (${currentCount} current + ${paths.length} new = ${newCount} > ${ConstraintExecutor.MAX_FILES_PER_BOUNDARY}). Complete this iteration first.` };
    }
    return { ok: true };
  }

  /** Called when AI expands the boundary. Captures export snapshots for later verification. */
  recordExpand(paths: string[], reason?: string): void {
    this.expandCount++;
    const resolvedReason = reason || "unspecified";
    // Snapshot exports of each expanded file BEFORE the AI edits them
    const snapshots: Record<string, string[]> = {};
    for (const p of paths) {
      const fullPath = path.join(this.workspaceRoot, p);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const parsed = parseFileExportsAndImports(content, p);
          snapshots[p] = parsed.exports;
        } catch { snapshots[p] = []; }
      } else {
        snapshots[p] = [];
      }
    }
    this.expandReasons.push({ paths, reason: resolvedReason, exportSnapshot: snapshots });
    recordExpandBoundary(this.project, `expanded by ${paths.length} file(s): ${paths.join(", ")} (${resolvedReason})`);
  }

  // ── Internal ──

  private getChanges(): string[] {
    try {
      const modified = execSync("git diff --name-only HEAD 2>/dev/null", {
        cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
      }).trim().split("\n").filter(Boolean);
      const untracked = execSync("git ls-files --others --exclude-standard 2>/dev/null", {
        cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
      }).trim().split("\n").filter(Boolean);
      return [...modified, ...untracked].filter((f) =>
        !f.startsWith(".chitu/") && !f.startsWith(".horsewhip/") &&
        f !== ".DS_Store" && f !== "Thumbs.db",
      );
    } catch {
      return [];
    }
  }

  private buildGraphNote(): string {
    const interfaces = loadAllFileInterfaces(this.workspaceRoot);
    return interfaces.length > 0
      ? buildInterfaceMapContext(interfaces)
      : "No interface graph yet. Read the source files directly, then call `horsewhip_lock_intent` to set your boundary.";
  }

  private lockAllCommitted(): void {
    const guard = this.agent.getGuard();
    if (!guard) return;
    try {
      guard.lockDecouple(`constraint:${this.project}`, { writablePaths: [], allowNewFiles: true, allowShellWrite: false });
    } catch { /* fallback: implicit decouple */ }
  }

  private checkBypass(): void {
    try {
      const diff = execSync("git diff --name-only HEAD 2>/dev/null", {
        cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
      }).trim();
      if (!diff) return;
      const modified = diff.split("\n").filter(Boolean);
      const untracked = execSync("git ls-files --others --exclude-standard 2>/dev/null", {
        cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
      }).trim().split("\n").filter(Boolean);

      // New untracked files are always allowed in constraint mode
      const allChanged = [...modified];
      const outside = allChanged.filter((f) =>
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
      return {
        exports: data.exports ?? [],
        imports: data.imports ?? [],
        capability: data.capability ?? "",
      };
    } catch { return null; }
  }

  private verifyExports(files: string[], exports: string[] | Record<string, string[]>): string[] {
    // Build a map of ALL exports across ALL target files
    const allExports = new Map<string, string[]>(); // file → exports
    for (const tf of files) {
      const fullPath = path.join(this.workspaceRoot, tf);
      if (!fs.existsSync(fullPath)) continue;
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const parsed = parseFileExportsAndImports(content, tf);
        allExports.set(tf, parsed.exports.length > 0 ? parsed.exports : []);
      } catch { /* skip */ }
    }

    // If exports is a Record (per-file), verify each file's declared exports.
    // Accept an export if it exists in ANY target file (AI may confuse imports with exports).
    const exportMap = Array.isArray(exports)
      ? Object.fromEntries(files.map((f) => [f, exports as string[]]))
      : exports;

    const issues: string[] = [];
    // Cache file contents for substring matching
    const fileContents = new Map(files.map((tf) => {
      try {
        const fullPath = path.join(this.workspaceRoot, tf);
        return [tf, fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf-8") : ""] as [string, string];
      } catch { return [tf, ""] as [string, string]; }
    }));

    for (const [file, declared] of Object.entries(exportMap)) {
      if (!Array.isArray(declared) || declared.length === 0) continue;
      // Entry point / side-effect-only file with no actual exports: skip verification
      const actualExports = allExports.get(file);
      if (!actualExports || actualExports.length === 0) continue;
      for (const exp of declared) {
        let found = false;
        for (const [tf, tfExports] of allExports) {
          // Exact symbol match in parsed exports
          if (tfExports.includes(exp)) { found = true; break; }
          // Non-code files or symbols not caught by parser: check filename or content
          const content = fileContents.get(tf) ?? "";
          const base = path.basename(tf);
          const baseNoExt = base.replace(/\.[^.]+$/, "");
          if (exp === base || exp === baseNoExt || exp === tf || (content && content.includes(exp))) {
            found = true; break;
          }
        }
        if (!found) {
          issues.push(`\`${exp}\` (declared for ${file}) not found in any target file`);
        }
      }
    }
    return issues;
  }

  private verifyImports(files: string[], imports: string[] | Record<string, string[]>): string[] {
    // Build a map of ALL imports across ALL target files
    const allImports = new Map<string, { symbol: string; from: string }[]>(); // file → imports
    for (const tf of files) {
      const fullPath = path.join(this.workspaceRoot, tf);
      if (!fs.existsSync(fullPath)) continue;
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const parsed = parseFileExportsAndImports(content, tf);
        if (parsed.imports.length > 0) allImports.set(tf, parsed.imports);
      } catch { /* skip */ }
    }

    // Normalize to per-file record
    const importMap = Array.isArray(imports)
      ? Object.fromEntries(files.map((f) => [f, imports as string[]]))
      : imports;

    const issues: string[] = [];
    for (const [file, declared] of Object.entries(importMap)) {
      if (!Array.isArray(declared) || declared.length === 0) continue;
      const actual = allImports.get(file);
      if (!actual || actual.length === 0) {
        // No imports declared vs none parsed — skip, file may have no imports
        continue;
      }
      const actualSymbols = new Set(actual.map((i) => i.symbol));
      const actualSources = new Set(actual.map((i) => i.from));
      for (const imp of declared) {
        // Accept if imp is a known import symbol OR a known import source file
        if (actualSymbols.has(imp)) continue;
        if (actualSources.has(imp)) continue;
        // Loose match: imp appears as part of a source path
        let found = false;
        for (const src of actualSources) {
          if (src.includes(imp) || imp.includes(src)) { found = true; break; }
        }
        if (!found) {
          issues.push(`\`${imp}\` declared as import in ${file} but not found`);
        }
      }
    }
    return issues;
  }

  private runTests(): { ok: boolean; output: string } {
    try {
      const pkgPath = path.join(this.workspaceRoot, "package.json");
      if (!fs.existsSync(pkgPath)) {
        return { ok: false, output: "No package.json found. Create one with a test script, then call `complete_sub_goal` again." };
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (!pkg.scripts?.test) {
        return { ok: false, output: "No test script in package.json. Add a `test` script (e.g. `node test/basic.test.js`), then call `complete_sub_goal` again." };
      }
      const result = execSync("npm test 2>&1 || true", {
        cwd: this.workspaceRoot, encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, timeout: 120_000,
      });
      const failed = /(?:FAIL|failed|\d+ failing|Test failed|AssertionError|npm ERR!)/i.test(result);
      return { ok: !failed, output: result };
    } catch (e: any) {
      return { ok: false, output: String(e?.stdout ?? e?.stderr ?? e).slice(0, 5000) };
    }
  }

  private commit(message: string): { ok: boolean; hash?: string; error?: string } {
    try {
      const toAdd: string[] = [];
      for (const f of this.targetFiles) {
        toAdd.push(f);
      }

      // Discover new untracked files created during this iteration
      try {
        const untracked = execSync("git ls-files --others --exclude-standard 2>/dev/null", {
          cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
        }).trim().split("\n").filter(Boolean);
        for (const f of untracked) {
          if (f.startsWith(".chitu/") || f.startsWith(".horsewhip/") || f.startsWith(".git/")) continue;
          if (f === ".DS_Store" || f === "Thumbs.db" || f.endsWith("~") || f.endsWith(".swp")) continue;
          if (!toAdd.includes(f)) {
            toAdd.push(f);
          }
        }
      } catch { /* skip */ }

      // Always include .chitu/plans/ and .chitu/interfaces/
      for (const dir of [".chitu/plans", ".chitu/interfaces"]) {
        const full = path.join(this.workspaceRoot, dir);
        if (fs.existsSync(full)) toAdd.push(dir + "/");
      }

      // Stage files individually (safer than shell wildcards with special chars)
      for (const f of toAdd) {
        try {
          execSync(`git add -- "${f}"`, { cwd: this.workspaceRoot, timeout: 5000, stdio: "pipe" });
        } catch { /* file may not exist */ }
      }

      // Escape double-quotes in commit message
      const safeMsg = message.replace(/"/g, '\\"');
      const output = execSync(`git commit -m "chitu: ${safeMsg}"`, {
        cwd: this.workspaceRoot, encoding: "utf-8", timeout: 10000, stdio: "pipe",
      }).trim();

      // nothing to commit is OK — means no changes
      if (output.includes("nothing to commit")) {
        return { ok: true, hash: "unchanged" };
      }

      const shortHash = output.match(/\[[\w-]+\s+(\w+)\]/)?.[1] ?? output.slice(0, 7);
      return { ok: true, hash: shortHash };
    } catch (e: any) {
      const stderr = String(e?.stderr ?? e?.message ?? e);
      if (stderr.includes("nothing to commit")) {
        return { ok: true, hash: "unchanged" };
      }
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
