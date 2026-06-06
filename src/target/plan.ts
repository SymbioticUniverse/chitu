import * as fs from "node:fs";
import * as path from "node:path";
import type { TargetPlan, SubGoal } from "../types.js";

// ── Goal completeness ──────────────────────────────────────────────

export interface GoalCheck {
  complete: boolean;
  missing: string[];
}

/** Check if a user's goal description is specific enough to generate a plan. */
export function checkGoalCompleteness(goal: string): GoalCheck {
  const missing: string[] = [];

  if (goal.length < 20) missing.push("目标描述过短，请详细描述要实现的功能");
  if (!/\b(?:实现|新增|修改|重构|修复|添加|创建|build|create|add|implement|fix|refactor)\b/i.test(goal))
    missing.push("请明确说明要做什么（实现/新增/修改/重构/修复）");
  if (!/\b(?:文件|模块|接口|路由|组件|页面|API|数据库|file|module|api|component|route)\b/i.test(goal))
    missing.push("请说明涉及哪些模块或文件类型");
  if (goal.split(/[。.!！?？\n]/).length < 2 && goal.length < 80)
    missing.push("目标可能需要更具体的步骤分解，请补充细节");
  if (goal.length > 2000)
    missing.push("目标描述过长，请精简到核心需求（当前 " + goal.length + " 字）");

  return { complete: missing.length === 0, missing };
}

// ── Plan generation prompt ─────────────────────────────────────────

const MAX_CLARIFICATION_ROUNDS = 12;

export function buildClarificationPrompt(goal: string, round: number): string {
  const planFormat = [
    "",
    "如果信息已足够，直接在你的回复中输出执行计划（不要写文件！），严格按照以下 JSON 格式：",
    "```json",
    JSON.stringify({
      project: "<英文项目名，kebab-case>",
      goal: "<精简后的目标描述>",
      subGoals: [
        {
          id: "1",
          title: "<子目标标题>",
          description: "<一句话描述>",
          targetFiles: ["<预计涉及的文件路径>"],
          dependsOn: [],
        },
      ],
    }, null, 2),
    "```",
    "要求：3-8 个子目标，每个 1-3 个文件。每个子目标必须列出 targetFiles，不能为空。dependsOn 只填真正有顺序依赖的，不要每个都依赖全部前面的。",
    "注意：你只能读代码、在回复中输出文本。不要使用 write_file 或任何写文件工具。编排层会自动解析你的 JSON 回复。",
  ].join("\n");

  if (round >= MAX_CLARIFICATION_ROUNDS) {
    return [
      `用户目标：${goal}`,
      "",
      `请基于已有信息直接生成执行计划。`,
      CONSTRAINT_DESCRIPTION,
      planFormat,
    ].join("\n");
  }

  return [
    `用户目标：${goal}`,
    "",
    `请逐项检查目标是否完整：`,
    `1. 要做什么？（实现/修改/重构）`,
    `2. 涉及哪些模块/文件？`,
    `3. 预期效果是什么？`,
    `4. 有无技术约束？`,
    "",
    `如果目标不够具体，请提出 1-3 个精准的澄清问题。`,
    `回答尽量简洁，直接输出 JSON 即可，不要长篇解释。`,
    CONSTRAINT_DESCRIPTION,
    planFormat,
  ].join("\n");
}

const CONSTRAINT_DESCRIPTION = [
  "",
  "执行约束（重要）：",
  "- 每个子目标完成后，其文件会被 git commit 并锁定为只读",
  "- 后续子目标不能修改已锁定的文件，只能新建文件或通过已导出的接口扩展",
  "- 在 Plan 阶段就考虑好：后续子目标如何在不修改前面文件的前提下接入？",
].join("\n");

