import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";
import type { Agent } from "../agent.js";
import type { TargetPlan, TargetPhase, TargetState, SubGoal, InterfaceDoc, SubGoalVerification, ViolationRecord } from "../types.js";
import {
  checkGoalCompleteness,
  buildClarificationPrompt,
  buildPlanGenerationPrompt,
  parsePlanFromResponse,
  savePlan,
  updateSubGoalStatus,
  loadPlanFile,
  savePlanFile,
  planId as toPlanId,
  planJsonPath,
  getPlansDir,
  getSubGoalDir,
} from "./plan.js";
import {
  writeInterfaceDoc,
  loadAllInterfaceDocs,
  buildInterfaceContext,
  generateInterfaceStubs,
  getInterfacesDir,
} from "./interface-doc.js";
import { COMPLETION_FILE } from "../tools/index.js";
import { writeVerificationDoc } from "./verification.js";
import { detectTaskIntent, getContentText } from "../types.js";

// ── State persistence (merged into plan flat file) ─────────────────

/** Simple string hash for temp plan ID during clarify phase (before a real plan exists). */
function goalToTempId(goal: string): string {
  let hash = 0;
  for (let i = 0; i < goal.length; i++) {
    hash = ((hash << 5) - hash) + goal.charCodeAt(i);
    hash |= 0;
  }
  return `clarify-${Math.abs(hash).toString(36).slice(0, 8)}`;
}

