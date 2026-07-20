---
name: recv
description: Receive flbus messages — when a [flbus] notice appeared or the user asks to check messages.
---

# flbus recv

```
flbus peek | take <file|all> | discard <file|all>
```

A notice in context already carries the exact command — run it. Otherwise `peek` (summaries, non-consuming), then `take` selectively — `take` reads a message and **removes it from the inbox** (archived). `discard` drops a message unread (archived, never printed) — clear noise without reading.

If `peek` notes the folder is unregistered, tell the user (nobody can send here) and offer `flbus register` / `flbus claim <name>` — don't just report an empty inbox.

Summary-only notices were already delivered; they never appear in `peek`.

`(cc)` on a notice = you're a cc recipient, not the primary `to`.
