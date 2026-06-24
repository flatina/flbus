import { mkdirSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

// Per-user flbus home: the peer table plus, by default, all bus state — central so messaging
// never touches the project tree. (Don't sync this dir: peers and state hold machine-specific paths.)
export const FLBUS_HOME = join(homedir(), ".flbus");
export const PEERS_PATH = join(FLBUS_HOME, "peers.json");

export type Envelope = { from: string; to: string; summary: string; cc?: string };
export type PeerEntry = { dir: string; state?: string };

// Reserved address tokens: `here` = this folder; the rest are grammar words. Never a peer/mailbox name.
export const RESERVED = new Set(["here", "peer", "host", "self", "local"]);

export function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

// Mailbox/peer names become path segments — first char alnum (no `.`/`..`/dotfiles), no separators,
// not a reserved bus filename. Callers reject invalid names before touching the filesystem.
export function validName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name !== "archive" && name !== "sessions.json";
}

// The machine-local peer table is the single source for a project's bus identity:
// name → { dir, state? }. A plain string is a bare dir; `state` opts a project into in-tree storage.
export function peers(): Record<string, PeerEntry> {
  const raw = readJson<Record<string, string | PeerEntry>>(PEERS_PATH, {});
  const out: Record<string, PeerEntry> = {};
  for (const [name, v] of Object.entries(raw)) out[name] = typeof v === "string" ? { dir: v } : v;
  return out;
}

// Case-insensitive on Windows/macOS, case-sensitive on Linux — match each platform's filesystem.
export const caseFold = (p: string) => (process.platform === "linux" ? p : p.toLowerCase());
// The single path-identity rule shared by samePath / projectRoot / projectKey: absolute + case-folded.
// Deliberately NOT realpath (it throws on missing paths and has junction/short-path quirks) — if symlink
// aliasing ever needs collapsing, change it here so all three stay consistent, never one in isolation.
export const canonical = (p: string) => caseFold(resolve(p));
export const samePath = (a: string, b: string) => canonical(a) === canonical(b);

export function peerFor(projectDir: string): { name: string; entry: PeerEntry } | undefined {
  for (const [name, entry] of Object.entries(peers())) if (samePath(entry.dir, projectDir)) return { name, entry };
  return undefined;
}

// Address grammar for `--to`/`--cc`:  [project][:mailbox][@host]
//   peerName          peer's default mailbox (= peerName)
//   peerName:mailbox  a named mailbox on a peer
//   here:mailbox      a same-folder mailbox (this project)
//   …@host            remote (host requires a project; resolution lands with the remote feature)
// Parse only — split into parts; the caller validates and resolves. Empty parts become undefined.
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
  for (const { dir } of Object.values(peers())) {
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
// listen mode flag; content = owning session id, so a dead session's flag is ignored
export const listenFlag = (projectDir: string, name: string) => join(busDir(projectDir), name, ".listen");
export const archiveDir = (projectDir: string) => join(busDir(projectDir), "archive");

// Identity resolution: claim (session id from hooks' stdin or the tool shell's env) → peer table (by dir) → folder basename
export function resolveName(projectDir: string, sessionId = process.env.CLAUDE_CODE_SESSION_ID): string {
  if (sessionId) {
    const sessions = readJson<Record<string, string>>(join(busDir(projectDir), "sessions.json"), {});
    if (sessions[sessionId]) return sessions[sessionId];
  }
  return peerFor(projectDir)?.name ?? basename(projectDir);
}

// Claim-first consume: rename into the archive (the claim), read after.
// Returns null when another consumer won the claim (benign ENOENT race). A failure AFTER the
// claim — renamed to archive but unreadable — throws: the message left the inbox, so it must
// surface, never vanish silently.
export function consumeMessage(projectDir: string, name: string, file: string): string | null {
  mkdirSync(archiveDir(projectDir), { recursive: true });
  const claimed = join(archiveDir(projectDir), `${Date.now()}-${file}`);
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

export function serializeEnvelope(env: Envelope, body: string): string {
  const lines = [`from: ${env.from}`, `to: ${env.to}`, `summary: ${env.summary}`];
  if (env.cc) lines.push(`cc: ${env.cc}`);
  return `---\n${lines.join("\n")}\n---\n${body.trimEnd()}\n`;
}

export function slug(s: string): string {
  return s.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "msg";
}
