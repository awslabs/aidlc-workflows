// The shipped `aidlc plugin build` makes a plugin under its author's names, in
// a catalogue of its own; only this repository's packager stamps ours as
// aidlc-test-pro and lists it in the one aidlc-plugins catalogue at the root of
// dist/plugins. So a shipped build of test-pro is the packager's tree with
// exactly those names (and on Kiro the folder named after them) put back to
// test-pro, plus that own catalogue. Tests compare the two through this one
// mapping.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readPluginTargets } from "../../dist/claude/.claude/tools/aidlc-plugin-emit.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const TARGETS = readPluginTargets(
  join(REPO_ROOT, "dist", "claude", ".claude", "tools", "data", "plugin-targets.json"),
);
const MANIFEST = JSON.parse(
  readFileSync(join(REPO_ROOT, "plugins", "test-pro", ".aidlc-plugin", "plugin.json"), "utf-8"),
) as { author: unknown; version: string; description: string };

const HOST_NAMED_FILES = new Set([
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".opencode-plugin/plugin.json",
  ".kiro/aidlc-plugins/test-pro/.kiro-plugin/plugin.json",
  ".kiro/hooks/aidlc-test-pro-compose.json",
]);

export function asShippedBuild(harness: string): (firstParty: Map<string, Buffer>) => Map<string, Buffer> {
  const target = TARGETS[harness];
  const pluginDir = target.kind === "kiro" || target.kind === "kiro-ide"
    ? `${target.harnessLeaf}/aidlc-plugins/test-pro/`
    : "";
  const ownCatalogue = `${JSON.stringify({
    name: "test-pro",
    owner: MANIFEST.author,
    description: "AIDLC plugin catalogue.",
    plugins: [{ name: "test-pro", source: ".", version: MANIFEST.version, description: MANIFEST.description }],
  }, null, 2)}\n`;
  return (firstParty) => {
    const out = new Map<string, Buffer>();
    for (const [name, bytes] of firstParty) {
      const path = name.replace(/^\.kiro\/aidlc-plugins\/aidlc-test-pro\//, ".kiro/aidlc-plugins/test-pro/");
      out.set(
        path,
        HOST_NAMED_FILES.has(path)
          ? Buffer.from(
            bytes.toString("utf-8")
              .replaceAll('"aidlc-test-pro"', '"test-pro"')
              .replaceAll(/aidlc-plugins\/aidlc-test-pro\b/g, "aidlc-plugins/test-pro"),
            "utf-8",
          )
          : bytes,
      );
    }
    out.set(`${pluginDir}${target.marketplaceDir}/marketplace.json`, Buffer.from(ownCatalogue, "utf-8"));
    return new Map([...out].sort(([left], [right]) => left.localeCompare(right)));
  };
}
