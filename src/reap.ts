// `flbus reap` — SessionEnd hook entrypoint: kill THIS session's listen watcher(s) and clear their flags.
// Reads {session_id, cwd} from the hook JSON on stdin. Targets only `.listen` flags owned by that session
// (sid match) in its own bus state — never other sessions' flags or unrelated processes. Fails open.
// Covers the orphan case: a watcher whose terminal/session closed but whose process survived.
// Graceful exit only — a force-closed session can leave a live-process orphan that's unobservable here.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { busDir, listenFlag, projectRoot, readFlag } from "./lib";

// A stale flag may name a pid the OS reused for another process — confirm it's still an flbus listen
// watcher before killing (fail safe: don't kill if unconfirmed).
function isListenWatcher(pid: number): boolean {
  const isWatcher = (cmd: string) => /flbus/i.test(cmd) && /\blisten\b/i.test(cmd);
  try {
    if (process.platform === "linux") return isWatcher(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    if (process.platform === "darwin") return isWatcher(execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 2000, windowsHide: true }));
    return isWatcher(execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", timeout: 2000, windowsHide: true }));
  } catch { return false; }
}

export function run() {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as { session_id?: string; cwd?: string };
    if (!input.session_id) process.exit(0);
    const cwd = projectRoot(input.cwd ?? process.cwd());
    const base = busDir(cwd);
    if (!existsSync(base)) process.exit(0);
    for (const name of readdirSync(base)) {
      if (name === "archive" || name === "sessions.json") continue;
      try { if (!statSync(join(base, name)).isDirectory()) continue; } catch { continue; }
      const flag = listenFlag(cwd, name);
      const fl = readFlag(flag);
      if (!fl || fl.sid !== input.session_id) continue; // only flags this session owns
      if (fl.pid && isListenWatcher(fl.pid)) { try { process.kill(fl.pid); } catch {} }
      try { rmSync(flag, { force: true }); } catch {}
    }
  } catch { /* never break session teardown */ }
  process.exit(0);
}
