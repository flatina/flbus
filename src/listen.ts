// `flbus listen`            on: write the mode flag, watch own inbox, consume on arrival
// `flbus listen --arm-only` write the flag only — no watch — then exit, arming the Stop-hook guard
//                           (a waiting message blocks the next stop). For self-delivery: a bare watcher
//                           would consume the just-armed message and exit mid-turn, losing the wakeup.
// `flbus listen --off`      off: remove this session's mode flag
// The flag persists across deliveries (mode ≠ process) — re-arm after each one.
// Single owner per inbox: the newest arm (sid+pid in the flag) delivers; a superseded watcher stands down.
import { watch } from "node:fs";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { listenFlag, consumeMessage, inboxDir, out, projectRoot, readFlag, resolveIdentity } from "./lib";
import { ensure } from "./remote/daemon";

export function run(args: string[]) {
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) { console.error("no CLAUDE_CODE_SESSION_ID — run inside a Claude Code session"); process.exit(1); }
  const unknown = args.find(a => a !== "--off" && a !== "--arm-only");
  if (unknown) { console.error(`unknown argument: ${unknown} (usage: flbus listen [--off | --arm-only])`); process.exit(1); }

  const cwd = projectRoot(process.cwd());
  const id = resolveIdentity(cwd);
  const name = id.name;
  const flagPath = listenFlag(cwd, name);

  if (args.includes("--off")) {
    if (!existsSync(flagPath)) { console.log(`not listening as '${name}'`); process.exit(0); }
    if (readFlag(flagPath)?.sid !== sid) {
      console.error(`listen for '${name}' is owned by another session — not touching it`);
      process.exit(1);
    }
    rmSync(flagPath, { force: true });
    console.log(`listen off for '${name}'`);
    process.exit(0);
  }

  // Fail closed, nothing written: arming a basename-fallback identity would phantom-create a mailbox
  // nobody can address (mailboxes exist only via claim/register — listen must not be a third way in).
  if (id.via === "basename") {
    console.error(`not listening: this folder is unregistered — '${name}' is a basename fallback peers and remote senders cannot address.`);
    console.error(`\`flbus register\` this project (or \`flbus claim <name>\`) first, then listen.`);
    process.exit(1);
  }

  mkdirSync(dirname(flagPath), { recursive: true });
  const armOnly = args.includes("--arm-only");
  // arm-only has no watcher to reap → sid only; a watching listen records pid for ownership
  writeFileSync(flagPath, armOnly ? `${sid}\n` : `${sid}\n${process.pid}\n`, "utf8");

  if (armOnly) {
    console.log(`armed as '${name}' (flag only, not watching) — a waiting message blocks the next stop`);
    process.exit(0);
  }

  const dir = inboxDir(cwd, name);
  mkdirSync(dir, { recursive: true });
  if (!out(`listening as '${name}': ${dir}\n`)) process.exit(1);

  const messages = () => readdirSync(dir).filter(f => f.endsWith(".md")).sort(); // receive-prefix order
  // single owner: deliver only while I hold the flag (sid+pid); a newer arm supersedes me → stand down
  const owned = () => { const fl = readFlag(flagPath); return fl?.sid === sid && fl?.pid === process.pid; };

  function finish(files: string[]) {
    if (!owned()) process.exit(0); // a newer session/process took over this inbox — don't race it
    for (const f of files) {
      // probe stdout before the irreversible consume — a dead pipe leaves the message for redelivery
      if (!out(`===== ${f} =====\n`)) {
        console.error("[flbus] listen stdout closed (piped to a reader that exited?) — not consuming; run a bare `flbus listen`");
        process.exit(1);
      }
      let raw: string | null;
      try { raw = consumeMessage(cwd, name, f); }
      catch (e) { console.error(`[flbus] consume error for ${f} (message preserved): ${e}`); continue; }
      if (raw === null) { out(`(${f} was already taken by another reader)\n`); continue; } // not a silent drop
      if (!out(`${raw}\n`)) process.exit(1); // pipe closed mid-message; already archived
    }
    out("[flbus] delivered — report what arrived to the user, then re-arm to keep listening\n");
    process.exit(0);
  }

  let settling: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    if (settling) return;
    settling = setTimeout(() => {
      if (!owned()) process.exit(0); // stand down even when idle, once a newer arm supersedes me
      const files = messages();
      if (files.length) finish(files);
      settling = null;
    }, 200);
  };

  watch(dir, check); // arm the watcher before the pre-scan — no arrival gap
  const existing = messages();
  if (existing.length) finish(existing);

  setInterval(() => {
    check();
    try { ensure(); } catch {} // a daemon that crashes mid-quiet-stretch has no prompt to revive it — a live watcher does
  }, 10_000); // poll fallback for missed fs.watch events (and the idle stand-down check)
}
