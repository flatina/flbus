// `flbus listen`            on: write the mode flag, watch own inbox, consume on arrival
// `flbus listen --arm-only` write the mode flag only — no watch, no consume — then exit. Arms the
//                           Stop-hook guard: a message then left in the inbox blocks the next stop and
//                           re-prompts, so self-delivery doesn't depend on the background-completion
//                           wakeup. The woken turn consumes it (`flbus get` / a fresh `listen`).
// `flbus listen --off`      off: remove this session's mode flag
// The flag persists across deliveries (mode ≠ process) — re-arm after each one.
// Exits 0 on delivery; lives and dies with the session.
import { watch } from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { listenFlag, consumeMessage, inboxDir, projectRoot, resolveName } from "./lib";

export function run(args: string[]) {
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) { console.error("no CLAUDE_CODE_SESSION_ID — run inside a Claude Code session"); process.exit(1); }
  const unknown = args.find(a => a !== "--off" && a !== "--arm-only");
  if (unknown) { console.error(`unknown argument: ${unknown} (usage: flbus listen [--off | --arm-only])`); process.exit(1); }

  const cwd = projectRoot(process.cwd());
  const name = resolveName(cwd);
  const flagPath = listenFlag(cwd, name);

  if (args.includes("--off")) {
    if (!existsSync(flagPath)) { console.log(`not listening as '${name}'`); process.exit(0); }
    if (readFileSync(flagPath, "utf8").trim() !== sid) {
      console.error(`listen for '${name}' is owned by another session — not touching it`);
      process.exit(1);
    }
    rmSync(flagPath, { force: true });
    console.log(`listen off for '${name}'`);
    process.exit(0);
  }

  mkdirSync(dirname(flagPath), { recursive: true });
  writeFileSync(flagPath, sid, "utf8");

  if (args.includes("--arm-only")) {
    console.log(`armed as '${name}' (flag only, not watching) — a waiting message blocks the next stop`);
    process.exit(0);
  }

  const dir = inboxDir(cwd, name);
  mkdirSync(dir, { recursive: true });
  console.log(`listening as '${name}': ${dir}`);

  const messages = () => readdirSync(dir).filter(f => f.endsWith(".md"));

  function finish(files: string[]) {
    for (const f of files) {
      let raw: string | null;
      try { raw = consumeMessage(cwd, name, f); }
      catch (e) { console.error(`[flbus] consume error for ${f} (message preserved): ${e}`); continue; }
      if (raw === null) continue; // another consumer won the claim — no loss
      console.log(`===== ${f} =====`);
      console.log(raw);
    }
    console.log("[flbus] delivered — report what arrived to the user, then re-arm to keep listening");
    process.exit(0);
  }

  let settling: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    if (settling) return;
    settling = setTimeout(() => {
      const files = messages();
      if (files.length) finish(files);
      settling = null;
    }, 200);
  };

  watch(dir, check); // arm the watcher before the pre-scan — no arrival gap
  const existing = messages();
  if (existing.length) finish(existing);

  setInterval(check, 10_000); // poll fallback for missed fs.watch events
}
