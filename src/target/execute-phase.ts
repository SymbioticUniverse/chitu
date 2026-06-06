import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { logger } from "../logger.js";
import type { Agent } from "../agent.js";
import type {
  TargetPlan, TargetPhase, TargetState, SubGoal, InterfaceDoc,
  SubGoalVerification, ViolationRecord,
} from "../types.js";
import { getContentText } from "../types.js";
import {
  checkGoalCompleteness,
  buildClarificationPrompt,
  buildPlanGenerationPrompt,
  parsePlanFromResponse,
  savePlan,
  updateSubGoalStatus,
  planId as toPlanId,
  getSubGoalDir,
  getPlansDir,
} from "./plan.js";
import {
  writeInterfaceDoc,
  loadAllInterfaceDocs,
  buildInterfaceContext,
  generateInterfaceStubs,
  getInterfacesDir,
} from "./interface-doc.js";
import { writeVerificationDoc } from "./verification.js";
import { COMPLETION_FILE } from "../tools/index.js";
import { loadState, saveState, goalToTempId } from "./state.js";
import type { TargetExecOptions } from "./executor.js";

// ── Integration test types ─────────────────────────────────────

interface IntegrationModule {
  name: string;
  purpose: string;
  imports: string[];
  needsSourceChanges: boolean;
}

const MAX_RETRIES = 3;

// ── Topological sort by dependsOn ────────────────────────────────

export function sortByDeps(subGoals: SubGoal[]): SubGoal[] {
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

export function findSubGoal(ordered: SubGoal[], subGoalId: string): { sg: SubGoal; idx: number } | null {
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]!.id === subGoalId) return { sg: ordered[i]!, idx: i };
  }
  return null;
}

// ── Phase 1: Clarify ───────────────────────────────────────────

export function lastAssistantContent(agent: Agent): string | null {
  const last = [...agent.getMessages()].reverse().find((m) => m.role === "assistant");
  if (!last) return null;
  return getContentText(last.content) ?? null;
}

export function transitionToPlan(
  agent: Agent, workspaceRoot: string, goal: string, state: TargetState, plan: TargetPlan,
): string {
  const planId = toPlanId(plan.project);
  savePlan(workspaceRoot, plan);
  generateInterfaceStubs(workspaceRoot, plan);
  state.phase = "execute";
  state.planConfirmed = true;
  state.plan = plan;
  state.goal = goal;
  state.currentSubGoalId = plan.subGoals[0]?.id;
  if (!state.initialHead) {
    try {
      state.initialHead = execSync("git rev-parse HEAD", {
        cwd: workspaceRoot, encoding: "utf-8", timeout: 5000,
      }).trim();
    } catch { state.initialHead = ""; }
  }
  saveState(workspaceRoot, planId, state);
  discardAndInjectPlan(agent, plan);
  return planSummary(plan, "Plan generated. Starting execution.");
}

export async function doClarify(
  agent: Agent, workspaceRoot: string,
  goal: string, state: TargetState, opts: TargetExecOptions,
): Promise<string> {
  const assistantText = lastAssistantContent(agent);
  const allMsgs = agent.getMessages();
  const lastMsg = allMsgs[allMsgs.length - 1];

  if (assistantText) {
    const plan = parsePlanFromResponse(assistantText, goal);
    if (plan) return transitionToPlan(agent, workspaceRoot, goal, state, plan);

    const hasQuestion = /(?:\?|？)/.test(assistantText) && lastMsg?.role === "assistant";
    if (hasQuestion && state.clarificationRounds < 2) {
      state.clarificationRounds++;
      saveState(workspaceRoot, state.plan?.project ? toPlanId(state.plan.project) : goalToTempId(goal), state);
      return assistantText;
    }
  }

  state.clarificationRounds++;
  const FORCE_PLAN_AFTER = 3;
  const forcePlan = state.clarificationRounds >= FORCE_PLAN_AFTER || checkGoalCompleteness(goal).complete;
  const prompt = forcePlan
    ? buildPlanGenerationPrompt(goal)
    : buildClarificationPrompt(goal, state.clarificationRounds);

  const guard = agent.getGuard();
  if (guard) guard.lockFiles([], "target:clarify");

  agent.getMessages().push({ role: "user", content: prompt });
  const result = await agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);

  const plan = parsePlanFromResponse(result, goal);
  if (plan) return transitionToPlan(agent, workspaceRoot, goal, state, plan);

  saveState(workspaceRoot, goalToTempId(goal), state);
  return result;
}

// ── Phase 1.5: Plan (auto-confirmed) ────────────────────────────

export async function doPlan(
  workspaceRoot: string, state: TargetState, _opts: TargetExecOptions,
): Promise<string> {
  const plan = state.plan;
  if (!plan) {
    state.phase = "clarify";
    state.planConfirmed = false;
    return "(Target: plan lost, returning to clarify)";
  }

  state.phase = "execute";
  state.planConfirmed = true;
  if (!state.initialHead) {
    try {
      state.initialHead = execSync("git rev-parse HEAD", {
        cwd: workspaceRoot, encoding: "utf-8", timeout: 5000,
      }).trim();
    } catch { state.initialHead = ""; }
  }
  saveState(workspaceRoot, toPlanId(plan.project), state);
  return `Plan auto-confirmed. Starting execution.`;
}

// ── Context management ──────────────────────────────────────────

export function discardAndInjectPlan(agent: Agent, plan: TargetPlan): void {
  const msgs = agent.getMessages();
  if (msgs.length === 0) { agent.rebuildSystemPrompt(); return; }
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
  agent.restoreMessages([systemMsg!, { role: "user", content: planCtx }]);
  agent.rebuildSystemPrompt();
}

