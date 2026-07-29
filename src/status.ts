// Statusline segment: inbox count + read hint, plus net visibility — "always, but stopped" must be
// visible to a human, and queued outbound mail deserves a glance. Prints nothing when all is quiet.
// `--json` emits the structured fields (plus the composed `text`) so a custom statusline can fold flbus
// in without parsing the human string.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { DAEMON_LOCK_PATH, DAEMON_STATUS_PATH, inboxDir, projectRoot, readJson, resolveName } from "./lib";
import { NET_PATH, netActive, outboxDepth, tryNet } from "./remote/net";

export function run(args: string[] = []) {
  let input: { session_id?: string; cwd?: string; workspace?: { current_dir?: string } } = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  // start from the working dir like every other entry point; projectRoot anchors it consistently
  const cwd = projectRoot(input.workspace?.current_dir ?? input.cwd ?? process.cwd());

  let inbox = 0;
  try { inbox = readdirSync(inboxDir(cwd, resolveName(cwd, input.session_id))).filter(f => f.endsWith(".md")).length; } catch {}

  let net: { configured: boolean; active: boolean; running: boolean; mode: string; queued: number; error: boolean } | null = null;
  try {
    const cfg = tryNet();
    const configured = existsSync(NET_PATH);
    if (configured) {
      if (!cfg) net = { configured, active: false, running: false, mode: "?", queued: 0, error: true };
      else if (netActive(cfg)) {
        const snap = readJson<{ at?: number }>(DAEMON_STATUS_PATH, {});
        let pidAlive = false;
        try { const pid = Number((readFileSync(DAEMON_LOCK_PATH, "utf8").split(/\r?\n/)[0] || "").trim()); if (pid) { process.kill(pid, 0); pidAlive = true; } } catch {}
        const running = pidAlive && typeof snap.at === "number" && Date.now() - snap.at < 180_000;
        net = { configured, active: true, running, mode: cfg.mode ?? "manual", queued: outboxDepth(), error: false };
      }
    }
  } catch {}

  const parts: string[] = [];
  if (inbox > 0) parts.push(`📬 flbus ${inbox} — /flbus:recv to read`);
  if (net?.error) parts.push(`⇅ flbus net: CONFIG ERROR — flbus remote check`);
  else if (net?.active && !net.running) parts.push(`⇅ flbus net stopped (${net.mode})`);
  else if (net?.active && net.queued > 0) parts.push(`⇅ flbus net: ${net.queued} sending`);
  const text = parts.join("  ");

  if (args.includes("--json")) { console.log(JSON.stringify({ inbox, net, text })); return; }
  if (text) console.log(text);
}
