// Stop hook: guards the listen promise — blocks once when the session that owns
// the listen flag tries to stop with unprocessed messages in its inbox.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { listenFlag, inboxDir, projectRoot, resolveName } from "./lib";

export function run() {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as { session_id?: string; cwd?: string; stop_hook_active?: boolean };
    if (input.stop_hook_active) process.exit(0); // never block twice — trap prevention
    const cwd = projectRoot(input.cwd ?? process.cwd());
    const name = resolveName(cwd, input.session_id);
    const flagPath = listenFlag(cwd, name);
    if (!input.session_id || !existsSync(flagPath) || readFileSync(flagPath, "utf8").trim() !== input.session_id) process.exit(0);
    const dir = inboxDir(cwd, name);
    const n = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".md")).length : 0;
    if (n > 0) {
      console.log(JSON.stringify({
        decision: "block",
        reason: `[flbus] listening, stopping with ${n} unprocessed message(s). Re-arm as a background task (flbus listen) — it consumes them; handle the content. To stop listening: flbus listen --off`,
      }));
    }
  } catch {
    // the guard fails open, silently
  }
  process.exit(0);
}
