// `flbus mailbox rm <name>`  -- tear a same-folder mailbox down (unread messages are archived first)
// `flbus mailbox ls`         -- list this project's mailboxes + pending counts
// To RECEIVE as a mailbox use `flbus claim <name>` (creates + binds the session); `flbus register` creates a
// project's default mailbox. `mailbox bind` is the mechanical alias `claim` dispatches to. Command-only lifecycle.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { archivePartition, atomicWrite, busDir, inboxDir, listenFlag, projectRoot, readFlag, readJson, RESERVED, resolveName, retryRename, validName } from "./lib";

export function run(args: string[]) {
  const [sub = "ls", arg] = args;
  const cwd = projectRoot(process.cwd());

  function requireValid(name: string | undefined): string {
    if (!name) { console.error(`mailbox ${sub}: a <name> is required`); process.exit(1); }
    if (!validName(name) || RESERVED.has(name)) { console.error(`invalid mailbox name '${name}' -- letters/digits/._- only, and not reserved`); process.exit(1); }
    return name;
  }

  if (sub === "rm") {
    const name = requireValid(arg);
    const dir = join(busDir(cwd), name);
    if (!existsSync(dir)) { console.log(`no mailbox '${name}' here`); process.exit(0); }
    if (existsSync(listenFlag(cwd, name))) console.log(`warning: '${name}' has a listen flag -- a live session may be listening`);
    if (name === resolveName(cwd)) console.log(`note: '${name}' is this project's default name -- it reappears on next use`);
    // atomic against deposit: rename the mailbox dir aside first (a racing deposit ENOENTs into a clean
    // error), THEN archive its unread messages — a deposit that won the race is archived, never deleted.
    const aside = `${dir}.rm-${process.pid}`;
    try { retryRename(dir, aside); }
    catch (e) { console.error(`could not remove '${name}' (a watcher may hold it): ${e}`); process.exit(1); }
    const inbox = join(aside, "inbox");
    let archived = 0;
    if (existsSync(inbox)) {
      const part = archivePartition(cwd);
      mkdirSync(part, { recursive: true });
      for (const f of readdirSync(inbox).filter(f => f.endsWith(".md"))) {
        try { retryRename(join(inbox, f), join(part, `${Date.now()}-${f}`)); archived++; } catch {}
      }
    }
    try { rmSync(aside, { recursive: true, force: true }); } catch {}
    console.log(`mailbox '${name}' removed${archived ? ` (${archived} unread archived)` : ""}`);
  } else if (sub === "ls" || sub === "list") {
    const base = busDir(cwd);
    const isDir = (n: string) => { try { return statSync(join(base, n)).isDirectory(); } catch { return false; } };
    const names = existsSync(base) ? readdirSync(base).filter(n => n !== "archive" && !n.startsWith(".") && isDir(n)) : [];
    if (!names.length) { console.log("(no mailboxes)"); process.exit(0); }
    for (const n of names) {
      const inbox = inboxDir(cwd, n);
      const count = existsSync(inbox) ? readdirSync(inbox).filter(f => f.endsWith(".md")).length : 0;
      console.log(`${n}\t${count} pending`);
    }
  } else if (sub === "bind") {
    // session <-> mailbox identity (the `claim` alias dispatches here)
    const sid = process.env.CLAUDE_CODE_SESSION_ID;
    if (!sid) { console.error("no CLAUDE_CODE_SESSION_ID -- run inside a Claude Code session"); process.exit(1); }
    const path = join(busDir(cwd), "sessions.json");
    const sessions = readJson<Record<string, string>>(path, {});
    const oldName = sessions[sid];
    const dropOwnedFlag = (name: string | undefined) => {
      if (!name) return;
      const f = listenFlag(cwd, name);
      if (existsSync(f) && readFlag(f)?.sid === sid) { rmSync(f, { force: true }); console.log(`listen off for '${name}'`); }
    };
    if (arg === "--off") {
      delete sessions[sid];
      atomicWrite(path, JSON.stringify(sessions, null, 2));
      dropOwnedFlag(oldName);
      console.log(`unbound -- this session resolves as '${resolveName(cwd)}'`);
    } else {
      const name = requireValid(arg);
      sessions[sid] = name;
      atomicWrite(path, JSON.stringify(sessions, null, 2));
      mkdirSync(inboxDir(cwd, name), { recursive: true }); // binding makes you reachable
      if (oldName && oldName !== name) dropOwnedFlag(oldName);
      console.log(`bound: this session is '${name}' -- scripts and hooks resolve it from here on`);
    }
  } else {
    console.error("usage: flbus mailbox ls | rm <name>   (to receive as one: flbus claim <name>; a project default: flbus register)");
    process.exit(1);
  }
}
