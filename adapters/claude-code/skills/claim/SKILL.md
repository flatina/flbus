---
name: claim
description: Receive as a name in this folder (for co-located sessions sharing one project); binds this session.
disable-model-invocation: true
---

# flbus claim

```
flbus claim <name>      # receive as <name> here: creates the mailbox if needed AND binds THIS session
flbus claim --off       # release the binding
```

`claim` is how a session *becomes* a recipient. After it, this session resolves as `<name>`; others reach you at `here:<name>` (same folder) or `<thisProject>:<name>` (from a peer).

**`claim` vs `mailbox add`** — both make a same-folder mailbox, but for opposite intents:
- **`flbus claim <name>`** — *"I receive as `<name>`."* Creates + **binds this session**. The normal case.
- **`flbus mailbox add <name>`** — *"make a mailbox for ANOTHER session to claim later."* Creates **without binding** — pre-provision a box before its session exists; that session then runs `flbus claim <name>`.
