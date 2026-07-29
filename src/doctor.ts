// `flbus doctor` — the install contract. Exit 0 only when the product can actually work: CLI on PATH,
// project addressable, valid remote config, and (Claude Code) a wired statusLine so the human gate can see
// arrivals. FAILs are what break the product; warns are advisories. Neutral checks are authoritative; the
// Claude Code section is best-effort but its statusLine requirement is load-bearing (without it the gate is blind).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NO_DAEMON_PATH, peerFor, projectRoot, readJson, resolveIdentity } from "./lib";
import { NET_PATH, daemonLive, loadNet, netActive } from "./remote/net";
import pkg from "../package.json";

type Level = "ok" | "warn" | "fail";
const mark = { ok: "✓", warn: "!", fail: "✗" } as const;

// Portable PATH lookup (no dependency on `which`/`where`, which aren't guaranteed).
function onPath(): string | undefined {
  const win = process.platform === "win32";
  const exts = win ? ["", ".cmd", ".exe", ".ps1", ".bat"] : [""];
  for (const dir of (process.env.PATH || "").split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) { const p = join(dir, `flbus${ext}`); try { if (existsSync(p)) return p; } catch {} }
  }
  return undefined;
}

export function run() {
  const lines: [Level, string][] = [];
  const add = (l: Level, s: string) => lines.push([l, s]);

  // 1. CLI on PATH — hooks and statusLine call the global `flbus`; if it's not on PATH the plugin is dead.
  const p = onPath();
  add("ok", `flbus ${pkg.version}`);
  if (p) add("ok", `on PATH: ${p}`);
  else add("fail", `flbus not on PATH — hooks/statusLine can't call it (npm i -g @flatina/flbus)`);

  // 2. this project's addressability
  const cwd = projectRoot(process.cwd());
  const id = resolveIdentity(cwd);
  const registered = !!peerFor(cwd);
  if (id.via === "basename") add("warn", `project unregistered — basename '${id.name}'; peers and remote senders can't address it (flbus register, or flbus claim <name> for same-folder)`);
  else if (id.via === "claim" && !registered) add("warn", `session claimed as '${id.name}', but the project isn't registered — only same-folder (here:) senders reach it; flbus register for cross-project/remote`);
  else add("ok", `project ${id.via === "claim" ? `claimed as '${id.name}'` : `registered as '${id.name}'`}`);

  // 3. remote config + daemon (only when net.json exists)
  if (!existsSync(NET_PATH)) add("ok", `remote: not configured — local messaging only`);
  else {
    let cfg;
    try { cfg = loadNet()!; } catch (e) { add("fail", `net.json INVALID — ${(e as Error).message}`); cfg = undefined; }
    if (cfg) {
      add("ok", `net.json valid: node '${cfg.node}'${cfg.hub ? " (hub)" : ""} mode ${cfg.mode ?? "manual"}${cfg.accept ? ` accept :${cfg.accept.port}` : ""}`);
      if (netActive(cfg)) {
        if (existsSync(NO_DAEMON_PATH)) add("warn", `daemon disabled (kill-switch) — flbus remote daemon enable`);
        else if (daemonLive()) add("ok", `daemon running`);
        else if (cfg.accept) add("warn", `daemon not running — an accepting node must stay up to receive; add a login task running \`flbus remote daemon\``);
        else add("ok", `daemon idle (manual; starts on next send/session)`);
      }
    }
  }

  // 4. Claude Code statusLine — required: without it, idle arrivals are invisible and the human gate is blind.
  const settings = join(homedir(), ".claude", "settings.json");
  const s = existsSync(settings) ? readJson<{ statusLine?: { command?: string; refreshInterval?: number } }>(settings, {}) : {};
  if (!existsSync(settings)) add("fail", `Claude Code settings.json not found — statusLine unwired (required; the gate is blind without it)`);
  else if (!s.statusLine) add("fail", `no statusLine wired — required; arriving mail is invisible while idle (see the README install steps)`);
  else if (!s.statusLine.refreshInterval) add("fail", `statusLine has no refreshInterval (seconds) — idle arrivals won't refresh; add e.g. 10`);
  else if (!/flbus/.test(s.statusLine.command ?? "")) add("warn", `statusLine is a custom command — can't verify it folds in \`flbus status\`; run it and confirm 📬 shows`);
  else add("ok", `statusLine wired (refresh ${s.statusLine.refreshInterval}s)`);

  for (const [l, str] of lines) console.log(`  ${mark[l]} ${str}`);
  const failed = lines.some(([l]) => l === "fail");
  console.log(failed
    ? `  → fix the ✗ above. Plugin hooks/statusLine load at session start — restart Claude Code, then re-run \`flbus doctor\`.`
    : `  → healthy. (Plugin hooks/statusLine load at session start; restart Claude Code if you just installed.)`);
  if (failed) process.exit(1);
}
