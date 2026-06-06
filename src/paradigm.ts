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
        "- You may read files to answer questions, but never edit, create, or delete anything.",
        "- Answer concisely and helpfully.",
        "- If the user asks you to modify code, remind them to switch to Target or Modify mode.",
      ].join("\n");

    case "ride":
      return [
        "## Target Mode (Constraint-Driven)",
        "",
        "Goal-driven, full workflow with hard system gates. Every phase is mechanically enforced — not optional.",
        "",
        "### 编排流程（必须严格遵循）",
        "",
        "**Phase 1 — Clarify:** 所有文件只读。理解目标，不够清晰就追问。准备好后输出 plan JSON。",
        "**Phase 2 — Plan:** 计划写入 `.chitu/plans/<plan-id>/`。用户确认后才能碰代码文件。",
        "**Phase 3 — Execute:** 逐子目标执行，每个子目标严格完成后再做下一个。",
        "**Phase 4 — Review:** 5 道关卡，全部通过才算完成。",
        "",
        "### 子目标隔离规则（最高优先级）",
        "",
        "- **你一次只能完成一个子目标。禁止为后续子目标创建或修改任何文件。**",
        "- 每个子目标完成后，系统会自动 commit，格式: `chitu: <子目标标题> 完成`",
        "- commit 后系统写入 verification.md（指标快照 + 测试结果），然后才能进入下一子目标",
        "- **如果你越界写入后续子目标的文件，会被 Horsewhip 硬拦截。**",
        "- **如果你污染了后续子目标的文件，会被检测到 → 警告 → 回滚重做 → 清除。**",
        "",
        "### 每个子目标的执行步骤",
        "",
        "1. **实现** — 只写当前子目标的 targetFiles，不允许碰其他文件",
        "2. **自检** — 确认 exports 都在源码中存在",
        "3. **测试** — npm test 必须通过",
        "4. **声明完成** — 回复 `SUB_GOAL_DONE` + JSON exports/imports/capability",
        "5. 系统自动执行 6 道验证门禁 → 自动 commit → 写验证文档 → 上下文重置 → 下一子目标",
        "",
        "### 文件路径",
        "",
        `- 计划: \`.chitu/plans/<plan-id>/plan.json\``,
        `- 接口契约: \`.chitu/plans/<plan-id>/sub-goals/<sg-id>/contract.md\``,
        `- 验证文档: \`.chitu/plans/<plan-id>/sub-goals/<sg-id>/verification.md\``,
        "",
        "### 硬约束（系统强制执行，无法绕过）",
        "",
        "- 无计划 → 代码文件只读（Horsewhip 锁定到 .chitu/plans/）",
        "- 执行阶段：只能写当前子目标 targetFiles 及其目录，其他路径被 Horsewhip gates 拒绝",
        "- 前序子目标文件受源码保护（修改需人工授权，云长模式自动授权）",
        "- 每个子目标必须产生一个 commit，格式不符 → Gate 5 拦截",
        "- 验证文档缺失或不对应 → Gate 5 拦截",
        "- 跨子目标污染 → 第一次回滚重做，第二次清除所有 commit 和计划",
        "- 违反次数累计跨子目标不清零",
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
        "Horsewhip boundary mode — every committed file is locked. You operate within explicit boundaries.",
        "",
        "**Flow:**",
        "1. Read the Interface Graph (injected below) — it maps every file, its exports, and its dependencies.",
        "2. Call `horsewhip_lock_intent` to declare which files you need to modify. One use per iteration.",
        "3. New files are always allowed. Locked files require `horsewhip_expand_boundary` (human approval).",
        "4. When done, call `complete_sub_goal` with your exports, imports, and capability.",
        "",
        "**Constraints:**",
        "- All committed files are read-only until you declare a boundary",
        "- Expand boundary = human-in-loop = -1 score",
        "- Bypass orchestration = -3 score",
        "- Prefer creating new files + importing over modifying locked files",
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