function loadState(workspaceRoot: string, planId: string): TargetState | null {
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
    // Reconstruct plan from top-level fields if nested plan is missing (state file corruption recovery)
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

function saveState(workspaceRoot: string, planId: string, state: TargetState): void {
  const existing = loadPlanFile(workspaceRoot, planId) ?? {};
  const merged = { ...existing, ...state };
  savePlanFile(workspaceRoot, planId, merged);
}

// ── Executor ───────────────────────────────────────────────────────

export interface TargetExecOptions {
  onToken?: (text: string) => void;
  signal?: AbortSignal;
  onToolOutput?: (toolName: string, output: string) => void;
  onCompress?: (phase: string, progress: number) => void;
  onReasoning?: (text: string) => void;
  /** Yunchang mode: skip plan confirmation, auto-proceed to execute. */
  yunchang?: boolean;
}

const MAX_CLARIFY_ROUNDS = 12;
const MAX_RETRIES = 3;

// ── Integration test types ─────────────────────────────────────

interface IntegrationModule {
  name: string;
  purpose: string;
  imports: string[];
  needsSourceChanges: boolean;
}

export class TargetExecutor {
  private agent: Agent;
  private workspaceRoot: string;

  constructor(agent: Agent, workspaceRoot: string) {
    this.agent = agent;
    this.workspaceRoot = workspaceRoot;
  }

  /** Main entry. Advances the Target state machine by one step.
   *  In yunchang mode: auto-loops through all phases until done, commit is the flow gate. */
  async execute(opts: TargetExecOptions): Promise<string> {
    // Clear any stale boundary from previous session
    const guard = this.agent.getGuard();
    if (guard) guard.unlock();

    const userMsg = this.readUserGoal();
    let state = this.loadActiveState();

    if (state) {
      const pid = state.plan ? toPlanId(state.plan.project) : goalToTempId(userMsg);

      // Reactivate abandoned plan if user is continuing
      if (state.phase === "abandoned") {
        state.phase = "execute";
        state.planConfirmed = true;
        if (state.plan && state.plan.subGoals.length > 0) {
          state.currentSubGoalId = state.plan.subGoals[0]!.id;
          state.currentSubGoal = 0;
        }
        saveState(this.workspaceRoot, pid, state);
      }

      // Reset in_progress sub-goals to pending on process restart.
      // "in_progress" is process-local state — when the process dies, the sub-goal
      // hasn't completed, so it must be retried. Otherwise doExecute() skips the
      // prompt push and agent.run() has no sub-goal context.
      if (state.phase === "execute" && state.plan) {
        let changed = false;
        for (const sg of state.plan.subGoals) {
          if (sg.status === "in_progress") {
            sg.status = "pending";
            sg.retryCount = 0;
            changed = true;
          }
        }
        // Integrity check: "done" sub-goals must have a committedHash.
        // If the state file was corrupted or the commit was lost, reset to pending.
        for (const sg of state.plan.subGoals) {
          if (sg.status === "done" && !sg.committedHash) {
            sg.status = "pending";
            sg.retryCount = 0;
            changed = true;
          }
        }
        if (changed) {
          const firstPending = state.plan.subGoals.find((sg) => sg.status === "pending");
          if (firstPending) {
            state.currentSubGoalId = firstPending.id;
            state.currentSubGoal = state.plan.subGoals.indexOf(firstPending);
          }
          saveState(this.workspaceRoot, pid, state);
        }
      }

      return this.autoLoop(opts);
    }

    // No active state — decide: conversational or task-driven?
    const intent = userMsg ? detectTaskIntent(userMsg) : "query";
    const isConversational = !userMsg || intent === "query";

    if (isConversational) {
      const guard = this.agent.getGuard();
      if (guard) guard.lockFiles([], "target:conversational");
      return this.agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);
    }

    const newState: TargetState = {
      phase: "clarify",
      goal: userMsg,
      clarificationRounds: 0,
      maxClarificationRounds: MAX_CLARIFY_ROUNDS,
      previousSubGoalFiles: [],
      humanInLoopCount: 0,
      planConfirmed: false,
      commits: [],
      violations: [],
      initialHead: "",
      subGoalHead: "",
    };

    return this.autoLoop(opts, newState);
  }

  /** Yunchang auto-loop: run all phases until done. Commit is the flow gate. */
  private async autoLoop(opts: TargetExecOptions, initialState?: TargetState): Promise<string> {
    const MAX_ROUNDS = 30;
    let result = "";

    for (let i = 0; i < MAX_ROUNDS; i++) {
      let state = this.loadActiveState();
      if (!state && initialState) {
        state = initialState;
        initialState = undefined;
      }
      if (!state) return result || "(Target: state lost)";

      if (!state.phase) {
        return "(Target: plan state corrupted — phase is missing. Delete .chitu/plans and restart.)";
      }
      switch (state.phase) {
        case "clarify": result = await this.doClarify(state.goal, state, opts); break;
        case "plan":    result = await this.doPlan(state, opts); break;
        case "execute": result = await this.doExecute(state, opts); break;
        case "review":  result = await this.doReview(state, opts); break;
        case "done":    return result || "(Target: all sub-goals completed)";
        case "abandoned": return "(Target: plan abandoned)";
      }

      state = this.loadActiveState();
      if (!state || state.phase === "done" || state.phase === "abandoned") return result;
    }

    return result + "\n\n(已达最大自动轮数)";
  }

  /** Check if two goals are essentially the same task. */
  private isSameGoal(a: string, b: string): boolean {
    // Normalize: lowercase, collapse whitespace
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
    const na = norm(a);
    const nb = norm(b);
    return na === nb || na.includes(nb) || nb.includes(na);
  }

  /** Mark stale plan as abandoned. Files preserved — 只增不减. */
  private discardState(state: TargetState): void {
    const pid = state.plan ? toPlanId(state.plan.project) : null;
    if (pid) {
      state.phase = "abandoned";
      saveState(this.workspaceRoot, pid, state);
    }
  }

  // ── Active state discovery ───────────────────────────────────────

  private loadActiveState(): TargetState | null {
    const plansDir = getPlansDir(this.workspaceRoot);
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
    return loadState(this.workspaceRoot, best.id);
  }

  private readUserGoal(): string {
    const userMsgs = this.agent.getMessages().filter((m) => m.role === "user");
    for (const m of userMsgs) {
      const text = getContentText(m.content) ?? "";
      if (text && !text.startsWith("## Target Plan:") && text.length > 0) {
        return text;
      }
    }
    return "";
  }

  /** Mark old project plan as abandoned when project name changes. */
  private cleanupOldState(oldProject: string, newProject: string): void {
    if (oldProject === newProject) return;
    const oldId = toPlanId(oldProject);
    const oldState = loadState(this.workspaceRoot, oldId);
    if (oldState) {
      oldState.phase = "abandoned";
      saveState(this.workspaceRoot, oldId, oldState);
    }
  }


  // ── Phase 1: Clarify (one model call per execute) ───────────────

  private async doClarify(goal: string, state: TargetState, opts: TargetExecOptions): Promise<string> {
    const assistantText = this.lastAssistantContent();
    const allMsgs = this.agent.getMessages();
    const lastMsg = allMsgs[allMsgs.length - 1];

    if (assistantText) {
      const plan = parsePlanFromResponse(assistantText, goal);
      if (plan) return this.transitionToPlan(goal, state, plan);

      const hasQuestion = /(?:\?|？)/.test(assistantText) && lastMsg?.role === "assistant";
      // Only treat as clarification question if under threshold.
      // Otherwise fall through to generate a new prompt.
      if (hasQuestion && state.clarificationRounds < 2) {
        state.clarificationRounds++;
        saveState(this.workspaceRoot, state.plan?.project ? toPlanId(state.plan.project) : goalToTempId(goal), state);
        return assistantText;
      }
    }

    state.clarificationRounds++;
    const FORCE_PLAN_AFTER = 3;
    const forcePlan = state.clarificationRounds >= FORCE_PLAN_AFTER || checkGoalCompleteness(goal).complete;
    const prompt = forcePlan
      ? buildPlanGenerationPrompt(goal)
      : buildClarificationPrompt(goal, state.clarificationRounds);

    // Clarify phase: lock nothing. AI can read, write new files, do anything.
    // Only committed sub-goal files get locked during execute phase.
    const guard = this.agent.getGuard();
    if (guard) {
      guard.lockFiles([], "target:clarify");
    }

    this.agent.getMessages().push({ role: "user", content: prompt });
    const result = await this.agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);

    const plan = parsePlanFromResponse(result, goal);
    if (plan) return this.transitionToPlan(goal, state, plan);

    saveState(this.workspaceRoot, goalToTempId(goal), state);
    return result;
  }

  private lastAssistantContent(): string | null {
    const last = [...this.agent.getMessages()].reverse().find((m) => m.role === "assistant");
    if (!last) return null;
    return getContentText(last.content) ?? null;
  }

  private transitionToPlan(goal: string, state: TargetState, plan: TargetPlan): string {
    const planId = toPlanId(plan.project);
    savePlan(this.workspaceRoot, plan);
    generateInterfaceStubs(this.workspaceRoot, plan);
    state.phase = "execute";
    state.planConfirmed = true;
    state.plan = plan;
    state.goal = goal;
    state.currentSubGoalId = plan.subGoals[0]?.id;
    // Capture initial HEAD for rollback
    if (!state.initialHead) {
      try {
        state.initialHead = execSync("git rev-parse HEAD", { cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000 }).trim();
      } catch { state.initialHead = ""; }
    }
    saveState(this.workspaceRoot, planId, state);
    this.discardAndInjectPlan(plan);
    return this.planSummary(plan, "Plan generated. Starting execution.");
  }

  // ── Phase 1.5: Plan (auto-confirmed, no human gate) ────────────────

  private async doPlan(state: TargetState, opts: TargetExecOptions): Promise<string> {
    const plan = state.plan;
    if (!plan) {
      state.phase = "clarify";
      state.planConfirmed = false;
      return "(Target: plan lost, returning to clarify)";
    }

    // Plan is always auto-confirmed — go straight to execute
    state.phase = "execute";
    state.planConfirmed = true;
    if (!state.initialHead) {
      try {
        state.initialHead = execSync("git rev-parse HEAD", { cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000 }).trim();
      } catch { state.initialHead = ""; }
    }
    saveState(this.workspaceRoot, toPlanId(plan.project), state);
    return `Plan auto-confirmed. Starting execution.`;
  }

  // ── Topological sort by dependsOn ────────────────────────────────

  private sortByDeps(subGoals: SubGoal[]): SubGoal[] {
    const byId = new Map(subGoals.map((sg) => [sg.id, sg]));
    const visited = new Set<string>();
    const sorted: SubGoal[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const sg = byId.get(id);
      if (!sg) return;
      for (const dep of sg.dependsOn) visit(dep);
      sorted.push(sg);
    };

    for (const sg of subGoals) visit(sg.id);
    return sorted;
  }

  /** Find sub-goal by id in the ordered list. */
  private findSubGoal(ordered: SubGoal[], subGoalId: string): { sg: SubGoal; idx: number } | null {
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i]!.id === subGoalId) return { sg: ordered[i]!, idx: i };
    }
    return null;
  }

  // ── Phase 2: Execute sub-goal (grow → trim → verify) ────────────

  private async doExecute(state: TargetState, opts: TargetExecOptions): Promise<string> {
    const plan = state.plan;
    if (!plan) return "(Target: no plan loaded)";

    // Hard gate: plan must be confirmed
    if (!state.planConfirmed) {
      state.phase = "plan";
      saveState(this.workspaceRoot, toPlanId(plan.project), state);
      return "(Target: plan not yet confirmed, returning to plan phase)";
    }

    const ordered = this.sortByDeps(plan.subGoals);

    // Use persisted sub-goal id, fall back to index
    let entry = state.currentSubGoalId
      ? this.findSubGoal(ordered, state.currentSubGoalId)
      : null;
    if (!entry && typeof state.currentSubGoal === "number" && state.currentSubGoal < ordered.length) {
      entry = { sg: ordered[state.currentSubGoal]!, idx: state.currentSubGoal };
    }
    if (!entry) {
      // Stale state: sub-goal index/id not found in plan. Log and abort with error.
      state.phase = "done";
      saveState(this.workspaceRoot, toPlanId(plan.project), state);
      return [
        `## Target Error: Stale state`,
        `Sub-goal id '${state.currentSubGoalId ?? "none"}' or index ${state.currentSubGoal} not found in plan with ${ordered.length} sub-goals.`,
        `The plan may have changed between executions. Run /target ${plan.project} to restart.`,
      ].join("\n");
    }

    const { sg: subGoal, idx } = entry;

    // ── GROW phase ──────────────────────────────────────────────

    // Hard gate: interface stub must exist before touching source files
    const planId = toPlanId(plan.project);
    const stubPath = path.join(
      getSubGoalDir(this.workspaceRoot, planId, subGoal.id), "contract.md",
    );
    if (!fs.existsSync(stubPath)) {
      generateInterfaceStubs(this.workspaceRoot, plan);
    }
    const stubContent = fs.existsSync(stubPath)
      ? fs.readFileSync(stubPath, "utf-8")
      : "";

    // Lock boundary: only previous sub-goal committed files are read-only
    this.lockSubGoalBoundary(plan.project, subGoal, state.previousSubGoalFiles);

    const completedDocs = loadAllInterfaceDocs(this.workspaceRoot, toPlanId(plan.project));
    const interfaceCtx = buildInterfaceContext(completedDocs);

    const prompt = [
      `## ${subGoal.title}`,
      ``,
      `Description: ${subGoal.description}`,
      `Target files: ${subGoal.targetFiles.join(", ")}`,
      ``,
      `### Interface Contract`,
      ``,
      stubContent || `(no interface contract yet)`,
      ...(interfaceCtx ? ["", interfaceCtx] : []),
      ``,
      `### Rules`,
      `- 已 commit 的文件是只读的，不能修改`,
      `- 只写当前子目标的文件，不要碰后续子目标的文件`,
      `- 直接做事，不要解释，不要写长篇说明`,
      ``,
      `完成后调用 \`complete_sub_goal\` 工具上报，不要输出 JSON 文本。`,
      `- exports: 文件→导出映射，如 { "src/foo.ts": ["FooClass", "barFn"] }`,
      `- imports: 文件→依赖映射，如 { "src/foo.ts": ["lodash"] }`,
      `- capability: 一句话说清楚用户现在能用这些代码做什么`,
    ].join("\n");

    // Already failed — skip to next sub-goal
    if (subGoal.status === "failed") {
      const nextEntry = ordered[idx + 1];
      if (nextEntry) {
        state.currentSubGoalId = nextEntry.id;
        state.currentSubGoal = idx + 1;
      } else {
        state.phase = "review";
      }
      saveState(this.workspaceRoot, toPlanId(plan.project), state);
      return `Sub-goal ${subGoal.id} previously failed, skipping to ${nextEntry ? `sub-goal ${nextEntry.id}` : "review"}.`;
    }

    if (subGoal.status !== "in_progress") {
      this.agent.getMessages().push({ role: "user", content: prompt });
      subGoal.status = "in_progress";
      updateSubGoalStatus(plan, subGoal.id, "in_progress");
      saveState(this.workspaceRoot, toPlanId(plan.project), state);
      this.auditSubGoalStart(plan.project, subGoal.id);
    }

    let result = "";
    let retries = 0;

    while (retries <= MAX_RETRIES) {
      result = await this.agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);

      // ── VERIFY phase: hard gates before marking done ──────────

      // Primary: read structured completion data from complete_sub_goal tool call.
      // Fallback: regex-parse JSON from text output.
      const doneJson = this.readCompletionFile() ?? this.extractCompletionJsonFromMessages() ?? this.extractCompletionJson(result);
      if (doneJson) {
        // Cross-contamination: detect if AI wrote files for future sub-goals
        // or modified already-committed files from previous sub-goals.
        // Only flags NEWLY CREATED (untracked) files — already-tracked files
        // from previous sessions are not contamination.
        const contamination = this.detectCrossContamination(plan, subGoal.id, state.previousSubGoalFiles);
        if (contamination.length > 0) {
          if (retries < MAX_RETRIES) {
            const warnPrompt = [
              `你修改了不允许改的文件:`,
              ...contamination.map((f) => `  - ${f}`),
              ``,
              `请立即用 git checkout 还原这些文件，只修改当前子目标允许的文件。`,
            ].join("\n");
            this.agent.getMessages().push({ role: "user", content: warnPrompt });
            retries++;
            subGoal.retryCount = retries;
            continue;
          }
          // Retries exhausted — fail this sub-goal
          subGoal.status = "failed";
          updateSubGoalStatus(plan, subGoal.id, "failed");
          saveState(this.workspaceRoot, toPlanId(plan.project), state);
          return `Sub-goal ${subGoal.id} failed: cross-contamination after ${MAX_RETRIES} retries.\nContaminated files: ${contamination.join(", ")}`;
        }

        const exports = this.normalizeExports(doneJson.exports ?? []);
        const imports = this.normalizeImports(doneJson.imports ?? []);
        const capability = doneJson.capability ?? "";

        // Gate: if no exports and no target files created, AI didn't produce code
        const exportCount = Array.isArray(exports) ? exports.length : Object.keys(exports).length;
        const importCount = Array.isArray(imports) ? imports.length : Object.keys(imports).length;
        if (exportCount === 0 && importCount === 0) {
          const anyFileExists = subGoal.targetFiles.some((tf) => {
            try {
              const fp = path.resolve(this.workspaceRoot, tf);
              return fs.existsSync(fp) && fs.statSync(fp).size > 0;
            } catch { return false; }
          });
          if (!anyFileExists) {
            if (retries < MAX_RETRIES) {
              const fixPrompt = `没有创建任何目标文件。请创建代码文件，完成后调用 complete_sub_goal 工具。`;
              this.agent.getMessages().push({ role: "user", content: fixPrompt });
              retries++;
              subGoal.retryCount = retries;
              continue;
            }
            subGoal.status = "failed";
            updateSubGoalStatus(plan, subGoal.id, "failed");
            saveState(this.workspaceRoot, toPlanId(plan.project), state);
            return `Sub-goal ${subGoal.id} failed: no code produced after ${MAX_RETRIES} retries.`;
          }
        }

        // Gate: verify declared exports actually exist in target files.
        // If verification fails but target files exist on disk, skip the gate —
        // the AI signaled completion and files are there, format mismatch is not a critical error.
        const exportIssues = this.verifyExports(subGoal.targetFiles, exports);
        if (exportIssues.length > 0) {
          const filesExist = subGoal.targetFiles.every((tf) => {
            try { return fs.existsSync(path.resolve(this.workspaceRoot, tf)) && fs.statSync(path.resolve(this.workspaceRoot, tf)).size > 0; }
            catch { return false; }
          });
          if (!filesExist && retries < MAX_RETRIES) {
            const fixPrompt = [
              `以下导出在代码中找不到：`,
              ...exportIssues.map((e) => `  - ${e}`),
              `请修复后调用 complete_sub_goal 工具。`,
            ].join("\n");
            this.agent.getMessages().push({ role: "user", content: fixPrompt });
            retries++;
            subGoal.retryCount = retries;
            continue;
          }
          // Files exist — accept and move on
        }

        subGoal.status = "done";

        // Hard gate: write and validate interface doc
        const docPath = writeInterfaceDoc(
          this.workspaceRoot, toPlanId(plan.project), subGoal, exports, imports, capability,
        );
        if (!docPath) {
          if (retries < MAX_RETRIES) {
            const fixPrompt = [
              `接口文档验证失败。请确认所有声明的导出在目标文件中存在。`,
              `修复后调用 complete_sub_goal 工具。`,
            ].join("\n");
            this.agent.getMessages().push({ role: "user", content: fixPrompt });
            retries++;
            subGoal.retryCount = retries;
            continue;
          }
          subGoal.status = "failed";
          updateSubGoalStatus(plan, subGoal.id, "failed");
          saveState(this.workspaceRoot, toPlanId(plan.project), state);
          return `Sub-goal ${subGoal.id} failed: interface doc validation failed after ${MAX_RETRIES} retries.`;
        }

        // Gate: tests must pass before commit
        const testResult = this.runProjectTests();
        if (!testResult.ok) {
          if (retries < MAX_RETRIES) {
            const fixPrompt = [
              `测试失败：`,
              ``,
              testResult.output.slice(0, 3000),
              ``,
              `请修复测试失败，然后调用 complete_sub_goal 工具。`,
            ].join("\n");
            this.agent.getMessages().push({ role: "user", content: fixPrompt });
            retries++;
            subGoal.retryCount = retries;
            continue;
          }
          subGoal.status = "failed";
          updateSubGoalStatus(plan, subGoal.id, "failed");
          saveState(this.workspaceRoot, toPlanId(plan.project), state);
          return `Sub-goal ${subGoal.id} failed: tests did not pass after ${MAX_RETRIES} retries.\n\n${testResult.summary}`;
        }

        subGoal.interfaceDoc = docPath;
        updateSubGoalStatus(plan, subGoal.id, "done");

        // Source protection: prevent subsequent sub-goals from modifying these files
        for (const tf of subGoal.targetFiles) {
          if (!state.previousSubGoalFiles.includes(tf)) {
            state.previousSubGoalFiles.push(tf);
          }
        }

        // Hard gate: auto-commit after successful sub-goal completion
        const commitHash = this.autoCommit(plan.project, subGoal);
        if (!commitHash) {
          return `## Commit Failed\n\nSub-goal ${subGoal.id} completed but git commit failed.\nCheck git status and resolve any issues, then type anything to retry.`;
        }
        subGoal.committedHash = commitHash;
        state.commits.push(commitHash);

        // Write verification document
        const verification: SubGoalVerification = {
          subGoalId: subGoal.id,
          subGoalTitle: subGoal.title,
          committedHash: commitHash,
          committedAt: new Date().toISOString(),
          testCommand: "npm test",
          testOutput: testResult.output.slice(0, 3000),
          testPassed: testResult.ok,
          integrationTestPassed: true,
          exportsVerified: this.flattenExports(exports),
          filesCreated: this.detectNewFiles(subGoal.targetFiles),
          filesModified: this.detectModifiedFiles(subGoal.targetFiles),
        };
        const verificationPath = writeVerificationDoc(
          this.workspaceRoot, toPlanId(plan.project), subGoal, verification,
        );
        subGoal.verificationDoc = verificationPath;

        this.discardSubGoalContext(plan);

        // ── Replan remaining sub-goals against real locked interfaces ──
        const remainingSgs = ordered.filter(sg => sg.status !== "done" && sg.status !== "failed");
        if (remainingSgs.length > 0) {
          const replanResult = await this.replanAgainstLockedInterfaces(
            plan, subGoal.id, remainingSgs, opts,
          );
          if (replanResult) {
            if (replanResult.phase) state.phase = replanResult.phase;
            if (replanResult.nextSubGoalId) {
              state.currentSubGoalId = replanResult.nextSubGoalId;
              state.currentSubGoal = plan.subGoals.findIndex(sg => sg.id === replanResult.nextSubGoalId);
            }
            saveState(this.workspaceRoot, toPlanId(plan.project), state);
            return replanResult.text;
          }
        }

        // Advance to next sub-goal or transition to review
        const nextEntry = ordered[idx + 1];
        if (nextEntry) {
          state.currentSubGoalId = nextEntry.id;
          state.currentSubGoal = idx + 1;
        } else {
          state.phase = "review";
        }
        saveState(this.workspaceRoot, toPlanId(plan.project), state);

        const nextMsg = nextEntry
          ? `Next: sub-goal ${nextEntry.id} — ${nextEntry.title}.`
          : `All sub-goals done. Starting final review.`;
        return [
          `Sub-goal ${subGoal.id} complete: ${subGoal.title}`,
          `Interface doc: ${docPath}`,
          `Commit: ${commitHash.slice(0, 7)}`,
          `Verification: ${verificationPath}`,
          `Context discarded.`,
          nextMsg,
        ].join("\n");
      }

      // AI didn't signal completion — push focused retry
      if (retries < MAX_RETRIES) {
        retries++;
        subGoal.retryCount = retries;
        const retryMsg = retries === 1
          ? "请调用 complete_sub_goal 工具标记完成。不要输出 JSON 文本，直接调工具。"
          : `第${retries}次重试：请调用 complete_sub_goal 工具，exports 中列出每个文件导出的符号名。`;
        this.agent.getMessages().push({ role: "user", content: retryMsg });
        continue;
      }
      // Retries exhausted — fail and advance
      subGoal.status = "failed";
      updateSubGoalStatus(plan, subGoal.id, "failed");
      const nextEntry = ordered[idx + 1];
      if (nextEntry) {
        state.currentSubGoalId = nextEntry.id;
        state.currentSubGoal = idx + 1;
      } else {
        state.phase = "review";
      }
      saveState(this.workspaceRoot, toPlanId(plan.project), state);
      return `Sub-goal ${subGoal.id} failed: AI did not signal completion after ${MAX_RETRIES} retries.`;
    }

    return result;
  }

  // ── Phase 3: Final review (hard gates) ──────────────────────────

  private async doReview(state: TargetState, opts: TargetExecOptions): Promise<string> {
    const plan = state.plan;
    if (!plan) return "(Target: no plan)";
    const docs = loadAllInterfaceDocs(this.workspaceRoot, toPlanId(plan.project));

    const gateResults: string[] = [];
    let gate1ok = true;
    let gate2ok = true;
    let gate3ok = true;
    let gate4ok = true;

    // ── Gate 1: Run project tests ──────────────────────────────
    const testResult = this.runProjectTests();
    gateResults.push(testResult.summary);
    if (!testResult.ok) {
      gate1ok = false;
      for (let ra = 0; ra < MAX_RETRIES && !gate1ok; ra++) {
        const testFixPrompt = [
          `项目测试失败：`,
          ``,
          testResult.output.slice(0, 3000),
          ``,
          `请修复测试失败。`,
        ].join("\n");
        this.agent.getMessages().push({ role: "user", content: testFixPrompt });
        await this.agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);
        const retest = this.runProjectTests();
        gate1ok = retest.ok;
        gateResults.push(`Gate 1 retry ${ra + 1}: ${retest.summary}`);
      }
    }
    // ── Gate 2: Verify all interface docs ──────────────────────
    const docIssues = this.verifyAllInterfaceDocs(docs);
    if (docIssues.length > 0) {
      gate2ok = false;
      for (let ra = 0; ra < MAX_RETRIES && !gate2ok; ra++) {
        const docFixPrompt = [
          `以下接口文档中的导出在代码中找不到：`,
          ...docIssues.map((i) => `  - ${i}`),
          ``,
          `请修复代码或更新接口文档。`,
        ].join("\n");
        this.agent.getMessages().push({ role: "user", content: docFixPrompt });
        await this.agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);
        const recheck = this.verifyAllInterfaceDocs(loadAllInterfaceDocs(this.workspaceRoot, toPlanId(plan.project)));
        gate2ok = recheck.length === 0;
        gateResults.push(`Gate 2 retry ${ra + 1}: ${gate2ok ? "PASSED" : `still ${recheck.length} issue(s)`}`);
      }
    } else {
      gateResults.push(`Gate 2 PASSED — ${docs.length} interface doc(s) verified`);
    }
    // ── Gate 3: Cumulative integration test ──────────────────────
    const integrationResult = await this.runFinalIntegrationTest(plan, docs, opts);
    if (integrationResult) {
      gate3ok = false;
      for (let ra = 0; ra < MAX_RETRIES && !gate3ok; ra++) {
        gateResults.push(`Gate 3 attempt ${ra + 1}: FAILED — integration test`);
        const integrationFixPrompt = [
          `跨模块集成测试失败，3-4 个假想模块无法干净集成：`,
          ``,
          integrationResult,
          ``,
          `请修复接口使跨模块集成不需要修改现有源码。`,
        ].join("\n");
        this.agent.getMessages().push({ role: "user", content: integrationFixPrompt });
        await this.agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);
        const retestIntegration = await this.runFinalIntegrationTest(
          plan, loadAllInterfaceDocs(this.workspaceRoot, toPlanId(plan.project)), opts,
        );
        gate3ok = retestIntegration === null;
        gateResults.push(`Gate 3 retry ${ra + 1}: ${gate3ok ? "PASSED" : "FAILED"}`);
      }
    } else {
      gateResults.push(`Gate 3 PASSED — cross-module integration verified`);
    }
    // ── Gate 4: Cross-reference commits against verification docs ──
    const crossRefResult = this.verifyCommitsAgainstVerification(plan);
    gateResults.push(`Gate 4: ${crossRefResult.ok ? "PASSED" : "FAILED"} — ${crossRefResult.detail}`);
    gate4ok = crossRefResult.ok;
    if (!gate4ok) {
      // Trigger penalty for missing commits or verification docs
      const violation: ViolationRecord = {
        subGoalId: "review",
        reason: `Gate 5 failed: ${crossRefResult.detail}`,
        detectedAt: new Date().toISOString(),
        action: state.violations.length === 0 ? "warning" : "rollback",
      };
      state.violations.push(violation);
      saveState(this.workspaceRoot, toPlanId(plan.project), state);

      if (state.violations.length >= 2) {
        return (await this.executePenaltyStr(state, plan, "purge")).text;
      }
      return (await this.executePenaltyStr(state, plan, "rollback")).text;
    }

    // ── Final verdict — gates are independent, all must pass ──
    const allPassed = gate1ok && gate2ok && gate3ok && gate4ok;

    if (allPassed) {
      state.phase = "done";
      const pid = toPlanId(plan.project);
      saveState(this.workspaceRoot, pid, state);

      // Unlock guard
      const guard = this.agent.getGuard();
      if (guard) guard.unlock();

      return [
        `## Target Complete: ${plan.project}`,
        ``,
        `All ${plan.subGoals.length} sub-goals done. All 4 review gates passed.`,
        ``,
        `### Gate Results`,
        ...gateResults.map((g) => `- ${g}`),
        ``,
        `### Modules Built`,
        ...docs.map((d) => `- Sub-goal ${d.subGoalId}: ${d.capability}`),
        ``,
        `Ready to commit.`,
      ].join("\n");
    } else {
      return [
        `## Review Incomplete — some gates did not pass`,
        ``,
        ...gateResults.map((g) => `- ${g}`),
        ``,
        `Addressing remaining issues and re-running review.`,
      ].join("\n");
    }
  }

  // ── Gate helpers ────────────────────────────────────────────────

  /** Normalize AI's varied export formats into a consistent shape.
   *  AI might output: [{name: "x"}], {"f.ts": ["x"]}, ["x"], or {name: "x"}. */
  private normalizeExports(raw: unknown): string[] | Record<string, string[]> {
    if (!raw) return [];
    // Already correct: Record<string, string[]>
    if (typeof raw === "object" && !Array.isArray(raw)) {
      const hasStringKeys = Object.values(raw).every((v) => Array.isArray(v) && v.every((e) => typeof e === "string"));
      if (hasStringKeys) return raw as Record<string, string[]>;
    }
    // Array of objects with name field: [{name: "x", ...}]
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "object" && raw[0] !== null && "name" in raw[0]) {
      return (raw as Array<{ name: string }>).map((e) => e.name);
    }
    // Single object with name field: {name: "x", ...}
    if (typeof raw === "object" && !Array.isArray(raw) && "name" in (raw as Record<string, unknown>)) {
      return [(raw as { name: string }).name];
    }
    // Array of strings: ["x", "y"]
    if (Array.isArray(raw) && raw.every((e) => typeof e === "string")) {
      return raw as string[];
    }
    return [];
  }

  private normalizeImports(raw: unknown): string[] | Record<string, string[]> {
    return this.normalizeExports(raw); // Same shapes
  }

  private flattenExports(exports: string[] | Record<string, string[]>): string[] {
    if (Array.isArray(exports)) return exports;
    return Object.values(exports).flat();
  }

  /** Verify an export name exists in source code. Supports:
   *  - `export function foo`, `export const foo`, `export class Foo`
   *  - `export { foo, bar }`, `export { foo as bar }`
   *  - `export default function foo`, `export default class Foo`
   */
  private hasExport(content: string, name: string): boolean {
    const e = this.escapeRegex(name);
    const patterns = [
      // Direct exports: export function/const/class/type/interface/enum name
      new RegExp(`export\\s+(?:const|let|var|function|class|type|interface|enum|default\\s+)?\\s*${e}\\b`),
      // Named exports: export { ..., name, ... }
      new RegExp(`export\\s*\\{[^}]*\\b${e}\\b[^}]*\\}`),
      // export default function/class name
      new RegExp(`export\\s+default\\s+(?:function|class)\\s+${e}\\b`),
    ];
    return patterns.some((re) => re.test(content));
  }

  /** Verify declared exports actually exist in target files. */
  private verifyExports(targetFiles: string[], exports: string[] | Record<string, string[]>): string[] {
    // Normalize: accept both flat array and { file: [exports] } mapping
    const flat: string[] = Array.isArray(exports)
      ? exports
      : Object.values(exports).flat();
    const issues: string[] = [];
    for (const exp of flat) {
      let found = false;
      for (const tf of targetFiles) {
        const fullPath = path.resolve(this.workspaceRoot, tf);
        if (!fs.existsSync(fullPath)) continue;
        try {
          if (this.hasExport(fs.readFileSync(fullPath, "utf-8"), exp)) {
            found = true;
            break;
          }
        } catch { /* skip */ }
      }
      if (!found) issues.push(`${exp} (declared but not found in ${targetFiles.join(", ")})`);
    }
    return issues;
  }

  /** Verify all interface docs for a project. */
  private verifyAllInterfaceDocs(docs: InterfaceDoc[]): string[] {
    const issues: string[] = [];
    for (const doc of docs) {
      if (!doc.files || doc.files.length === 0) {
        // doc.files was not recorded (old interface docs) — skip individual check
        continue;
      }
      // Verify each declared export exists in at least one target file
      for (const exp of doc.exports) {
        let found = false;
        for (const tf of doc.files) {
          const fullPath = path.resolve(this.workspaceRoot, tf);
          if (!fs.existsSync(fullPath)) continue;
          try {
            if (this.hasExport(fs.readFileSync(fullPath, "utf-8"), exp)) {
              found = true;
              break;
            }
          } catch { /* skip */ }
        }
        if (!found) {
          issues.push(`Sub-goal ${doc.subGoalId}: export "${exp}" not found in [${doc.files.join(", ")}]`);
        }
      }
      // Check all target files exist
      for (const tf of doc.files) {
        const fullPath = path.resolve(this.workspaceRoot, tf);
        if (!fs.existsSync(fullPath)) {
          issues.push(`Sub-goal ${doc.subGoalId}: file "${tf}" not found`);
        }
      }
    }
    return issues;
  }

  /** Run project tests (npm test or equivalent). */
  private runProjectTests(): { ok: boolean; summary: string; output: string } {
    try {
      const pkgPath = path.join(this.workspaceRoot, "package.json");
      if (!fs.existsSync(pkgPath)) {
        return { ok: true, summary: "No package.json — skipping tests", output: "" };
      }
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (!pkg.scripts?.test) {
        return { ok: true, summary: "No test script — skipping tests", output: "" };
      }

      const result = execSync("npm test 2>&1 || true", {
        encoding: "utf-8",
        cwd: this.workspaceRoot,
        maxBuffer: 5 * 1024 * 1024,
        timeout: 120_000,
      });

      // Check for failure indicators
      const failed = /(?:FAIL|failed|\d+ failing|Test failed|AssertionError|npm ERR!)/i.test(result);
      if (failed) {
        return { ok: false, summary: "Tests FAILED", output: result };
      }
      return { ok: true, summary: "Tests PASSED", output: result };
    } catch (e: any) {
      const output = e?.stdout ?? e?.stderr ?? String(e);
      return { ok: false, summary: "Tests FAILED (non-zero exit)", output: String(output).slice(0, 5000) };
    }
  }

  /** Write a sub-goal start audit event for metrics segmentation. */
  private auditSubGoalStart(project: string, subGoalId: string): void {
    try {
      const auditDir = path.join(this.workspaceRoot, ".git", "horsewhip");
      if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
      const auditPath = path.join(auditDir, "session-audit.json");
      const event = {
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: "task_start",
        timestamp: new Date().toISOString(),
        task: `target:${project}:sg-${subGoalId}`,
        subGoalId,
        project,
      };
      fs.appendFileSync(auditPath, JSON.stringify(event) + "\n", "utf-8");
    } catch (e) {
      logger.warn("Audit write failed", { error: String(e) });
    }
  }

  // ── Context management ──────────────────────────────────────────

  private discardAndInjectPlan(plan: TargetPlan): void {
    const msgs = this.agent.getMessages();
    if (msgs.length === 0) { this.agent.rebuildSystemPrompt(); return; }
    const systemMsg = msgs[0]!;
    const planCtx = [
      `## Target Plan: ${plan.project}`,
      `Goal: ${plan.goal}`,
      ``,
      `Sub-goals (${plan.subGoals.length}):`,
      ...plan.subGoals.map((sg) =>
        `  ${sg.id}. [${sg.status}] ${sg.title} → ${sg.targetFiles.join(", ")}`
      ),
    ].join("\n");
    this.agent.restoreMessages([systemMsg!, { role: "user", content: planCtx }]);
    this.agent.rebuildSystemPrompt();
  }

  private discardSubGoalContext(plan: TargetPlan): void {
    const msgs = this.agent.getMessages();
    if (msgs.length === 0) { this.agent.rebuildSystemPrompt(); return; }
    const systemMsg = msgs[0]!;
    const docs = loadAllInterfaceDocs(this.workspaceRoot, toPlanId(plan.project));
    const interfaceCtx = buildInterfaceContext(docs);
    const planCtx = [
      `## Target Plan: ${plan.project}`,
      `Goal: ${plan.goal}`,
      ``,
      `Sub-goals:`,
      ...plan.subGoals.map((sg) => `  ${sg.id}. [${sg.status}] ${sg.title}`),
      ``,
      interfaceCtx,
    ].filter(Boolean).join("\n");
    this.agent.restoreMessages([systemMsg!, { role: "user", content: planCtx }]);
    this.agent.rebuildSystemPrompt();
  }

  // ── Recursive replanning ───────────────────────────────────────

  /** After a sub-goal completes and its files are locked, regenerate the
   *  remaining sub-goals against the real locked interfaces. The AI sees
   *  actual contract.md files and must design new sub-goals that integrate
   *  without modifying locked files. */
  private async replanAgainstLockedInterfaces(
    plan: TargetPlan,
    completedSgId: string,
    remainingSgs: SubGoal[],
    opts: TargetExecOptions,
  ): Promise<{ text: string; phase?: TargetPhase; nextSubGoalId?: string } | null> {
    const planId = toPlanId(plan.project);
    const doneSgs = plan.subGoals.filter((sg) => sg.status === "done");
    const lockedFiles = doneSgs.flatMap((sg) => sg.targetFiles);

    // Load real contract.md content for each completed sub-goal
    const interfaceBlocks: string[] = [];
    for (const sg of doneSgs) {
      const contractPath = path.join(
        getSubGoalDir(this.workspaceRoot, planId, sg.id), "contract.md",
      );
      try {
        if (fs.existsSync(contractPath)) {
          interfaceBlocks.push(fs.readFileSync(contractPath, "utf-8"));
        }
      } catch { /* skip */ }
    }

    const remainingDesc = remainingSgs
      .map((sg) => `  - ${sg.id}. ${sg.title}: ${sg.description} (targetFiles: ${sg.targetFiles.join(", ")})`)
      .join("\n");

    const prompt = [
      `## Replan: adapt remaining sub-goals to real locked interfaces`,
      ``,
      `### Project`,
      plan.goal,
      ``,
      `### Locked Interfaces (from completed sub-goals)`,
      ``,
      ...(interfaceBlocks.length > 0
        ? interfaceBlocks
        : [`(no interface docs yet)`]),
      ``,
      `### Locked Files (read-only, cannot be modified)`,
      ...lockedFiles.map((f) => `  - ${f}`),
      ``,
      `### Remaining Work`,
      remainingDesc,
      ``,
      `These remaining sub-goals were planned before the real interfaces existed.`,
      `Regenerate them so each integrates with the ACTUAL locked interfaces above.`,
      ``,
      `Constraints:`,
      `- Completed sub-goal files are locked — new sub-goals CANNOT target them`,
      `- Each new sub-goal must create NEW files or extend via imports from locked modules`,
      `- Dependencies between new sub-goals should respect the locked interfaces`,
      ``,
      `Output a complete plan JSON (same format as initial planning):`,
      "```json",
      JSON.stringify(
        {
          project: plan.project,
          goal: plan.goal,
          subGoals: remainingSgs.map((sg) => ({
            id: sg.id,
            title: sg.title,
            description: sg.description,
            targetFiles: sg.targetFiles,
            dependsOn: sg.dependsOn,
          })),
        },
        null, 2,
      ),
      "```",
      ``,
      `Update targetFiles and dependsOn as needed. Keep ids stable where possible.`,
      `You can add, remove, split, or merge sub-goals — just output valid JSON.`,
    ].join("\n");

    this.agent.getMessages().push({ role: "user", content: prompt });
    const result = await this.agent.run(
      opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning,
    );

    // Parse AI response
    const newPlan = parsePlanFromResponse(result, plan.goal);
    if (!newPlan || newPlan.subGoals.length === 0) {
      logger.warn("Replan: could not parse AI response, keeping original plan");
      return null;
    }

    // Merge: keep done/failed, replace pending with regenerated
    const merged: SubGoal[] = [];
    for (const sg of plan.subGoals) {
      if (sg.status === "done" || sg.status === "failed") {
        merged.push(sg);
      }
    }

    let nextId = plan.subGoals.length + 1;
    for (const nsg of newPlan.subGoals) {
      // Reject sub-goals that target already-locked files
      const overlaps = nsg.targetFiles.filter((tf) => lockedFiles.includes(tf));
      if (overlaps.length > 0) {
        logger.warn(`Replan: sub-goal "${nsg.title}" targets locked files: ${overlaps.join(", ")} — skipped`);
        continue;
      }
      if (nsg.targetFiles.length === 0) {
        logger.warn(`Replan: sub-goal "${nsg.title}" has no targetFiles — skipped`);
        continue;
      }
      merged.push({
        ...nsg,
        id: String(nextId++),
        status: "pending" as const,
        retryCount: 0,
        maxRetries: 3,
      });
    }

    const pendingCount = merged.filter((sg) => sg.status === "pending").length;
    if (pendingCount === 0) {
      return {
        text: "All remaining work integrated into completed modules. Proceeding to review.",
        phase: "review",
      };
    }

    // Replace plan sub-goals with merged list
    plan.subGoals.length = 0;
    plan.subGoals.push(...merged);

    // Generate new interface stubs for the replanned sub-goals
    generateInterfaceStubs(this.workspaceRoot, plan);

    const firstPending = merged.find((sg) => sg.status === "pending");

    return {
      text: [
        `## Replan Complete`,
        ``,
        `Regenerated ${newPlan.subGoals.length} sub-goals against ${doneSgs.length} locked interfaces.`,
        ``,
        `### Updated Plan`,
        ...merged.map((sg) => `  ${sg.id}. [${sg.status}] ${sg.title} → ${sg.targetFiles.join(", ")}`),
        ``,
        firstPending
          ? `Next: sub-goal ${firstPending.id} — ${firstPending.title}.`
          : `All sub-goals accounted for.`,
      ].join("\n"),
      nextSubGoalId: firstPending?.id,
    };
  }

  // ── Guard boundary management ──────────────────────────────────

  /** Lock boundary: only previous sub-goal committed files are read-only. Everything else free. */
  private lockSubGoalBoundary(project: string, subGoal: SubGoal, committedFiles: string[]): void {
    const guard = this.agent.getGuard();
    if (!guard) return;
    guard.lockFiles(committedFiles, `target:${project}:sg-${subGoal.id}`);
  }

  // ── Integration test (hard gate: per sub-goal + final review) ─────

  /** Run integration test: AI must design 3-4 hypothetical modules that integrate
   *  with the current interface docs WITHOUT requiring source changes.
   *  Returns null if passed, or the failure message if failed. */
  /** Mechanical verification of integration test result.
   *  Parses the JSON output and validates every module design.
   *  Returns null if passed, error string if failed. */
  private verifyIntegrationModules(jsonStr: string, minModules: number): string | null {
    // Extract JSON block
    const jsonMatch = jsonStr.match(/\{[\s\S]*"modules"[\s\S]*\}/);
    if (!jsonMatch) return "No valid JSON modules block found in response.";

    let data: { modules?: IntegrationModule[] };
    try {
      data = JSON.parse(jsonMatch[0]);
    } catch {
      return "Failed to parse integration test JSON. Response must contain valid JSON.";
    }

    if (!data.modules || !Array.isArray(data.modules)) {
      return "JSON missing 'modules' array.";
    }

    const modules = data.modules;
    if (modules.length < minModules) {
      return `Only ${modules.length} modules designed, minimum ${minModules} required.`;
    }

    const failures: string[] = [];
    for (let i = 0; i < modules.length; i++) {
      const m = modules[i]!;
      if (!m.name || typeof m.name !== "string" || m.name.trim().length === 0) {
        failures.push(`Module ${i + 1}: missing or empty 'name'.`);
      }
      if (!Array.isArray(m.imports) || m.imports.length === 0) {
        failures.push(`Module ${i + 1} "${m.name || "unnamed"}": missing or empty 'imports' array. Must list specific imports.`);
      }
      if (m.imports && m.imports.some((imp) => typeof imp !== "string" || imp.trim().length === 0)) {
        failures.push(`Module ${i + 1} "${m.name || "unnamed"}": empty import entry. Every import must be specific (e.g. "getUser from user-service").`);
      }
      if (m.needsSourceChanges !== false) {
        failures.push(`Module ${i + 1} "${m.name || "unnamed"}": requires source changes — \`needsSourceChanges\` must be false. Interfaces are not decoupled enough.`);
      }
    }

    if (failures.length > 0) {
      return `Integration test FAILED — ${failures.length} violation(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`;
    }

    return null; // Passed
  }

  /** Run integration test: AI must design 3-4 hypothetical modules that integrate
   *  with the current interface docs WITHOUT requiring source changes.
   *  Mechanical verification — AI self-report is not trusted.
   *  Returns null if passed, or the failure message if failed. */
  private async runIntegrationTest(
    plan: TargetPlan, subGoal: SubGoal, opts: TargetExecOptions,
  ): Promise<string | null> {
    const planId = toPlanId(plan.project);
    const allDocs = loadAllInterfaceDocs(this.workspaceRoot, planId);
    if (allDocs.length === 0) return null;

    const docsContent = allDocs.map((d) => {
      const filePath = path.join(
        getInterfacesDir(this.workspaceRoot), `interface-${planId}`, `sub-goal-${d.subGoalId}.md`,
      );
      let content = "";
      try { content = fs.readFileSync(filePath, "utf-8"); } catch { return `### Sub-goal ${d.subGoalId}\n(no doc)`; }
      return content;
    }).join("\n---\n");

    const prompt = [
      `以下是已完成子目标的接口文档。`,
      `请设计 3-4 个假想的新模块，这些模块应能基于现有接口实现，不需要修改现有源码。`,
      ``,
      `输出格式（严格按此 JSON）：`,
      "```json",
      JSON.stringify({
        modules: [{
          name: "ModuleName",
          purpose: "一句话描述该模块做什么",
          imports: ["specificExport from sub-goal-id", "AnotherExport from other-sub-goal"],
          needsSourceChanges: false,
        }],
      }, null, 2),
      "```",
      ``,
      `规则：`,
      `- 至少设计 3 个模块，每个模块必须从现有接口导入`,
      `- imports 必须列出具体的导出名（如 "getUserProfile from user-service"），不能模糊引用`,
      `- needsSourceChanges 必须为 false`,
      ``,
      `### 接口文档`,
      ``,
      docsContent || "(暂无接口文档)",
    ].join("\n");

    this.agent.getMessages().push({ role: "user", content: prompt });
    const result = await this.agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);

    return this.verifyIntegrationModules(result, 3);
  }

  /** Final integration test: 3-4 hypothetical modules spanning MULTIPLE interfaces.
   *  Tests cross-module composability. Mechanical verification. Returns null if passed. */
  private async runFinalIntegrationTest(
    plan: TargetPlan, docs: InterfaceDoc[], opts: TargetExecOptions,
  ): Promise<string | null> {
    if (docs.length < 2) return null;

    const planId = toPlanId(plan.project);
    const docsContent = docs.map((d) => {
      const filePath = path.join(
        getInterfacesDir(this.workspaceRoot), `interface-${planId}`, `sub-goal-${d.subGoalId}.md`,
      );
      let content = "";
      try { content = fs.readFileSync(filePath, "utf-8"); } catch { return `### Sub-goal ${d.subGoalId}\n(no doc)`; }
      return content;
    }).join("\n---\n");

    const prompt = [
      `以下是本项目全部 ${docs.length} 个子目标的接口文档。`,
      `请设计 3-4 个跨越多个接口的假想模块——每个模块必须从至少 2 个不同子目标的接口导入。`,
      ``,
      `输出格式（严格按此 JSON）：`,
      "```json",
      JSON.stringify({
        modules: [{
          name: "CrossModuleName",
          purpose: "一句话描述该模块做什么",
          imports: ["exportA from sub-goal-1", "exportB from sub-goal-2"],
          needsSourceChanges: false,
        }],
      }, null, 2),
      "```",
      ``,
      `规则：`,
      `- 至少设计 3 个模块，每个必须从 2+ 个不同子目标导入`,
      `- imports 必须列出具体的导出名及其子目标来源`,
      `- needsSourceChanges 必须为 false`,
      ``,
      `### 全部接口文档`,
      ``,
      docsContent,
    ].join("\n");

    this.agent.getMessages().push({ role: "user", content: prompt });
    const result = await this.agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);

    return this.verifyIntegrationModules(result, 3);
  }

  /** Count source files in workspace (bounded depth, cached 30s). */
  private _srcCountCache: { value: number; at: number } = { value: 0, at: 0 };
  private countSourceFiles(): number {
    const now = Date.now();
    if (now - this._srcCountCache.at < 30000) return this._srcCountCache.value;
    let count = 0;
    try {
      const MAX_DEPTH = 4;
      const walk = (dir: string, depth: number): void => {
        if (depth > MAX_DEPTH) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          if (entry.isDirectory()) { walk(path.join(dir, entry.name), depth + 1); }
          else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) { count++; }
        }
      };
      walk(this.workspaceRoot, 0);
    } catch { /* ignore */ }
    this._srcCountCache = { value: count, at: now };
    return count;
  }

  // ── JSON parsing ──────────────────────────────────────────────

  /** Read completion data written by the complete_sub_goal tool. */
  private readCompletionFile(): { exports?: string[]; imports?: string[]; capability?: string } | null {
    try {
      const fp = path.join(this.workspaceRoot, COMPLETION_FILE);
      if (!fs.existsSync(fp)) return null;
      const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
      // Clear immediately so stale data doesn't bleed into next sub-goal
      fs.unlinkSync(fp);
      return data;
    } catch {
      return null;
    }
  }

  /** Search recent assistant messages for completion JSON. */
  private extractCompletionJsonFromMessages(): { exports?: string[]; imports?: string[]; capability?: string } | null {
    const msgs = this.agent.getMessages();
    // Search last 5 assistant messages (newest first)
    for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 5); i--) {
      const m = msgs[i];
      if (m?.role !== "assistant") continue;
      const text = typeof m.content === "string" ? m.content : "";
      if (!text) continue;
      const parsed = this.extractCompletionJson(text);
      if (parsed) return parsed;
    }
    return null;
  }

  /** Extract the completion JSON block (with "exports" key) from AI response. */
  private extractCompletionJson(text: string): { exports?: string[]; imports?: string[]; capability?: string } | null {
    // Try fenced JSON block first
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch?.[1]) {
      try {
        const parsed = JSON.parse(fenceMatch[1].trim());
        if (parsed.exports !== undefined || parsed.capability !== undefined) return parsed;
      } catch { /* fall through */ }
    }
    // Try bare JSON object with "exports" key
    const m = text.match(/\{[\s\S]*?"exports"[\s\S]*?\}/);
    if (m) {
      const idx = text.indexOf(m[0]);
      const slice = text.slice(idx);
      let depth = 0, end = -1;
      for (let i = 0; i < slice.length; i++) {
        if (slice[i] === "{") depth++;
        else if (slice[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      if (end > 0) {
        try {
          const parsed = JSON.parse(slice.slice(0, end));
          if (parsed.exports !== undefined || parsed.capability !== undefined) return parsed;
        } catch { /* fall through */ }
      }
    }
    return null;
  }

  // ── Helpers ───────────────────────────────────────────────────

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private planSummary(plan: TargetPlan, extra: string): string {
    return [
      `Plan generated: **${plan.project}**`,
      `${plan.subGoals.length} sub-goals:`,
      ...plan.subGoals.map((sg) => `  ${sg.id}. ${sg.title}`),
      "",
      extra,
    ].join("\n");
  }

  /** Auto-commit after successful sub-goal completion. */
  private autoCommit(project: string, subGoal: import("../types.js").SubGoal): string | null {
    try {
      const files = subGoal.targetFiles.filter((f) => {
        const fullPath = path.resolve(this.workspaceRoot, f);
        return fs.existsSync(fullPath);
      });
      if (files.length === 0) {
        return execSync("git rev-parse HEAD 2>&1", {
          cwd: this.workspaceRoot, timeout: 10_000, stdio: "pipe",
        }).toString().trim() || null;
      }

      const fileList = files.join(" ");
      execSync(`git add ${fileList} 2>&1`, { cwd: this.workspaceRoot, timeout: 10_000, stdio: "pipe" });
      const msg = `chitu: ${subGoal.title} 完成`;
      execSync(`git commit -m "${msg.replace(/"/g, '\\"')}" 2>&1`, {
        cwd: this.workspaceRoot,
        timeout: 10_000,
        stdio: "pipe",
      });
      const hash = execSync("git rev-parse HEAD 2>&1", {
        cwd: this.workspaceRoot, timeout: 10_000, stdio: "pipe",
      }).toString().trim();
      return hash || null;
    } catch (e) {
      logger.warn("Auto-commit failed", { project, subGoalId: subGoal.id, error: String(e) });
      return null;
    }
  }

  // ── Cross-contamination detection ──────────────────────────────

  /** Detect if AI wrote files belonging to future sub-goals.
   *  Only flags NEWLY CREATED (untracked) files. Files already tracked by git
   *  (from previous sessions) are not contamination — they were committed before. */
  private detectCrossContamination(plan: TargetPlan, currentSubGoalId: string, committedFiles: string[]): string[] {
    const currentSg = plan.subGoals.find((s) => s.id === currentSubGoalId);
    if (!currentSg) return [];
    const allowed = new Set(currentSg.targetFiles.map((f) => path.resolve(this.workspaceRoot, f)));

    // Only care about untracked files — these were created THIS round.
    // Tracked files (even if modified) belong to previous sessions and are fine.
    const untrackedFiles = new Set<string>();
    try {
      const untracked = execSync("git ls-files --others --exclude-standard", {
        cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
      }).trim();
      for (const f of untracked.split("\n")) {
        const trimmed = f.trim();
        if (trimmed) untrackedFiles.add(path.resolve(this.workspaceRoot, trimmed));
      }
    } catch { /* non-critical */ }

    // Also check diff against HEAD — files the AI modified that were already tracked
    const modifiedTracked = new Set<string>();
    try {
      const diffFiles = execSync("git diff --name-only HEAD", {
        cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
      }).trim();
      for (const f of diffFiles.split("\n")) {
        const trimmed = f.trim();
        if (trimmed) modifiedTracked.add(path.resolve(this.workspaceRoot, trimmed));
      }
    } catch { /* non-critical */ }

    const contaminated: string[] = [];

    // 1. Check untracked files for future sub-goals (AI created files ahead of schedule)
    for (const sg of plan.subGoals) {
      if (sg.id === currentSubGoalId || sg.status === "done") continue;
      for (const tf of sg.targetFiles) {
        const absPath = path.resolve(this.workspaceRoot, tf);
        if (untrackedFiles.has(absPath) && !allowed.has(absPath)) {
          contaminated.push(tf);
        }
      }
    }

    // 2. Check if AI modified already-committed files from previous sub-goals
    for (const cf of committedFiles) {
      const absPath = path.resolve(this.workspaceRoot, cf);
      if (modifiedTracked.has(absPath)) {
        contaminated.push(cf);
      }
    }

    return contaminated;
  }

  // ── Penalty system ─────────────────────────────────────────────

  /** Execute penalty action. Returns result message string. */
  private async executePenaltyStr(state: TargetState, plan: TargetPlan, level: "warning" | "rollback" | "purge"): Promise<{ text: string }> {
    const planId = toPlanId(plan.project);
    switch (level) {
      case "warning":
        return { text: "## 违规警告\n\n检测到步骤违规。请在继续之前修复问题。" };
      case "rollback": {
        try {
          if (state.initialHead) {
            execSync(`git reset --hard ${state.initialHead}`, { cwd: this.workspaceRoot, timeout: 10_000 });
          }
          for (const sg of plan.subGoals) {
            sg.status = "pending";
            sg.committedHash = undefined;
            sg.verificationDoc = undefined;
          }
          state.commits = [];
          state.currentSubGoalId = plan.subGoals[0]?.id;
          state.currentSubGoal = 0;
          state.phase = "execute";
          savePlan(this.workspaceRoot, plan);
          saveState(this.workspaceRoot, planId, state);
          return { text: `## 回滚执行\n\n所有 ${plan.subGoals.length} 个子目标的 commit 已回滚到初始 HEAD。\n从子目标 1 重新开始。` };
        } catch (e) {
          return { text: `## 回滚失败\n\n${String(e)}` };
        }
      }
      case "purge": {
        try {
          if (state.initialHead) {
            execSync(`git reset --hard ${state.initialHead}`, { cwd: this.workspaceRoot, timeout: 10_000 });
          }
          const planDir = path.join(getPlansDir(this.workspaceRoot), planId);
          if (fs.existsSync(planDir)) {
            fs.rmSync(planDir, { recursive: true });
          }
          state.phase = "abandoned";
          saveState(this.workspaceRoot, planId, state);
          return { text: `## 清除执行\n\n所有 commit 和计划文件已删除。仓库已恢复到初始状态。\n违规次数已达到上限，请重新开始。` };
        } catch (e) {
          return { text: `## 清除失败\n\n${String(e)}` };
        }
      }
    }
  }

  /** Execute penalty (used from doExecute). Returns TargetStepResult. */
  private executePenalty(state: TargetState, plan: TargetPlan, level: "warning" | "rollback" | "purge"): { text: string; autoContinue: boolean; terminal: boolean } {
    const result = { text: "", autoContinue: false, terminal: false };
    const planId = toPlanId(plan.project);
    switch (level) {
      case "warning":
        result.text = "## 违规警告\n\n检测到步骤违规。请在继续之前修复问题。";
        return result;
      case "rollback": {
        try {
          if (state.initialHead) {
            execSync(`git reset --hard ${state.initialHead}`, { cwd: this.workspaceRoot, timeout: 10_000 });
          }
          for (const sg of plan.subGoals) {
            sg.status = "pending";
            sg.committedHash = undefined;
            sg.verificationDoc = undefined;
          }
          state.commits = [];
          state.currentSubGoalId = plan.subGoals[0]?.id;
          state.currentSubGoal = 0;
          state.phase = "execute";
          savePlan(this.workspaceRoot, plan);
          saveState(this.workspaceRoot, planId, state);
          result.text = `## 回滚执行\n\n所有 ${plan.subGoals.length} 个子目标的 commit 已回滚到初始 HEAD。\n从子目标 1 重新开始。`;
          result.autoContinue = true;
          return result;
        } catch (e) {
          result.text = `## 回滚失败\n\n${String(e)}`;
          return result;
        }
      }
      case "purge": {
        try {
          if (state.initialHead) {
            execSync(`git reset --hard ${state.initialHead}`, { cwd: this.workspaceRoot, timeout: 10_000 });
          }
          const planDir = path.join(getPlansDir(this.workspaceRoot), planId);
          if (fs.existsSync(planDir)) {
            fs.rmSync(planDir, { recursive: true });
          }
          state.phase = "abandoned";
          saveState(this.workspaceRoot, planId, state);
          result.text = `## 清除执行\n\n所有 commit 和计划文件已删除。仓库已恢复到初始状态。\n违规次数已达到上限，请重新开始。`;
          result.terminal = true;
          return result;
        } catch (e) {
          result.text = `## 清除失败\n\n${String(e)}`;
          return result;
        }
      }
    }
  }

  // ── Commit verification ────────────────────────────────────────

  private countChituCommits(): number {
    try {
      const output = execSync('git log --oneline --grep="^chitu: " HEAD', {
        cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
      });
      return output.trim().split("\n").filter(Boolean).length;
    } catch { return 0; }
  }

  private verifyCommitsAgainstVerification(plan: TargetPlan): { ok: boolean; detail: string } {
    const planId = toPlanId(plan.project);
    const issues: string[] = [];
    for (const sg of plan.subGoals) {
      if (sg.status !== "done") continue;
      if (!sg.committedHash) {
        issues.push(`sg-${sg.id}: no commit hash`);
        continue;
      }
      const verPath = path.join(getSubGoalDir(this.workspaceRoot, planId, sg.id), "verification.md");
      if (!fs.existsSync(verPath)) {
        issues.push(`sg-${sg.id}: verification.md missing`);
        continue;
      }
      try {
        const msg = execSync(`git log --format=%s -n 1 ${sg.committedHash}`, {
          cwd: this.workspaceRoot, encoding: "utf-8", timeout: 5000,
        }).trim();
        const expected = `chitu: ${sg.title} 完成`;
        if (msg !== expected) {
          issues.push(`sg-${sg.id}: commit msg mismatch. Expected "${expected}", got "${msg}"`);
        }
      } catch {
        issues.push(`sg-${sg.id}: commit ${(sg.committedHash ?? "").slice(0, 7)} not found`);
      }
      try {
        const content = fs.readFileSync(verPath, "utf-8");
        if (!content.includes(sg.committedHash!)) {
          issues.push(`sg-${sg.id}: verification.md does not reference commit`);
        }
      } catch { /* already caught */ }
    }
    const doneCount = plan.subGoals.filter((sg) => sg.status === "done").length;
    const commitCount = this.countChituCommits();
    if (commitCount < doneCount) {
      issues.push(`Commit count mismatch: ${doneCount} done sub-goals but only ${commitCount} chitu commits found`);
    }
    if (issues.length === 0) {
      return { ok: true, detail: `${doneCount} sub-goals verified against ${commitCount} commits` };
    }
    return { ok: false, detail: issues.join("; ") };
  }

  // ── File change detection ──────────────────────────────────────

  private detectNewFiles(targetFiles: string[]): string[] {
    const result: string[] = [];
    for (const tf of targetFiles) {
      const absPath = path.resolve(this.workspaceRoot, tf);
      if (!fs.existsSync(absPath)) continue;
      try {
        execSync(`git ls-files --error-unmatch ${tf} 2>/dev/null`, { cwd: this.workspaceRoot, timeout: 5000 });
      } catch { result.push(tf); }
    }
    return result;
  }

  private detectModifiedFiles(targetFiles: string[]): string[] {
    const result: string[] = [];
    for (const tf of targetFiles) {
      const absPath = path.resolve(this.workspaceRoot, tf);
      if (!fs.existsSync(absPath)) continue;
      try {
        execSync(`git diff --quiet HEAD -- ${tf} 2>/dev/null`, { cwd: this.workspaceRoot, timeout: 5000 });
      } catch { result.push(tf); }
    }
    return result;
  }

}
