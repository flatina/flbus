# flbus

Agent-to-agent message bus for Claude Code sessions — human-gated, file-based, no daemon.

Sessions (across projects, or sharing one folder) exchange Markdown messages through per-recipient inbox dirs. Messages rest as files until pulled; only one-line summaries inject into context.

## Concepts

- **Endpoint = named session, not a project.** A project is a namespace with a default name; co-located sessions are told apart by claims (`/flbus:claim`).
- **Envelope** — `from / to / summary` front-matter, plus optional `cc` (delivers to extra inboxes, full addressing visible to all). Recipients list summaries and pull bodies selectively. A summary-only message (empty body) is delivered by its notice line alone — no pull.
- **Gated (default)** — delivery notices ride the user's next prompt; the human decides when a body is read. Re-sending with the same subject overwrites the file, so a supervisor can iterate the sender. Nothing bypasses the gate without explicit opt-in.
- **Listen (opt-in)** — a session holds a background watcher on its inbox; the watcher's exit re-invokes the session for automatic round-trips. Only the user's explicit ask toggles it — message content never does.
- **Ephemeral** — an empty inbox is the healthy state. Pulled messages go to the archive as a paper trail; the bus keeps no history.

## Install

The core is the `flbus` CLI (runs on [Node](https://nodejs.org) ≥ 18 — no bun required); the Claude Code plugin (gate hooks + slash commands) is a thin layer that calls it.

```
npm i -g @flatina/flbus                # the `flbus` command on PATH
claude plugin marketplace add flatina/flbus
claude plugin install flbus@flatina    # thin plugin → calls `flbus`
```

Any external skill or agent invokes flbus the same way — the `flbus` command on PATH, never a hardcoded path or `${CLAUDE_PLUGIN_ROOT}`.

By default, bus state (inboxes, flags, archive) lives in a per-user dir *outside* the project — `~/.flbus/<project-key>/` — so messaging never changes the project tree.

## Routes

Cross-project routing uses a machine-local table (`~/.flbus/routes.json`): the single source of a project's bus identity — registration writes nothing into the project. Add with `/flbus:register` or edit directly. A name defaults to the folder basename. State is central by default; set the optional `state` field to a project-relative path to store it in-tree instead (for trees that already ignore that path):

```json
{ "alpha": "C:\\work\\project-a", "beta": { "dir": "C:\\work\\project-b", "state": ".tmp/flbus" } }
```

A session in a subdirectory anchors to the deepest registered route at or above it. **Caveat** (no in-tree marker under central storage): an *unregistered* project's sessions started from different subdirs resolve to *different* identities, and in a monorepo where only the root is registered a subpackage session anchors up and shares the root's identity. Register each folder you want as its own endpoint (or `/flbus:claim` a distinct name).

## Use

Each command also triggers on plain words:

- `/flbus:send` — *"send this to alpha"*
- `/flbus:recv` — list summaries, pull selectively — *"check messages"*
- `/flbus:listen` — watcher wakes the session on arrival, reads, re-arms — *"watch your inbox"* / *"stop watching"*
- `/flbus:register` — put a project on the bus (bare = current)
- `/flbus:claim` — bind a name for co-located sessions (type it; no plain-word trigger)

Same-folder mailboxes are managed with `flbus endpoint create|ls|rm <name>` (`flbus claim` = `endpoint bind`).

Optional idle inbox indicator: wire `flbus status` (prints `📬 flbus N` when mail waits, nothing when empty) into your `statusLine` with a `refreshInterval`.
