// covers: file:harness/claude/settings.json, file:scripts/package.ts, hook:aidlc-plan-approval-guard
// Execute the shipped command through Claude's shell syntax, not a direct
// absolute-path spawn that would hide a relative hook entry-point regression.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";
import {
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  createTestProject,
  REPO_ROOT,
  seededStateFile,
} from "../harness/fixtures.ts";

interface Settings {
  hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
  statusLine: { command: string };
}

function settings(channel: "dist" | "dist-release"): Settings {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, channel, "claude", ".claude", "settings.json"), "utf-8"),
  );
}

const SOURCE_ENTRY = 'bun "$CLAUDE_PROJECT_DIR/.claude/tools/aidlc.ts"';

describe("Claude hook project-root anchoring", () => {
  test("every source hook and statusline anchors its entry; native preserves routes without Bun", () => {
    const source = settings("dist");
    const native = settings("dist-release");
    const expectedNative: Settings = JSON.parse(JSON.stringify(source));
    const commands = Object.values(expectedNative.hooks)
      .flatMap((groups) => groups.flatMap((group) => group.hooks));
    commands.push(expectedNative.statusLine);
    expect(commands.length).toBeGreaterThan(1);
    for (const hook of commands) {
      expect(hook.command.startsWith(`${SOURCE_ENTRY} engine `), hook.command).toBe(true);
      hook.command = `aidlc${hook.command.slice(SOURCE_ENTRY.length)}`;
    }
    expect(native.hooks).toEqual(expectedNative.hooks);
    expect(native.statusLine).toEqual(expectedNative.statusLine);
  });

  test("actual source guard loads from a nested cwd with a spaced root; reads pass and writes block", () => {
    const original = createTestProject();
    const project = `${original} project with spaces`;
    renameSync(original, project);
    try {
      cpSync(AIDLC_SRC, join(project, ".claude"), { recursive: true });
      const cwd = join(project, "app", "nested directory");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, "source.ts"), "export const value = 1;\n");
      const state = `# AI-DLC State Tracking

## Project Information
- **Project**: hook entry regression
- **Scope**: poc

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
`;
      writeFileSync(seededStateFile(project), state);
      writeActiveDirectiveMarker(project, {
        kind: "run-stage",
        stage: "code-generation",
        state_sha256: stateDigest(state),
      });
      const hooks = settings("dist").hooks.PreToolUse
        .filter((group) => new RegExp(`^(?:${group.matcher})$`).test("Bash"))
        .flatMap((group) => group.hooks);
      const entry = hooks.find((hook) => hook.command.endsWith(" engine hook plan-approval-guard"));
      expect(entry).toBeDefined();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_PROJECT_DIR: project,
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
      };
      delete env.AIDLC_PROJECT_DIR;
      delete env.AIDLC_DISABLE_PLAN_APPROVAL_GUARD;
      const run = (command: string) => spawnSync(
        "bash",
        // Check that the configured command leaves the calling shell's cwd
        // intact as well as preserving the hook's exit code and stdin.
        [
          "-c",
          `${entry?.command}\nhook_status=$?\nbun -e 'console.log(process.cwd())'\nexit "$hook_status"`,
        ],
        {
          cwd,
          env,
          input: JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command },
            cwd,
          }),
          encoding: "utf-8",
          timeout: 15_000,
        },
      );
      const read = run("cat source.ts");
      expect(read.error).toBeUndefined();
      expect(read.status, read.stderr).toBe(0);
      expect(read.stdout.trim()).toBe(cwd);
      const blocked = run("printf changed > source.ts");
      expect(blocked.error).toBeUndefined();
      expect(blocked.status, blocked.stderr).toBe(2);
      expect(blocked.stderr).toContain("Approve Plan");
      expect(blocked.stderr).toContain(join(cwd, "source.ts"));
      expect(blocked.stdout.trim()).toBe(cwd);
      expect(readFileSync(join(cwd, "source.ts"), "utf-8")).toBe("export const value = 1;\n");
      // The hook also loads for a cd-to-root recovery attempt. Preserve the
      // guard's existing refusal of this mutation-capable compound command.
      const rootRelative = relative(cwd, project).split("\\").join("/");
      const recover = run(`cd "${rootRelative}" && pwd`);
      expect(recover.status, recover.stderr).toBe(2);
      expect(recover.stderr).toContain("Code generation cannot run mutation-capable shell command");
      expect(recover.stderr).not.toContain("Module not found");
      expect(recover.stdout.trim()).toBe(cwd);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);
});
