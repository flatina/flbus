// TLS link layer: one persistent bidirectional connection per link, NDJSON packets, pin-then-token.
// Client authenticates the server by fingerprint256 pin (the ONLY server-auth signal — checkServerIdentity
// is not guaranteed to run for self-signed certs and would fail open); the token is written only after the
// pin verifies. Server authenticates the client by per-peer token bound to an expected node name.
// No session reuse: every dial is a fresh handshake, so the pin always fires.
import { connect as tlsConnect, createServer, type Server, type TLSSocket } from "node:tls";
import { readFileSync } from "node:fs";
import { validName } from "../lib";
import { LINE_CAP, WIRE_V, foldName, normPin, tokenEqual, type Msg, type NetConfig } from "./net";

export type Packet =
  | { type: "hello"; v: number; node: string; token: string }
  | ({ type: "msg" } & Msg)
  | { type: "ack"; id: string }
  | { type: "err"; id: string; reason: string }
  | { type: "ping" }
  | { type: "pong" };

export type Link = {
  node: string;                       // authenticated peer node name
  sock: TLSSocket;
  send: (p: Packet) => boolean;       // false = kernel buffer full; the delivery loop must wait for drain
  writable: () => boolean;            // false while backpressured — don't queue more onto the socket
  close: (why?: string) => void;
  isClosed: () => boolean;
};

const PING_MS = 30_000;
const IDLE_DEAD_MS = 75_000;          // no traffic (not even pong) this long ⇒ half-open, destroy
const HANDSHAKE_MS = 10_000;          // hello must complete within this on the accept side
const PREHELLO_CAP = 16;              // sockets allowed to sit un-helloed at once

export type LinkHandlers = {
  onPacket: (link: Link, p: Packet) => void;
  onClose: (link: Link, why: string) => void;
};

// App-level keepalive + NDJSON framing with a hard line cap: an over-long line fails the link
// rather than growing the buffer. A dead intermediary leaves a socket that still looks open.
function mkLink(node: string, sock: TLSSocket, h: LinkHandlers, log: (m: string) => void): Link {
  let closed = false;
  let buf = "";
  let lastRecv = Date.now();
  const link: Link = {
    node, sock,
    send: (p) => { try { return sock.write(JSON.stringify(p) + "\n"); } catch { return false; } },
    writable: () => !closed && !sock.writableNeedDrain,
    close: (why = "closed") => { if (closed) return; closed = true; clearInterval(iv); try { sock.destroy(); } catch {} h.onClose(link, why); },
    isClosed: () => closed,
  };
  const iv = setInterval(() => {
    if (Date.now() - lastRecv > IDLE_DEAD_MS) return link.close("keepalive timeout");
    link.send({ type: "ping" });
  }, PING_MS);
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    lastRecv = Date.now();
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let p: Packet;
      try { p = JSON.parse(line); } catch { log(`${node}: unparseable packet — ignored`); continue; }
      if (p?.type === "ping") { link.send({ type: "pong" }); continue; }
      if (p?.type === "pong") continue;
      if (p?.type === "msg" || p?.type === "ack" || p?.type === "err") { try { h.onPacket(link, p); } catch (e) { log(`${node}: handler error ${(e as Error).message}`); } }
      // unknown type: ignored (forward compatibility)
    }
    // the cap is bytes, not UTF-16 units, and applies to the residual (an unterminated line) — a chunk
    // holding several complete lines may legitimately exceed it in total
    if (buf.length > LINE_CAP || Buffer.byteLength(buf, "utf8") > LINE_CAP) return link.close("line cap exceeded");
  });
  sock.on("error", (e) => link.close(`socket error: ${(e as Error).message}`));
  sock.on("close", () => link.close("socket closed"));
  return link;
}

// ---- accept side ----

