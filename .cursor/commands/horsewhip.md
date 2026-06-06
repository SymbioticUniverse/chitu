# Horsewhip — mandatory boundary workflow

**This command is active.** Follow the Horsewhip flow strictly; **do not** Write / edit / batch-change any project files until locking completes.

## 1. Load the Skill (required)

Read and obey the full Skill (pick one client):

- Cursor: `.cursor/skills/horsewhip/SKILL.md`
- Claude Code: `.claude/skills/horsewhip/SKILL.md`

## 2. User task

Text **after the command name in the same message** is this session's task. If there is no concrete task, ask the user what to do before locking.

## 3. Required order (Phase 4B · intent lock)

1. **Intent** — `horsewhip_lock_intent` with `preview: true`: `task` + `touch` globs; optional `core` / `edge` tiers
2. **Confirm** — show the core/edge partition table; lock only after user approval (or `auto: true`)
3. **`horsewhip_lock_intent`** with `preview: false` → system resolves files and writes allowlist v3
4. **`horsewhip_whip_ceremony`** — `{ "phase": "lock" }`
5. **Edit** — change code only inside the allowlist
6. **Done** — `horsewhip_task_complete` + remind the user to `git commit` themselves

For tiny tasks (1–3 explicit files), `horsewhip_lock_paths` is still allowed.

## 4. Overreach · inline round

- Write blocked → read `inlineExpand.prompt` in `edit-blocked.json`
- Confirm once with the user → `horsewhip_expand_boundary({ paths: ["…"], inline: true, grantedBy: "user" })` → **immediately rewrite** that file
- Do not expand without user consent

## 5. vs. normal chat

When the user types `/horsewhip`, you **must** run the MCP flow above — not a normal coding request that edits files directly.

## 6. Need fully automatic commit?

If the user wants lock + tidy + auto commit on finish, use **`/horsewhip-auto <task>`** and follow the `horsewhip-auto` skill `finish_auto` flow.
