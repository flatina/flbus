// Statusline segment: inbox count + read hint. Prints nothing when the inbox is empty.
import { readdirSync, readFileSync } from "node:fs";
import { inboxDir, projectRoot, resolveName } from "./lib";

export function run() {
  let input: { session_id?: string; cwd?: string; workspace?: { current_dir?: string } } = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  // start from the working dir like every other entry point; projectRoot anchors it consistently
  const cwd = projectRoot(input.workspace?.current_dir ?? input.cwd ?? process.cwd());
  try {
    const n = readdirSync(inboxDir(cwd, resolveName(cwd, input.session_id))).filter(f => f.endsWith(".md")).length;
    if (n > 0) console.log(`📬 flbus ${n} — /flbus:recv to read`);
  } catch {
    // no inbox dir = empty segment
  }
}
