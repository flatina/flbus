// `flbus peer ls | add [name] [dir] [--state <rel>] | rm <name>`  (`list` accepted for `ls`)
// Peers are THIS-machine projects. add registers one (dir defaults to cwd, name to basename) AND creates its
// default mailbox -- registered = reachable. Remote nodes live in net.json, not here.
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { atomicWrite, inboxDir, peers, PEERS_PATH, readJson, RESERVED, retryRename, samePath, stateDir, validName, type PeerEntry } from "./lib";

export function run(args: string[]) {
  const splice = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const stateArg = splice("--state");
  if (args.includes("--host") || args.includes("--via")) {
    console.error("--host/--via belonged to the removed ssh transport — remote nodes live in ~/.flbus/net.json (`flbus remote check`); peers are local projects only");
    process.exit(1);
  }
  const [cmd = "ls", nameArg, dirArg] = args;

  const raw = readJson<Record<string, string | PeerEntry>>(PEERS_PATH, {});
  const entryDir = (v: string | PeerEntry): string | undefined => (typeof v === "string" ? v : v.dir);
  const entryState = (v: string | PeerEntry) => (typeof v === "string" ? undefined : v.state);

  if (cmd === "ls" || cmd === "list") {
    const entries = Object.entries(peers());
    if (!entries.length) console.log("(no peers)");
    for (const [n, e] of entries) {
      if (e.host) { console.log(`${n}\t@${e.host}\t(removed ssh transport — re-register the machine as a net node, then \`flbus peer rm ${n}\`)`); continue; }
      console.log(`${n}\t${e.dir}${e.state ? `\tstate: ${e.state}` : ""}${e.dir && existsSync(e.dir) ? "" : "\t(missing!)"}`);
    }
  } else if (cmd === "add") {
    const abs = resolve(dirArg ?? process.cwd());
    if (!existsSync(abs)) { console.error(`directory not found: ${abs}`); process.exit(1); }
    const name = nameArg ?? basename(abs);
    if (!validName(name) || RESERVED.has(name)) { console.error(`invalid peer name '${name}' -- letters/digits/._- only, and not reserved (${[...RESERVED].join("/")})`); process.exit(1); }
    let state = stateArg;
    if (state !== undefined && (isAbsolute(state) || state.split(/[\\/]/).includes(".."))) {
      console.error(`--state must be a relative path inside the project (no absolute path, no ..): '${state}'`); process.exit(1);
    }
    for (const [n, v] of Object.entries(raw)) {
      const d = entryDir(v);
      if (n === name || !d || !samePath(d, abs)) continue; // skip other dirs and remote (dir-less) entries
      state ??= entryState(v);
      delete raw[n];
      const oldEp = join(stateDir(abs, entryState(v)), n);
      const newEp = join(stateDir(abs, state), name);
      if (existsSync(oldEp) && !existsSync(newEp)) { mkdirSync(dirname(newEp), { recursive: true }); retryRename(oldEp, newEp); }
      console.log(`renamed: ${n} -> ${name}`);
    }
    const prev = raw[name];
    const prevDir = prev && entryDir(prev);
    if (prevDir && samePath(prevDir, abs)) state ??= entryState(prev);
    if (prevDir && !samePath(prevDir, abs)) console.log(`overwriting ${name}: ${prevDir} -> ${abs}`);
    raw[name] = state ? { dir: abs, state } : abs;
    atomicWrite(PEERS_PATH, JSON.stringify(raw, null, 2));
    mkdirSync(inboxDir(abs, name), { recursive: true }); // register creates the default mailbox = reachable
    console.log(`peer: ${name} -> ${abs}${state ? ` (state: ${state})` : ""} (mailbox '${name}' ready)`);
  } else if (cmd === "rm" && nameArg) {
    if (!(nameArg in raw)) { console.error(`no such peer: ${nameArg}`); process.exit(1); }
    delete raw[nameArg];
    atomicWrite(PEERS_PATH, JSON.stringify(raw, null, 2));
    console.log(`removed: ${nameArg}`);
  } else {
    console.error("usage: flbus peer ls | add [name] [dir] [--state <rel>] | rm <name>");
    process.exit(1);
  }
}
