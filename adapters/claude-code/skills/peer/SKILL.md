---
name: peer
description: Register this project (or another) as an flbus peer so others can message it, and list or remove peers.
---

# flbus peer

```
flbus register                         # register THIS project (folder name) — alias for `flbus peer add`
flbus peer add <name> [projectDir]     # register a project under <name> (dir = cwd if omitted)
flbus peer add ... --state <relpath>   # store its state in-tree (default: central)
flbus peer ls
flbus peer rm <name>
```

Registering makes a project addressable (creates its mailbox). The inbox indicator (statusLine) is wired once at install, not here — see the README install steps.

Address a peer as `<name>` (its default mailbox) or `<name>:<mailbox>`. Peers are local projects; a project on
another machine is addressed `<project>[:mailbox]@node` (nodes: `flbus remote check`).
