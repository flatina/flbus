// `flbus peer ls | add [name] [projectDir] [--state <relpath>] | rm <name>`
// add defaults: projectDir = cwd, name = folder basename. --state opts into in-tree storage (default: central).
// One default identity per project: re-registering a dir under a new name renames it, mailbox dir included.
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { atomicWrite, peers, PEERS_PATH, readJson, RESERVED, retryRename, samePath, stateDir, validName, type PeerEntry } from "./lib";

export function run(args: string[]) {
  const sIdx = args.indexOf("--state");
  const stateArg = sIdx >= 0 ? args.splice(sIdx, 2)[1] : undefined;
  const [cmd, nameArg, dirArg] = args;

  // raw form is preserved on write: plain string = a bare dir (no state → central storage)
  const raw = readJson<Record<string, string | PeerEntry>>(PEERS_PATH, {});
  const entryDir = (v: string | PeerEntry) => (typeof v === "string" ? v : v.dir);
  const entryState = (v: string | PeerEntry) => (typeof v === "string" ? undefined : v.state);

  if (cmd === "ls") {
    const entries = Object.entries(peers());
    if (!entries.length) console.log("(no peers)");
    for (const [n, e] of entries)
      console.log(`${n}\t${e.dir}${e.state ? `\tstate: ${e.state}` : ""}${existsSync(e.dir) ? "" : "\t(missing!)"}`);
  } else if (cmd === "add") {
    const abs = resolve(dirArg ?? process.cwd());
    if (!existsSync(abs)) { console.error(`directory not found: ${abs}`); process.exit(1); }
    const name = nameArg ?? basename(abs);
    if (!validName(name) || RESERVED.has(name)) { console.error(`invalid peer name '${name}' — letters/digits/._- only, and not reserved (${[...RESERVED].join("/")})`); process.exit(1); }
    let state = stateArg;
    if (state !== undefined && (isAbsolute(state) || state.split(/[\\/]/).includes(".."))) {
      console.error(`--state must be a relative path inside the project (no absolute path, no ..): '${state}'`); process.exit(1);
    }
    for (const [n, v] of Object.entries(raw)) {
      if (n === name || !samePath(entryDir(v), abs)) continue;
      state ??= entryState(v);
      delete raw[n];
      const oldEp = join(stateDir(abs, entryState(v)), n);
      const newEp = join(stateDir(abs, state), name);
      if (existsSync(oldEp) && !existsSync(newEp)) {
        mkdirSync(dirname(newEp), { recursive: true });
        retryRename(oldEp, newEp);
      }
      console.log(`renamed: ${n} → ${name}`);
    }
    const prev = raw[name];
    if (prev && samePath(entryDir(prev), abs)) state ??= entryState(prev);
    if (prev && !samePath(entryDir(prev), abs)) console.log(`overwriting ${name}: ${entryDir(prev)} → ${abs}`);
    raw[name] = state ? { dir: abs, state } : abs;
    atomicWrite(PEERS_PATH, JSON.stringify(raw, null, 2));
    console.log(`peer: ${name} → ${abs}${state ? ` (state: ${state})` : ""}`);
  } else if (cmd === "rm" && nameArg) {
    if (!(nameArg in raw)) { console.error(`no such peer: ${nameArg}`); process.exit(1); }
    delete raw[nameArg];
    atomicWrite(PEERS_PATH, JSON.stringify(raw, null, 2));
    console.log(`removed: ${nameArg}`);
  } else {
    console.error("usage: flbus peer ls | add [name] [projectDir] [--state <relpath>] | rm <name>");
    process.exit(1);
  }
}
