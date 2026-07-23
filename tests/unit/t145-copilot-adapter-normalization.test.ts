// t145-copilot-adapter-normalization: the Copilot stdin shim normalizes every
// Copilot-native tool name and camelCase tool_input key into the core hooks'
// ClaudeCodeHookInput contract before dispatch.
//
// WHAT. The adapter (harness/copilot/hooks/aidlc-copilot-adapter.ts) is a
// subprocess shim: VS Code Copilot spawns `bun aidlc-copilot-adapter.ts
// <target>` with a JSON payload on stdin, and the adapter maps the payload to
// the shape the byte-shared core hooks read, then subprocess-pipes it into the
// named core hook (via process.execPath) resolved FROM ITS OWN DIRECTORY. So a
// hermetic rig copies the authored adapter into a scratch dir beside a set of
// STUB core hooks that do exactly one thing — echo their argv[?]-less stdin to
// a capture file — and asserts the bytes the adapter forwarded. This contracts
// the normalization surface (§4.1 tool-name table + camelCase→snake_case)
// WITHOUT depending on the generated dist/copilot/ tree (built in a later step)
// or on core-hook side effects (those are covered by t149/t147).
//
// Every row of the system-architecture.md §4.1 mapping table is exercised:
//   runTerminalCommand → Bash, editFiles → Edit, createFile → Write,
//   readFile → Read, listDirectory → LS, fileSearch → Glob, textSearch → Grep,
//   applyPatch → Edit. Plus filePath → file_path key normalization.
//
// WHY SUBPROCESS. The adapter IS a subprocess shim — in-process testing would
// bypass the exact stdin/argv/exit-code surface being contracted. (Same idiom
// as the Codex t149 and Kiro t147 adapter suites.)

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADAPTER_SRC = join(
  REPO_ROOT,
  "harness",
  "copilot",
  "hooks",
  "aidlc-copilot-adapter.ts",
);

// Every core hook the adapter can dispatch to. Each stub records the stdin it
// received (one file per hook) so the test can assert normalization + which
// hook(s) fired in which order.
const CORE_HOOKS = [
  "aidlc-session-start.ts",
  "aidlc-mint-presence.ts",
  "aidlc-state-transition-guard.ts",
  "aidlc-reviewer-scope.ts",
  "aidlc-audit-logger.ts",
  "aidlc-sensor-fire.ts",
  "aidlc-runtime-compile.ts",
  "aidlc-validate-state.ts",
  "aidlc-log-subagent.ts",
  "aidlc-stop.ts",
  "aidlc-session-end.ts",
];

/** A stub core hook: append its raw stdin to <capture>/<hookName>.jsonl (one
 *  JSON line per invocation), then exit 0. The capture dir is passed via env so
 *  concurrent scratch projects never cross-write. */
function stubHookBody(hookName: string): string {
  return [
    `const raw = await Bun.stdin.text();`,
    `const dir = process.env.T145_CAPTURE ?? ".";`,
    `const { appendFileSync } = await import("node:fs");`,
    `const { join } = await import("node:path");`,
    `appendFileSync(join(dir, ${JSON.stringify(`${hookName}.jsonl`)}), raw + "\\n");`,
    `process.exit(0);`,
  ].join("\n");
}

/** Build a scratch project: the authored adapter + stub core hooks beside it,
 *  and an isolated capture dir. Returns { hooksDir, captureDir, cleanup }. */
