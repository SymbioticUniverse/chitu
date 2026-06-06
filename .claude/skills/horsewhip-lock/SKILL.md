---
name: horsewhip-lock
description: >-
  MANDATORY when user types /horsewhip-lock. Full lock: git-tracked files are read-only;
  only add NEW untracked files. No editing meta/source files without expand_boundary.
  Triggers: /horsewhip-lock, full lock, decouple lock.
---

# `/horsewhip-lock`

## Single hard rule

This mode is **add-only for existing tracked code**:

- **Do not edit** any **git-tracked** file (source, config, metadata such as `package.json` / `tsconfig`)
- **Allowed:** create **new untracked** files to deliver the goal
- Use existing code via `import`; do not copy old code and modify tracked files
- Structure should emerge from constraints; this Skill does not prescribe architecture

Need to edit a tracked file? Ask user first -> `horsewhip_expand_boundary` -> then write.

## Required MCP order

1. `horsewhip_lock_decouple({ task, userText })` — `userText` must carry the user's original request
2. `horsewhip_whip_ceremony({ phase: "lock" })`
3. Implement (new files only) -> call `horsewhip_record_write({ path })` after each write
4. `horsewhip_task_complete` — **remind user to run** `git commit` manually
5. Optional `horsewhip_unlock`

For fully automated finish (including commit), use **`/horsewhip-lock-auto`**. See `horsewhip-lock-auto/SKILL.md`.

## Forbidden

- Editing files before `lock_decouple`
- Editing tracked files without `expand_boundary`
- `git commit --no-verify` or committing on behalf of user in non-auto mode

## Need delete/merge/refactor later?

Recommend opening **`/horsewhip`** in a new turn to consolidate within a bounded new-layer scope. See [decouple-architecture.md](../../../docs/decouple-architecture.md).
