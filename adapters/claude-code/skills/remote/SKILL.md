---
name: remote
description: Set up cross-machine flbus over pinned-TLS — add this machine to a hub, or stand up a hub. Use for "connect to the flbus hub", "remote peer/node setup", "@node addressing".
---

# flbus remote

Cross-machine messaging over one persistent pinned-TLS link per pair. Address a project on another machine as `project[:mailbox]@node`. Config is `~/.flbus/net.json` (read once at daemon **startup** — every change needs a daemon restart). Reachability (Tailscale/LAN/VPN/tunnel) is a deployment concern; flbus has no ssh. Validate any config with `flbus remote check`.

## Roles (hub-and-spoke)

- **hub** — dials out to spokes and relays spoke↔spoke traffic. **Never accepts inbound** (it holds every pin and token — opening its port exposes the crown jewel). Spoke↔spoke goes through it, so each machine only configures its link to the hub.
- **spoke** — accepts; the hub dials it. Most machines are spokes.

Decide which this machine is. Joining an existing hub → **spoke** (the common case).

## Add this machine as a spoke

1. **Cert + key** (self-contained — does not read the system openssl.cnf, which is often broken on Windows):
   ```
   mkdir -p ~/.flbus/certs
   cat > ~/.flbus/certs/req.cnf <<'EOF'
   [req]
   distinguished_name = dn
   prompt = no
   [dn]
   CN = THIS_NODE
   EOF
   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
     -keyout ~/.flbus/certs/THIS_NODE.key -out ~/.flbus/certs/THIS_NODE.crt -config ~/.flbus/certs/req.cnf
   ```
2. **Pin** (give to the hub operator): `openssl x509 -in ~/.flbus/certs/THIS_NODE.crt -noout -fingerprint -sha256`
3. **Token** (you generate, shared with the hub): `openssl rand -hex 24`
4. **Port**: pick a **fixed port below 49152**. On Windows the dynamic range (49152+) is chunk-reserved by Hyper-V/WSL and gives `listen EACCES` on seemingly-free ports — check `netsh int ipv4 show excludedportrange protocol=tcp`.
5. **Write `~/.flbus/net.json`** (accept-only spoke):
   ```json
   { "node": "THIS_NODE",
     "hubNode": "HUB_NODE",
     "accept": { "port": 9440, "cert": "<abs path>/THIS_NODE.crt", "key": "<abs path>/THIS_NODE.key",
                 "tokens": { "HUB_NODE": "THE_TOKEN" } } }
   ```
6. `flbus remote check` → fix any error it names.
7. **Ensure `<this-tailscale-or-lan-IP>:<port>` is reachable from the hub** (open the port to the trusted interface only).
8. **Hand the hub operator four values**: node name `THIS_NODE`, address `IP:port`, the pin (step 2), the token (step 3). The hub adds you (below).
9. **Start + verify**: `flbus remote daemon` then `flbus remote status` (expect `HUB_NODE: up (inbound)`) then `flbus doctor`.
10. **Boot** (receive-only machine, no live session to spawn the daemon): add a **login/logon scheduled task** running `flbus remote daemon`. flbus ships no OS service supervision by design.

## Hub side: add a spoke

Add to the hub's `net.json` `peers` (create the block if absent), using the four values the spoke handed you:
```json
"THIS_NODE": { "address": "IP:port", "pins": ["<spoke pin>"], "token": "THE_TOKEN" }
```
Then **restart the hub daemon** (`flbus remote daemon stop` then `flbus remote daemon`) — net.json is read once at startup. `flbus remote status` → `THIS_NODE: up`.

## Stand up a new hub

```json
{ "node": "HUB_NODE", "hub": true, "mode": "always",
  "peers": { "SPOKE": { "address": "IP:port", "pins": ["<spoke pin>"], "token": "..." } } }
```
`mode: "always"` keeps a connect-only hub from idle-exiting. Then add each spoke as above.

## net.json fields

- `node` — this machine's canonical name (bare name; the routing key, distinct from its address).
- `mode` — `manual` (idle-exit) | `always`. Ignored on accepting nodes (they never idle-exit).
- `hub: true` — this node relays spoke↔spoke.
- `hubNode` — on an accept-only spoke, the node it trusts as hub + routes through by default.
- `accept` — `{ port, host?, cert, key, tokens }`; `tokens` maps each connecting node name → its token.
- `peers` — `{ <node>: { address, pins:[…], token, hub? } }`; `pins` is the accepted-fingerprint set, `hub:true` marks the relay.
- **Name match**: the hub's `peers` key = the spoke's `node`; the spoke's `accept.tokens` key = the hub's `node`; the `token` is identical on both sides.

## Rotation

- **Any net.json change needs a daemon restart** (config is read once at startup).
- **Cert (zero-downtime — `pins` is a set)**: add the new pin to the **dialer's** peer entry (the hub, for a hub→spoke link) → restart → swap the cert on the accepting side → remove the old pin → restart.
- **Token (single value, not zero-downtime)**: change it on both sides, restart both.
