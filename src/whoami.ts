// `flbus whoami` — how this session's identity resolves. Agents branch on the first word:
// `claimed`/`registered` are addressable; `unregistered` is a basename fallback nobody can send to.
import { projectRoot, resolveIdentity } from "./lib";

export function run() {
  const cwd = projectRoot(process.cwd());
  const id = resolveIdentity(cwd);
  if (id.via === "claim") console.log(`claimed '${id.name}' — ${cwd}`);
  else if (id.via === "peer") console.log(`registered '${id.name}' — ${cwd}`);
  else console.log(`unregistered — resolving as basename '${id.name}' (${cwd}); peers and remote senders cannot address this dir. \`flbus register\` this project, or \`flbus claim <name>\`.`);
}
