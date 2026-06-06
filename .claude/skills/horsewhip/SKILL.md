---
name: horsewhip
description: >-
  MANDATORY when user types /horsewhip or asks to use Horsewhip boundary workflow.
  Declare intent + touch globs via lock_intent before edits; tiered strict/warn guard;
  inline expand on overreach; whip on lock and task complete. Triggers: /horsewhip,
  horsewhip, boundary lock, lock paths before edit.
---

# Horsewhip — AI boundary workflow (Phase 4B)

## Forced invocation: `/horsewhip`

When the user message **starts with `/horsewhip`** or they pick the **`/horsewhip` slash command**:

1. Treat this as **mandatory** — do **not** edit files until the workflow below completes.
2. Strip the `/horsewhip` prefix; the remainder is the task.
3. Follow **Intent lock** and **Inline expand** without shortcuts.

## Intent lock (prefer over lock_paths)

**Do not guess file lists.** Declare task + touch globs; the system resolves files.

```json
horsewhip_lock_intent({
  "task": "add batch query cache middleware",
  "touch": ["packages/server/src/middleware/", "tests/", "examples/minimal/"],
  "core": ["packages/server/src/middleware/**/*.ts"],
  "edge": ["examples/minimal/**"],
  "preview": true
})
```

Show the returned partition to the user:

- **strict core** — block + revert if touched without lock
- **warn edge** — allow write, audit only (`auto_allow` in audit chain)

After user confirms (or `auto: true` in trusted mode):

```json
horsewhip_lock_intent({ "task": "...", "touch": [...], "core": [...], "edge": [...], "preview": false })
horsewhip_whip_ceremony({ "phase": "lock" })
```

**`preview: true`** already writes `user_request` to session-audit (with `userText`). **`preview: false`** reuses that session — do not omit `userText` on the first preview call.

Legacy `horsewhip_lock_paths` still works for tiny 1–3 file tasks.

## Tiered guard

| Tier | Behavior |
|------|----------|
| **strict** | In pasture; full commit/write guard |
| **warn** | In pasture; writes allowed, logged to `.git/horsewhip/audit-chain.jsonl` |
| **unrelated** | Outside pasture → block + inline expand prompt |

## Inline expand (two-turn overreach)

When write/save is blocked, read `.git/horsewhip/edit-blocked.json` → `inlineExpand.prompt`.

1. Ask once: "Can I expand boundary to include `db.ts`?"
2. On yes:

```json
horsewhip_expand_boundary({ "paths": ["examples/minimal/db.ts"], "inline": true, "grantedBy": "user" })
```

3. **Immediately retry** the write to that file (system expanded; you rewrite).

Do **not** wait for the user to say "expand" in a separate turn.

## Standard flow

1. **Preview** — `lock_intent` with `preview: true` OR `suggest_scope` with `touch`
2. **Confirm** — user approves partition (unless `auto: true`)
3. **Lock** — `lock_intent` `preview: false` + `whip_ceremony` lock
4. **Edit** inside pasture only — after each in-pasture edit call `horsewhip_record_write({ path: "<rel>" })` if save/audit may not reach the extension (required when the Agent writes directly to disk)
5. **Overreach** — inline expand flow above
6. **Done** — `task_complete` + remind user to run `git commit` themselves
7. **Unlock** — optional `horsewhip_unlock`

## Audit chain

All hops append to **`.git/horsewhip/session-audit.json`** (causal chain with `causedBy`):

| type | Meaning |
|------|---------|
| `user_request` | **Chain root** — pass user's original words in `userText` |
| `intent_lock` | Pasture armed from resolved globs |
| `auto_allow` | Edge tier file included |
| `strict_block` | Outside pasture blocked |
| `user_expand` | User approved inline/full expand |
| `write` | Successful in-pasture save |

Always pass **`userText`** on `lock_intent` with the user's verbatim instruction (not just your task summary).

Open **Guard Record** in VS Code to see the full causal timeline.

## MCP tools

| Tool | Purpose |
|------|---------|
| `horsewhip_lock_intent` | **Primary** — task + touch globs → resolved files + tiers |
| `horsewhip_lock_paths` | Legacy explicit file list (max 8) |
| `horsewhip_suggest_scope` | Preview partition without locking |
| `horsewhip_expand_boundary` | Merge paths/globs; `inline: true` for one-round expand |
| `horsewhip_record_write` | Log in-pasture write to session-audit (when Agent writes directly or extension is offline) |
| `horsewhip_unlock` | Clear boundary |
| `horsewhip_get_boundary` | Allowlist + tiers + edit-blocked |
| `horsewhip_whip_ceremony` | Whip + UI |
| `horsewhip_task_complete` | Closing whip; releases panel readonly |

## Forbidden

- Guessing filenames instead of `touch` globs on non-trivial tasks
- Skipping user confirm on strict/core partition (unless user enabled auto)
- Silent edits outside pasture
- `git commit --no-verify` / committing for the user

See [docs/boundary-guard.md](../../../docs/boundary-guard.md).

## Related: `/horsewhip-lock` (growth phase)

Full lock — tracked read-only, new files only. Skill: `horsewhip-lock/SKILL.md` · MCP: `horsewhip_lock_decouple`.  
Constraint shapes structure; no upfront architecture prescription in Skill.

After growth, user may use **`/horsewhip`** to consolidate (prune inside a pasture). See [decouple-architecture.md](../../../docs/decouple-architecture.md).

## Related: `/horsewhip-auto` (consolidation + auto commit)

When the user explicitly wants "bounded consolidation + automatic commit", use **`/horsewhip-auto`** (Skill: `horsewhip-auto/SKILL.md`):

- Same boundary flow as `/horsewhip` (`lock_intent` preview/confirm/lock + inline expand)
- Finish with `horsewhip_finish_auto({ summary, message })`
- Still forbid `--no-verify`; if hooks fail, fix and retry commit

Without `-auto`, `/horsewhip` remains **user commits manually**.

## Consolidation phase (`/horsewhip`)

When user wants **delete / merge / refactor** inside a bounded scope (often after `/horsewhip-lock`):

1. `lock_intent` preview → confirm → lock + `whip_ceremony`
2. Edit **inside** pasture only (deletes allowed inside)
3. `task_complete`

Do not use pasture for greenfield decouple growth — use `/horsewhip-lock`.
