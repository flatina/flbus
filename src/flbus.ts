#!/usr/bin/env node
// Single entrypoint: `flbus <cmd> …` calls a per-command module's `run()`. Bundled to a single node
// binary (`dist/flbus.js`, the npm bin); dev runs `bun src/flbus.ts`. peek/take/discard share pull (it
// reads the verb from argv[0]); `claim` is the short alias for `mailbox bind`.
import { run as send } from "./send";
import { run as pull } from "./pull";
import { run as listen } from "./listen";
import { run as guard } from "./listen-guard";
import { run as peer } from "./peer";
import { run as status } from "./status";
import { run as notify } from "./notify";
import { run as mailbox } from "./mailbox";
import pkg from "../package.json";

const [cmd, ...rest] = process.argv.slice(2);

const DISPATCH: Record<string, () => void> = {
  send: () => send(rest),
  peek: () => pull([cmd, ...rest]),
  take: () => pull([cmd, ...rest]),
  discard: () => pull([cmd, ...rest]),
  listen: () => listen(rest),
  mailbox: () => mailbox(rest),
  claim: () => mailbox(["bind", ...rest]),
  status: () => status(),
  peer: () => peer(rest),
  notify: () => notify(),
  guard: () => guard(),
};

const HELP = `flbus ${pkg.version} — human-gated, file-based agent message bus

usage: flbus <command> [args]

  send --to <addr> --summary <s> [--subject <s>] [--cc <a,b>] [--body <t>|--body-file <p>|--body-stdin]
                                      send a message (--recall to unsend an unread one)
                                      <addr>: peer | peer:mailbox | here:mailbox
  peek [--name <name>]                list waiting messages (summaries; does NOT consume)
  take <file|all> [--name <name>]     read message(s) and remove from inbox (archived)
  discard <file|all> [--name <name>]  drop message(s) unread (archived)
  listen [--off|--arm-only]           watch inbox & CONSUME on arrival (run as a background task)
  claim <name> | claim --off          receive as <name> here (creates the mailbox + binds this session)
  mailbox add <name> | ls | rm <name> pre-make / list / remove same-folder mailboxes
  peer add [name] [dir] [--state <rel>] | ls | rm <name>
                                      directory of other flbus instances (projects now, remote PCs later)
  status                              inbox indicator for statusLine (reads hook JSON on stdin)
  -h, --help                          show this help
  -v, --version                       show version

State is central in ~/.flbus by default; set a peer's \`state\` to store it in-tree instead.
(notify and guard are internal Claude Code hook entrypoints.)`;

if (!cmd || cmd === "-h" || cmd === "--help") { console.log(HELP); process.exit(0); }
if (cmd === "-v" || cmd === "--version") { console.log(pkg.version); process.exit(0); }

const fn = DISPATCH[cmd];
if (!fn) {
  if (cmd === "route") console.error(`flbus: 'route' was renamed to 'peer' (the routing table). To SEND a message, use \`flbus send --to <addr>\`.`);
  else if (cmd === "endpoint") console.error(`flbus: 'endpoint' was renamed to 'mailbox' (and 'create' to 'add'). To receive as a name, use \`flbus claim <name>\`.`);
  else if (cmd === "list") console.error(`flbus: 'list' was renamed to 'peek'.`);
  else if (cmd === "get") console.error(`flbus: 'get' was renamed to 'take'.`);
  else console.error(`flbus: unknown command '${cmd}' — run \`flbus --help\``);
  process.exit(1);
}
fn();