export function discardSubGoalContext(agent: Agent, workspaceRoot: string, plan: TargetPlan): void {
  const msgs = agent.getMessages();
  if (msgs.length === 0) { agent.rebuildSystemPrompt(); return; }
  const systemMsg = msgs[0]!;
  const docs = loadAllInterfaceDocs(workspaceRoot, toPlanId(plan.project));
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
  agent.restoreMessages([systemMsg!, { role: "user", content: planCtx }]);
  agent.rebuildSystemPrompt();
}

// ── Guard boundary management ──────────────────────────────────

export function lockSubGoalBoundary(
  agent: Agent, project: string, subGoal: SubGoal, committedFiles: string[],
): void {
  const guard = agent.getGuard();
  if (!guard) return;
  guard.lockFiles(committedFiles, `target:${project}:sg-${subGoal.id}`);
}

// ── JSON parsing helpers ──────────────────────────────────────────────

export function readCompletionFile(workspaceRoot: string): {
  exports?: string[]; imports?: string[]; capability?: string;
} | null {
  try {
    const fp = path.join(workspaceRoot, COMPLETION_FILE);
    if (!fs.existsSync(fp)) return null;
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    fs.unlinkSync(fp);
    return data;
  } catch { return null; }
}

export function extractCompletionJson(text: string): {
  exports?: string[]; imports?: string[]; capability?: string;
} | null {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed.exports !== undefined || parsed.capability !== undefined) return parsed;
    } catch { /* fall through */ }
  }
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

export function extractCompletionJsonFromMessages(agent: Agent): {
  exports?: string[]; imports?: string[]; capability?: string;
} | null {
  const msgs = agent.getMessages();
  for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 5); i--) {
    const m = msgs[i];
    if (m?.role !== "assistant") continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (!text) continue;
    const parsed = extractCompletionJson(text);
    if (parsed) return parsed;
  }
  return null;
}

// ── Gate helpers: export normalization & verification ──────────

export function normalizeExports(raw: unknown): string[] | Record<string, string[]> {
  if (!raw) return [];
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const hasStringKeys = Object.values(raw).every(
      (v) => Array.isArray(v) && v.every((e) => typeof e === "string"),
    );
    if (hasStringKeys) return raw as Record<string, string[]>;
  }
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "object" && raw[0] !== null && "name" in raw[0]) {
    return (raw as Array<{ name: string }>).map((e) => e.name);
  }
  if (typeof raw === "object" && !Array.isArray(raw) && "name" in (raw as Record<string, unknown>)) {
    return [(raw as { name: string }).name];
  }
  if (Array.isArray(raw) && raw.every((e) => typeof e === "string")) {
    return raw as string[];
  }
  return [];
}

export function normalizeImports(raw: unknown): string[] | Record<string, string[]> {
  return normalizeExports(raw);
}

export function flattenExports(exports: string[] | Record<string, string[]>): string[] {
  if (Array.isArray(exports)) return exports;
  return Object.values(exports).flat();
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasExport(content: string, name: string): boolean {
  const e = escapeRegex(name);
  const patterns = [
    new RegExp(`export\\s+(?:const|let|var|function|class|type|interface|enum|default\\s+)?\\s*${e}\\b`),
    new RegExp(`export\\s*\\{[^}]*\\b${e}\\b[^}]*\\}`),
    new RegExp(`export\\s+default\\s+(?:function|class)\\s+${e}\\b`),
  ];
  return patterns.some((re) => re.test(content));
}

export function verifyExports(
  workspaceRoot: string, targetFiles: string[],
  exports: string[] | Record<string, string[]>,
): string[] {
  const flat: string[] = Array.isArray(exports) ? exports : Object.values(exports).flat();
  const issues: string[] = [];
  for (const exp of flat) {
    let found = false;
    for (const tf of targetFiles) {
      const fullPath = path.resolve(workspaceRoot, tf);
      if (!fs.existsSync(fullPath)) continue;
      try {
        if (hasExport(fs.readFileSync(fullPath, "utf-8"), exp)) { found = true; break; }
      } catch { /* skip */ }
    }
    if (!found) issues.push(`${exp} (declared but not found in ${targetFiles.join(", ")})`);
  }
  return issues;
}

export function verifyAllInterfaceDocs(workspaceRoot: string, docs: InterfaceDoc[]): string[] {
  const issues: string[] = [];
  for (const doc of docs) {
    if (!doc.files || doc.files.length === 0) continue;
    for (const exp of doc.exports) {
      let found = false;
      for (const tf of doc.files) {
        const fullPath = path.resolve(workspaceRoot, tf);
        if (!fs.existsSync(fullPath)) continue;
        try {
          if (hasExport(fs.readFileSync(fullPath, "utf-8"), exp)) { found = true; break; }
        } catch { /* skip */ }
      }
      if (!found) issues.push(`Sub-goal ${doc.subGoalId}: export "${exp}" not found in [${doc.files.join(", ")}]`);
    }
    for (const tf of doc.files) {
      const fullPath = path.resolve(workspaceRoot, tf);
      if (!fs.existsSync(fullPath)) issues.push(`Sub-goal ${doc.subGoalId}: file "${tf}" not found`);
    }
  }
  return issues;
}

// ── Test runner ─────────────────────────────────────────────────

export function runProjectTests(workspaceRoot: string): { ok: boolean; summary: string; output: string } {
  try {
    const pkgPath = path.join(workspaceRoot, "package.json");
    if (!fs.existsSync(pkgPath)) {
      return { ok: true, summary: "No package.json — skipping tests", output: "" };
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (!pkg.scripts?.test) {
      return { ok: true, summary: "No test script — skipping tests", output: "" };
    }
    const result = execSync("npm test 2>&1 || true", {
      encoding: "utf-8", cwd: workspaceRoot,
      maxBuffer: 5 * 1024 * 1024, timeout: 120_000,
    });
    const failed = /(?:FAIL|failed|\d+ failing|Test failed|AssertionError|npm ERR!)/i.test(result);
    return failed
      ? { ok: false, summary: "Tests FAILED", output: result }
      : { ok: true, summary: "Tests PASSED", output: result };
  } catch (e: any) {
    const output = e?.stdout ?? e?.stderr ?? String(e);
    return { ok: false, summary: "Tests FAILED (non-zero exit)", output: String(output).slice(0, 5000) };
  }
}

// ── Audit ───────────────────────────────────────────────────────

export function auditSubGoalStart(workspaceRoot: string, project: string, subGoalId: string): void {
  try {
    const auditDir = path.join(workspaceRoot, ".git", "horsewhip");
    if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
    const auditPath = path.join(auditDir, "session-audit.json");
    const event = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "task_start",
      timestamp: new Date().toISOString(),
      task: `target:${project}:sg-${subGoalId}`,
      subGoalId, project,
    };
    fs.appendFileSync(auditPath, JSON.stringify(event) + "\n", "utf-8");
  } catch (e) {
    logger.warn("Audit write failed", { error: String(e) });
  }
}

// ── Integration test verification ───────────────────────────────

export function verifyIntegrationModules(jsonStr: string, minModules: number): string | null {
  const jsonMatch = jsonStr.match(/\{[\s\S]*"modules"[\s\S]*\}/);
  if (!jsonMatch) return "No valid JSON modules block found in response.";
  let data: { modules?: IntegrationModule[] };
  try { data = JSON.parse(jsonMatch[0]); } catch {
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
      failures.push(`Module ${i + 1} "${m.name || "unnamed"}": missing or empty 'imports' array.`);
    }
    if (m.imports && m.imports.some((imp) => typeof imp !== "string" || imp.trim().length === 0)) {
      failures.push(`Module ${i + 1} "${m.name || "unnamed"}": empty import entry.`);
    }
    if (m.needsSourceChanges !== false) {
      failures.push(`Module ${i + 1} "${m.name || "unnamed"}": requires source changes — \`needsSourceChanges\` must be false.`);
    }
  }
  if (failures.length > 0) {
    return `Integration test FAILED — ${failures.length} violation(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`;
  }
  return null;
}