export function acceptServer(
  cfg: NetConfig,
  onAuthed: (link: Link) => void,
  h: LinkHandlers,
  log: (m: string) => void,
): Server {
  const a = cfg.accept!;
  const cert = readFileSync(a.cert);
  const key = readFileSync(a.key);
  let preHello = 0;
  let preTls = 0;
  const server = createServer({ cert, key, minVersion: "TLSv1.3", handshakeTimeout: HANDSHAKE_MS }, (sock) => {
    if (preHello >= PREHELLO_CAP) { sock.destroy(); return; } // reaching the port must not exhaust sockets
    preHello++;
    let done = false;
    const finish = () => { if (!done) { done = true; preHello--; clearTimeout(deadline); } };
    const deadline = setTimeout(() => { finish(); sock.destroy(); }, HANDSHAKE_MS);
    let buf = "";
    sock.setEncoding("utf8");
    const onData = (chunk: string) => {
      buf += chunk;
      if (buf.length > LINE_CAP) { finish(); sock.destroy(); return; }
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      sock.off("data", onData);
      const rest = buf.slice(nl + 1);
      let hello: Packet;
      try { hello = JSON.parse(buf.slice(0, nl)); } catch { finish(); sock.destroy(); return; }
      finish();
      if (hello?.type !== "hello") { sock.destroy(); return; }               // no msg before hello completes
      if (hello.v !== WIRE_V) { log(`hello: unsupported wire v${hello.v} — closing`); sock.destroy(); return; }
      const node = hello.node;
      if (typeof node !== "string" || !validName(node)) { sock.destroy(); return; }
      const expect = Object.entries(a.tokens).find(([n]) => foldName(n) === foldName(node))?.[1];
      // constant-time compare; tokens and rejected packets never appear in logs
      if (!expect || typeof hello.token !== "string" || !tokenEqual(expect, hello.token)) {
        log(`hello: rejected connection claiming '${node}'`); sock.destroy(); return;
      }
      const link = mkLink(node, sock, h, log);
      onAuthed(link);                                                        // newest-wins is the registry's call
      if (rest.trim()) sock.emit("data", rest);                              // packets pipelined behind hello
    };
    sock.on("data", onData);
    sock.on("error", () => { finish(); });
    sock.on("close", () => { finish(); });
  });
  // the hello caps above start only after the TLS handshake; `handshakeTimeout` bounds a stalled handshake's
  // duration, and this raw-stage cap bounds its concurrency — together the pre-auth surface is finite
  server.on("connection", (raw) => {
    if (preTls >= PREHELLO_CAP * 2) { raw.destroy(); return; }
    preTls++;
    raw.on("close", () => { preTls--; });
    raw.on("error", () => {});
  });
  server.listen(a.port, a.host);
  return server;
}

// ---- connect side ----

export function dial(
  cfg: NetConfig,
  peerNode: string,
  h: LinkHandlers,
  log: (m: string) => void,
  onUp: (link: Link) => void,
  onFail: (why: string) => void,
): void {
  const peer = cfg.peers![peerNode];
  const i = peer.address.lastIndexOf(":");
  const host = i > 0 ? peer.address.slice(0, i) : peer.address;
  const port = i > 0 ? Number(peer.address.slice(i + 1)) : NaN;
  if (!Number.isFinite(port)) return onFail(`bad address '${peer.address}' (need host:port)`);
  const pins = peer.pins.map(normPin);
  let settled = false;
  const sock = tlsConnect({ host, port, rejectUnauthorized: false, minVersion: "TLSv1.3" }, () => {
    // The pin is the only server-auth signal; nothing (the token especially) is written before it verifies.
    const fp = normPin(sock.getPeerCertificate()?.fingerprint256 ?? "");
    if (!fp || !pins.includes(fp)) {
      settled = true; sock.destroy();
      return onFail(`pin mismatch for '${peerNode}' — refusing to speak`);
    }
    settled = true;
    sock.setTimeout(0); // the connect deadline; keepalive owns liveness from here
    const link = mkLink(peerNode, sock, h, log);
    link.send({ type: "hello", v: WIRE_V, node: cfg.node, token: peer.token });
    onUp(link);
  });
  sock.setTimeout(HANDSHAKE_MS, () => { if (!settled) { settled = true; sock.destroy(); onFail("connect timeout"); } });
  sock.on("error", (e) => { if (!settled) { settled = true; onFail((e as Error).message); } });
}
