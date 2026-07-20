---
name: peer
description: Register, list, or remove flbus peers (other projects) to message them.
---

# flbus peer

```
flbus peer add                         # this project, folder name
flbus peer add <name> [projectDir]     # register a project under <name> (dir = cwd if omitted)
flbus peer add ... --state <relpath>   # store its state in-tree (default: central)
flbus peer ls
flbus peer rm <name>
```

Address a peer as `<name>` (its default mailbox) or `<name>:<mailbox>`. Peers are local projects; a project on
another machine is addressed `<project>[:mailbox]@node` (nodes: `flbus remote check`).
