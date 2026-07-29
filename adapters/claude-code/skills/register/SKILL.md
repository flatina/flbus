---
name: register
description: Register THIS project as an flbus peer so others can message it.
disable-model-invocation: true
---

# flbus register

`flbus register [name]` — register THIS project (name = folder if omitted). Alias for `flbus peer add`; other forms via `/flbus:peer`. The CLI only creates the mailbox — the statusLine wiring below is this skill's job (an agent that ran the bare CLI still needs it).

**statusLine** — without it, arriving mail is invisible while idle and the gate is effectively blind. In `~/.claude/settings.json`:
- No `statusLine` → add `{"type":"command","command":"flbus status","refreshInterval":10}`. `refreshInterval` is in **seconds** (min 1). (dev: `command` → `bun <flbus>/src/flbus.ts status`.)
- A `statusLine` already exists → **don't overwrite it; fold flbus in as a segment**: have its command also run `flbus status --json` and append the `.text` field (empty when quiet), **piping the same hook JSON it receives to that call's stdin** (flbus reads `workspace.current_dir`/`session_id` from it). Ensure `refreshInterval` (seconds) is set.

Then have the user **restart Claude Code** (statusLine + hooks load at session start) and verify with `flbus doctor`.
