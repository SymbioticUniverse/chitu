---
name: horsewhip-lock-auto
description: >-
  MANDATORY when user types /horsewhip-lock-auto. Same as horsewhip-lock (add-only, tracked read-only)
  but end with horsewhip_finish_auto to commit. Explicit user opt-in for automated git commit.
  Triggers: /horsewhip-lock-auto, lock auto, decouple auto.
---

# `/horsewhip-lock-auto`

Same hard rule as `/horsewhip-lock` (new files only, tracked files read-only), but with **explicit user authorization** for automatic `git commit` at finish.

## Hard rules

- **Do not edit** git-tracked files (including metadata), unless expanded via `expand_boundary`
- **Allowed:** create new untracked files + import old code
- **Only this command** may call `horsewhip_auto_commit` / `horsewhip_finish_auto`
- **Never** use `git commit --no-verify`; if hooks fail, fix and retry

## MCP order

1. `horsewhip_lock_decouple({ task, userText })`
2. `horsewhip_whip_ceremony({ phase: "lock" })`
3. Implement -> call `horsewhip_record_write` for each new file write
4. **`horsewhip_finish_auto({ summary, message })`** — commit only after guard passes  
   - `message` is one line aligned with task, e.g. `feat: ...`

Optional split flow: `task_complete` then `horsewhip_auto_commit({ message })`.

5. Optional `horsewhip_unlock`

## Difference from `/horsewhip-lock`

| | `/horsewhip-lock` | `/horsewhip-lock-auto` |
|---|-------------------|------------------------|
| commit | **User commits manually** | **`finish_auto` commits automatically** (user opted in) |
| use case | Manual acceptance or documentation-sensitive workflow | Fully automated closed-loop experiment |

Without `-auto`, auto-commit is **forbidden**.
