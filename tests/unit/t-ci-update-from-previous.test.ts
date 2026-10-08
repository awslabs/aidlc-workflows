// covers: file:scripts/ci-update-from-previous.ts
// The update-from-the-last-release check finds each harness tree's hook
// commands and reads the hook phase trace to see that the engine ran them.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childEnvironment,
  hookCommands,
  hookInput,
  hooksTracedToCompletion,
  opencodeHookCommands,
  tracedToCompletion,
  uncheckedHarnesses,
} from "../../scripts/ci-update-from-previous.ts";

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

  test("opencode's hook commands come from its plugin, in the form the plugin starts them", () => {
    const tree = scratch();
    const plugin = join(tree, "aidlc-opencode-adapter.ts");
    writeFileSync(plugin, [
      'const PROJECTED_INVOKE = "aidlc";',
      'const TRUSTED_NAMESPACE = "engine";',
      "// chat.message -> aidlc-session-start.ts",
      'await runCore("aidlc-write-audit-log.ts", payload, directory);',
      "const result = await runCore(",
      '  "aidlc-session-start.ts",',
      "  input,",
      ");",
      'const message = "use aidlc-orchestrate.ts report instead";',
    ].join("\n"));
    expect(opencodeHookCommands(plugin)).toEqual([
      "aidlc engine hook session-start",
      "aidlc engine hook write-audit-log",
    ]);
    // A source tree that was never projected falls back the way the plugin does.
    writeFileSync(plugin, 'const PROJECTED_INVOKE = "{{INVOKE}}";\n  "aidlc-session-start.ts",\n');
    expect(opencodeHookCommands(plugin)).toEqual(["bun .aidlc/tools/aidlc.ts engine hook session-start"]);
    expect(opencodeHookCommands(join(tree, "missing.ts"))).toEqual([]);
  });

  test("a harness the release ships that the check does not set up is named", () => {
    const shipped = (names: string[]) => ({ distributions: names.map((name) => ({ name })) });
    expect(uncheckedHarnesses(shipped(["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"]))).toEqual([]);
    expect(uncheckedHarnesses(shipped(["claude", "newcli"]))).toEqual(["newcli"]);
    expect(uncheckedHarnesses({})).toEqual([]);
  });

  test("the releases under test get no GitHub, Actions or provider credentials", () => {
    const env = childEnvironment({
      PATH: "/usr/bin", HOME: "/home/runner", SystemRoot: "C:\\Windows", RUNNER_TEMP: "/tmp/r", GITHUB_REPOSITORY: "o/r",
      GH_TOKEN: "x", GITHUB_TOKEN: "x", ACTIONS_RUNTIME_TOKEN: "x", ACTIONS_ID_TOKEN_REQUEST_URL: "x",
      AWS_SECRET_ACCESS_KEY: "x", ANTHROPIC_API_KEY: "x", NPM_TOKEN: "x", SOME_PASSWORD: "x", OTHER_API_KEY: "x",
    });
    expect(Object.keys(env).sort()).toEqual(["GITHUB_REPOSITORY", "HOME", "PATH", "RUNNER_TEMP", "SystemRoot"]);
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
    // By name: what the plugin's events reached, each to its end.
    const both = trace(join(root, "e"), { phase: "dispatcher-start", hook: "session-start" }, { phase: "hook-import-end" },
      { phase: "exit", code: 0 });
    writeFileSync(join(both, "hook-2.ndjson"), [{ phase: "dispatcher-start", hook: "continue-workflow" }, { phase: "exit", code: 1 }]
      .map((phase) => JSON.stringify(phase)).join("\n"));
    expect([...hooksTracedToCompletion(both)]).toEqual(["session-start"]);
  });

  // Kiro IDE's shell-follow-up hooks are skipped before the engine loads when
  // nothing they read changed (#1946): that is the hook working, not failing.
  test("a hook the front gate skipped with code 0 ran to its end", () => {
    const root = scratch();
    const skip = (dir: string, code: number) => trace(join(root, dir),
      { phase: "dispatcher-start", adapter: "kiro-ide", target: "after-shell" },
      { phase: "adapter-front-gate-skip", target: "after-shell" },
      { phase: "exit", code });
    expect(tracedToCompletion(skip("a", 0))).toBe(true);
    expect(tracedToCompletion(skip("b", 1))).toBe(false);
  });

  // Kiro IDE always names the tool a PreToolUse guard checks; an empty payload
  // is one it never sends, and the guards rightly refuse it.
  test("Kiro IDE's tool-call guards get a tool call; every other hook an empty payload", () => {
    for (const target of ["guard-tool-call", "review-freeze", "state-transition-guard", "plan-approval-guard"]) {
      const input = JSON.parse(hookInput("kiro-ide", `aidlc engine adapter kiro-ide ${target}`));
      expect(input, target).toEqual({
        hook_event_name: "PreToolUse",
        tool_name: "execute_bash",
        tool_input: { command: "git status" },
      });
    }
    expect(hookInput("kiro-ide", "aidlc engine adapter kiro-ide after-shell")).toBe("{}");
    expect(hookInput("kiro", "aidlc engine adapter kiro guard-tool-call")).toBe("{}");
    expect(hookInput("claude", "aidlc engine hook review-freeze")).toBe("{}");
  });
});
