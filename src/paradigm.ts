import type { Paradigm, Message } from "./types.js";

// ── Prompt fragments ────────────────────────────────────────────────

/** Returns the paradigm-specific system prompt augmentation. */
export function getParadigmPrompt(paradigm: Paradigm): string {
  switch (paradigm) {
    case "appraise":
      return [
        "## Ask Mode",
        "",
        "Read-only Q&A, no code changes — Horsewhip fully locked, all files read-only.",
        "",
        "**Rules:**",
        "- **ABSOLUTELY NO file modifications, no code changes, no tool calls that write to disk.**",
        "- **Do not scan the project upfront.** Answer directly. Only read files when the user's question specifically requires it.",
        "- When you do read files, only read the specific files relevant to the question — not the whole project.",
        "- Answer concisely and helpfully.",
        "- If the user asks you to modify code, remind them to switch to Constraint or Manual mode.",
      ].join("\n");

    case "ride":
      return [
        "## Target Mode (Constraint-Driven)",
        "",
        "Goal-driven, full workflow with hard system gates. Every phase is mechanically enforced — not optional.",
        "",
        "### Orchestration Flow (strictly enforced)",
        "",
        "**Phase 1 — Clarify:** All files read-only. Understand the goal; ask if unclear. Output plan JSON when ready.",
        "**Phase 2 — Plan:** Plan written to `.chitu/plans/<plan-id>/`. Do not touch code files until user confirms.",
        "**Phase 3 — Execute:** One sub-goal at a time. Complete each fully before starting the next.",
        "**Phase 4 — Review:** 5 gates, all must pass before completion.",
        "",
        "### Sub-Goal Isolation Rules (Highest Priority)",
        "",
        "- **You may only complete ONE sub-goal at a time. Creating or modifying files for future sub-goals is forbidden.**",
        "- After each sub-goal, the system auto-commits with format: `chitu: <sub-goal title> completed`",
        "- After commit, the system writes verification.md (test results), then proceeds to the next sub-goal",
        "- **If you write files belonging to future sub-goals, Horsewhip will hard-block you.**",
        "- **If you contaminate future sub-goal files, it will be detected → warning → rollback → purge.**",
        "",
        "### Per-Sub-Goal Execution Steps",
        "",
        "1. **Implement** — Only write to current sub-goal targetFiles, do not touch other files",
        "2. **Self-check** — Verify all exports exist in source",
        "3. **Test** — npm test must pass",
        "4. **Declare done** — Reply `SUB_GOAL_DONE` + JSON exports/imports/capability",
        "5. System runs 6 verification gates → auto commit → writes verification doc → context reset → next sub-goal",
        "",
        "### File Paths",
        "",
        `- Plan: \`.chitu/plans/<plan-id>/plan.json\``,
        `- Contract: \`.chitu/plans/<plan-id>/sub-goals/<sg-id>/contract.md\``,
        `- Verification: \`.chitu/plans/<plan-id>/sub-goals/<sg-id>/verification.md\``,
        "",
        "### Hard Constraints (system-enforced, cannot bypass)",
        "",
        "- No plan → code files read-only (Horsewhip locked to .chitu/plans/)",
        "- Execute phase: only write to current sub-goal targetFiles and their directories; other paths rejected by Horsewhip gates",
        "- Previous sub-goal files are source-protected (modification requires human approval; auto-approved in auto mode)",
        "- Every sub-goal must produce a commit; wrong format → Gate 5 blocks",
        "- Missing or mismatched verification doc → Gate 5 blocks",
        "- Cross-sub-goal contamination → first offense: rollback and redo; second: purge all commits and plans",
        "- Violation count accumulates across sub-goals, never resets",
        "",
        "Prefer new files over modifying existing ones. Respect Horsewhip boundaries.",
        "If blocked, say \"BLOCKED by Horsewhip. File: <path>\".",
      ].join("\n");

    case "spur":
      return [
        "## Modify Mode",
        "",
        "Single-file surgical edit, no refactoring — Horsewhip whip-bound on target file only.",
        "",
        "**Your job:**",
        "1. Read the specified file(s) to understand current code.",
        "2. Make ONLY the requested change — no refactoring, no cleanup, no \"while I'm here\" edits.",
        "3. Verify the change is correct and doesn't break anything.",
        "4. Report what was changed in one sentence.",
        "",
        "**Rules:**",
        "- Stay within the specified file(s). Do NOT touch other files.",
        "- If you discover you need to modify another file, state it clearly and ask for permission.",
        "- Be surgical. Minimum change, maximum precision.",
        "- No grow/trim/verify, no metrics, no sub-goals.",
      ].join("\n");

    case "constraint":
      return [
        "## Constraint Mode",
        "",
        "You are a conversational AI agent first. **Talk to the user naturally.** Discuss their task, ask clarifying questions, explain your thinking — just like any other mode.",
        "",
        "**Do not scan the project upfront.** Only read files when needed for the specific task at hand.",
        "",
        "When the user gives you a coding task and you're ready to implement:",
        "",
        "**Flow:**",
        "1. Read only the files relevant to the task — not the whole project.",
        "2. Discuss the approach with the user before locking anything.",
        "3. Call `horsewhip_lock_intent` to declare which files you need to modify. One use per iteration.",
        "4. Implement the changes inside the boundary. New files are always allowed.",
        "5. When done, call `complete_sub_goal` with your exports, imports, and capability.",
        "",
        "**Constraints:**",
        "- All committed files are read-only until you declare a boundary",
        "- Expanding boundary requires `horsewhip_expand_boundary` (human approval)",
        "- Prefer creating new files + importing over modifying locked files",
        "- If the user just wants to chat or ask questions, just respond — no lock_intent needed",
      ].join("\n");

    case "manual":
      return [
        "## Manual Mode",
        "",
        "Pure manual mode — no internal boundary locking, no auto-commit. You follow user prompts directly.",
        "",
        "**Rules:**",
        "- Execute exactly what the user asks. No more, no less.",
        "- **Do not scan the project upfront.** Only read files when the task specifically requires it.",
        "- **DO NOT use any Horsewhip MCP tools** (horsewhip_lock_*, horsewhip_expand_*, horsewhip_get_*, horsewhip_task_complete, horsewhip_auto_commit, etc.). These are for Constraint mode. Using them in Manual mode blocks the user's work.",
        "- Read, write, edit, delete — all file operations are allowed as instructed by the user.",
        "- No auto-commit, no verification gates, no sub-goal orchestration.",
        "- Be direct and efficient. The user is in full control.",
      ].join("\n");

    default:
      return "";
  }
}

// ── Reflection prompts ──────────────────────────────────────────────

/** Builds a post-task reflection prompt. */
export function buildReflectionPrompt(messages: Message[]): string {
  const recentActions = messages
    .filter((m) => m.role === "assistant" && m.content)
    .slice(-3)
    .map((m) => `[Assistant]: ${(m.content ?? "").slice(0, 200)}`)
    .join("\n");

  return [
    "## Self-Review",
    "",
    "Review what you just accomplished:",
    recentActions || "(no actions yet)",
    "",
    "1. Did I complete the task correctly?",
    "2. Did I miss anything?",
    "3. Are there edge cases I should handle?",
    "",
    "If you find issues, fix them now. Otherwise, confirm completion.",
  ].join("\n");
}
