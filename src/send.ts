// `flbus send --to <addr> --summary "<one line>" [--subject <s>] [--cc <a,b>] [--from <name>] [--body <t>|--body-file <p>|--body-stdin]`
// `flbus send --recall --to <addr> [--cc <a,b>] [--subject <s>|--summary <s>] [--from <name>]`
// <addr>: `peer` | `peer:mailbox` | `here:mailbox` | `project[:mailbox]@node` (a configured net node).
// Delivery is append-only everywhere — re-sending a subject delivers another message. A remote send
// queues in the outbox and returns; failures come back as messages in the sender's inbox.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  archivePartition, busDir, depositMessage, inboxDir, localPeers, parseAddress, parseEnvelope, peerFor, peers,
  PEERS_PATH, projectRoot, resolveName, retryRename, validName, type Envelope,
} from "./lib";
import { BODY_CAP, LINE_CAP, foldName, loadNet, mintId, nextHop, outboxAdd, outboxList, recallNew, type Msg, type NetConfig } from "./remote/net";
import { ensure } from "./remote/daemon";

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
  const ident = opt("subject") ?? summary;

  type Target =
    | { kind: "local"; dir: string; mailbox: string }
    | { kind: "remote"; node: string; project: string; mailbox: string };
  let net: NetConfig | undefined | null = null; // lazy; null = unloaded
  const netCfg = (): NetConfig => {
    if (net === null) { try { net = loadNet(); } catch (e) { console.error(`${(e as Error).message}`); process.exit(1); } }
    if (!net) { console.error(`no net config (~/.flbus/net.json) — remote addressing needs this node set up first`); process.exit(1); }
    return net;
  };
  function resolveTarget(addr: string): Target {
    const { project, mailbox, host } = parseAddress(addr);
    if (!project) { console.error(`bad address '${addr}': need a peer, 'here:', or 'project@node'`); process.exit(1); }
    const mb = mailbox ?? project; // default mailbox = the project's own name
    if (!validName(project) || !validName(mb)) { console.error(`invalid name in '${addr}' -- letters/digits/._- only`); process.exit(1); }

    if (host !== undefined) {
      if (!validName(host)) { console.error(`invalid node name in '${addr}'`); process.exit(1); }
      const cfg = netCfg();
      if (!nextHop(cfg, host)) { console.error(`no route to node '${host}': not a configured peer and no hub is set (net.json)`); process.exit(1); }
      return { kind: "remote", node: host, project, mailbox: mb };
    }
    if (project === "here") {
      if (!mailbox) { console.error(`'here:' needs a mailbox name -- e.g. 'here:main'`); process.exit(1); }
      if (!existsSync(join(busDir(cwd), mailbox))) { console.error(`no local mailbox '${mailbox}' here -- 'flbus claim ${mailbox}' to receive as it`); process.exit(1); }
      return { kind: "local", dir: cwd, mailbox };
    }
    const entry = peers()[project];
    if (entry && (entry as { host?: string }).host) {
      console.error(`peer '${project}' uses the removed ssh transport — register the machine as a net node and address it as ${project}@<node>`);
      process.exit(1);
    }
    const local = localPeers()[project];
    if (!local?.dir) {
      console.error(`no peer '${project}': not in the peer table. 'flbus peer add ${project} <dir>', or 'here:${project}' / 'project@node'.`);
      console.error(`known peers: ${Object.keys(peers()).join(", ") || "(none)"}`);
      process.exit(1);
    }
    if (!existsSync(local.dir)) { console.error(`peer '${project}' -> ${local.dir} does not exist. Update the peer table (${PEERS_PATH}).`); process.exit(1); }
    if (!existsSync(join(busDir(local.dir), mb))) { console.error(`peer '${project}' has no mailbox '${mb}' -- it must 'flbus register'/'flbus claim' first (no phantom create).`); process.exit(1); }
    return { kind: "local", dir: local.dir, mailbox: mb };
  }

  const cc = (opt("cc") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  // resolve every recipient before touching anything -- no partial deliveries/recalls
  const targets = [to, ...cc].map(addr => ({ addr, r: resolveTarget(addr) }));

  if (!ident) { console.error("required: --subject or --summary"); process.exit(1); }
  const anyRemote = targets.some(t => t.r.kind === "remote");

  // A remote reply must resolve on this machine: the sending project must be self-registered.
  let replyTo: { project: string; mailbox: string } | undefined;
  if (anyRemote) {
    const pf = peerFor(cwd);
    if (!pf) { console.error("remote send needs this project self-registered so replies can reach it -- run `flbus register` here first"); process.exit(1); }
    replyTo = { project: pf.name, mailbox: resolveName(cwd) };
  }

  if (flag("recall")) return recall(targets, ident, netCfg);

  if (!summary) { console.error("required: --summary"); process.exit(1); }
  const bodyFile = opt("body-file");
  const body = flag("body-stdin") ? readFileSync(0, "utf8") : bodyFile ? readFileSync(bodyFile, "utf8") : (opt("body") ?? "");
  if (Buffer.byteLength(body, "utf8") > BODY_CAP) { console.error(`body exceeds the ${Math.round(BODY_CAP / 1024)}KB cap — send a file path or split it`); process.exit(1); }
  const ccStr = cc.length ? cc.join(", ") : undefined;
  const sentIso = new Date().toISOString();

  let queuedRemote = false;
  for (const { r } of targets) {
    if (r.kind === "local") {
      const env: Envelope = { from, to, summary, ...(opt("subject") ? { subject: opt("subject") } : {}), sent: sentIso, ...(ccStr ? { cc: ccStr } : {}) };
      const pseudo = { origin: "", dest: "", project: r.mailbox, mailbox: r.mailbox, replyTo: { project: from, mailbox: from }, summary, subject: opt("subject"), cc: ccStr, body };
      const file = depositMessage(r.dir, r.mailbox, env, body, mintId(pseudo));
      console.log(`sent: ${file}`);
      continue;
    }
    const cfg = netCfg();
    const m: Omit<Msg, "id"> = {
      origin: cfg.node, dest: r.node, project: r.project, mailbox: r.mailbox,
      replyTo: replyTo!, summary, ...(opt("subject") ? { subject: opt("subject") } : {}), ...(ccStr ? { cc: ccStr } : {}), body,
    };
    const msg: Msg = { id: mintId(m), ...m };
    // the wire unit is the serialized line — JSON escaping can inflate a within-cap body past LINE_CAP,
    // and an over-cap entry would flap the link from the head of its queue instead of failing here, loudly
    if (Buffer.byteLength(JSON.stringify({ type: "msg", ...msg }), "utf8") + 1 > LINE_CAP) {
      console.error(`message serializes past the ${LINE_CAP >> 20}MiB wire cap (escaping inflates it) — shorten the body/summary or send a file path`);
      process.exit(1);
    }
    const res = outboxAdd(msg);
    if (res === "outbox-full") { console.error(`outbox full (${msg.id} not queued) — the network is down or a destination is stalled; \`flbus remote status\` / \`flbus remote giveup\``); process.exit(1); }
    console.log(`${res === "already-queued" ? "already queued" : "queued"} ${msg.id} -> ${r.project}:${r.mailbox}@${r.node}`);
    queuedRemote = true;
  }

  if (queuedRemote) {
    // an acknowledged enqueue must never wait in silence: say it loudly when nothing will deliver
    const st = ensure();
    if (st === "disabled") console.error(`WARNING: queued, but the daemon is DISABLED — nothing delivers until \`flbus remote daemon enable\``);
    else if (st === "inactive") console.error(`WARNING: queued, but net.json is missing/inactive — nothing will deliver`);
    else if (st === "spawn-failed") console.error(`WARNING: queued, but the daemon could not be started — check ${"`flbus remote status`"} and the daemon log`);
    console.log(`delivery is async; a failure or delay lands in your inbox as a message`);
  }
  if (!body.trim()) console.log(`summary-only (no body): the recipient's notice line delivers it -- no pull will happen`);
}