function scratch(): { hooksDir: string; captureDir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t145-")));
  const hooksDir = join(dir, ".github", "hooks");
  const captureDir = join(dir, "capture");
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(captureDir, { recursive: true });
  copyFileSync(ADAPTER_SRC, join(hooksDir, "aidlc-copilot-adapter.ts"));
  for (const hook of CORE_HOOKS) {
    writeFileSync(join(hooksDir, hook), stubHookBody(hook), "utf-8");
  }
  return {
    hooksDir,
    captureDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runAdapter(
  hooksDir: string,
  captureDir: string,
  target: string,
  payload: unknown,
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(
    process.execPath,
    [join(hooksDir, "aidlc-copilot-adapter.ts"), target],
    {
      cwd: dirname(dirname(hooksDir)),
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf-8",
      // Strip inherited project-dir envs so the adapter resolves the scratch
      // project from the payload cwd; pass the capture dir to the stubs.
      env: {
        ...process.env,
        AIDLC_PROJECT_DIR: undefined,
        CLAUDE_PROJECT_DIR: undefined,
        T145_CAPTURE: captureDir,
      } as NodeJS.ProcessEnv,
      timeout: 30_000,
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

/** Read the captured stdin lines a given stub hook received (parsed JSON). */
function captured(captureDir: string, hookName: string): Array<Record<string, unknown>> {
  const file = join(captureDir, `${hookName}.jsonl`);
  let names: string[];
  try {
    names = readdirSync(captureDir);
  } catch {
    return [];
  }
  if (!names.includes(`${hookName}.jsonl`)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("t145 Copilot adapter tool-name + property normalization", () => {
  // --- Every §4.1 mapping-table row, on the target that dispatches it ---------
  //
  // Each row is proven by the tool_name the STUB core hook actually received
  // (post-normalization), sourced from a Copilot-native payload.

  test("1: runTerminalCommand → Bash (pre-tool-use → state-transition-guard)", () => {
    const s = scratch();
    try {
      runAdapter(s.hooksDir, s.captureDir, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "runTerminalCommand",
        tool_input: { command: "echo hi" },
      });
      const guard = captured(s.captureDir, "aidlc-state-transition-guard.ts");
      expect(guard.length).toBe(1);
      expect(guard[0].tool_name).toBe("Bash");
      expect((guard[0].tool_input as Record<string, unknown>).command).toBe("echo hi");
    } finally {
      s.cleanup();
    }
  });

  test("2: editFiles → Edit + filePath → file_path (post-tool-use → audit-logger)", () => {
    const s = scratch();
    try {
      runAdapter(s.hooksDir, s.captureDir, "post-tool-use", {
        hook_event_name: "PostToolUse",
        tool_name: "editFiles",
        tool_input: { filePath: "src/foo.ts" },
      });
      const audit = captured(s.captureDir, "aidlc-audit-logger.ts");
      expect(audit.length).toBe(1);
      expect(audit[0].tool_name).toBe("Edit");
      const ti = audit[0].tool_input as Record<string, unknown>;
      // camelCase filePath normalized to snake_case file_path…
      expect(typeof ti.file_path).toBe("string");
      expect(ti.file_path).toContain("src/foo.ts");
      // …and the camelCase key is gone.
      expect(ti.filePath).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });

  test("3: createFile → Write (post-tool-use → audit-logger + sensor-fire)", () => {
    const s = scratch();
    try {
      runAdapter(s.hooksDir, s.captureDir, "post-tool-use", {
        hook_event_name: "PostToolUse",
        tool_name: "createFile",
        tool_input: { filePath: "src/new.ts" },
      });
      const audit = captured(s.captureDir, "aidlc-audit-logger.ts");
      const sensor = captured(s.captureDir, "aidlc-sensor-fire.ts");
      expect(audit.length).toBe(1);
      expect(sensor.length).toBe(1);
      expect(audit[0].tool_name).toBe("Write");
      expect(sensor[0].tool_name).toBe("Write");
    } finally {
      s.cleanup();
    }
  });

  test("4: readFile → Read (pre-tool-use → reviewer-scope only)", () => {
    const s = scratch();
    try {
      runAdapter(s.hooksDir, s.captureDir, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "readFile",
        tool_input: { filePath: "src/foo.ts" },
      });
      const scope = captured(s.captureDir, "aidlc-reviewer-scope.ts");
      expect(scope.length).toBe(1);
      expect(scope[0].tool_name).toBe("Read");
      expect((scope[0].tool_input as Record<string, unknown>).file_path).toContain("src/foo.ts");
      // A Read is not a Bash → the state-transition guard must NOT fire.
      expect(captured(s.captureDir, "aidlc-state-transition-guard.ts").length).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("5: listDirectory → LS (pre-tool-use → reviewer-scope)", () => {
    const s = scratch();
    try {
      runAdapter(s.hooksDir, s.captureDir, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "listDirectory",
        tool_input: { path: "src" },
      });
      const scope = captured(s.captureDir, "aidlc-reviewer-scope.ts");
      expect(scope.length).toBe(1);
      expect(scope[0].tool_name).toBe("LS");
    } finally {
      s.cleanup();
    }
  });

  test("6: fileSearch → Glob (pre-tool-use → reviewer-scope)", () => {
    const s = scratch();
    try {
      runAdapter(s.hooksDir, s.captureDir, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "fileSearch",
        tool_input: { pattern: "**/*.ts" },
      });
      const scope = captured(s.captureDir, "aidlc-reviewer-scope.ts");
      expect(scope.length).toBe(1);
      expect(scope[0].tool_name).toBe("Glob");
      expect((scope[0].tool_input as Record<string, unknown>).pattern).toBe("**/*.ts");
    } finally {
      s.cleanup();
    }
  });

  test("7: textSearch → Grep (pre-tool-use → reviewer-scope)", () => {
    const s = scratch();
    try {
      runAdapter(s.hooksDir, s.captureDir, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "textSearch",
        tool_input: { pattern: "TODO" },
      });
      const scope = captured(s.captureDir, "aidlc-reviewer-scope.ts");
      expect(scope.length).toBe(1);
      expect(scope[0].tool_name).toBe("Grep");
    } finally {
      s.cleanup();
    }
  });

  test("8: applyPatch → Edit, fanned out per Add/Update file in the envelope", () => {
    const s = scratch();
    try {
      const patch = [
        "*** Begin Patch",
        "*** Add File: src/added.ts",
        "+export const a = 1;",
        "*** Update File: src/changed.ts",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n");
      runAdapter(s.hooksDir, s.captureDir, "post-tool-use", {
        hook_event_name: "PostToolUse",
        tool_name: "applyPatch",
        tool_input: { patch },
      });
      const audit = captured(s.captureDir, "aidlc-audit-logger.ts");
      const sensor = captured(s.captureDir, "aidlc-sensor-fire.ts");
      // One audit + one sensor pass per touched file (2 files).
      expect(audit.length).toBe(2);
      expect(sensor.length).toBe(2);
      for (const row of audit) expect(row.tool_name).toBe("Edit");
      const paths = audit.map((r) => (r.tool_input as Record<string, unknown>).file_path);
      expect(paths.some((p) => String(p).endsWith("src/added.ts"))).toBe(true);
      expect(paths.some((p) => String(p).endsWith("src/changed.ts"))).toBe(true);
    } finally {
      s.cleanup();
    }
  });

  test("9: runTerminalCommand → Bash on post-tool-use routes to runtime-compile", () => {
    const s = scratch();
    try {
      runAdapter(s.hooksDir, s.captureDir, "post-tool-use", {
        hook_event_name: "PostToolUse",
        tool_name: "runTerminalCommand",
        tool_input: { command: "bun x" },
      });
      const compile = captured(s.captureDir, "aidlc-runtime-compile.ts");
      expect(compile.length).toBe(1);
      expect(compile[0].tool_name).toBe("Bash");
      // Not an edit → audit/sensor must not fire.
      expect(captured(s.captureDir, "aidlc-audit-logger.ts").length).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("10: session-start forwards source + session_id; stdout is passed through", () => {
    const s = scratch();
    try {
      // A stub session-start that emits an additionalContext payload so we can
      // assert the adapter forwards stdout verbatim. Overwrite the plain stub.
      writeFileSync(
        join(s.hooksDir, "aidlc-session-start.ts"),
        [
          `const raw = await Bun.stdin.text();`,
          `const dir = process.env.T145_CAPTURE ?? ".";`,
          `const { appendFileSync } = await import("node:fs");`,
          `const { join } = await import("node:path");`,
          `appendFileSync(join(dir, "aidlc-session-start.ts.jsonl"), raw + "\\n");`,
          `process.stdout.write(JSON.stringify({ additionalContext: "CTX" }) + "\\n");`,
          `process.exit(0);`,
        ].join("\n"),
        "utf-8",
      );
      const r = runAdapter(s.hooksDir, s.captureDir, "session-start", {
        hook_event_name: "SessionStart",
        source: "resume",
        session_id: "sess-42",
      });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).additionalContext).toBe("CTX");
      const start = captured(s.captureDir, "aidlc-session-start.ts");
      expect(start.length).toBe(1);
      expect(start[0].source).toBe("resume");
      expect(start[0].session_id).toBe("sess-42");
    } finally {
      s.cleanup();
    }
  });

  test("11: user-prompt-submit mints presence via aidlc-mint-presence.ts", () => {
    const s = scratch();
    try {
      const r = runAdapter(s.hooksDir, s.captureDir, "user-prompt-submit", {
        hook_event_name: "UserPromptSubmit",
      });
      expect(r.code).toBe(0);
      expect(captured(s.captureDir, "aidlc-mint-presence.ts").length).toBe(1);
    } finally {
      s.cleanup();
    }
  });

  test("12: subagent-stop forwards agent identity to log-subagent", () => {
    const s = scratch();
    try {
      runAdapter(s.hooksDir, s.captureDir, "subagent-stop", {
        hook_event_name: "SubagentStop",
        agent_type: "aidlc-architect-agent",
        agent_id: "call-7",
      });
      const log = captured(s.captureDir, "aidlc-log-subagent.ts");
      expect(log.length).toBe(1);
      expect(log[0].agent_type).toBe("aidlc-architect-agent");
      expect(log[0].agent_id).toBe("call-7");
    } finally {
      s.cleanup();
    }
  });

  test("13: pre-compact routes to validate-state", () => {
    const s = scratch();
    try {
      const r = runAdapter(s.hooksDir, s.captureDir, "pre-compact", {
        hook_event_name: "PreCompact",
      });
      expect(r.code).toBe(0);
      expect(captured(s.captureDir, "aidlc-validate-state.ts").length).toBe(1);
    } finally {
      s.cleanup();
    }
  });
});