export async function runIntegrationTest(
  agent: Agent, workspaceRoot: string,
  plan: TargetPlan, subGoal: SubGoal, opts: TargetExecOptions,
): Promise<string | null> {
  const planId = toPlanId(plan.project);
  const allDocs = loadAllInterfaceDocs(workspaceRoot, planId);
  if (allDocs.length === 0) return null;
  const docsContent = allDocs.map((d) => {
    const filePath = path.join(
      getInterfacesDir(workspaceRoot), `interface-${planId}`, `sub-goal-${d.subGoalId}.md`,
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
        name: "ModuleName", purpose: "一句话描述该模块做什么",
        imports: ["specificExport from sub-goal-id"],
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
    `### 接口文档`, ``, docsContent || "(暂无接口文档)",
  ].join("\n");

  agent.getMessages().push({ role: "user", content: prompt });
  const result = await agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);
  return verifyIntegrationModules(result, 3);
}

export async function runFinalIntegrationTest(
  agent: Agent, workspaceRoot: string,
  plan: TargetPlan, docs: InterfaceDoc[], opts: TargetExecOptions,
): Promise<string | null> {
  if (docs.length < 2) return null;
  const planId = toPlanId(plan.project);
  const docsContent = docs.map((d) => {
    const filePath = path.join(
      getInterfacesDir(workspaceRoot), `interface-${planId}`, `sub-goal-${d.subGoalId}.md`,
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
        name: "CrossModuleName", purpose: "一句话描述该模块做什么",
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
    `### 全部接口文档`, ``, docsContent,
  ].join("\n");

  agent.getMessages().push({ role: "user", content: prompt });
  const result = await agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);
  return verifyIntegrationModules(result, 3);
}

// ── Auto commit ─────────────────────────────────────────────────

export function autoCommit(workspaceRoot: string, project: string, subGoal: SubGoal): string | null {
  try {
    const files = subGoal.targetFiles.filter((f) => {
      const fullPath = path.resolve(workspaceRoot, f);
      return fs.existsSync(fullPath);
    });
    if (files.length === 0) {
      return execSync("git rev-parse HEAD 2>&1", {
        cwd: workspaceRoot, timeout: 10_000, stdio: "pipe",
      }).toString().trim() || null;
    }
    const fileList = files.join(" ");
    execSync(`git add ${fileList} 2>&1`, { cwd: workspaceRoot, timeout: 10_000, stdio: "pipe" });
    const msg = `chitu: ${subGoal.title} 完成`;
    execSync(`git commit -m "${msg.replace(/"/g, '\\"')}" 2>&1`, {
      cwd: workspaceRoot, timeout: 10_000, stdio: "pipe",
    });
    const hash = execSync("git rev-parse HEAD 2>&1", {
      cwd: workspaceRoot, timeout: 10_000, stdio: "pipe",
    }).toString().trim();
    return hash || null;
  } catch (e) {
    logger.warn("Auto-commit failed", { project, subGoalId: subGoal.id, error: String(e) });
    return null;
  }
}

// ── Cross-contamination detection ──────────────────────────────

export function detectCrossContamination(
  workspaceRoot: string, plan: TargetPlan,
  currentSubGoalId: string, committedFiles: string[],
): string[] {
  const currentSg = plan.subGoals.find((s) => s.id === currentSubGoalId);
  if (!currentSg) return [];
  const allowed = new Set(currentSg.targetFiles.map((f) => path.resolve(workspaceRoot, f)));

  const untrackedFiles = new Set<string>();
  try {
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd: workspaceRoot, encoding: "utf-8", timeout: 5000,
    }).trim();
    for (const f of untracked.split("\n")) {
      const trimmed = f.trim();
      if (trimmed) untrackedFiles.add(path.resolve(workspaceRoot, trimmed));
    }
  } catch { /* non-critical */ }

  const modifiedTracked = new Set<string>();
  try {
    const diffFiles = execSync("git diff --name-only HEAD", {
      cwd: workspaceRoot, encoding: "utf-8", timeout: 5000,
    }).trim();
    for (const f of diffFiles.split("\n")) {
      const trimmed = f.trim();
      if (trimmed) modifiedTracked.add(path.resolve(workspaceRoot, trimmed));
    }
  } catch { /* non-critical */ }

  const contaminated: string[] = [];
  for (const sg of plan.subGoals) {
    if (sg.id === currentSubGoalId || sg.status === "done") continue;
    for (const tf of sg.targetFiles) {
      const absPath = path.resolve(workspaceRoot, tf);
      if (untrackedFiles.has(absPath) && !allowed.has(absPath)) contaminated.push(tf);
    }
  }
  for (const cf of committedFiles) {
    const absPath = path.resolve(workspaceRoot, cf);
    if (modifiedTracked.has(absPath)) contaminated.push(cf);
  }
  return contaminated;
}

