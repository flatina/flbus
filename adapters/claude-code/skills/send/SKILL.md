---
name: send
description: Send a message to another agent over flbus.
---

```
flbus send --to <name> --summary "<terse one line>"

flbus send --to <name> --summary "<terse one line>" --subject "<filename>" --body "<terse contents>"

# to a new same-folder endpoint: create it first, then send
flbus endpoint create <name>
flbus send --to <name> --summary "<terse one line>"
```

- Body with backticks/`$(...)`/quotes: never inline `--body` (shell mangles it) — use `--body-stdin` with a single-quoted heredoc (bash `<<'E'…E`) or here-string (PowerShell `@'…'@`), or `--body-file <.tmp/file>`
- `--cc <a,b>`: also deliver the same message to others (everyone sees the full addressing)
- Monorepo: a subfolder session shares the parent's identity unless registered — suggest `/flbus:register` if it should be separate
- Re-send with the same `--subject` to overwrite (recipient sees only the final version)
- Recall an unread message: `--recall --to <name> --subject <s>` (same `--cc`/`--from`) — only until the recipient pulls it
- After sending, end the turn — the human decides when it's read
