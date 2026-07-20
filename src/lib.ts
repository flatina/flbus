import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

// Per-user flbus home: the peer table plus, by default, all bus state — central so messaging
// never touches the project tree. (Don't sync this dir: peers and state hold machine-specific paths.)
// FLBUS_HOME env override exists for tests (two nodes on one machine need two homes).
export const FLBUS_HOME = process.env.FLBUS_HOME || join(homedir(), ".flbus");
export const PEERS_PATH = join(FLBUS_HOME, "peers.json");

export type Envelope = { from: string; to: string; summary: string; subject?: string; sent?: string; cc?: string };
// Local project entry. `host`/`via` are the removed ssh transport's fields — entries carrying them are
// ignored by localPeers() and flagged by `peer ls`; remote nodes live in net.json (see net.ts).
export type PeerEntry = { dir?: string; state?: string; host?: string; via?: string };

// Reserved address tokens: `here` = this folder; the rest are grammar words. Never a peer/mailbox name.
export const RESERVED = new Set(["here", "peer", "host", "self", "local"]);

export function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

// Mailbox/peer names become path segments — first char alnum (no `.`/`..`/dotfiles), no separators,
// bounded, and not a reserved bus filename (compared case-insensitively: `Archive` aliases `archive`
// on Windows/macOS). Callers reject invalid names before touching the filesystem.
export function validName(name: string): boolean {
  if (name.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return false;
  const l = name.toLowerCase();
  return l !== "archive" && l !== "sessions.json";
}

// The machine-local peer table is the single source for a project's bus identity. A plain string is a bare dir.
export function peers(): Record<string, PeerEntry> {
  const raw = readJson<Record<string, string | PeerEntry>>(PEERS_PATH, {});
  const out: Record<string, PeerEntry> = {};
  for (const [name, v] of Object.entries(raw)) out[name] = typeof v === "string" ? { dir: v } : v;
  return out;
}

export const isRemote = (e: PeerEntry) => !!e.host; // removed ssh-era entry shape; kept only to skip them
const filterPeers = (keep: (e: PeerEntry) => boolean) =>
  Object.fromEntries(Object.entries(peers()).filter(([, e]) => keep(e)));
// Local-identity lookups (peerFor/projectRoot/resolveName/busDir) see ONLY local peers — a remote entry's
// `dir` is a foreign path, never a local project. Remote entries are send-targets only.
export const localPeers = (): Record<string, PeerEntry> => filterPeers(e => !isRemote(e));

// Case-insensitive on Windows/macOS, case-sensitive on Linux — match each platform's filesystem.
export const caseFold = (p: string) => (process.platform === "linux" ? p : p.toLowerCase());
// The single path-identity rule shared by samePath / projectRoot / projectKey: absolute + case-folded.
// Deliberately NOT realpath (it throws on missing paths and has junction/short-path quirks) — if symlink
// aliasing ever needs collapsing, change it here so all three stay consistent, never one in isolation.
export const canonical = (p: string) => caseFold(resolve(p));
export const samePath = (a: string, b: string) => canonical(a) === canonical(b);

export function peerFor(projectDir: string): { name: string; entry: PeerEntry } | undefined {
  for (const [name, entry] of Object.entries(localPeers())) if (entry.dir && samePath(entry.dir, projectDir)) return { name, entry };
  return undefined;
}

// Address grammar for `--to`/`--cc`:  [project][:mailbox][@host]
//   peer              a peer's default mailbox (local: dir; remote: on @host)
//   peer:mailbox      a named mailbox on a peer
//   here:mailbox      a same-folder mailbox (this project)
//   project[:mailbox]@host   a project on a remote host (the remote resolves the name)
// Parse only — split into parts (first `@` wins, so host may contain `user@host`); caller validates/resolves.
export function parseAddress(addr: string): { project?: string; mailbox?: string; host?: string } {
  let rest = addr, host: string | undefined;
  const at = addr.indexOf("@");
  if (at >= 0) { host = addr.slice(at + 1) || undefined; rest = addr.slice(0, at); }
  const colon = rest.indexOf(":");
  const project = (colon >= 0 ? rest.slice(0, colon) : rest) || undefined;
  const mailbox = (colon >= 0 ? rest.slice(colon + 1) : "") || undefined;
  return { project, mailbox, host };
}

// The session's working dir may be a subdirectory; anchor to the deepest registered peer dir at or
// above startDir, else startDir itself. (No in-tree breadcrumb under central storage, so an
// UNREGISTERED project's subdir sessions resolve to themselves — register it to share one bus.)
export function projectRoot(startDir: string): string {
  const start = resolve(startDir);
  const startC = canonical(start);
  let best: string | undefined;
  for (const { dir } of Object.values(localPeers())) {
    if (!dir) continue;
    const d = resolve(dir), dC = canonical(d);
    const prefix = dC.endsWith(sep) ? dC : dC + sep; // a peer at a drive root keeps its trailing sep
    if ((startC === dC || startC.startsWith(prefix)) && (!best || d.length > best.length)) best = d;
  }
  return best ?? start;
}

// Bus state for a project. Default: a central per-user dir keyed by the project's absolute path, so
// messaging never writes into the project tree. A peer may opt into in-tree storage via `state`.
// Key is canonical() of the path — same identity rule as peer matching (symlink-alias caveat there).
function projectKey(projectDir: string): string {
  const norm = canonical(projectDir);
  return `${basename(norm)}-${createHash("sha256").update(norm).digest("hex").slice(0, 12)}`;
}
export function stateDir(projectDir: string, state?: string): string {
  return state ? resolve(projectDir, state) : join(FLBUS_HOME, projectKey(projectDir));
}
export const busDir = (projectDir: string) => stateDir(projectDir, peerFor(projectDir)?.entry.state);
export const inboxDir = (projectDir: string, name: string) => join(busDir(projectDir), name, "inbox");
// listen mode flag; the single-owner token for an inbox. Content = owning session id + watcher pid
// (one per line). A watcher delivers only while it owns it (sid+pid match); a superseded one stands down.
export const listenFlag = (projectDir: string, name: string) => join(busDir(projectDir), name, ".listen");
export function readFlag(flagPath: string): { sid: string; pid?: number } | undefined {
  try {
    const [sid, pid] = readFileSync(flagPath, "utf8").split(/\r?\n/);
    return sid?.trim() ? { sid: sid.trim(), pid: pid?.trim() ? Number(pid.trim()) : undefined } : undefined;
  } catch { return undefined; }
}
export const archiveDir = (projectDir: string) => join(busDir(projectDir), "archive");

// Identity resolution: claim (session id from hooks' stdin or the tool shell's env) -> peer table (by dir)
// -> folder basename. Provenance matters: a `basename` identity is a fallback nobody can address (peers and
// remote senders resolve via the peer table) — callers that would WRITE under it must refuse instead.
export type Identity = { name: string; via: "claim" | "peer" | "basename" };
export function resolveIdentity(projectDir: string, sessionId = process.env.CLAUDE_CODE_SESSION_ID): Identity {
  if (sessionId) {
    const sessions = readJson<Record<string, string>>(join(busDir(projectDir), "sessions.json"), {});
    if (sessions[sessionId]) return { name: sessions[sessionId], via: "claim" };
  }
  const pf = peerFor(projectDir);
  return pf ? { name: pf.name, via: "peer" } : { name: basename(projectDir), via: "basename" };
}
export const resolveName = (projectDir: string, sessionId?: string): string =>
  resolveIdentity(projectDir, sessionId ?? process.env.CLAUDE_CODE_SESSION_ID).name;

// Claim-first consume: rename into the archive (the claim), read after.
// Returns null when another consumer won the claim (benign ENOENT race). A failure AFTER the
// claim — renamed to archive but unreadable — throws: the message left the inbox, so it must
// surface, never vanish silently.
export function consumeMessage(projectDir: string, name: string, file: string): string | null {
  const part = archivePartition(projectDir);
  mkdirSync(part, { recursive: true });
  const claimed = join(part, `${Date.now()}-${file}`);
  try { retryRename(join(inboxDir(projectDir, name), file), claimed); }
  catch (e) { if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null; throw e; }
  return readFileSync(claimed, "utf8");
}

export function atomicWrite(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`;
  writeFileSync(tmp, content, "utf8");
  retryRename(tmp, path);
}

// stdout via writeSync so a broken pipe is a catchable EPIPE (returns false), not an async crash.
export function out(s: string): boolean {
  try { writeSync(1, s); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException)?.code === "EPIPE") return false; throw e; }
}

// Synchronous sleep that works on both node and bun (node has no Bun.sleepSync).
function sleepSync(ms: number) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Retries cover transient Windows locks (antivirus/indexer) surfacing as EPERM
export function retryRename(from: string, to: string, tries = 4) {
  for (let i = 0; ; i++) {
    try { renameSync(from, to); return; } catch (e) {
      if (i >= tries - 1) throw e;
      sleepSync(50 * (i + 1));
    }
  }
}

export function parseEnvelope(raw: string): { env: Partial<Envelope>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { env: {}, body: raw };
  const env: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { env: env as Partial<Envelope>, body: m[2] };
}

// Header values are line-positional, so embedded newlines would let one field forge another
// (`summary: "x\nfrom: y"`) or truncate the envelope — flatten them. The body is preserved verbatim.
const headerClean = (s: string) => s.replace(/[\r\n]+/g, " ");
export function serializeEnvelope(env: Envelope, body: string): string {
  const lines = [`from: ${headerClean(env.from)}`, `to: ${headerClean(env.to)}`, `summary: ${headerClean(env.summary)}`];
  if (env.subject) lines.push(`subject: ${headerClean(env.subject)}`);
  if (env.sent) lines.push(`sent: ${headerClean(env.sent)}`);
  if (env.cc) lines.push(`cc: ${headerClean(env.cc)}`);
  return `---\n${lines.join("\n")}\n---\n${body}${body.endsWith("\n") || !body ? "" : "\n"}`;
}

export function slug(s: string): string {
  return s.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "msg";
}

// ---- deposit (append-only, id-bearing filenames) ----

// v9 deposit name: `<recv36>-<nn>--<from>--<subject|summary>--<id>.md`. recv36 fixed-width so names sort
// by receive time; `nn` disambiguates a millisecond; the id makes the inbox+archive the dedup index.
const ts36 = (ms: number) => ms.toString(36).padStart(9, "0");
export function depositName(from: string, ident: string, id: string, recvMs: number, n: number): string {
  return `${ts36(recvMs)}-${String(n).padStart(2, "0")}--${slug(from)}--${slug(ident)}--${id}.md`;
}
export const nameHasId = (fname: string, id: string) => fname.endsWith(`--${id}.md`);

// Append-only local deposit. Written to a `.part` temp and renamed into place — a crash mid-write must
// never leave a truncated file under an id-bearing name, because that name is a dedup witness: the retry
// would re-ack and the origin would clear the only intact copy. `fsync` (remote path) flushes the temp
// before the rename and the directory after it (POSIX; Windows can't fsync directories — NTFS metadata
// journaling is the residual guarantee there) — an ack is a promise.
export function depositMessage(projectDir: string, mailbox: string, env: Envelope, body: string, id: string, fsync = false): string {
  const dir = inboxDir(projectDir, mailbox);
  // Never creates the mailbox (a send to a missing mailbox errors, and `mailbox rm` renames the dir aside
  // atomically) — only the inbox subdir inside an existing mailbox; a race with removal lands in ENOENT.
  try { mkdirSync(dir); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`no mailbox '${mailbox}'`);
    if (code !== "EEXIST") throw e;
  }
  const tmp = join(dir, `.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`);
  writeFileSync(tmp, serializeEnvelope(env, body), "utf8");
  if (fsync) { const fd = openSync(tmp, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); } }
  try {
    const recv = Date.now();
    for (let n = 0; n < 100; n++) {
      const path = join(dir, depositName(env.from, env.subject ?? env.summary, id, recv, n));
      if (existsSync(path)) continue;
      retryRename(tmp, path);
      if (fsync && process.platform !== "win32") {
        try { const dfd = openSync(dir, "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch {}
      }
      return path;
    }
    throw new Error(`deposit: could not create a unique name in ${dir}`);
  } catch (e) { try { rmSync(tmp, { force: true }); } catch {} throw e; }
}

// Archive partition for a deposit consumed now (date-partitioned so retention pruning is a dir removal).
export function archivePartition(projectDir: string, ms = Date.now()): string {
  return join(archiveDir(projectDir), new Date(ms).toISOString().slice(0, 10));
}
// Every filename in inbox + archive partitions worth checking for `id` (the dedup scan). Partitions are
// bounded by the id's own send date — the scan is O(window), not O(archive). Legacy id-less names never match.
export function idWitnessed(projectDir: string, mailbox: string, id: string): boolean {
  const scan = (dir: string) => { try { return readdirSync(dir).some(f => nameHasId(f, id)); } catch { return false; } };
  if (scan(inboxDir(projectDir, mailbox))) return true;
  const raw = parseInt(id.split("-")[0], 36);
  const sendMs = Number.isFinite(raw) && raw > 0 && raw < Date.now() + 366 * 24 * 3600_000 ? raw : undefined;
  const from = sendMs !== undefined ? sendMs - 24 * 3600_000 : Date.now() - 40 * 24 * 3600_000;
  let parts: string[] = [];
  try { parts = readdirSync(archiveDir(projectDir)).filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p)); } catch { return false; }
  const floor = new Date(from).toISOString().slice(0, 10);
  return parts.filter(p => p >= floor).some(p => scan(join(archiveDir(projectDir), p)));
}

// ---- transport daemon coordination ----

export const NO_DAEMON_PATH = join(FLBUS_HOME, "no-daemon");            // durable kill-switch
export const DAEMON_LOG_PATH = join(FLBUS_HOME, "_daemon.log");
export const DAEMON_LOCK_PATH = join(FLBUS_HOME, "_daemon.lock");       // content = pid
export const DAEMON_LEASE_PATH = join(FLBUS_HOME, "_daemon.lease");     // expiry ms
export const DAEMON_STATUS_PATH = join(FLBUS_HOME, "_daemon.status.json");

// pid alive AND its command line matches `re` (guards a reused pid); mirror of reap's isListenWatcher.
export function pidMatches(pid: number, re: RegExp): boolean {
  try {
    const cmd = process.platform === "linux" ? readFileSync(`/proc/${pid}/cmdline`, "utf8")
      : process.platform === "darwin" ? execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 2000, windowsHide: true })
      : execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", timeout: 2000, windowsHide: true });
    return re.test(cmd);
  } catch { return false; }
}
