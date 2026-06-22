// UserPromptSubmit hook: one-line inbox summaries (never injects bodies).
// Summary-only messages (empty body) are fully delivered by the notice line: archived here, no pull needed.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { archiveDir, inboxDir, parseEnvelope, projectRoot, resolveName, retryRename } from "./lib";

export function run() {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as { session_id?: string; cwd?: string };
    const cwd = projectRoot(input.cwd ?? process.cwd());
    const name = resolveName(cwd, input.session_id);
    // Always summarize (flag-agnostic): claim-first consume keeps notify/watcher concurrency safe,
    // and never skipping keeps the gate alive when a .listen flag is orphaned (watcher gone).
    const dir = inboxDir(cwd, name);
    let pending = 0;
    for (const f of readdirSync(dir).filter(f => f.endsWith(".md"))) {
      try {
        const { env, body } = parseEnvelope(readFileSync(join(dir, f), "utf8"));
        const ccTag = env.cc && env.to !== name ? " (cc)" : "";
        const line = `[flbus] ${name} inbox: from ${env.from ?? "?"} — "${env.summary ?? f}" · ${f}${ccTag}`;
        if (body.trim()) { console.log(line); pending++; continue; }
        const archive = archiveDir(cwd);
        mkdirSync(archive, { recursive: true });
        retryRename(join(dir, f), join(archive, `${Date.now()}-${f}`));
        console.log(`${line} (summary-only — delivered)`);
      } catch { /* file vanished mid-loop (watcher won) or unreadable — skip; next prompt re-surfaces */ }
    }
    if (pending) console.log(`[flbus] receive: flbus get all (or get <file>)`);
  } catch {
    // a failed notice must never break the user's prompt
  }
  process.exit(0);
}