// ── Penalty system ─────────────────────────────────────────────

export async function executePenaltyStr(
  workspaceRoot: string, state: TargetState, plan: TargetPlan,
  level: "warning" | "rollback" | "purge",
): Promise<{ text: string }> {
  const planId = toPlanId(plan.project);
  switch (level) {
    case "warning":
      return { text: "## 违规警告\n\n检测到步骤违规。请在继续之前修复问题。" };
    case "rollback": {
      try {
        if (state.initialHead) {
          execSync(`git reset --hard ${state.initialHead}`, { cwd: workspaceRoot, timeout: 10_000 });
        }
        for (const sg of plan.subGoals) {
          sg.status = "pending"; sg.committedHash = undefined; sg.verificationDoc = undefined;
        }
        state.commits = [];
        state.currentSubGoalId = plan.subGoals[0]?.id;
        state.currentSubGoal = 0;
        state.phase = "execute";
        savePlan(workspaceRoot, plan);
        saveState(workspaceRoot, planId, state);
        return { text: `## 回滚执行\n\n所有 ${plan.subGoals.length} 个子目标的 commit 已回滚到初始 HEAD。\n从子目标 1 重新开始。` };
      } catch (e) {
        return { text: `## 回滚失败\n\n${String(e)}` };
      }
    }
    case "purge": {
      try {
        if (state.initialHead) {
          execSync(`git reset --hard ${state.initialHead}`, { cwd: workspaceRoot, timeout: 10_000 });
        }
        const planDir = path.join(getPlansDir(workspaceRoot), planId);
        if (fs.existsSync(planDir)) fs.rmSync(planDir, { recursive: true });
        state.phase = "abandoned";
        saveState(workspaceRoot, planId, state);
        return { text: `## 清除执行\n\n所有 commit 和计划文件已删除。仓库已恢复到初始状态。\n违规次数已达到上限，请重新开始。` };
      } catch (e) {
        return { text: `## 清除失败\n\n${String(e)}` };
      }
    }
  }
}

