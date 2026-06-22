// Usage: bun ship.ts — bump patch version and run `claude plugin update`
import { $ } from "bun";
import { join } from "node:path";
import { atomicWrite, readJson } from "./lib";

const PLUGIN_JSON = join(import.meta.dir, "..", "adapters", "claude-code", ".claude-plugin", "plugin.json");
const manifest = readJson<{ version: string } & Record<string, unknown>>(PLUGIN_JSON, { version: "" });
if (!manifest.version) { console.error(`no version in ${PLUGIN_JSON}`); process.exit(1); }

const [maj, min, pat] = manifest.version.split(".").map(Number);
const next = `${maj}.${min}.${pat + 1}`;
atomicWrite(PLUGIN_JSON, JSON.stringify({ ...manifest, version: next }, null, 2) + "\n");
console.log(`version: ${manifest.version} → ${next}`);

await $`claude plugin update flbus@flatina`;
