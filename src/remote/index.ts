// `flbus remote <sub>` — the TLS transport surface. Config lives in ~/.flbus/net.json (hand-edited;
// shape + cert commands in the ops doc). Address a remote as project[:mailbox]@node.
//   status                     node, links, outbox, daemon state
//   daemon [status|stop|disable|enable|run]
//   giveup <id> | --to <node>  force the give-up transition on stalled outbox entries (→ unconfirmed report)
//   check                      validate net.json and say exactly what is wrong
import { NET_PATH, clearEntry, depositReport, foldName, idSendMs, loadNet, outboxList } from "./net";
import { run as daemon } from "./daemon";

export function run(args: string[]) {
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === "status" || sub === undefined) return daemon(["status"]);
  if (sub === "daemon") return daemon(rest);

  if (sub === "check") {
    try {
      const cfg = loadNet();
      if (!cfg) { console.log(`no net config — create ${NET_PATH} (see the ops doc for the shape)`); return; }
      const peers = Object.keys(cfg.peers ?? {});
      console.log(`ok: node '${cfg.node}'${cfg.hub ? " (hub)" : ""} mode ${cfg.mode ?? "manual"}`);
      if (cfg.accept) console.log(`  accepts on :${cfg.accept.port} for [${Object.keys(cfg.accept.tokens).join(", ")}]`);
      if (peers.length) console.log(`  connects to: ${peers.map(n => `${n}@${cfg.peers![n].address}${cfg.peers![n].hub ? " (hub)" : ""}`).join(", ")}`);
      if (cfg.hubNode) console.log(`  hub (inbound): ${cfg.hubNode}`);
      return;
    } catch (e) { console.error(`${(e as Error).message}`); process.exit(1); }
  }

  if (sub === "giveup") {
    const toIdx = rest.indexOf("--to");
    const node = toIdx >= 0 ? rest[toIdx + 1] : undefined;
    const id = toIdx < 0 ? rest[0] : undefined;
    if (!id && !node) { console.error("usage: flbus remote giveup <id> | --to <node>"); process.exit(1); }
    let n = 0;
    for (const e of outboxList()) {
      if (id && e.msg.id !== id) continue;
      if (node && foldName(e.msg.dest) !== foldName(node)) continue; // giveup is the wedged outbox's exit — a case mismatch must not disable it
      // the normal give-up transition, run now: report first (the entry is the report's regenerator), then clear
      const kind = e.state === "sent" ? "unconfirmed" : "undelivered";
      try { depositReport(e.msg, kind, `given up by hand after ${Math.round((Date.now() - idSendMs(e.msg.id)) / 60_000)}m`); }
      catch (err) { console.error(`report for ${e.msg.id} failed — entry kept: ${(err as Error).message}`); continue; }
      clearEntry(e.msg.id);
      n++;
      console.log(`gave up ${e.msg.id} -> ${e.msg.project}:${e.msg.mailbox}@${e.msg.dest} (${kind}${e.state === "sent" ? "; a copy may still land" : ""})`);
    }
    if (!n) console.log("no matching outbox entries");
    return;
  }

  if (sub === "my-address" || sub === "accept" || sub === "pull-stream") {
    console.error(`'remote ${sub}' belonged to the removed ssh transport — remote messaging is now TLS via ${NET_PATH}; see \`flbus remote check\``);
    process.exit(1);
  }

  console.error("usage: flbus remote [status] | daemon [...] | giveup <id>|--to <node> | check");
  process.exit(1);
}