export function executePenalty(
  workspaceRoot: string, state: TargetState, plan: TargetPlan,
  level: "warning" | "rollback" | "purge",
): { text: string; autoContinue: boolean; terminal: boolean } {
  const result = { text: "", autoContinue: false, terminal: false };
  const planId = toPlanId(plan.project);
  switch (level) {
    case "warning":
      result.text = "## 违规警告\n\n检测到步骤违规。请在继续之前修复问题。";
      return result;
    case "rollback": {
      try {
        if (state.initialHead) {
          execSync(`git reset --hard ${state.initialHead}`, { cwd: workspaceRoot, timeout: 10_000 });
        }
        for (const sg of plan.subGoals) {
          sg.status = "pending"; sg.committedHash = undefined; sg.verificationDoc = undefined;
        }
        state.commits = [];
        state.currentSubGoalId = plan.subGoals[0]?.id;
        state.currentSubGoal = 0;
        state.phase = "execute";
        savePlan(workspaceRoot, plan);
        saveState(workspaceRoot, planId, state);
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
          execSync(`git reset --hard ${state.initialHead}`, { cwd: workspaceRoot, timeout: 10_000 });
        }
        const planDir = path.join(getPlansDir(workspaceRoot), planId);
        if (fs.existsSync(planDir)) fs.rmSync(planDir, { recursive: true });
        state.phase = "abandoned";
        saveState(workspaceRoot, planId, state);
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

function countChituCommits(workspaceRoot: string): number {
  try {
    const output = execSync('git log --oneline --grep="^chitu: " HEAD', {
      cwd: workspaceRoot, encoding: "utf-8", timeout: 5000,
    });
    return output.trim().split("\n").filter(Boolean).length;
  } catch { return 0; }
}

export function verifyCommitsAgainstVerification(
  workspaceRoot: string, plan: TargetPlan,
): { ok: boolean; detail: string } {
  const planId = toPlanId(plan.project);
  const issues: string[] = [];
  for (const sg of plan.subGoals) {
    if (sg.status !== "done") continue;
    if (!sg.committedHash) { issues.push(`sg-${sg.id}: no commit hash`); continue; }
    const verPath = path.join(getSubGoalDir(workspaceRoot, planId, sg.id), "verification.md");
    if (!fs.existsSync(verPath)) { issues.push(`sg-${sg.id}: verification.md missing`); continue; }
    try {
      const msg = execSync(`git log --format=%s -n 1 ${sg.committedHash}`, {
        cwd: workspaceRoot, encoding: "utf-8", timeout: 5000,
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
  const commitCount = countChituCommits(workspaceRoot);
  if (commitCount < doneCount) {
    issues.push(`Commit count mismatch: ${doneCount} done sub-goals but only ${commitCount} chitu commits found`);
  }
  return issues.length === 0
    ? { ok: true, detail: `${doneCount} sub-goals verified against ${commitCount} commits` }
    : { ok: false, detail: issues.join("; ") };
}

// ── File change detection ──────────────────────────────────────

export function detectNewFiles(workspaceRoot: string, targetFiles: string[]): string[] {
  const result: string[] = [];
  for (const tf of targetFiles) {
    const absPath = path.resolve(workspaceRoot, tf);
    if (!fs.existsSync(absPath)) continue;
    try {
      execSync(`git ls-files --error-unmatch ${tf} 2>/dev/null`, {
        cwd: workspaceRoot, timeout: 5000,
      });
    } catch { result.push(tf); }
  }
  return result;
}

export function detectModifiedFiles(workspaceRoot: string, targetFiles: string[]): string[] {
  const result: string[] = [];
  for (const tf of targetFiles) {
    const absPath = path.resolve(workspaceRoot, tf);
    if (!fs.existsSync(absPath)) continue;
    try {
      execSync(`git diff --quiet HEAD -- ${tf} 2>/dev/null`, {
        cwd: workspaceRoot, timeout: 5000,
      });
    } catch { result.push(tf); }
  }
  return result;
}

// ── Source counting ────────────────────────────────────────────

let _srcCountCache: { value: number; at: number } = { value: 0, at: 0 };

export function countSourceFiles(workspaceRoot: string): number {
  const now = Date.now();
  if (now - _srcCountCache.at < 30000) return _srcCountCache.value;
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
    walk(workspaceRoot, 0);
  } catch { /* ignore */ }
  _srcCountCache = { value: count, at: now };
  return count;
}

// ── Helpers ───────────────────────────────────────────────────

export function planSummary(plan: TargetPlan, extra: string): string {
  return [
    `Plan generated: **${plan.project}**`,
    `${plan.subGoals.length} sub-goals:`,
    ...plan.subGoals.map((sg) => `  ${sg.id}. ${sg.title}`),
    "",
    extra,
  ].join("\n");
}

// ── Recursive replanning ───────────────────────────────────────

export async function replanAgainstLockedInterfaces(
  agent: Agent, workspaceRoot: string,
  plan: TargetPlan, completedSgId: string,
  remainingSgs: SubGoal[], opts: TargetExecOptions,
): Promise<{ text: string; phase?: TargetPhase; nextSubGoalId?: string } | null> {
  const planId = toPlanId(plan.project);
  const doneSgs = plan.subGoals.filter((sg) => sg.status === "done");
  const lockedFiles = doneSgs.flatMap((sg) => sg.targetFiles);

  const interfaceBlocks: string[] = [];
  for (const sg of doneSgs) {
    const contractPath = path.join(
      getSubGoalDir(workspaceRoot, planId, sg.id), "contract.md",
    );
    try {
      if (fs.existsSync(contractPath)) interfaceBlocks.push(fs.readFileSync(contractPath, "utf-8"));
    } catch { /* skip */ }
  }

  const remainingDesc = remainingSgs
    .map((sg) => `  - ${sg.id}. ${sg.title}: ${sg.description} (targetFiles: ${sg.targetFiles.join(", ")})`)
    .join("\n");

  const prompt = [
    `## Replan: adapt remaining sub-goals to real locked interfaces`,
    ``,
    `### Project`, plan.goal, ``,
    `### Locked Interfaces (from completed sub-goals)`, ``,
    ...(interfaceBlocks.length > 0 ? interfaceBlocks : [`(no interface docs yet)`]),
    ``,
    `### Locked Files (read-only, cannot be modified)`,
    ...lockedFiles.map((f) => `  - ${f}`),
    ``,
    `### Remaining Work`, remainingDesc, ``,
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
    JSON.stringify({
      project: plan.project, goal: plan.goal,
      subGoals: remainingSgs.map((sg) => ({
        id: sg.id, title: sg.title, description: sg.description,
        targetFiles: sg.targetFiles, dependsOn: sg.dependsOn,
      })),
    }, null, 2),
    "```",
    ``,
    `Update targetFiles and dependsOn as needed. Keep ids stable where possible.`,
    `You can add, remove, split, or merge sub-goals — just output valid JSON.`,
  ].join("\n");

  agent.getMessages().push({ role: "user", content: prompt });
  const result = await agent.run(
    opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning,
  );

  const newPlan = parsePlanFromResponse(result, plan.goal);
  if (!newPlan || newPlan.subGoals.length === 0) {
    logger.warn("Replan: could not parse AI response, keeping original plan");
    return null;
  }

  const merged: SubGoal[] = [];
  for (const sg of plan.subGoals) {
    if (sg.status === "done" || sg.status === "failed") merged.push(sg);
  }

  let nextId = plan.subGoals.length + 1;
  for (const nsg of newPlan.subGoals) {
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
      ...nsg, id: String(nextId++),
      status: "pending" as const, retryCount: 0, maxRetries: 3,
    });
  }

  const pendingCount = merged.filter((sg) => sg.status === "pending").length;
  if (pendingCount === 0) {
    return { text: "All remaining work integrated into completed modules. Proceeding to review.", phase: "review" };
  }

  plan.subGoals.length = 0;
  plan.subGoals.push(...merged);
  generateInterfaceStubs(workspaceRoot, plan);

  const firstPending = merged.find((sg) => sg.status === "pending");
  return {
    text: [
      `## Replan Complete`, ``,
      `Regenerated ${newPlan.subGoals.length} sub-goals against ${doneSgs.length} locked interfaces.`,
      ``,
      `### Updated Plan`,
      ...merged.map((sg) => `  ${sg.id}. [${sg.status}] ${sg.title} → ${sg.targetFiles.join(", ")}`),
      ``,
      firstPending ? `Next: sub-goal ${firstPending.id} — ${firstPending.title}.` : `All sub-goals accounted for.`,
    ].join("\n"),
    nextSubGoalId: firstPending?.id,
  };
}

// ── Phase 2: Execute sub-goal (grow → trim → verify) ────────────

export async function doExecute(
  agent: Agent, workspaceRoot: string,
  state: TargetState, opts: TargetExecOptions,
): Promise<string> {
  const plan = state.plan;
  if (!plan) return "(Target: no plan loaded)";

  if (!state.planConfirmed) {
    state.phase = "plan";
    saveState(workspaceRoot, toPlanId(plan.project), state);
    return "(Target: plan not yet confirmed, returning to plan phase)";
  }

  const ordered = sortByDeps(plan.subGoals);

  let entry = state.currentSubGoalId
    ? findSubGoal(ordered, state.currentSubGoalId)
    : null;
  if (!entry && typeof state.currentSubGoal === "number" && state.currentSubGoal < ordered.length) {
    entry = { sg: ordered[state.currentSubGoal]!, idx: state.currentSubGoal };
  }
  if (!entry) {
    state.phase = "done";
    saveState(workspaceRoot, toPlanId(plan.project), state);
    return [
      `## Target Error: Stale state`,
      `Sub-goal id '${state.currentSubGoalId ?? "none"}' or index ${state.currentSubGoal} not found in plan with ${ordered.length} sub-goals.`,
      `The plan may have changed between executions. Run /target ${plan.project} to restart.`,
    ].join("\n");
  }

  const { sg: subGoal, idx } = entry;

  // ── GROW phase ──────────────────────────────────────────────
  const planId = toPlanId(plan.project);
  const stubPath = path.join(
    getSubGoalDir(workspaceRoot, planId, subGoal.id), "contract.md",
  );
  if (!fs.existsSync(stubPath)) {
    generateInterfaceStubs(workspaceRoot, plan);
  }
  const stubContent = fs.existsSync(stubPath)
    ? fs.readFileSync(stubPath, "utf-8") : "";

  lockSubGoalBoundary(agent, plan.project, subGoal, state.previousSubGoalFiles);

  const completedDocs = loadAllInterfaceDocs(workspaceRoot, toPlanId(plan.project));
  const interfaceCtx = buildInterfaceContext(completedDocs);

  const prompt = [
    `## ${subGoal.title}`,
    ``,
    `Description: ${subGoal.description}`,
    `Target files: ${subGoal.targetFiles.join(", ")}`,
    ``,
    `### Interface Contract`, ``,
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

  if (subGoal.status === "failed") {
    const nextEntry = ordered[idx + 1];
    if (nextEntry) {
      state.currentSubGoalId = nextEntry.id;
      state.currentSubGoal = idx + 1;
    } else {
      state.phase = "review";
    }
    saveState(workspaceRoot, toPlanId(plan.project), state);
    return `Sub-goal ${subGoal.id} previously failed, skipping to ${nextEntry ? `sub-goal ${nextEntry.id}` : "review"}.`;
  }

  if (subGoal.status !== "in_progress") {
    agent.getMessages().push({ role: "user", content: prompt });
    subGoal.status = "in_progress";
    updateSubGoalStatus(plan, subGoal.id, "in_progress");
    saveState(workspaceRoot, toPlanId(plan.project), state);
    auditSubGoalStart(workspaceRoot, plan.project, subGoal.id);
  }

  let result = "";
  let retries = 0;

  while (retries <= MAX_RETRIES) {
    result = await agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);

    const doneJson = readCompletionFile(workspaceRoot)
      ?? extractCompletionJsonFromMessages(agent)
      ?? extractCompletionJson(result);

    if (doneJson) {
      const contamination = detectCrossContamination(
        workspaceRoot, plan, subGoal.id, state.previousSubGoalFiles,
      );
      if (contamination.length > 0) {
        if (retries < MAX_RETRIES) {
          const warnPrompt = [
            `你修改了不允许改的文件:`,
            ...contamination.map((f) => `  - ${f}`),
            ``,
            `请立即用 git checkout 还原这些文件，只修改当前子目标允许的文件。`,
          ].join("\n");
          agent.getMessages().push({ role: "user", content: warnPrompt });
          retries++;
          subGoal.retryCount = retries;
          continue;
        }
        subGoal.status = "failed";
        updateSubGoalStatus(plan, subGoal.id, "failed");
        saveState(workspaceRoot, toPlanId(plan.project), state);
        return `Sub-goal ${subGoal.id} failed: cross-contamination after ${MAX_RETRIES} retries.\nContaminated files: ${contamination.join(", ")}`;
      }

      const exports = normalizeExports(doneJson.exports ?? []);
      const imports = normalizeImports(doneJson.imports ?? []);
      const capability = doneJson.capability ?? "";

      const exportCount = Array.isArray(exports) ? exports.length : Object.keys(exports).length;
      const importCount = Array.isArray(imports) ? imports.length : Object.keys(imports).length;
      if (exportCount === 0 && importCount === 0) {
        const anyFileExists = subGoal.targetFiles.some((tf) => {
          try {
            const fp = path.resolve(workspaceRoot, tf);
            return fs.existsSync(fp) && fs.statSync(fp).size > 0;
          } catch { return false; }
        });
        if (!anyFileExists) {
          if (retries < MAX_RETRIES) {
            const fixPrompt = `没有创建任何目标文件。请创建代码文件，完成后调用 complete_sub_goal 工具。`;
            agent.getMessages().push({ role: "user", content: fixPrompt });
            retries++; subGoal.retryCount = retries; continue;
          }
          subGoal.status = "failed";
          updateSubGoalStatus(plan, subGoal.id, "failed");
          saveState(workspaceRoot, toPlanId(plan.project), state);
          return `Sub-goal ${subGoal.id} failed: no code produced after ${MAX_RETRIES} retries.`;
        }
      }

      const exportIssues = verifyExports(workspaceRoot, subGoal.targetFiles, exports);
      if (exportIssues.length > 0) {
        const filesExist = subGoal.targetFiles.every((tf) => {
          try { return fs.existsSync(path.resolve(workspaceRoot, tf)) && fs.statSync(path.resolve(workspaceRoot, tf)).size > 0; }
          catch { return false; }
        });
        if (!filesExist && retries < MAX_RETRIES) {
          const fixPrompt = [
            `以下导出在代码中找不到：`,
            ...exportIssues.map((e) => `  - ${e}`),
            `请修复后调用 complete_sub_goal 工具。`,
          ].join("\n");
          agent.getMessages().push({ role: "user", content: fixPrompt });
          retries++; subGoal.retryCount = retries; continue;
        }
      }

      subGoal.status = "done";

      const docPath = writeInterfaceDoc(
        workspaceRoot, toPlanId(plan.project), subGoal, exports, imports, capability,
      );
      if (!docPath) {
        if (retries < MAX_RETRIES) {
          const fixPrompt = [
            `接口文档验证失败。请确认所有声明的导出在目标文件中存在。`,
            `修复后调用 complete_sub_goal 工具。`,
          ].join("\n");
          agent.getMessages().push({ role: "user", content: fixPrompt });
          retries++; subGoal.retryCount = retries; continue;
        }
        subGoal.status = "failed";
        updateSubGoalStatus(plan, subGoal.id, "failed");
        saveState(workspaceRoot, toPlanId(plan.project), state);
        return `Sub-goal ${subGoal.id} failed: interface doc validation failed after ${MAX_RETRIES} retries.`;
      }

      const testResult = runProjectTests(workspaceRoot);
      if (!testResult.ok) {
        if (retries < MAX_RETRIES) {
          const fixPrompt = [
            `测试失败：`, ``, testResult.output.slice(0, 3000), ``,
            `请修复测试失败，然后调用 complete_sub_goal 工具。`,
          ].join("\n");
          agent.getMessages().push({ role: "user", content: fixPrompt });
          retries++; subGoal.retryCount = retries; continue;
        }
        subGoal.status = "failed";
        updateSubGoalStatus(plan, subGoal.id, "failed");
        saveState(workspaceRoot, toPlanId(plan.project), state);
        return `Sub-goal ${subGoal.id} failed: tests did not pass after ${MAX_RETRIES} retries.\n\n${testResult.summary}`;
      }

      subGoal.interfaceDoc = docPath;
      updateSubGoalStatus(plan, subGoal.id, "done");

      for (const tf of subGoal.targetFiles) {
        if (!state.previousSubGoalFiles.includes(tf)) state.previousSubGoalFiles.push(tf);
      }

      const commitHash = autoCommit(workspaceRoot, plan.project, subGoal);
      if (!commitHash) {
        return `## Commit Failed\n\nSub-goal ${subGoal.id} completed but git commit failed.\nCheck git status and resolve any issues, then type anything to retry.`;
      }
      subGoal.committedHash = commitHash;
      state.commits.push(commitHash);

      const verification: SubGoalVerification = {
        subGoalId: subGoal.id, subGoalTitle: subGoal.title,
        committedHash: commitHash, committedAt: new Date().toISOString(),
        testCommand: "npm test",
        testOutput: testResult.output.slice(0, 3000),
        testPassed: testResult.ok, integrationTestPassed: true,
        exportsVerified: flattenExports(exports),
        filesCreated: detectNewFiles(workspaceRoot, subGoal.targetFiles),
        filesModified: detectModifiedFiles(workspaceRoot, subGoal.targetFiles),
      };
      const verificationPath = writeVerificationDoc(
        workspaceRoot, toPlanId(plan.project), subGoal, verification,
      );
      subGoal.verificationDoc = verificationPath;

      discardSubGoalContext(agent, workspaceRoot, plan);

      const remainingSgs = ordered.filter((sg) => sg.status !== "done" && sg.status !== "failed");
      if (remainingSgs.length > 0) {
        const replanResult = await replanAgainstLockedInterfaces(
          agent, workspaceRoot, plan, subGoal.id, remainingSgs, opts,
        );
        if (replanResult) {
          if (replanResult.phase) state.phase = replanResult.phase;
          if (replanResult.nextSubGoalId) {
            state.currentSubGoalId = replanResult.nextSubGoalId;
            state.currentSubGoal = plan.subGoals.findIndex((sg) => sg.id === replanResult.nextSubGoalId);
          }
          saveState(workspaceRoot, toPlanId(plan.project), state);
          return replanResult.text;
        }
      }

      const nextEntry = ordered[idx + 1];
      if (nextEntry) {
        state.currentSubGoalId = nextEntry.id;
        state.currentSubGoal = idx + 1;
      } else {
        state.phase = "review";
      }
      saveState(workspaceRoot, toPlanId(plan.project), state);

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

    // AI didn't signal completion
    if (retries < MAX_RETRIES) {
      retries++;
      subGoal.retryCount = retries;
      const retryMsg = retries === 1
        ? "请调用 complete_sub_goal 工具标记完成。不要输出 JSON 文本，直接调工具。"
        : `第${retries}次重试：请调用 complete_sub_goal 工具，exports 中列出每个文件导出的符号名。`;
      agent.getMessages().push({ role: "user", content: retryMsg });
      continue;
    }
    subGoal.status = "failed";
    updateSubGoalStatus(plan, subGoal.id, "failed");
    const nextEntry = ordered[idx + 1];
    if (nextEntry) {
      state.currentSubGoalId = nextEntry.id;
      state.currentSubGoal = idx + 1;
    } else {
      state.phase = "review";
    }
    saveState(workspaceRoot, toPlanId(plan.project), state);
    return `Sub-goal ${subGoal.id} failed: AI did not signal completion after ${MAX_RETRIES} retries.`;
  }

  return result;
}

// ── Phase 3: Final review (hard gates) ──────────────────────────

export async function doReview(
  agent: Agent, workspaceRoot: string,
  state: TargetState, opts: TargetExecOptions,
): Promise<string> {
  const plan = state.plan;
  if (!plan) return "(Target: no plan)";
  const docs = loadAllInterfaceDocs(workspaceRoot, toPlanId(plan.project));

  const gateResults: string[] = [];
  let gate1ok = true, gate2ok = true, gate3ok = true, gate4ok = true;

  // Gate 1: Run project tests
  const testResult = runProjectTests(workspaceRoot);
  gateResults.push(testResult.summary);
  if (!testResult.ok) {
    gate1ok = false;
    for (let ra = 0; ra < MAX_RETRIES && !gate1ok; ra++) {
      const testFixPrompt = [
        `项目测试失败：`, ``, testResult.output.slice(0, 3000), ``,
        `请修复测试失败。`,
      ].join("\n");
      agent.getMessages().push({ role: "user", content: testFixPrompt });
      await agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);
      const retest = runProjectTests(workspaceRoot);
      gate1ok = retest.ok;
      gateResults.push(`Gate 1 retry ${ra + 1}: ${retest.summary}`);
    }
  }

  // Gate 2: Verify all interface docs
  const docIssues = verifyAllInterfaceDocs(workspaceRoot, docs);
  if (docIssues.length > 0) {
    gate2ok = false;
    for (let ra = 0; ra < MAX_RETRIES && !gate2ok; ra++) {
      const docFixPrompt = [
        `以下接口文档中的导出在代码中找不到：`,
        ...docIssues.map((i) => `  - ${i}`),
        ``, `请修复代码或更新接口文档。`,
      ].join("\n");
      agent.getMessages().push({ role: "user", content: docFixPrompt });
      await agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);
      const recheck = verifyAllInterfaceDocs(workspaceRoot, loadAllInterfaceDocs(workspaceRoot, toPlanId(plan.project)));
      gate2ok = recheck.length === 0;
      gateResults.push(`Gate 2 retry ${ra + 1}: ${gate2ok ? "PASSED" : `still ${recheck.length} issue(s)`}`);
    }
  } else {
    gateResults.push(`Gate 2 PASSED — ${docs.length} interface doc(s) verified`);
  }

  // Gate 3: Cumulative integration test
  const integrationResult = await runFinalIntegrationTest(agent, workspaceRoot, plan, docs, opts);
  if (integrationResult) {
    gate3ok = false;
    for (let ra = 0; ra < MAX_RETRIES && !gate3ok; ra++) {
      gateResults.push(`Gate 3 attempt ${ra + 1}: FAILED — integration test`);
      const integrationFixPrompt = [
        `跨模块集成测试失败，3-4 个假想模块无法干净集成：`,
        ``, integrationResult, ``,
        `请修复接口使跨模块集成不需要修改现有源码。`,
      ].join("\n");
      agent.getMessages().push({ role: "user", content: integrationFixPrompt });
      await agent.run(opts.onToken, opts.signal, opts.onToolOutput, opts.onCompress, opts.onReasoning);
      const retestIntegration = await runFinalIntegrationTest(
        agent, workspaceRoot, plan, loadAllInterfaceDocs(workspaceRoot, toPlanId(plan.project)), opts,
      );
      gate3ok = retestIntegration === null;
      gateResults.push(`Gate 3 retry ${ra + 1}: ${gate3ok ? "PASSED" : "FAILED"}`);
    }
  } else {
    gateResults.push(`Gate 3 PASSED — cross-module integration verified`);
  }

  // Gate 4: Cross-reference commits
  const crossRefResult = verifyCommitsAgainstVerification(workspaceRoot, plan);
  gateResults.push(`Gate 4: ${crossRefResult.ok ? "PASSED" : "FAILED"} — ${crossRefResult.detail}`);
  gate4ok = crossRefResult.ok;
  if (!gate4ok) {
    const violation: ViolationRecord = {
      subGoalId: "review",
      reason: `Gate 5 failed: ${crossRefResult.detail}`,
      detectedAt: new Date().toISOString(),
      action: state.violations.length === 0 ? "warning" : "rollback",
    };
    state.violations.push(violation);
    saveState(workspaceRoot, toPlanId(plan.project), state);

    if (state.violations.length >= 2) {
      return (await executePenaltyStr(workspaceRoot, state, plan, "purge")).text;
    }
    return (await executePenaltyStr(workspaceRoot, state, plan, "rollback")).text;
  }

  const allPassed = gate1ok && gate2ok && gate3ok && gate4ok;
  if (allPassed) {
    state.phase = "done";
    const pid = toPlanId(plan.project);
    saveState(workspaceRoot, pid, state);

    const guard = agent.getGuard();
    if (guard) guard.unlock();

    return [
      `## Target Complete: ${plan.project}`, ``,
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
      `## Review Incomplete — some gates did not pass`, ``,
      ...gateResults.map((g) => `- ${g}`),
      ``,
      `Addressing remaining issues and re-running review.`,
    ].join("\n");
  }
}
