// `flbus remote daemon` — the v9 TLS transport daemon: one per node. Delivers the outbox over persistent
// links (end-to-end acked), accepts + deposits inbound messages gated (never consuming), relays spoke↔spoke
// traffic when this node is the hub, and turns every terminal outcome into a deposited report.
// `ensure` (bare verb, run from hooks and `send`) renews a lease + spawns; single-instance via linkSync lock.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, linkSync, readdirSync, renameSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:tls";
import {
  FLBUS_HOME, NO_DAEMON_PATH, DAEMON_LOG_PATH, DAEMON_LOCK_PATH, DAEMON_LEASE_PATH, DAEMON_STATUS_PATH,
  archiveDir, atomicWrite, busDir, depositMessage, idWitnessed, inboxDir, localPeers, pidMatches, readFlag, readJson, validName, type Envelope,
} from "../lib";
import {
  BODY_CAP, GIVE_UP_MS, ID_RE, NOTICE_MS, RETENTION_MS,
  clearEntry, depositReport, evictions, foldName, hubName, idSendMs, inboxFull, loadNet, markNoticed, markSent, msgHash, netActive,
  outboxGet, outboxList, undeliverableCount, wasNoticed, nextHop, type Msg, type NetConfig,
} from "./net";
import { acceptServer, dial, type Link, type Packet } from "./link";

const TTL_MS = 30 * 60_000;
const LEASE_CHECK_MS = 60_000;              // housekeeping + self-exit poll
const STATUS_TTL_MS = 3 * LEASE_CHECK_MS;   // snapshot older than this = daemon gone/hung
const LOG_MAX = 5 * 1024 * 1024;
const BACKOFF_MIN = 1000, BACKOFF_MAX = 60_000;
const HEALTHY_MS = 60_000;                  // a connection up this long resets its backoff
const DELIVER_MS = 2_000;                   // outbox sweep cadence
const RETRY_MS = 30_000;                    // re-transmit an unacked entry at most this often
const INFLIGHT_PER_EGRESS = 64;             // hub in-flight table bound (per egress link)
const PRUNE_MS = 6 * 3600_000;              // archive retention sweep

// Terminal-undelivered reasons: no byte reached an inbox. Anything else the origin daemon retries silently.
const TERMINAL = new Set(["unknown-node", "invalid", "unregistered-mailbox", "inbox-full"]);

const isDaemonPid = (pid: number) => pidMatches(pid, /(?=[\s\S]*flbus)(?=[\s\S]*\bdaemon\b)/i);
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const now = () => Date.now();
const stamp = () => new Date().toISOString();
const log = (m: string) => { try { console.log(`${stamp()} ${m}`); } catch {} };
const ago = (ts?: number) => (ts ? `${Math.round((now() - ts) / 1000)}s ago` : "never");

export function run(args: string[]) {
  switch (args[0]) {
    case undefined: return void ensure();
    case "run": return runDaemon();
    case "status": return status();
    case "stop": return stop();
    case "disable": return disable();
    case "enable": return enable();
    default: console.error("usage: flbus remote daemon [status|stop|disable|enable|run]"); process.exit(1);
  }
}

// ---- lease + lock ----
export function touchLease() { mkdirSync(FLBUS_HOME, { recursive: true }); writeFileSync(DAEMON_LEASE_PATH, `${now() + TTL_MS}\n`, "utf8"); }
function leaseExpiry(): number { try { return Number(readFileSync(DAEMON_LEASE_PATH, "utf8").trim()) || 0; } catch { return 0; } }
function lockPid(): number | undefined { try { const p = Number((readFileSync(DAEMON_LOCK_PATH, "utf8").split(/\r?\n/)[0] || "").trim()); return p || undefined; } catch { return undefined; } }
// Hard-link a pid temp into place (EEXIST if held; never observable empty, so a racer can't misread it as
// stale). A dead pid is reclaimed by renaming the stale lock aside -- one racer wins the rename.
function acquireLock(): boolean {
  mkdirSync(FLBUS_HOME, { recursive: true });
  const tmp = `${DAEMON_LOCK_PATH}.${process.pid}.tmp`;
  try { writeFileSync(tmp, `${process.pid}\n`, "utf8"); } catch { return false; }
  try {
    for (let i = 0; i < 5; i++) {
      try { linkSync(tmp, DAEMON_LOCK_PATH); return true; }
      catch (e) {
        // non-EEXIST (a filesystem without hard links) must fail the acquire, not throw out of runDaemon —
        // an uncaught throw here plus ensure's respawns is a permanent spawn storm
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") { log(`lock: ${(e as Error).message}`); return false; }
        const pid = lockPid();
        if (pid && pid !== process.pid && isDaemonPid(pid)) return false;
        try { renameSync(DAEMON_LOCK_PATH, `${DAEMON_LOCK_PATH}.reclaim`); rmSync(`${DAEMON_LOCK_PATH}.reclaim`, { force: true }); } catch {}
      }
    }
    return false;
  } finally { try { rmSync(tmp, { force: true }); } catch {} }
}
function snapFresh(pid: number): boolean {
  const s = readJson<any>(DAEMON_STATUS_PATH, null);
  return !!s && s.pid === pid && typeof s.at === "number" && now() - s.at < STATUS_TTL_MS;
}

