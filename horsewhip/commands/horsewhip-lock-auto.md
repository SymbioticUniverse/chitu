# `/horsewhip-lock-auto`

**Fully automatic decouple growth.** Read `.cursor/skills/horsewhip-lock-auto/SKILL.md`.

## Difference from `/horsewhip-lock`

User suffix **`-auto`** = authorize **automatic git commit** on finish (pre-commit guard still applies; never use `--no-verify`).

## Order

1. `horsewhip_lock_decouple` + `userText`
2. `horsewhip_whip_ceremony` lock
3. Create new files only + `record_write`
4. **`horsewhip_finish_auto({ summary, message })`**
5. Optional `unlock`

Task = text after the command.
