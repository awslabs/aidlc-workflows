// covers: subcommand:aidlc-utility:select-plugins, function:pinNamedHarness, cli:aidlc(engine plugin select)
//
// In a project that holds two installs, the native aidlc pins the first one
// (.claude) before any command runs. `plugin select --harness-dir <dir>` names
// the install to change, as `plugin sync` does, so the person's pick lands on
// the install they named and the other is left as it was. Without the flag,
// the pinned install is the one that changes, as before.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_RUNTIME_CASE_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

function selection(project: string, harnessDir: string): unknown {
  return (JSON.parse(readFileSync(join(project, harnessDir, "tools", "data", "harness.json"), "utf-8")) as { plugins?: unknown })
    .plugins ?? null;
}

// The native installs: the release trees, whose generated tables name the
// installed aidlc the same way in both.
function install(project: string, harness: string): void {
  mkdirSync(project, { recursive: true });
  cpSync(join(REPO_ROOT, "dist-release", harness), project, { recursive: true });
}

// The dispatcher with the harness pinned to .claude, as the compiled aidlc
// pins the first install it finds before the command runs.
function select(project: string, args: string[]) {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:AIDLC_|CLAUDE_|CLAUDECODE$|CODEX_|KIRO_|CURSOR_|OPENCODE|COPILOT_)/.test(key)));
  const r = spawnSync(process.execPath, [join(project, ".claude", "tools", "aidlc.ts"), "engine", "plugin", "select", ...args], {
    cwd: project,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_RUNTIME_CASE_TIMEOUT_MS),
    env: { ...env, AIDLC_HARNESS_DIR: ".claude", AIDLC_HARNESS_NAME: "claude" },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("t-plugin-select-harness-dir: plugin select changes the install the person names", () => {
  let tmp: string;
  let project: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "aidlc-select-harness-dir-"));
    project = join(tmp, "project");
    install(project, "claude");
    install(project, "kiro");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("--harness-dir .kiro changes Kiro's selection and leaves Claude Code's as it was", () => {
    const selected = select(project, ["aidlc", "--harness-dir", ".kiro"]);
    expect(selected.status, selected.out).toBe(0);
    expect(selected.out).toContain("Enabled plugins: aidlc");
    expect(selection(project, ".kiro")).toEqual(["aidlc"]);
    expect(selection(project, ".claude")).toBeNull();
  });

  test("with no --harness-dir the pinned install is the one that changes", () => {
    const selected = select(project, ["aidlc"]);
    expect(selected.status, selected.out).toBe(0);
    expect(selection(project, ".claude")).toEqual(["aidlc"]);
    expect(selection(project, ".kiro")).toBeNull();
  });
});
