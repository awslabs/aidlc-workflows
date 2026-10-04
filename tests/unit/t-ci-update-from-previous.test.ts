// covers: file:scripts/ci-update-from-previous.ts
// The update-from-the-last-release check finds each harness tree's hook
// commands and reads the hook phase trace to see that the engine ran them.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookCommands, tracedToCompletion } from "../../scripts/ci-update-from-previous.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "aidlc-update-from-previous-"));
  roots.push(root);
  return root;
}

function trace(dir: string, ...phases: object[]): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hook-1.ndjson"), phases.map((phase) => JSON.stringify(phase)).join("\n") + "\n");
  return dir;
}

describe("ci-update-from-previous helpers", () => {
  test("hook commands come from every JSON config in the tree, nested or not", () => {
    const tree = scratch();
    mkdirSync(join(tree, "hooks"), { recursive: true });
    writeFileSync(join(tree, "settings.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "aidlc engine hook continue-workflow" }] }] },
      statusLine: { command: "aidlc engine statusline" },
    }));
    // A Kiro IDE hook file, written as text: its "then" key is the hook's action.
    writeFileSync(join(tree, "hooks", "guard.kiro.hook"),
      '{"then":{"command":"aidlc engine adapter kiro state-transition-guard aidlc-developer-agent"},' +
        '"when":{"patterns":["aidlc engine adapter *"]}}');
    writeFileSync(join(tree, "hooks", "notes.md"), "aidlc engine hook session-start\n");
    writeFileSync(join(tree, "broken.json"), "{ not json");
    expect(hookCommands(tree)).toEqual([
      "aidlc engine adapter kiro state-transition-guard aidlc-developer-agent",
      "aidlc engine hook continue-workflow",
    ]);
    expect(hookCommands(join(tree, "missing"))).toEqual([]);
  });

  test("a hook ran when the engine started, loaded it, and every end it logged was code 0", () => {
    const root = scratch();
    expect(tracedToCompletion(trace(join(root, "a"),
      { phase: "dispatcher-start", hook: "session-start" }, { phase: "hook-import-end" }, { phase: "hook-run-end", code: 0 },
      { phase: "exit", code: 0 }))).toBe(true);
    // The human-turn hook runs its code in a child process.
    expect(tracedToCompletion(trace(join(root, "b"),
      { phase: "dispatcher-start", hook: "record-human-turn" }, { phase: "hook-child-started" }, { phase: "hook-run-end", code: 0 }))).toBe(true);
    expect(tracedToCompletion(trace(join(root, "c"),
      { phase: "dispatcher-start", adapter: "kiro" }, { phase: "adapter-import-end" }, { phase: "exit", code: 1 }))).toBe(false);
    expect(tracedToCompletion(trace(join(root, "d"), { phase: "dispatcher-start", hook: "x" }, { phase: "exit", code: 0 }))).toBe(false);
    expect(tracedToCompletion(join(root, "none"))).toBe(false);
  });
});