// Recall is local: the outbox and local inboxes only. Only never-transmitted outbox entries are removable;
// local inbox recalls ARCHIVE the message (the archive is the dedup index). Matches the persisted subject.
function recall(
  targets: { addr: string; r: { kind: "local"; dir: string; mailbox: string } | { kind: "remote"; node: string; project: string; mailbox: string } }[],
  ident: string,
  netCfg: () => NetConfig,
) {
  for (const { addr, r } of targets) {
    if (r.kind === "local") {
      const dir = inboxDir(r.dir, r.mailbox);
      let hit = 0;
      const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".md")) : [];
      for (const f of files) {
        try {
          const { env } = parseEnvelope(readFileSync(join(dir, f), "utf8"));
          if ((env.subject ?? env.summary) !== ident) continue;
          const part = archivePartition(r.dir);
          mkdirSync(part, { recursive: true });
          retryRename(join(dir, f), join(part, `${Date.now()}-recalled-${f}`));
          hit++; console.log(`recalled from ${addr}: ${f}`);
        } catch {}
      }
      if (!hit) console.log(`nothing to recall from ${addr} -- already read or never there`);
      continue;
    }
    // remote target: the outbox is the reach of recall; in-flight entries are not recallable
    const cfg = netCfg();
    let hit = 0;
    for (const e of outboxList()) {
      const m = e.msg;
      if (foldName(m.origin) !== foldName(cfg.node) || foldName(m.dest) !== foldName(r.node)) continue;
      if (m.project !== r.project || m.mailbox !== r.mailbox) continue;
      if ((m.subject ?? m.summary) !== ident) continue;
      // winning the rename out of new/ IS the claim — a concurrent markSent may beat us, then it's in flight
      if (e.state === "new" && recallNew(m.id)) { hit++; console.log(`recalled from ${addr}: ${m.id} (never transmitted)`); }
      else { hit++; console.log(`${m.id} is in flight — not recallable; it may already be delivered (\`flbus remote giveup ${m.id}\` to abandon waiting)`); }
    }
    if (!hit) console.log(`nothing to recall for ${addr} -- possibly already delivered`);
  }
  process.exit(0);
}
