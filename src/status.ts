// Statusline segment: inbox count + read hint, plus net visibility — "always, but stopped" must be
// visible to a human, and queued outbound mail deserves a glance. Prints nothing when all is quiet.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { DAEMON_LOCK_PATH, DAEMON_STATUS_PATH, inboxDir, projectRoot, readJson, resolveName } from "./lib";
import { NET_PATH, netActive, outboxDepth, tryNet } from "./remote/net";

export function run() {
  let input: { session_id?: string; cwd?: string; workspace?: { current_dir?: string } } = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  // start from the working dir like every other entry point; projectRoot anchors it consistently
  const cwd = projectRoot(input.workspace?.current_dir ?? input.cwd ?? process.cwd());
  const parts: string[] = [];
  try {
    const n = readdirSync(inboxDir(cwd, resolveName(cwd, input.session_id))).filter(f => f.endsWith(".md")).length;
    if (n > 0) parts.push(`📬 flbus ${n} — /flbus:recv to read`);
  } catch { /* no inbox dir = empty segment */ }
  try {
    const cfg = tryNet();
    if (!cfg && existsSync(NET_PATH)) parts.push(`⇅ flbus net: CONFIG ERROR — flbus remote check`); // invalid must not read as absent
    if (cfg && netActive(cfg)) {
      const snap = readJson<{ pid?: number; at?: number }>(DAEMON_STATUS_PATH, {});
      let pidAlive = false;
      try { const pid = Number((readFileSync(DAEMON_LOCK_PATH, "utf8").split(/\r?\n/)[0] || "").trim()); if (pid) { process.kill(pid, 0); pidAlive = true; } } catch {}
      const running = pidAlive && typeof snap.at === "number" && Date.now() - snap.at < 180_000;
      const queued = outboxDepth();
      if (!running) parts.push(`⇅ flbus net stopped (${cfg.mode ?? "manual"})`);
      else if (queued > 0) parts.push(`⇅ flbus net: ${queued} sending`);
    }
  } catch { /* net status is best-effort */ }
  if (parts.length) console.log(parts.join("  "));
}
