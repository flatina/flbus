// Usage: bun ship.ts — release one flbus version: bump package.json + plugin.json in lockstep,
// publish the core to npm, refresh the Claude Code plugin snapshot. (Dev tool; bun-only.)
import { $ } from "bun";
import { join } from "node:path";
import { atomicWrite, readJson } from "./lib";

const ROOT = join(import.meta.dir, "..");
const PKG_JSON = join(ROOT, "package.json");
const PLUGIN_JSON = join(ROOT, "adapters", "claude-code", ".claude-plugin", "plugin.json");

const pkg = readJson<{ version: string } & Record<string, unknown>>(PKG_JSON, { version: "" });
const manifest = readJson<{ version: string } & Record<string, unknown>>(PLUGIN_JSON, { version: "" });
if (!pkg.version) { console.error(`no version in ${PKG_JSON}`); process.exit(1); }
// Lockstep invariant: the two manifests are one "flbus" version. Refuse to ship if they already diverged.
if (pkg.version !== manifest.version) {
  console.error(`version drift: package.json ${pkg.version} ≠ plugin.json ${manifest.version} — reconcile first`);
  process.exit(1);
}

const [maj, min, pat] = pkg.version.split(".").map(Number);
const next = `${maj}.${min}.${pat + 1}`;
atomicWrite(PKG_JSON, JSON.stringify({ ...pkg, version: next }, null, 2) + "\n");
atomicWrite(PLUGIN_JSON, JSON.stringify({ ...manifest, version: next }, null, 2) + "\n");
console.log(`version: ${pkg.version} → ${next} (package.json + plugin.json)`);

await $`npm publish`;                      // core → npm @flatina/flbus (auth in ~/.npmrc, public since 0.1.0; `prepare` builds dist)
await $`claude plugin update flbus@flatina`; // refresh the marketplace snapshot OSS users pull
