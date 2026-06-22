---
name: recv
description: Receive flbus messages — when a [flbus] notice appeared or the user asks to check messages.
---

# flbus recv

```
flbus list | get <file|all> | discard <file|all>
```

A notice in context already carries the exact command — run it. Otherwise `list`, then `get` selectively. `discard` drops a message unread (archived, never printed) — use it to clear noise without reading.

Summary-only notices were already delivered; they never appear in `list`.

`(cc)` on a notice = you're a cc recipient, not the primary `to`.
