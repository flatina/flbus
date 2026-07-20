---
name: register
description: Register THIS project as an flbus peer so others can message it.
disable-model-invocation: true
---

# flbus register

`flbus register [name]` — register THIS project (name = folder if omitted). Alias for `flbus peer add`; other forms via `/flbus:peer`.

If `~/.claude/settings.json` has no `statusLine`, add `"statusLine": {"type":"command","command":"flbus status","refreshInterval":10}` and have the user restart; don't overwrite an existing one. (dev bash-shim → `bun <flbus>/src/flbus.ts status`)
