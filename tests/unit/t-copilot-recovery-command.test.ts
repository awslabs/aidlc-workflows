// covers: none (the Copilot adapter's claim-recovery message)
//
// #1411: when the Copilot adapter could not match a command to current
// coordination evidence, it told the user to run a fresh
// `bun .aidlc/tools/aidlc-orchestrate.ts next`, a path a native install does
// not have. The message now renders the command the way the rest of the tree
// does: `aidlc engine orchestrate next` on a shipped install, the bun entry on
// a source checkout.

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function recoveryReason(tree: "dist" | "dist-release"): Promise<string> {
  const adapter = await import(join(REPO_ROOT, tree, "copilot", ".aidlc", "hooks", "aidlc-copilot-adapter.ts"));
  return adapter.copilotRecoveryReason();
}

describe("Copilot claim-recovery command (#1411)", () => {
  test("a shipped install names the aidlc command", async () => {
    const reason = await recoveryReason("dist-release");
    expect(reason).toContain("Run a fresh `aidlc engine orchestrate next`");
    expect(reason).not.toContain("aidlc-orchestrate.ts");
  });

  test("a source checkout names the bun entry that exists in it", async () => {
    const reason = await recoveryReason("dist");
    expect(reason).toContain("Run a fresh `bun .aidlc/tools/aidlc.ts engine orchestrate next`");
    expect(reason).not.toContain("aidlc-orchestrate.ts");
  });
});
