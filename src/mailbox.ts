// `flbus mailbox add <name>` — make a same-folder mailbox so another session can `claim` it (or you can address `here:<name>`)
// `flbus mailbox rm <name>`  — tear it down (unread messages are archived first)
// `flbus mailbox ls`         — list this project's mailboxes + pending counts
// To RECEIVE as a mailbox, use `flbus claim <name>` (creates it if needed + binds this session); `mailbox bind` is the
// mechanical alias `claim` dispatches to. Mailbox lifecycle is command-only — callers never touch the bus storage layout.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { archiveDir, atomicWrite, busDir, inboxDir, listenFlag, peers, projectRoot, readJson, RESERVED, resolveName, retryRename, validName } from "./lib";

export function run(args: string[]) {
  const [sub, arg] = args;
  const cwd = projectRoot(process.cwd());

  function requireValid(name: string | undefined): string {
    if (!name) { console.error(`mailbox ${sub}: a <name> is required`); process.exit(1); }
    if (!validName(name) || RESERVED.has(name)) { console.error(`invalid mailbox name '${name}' — letters/digits/._- only, and not reserved`); process.exit(1); }
    return name;
  }

  if (sub === "add") {
    const name = requireValid(arg);
    mkdirSync(inboxDir(cwd, name), { recursive: true });
    if (peers()[name]) console.log(`note: '${name}' is also a peer name — address this local one as 'here:${name}'`);
    console.log(`mailbox '${name}' ready — to receive as it: flbus claim ${name}`);
  } else if (sub === "rm") {
    const name = requireValid(arg);
    const dir = join(busDir(cwd), name);
    if (!existsSync(dir)) { console.log(`no mailbox '${name}' here`); process.exit(0); }
    // no-silent-loss invariant: archive any unread messages before removing
    const inbox = inboxDir(cwd, name);
    let archived = 0;
    if (existsSync(inbox)) {
      mkdirSync(archiveDir(cwd), { recursive: true });
      for (const f of readdirSync(inbox).filter(f => f.endsWith(".md"))) {
        try { retryRename(join(inbox, f), join(archiveDir(cwd), `${Date.now()}-${f}`)); archived++; } catch {}
      }
    }
    if (existsSync(listenFlag(cwd, name))) console.log(`warning: '${name}' has a listen flag — a live session may be listening`);
    if (name === resolveName(cwd)) console.log(`note: '${name}' is this project's default name — it reappears on next use`);
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error(`could not fully remove '${name}' (a watcher may hold it): ${e}`); process.exit(1); }
    console.log(`mailbox '${name}' removed${archived ? ` (${archived} unread archived)` : ""}`);
  } else if (sub === "ls") {
    const base = busDir(cwd);
    const isDir = (n: string) => { try { return statSync(join(base, n)).isDirectory(); } catch { return false; } };
    const names = existsSync(base) ? readdirSync(base).filter(n => n !== "archive" && isDir(n)) : [];
    if (!names.length) { console.log("(no mailboxes)"); process.exit(0); }
    for (const n of names) {
      const inbox = inboxDir(cwd, n);
      const count = existsSync(inbox) ? readdirSync(inbox).filter(f => f.endsWith(".md")).length : 0;
      console.log(`${n}\t${count} pending`);
    }
  } else if (sub === "bind") {
    // session ↔ mailbox identity (the `claim` alias dispatches here)
    const sid = process.env.CLAUDE_CODE_SESSION_ID;
    if (!sid) { console.error("no CLAUDE_CODE_SESSION_ID — run inside a Claude Code session"); process.exit(1); }
    const path = join(busDir(cwd), "sessions.json");
    const sessions = readJson<Record<string, string>>(path, {});
    const oldName = sessions[sid];
    const dropOwnedFlag = (name: string | undefined) => {
      if (!name) return;
      const f = listenFlag(cwd, name);
      if (existsSync(f) && readFileSync(f, "utf8").trim() === sid) { rmSync(f, { force: true }); console.log(`listen off for '${name}'`); }
    };
    if (arg === "--off") {
      delete sessions[sid];
      atomicWrite(path, JSON.stringify(sessions, null, 2));
      dropOwnedFlag(oldName);
      console.log(`unbound — this session resolves as '${resolveName(cwd)}'`);
    } else {
      const name = requireValid(arg);
      sessions[sid] = name;
      atomicWrite(path, JSON.stringify(sessions, null, 2));
      mkdirSync(inboxDir(cwd, name), { recursive: true }); // binding makes you reachable
      if (oldName && oldName !== name) dropOwnedFlag(oldName);
      console.log(`bound: this session is '${name}' — scripts and hooks resolve it from here on`);
    }
  } else {
    console.error("usage: flbus mailbox add <name> | ls | rm <name>   (to receive as one: flbus claim <name>)");
    process.exit(1);
  }
}