// ---- ensure (cheap; no network) ----
// Returns what `send` must say out loud: an acknowledged enqueue must never wait in silence.
export function ensure(): "running" | "spawned" | "spawn-failed" | "disabled" | "inactive" {
  if (existsSync(NO_DAEMON_PATH)) return "disabled";                   // durable kill-switch
  if (!netActive()) return "inactive";                                 // accept-only nodes count as active
  touchLease();
  const pid = lockPid();
  if (pid && isAlive(pid) && snapFresh(pid)) return "running";         // optimization only; the lock is authority
  return spawnDaemon() ? "spawned" : "spawn-failed";
}
function rotateLog() { try { if (statSync(DAEMON_LOG_PATH).size > LOG_MAX) renameSync(DAEMON_LOG_PATH, `${DAEMON_LOG_PATH}.1`); } catch {} }
function spawnDaemon(): boolean {
  const entry = process.argv[1]; // JS entry, not the .cmd shim
  if (!entry) return false;
  rotateLog();
  let fd: number; try { fd = openSync(DAEMON_LOG_PATH, "a"); } catch { return false; }
  try {
    const child = spawn(process.execPath, [entry, "remote", "daemon", "run"], { detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
    child.on("error", () => {}); // async spawn failure must not become the CALLER's uncaught exception
    child.unref();
    return child.pid !== undefined;
  } catch { return false; }
  finally { try { closeSync(fd); } catch {} }
}

// ---- daemon process ----

type PeerState = { link?: Link; timer?: ReturnType<typeof setTimeout>; backoffMs: number; connectedAt?: number };

function runDaemon() {
  process.title = "flbus-daemon";
  if (existsSync(NO_DAEMON_PATH)) { log("disabled -- not starting"); process.exit(0); }
  let cfg: NetConfig;
  try { const c = loadNet(); if (!c) { log("no net.json -- exiting"); process.exit(0); } cfg = c; }
  catch (e) { log(`net.json invalid: ${(e as Error).message} -- exiting`); process.exit(1); }
  if (!acquireLock()) { log("another daemon owns the lock -- exiting"); process.exit(0); }

  const startedAt = now();
  log(`start pid=${process.pid} node=${cfg.node}${cfg.hub ? " (hub)" : ""}${cfg.accept ? ` accept :${cfg.accept.port}` : ""} peers=[${Object.keys(cfg.peers ?? {}).join(",")}]`);

  const links = new Map<string, Link>();                       // foldName(node) -> live link
  const peersState = new Map<string, PeerState>();             // outbound connectors
  const inflight = new Map<string, { ingress: string; egress: string; at: number }>();
  const lastAttempt = new Map<string, number>();
  let droppedAnswers = 0;
  let server: Server | undefined;
  let stopping = false;

  const linkFor = (node: string) => { const l = links.get(foldName(node)); return l && !l.isClosed() ? l : undefined; };
  const egressCount = (node: string) => { let n = 0; for (const e of inflight.values()) if (foldName(e.egress) === foldName(node)) n++; return n; };

  const cleanup = () => {
    if (stopping) return; stopping = true;
    try { server?.close(); } catch {}
    for (const l of links.values()) l.close("daemon exiting");
    for (const s of peersState.values()) if (s.timer) clearTimeout(s.timer);
    try { if (lockPid() === process.pid) rmSync(DAEMON_LOCK_PATH, { force: true }); } catch {}
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(sig, () => { log(`${sig} -- exiting`); cleanup(); process.exit(0); });

  // ---- deposit (receiving end): validate → verify hash → dedup → recipient checks → deposit+fsync → ack ----
  // Dedup precedes the recipient checks: a retry of a delivered message whose mailbox has since vanished
  // must re-ack, not err. A dedup hit still acks — the one line of law.
  function depositRemote(m: Msg): "ok" | "dup" | "unregistered-mailbox" | "inbox-full" | "deposit-retry" {
    const entry = localPeers()[m.project];
    if (entry?.dir && idWitnessed(entry.dir, m.mailbox, m.id)) return "dup";
    if (!entry?.dir || !existsSync(join(busDir(entry.dir), m.mailbox))) return "unregistered-mailbox";
    if (inboxFull(inboxDir(entry.dir, m.mailbox))) return "inbox-full";
    const mbPart = m.replyTo.mailbox !== m.replyTo.project ? `:${m.replyTo.mailbox}` : "";
    const env: Envelope = {
      from: `${m.replyTo.project}${mbPart}@${m.origin}`,
      to: `${m.project}:${m.mailbox}`,
      summary: m.summary,
      ...(m.subject ? { subject: m.subject } : {}),
      sent: new Date(idSendMs(m.id)).toISOString(),
      ...(m.cc ? { cc: m.cc } : {}),
    };
    try { depositMessage(entry.dir, m.mailbox, env, m.body, m.id, true); return "ok"; }
    catch (e) { log(`deposit ${m.id} failed (will be retried by origin): ${(e as Error).message}`); return "deposit-retry"; }
  }

  function validMsg(m: Msg): boolean {
    if (![m.origin, m.dest, m.project, m.mailbox, m.replyTo?.project, m.replyTo?.mailbox].every(v => typeof v === "string" && validName(v))) return false;
    if (typeof m.id !== "string" || !ID_RE.test(m.id)) return false;   // lowercase-only ids, sane ts range
    const ts = idSendMs(m.id);
    if (!Number.isFinite(ts) || ts <= 0 || ts > now() + 3 * 24 * 3600_000) return false; // future ids are junk (skew ≪ 3d)
    // every optional must be absent or a string, or hashing/slugging would THROW — and a handler throw
    // sends no answer at all, turning a malformed packet into a 3-day retry ending in `unconfirmed`
    if (m.subject !== undefined && typeof m.subject !== "string") return false;
    if (m.cc !== undefined && typeof m.cc !== "string") return false;
    if (typeof m.summary !== "string" || typeof m.body !== "string" || Buffer.byteLength(m.body, "utf8") > BODY_CAP) return false;
    return msgHash(m) === m.id.split("-")[1];                          // same id ⇒ same content, enforced
  }

  function handleMsg(link: Link, m: Msg) {
    const answer = (p: Packet) => { try { link.send(p); } catch { droppedAnswers++; } }; // err never generates err
    if (!validMsg(m)) return answer({ type: "err", id: typeof m?.id === "string" ? m.id.slice(0, 64) : "invalid", reason: "invalid" });
    const fromLink = foldName(m.origin) === foldName(link.node);
    if (foldName(m.dest) === foldName(cfg.node)) {
      // origin is claimed inside the hash and verified against the authenticated link; a relayed origin
      // is trusted only from the node configured as this one's hub.
      const hub = hubName(cfg);
      if (!fromLink && (!hub || foldName(link.node) !== foldName(hub))) return answer({ type: "err", id: m.id, reason: "invalid" });
      const r = depositRemote(m);
      if (r === "ok") { log(`deposited ${m.id} -> ${m.project}:${m.mailbox} (from ${m.origin} via ${link.node})`); return answer({ type: "ack", id: m.id }); }
      if (r === "dup") { log(`dup ${m.id} — re-acked`); return answer({ type: "ack", id: m.id }); }
      return answer({ type: "err", id: m.id, reason: r });
    }
    // not addressed to me: only a hub forwards, exactly once, from an authenticated ingress spoke
    if (!cfg.hub || !fromLink) return answer({ type: "err", id: m.id, reason: "unknown-node" });
    const dest = Object.keys(cfg.peers ?? {}).find(n => foldName(n) === foldName(m.dest));
    if (!dest) return answer({ type: "err", id: m.id, reason: "unknown-node" });
    const eg = linkFor(dest);
    if (!eg) return answer({ type: "err", id: m.id, reason: "node-down" });
    if (!eg.writable()) return answer({ type: "err", id: m.id, reason: "node-busy" }); // backpressured egress: don't pile on
    if (egressCount(dest) >= INFLIGHT_PER_EGRESS) return answer({ type: "err", id: m.id, reason: "node-busy" });
    inflight.set(m.id, { ingress: link.node, egress: dest, at: now() });
    eg.send({ type: "msg", ...m });
    log(`relayed ${m.id} ${link.node} -> ${dest}`);
  }

  function handleAnswer(link: Link, p: { type: "ack" | "err"; id: string; reason?: string }) {
    // the answer id becomes a path segment in outboxGet/clearEntry — reject non-bare names, same
    // traversal class the msg fields guard against
    if (typeof p.id !== "string" || !ID_RE.test(p.id)) return;
    const fl = inflight.get(p.id);
    if (fl) { // hub: route the answer back on the ingress link
      if (foldName(fl.egress) !== foldName(link.node)) return;         // answers only from the link the delivery went out on
      inflight.delete(p.id);
      const ing = linkFor(fl.ingress);
      if (ing) ing.send(p.type === "ack" ? { type: "ack", id: p.id } : { type: "err", id: p.id, reason: String(p.reason ?? "invalid") });
      else { droppedAnswers++; log(`answer for ${p.id} dropped — ingress ${fl.ingress} down (origin will retry)`); }
      return;
    }
    const entry = outboxGet(p.id);
    if (!entry) return;                                                // already cleared (or never ours)
    const hop = nextHop(cfg, entry.msg.dest);
    if (!hop || foldName(hop) !== foldName(link.node)) return;         // trusted by authenticated arrival only
    if (p.type === "ack") { clearEntry(p.id); lastAttempt.delete(p.id); log(`acked ${p.id}`); return; }
    const reason = String(p.reason ?? "invalid");
    if (!TERMINAL.has(reason)) { log(`err ${p.id}: ${reason} — will retry`); return; }
    // terminal transition, ordered: deposit the report, then clear the entry (the entry regenerates the report)
    try { depositReport(entry.msg, "undelivered", `${reason} at ${entry.msg.dest}`); } catch (e) { log(`report for ${p.id} failed: ${(e as Error).message}`); return; }
    clearEntry(p.id); lastAttempt.delete(p.id);
    log(`undelivered ${p.id}: ${reason} — reported`);
  }

  const handlers = {
    onPacket: (link: Link, p: Packet) => {
      if (p.type === "msg") { const { type, ...m } = p; handleMsg(link, m as Msg); }
      else if (p.type === "ack" || p.type === "err") handleAnswer(link, p);
    },
    onClose: (link: Link, why: string) => {
      if (links.get(foldName(link.node)) === link) links.delete(foldName(link.node));
      for (const [id, e] of inflight) if (foldName(e.egress) === foldName(link.node) || foldName(e.ingress) === foldName(link.node)) inflight.delete(id);
      log(`${link.node}: link closed (${why})`);
      const s = peersState.get(link.node);
      if (s && s.link === link && !stopping) { s.link = undefined; scheduleReconnect(link.node, s); }
    },
  };

  const register = (link: Link) => {                                   // newest-wins, by authenticated identity
    const key = foldName(link.node);
    const old = links.get(key);
    if (old && old !== link) old.close("superseded by newer connection");
    links.set(key, link);
    log(`${link.node}: link up`);
    deliver();
  };

  function scheduleReconnect(node: string, s: PeerState) {
    const healthy = s.connectedAt && now() - s.connectedAt > HEALTHY_MS;
    s.backoffMs = healthy ? BACKOFF_MIN : Math.min(s.backoffMs * 2, BACKOFF_MAX);
    s.connectedAt = undefined;
    const wait = Math.round(s.backoffMs * (0.5 + Math.random()));
    s.timer = setTimeout(() => { s.timer = undefined; connectPeer(node, s); }, wait);
  }
  function connectPeer(node: string, s: PeerState) {
    if (stopping) return;
    dial(cfg, node, handlers, log, (link) => { s.link = link; s.connectedAt = now(); register(link); },
      (why) => { if (!stopping) { log(`${node}: connect failed — ${why}`); scheduleReconnect(node, s); } });
  }

  if (cfg.accept) {
    try { server = acceptServer(cfg, register, handlers, log); log(`accepting on :${cfg.accept.port}`); }
    catch (e) { log(`accept failed: ${(e as Error).message}`); process.exit(1); }  // lingering port: next ensure retries
    server.on("error", (e) => { log(`accept error: ${(e as Error).message} — exiting (a lingering socket clears)`); cleanup(); process.exit(1); });
  }
  for (const node of Object.keys(cfg.peers ?? {})) {
    const s: PeerState = { backoffMs: BACKOFF_MIN };
    peersState.set(node, s);
    connectPeer(node, s);
  }

  // ---- delivery: per-destination FIFO, destinations served independently; transient faults stay here ----
  function deliver() {
    if (stopping) return;
    // hub in-flight entries whose answer will never come (lost on a link that stayed up) must not squat
    // the egress bound forever — the origin retries anyway
    for (const [id, e] of inflight) if (now() - e.at > 5 * RETRY_MS) { inflight.delete(id); droppedAnswers++; }
    const entries = outboxList();                                      // already send-time sorted
    for (const id of lastAttempt.keys()) if (!entries.some(e => e.msg.id === id)) lastAttempt.delete(id); // cleared out-of-process (giveup/recall)
    const blockedLink = new Set<string>();                             // backpressured this pass
    for (const e of entries) {
      const m = e.msg;
      const age = now() - idSendMs(m.id);
      const hop = nextHop(cfg, m.dest);
      if (!hop) { // never routable from this node: terminal, loud
        try { depositReport(m, e.state === "new" ? "undelivered" : "unconfirmed", `node '${m.dest}' is not configured (and no hub peer is)`); }
        catch { continue; }
        clearEntry(m.id); lastAttempt.delete(m.id); continue;
      }
      if (age > GIVE_UP_MS) {
        try { depositReport(m, e.state === "new" ? "undelivered" : "unconfirmed", `gave up after ${Math.round(age / 3600_000)}h`); }
        catch { continue; }
        clearEntry(m.id); lastAttempt.delete(m.id); continue;
      }
      if (age > NOTICE_MS && !wasNoticed(m.id)) {
        try { depositReport(m, "delayed", `still undelivered after ${Math.round(age / 60_000)}m; retrying until give-up`); markNoticed(m.id); } catch {}
      }
      const link = linkFor(hop);
      if (!link || !link.writable() || blockedLink.has(foldName(hop))) continue; // down/backpressured destination never delays another's queue
      const last = lastAttempt.get(m.id) ?? 0;
      if (now() - last < RETRY_MS) continue;
      // the durable in-flight claim precedes the wire; losing it (a concurrent recall won the rename)
      // means the entry is not ours to transmit
      if (e.state === "new" && !markSent(m.id)) continue;
      lastAttempt.set(m.id, now());
      if (!link.send({ type: "msg", ...m })) blockedLink.add(foldName(hop)); // backpressure: yield until drain
    }
  }

  // archive retention is the dedup window; pruning is a partition-dir removal, never a scan
  function pruneArchives() {
    const floor = new Date(now() - RETENTION_MS).toISOString().slice(0, 10);
    for (const e of Object.values(localPeers())) {
      if (!e.dir) continue;
      try {
        for (const p of readdirSync(archiveDir(e.dir)).filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p) && p < floor)) {
          rmSync(join(archiveDir(e.dir), p), { recursive: true, force: true });
        }
      } catch {}
    }
  }

  function writeStatus() {
    const linkStates: Record<string, string> = {};
    for (const node of Object.keys(cfg.peers ?? {})) linkStates[node] = linkFor(node) ? "up" : "down";
    for (const l of links.values()) if (!(l.node in linkStates)) linkStates[l.node] = "up (inbound)";
    const ob = outboxList();
    const snap = {
      pid: process.pid, startedAt, at: now(), lease: leaseExpiry(),
      node: cfg.node, hub: !!cfg.hub, mode: cfg.mode ?? "manual", accepting: !!cfg.accept,
      links: linkStates, outbox: ob.length, oldest: ob.length ? idSendMs(ob[0].msg.id) : undefined,
      inflight: inflight.size, droppedAnswers, undeliverable: undeliverableCount(), evictions: evictions(),
    };
    try { atomicWrite(DAEMON_STATUS_PATH, JSON.stringify(snap)); } catch {} // readers must never see a truncated snapshot
  }

  deliver();
  pruneArchives();
  writeStatus();
  setInterval(deliver, DELIVER_MS);
  setInterval(pruneArchives, PRUNE_MS);
  setInterval(writeStatus, 5_000);
  setInterval(() => {
    if (existsSync(NO_DAEMON_PATH)) { log("disabled -- exiting"); cleanup(); process.exit(0); }
    // an accepting node never idle-exits regardless of mode; `always` doesn't either
    const idleExits = !cfg.accept && (cfg.mode ?? "manual") === "manual";
    if (idleExits && leaseExpiry() < now() && outboxList().length === 0) { log("lease lapsed -- exiting"); cleanup(); process.exit(0); }
  }, LEASE_CHECK_MS);
}

// ---- status / control ----
function status() {
  const disabled = existsSync(NO_DAEMON_PATH);
  const pid = lockPid();
  const alive = pid ? isDaemonPid(pid) : false;
  console.log(`flbus daemon: ${alive ? `running (pid ${pid})` : "not running"}${disabled ? " [disabled]" : ""}`);
  let cfg;
  try { cfg = loadNet(); } catch (e) {
    // an invalid config must not read as "not configured" — that hides the refusal
    console.log(`  net: INVALID — ${(e as Error).message}`);
    return;
  }
  if (!cfg) { console.log(`  net: not configured (no ${join(FLBUS_HOME, "net.json")})`); return; }
  console.log(`  node: ${cfg.node}${cfg.hub ? " (hub)" : ""} mode: ${cfg.mode ?? "manual"}${cfg.accept ? ` accept: :${cfg.accept.port}` : ""}`);
  if (pid && !alive) console.log(`  stale lock: pid ${pid} is not a live daemon (cleared on next spawn)`);
  const snap = readJson<any>(DAEMON_STATUS_PATH, null);
  if (alive && snap?.pid === pid) {
    console.log(`  uptime: ${Math.round((now() - snap.startedAt) / 1000)}s`);
    for (const [n, st] of Object.entries<any>(snap.links ?? {})) console.log(`    ${n}: ${st}`);
    console.log(`  outbox: ${snap.outbox}${snap.oldest ? ` (oldest ${ago(snap.oldest)})` : ""}  inflight: ${snap.inflight}`);
    if (snap.undeliverable) console.log(`  undeliverable/: ${snap.undeliverable} (evicted ${snap.evictions?.count ?? 0})`);
    if (snap.droppedAnswers) console.log(`  dropped answers: ${snap.droppedAnswers} (origins retry)`);
  } else {
    const ob = outboxList();
    if (ob.length) console.log(`  outbox: ${ob.length} waiting (oldest ${ago(idSendMs(ob[0].msg.id))}) — daemon not running!`);
  }
  // a .listen flag with no live watcher is a stale arm — the session it belonged to is gone
  for (const [pname, e] of Object.entries(localPeers())) {
    if (!e.dir) continue;
    try {
      for (const mb of readdirSync(busDir(e.dir))) {
        const fl = readFlag(join(busDir(e.dir), mb, ".listen"));
        if (fl?.pid && !isAlive(fl.pid)) console.log(`  stale listen flag: ${pname}:${mb} (watcher pid ${fl.pid} is gone)`);
      }
    } catch {}
  }
}
function stop() {
  const pid = lockPid();
  if (pid && isDaemonPid(pid)) {
    try {
      process.kill(pid);
      if (process.platform === "win32") { try { rmSync(DAEMON_LOCK_PATH, { force: true }); } catch {} } // TerminateProcess runs no handlers
      console.log(`stopped daemon (pid ${pid})`);
    } catch (e) { console.error(`could not stop pid ${pid}: ${(e as Error).message}`); }
  } else console.log("no running daemon");
}
function disable() { mkdirSync(FLBUS_HOME, { recursive: true }); writeFileSync(NO_DAEMON_PATH, "disabled\n", "utf8"); stop(); console.log("daemon disabled -- `flbus remote daemon enable` to allow it again"); }
function enable() { try { rmSync(NO_DAEMON_PATH, { force: true }); } catch {} console.log("daemon enabled"); }
