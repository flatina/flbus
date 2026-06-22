#!/usr/bin/env node
// Single entrypoint: `flbus <cmd> …` calls a per-command module's `run()`. Bundled to a single node
// binary (`dist/flbus.js`, the npm bin); dev runs `bun src/flbus.ts`. list/get/discard share pull (it
// reads the verb from argv[0]); `claim` is the short alias for `endpoint bind`.
import { run as send } from "./send";
import { run as pull } from "./pull";
import { run as listen } from "./listen";
import { run as guard } from "./listen-guard";
import { run as route } from "./route";
import { run as status } from "./status";
import { run as notify } from "./notify";
import { run as endpoint } from "./endpoint";
import pkg from "../package.json";

const [cmd, ...rest] = process.argv.slice(2);

const DISPATCH: Record<string, () => void> = {
  send: () => send(rest),
  list: () => pull([cmd, ...rest]),
  get: () => pull([cmd, ...rest]),
  discard: () => pull([cmd, ...rest]),
  listen: () => listen(rest),
  endpoint: () => endpoint(rest),
  claim: () => endpoint(["bind", ...rest]),
  status: () => status(),
  route: () => route(rest),
  notify: () => notify(),
  guard: () => guard(),
};

const HELP = `flbus ${pkg.version} — human-gated, file-based agent message bus

usage: flbus <command> [args]

  send --to <name> --summary <s> [--subject <s>] [--cc <a,b>] [--body <t>|--body-file <p>|--body-stdin]
                                      send a message (--recall to unsend an unread one)
  list [--name <name>]                list inbox summaries
  get <file|all> [--name <name>]      read message(s), archived after
  discard <file|all> [--name <name>]  drop unread without reading (archived)
  listen [--off]                      watch inbox, consume on arrival (run as a background task)
  endpoint create|rm|ls [<name>]      manage same-folder mailboxes
  claim <name> | claim --off          bind this session to a name (alias of: endpoint bind)
  route list | add [name] [dir] [--state <rel>] | remove <name>
                                      cross-project routing table
  status                              inbox indicator for statusLine (reads hook JSON on stdin)
  -h, --help                          show this help
  -v, --version                       show version

State is central in ~/.flbus by default; set a route's \`state\` to store it in-tree instead.
(notify and guard are internal Claude Code hook entrypoints.)`;

if (!cmd || cmd === "-h" || cmd === "--help") { console.log(HELP); process.exit(0); }
if (cmd === "-v" || cmd === "--version") { console.log(pkg.version); process.exit(0); }

const fn = DISPATCH[cmd];
if (!fn) {
  console.error(`flbus: unknown command '${cmd}' — run \`flbus --help\``);
  process.exit(1);
}
fn();
