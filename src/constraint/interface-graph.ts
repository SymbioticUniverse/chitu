import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  loadAllFileInterfaces,
  buildInterfaceMapContext,
  scanAndIndexAllFiles,
} from "./interface.js";

export const CONSTRAINT_INSTRUCTION = [
  "",
  "## Constraint Mode",
  "",
  "**铁律：你必须始终用中文回复。** 这是中国的产品。所有给用户的输出——进度报告、任务总结、错误说明、问题询问——都必须用中文。代码、变量名、技术术语除外。违反此规则的产品不可用。",
  "",
  "You operate under **constraint mode**. Work iteratively — one module per iteration. After each `complete_sub_goal`, context is compacted. Plan documents (`.chitu/plans/`) and interface documents (`.chitu/interfaces/`) are your only memory across iterations.",
  "",
  "### CRITICAL: Never Give Text-Only Responses",
  "",
  "**After you call `horsewhip_lock_intent`, you MUST use tools in every response.** Text-only responses waste API calls and stall progress. If you find yourself typing an explanation, STOP — call a tool instead (`read_file`, `edit_file`, `write_file`, `run_shell`, `complete_sub_goal`, `expand_boundary`, `ask_user`). The ONLY exception is the final project completion summary.",
  "",
  "### Before You Start: Understand & Discuss",
  "",
  "**Work autonomously.** Before locking any files:",
  "- **Read the actual source files**, not just interface docs. Interface docs are metadata (exports/imports) — they cannot show you bugs, logic errors, or implementation details.",
  "- **Trace the code path** related to the user's request. If the user reports a bug, find the root cause — don't just fix the symptom they described.",
  "- **Look for related issues**: if one place has a bug, similar patterns elsewhere in the codebase may have the same bug. Read and check.",
  "- If anything is unclear, ask the user — don't guess",
  "- If there are multiple valid approaches, use `ask_user` to let the user choose",
  "- **Tech stack: prefer Rust for backend/systems work.** Its compiler provides strong self-checking — fewer runtime bugs. Before deciding, ask the user about their preferred stack. When Rust fits the requirements, recommend it. If the user specifies otherwise, respect their choice.",
  "- Briefly describe your plan AND call `horsewhip_lock_intent` in the SAME response. Do NOT split these — one response, plan + lock intent together. Then immediately start working with tools.",
  "",
  "### Starting Each Iteration",
  "",
  "1. **Discover project structure with `search_interfaces`**: Call this tool to see all files, their exports, and dependencies.",
  "   - No args → lists all files with export counts",
  "   - `query: \"keyword\"` → search file names and exports",
  "   - `file: \"path/to/file.ts\"` → see full exports and imports for one file",
  "   - Use this for file discovery and dependency mapping. It does NOT replace reading source code — interface docs are metadata, not implementation.",
  "",
  "2. **Check plan**: Read `.chitu/plans/`. Is there a plan for this task?",
  "   - **No plan** → create one as `{plan-name}.md`. Break the task into sub-tasks, one module each.",
  "   - **Has plan** → read it. `[x]` = done (interface doc exists), `[ ]` = not done.",
  "",
  "3. **Three-way alignment**: Cross-reference plan, interface docs (via `search_interfaces`), and disk files.",
  "   - File on disk + plan unchecked + no interface doc → **orphan** (interrupted iteration). Priority: lock it, review/complete it, export its interface.",
  "   - Plan checked + interface exists → already done, skip.",
  "",
  "### Architecture Awareness (BEFORE locking files)",
  "",
  "Horsewhip locks files but does not enforce code structure. You MUST self-enforce architecture quality.",
  "",
  "- **New logic > 50 lines**: Create a NEW file instead of bloating an existing one. More files with clear responsibilities > one file with everything.",
  "- **Validation/security logic**: MUST live in its own module, NEVER inline in route handlers or business functions.",
  "- **Route handlers**: should only do: parse input → call business logic → format output. No validation, no DB queries, no security checks directly in the handler.",
  "- **Before adding to an existing file**, ask yourself: \"Does this logic have a different responsibility than what this file already does?\" If yes, new file.",
  "- **Architecture scoring**: New files with clear responsibility = +1 architecture expand. Inline validation in routes = -1 architecture smell. File bloat (unrelated logic in one file) = -1.",
  "",
  "### Each Iteration",
  "",
  "4. **Declare boundary upfront**: For each sub-goal, list ALL files you will touch (create, modify, or delete) and call `horsewhip_lock_intent` with ALL of them at once. If you later discover you need an additional file, call `horsewhip_lock_intent` again with the expanded list — this is preferred over `horsewhip_expand_boundary`, which pauses the workflow for human approval.",
  "",
  "5. **Work** within the boundary. Import from existing modules via their documented interfaces. Before editing, read the source files you plan to modify — do not rely on memory or interface docs alone. After changes, check: is the logic correct? Are null/undefined cases handled? Are edge cases covered? Are there similar patterns nearby that have the same issue? If the sub-goal requires deleting files, include them in the boundary declaration too.",
  "",
  "6. **Use `ask_user` for decisions**: If there are multiple valid approaches, use `ask_user` to let the user choose. Do NOT pick one yourself. If a file is blocked: put that task aside, complete what you can, call `complete_sub_goal`, and handle the blocked file in the next iteration.",
  "",
  "7. **Self-review (MANDATORY before complete_sub_goal)**: Do NOT skip this step.",
  "   - Run `git diff` to see exactly what you changed.",
  "   - For each changed file, check: logic correctness, null/undefined safety, edge case handling, error paths.",
  "   - Check nearby code: do similar patterns exist? Do they have the same issue?",
  "   - Write the review to `.chitu/plans/current/review.md`. Be specific — mention file names and concerns.",
  "   - Only after writing the review, call `complete_sub_goal`.",
  "",
  "8. **Complete**: Call `complete_sub_goal` with this iteration's exports and imports. This is MANDATORY — it triggers git commit. Skipping it means your work is lost.",
  "",
  "9. **On success** (gates pass, commit happens): Plan checkboxes and interface docs are auto-updated. Context compacts automatically. Next iteration starts fresh.",
  "",
  "### When the Entire Project Is Complete",
  "",
  "After calling `complete_sub_goal` for your final sub-goal, if there are truly no more sub-goals left: **stop.** Reply with a brief summary. Do NOT call `complete_sub_goal` with empty work. Do NOT loop. Just report completion and wait for new instructions.",
  "",
  "**Important**: `complete_sub_goal` triggers git commit. Every sub-goal MUST end with `complete_sub_goal` — otherwise your file changes are NOT saved. Only skip `complete_sub_goal` if you made zero changes.",
  "",
  "### Scoring",
  "  Creation: +2 autonomous | +1 architecture expand (new module) | -1 architecture smell | -2 architecture fraud | -3 bypass",
  "  Modify:   +1 precise | -1 file bloat (unrelated logic in one file) | -3 bypass",
  "",
].join("\n");

