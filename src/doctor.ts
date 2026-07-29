// `flbus doctor` — self-diagnostic for an install agent. Neutral checks are authoritative; Claude Code
// integration is best-effort (the CLI is adapter-neutral). Exit 1 if any check FAILs.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_LOCK_PATH, DAEMON_STATUS_PATH, NO_DAEMON_PATH, pidMatches, projectRoot, readJson, resolveIdentity } from "./lib";
import { NET_PATH, loadNet, netActive } from "./remote/net";
import pkg from "../package.json";

type Level = "ok" | "warn" | "fail";
const mark = { ok: "✓", warn: "!", fail: "✗" } as const;

export function run() {
  const lines: [Level, string][] = [];
  const add = (l: Level, s: string) => lines.push([l, s]);

  // 1. CLI on PATH — the global `flbus` an agent/hook resolves (may differ from how doctor was invoked)
  let onPath: string | undefined;
  try {
    const [c, a] = process.platform === "win32" ? ["where", "flbus"] : ["which", "flbus"];
    onPath = execFileSync(c, [a], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0].trim() || undefined;
  } catch {}
  if (onPath) add("ok", `flbus ${pkg.version} on PATH (${onPath})`);
  else add("warn", `flbus ${pkg.version} running, but not found on PATH — hooks/statusLine call the global \`flbus\` (npm i -g @flatina/flbus)`);

  // 2. this project's identity
  const cwd = projectRoot(process.cwd());
  const id = resolveIdentity(cwd);
  if (id.via === "basename") add("warn", `project unregistered — resolving as basename '${id.name}'; peers and remote senders can't address it (flbus register / flbus claim <name>)`);
  else add("ok", `project ${id.via === "claim" ? "claimed" : "registered"} as '${id.name}'`);

  // 3. net.json (remote transport)
  if (!existsSync(NET_PATH)) {
    add("ok", `remote: not configured (${NET_PATH}) — local messaging only`);
  } else {
    try {
      const cfg = loadNet()!;
      add("ok", `net.json valid: node '${cfg.node}'${cfg.hub ? " (hub)" : ""} mode ${cfg.mode ?? "manual"}${cfg.accept ? ` accept :${cfg.accept.port}` : ""}`);
      // 4. daemon liveness (only meaningful when remote is active)
      if (netActive(cfg)) {
        if (existsSync(NO_DAEMON_PATH)) add("warn", `daemon disabled (kill-switch set) — flbus remote daemon enable`);
        else {
          const pid = Number((readFileSync(DAEMON_LOCK_PATH, "utf8").split(/\r?\n/)[0] || "").trim() || 0);
          const alive = pid ? pidMatches(pid, /(?=[\s\S]*flbus)(?=[\s\S]*\bdaemon\b)/i) : false;
          const snap = readJson<{ at?: number }>(DAEMON_STATUS_PATH, {});
          const fresh = typeof snap.at === "number" && Date.now() - snap.at < 180_000;
          if (alive && fresh) add("ok", `daemon running (pid ${pid})`);
          else add("warn", `daemon not running — starts on next send/session; a receive-only node needs a boot trigger (login scheduled task running \`flbus remote daemon\`)`);
        }
      }
    } catch (e) {
      add("fail", `net.json INVALID — ${(e as Error).message}`);
    }
  }

  // 5. Claude Code integration (best-effort; the CLI is adapter-neutral)
  const settings = join(homedir(), ".claude", "settings.json");
  if (existsSync(settings)) {
    const s = readJson<{ statusLine?: { command?: string; refreshInterval?: number } }>(settings, {});
    if (!s.statusLine) add("warn", `no statusLine wired — arriving mail is invisible while idle; wire \`flbus status\` (see /flbus:register)`);
    else if (!s.statusLine.refreshInterval) add("warn", `statusLine has no refreshInterval (seconds) — idle arrivals won't refresh; add e.g. 10`);
    else add("ok", `statusLine wired (refresh ${s.statusLine.refreshInterval}s)${/flbus/.test(s.statusLine.command ?? "") ? "" : " — custom command; ensure it folds in `flbus status`"}`);
  }
  add("warn", `plugin hooks + statusLine load at session start — RESTART Claude Code after install, then re-run \`flbus doctor\` to verify`);

  for (const [l, s] of lines) console.log(`  ${mark[l]} ${s}`);
  if (lines.some(([l]) => l === "fail")) process.exit(1);
}
