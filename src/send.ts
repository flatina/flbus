// `flbus send --to <name> --summary "<one line>"`
//   [--subject "<topic>"] [--cc <a,b>] [--from <name>] [--body-file <path> | --body "<text>" | --body-stdin]
// `flbus send --recall --to <name> [--cc <a,b>] [--subject <s> | --summary <s>] [--from <name>]`
// --body-stdin reads the body from stdin — feed it a single-quoted heredoc / here-string so the shell can't
// mangle backticks or $(...) in the content.
// Re-sending with the same --subject overwrites the same file (revision gate loop).
// --cc delivers the same message to additional inboxes; the envelope shows the full addressing.
// --recall deletes an as-yet-unread message from the recipient inbox(es); once pulled it's gone and can't be recalled.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, busDir, inboxDir, projectRoot, resolveName, ROUTES_PATH, routes, serializeEnvelope, slug, validName } from "./lib";

export function run(args: string[]) {
  const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const flag = (k: string) => args.includes(`--${k}`);

  const VALUE_OPTS = new Set(["--to", "--summary", "--subject", "--cc", "--from", "--body", "--body-file"]);
  const BOOL_OPTS = new Set(["--body-stdin", "--recall"]);
  for (let i = 0; i < args.length; i++) {
    if (VALUE_OPTS.has(args[i])) { i++; continue; }
    if (!BOOL_OPTS.has(args[i])) { console.error(`unknown argument: ${args[i]}`); process.exit(1); }
  }

  const cwd = projectRoot(process.cwd());
  const to = opt("to");
  if (!to) { console.error("required: --to"); process.exit(1); }
  const from = opt("from") ?? resolveName(cwd);
  const summary = opt("summary");
  const ident = opt("subject") ?? summary; // names the file, shared by send and recall

  // Recipient resolution: same-project endpoint first, then the routing table
  function projectOf(name: string): string {
    if (!validName(name)) { console.error(`invalid recipient name '${name}' — letters/digits/._- only`); process.exit(1); }
    if (existsSync(join(busDir(cwd), name))) return cwd;
    const r = routes();
    if (!r[name]) {
      console.error(`recipient '${name}' not found: no same-folder endpoint, not in routing table.`);
      console.error(`known routes: ${Object.keys(r).join(", ") || "(none)"}`);
      console.error(`make a same-folder endpoint with \`flbus endpoint create ${name}\`, or register a route.`);
      process.exit(1);
    }
    if (!existsSync(r[name].dir)) {
      console.error(`route '${name}' → ${r[name].dir} does not exist. Update the routes table (${ROUTES_PATH}).`);
      process.exit(1);
    }
    return r[name].dir;
  }

  const cc = (opt("cc") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  // resolve every recipient before touching anything — no partial deliveries/recalls
  const targets = [{ name: to, project: projectOf(to) }];
  for (const n of cc) targets.push({ name: n, project: projectOf(n) });

  if (!ident) { console.error("required: --subject or --summary"); process.exit(1); }
  const fname = `from-${slug(from)}--${slug(ident)}.md`;

  if (flag("recall")) {
    for (const t of targets) {
      const file = join(inboxDir(t.project, t.name), fname);
      // delete is the claim: success means we won the race; ENOENT means already pulled or never there
      try { rmSync(file); console.log(`recalled from ${t.name}: ${fname}`); }
      catch { console.log(`nothing to recall from ${t.name} — already read or never there: ${fname}`); }
    }
    process.exit(0);
  }

  if (!summary) { console.error("required: --summary"); process.exit(1); }
  const bodyFile = opt("body-file");
  const body = flag("body-stdin") ? readFileSync(0, "utf8") : bodyFile ? readFileSync(bodyFile, "utf8") : (opt("body") ?? "");
  const env = { from, to, summary, ...(cc.length ? { cc: cc.join(", ") } : {}) };
  for (const t of targets) {
    const file = join(inboxDir(t.project, t.name), fname);
    atomicWrite(file, serializeEnvelope(env, body));
    console.log(`sent: ${file}`);
  }

  if (!body.trim()) console.log(`summary-only (no body): the recipient's notice line delivers it — no pull will happen`);
}
