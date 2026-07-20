# flbus

Agent-to-agent message bus for Claude Code sessions — human-gated and file-based.

Sessions (across projects, machines, or sharing one folder) exchange Markdown messages through per-recipient inbox dirs. Messages rest as files until pulled; only one-line summaries inject into context.

## Concepts

- **Mailbox = a named recipient.** Each session receives at a named mailbox; co-located sessions in one folder are told apart by claims (`/flbus:claim`). A project also carries one default identity for cross-project messaging — a **peer**.
- **Address** — who a message is `--to`:
  - `peer` — a registered project's default mailbox (the common case)
  - `peer:mailbox` — a named mailbox on a peer
  - `here:mailbox` — a mailbox in *this* folder (co-located sessions); `here:` is required, never a bare name
  - `project[:mailbox]@node` — a project on another machine; `node` is a name registered in `net.json`, not a hostname (see [Remote](#remote))

  Every address has exactly one meaning — no fallback guessing.
- **Envelope** — `from / to / summary` front-matter, plus optional `cc` (delivers to extra inboxes, full addressing visible to all). Recipients peek summaries and take bodies selectively. A summary-only message (empty body) is delivered by its notice line alone — no pull.
- **Gated (default)** — delivery notices ride the user's next prompt; the human decides when a body is read. Delivery is append-only: re-sending a subject delivers another message (the envelope's `sent:` time says which is newer). Nothing bypasses the gate without explicit opt-in.
- **Listen (opt-in)** — a session holds a background watcher on its inbox; on arrival it consumes the message and the watcher's exit re-invokes the session for automatic round-trips. Only the user's explicit ask toggles it — message content never does.
- **Ephemeral** — an empty inbox is the healthy state. Taken messages go to the archive as a paper trail; the bus keeps no history.

## Install

The core is the `flbus` CLI (runs on [Node](https://nodejs.org) ≥ 18 — no bun required); the Claude Code plugin (gate hooks + slash commands) is a thin layer that calls it.

```
npm i -g @flatina/flbus                # the `flbus` command on PATH
claude plugin marketplace add flatina/flbus
claude plugin install flbus@flatina    # thin plugin → calls `flbus`
```

Any external skill or agent invokes flbus the same way — the `flbus` command on PATH, never a hardcoded path or `${CLAUDE_PLUGIN_ROOT}`.

By default, bus state (inboxes, flags, archive) lives in a per-user dir *outside* the project — `~/.flbus/<project-key>/` — so messaging never changes the project tree.

## Peers

Cross-project messaging uses a machine-local table (`~/.flbus/peers.json`): the single source of a project's bus identity — registration writes nothing into the project. Add with `/flbus:peer` or edit directly. A name defaults to the folder basename. State is central by default; set the optional `state` field to a project-relative path to store it in-tree instead (for trees that already ignore that path):

```json
{ "alpha": "C:\\work\\project-a", "beta": { "dir": "C:\\work\\project-b", "state": ".tmp/flbus" } }
```

A session in a subdirectory anchors to the deepest registered peer at or above it. **Caveat** (no in-tree marker under central storage): an *unregistered* project's sessions started from different subdirs resolve to *different* identities, and in a monorepo where only the root is registered a subpackage session anchors up and shares the root's identity. Register each folder you want as its own peer (or `/flbus:claim` a distinct name).

## Remote

`--to project[:mailbox]@node` reaches a project on another machine — local addressing plus a node name. Machines link over **pinned self-signed TLS** (no ssh; works on networks with no security of their own), hub-and-spoke: spoke↔spoke traffic relays through the hub, so each machine only configures its link to the hub. Node setup lives in `~/.flbus/net.json` (the ops doc has the shape and cert commands).

A remote send returns immediately; a transport daemon delivers it **end-to-end acknowledged** and never reads bodies. Nothing fails silently — every failure or delay comes back as a message in the sender's own inbox. Delivery is at-least-once: rare duplicates are possible, and always visible as such. The `from` you reply to is `project@node`, its node part authenticated. Ask your agent for the transport's status, to disable it durably, or to give up on a stalled send.

## Use

Each command also triggers on plain words — just tell your agent:

- `/flbus:send` — *"send this to alpha"*
- `/flbus:recv` — peek summaries, take selectively — *"check messages"*
- `/flbus:listen` — watcher wakes the session on arrival, consumes, re-arms — *"watch your inbox"* / *"stop watching"*
- `/flbus:peer` — register another flbus instance (bare = current project)
- `/flbus:claim` — receive as a name for co-located sessions (type it; no plain-word trigger)

Same-folder mailboxes: `flbus claim <name>` to receive as one (`flbus mailbox ls|rm` to manage).

Inbox indicator: wire `flbus status` (prints `📬 flbus N` when mail waits, nothing when empty) into your `statusLine` with a `refreshInterval` so arriving mail is visible while idle — `/flbus:register` sets this up if it isn't already.
