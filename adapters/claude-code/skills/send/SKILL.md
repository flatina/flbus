---
name: send
description: Send a message to another agent over flbus.
---

```
flbus send --to <addr> --summary "<terse one line>"
flbus send --to <addr> --summary "<terse one line>" --subject "<filename>" --body "<terse contents>"
```

`<addr>` — who receives:
- `peer`           — a registered peer project's default mailbox (the common case)
- `peer:mailbox`   — a named mailbox on a peer (when it has multiple sessions)
- `here:mailbox`   — a mailbox in THIS folder (co-located sessions); `here:` is required, never a bare name

`peer` = a project on the table (`/flbus:peer`). Remote `…@host` is reserved for later.

- Body with backticks/`$(...)`/quotes: never inline `--body` (shell mangles it) — use `--body-stdin` with a single-quoted heredoc (bash `<<'E'…E`) or here-string (PowerShell `@'…'@`), or `--body-file <.tmp/file>`
- `--cc <a,b>`: also deliver to others (everyone sees the full addressing)
- New same-folder recipient with no mailbox yet: `flbus mailbox add <name>` first, then address it `here:<name>`
- Re-send with the same `--subject` to overwrite (recipient sees only the final version)
- Recall an unread message: `--recall --to <addr> --subject <s>` (same `--cc`/`--from`) — only until pulled
- After sending, end the turn — the human decides when it's read
