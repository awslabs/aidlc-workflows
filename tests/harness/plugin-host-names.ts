// The shipped `aidlc plugin build` makes a plugin under its author's names;
// only this repository's packager stamps ours as aidlc-test-pro in the
// aidlc-plugins catalogue. So a shipped build of test-pro is the packager's tree
// with exactly those names (and on Kiro the folder named after them) put back
// to test-pro. Tests compare the two through this one mapping.

const HOST_NAMED_FILES = new Set([
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".codex-plugin/plugin.json",
  ".agents/plugins/marketplace.json",
  ".plugin/plugin.json",
  ".plugin/marketplace.json",
  ".cursor-plugin/plugin.json",
  ".cursor-plugin/marketplace.json",
  ".opencode-plugin/plugin.json",
  ".opencode-plugin/marketplace.json",
  ".kiro/aidlc-plugins/test-pro/.kiro-plugin/plugin.json",
  ".kiro/aidlc-plugins/test-pro/.kiro-plugin/marketplace.json",
  ".kiro/hooks/aidlc-test-pro-compose.json",
]);

export function asShippedBuild(firstParty: Map<string, Buffer>): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const [name, bytes] of firstParty) {
    const path = name.replace(/^\.kiro\/aidlc-plugins\/aidlc-test-pro\//, ".kiro/aidlc-plugins/test-pro/");
    out.set(
      path,
      HOST_NAMED_FILES.has(path)
        ? Buffer.from(
          bytes.toString("utf-8")
            .replaceAll('"aidlc-test-pro"', '"test-pro"')
            .replaceAll('"aidlc-plugins"', '"test-pro"')
            .replaceAll("aidlc-plugins/aidlc-test-pro/", "aidlc-plugins/test-pro/"),
          "utf-8",
        )
        : bytes,
    );
  }
  return out;
}
