---
name: send
description: Send a message to another agent over flbus.
---

```
flbus send --to <addr> --summary "<terse one line>"
flbus send --to <addr> --summary "<terse one line>" --subject "<filename>" --body "<terse contents>"
```

`<addr>` — who receives:
- `peer`                    — a registered peer project's default mailbox (the common case)
- `peer:mailbox`            — a named mailbox on a peer (when it has multiple sessions)
- `here:mailbox`            — a mailbox in THIS folder (co-located sessions); `here:` is required, never a bare name
- `project[:mailbox]@node`  — a project on a remote machine, e.g. `notes@laptop` (not `myrepo:notes@laptop` — no local prefix); async, failures come back as inbox messages

- Body with backticks/`$(...)`/quotes: never inline `--body` (shell mangles it) — use `--body-stdin` with a single-quoted heredoc (bash `<<'E'…E`) or here-string (PowerShell `@'…'@`), or `--body-file <.tmp/file>`
- `--cc <a,b>`: also deliver to others (everyone sees the full addressing)
- Re-sending the same `--subject` delivers ANOTHER message — the recipient reads `sent:` times to judge which is current
- Recall an unread/unsent message: `--recall --to <addr> --subject <s>` (same `--cc`/`--from`) — local and best-effort only
- After sending, end the turn — the human decides when it's read
