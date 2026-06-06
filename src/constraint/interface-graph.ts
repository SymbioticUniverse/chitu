import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  loadAllFileInterfaces,
  buildInterfaceMapContext,
} from "./interface.js";

export const CONSTRAINT_INSTRUCTION = [
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
  "   - **No plan** → create one as `{plan-name}.md`. Break the task into sub-tasks, one module each.",
  "   - **Has plan** → read it. `[x]` = done (interface doc exists), `[ ]` = not done.",
  "",
  "3. **Three-way alignment**: Cross-reference plan, interface docs, and disk files.",
  "   - File on disk + plan unchecked + no interface doc → **orphan** (interrupted iteration). Priority: lock it, review/complete it, export its interface.",
  "   - Plan checked + interface exists → already done, skip.",
  "",
  "### Each Iteration",
  "",
  "4. **Pick ONE unchecked item** from the plan (ONE file, not a whole phase). Call `horsewhip_lock_intent` with ONLY that item's files.",
  "",
  "5. **Work** within the boundary. Import from existing modules via their documented interfaces. Prefer new files over modifying locked ones.",
  "",
  "6. **If blocked**: `horsewhip_expand_boundary` with `reason`: `architecture` (interface/export change), `bugfix`, or `omission`. Max 2 expands per iteration, cumulative boundary ≤ 10 files.",
  "",
  "7. **Complete**: Call `complete_sub_goal` with this iteration's exports and imports.",
  "",
  "8. **On success** (gates pass, commit happens): Plan checkboxes and interface docs are auto-updated. Context compacts automatically. Next iteration starts fresh.",
  "",
  "### Scoring",
  "  Creation: +2 autonomous | +1 valid architecture expand | -1 bugfix/omission | -2 architecture fraud | -3 bypass",
  "  Modify:   +1 precise | -1 expand | -3 bypass",
  "",
].join("\n");

/** Build interface graph note for system prompt injection. */
export function buildGraphNote(workspaceRoot: string): string {
  const interfaces = loadAllFileInterfaces(workspaceRoot);
  return interfaces.length > 0
    ? buildInterfaceMapContext(interfaces)
    : "No interface graph yet. Read the source files directly, then call `horsewhip_lock_intent` to set your boundary.";
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
