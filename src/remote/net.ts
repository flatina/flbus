// v9 remote transport core: node/peer config, message identity, the outbox, terminal reports.
// Transport rule: never silently wrong; loudly imperfect is fine. Anomalies become visible messages.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  DAEMON_LOCK_PATH, DAEMON_STATUS_PATH, FLBUS_HOME, RESERVED, busDir, depositMessage, localPeers, readJson, retryRename, validName, type Envelope,
} from "../lib";

// Daemon liveness — one predicate shared by status, doctor, and `remote status`. The daemon rewrites its
// status snapshot (with its own pid) every few seconds; a lock pid that matches a fresh snapshot pid is the
// live daemon, so a recycled pid can't read as running. EPERM from kill(pid,0) means alive (foreign owner).
export const STATUS_TTL_MS = 180_000;
export function daemonLive(): number | undefined {
  let pid = 0;
  try { pid = Number((readFileSync(DAEMON_LOCK_PATH, "utf8").split(/\r?\n/)[0] || "").trim()); } catch { return undefined; }
  if (!pid) return undefined;
  const snap = readJson<{ pid?: number; at?: number }>(DAEMON_STATUS_PATH, {});
  if (snap.pid !== pid || typeof snap.at !== "number" || Date.now() - snap.at >= STATUS_TTL_MS) return undefined;
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") return undefined; }
  return pid;
}

// ---- protocol constants ----
export const WIRE_V = 1;
export const LINE_CAP = 1 << 20;          // one NDJSON packet
export const BODY_CAP = 256 * 1024;
export const NOTICE_MS = 10 * 60_000;     // delay notice: "still undelivered after T"
export const GIVE_UP_MS = 3 * 24 * 3600_000;
export const RETENTION_MS = 30 * 24 * 3600_000; // archive/dedup window; give-up sits well inside it
export const OUTBOX_CAP = 1000;           // entries, checked synchronously at send (a bound, not an invariant)
export const INBOX_CAP = { count: 200, bytes: 32 * 1024 * 1024 };
export const UNDELIVERABLE_CAP = 500;

// ---- node + peer configuration (~/.flbus/net.json, hand-edited; ops doc has the shape) ----

export type NetPeer = { address: string; pins: string[]; token: string; hub?: boolean };
export type NetConfig = {
  node: string;
  mode?: "manual" | "always";
  hub?: boolean;                                     // this node forwards spoke↔spoke traffic
  hubNode?: string;                                  // accept-only spokes: the inbound peer trusted as hub (and default route)
  accept?: { port: number; host?: string; cert: string; key: string; tokens: Record<string, string> };
  peers?: Record<string, NetPeer>;
};
export const NET_PATH = join(FLBUS_HOME, "net.json");

