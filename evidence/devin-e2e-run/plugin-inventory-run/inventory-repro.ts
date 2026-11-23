import { discoverPluginInventory } from "../../core/tools/aidlc-plugin.ts";

const inv = discoverPluginInventory(process.argv[2] ?? ".devin");
console.log(JSON.stringify({
  capability: inv.capability,
  harness: inv.harness,
  installed: inv.installed.map((p) => `${p.key}@${p.version} ${p.manifestPath}`),
  invalid: inv.invalid.map((i) => i.message),
}, null, 2));