/** Build interface graph note for system prompt injection. */
export function buildGraphNote(workspaceRoot: string): string {
  const interfaces = scanAndIndexAllFiles(workspaceRoot);
  return interfaces.length > 0
    ? buildInterfaceMapContext(interfaces)
    : "No source files found in this project.";
}

/** Build compact state message for next iteration (discards history, keeps task + progress). */
export function buildCompactState(userGoal: string, workspaceRoot: string): string {
  const modules = getCompletedCapabilities(workspaceRoot);
  const parts = ["## 任务目标", userGoal || "(no goal recorded)", ""];

  if (modules.length > 0) {
    parts.push(`### 已完成的 ${modules.length} 个模块`);
    for (const m of modules) {
      parts.push(`- **${m.file}**: ${m.capability}`);
    }
    parts.push("");
  }

  // Include plan content so AI doesn't lose track of what's next
  try {
    const plansDir = path.join(workspaceRoot, ".chitu", "plans");
    if (fs.existsSync(plansDir)) {
      const planFiles = fs.readdirSync(plansDir).filter((f) => f.endsWith(".md"));
      if (planFiles.length > 0) {
        parts.push("### 当前计划");
        for (const pf of planFiles.slice(0, 3)) {
          const content = fs.readFileSync(path.join(plansDir, pf), "utf-8");
          // Extract unchecked items — these are what still needs work
          const unchecked = content.split("\n").filter((l) => l.match(/^-\s+\[ \]/));
          const checked = content.split("\n").filter((l) => l.match(/^-\s+\[x\]/));
          parts.push(`**${pf}**: ${checked.length} done, ${unchecked.length} remaining`);
          if (unchecked.length > 0 && unchecked.length <= 10) {
            parts.push("待完成:");
            for (const item of unchecked.slice(0, 8)) {
              parts.push(`  ${item.trim()}`);
            }
          }
        }
        parts.push("");
      }
    }
  } catch { /* best effort */ }

  parts.push("## 继续工作");
  parts.push("1. 查看上方计划，找到下一个未完成项。");
  parts.push("2. 调用 `search_interfaces` 查看可用模块和它们的导出。");
  parts.push("3. 调用 `horsewhip_lock_intent` 锁定你要修改的文件。");
  parts.push("4. 开始工作，完成后调用 `complete_sub_goal`。");
  return parts.join("\n");
}

/** Collect completed module info from interface docs. */
function getCompletedCapabilities(workspaceRoot: string): { file: string; capability: string; exports: string[] }[] {
  return loadAllFileInterfaces(workspaceRoot).map((i) => ({
    file: i.file, capability: i.capability, exports: i.exports,
  }));
}

/** Scan plan markdown files and mark checkboxes matching target files as done. */
export function markPlanItemsDone(workspaceRoot: string, targetFiles: string[]): void {
  const plansDir = path.join(workspaceRoot, ".chitu", "plans");
  if (!fs.existsSync(plansDir)) return;
  try {
    for (const entry of fs.readdirSync(plansDir)) {
      if (!entry.endsWith(".md")) continue;
      const planPath = path.join(plansDir, entry);
      let content = fs.readFileSync(planPath, "utf-8");
      let changed = false;
      for (const tf of targetFiles) {
        const escaped = tf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`(-\\s+\\[\\s*\\]\\s+.*?${escaped}.*)`, "g");
        const updated = content.replace(pattern, (match) => match.replace(/\[ \]/, "[x]"));
        if (updated !== content) { content = updated; changed = true; }
      }
      if (changed) fs.writeFileSync(planPath, content, "utf-8");
    }
  } catch { /* best-effort */ }
}
