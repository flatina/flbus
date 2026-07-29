// Statusline segment: inbox count + read hint, plus net visibility — "always, but stopped" must be
// visible to a human, and queued outbound mail deserves a glance. Prints nothing when all is quiet.
// `--json` emits the structured fields (plus the composed `text`) so a custom statusline can fold flbus
// in without parsing the human string.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { inboxDir, projectRoot, resolveName } from "./lib";
import { NET_PATH, daemonLive, netActive, outboxDepth, tryNet } from "./remote/net";

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
    if (existsSync(NET_PATH)) {
      if (!cfg) net = { configured: true, active: false, running: false, mode: "?", queued: 0, error: true };
      else net = { configured: true, active: netActive(cfg), running: !!daemonLive(), mode: cfg.mode ?? "manual", queued: outboxDepth(), error: false };
    }
  } catch {}

  const parts: string[] = [];
  if (inbox > 0) parts.push(`📬 flbus ${inbox} — /flbus:recv to read`);
  if (net?.error) parts.push(`⇅ flbus net: CONFIG ERROR — flbus remote check`);
  else if (net?.active && !net.running) parts.push(`⇅ flbus net stopped (${net.mode})${net.queued > 0 ? `, ${net.queued} queued` : ""}`);
  else if (net?.active && net.queued > 0) parts.push(`⇅ flbus net: ${net.queued} sending`);
  const text = parts.join("  ");

  if (args.includes("--json")) { console.log(JSON.stringify({ inbox, net, text })); return; }
  if (text) console.log(text);
}