// Fail closed: a config that would accept without a token or connect without a pin is an error, not a default.
export function loadNet(): NetConfig | undefined {
  if (!existsSync(NET_PATH)) return undefined;
  let cfg: NetConfig;
  try { cfg = JSON.parse(readFileSync(NET_PATH, "utf8")); } catch (e) { throw new Error(`net.json: unparseable JSON: ${e}`); }
  const badName = (n: string) => !validName(n) || RESERVED.has(foldName(n));
  if (!cfg.node || badName(cfg.node)) throw new Error(`net.json: 'node' must be a bare, non-reserved name`);
  if (cfg.mode && cfg.mode !== "manual" && cfg.mode !== "always") throw new Error(`net.json: mode must be manual|always`);
  if (cfg.accept) {
    const a = cfg.accept;
    if (!a.port || !a.cert || !a.key) throw new Error(`net.json: accept needs port, cert, key`);
    const tokens = Object.entries(a.tokens ?? {});
    if (!tokens.length) throw new Error(`net.json: accept.tokens is empty — refusing to accept without client tokens`);
    const seen = new Set<string>();
    for (const [n, t] of tokens) {
      if (badName(n)) throw new Error(`net.json: accept.tokens has invalid node name '${n}'`);
      if (!t) throw new Error(`net.json: empty token for '${n}'`);
      if (seen.has(t)) throw new Error(`net.json: duplicate token (tokens must be unique per peer)`);
      seen.add(t);
    }
  }
  if (cfg.hubNode && badName(cfg.hubNode)) throw new Error(`net.json: invalid hubNode '${cfg.hubNode}'`);
  let hubs = 0;
  for (const [n, p] of Object.entries(cfg.peers ?? {})) {
    if (badName(n)) throw new Error(`net.json: invalid peer node name '${n}'`);
    if (foldName(n) === foldName(cfg.node)) throw new Error(`net.json: peer '${n}' is this node itself`);
    if (!p.address) throw new Error(`net.json: peer '${n}' has no address`);
    if (!p.pins?.length || p.pins.some(x => !x)) throw new Error(`net.json: peer '${n}' has an empty pin set — refusing to connect unpinned`);
    if (!p.token) throw new Error(`net.json: peer '${n}' has no token`);
    if (p.hub) hubs++;
  }
  if (hubs > 1) throw new Error(`net.json: more than one peer marked hub`);
  return cfg;
}
export const netActive = (cfg = tryNet()) => !!cfg && (!!cfg.accept || !!Object.keys(cfg.peers ?? {}).length);
export function tryNet(): NetConfig | undefined { try { return loadNet(); } catch { return undefined; } }

// The node this one trusts as its hub: an outbound peer marked `hub`, or (accept-only spokes) `hubNode`.
export const hubName = (cfg: NetConfig): string | undefined =>
  Object.keys(cfg.peers ?? {}).find(n => cfg.peers![n].hub) ?? cfg.hubNode;
// The link a delivery to `dest` goes out on — and the only link its answer is honoured from.
export const nextHop = (cfg: NetConfig, dest: string): string | undefined =>
  Object.keys(cfg.peers ?? {}).find(n => foldName(n) === foldName(dest)) ?? hubName(cfg);

// Node names compare case-folded UNCONDITIONALLY (lib's caseFold is filesystem-conditional — identity on
// Linux — which would make a config that works on Windows answer unknown-node on Linux).
export const foldName = (s: string) => s.toLowerCase();

// fingerprint256 normalization: openssl and node both print "AB:CD:…"; compare lowercased hex.
export const normPin = (p: string) => p.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
export function tokenEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

// ---- message identity ----

export type Msg = {
  id: string; origin: string; dest: string; project: string; mailbox: string;
  replyTo: { project: string; mailbox: string };
  summary: string; subject?: string; cc?: string; body: string;
};

// Canonical serialization: netstring-style `<byte-length>:<utf8>` over a fixed field order; absent
// optionals are empty; bytes as sent, no normalization. The hash covers every sender-chosen field —
// origin included (verified against the authenticated link), so two nodes can never coalesce onto one id.
export function msgHash(m: Omit<Msg, "id">): string {
  const fields = [m.origin, m.dest, m.project, m.mailbox, m.replyTo.project, m.replyTo.mailbox, m.subject ?? "", m.summary, m.cc ?? "", m.body];
  const h = createHash("sha256");
  for (const f of fields) { const b = Buffer.from(f, "utf8"); h.update(`${b.length}:`); h.update(b); }
  return h.digest("hex").slice(0, 16);
}
export const mintId = (m: Omit<Msg, "id">, ms = Date.now()) => `${ms.toString(36)}-${msgHash(m)}`;
// lowercase-only, validated on receipt; ts36 length bounds the timestamp to a sane range so a crafted id
// can't blow up Date math or squat in relay tables (8 chars ≈ 2004, 9 ≈ year 5188).
export const ID_RE = /^[0-9a-z]{8,9}-[0-9a-f]{16}$/;
export const idSendMs = (id: string) => parseInt(id.split("-")[0], 36);

