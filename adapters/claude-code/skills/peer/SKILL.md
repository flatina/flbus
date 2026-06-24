---
name: peer
description: Register another flbus instance (a project now, a remote PC later) so you can message it; list or remove peers.
---

# flbus peer

Peers live in the machine-local table (`~/.flbus/peers.json`); registration writes nothing into the project.

```
flbus peer add                         # this project, folder name
flbus peer add <name>                  # this project, chosen name
flbus peer add <name> <projectDir>     # another project
flbus peer add ... --state <relpath>   # store state in-tree at <project>/<relpath> (default: central ~/.flbus)
flbus peer ls
flbus peer rm <name>
```

Then address it as `<name>` (its default mailbox) or `<name>:<mailbox>` (a specific session there).

Same-folder mailboxes are NOT peers — make them with `flbus claim <name>` (to receive) or `flbus mailbox add <name>` (for another session), and address them `here:<name>`.
