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
  "You operate under **constraint mode**. Work iteratively — one module per iteration. After each `complete_sub_goal`, context is compacted. Plan documents (`.chitu/plans/`) and interface documents (`.chitu/interfaces/`) are your only memory across iterations.",
  "",
  "### Before You Start: Understand & Discuss",
  "",
  "**Work autonomously.** Before locking any files:",
  "- **Read the actual source files**, not just interface docs. Interface docs are metadata (exports/imports) — they cannot show you bugs, logic errors, or implementation details.",
  "- **Trace the code path** related to the user's request. If the user reports a bug, find the root cause — don't just fix the symptom they described.",
  "- **Look for related issues**: if one place has a bug, similar patterns elsewhere in the codebase may have the same bug. Read and check.",
  "- If anything is unclear, ask the user — don't guess",
  "- If there are multiple valid approaches, use `ask_user` to let the user choose",
  "- Describe your understanding and plan, then call `horsewhip_lock_intent` to declare your boundary and start working. Do NOT wait for confirmation — proceed automatically.",
  "",
  "### Starting Each Iteration",
  "",
  "1. **Interfaces are pre-indexed**: The Interface Graph below lists every source file, its exports, and its imports. Use it ONLY for file discovery and dependency mapping. It does NOT replace reading source code — interface docs are metadata, not implementation.",
  "   - If the graph is empty → fresh project, proceed to step 2.",
  "",
  "2. **Check plan**: Read `.chitu/plans/`. Is there a plan for this task?",
  "   - **No plan** → create one as `{plan-name}.md`. Break the task into sub-tasks, one module each.",
  "   - **Has plan** → read it. `[x]` = done (interface doc exists), `[ ]` = not done.",
  "",
  "3. **Three-way alignment**: Cross-reference plan, interface docs, and disk files.",
  "   - File on disk + plan unchecked + no interface doc → **orphan** (interrupted iteration). Priority: lock it, review/complete it, export its interface.",
  "   - Plan checked + interface exists → already done, skip.",
  "",
  "### Each Iteration",
  "",
  "4. **Declare boundary upfront**: For each sub-goal, list ALL files you will touch (create, modify, or delete) and call `horsewhip_lock_intent` with ALL of them at once. If you later discover you need an additional file, call `horsewhip_lock_intent` again with the expanded list — this is preferred over `horsewhip_expand_boundary`, which pauses the workflow for human approval.",
  "",
  "5. **Work** within the boundary. Import from existing modules via their documented interfaces. Before editing, read the source files you plan to modify — do not rely on memory or interface docs alone. After changes, review: is the fix correct? Are there similar patterns nearby that have the same issue? If the sub-goal requires deleting files, include them in the boundary declaration too.",
  "",
  "6. **Use `ask_user` for decisions**: If there are multiple valid approaches, use `ask_user` to let the user choose. Do NOT pick one yourself. If a file is blocked: put that task aside, complete what you can, call `complete_sub_goal`, and handle the blocked file in the next iteration.",
  "",
  "7. **Complete**: Call `complete_sub_goal` with this iteration's exports and imports.",
  "",
  "8. **On success** (gates pass, commit happens): Plan checkboxes and interface docs are auto-updated. Context compacts automatically. Next iteration starts fresh.",
  "",
  "### When All Tasks Are Done",
  "",
  "**Stop.** Reply with a brief summary. Do NOT call `complete_sub_goal` with empty work. Do NOT loop. If there are no more sub-goals, just report completion and wait for new instructions.",
  "",
  "### Scoring",
  "  Creation: +2 autonomous | +1 valid architecture expand | -1 bugfix/omission | -2 architecture fraud | -3 bypass",
  "  Modify:   +1 precise | -1 expand | -3 bypass",
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
  const parts = ["## Task", userGoal || "(no goal recorded)", ""];
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
