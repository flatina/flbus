// `flbus peek [--name <name>]` · `flbus take <file|all> [--name <name>]` · `flbus discard <file|all> [--name <name>]`
// take/discard move the message into the state dir's archive (paper trail); discard skips printing it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { consumeMessage, inboxDir, parseEnvelope, projectRoot, resolveIdentity } from "./lib";

export function run(args: string[]) {
  const cmd = args[0];
  const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };

  const cwd = projectRoot(process.cwd());
  const id = resolveIdentity(cwd);
  const name = opt("name") ?? id.name;
  const dir = inboxDir(cwd, name);
  // receive-time prefix orders the listing; directory enumeration order is not presentation order
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".md")).sort() : [];

  if (cmd === "peek") {
    // an empty fallback inbox is not the same fact as an empty real one — nobody could have sent here
    if (!opt("name") && id.via === "basename") console.log(`(this folder is unregistered — resolving as basename '${name}'; peers and remote senders cannot address it)`);
    if (!files.length) { console.log("(inbox empty)"); process.exit(0); }
    for (const f of files) {
      const { env } = parseEnvelope(readFileSync(join(dir, f), "utf8"));
      console.log(`${f}\tfrom ${env.from ?? "?"}\t${env.summary ?? ""}`);
    }
  } else if (cmd === "take" || cmd === "discard") {
    const target = args[1];
    if (!target) { console.error("required: a message file name, or all"); process.exit(1); }
    const picked = target === "all" ? files : files.filter(f => f === target);
    if (!picked.length) { console.error(`not in inbox: ${target}`); process.exit(1); }
    for (const f of picked) {
      let raw: string | null;
      try { raw = consumeMessage(cwd, name, f); } // archived either way
      catch (e) { console.error(`consume error for ${f} (message preserved): ${e}`); continue; }
      if (raw === null) { console.error(`already taken (concurrent consume): ${f}`); continue; }
      if (cmd === "take") { console.log(`===== ${f} =====`); console.log(raw); }
      else console.log(`discarded (unread): ${f}`);
    }
  } else {
    console.error("usage: flbus peek|take|discard <file|all> [--name <name>]");
    process.exit(1);
  }
}
