# `/horsewhip-auto`

**Fully automatic lock-and-tidy.** Read `.cursor/skills/horsewhip-auto/SKILL.md`.

## Difference from `/horsewhip`

User suffix **`-auto`** = authorize **automatic git commit** on finish (pre-commit guard still applies; never use `--no-verify`).

## Order

1. `horsewhip_lock_intent` preview (show strict/warn tiers and confirm)
2. `horsewhip_lock_intent` lock + `horsewhip_whip_ceremony` lock
3. Edit only inside the boundary + `horsewhip_record_write`
4. **`horsewhip_finish_auto({ summary, message })`**
5. Optional `horsewhip_unlock`

Task = text after the command.
