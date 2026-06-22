---
name: register
description: Put a project on the flbus routing table; list or remove routes.
---

# flbus register

Routes live in the machine-local flbus table (`~/.flbus/routes.json`); registration writes nothing into the project.

```
flbus route add                        # this project, folder name
flbus route add <name>                 # this project, chosen name
flbus route add <name> <projectDir>    # another project
flbus route add ... --state <relpath>  # store state in-tree at <project>/<relpath> (default: central ~/.flbus)
flbus route list
flbus route remove <name>
```

- Same-folder endpoints need no route — manage them directly:

```
flbus endpoint create <name>   # make a same-folder mailbox
flbus endpoint ls              # list endpoints here
flbus endpoint rm <name>       # tear one down
```
