// UserPromptSubmit hook: one-line inbox summaries (never injects bodies) + a cheap daemon `ensure` (spawn/renew).
// Summary-only messages (empty body) are fully delivered by the notice line: archived here, no pull needed.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { archivePartition, inboxDir, out, parseAddress, parseEnvelope, projectRoot, resolveName, retryRename } from "./lib";
import { ensure } from "./remote/daemon";

export function run() {
  try {
    // The hook payload identifies the session; without a valid one we cannot know which mailbox is ours,
    // and archiving a summary-only message from the wrong (fallback) mailbox would steal a co-located
    // session's mail. So a bad/absent payload skips the scan entirely (breadcrumb to stderr for hand-testing).
    let input: { session_id?: string; cwd?: string } | null = null;
    try { const p = JSON.parse(readFileSync(0, "utf8")); if (p && typeof p === "object") input = p; } catch {}
    if (!input) console.error("[flbus] notify: no/invalid hook payload on stdin — inbox scan skipped");
    else {
      const cwd = projectRoot(input.cwd ?? process.cwd());
      const name = resolveName(cwd, input.session_id);
      const dir = inboxDir(cwd, name);
      let pending = 0;
      for (const f of readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
        try {
          const { env, body } = parseEnvelope(readFileSync(join(dir, f), "utf8"));
          const a = env.to ? parseAddress(env.to) : {};
          const ccTag = env.cc && (a.mailbox ?? a.project) !== name ? " (cc)" : "";
          const line = `[flbus] ${name} inbox: from ${env.from ?? "?"} — "${env.summary ?? f}" · ${f}${ccTag}`;
          if (body.trim()) { out(`${line}\n`); pending++; continue; }
          const archive = archivePartition(cwd); // partitioned, so a remote retry still finds its dedup witness
          mkdirSync(archive, { recursive: true });
          retryRename(join(dir, f), join(archive, `${Date.now()}-${f}`));
          out(`${line} (summary-only — delivered)\n`);
        } catch { /* file vanished mid-loop (watcher won) or unreadable — skip; next prompt re-surfaces */ }
      }
      if (pending) out(`[flbus] receive: flbus take all (or take <file>)\n`);
    }
  } catch {
    // a failed notice must never break the user's prompt
  }
  try { ensure(); } catch { /* daemon ensure is best-effort — never blocks the prompt */ }
  process.exit(0);
}