// ---- outbox: the only buffer in the system ----

export const OUTBOX_DIR = join(FLBUS_HOME, "outbox");
const NEW = join(OUTBOX_DIR, "new");    // never transmitted — the only recallable state
const SENT = join(OUTBOX_DIR, "sent");  // transmitted at least once, unacked (in flight)

export type OutboxEntry = { msg: Msg; state: "new" | "sent"; path: string };

function listDir(dir: string, state: "new" | "sent"): OutboxEntry[] {
  const out: OutboxEntry[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try { out.push({ msg: JSON.parse(readFileSync(join(dir, f), "utf8")), state, path: join(dir, f) }); }
      catch { try { retryRename(join(dir, f), join(dir, `${f}.bad`)); } catch {} } // corrupt entry must not squat its id
    }
  } catch {}
  return out;
}
export function outboxList(): OutboxEntry[] {
  return [...listDir(NEW, "new"), ...listDir(SENT, "sent")].sort((a, b) => idSendMs(a.msg.id) - idSendMs(b.msg.id));
}
// Count without parsing — depth is read on every status render and send.
export const outboxDepth = () => {
  let n = 0;
  for (const d of [NEW, SENT]) { try { n += readdirSync(d).filter(f => f.endsWith(".json")).length; } catch {} }
  return n;
};

// A same-id send onto an existing entry is a no-op (its lifecycle is preserved, never reset). Written to
// a temp and renamed in — a crash mid-write must not leave a partial final that squats the id forever.
export function outboxAdd(m: Msg): "queued" | "already-queued" | "outbox-full" {
  mkdirSync(NEW, { recursive: true }); mkdirSync(SENT, { recursive: true });
  if (existsSync(join(NEW, `${m.id}.json`)) || existsSync(join(SENT, `${m.id}.json`))) return "already-queued";
  if (outboxDepth() >= OUTBOX_CAP) return "outbox-full";
  const tmp = join(OUTBOX_DIR, `${m.id}.${process.pid}.part`);
  writeFileSync(tmp, JSON.stringify(m), "utf8");
  try { retryRename(tmp, join(NEW, `${m.id}.json`)); } catch (e) { try { rmSync(tmp, { force: true }); } catch {} throw e; }
  return "queued";
}
export function outboxGet(id: string): OutboxEntry | undefined {
  for (const [dir, state] of [[SENT, "sent"], [NEW, "new"]] as const) {
    const p = join(dir, `${id}.json`);
    if (!existsSync(p)) continue;
    try { return { msg: JSON.parse(readFileSync(p, "utf8")), state, path: p }; } catch {}
  }
  return undefined;
}
// Transmission is a durable state change (atomic rename) — the untransmitted/in-flight split survives
// restart. Returns false when the claim was lost (recalled, locked, or already gone): DO NOT transmit then.
export function markSent(id: string): boolean {
  mkdirSync(SENT, { recursive: true });
  try { retryRename(join(NEW, `${id}.json`), join(SENT, `${id}.json`)); return true; }
  catch { return existsSync(join(SENT, `${id}.json`)); }
}
// Recall's exclusive counterpart of markSent: winning the rename out of new/ IS the claim; losing it
// means the daemon owns the entry (in flight) — never delete unconditionally.
export function recallNew(id: string): boolean {
  const aside = join(OUTBOX_DIR, `${id}.recalled`);
  try { retryRename(join(NEW, `${id}.json`), aside); } catch { return false; }
  try { rmSync(aside, { force: true }); } catch {}
  try { rmSync(noticedPath(id), { force: true }); } catch {}
  return true;
}
export function clearEntry(id: string) {
  for (const d of [SENT, NEW]) try { rmSync(join(d, `${id}.json`), { force: true }); } catch {}
  try { rmSync(join(OUTBOX_DIR, `${id}.noticed`), { force: true }); } catch {}
}
export const noticedPath = (id: string) => join(OUTBOX_DIR, `${id}.noticed`);
export const wasNoticed = (id: string) => existsSync(noticedPath(id));
export const markNoticed = (id: string) => { try { writeFileSync(noticedPath(id), "", "utf8"); } catch {} };

