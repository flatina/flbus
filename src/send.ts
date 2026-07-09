// `flbus send --to <addr> --summary "<one line>"`
//   [--subject "<topic>"] [--cc <a,b>] [--from <name>] [--body-file <path> | --body "<text>" | --body-stdin]
// `flbus send --recall --to <addr> [--cc <a,b>] [--subject <s> | --summary <s>] [--from <name>]`
// <addr> grammar: `peer` | `peer:mailbox` | `here:mailbox` | `…@host` (remote, not yet). bare peer = its default mailbox.
// --body-stdin reads the body from stdin — feed it a single-quoted heredoc / here-string so the shell can't
// mangle backticks or $(...) in the content.
// Re-sending with the same --subject overwrites the same file (revision gate loop).
// --cc delivers the same message to additional inboxes; the envelope shows the full addressing.
// --recall deletes an as-yet-unread message from the recipient inbox(es); once pulled it's gone and can't be recalled.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, busDir, inboxDir, parseAddress, peers, PEERS_PATH, projectRoot, resolveName, serializeEnvelope, slug, validName } from "./lib";

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

  // Resolve an address [project][:mailbox][@host] to a target busDir + mailbox name.
  function resolveTarget(addr: string): { dir: string; mailbox: string } {
    const { project, mailbox, host } = parseAddress(addr);
    if (host !== undefined) { console.error(`remote peers not supported yet (got '@${host}' in '${addr}')`); process.exit(1); }
    if (!project) { console.error(`bad address '${addr}': need a peer or 'here:' — e.g. 'alpha', 'alpha:main', 'here:main'`); process.exit(1); }
    if (project === "here") {
      if (!mailbox) { console.error(`'here:' needs a mailbox name — e.g. 'here:main'`); process.exit(1); }
      if (!validName(mailbox)) { console.error(`invalid mailbox name '${mailbox}' — letters/digits/._- only`); process.exit(1); }
      if (!existsSync(join(busDir(cwd), mailbox))) {
        console.error(`no local mailbox '${mailbox}' here — 'flbus claim ${mailbox}' to receive as it, or 'flbus mailbox add ${mailbox}' to make it for another session`);
        process.exit(1);
      }
      return { dir: cwd, mailbox };
    }
    const r = peers();
    if (!r[project]) {
      console.error(`no peer '${project}': not in the peer table. 'flbus peer add ${project} <dir>', or for a same-folder mailbox use 'here:${project}'.`);
      console.error(`known peers: ${Object.keys(r).join(", ") || "(none)"}`);
      process.exit(1);
    }
    if (!existsSync(r[project].dir)) { console.error(`peer '${project}' → ${r[project].dir} does not exist. Update the peer table (${PEERS_PATH}).`); process.exit(1); }
    const mb = mailbox ?? project; // bare peer addresses its default mailbox (named after the project)
    if (!validName(mb)) { console.error(`invalid mailbox name '${mb}' — letters/digits/._- only`); process.exit(1); }
    return { dir: r[project].dir, mailbox: mb };
  }

  const cc = (opt("cc") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  // resolve every recipient before touching anything — no partial deliveries/recalls
  const targets = [{ addr: to, ...resolveTarget(to) }];
  for (const a of cc) targets.push({ addr: a, ...resolveTarget(a) });

  if (!ident) { console.error("required: --subject or --summary"); process.exit(1); }
  const fname = `from-${slug(from)}--${slug(ident)}.md`;

  if (flag("recall")) {
    for (const t of targets) {
      const file = join(inboxDir(t.dir, t.mailbox), fname);
      // delete is the claim: success means we won the race; ENOENT means already pulled or never there
      try { rmSync(file); console.log(`recalled from ${t.addr}: ${fname}`); }
      catch { console.log(`nothing to recall from ${t.addr} — already read or never there: ${fname}`); }
    }
    process.exit(0);
  }

  if (!summary) { console.error("required: --summary"); process.exit(1); }
  const bodyFile = opt("body-file");
  const body = flag("body-stdin") ? readFileSync(0, "utf8") : bodyFile ? readFileSync(bodyFile, "utf8") : (opt("body") ?? "");
  const env = { from, to, summary, ...(cc.length ? { cc: cc.join(", ") } : {}) };
  for (const t of targets) {
    const file = join(inboxDir(t.dir, t.mailbox), fname);
    atomicWrite(file, serializeEnvelope(env, body));
    console.log(`sent: ${file}`);
  }

  if (!body.trim()) console.log(`summary-only (no body): the recipient's notice line delivers it — no pull will happen`);
}