export function buildPlanGenerationPrompt(goal: string): string {
  return [
    `请为以下目标生成结构化执行计划。直接输出 JSON，不要解释。`,
    ``,
    `  ${goal}`,
    ``,
    CONSTRAINT_DESCRIPTION,
    ``,
    `严格按照以下 JSON 格式输出（放在 \`\`\`json 代码块中）：`,
    "",
    "```json",
    JSON.stringify({
      project: "<项目英文名，如 add-jwt-auth>",
      goal: "<精简后的目标描述>",
      subGoals: [
        {
          id: "1",
          title: "<子目标标题>",
          description: "<具体要做的事，一句话>",
          targetFiles: ["<预计涉及的文件路径>"],
          dependsOn: [],
        },
      ],
    }, null, 2),
    "```",
    "",
    "要求：",
    "- project: 英文项目名，kebab-case",
    "- subGoals: 按执行顺序排列，自上而下，3-8 个",
    "- targetFiles: 每个子目标必须列出至少 1 个文件（不能为空）",
    "- dependsOn: 只填真正有顺序依赖的。不要每个子目标都依赖前面所有子目标，那说明你没想清楚解耦",
    "- 每个子目标粒度控制在 1-3 个文件",
    "- 你只能读代码、在回复中输出文本。不要使用 write_file。编排层会自动保存计划。",
  ].join("\n");
}

// ── Plan parsing ───────────────────────────────────────────────────

export function parsePlanFromResponse(text: string, goal: string): TargetPlan | null {
  try {
    let jsonStr: string | null = null;

    // Pattern 1: ```json ... ``` or ``` ... ```
    const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlock?.[1]) {
      jsonStr = codeBlock[1].trim();
    }

    // Pattern 2: Any JSON object with "project" and "subGoals" keys (bare, no fence)
    if (!jsonStr) {
      const m = text.match(/\{[\s\S]*?"project"[\s\S]*?"subGoals"[\s\S]*?\}/);
      if (m) {
        const idx = text.indexOf(m[0]);
        if (idx >= 0) {
          const slice = text.slice(idx);
          let depth = 0, end = -1;
          for (let i = 0; i < slice.length; i++) {
            if (slice[i] === "{") depth++;
            else if (slice[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
          }
          if (end > 0) jsonStr = slice.slice(0, end);
        }
      }
    }

    if (!jsonStr) return null;

    const parsed = JSON.parse(jsonStr);

    if (!parsed.project || !Array.isArray(parsed.subGoals)) return null;
    if (parsed.subGoals.length === 0) return null;
    if (parsed.subGoals.length > 8) return null;

    const subGoals: SubGoal[] = [];
    for (let idx = 0; idx < parsed.subGoals.length; idx++) {
      const sg = parsed.subGoals[idx];
      const targetFiles: string[] = Array.isArray(sg.targetFiles) ? sg.targetFiles : [];
      // Reject sub-goals with no target files (can't lock boundary, can't verify)
      if (targetFiles.length === 0) return null;
      const dependsOn: string[] = Array.isArray(sg.dependsOn) ? sg.dependsOn.map(String) : [];
      subGoals.push({
        id: String(sg.id ?? idx + 1),
        title: String(sg.title ?? `Sub-goal ${idx + 1}`),
        description: String(sg.description ?? ""),
        targetFiles,
        dependsOn,
        status: "pending" as const,
        retryCount: 0,
        maxRetries: 3,
      });
    }

    return {
      project: parsed.project,
      goal: goal.slice(0, 500),
      createdAt: new Date().toISOString(),
      subGoals,
    };
  } catch {
    return null;
  }
}

// ── Persistence ────────────────────────────────────────────────────

export function getPlansDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".chitu", "plans");
}

/** Absolute path to a plan's folder. */
export function getPlanDir(workspaceRoot: string, planId: string): string {
  return path.join(getPlansDir(workspaceRoot), planId);
}

/** Absolute path to a sub-goal's folder. */
export function getSubGoalDir(workspaceRoot: string, planId: string, subGoalId: string): string {
  return path.join(getPlanDir(workspaceRoot, planId), "sub-goals", subGoalId);
}

/** Absolute path to the plan JSON file (folder format). */
export function planJsonPath(workspaceRoot: string, planId: string): string {
  return path.join(getPlanDir(workspaceRoot, planId), "plan.json");
}

/** Absolute path to the plan Markdown file (folder format). */
export function planMdPath(workspaceRoot: string, planId: string): string {
  return path.join(getPlanDir(workspaceRoot, planId), "plan.md");
}