// ---- terminal reports: deposited as normal local messages, ordered report-then-clear ----

export type ReportKind = "undelivered" | "unconfirmed" | "delayed";
export const UNDELIVERABLE_DIR = join(FLBUS_HOME, "undeliverable");

// Fallback chain, sweep-less: replyTo mailbox → the project's default mailbox → undeliverable/ (counted;
// at its bound the oldest is evicted into the tally). A report is never dropped silently.
export function depositReport(m: Msg, kind: ReportKind, detail: string): string {
  const env: Envelope = {
    from: "flbus", to: `${m.replyTo.project}:${m.replyTo.mailbox}`,
    summary: `[flbus ${kind}] to ${m.project}:${m.mailbox}@${m.dest} — "${m.subject ?? m.summary}"`,
    subject: `flbus-${kind}-${m.id}`, sent: new Date().toISOString(),
  };
  const body = [
    `message: ${m.id} to ${m.project}:${m.mailbox}@${m.dest}`,
    `subject: ${m.subject ?? m.summary}`,
    `outcome: ${kind} — ${detail}`,
    kind === "unconfirmed" ? `a copy may still land; re-send only if the recipient confirms nothing arrived` : "",
  ].filter(Boolean).join("\n");
  const entry = localPeers()[m.replyTo.project];
  if (entry?.dir) {
    for (const mb of [m.replyTo.mailbox, m.replyTo.project]) {
      if (!existsSync(join(busDir(entry.dir), mb))) continue;
      // reports respect the inbox hard bound too — overflow falls through to undeliverable/, never past the cap
      if (inboxFull(join(busDir(entry.dir), mb, "inbox"), Buffer.byteLength(body, "utf8"))) continue;
      try { return depositMessage(entry.dir, mb, env, body, mintId({ ...m, ...{ origin: "", dest: "", project: m.replyTo.project, mailbox: mb, body } })); } catch {}
    }
  }
  // project gone (or both deposits failed): the flat, counted floor
  mkdirSync(UNDELIVERABLE_DIR, { recursive: true });
  const files = readdirSync(UNDELIVERABLE_DIR).filter(f => f.endsWith(".md")).sort();
  if (files.length >= UNDELIVERABLE_CAP) {
    try { rmSync(join(UNDELIVERABLE_DIR, files[0]), { force: true }); bumpEvictions(); } catch {}
  }
  const path = join(UNDELIVERABLE_DIR, `${Date.now()}-${m.id}-${kind}.md`);
  writeFileSync(path, `${env.summary}\n\n${body}\n`, "utf8");
  return path;
}
const EVICT_PATH = join(FLBUS_HOME, "undeliverable-evicted.json");
function bumpEvictions() {
  const s = readJson<{ count: number; last?: string }>(EVICT_PATH, { count: 0 });
  writeFileSync(EVICT_PATH, JSON.stringify({ count: s.count + 1, last: new Date().toISOString() }), "utf8");
}
export const evictions = () => readJson<{ count: number; last?: string }>(EVICT_PATH, { count: 0 });
export const undeliverableCount = () => { try { return readdirSync(UNDELIVERABLE_DIR).filter(f => f.endsWith(".md")).length; } catch { return 0; } };

// ---- inbox bound (receiver side): counts the incoming message too, so the cap is never exceeded ----
export function inboxFull(dir: string, incomingBytes = 0): boolean {
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".md"));
    if (files.length >= INBOX_CAP.count) return true;
    let bytes = incomingBytes;
    for (const f of files) { try { bytes += statSync(join(dir, f)).size; } catch {} }
    return bytes >= INBOX_CAP.bytes;
  } catch { return false; }
}
