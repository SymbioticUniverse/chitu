---
name: horsewhip-auto
description: >-
  MANDATORY when user types /horsewhip-auto. Same pasture workflow as /horsewhip
  (intent lock + tiered guard + inline expand), but end with horsewhip_finish_auto
  to commit. Explicit user opt-in for automated git commit.
  Triggers: /horsewhip-auto, auto pasture, auto consolidation.
---

# `/horsewhip-auto`

Same boundary rules as `/horsewhip` (intent lock + tiered pasture + inline overreach expansion), but with **explicit user authorization** to auto-run `git commit` at finish.

## Hard rules

- Run `lock_intent` before editing; do not write before lock
- Overreach must be user-approved before `expand_boundary`
- **Only this command** may call `horsewhip_auto_commit` / `horsewhip_finish_auto`
- Never use `git commit --no-verify`; if hooks fail, fix and retry

## Required MCP order

1. `horsewhip_lock_intent({ task, touch, core, edge, preview: true, userText })`
2. After user confirms partition (or `auto: true`): `horsewhip_lock_intent({ ..., preview: false })`
3. `horsewhip_whip_ceremony({ phase: "lock" })`
4. Implement inside pasture + call `horsewhip_record_write({ path })` after each write
5. **`horsewhip_finish_auto({ summary, message })`** — commit only after guard passes  
   - `message` should be one line aligned with the task, e.g. `feat: ...`
6. Optional `horsewhip_unlock`

Optional split flow: `horsewhip_task_complete` then `horsewhip_auto_commit({ message })`.

## Difference from `/horsewhip`

| | `/horsewhip` | `/horsewhip-auto` |
|---|-------------|-------------------|
| commit | **User commits manually** | **`finish_auto` commits automatically** (user opted in) |
| use case | Bounded consolidation + manual finish | Bounded consolidation + fully automated finish |

Without `-auto`, auto-commit is forbidden.