export function savePlan(workspaceRoot: string, plan: TargetPlan): void {
  const planId = `plan-${plan.project}`;
  const planDir = getPlanDir(workspaceRoot, planId);
  if (!fs.existsSync(planDir)) fs.mkdirSync(planDir, { recursive: true });
  // Merge with existing state to avoid clobbering phase/currentSubGoalId etc.
  const existing = loadPlanFile(workspaceRoot, planId) ?? {};
  const merged = { ...existing, ...plan };
  fs.writeFileSync(planJsonPath(workspaceRoot, planId), JSON.stringify(merged, null, 2), "utf-8");
  fs.writeFileSync(planMdPath(workspaceRoot, planId), generatePlanMd(merged as unknown as TargetPlan), "utf-8");
}

/** Generate a human-readable plan.md from the structured plan. */
function generatePlanMd(plan: TargetPlan): string {
  const lines = [
    `# Target Plan: ${plan.project}`,
    ``,
    `**Goal:** ${plan.goal}`,
    ``,
    `**Created:** ${plan.createdAt}`,
    ``,
    `## Sub-goals (${plan.subGoals.length})`,
    ``,
  ];

  for (const sg of plan.subGoals) {
    const statusIcon = sg.status === "done" ? "✅" : sg.status === "in_progress" ? "🔄" : sg.status === "failed" ? "❌" : "⬜";
    lines.push(`### ${statusIcon} ${sg.id}. ${sg.title}`);
    lines.push(``);
    lines.push(`- **Description:** ${sg.description}`);
    lines.push(`- **Target files:** ${sg.targetFiles.join(", ") || "(none)"}`);
    if (sg.dependsOn.length > 0) {
      lines.push(`- **Depends on:** ${sg.dependsOn.join(", ")}`);
    }
    if (sg.interfaceDoc) {
      lines.push(`- **Interface doc:** ${sg.interfaceDoc}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

export function loadPlan(workspaceRoot: string, planId: string): TargetPlan | null {
  const file = planJsonPath(workspaceRoot, planId);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, "utf-8")) as TargetPlan; }
    catch { /* fall through to migration */ }
  }
  // Try old flat format and migrate
  const oldFile = path.join(getPlansDir(workspaceRoot), `${planId}.json`);
  if (fs.existsSync(oldFile)) {
    migratePlanToFolderFormat(workspaceRoot, planId);
    try { return JSON.parse(fs.readFileSync(file, "utf-8")) as TargetPlan; }
    catch { return null; }
  }
  return null;
}

/** Load plan file including merged state fields. Returns null if not found. */
export function loadPlanFile(workspaceRoot: string, planId: string): Record<string, unknown> | null {
  const file = planJsonPath(workspaceRoot, planId);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>; }
    catch { /* fall through */ }
  }
  // Try old flat format and migrate
  const oldFile = path.join(getPlansDir(workspaceRoot), `${planId}.json`);
  if (fs.existsSync(oldFile)) {
    migratePlanToFolderFormat(workspaceRoot, planId);
    try { return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>; }
    catch { return null; }
  }
  return null;
}

/** Save the full plan file (plan + state merged). */
export function savePlanFile(workspaceRoot: string, planId: string, data: Record<string, unknown>): void {
  const planDir = getPlanDir(workspaceRoot, planId);
  if (!fs.existsSync(planDir)) fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(planJsonPath(workspaceRoot, planId), JSON.stringify(data, null, 2), "utf-8");
}

export function updateSubGoalStatus(
  plan: TargetPlan,
  subGoalId: string,
  status: SubGoal["status"],
): void {
  const sg = plan.subGoals.find((s) => s.id === subGoalId);
  if (sg) {
    sg.status = status;
  }
  // Persistence is the caller's responsibility — call saveState() after this.
  // This avoids the read-modify-write race between savePlan and saveState.
}

/** Generate plan ID from project name. */
export function planId(projectName: string): string {
  return `plan-${projectName}`;
}

/** Scan the plans directory and return basic info about each plan. */
export function listPlanFiles(workspaceRoot: string): { id: string; goal: string; phase: string; createdAt: string; subGoalCount: number; completedSubGoals: number }[] {
  const dir = getPlansDir(workspaceRoot);
  if (!fs.existsSync(dir)) return [];
  const results: { id: string; goal: string; phase: string; createdAt: string; subGoalCount: number; completedSubGoals: number }[] = [];
  const seen = new Set<string>();
  for (const entry of fs.readdirSync(dir)) {
    // New folder format
    const folderPath = path.join(dir, entry);
    if (fs.statSync(folderPath).isDirectory() && entry.startsWith("plan-")) {
      const planFile = path.join(folderPath, "plan.json");
      if (fs.existsSync(planFile)) {
        try {
          const raw = JSON.parse(fs.readFileSync(planFile, "utf-8")) as Record<string, unknown>;
          const subGoals = Array.isArray(raw.subGoals) ? raw.subGoals as Record<string, unknown>[] : [];
          const done = subGoals.filter((sg) => sg.status === "done").length;
          results.push({
            id: entry,
            goal: (raw.goal as string) ?? "",
            phase: (raw.phase as string) ?? "unknown",
            createdAt: (raw.createdAt as string) ?? "",
            subGoalCount: subGoals.length,
            completedSubGoals: done,
          });
          seen.add(entry);
        } catch { /* skip corrupt */ }
      }
    }
    // Old flat format
    if (entry.endsWith(".json")) {
      const planId = entry.replace(/\.json$/, "");
      if (seen.has(planId)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf-8")) as Record<string, unknown>;
        const subGoals = Array.isArray(raw.subGoals) ? raw.subGoals as Record<string, unknown>[] : [];
        const done = subGoals.filter((sg) => sg.status === "done").length;
        results.push({
          id: planId,
          goal: (raw.goal as string) ?? "",
          phase: (raw.phase as string) ?? "unknown",
          createdAt: (raw.createdAt as string) ?? "",
          subGoalCount: subGoals.length,
          completedSubGoals: done,
        });
      } catch { /* skip corrupt */ }
    }
  }
  results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return results;
}

// ── Migration ─────────────────────────────────────────────────────────

/** Migrate old flat plan files to folder format. Returns true on success. */
export function migratePlanToFolderFormat(workspaceRoot: string, planId: string): boolean {
  const oldJsonPath = path.join(getPlansDir(workspaceRoot), `${planId}.json`);
  const oldMdPath = path.join(getPlansDir(workspaceRoot), `${planId}.md`);
  const planDir = getPlanDir(workspaceRoot, planId);

  // Already migrated
  if (fs.existsSync(path.join(planDir, "plan.json"))) return true;
  // No old file to migrate
  if (!fs.existsSync(oldJsonPath)) return false;

  if (!fs.existsSync(planDir)) fs.mkdirSync(planDir, { recursive: true });

  // Move plan.json
  try {
    const planData = JSON.parse(fs.readFileSync(oldJsonPath, "utf-8"));
    fs.writeFileSync(path.join(planDir, "plan.json"), JSON.stringify(planData, null, 2), "utf-8");
  } catch { return false; }

  // Move plan.md
  if (fs.existsSync(oldMdPath)) {
    try {
      const mdContent = fs.readFileSync(oldMdPath, "utf-8");
      fs.writeFileSync(path.join(planDir, "plan.md"), mdContent, "utf-8");
    } catch { /* non-critical */ }
  }

  // Migrate interface docs into sub-goal folders
  const interfacesDir = path.join(workspaceRoot, ".chitu", "interfaces", `interface-${planId}`);
  if (fs.existsSync(interfacesDir)) {
    for (const entry of fs.readdirSync(interfacesDir)) {
      if (!entry.endsWith(".md")) continue;
      const sgId = entry.replace("sub-goal-", "").replace(".md", "");
      const sgDir = path.join(planDir, "sub-goals", sgId);
      if (!fs.existsSync(sgDir)) fs.mkdirSync(sgDir, { recursive: true });
      try {
        fs.renameSync(path.join(interfacesDir, entry), path.join(sgDir, "contract.md"));
      } catch { /* skip */ }
    }
    try { fs.rmdirSync(interfacesDir); } catch { /* not empty, leave it */ }
  }

  // Remove old flat files
  try { fs.unlinkSync(oldJsonPath); } catch { /* gone */ }
  try { fs.unlinkSync(oldMdPath); } catch { /* gone */ }

  return true;
}
