// t146-copilot-adapter-security: the Copilot stdin shim upholds its security
// contract (security/implementation-guidance.md §1.1, §3) — fail-open on bad
// input, and path confinement (RT-0002) against traversal / injection.
//
// WHAT. The adapter is the highest-security runtime component: it sits at the
// trust boundary between the VS Code Copilot platform and the core hook
// scripts. Its security properties (guidance §1.1) are:
//   - Fail-open on parse error   → exit 0, never 1/throw (ADR-002)
//   - Fail-open on unknown tool   → exit 0 (switch/tool-name default)
//   - Path confinement (RT-0002)  → a file_path resolving OUTSIDE the project
//                                    dir is not forwarded (dispatch skipped),
//                                    and the call is still allowed (fail-open)
//   - Exit-code forwarding         → a core hook's exit 2 is NOT suppressed
//
// The rig mirrors t145: the authored adapter is copied beside STUB core hooks
// that record their stdin, so the test can assert (a) the adapter's own exit
// code and (b) whether a core hook was reached — the observable security
// surface — without the generated dist/copilot/ tree or real core side effects.
//
// WHY SUBPROCESS. Fail-open is an EXIT-CODE contract; only a real subprocess
// exercises process.exit()/uncaught-throw behavior faithfully.

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

const TARGETS = [
  "session-start",
  "user-prompt-submit",
  "pre-tool-use",
  "post-tool-use",
  "pre-compact",
  "subagent-stop",
  "stop",
];

/** A recording stub: append stdin to <capture>/<hook>.jsonl, exit `exitCode`.
 *  Most stubs exit 0; a reviewer-scope stub can be seeded to exit 2 to prove
 *  the adapter forwards a deliberate block. */
function stubHookBody(hookName: string, exitCode = 0, stderr = ""): string {
  return [
    `const raw = await Bun.stdin.text();`,
    `const dir = process.env.T146_CAPTURE ?? ".";`,
    `const { appendFileSync } = await import("node:fs");`,
    `const { join } = await import("node:path");`,
    `appendFileSync(join(dir, ${JSON.stringify(`${hookName}.jsonl`)}), raw + "\\n");`,
    stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ``,
    `process.exit(${exitCode});`,
  ]
    .filter(Boolean)
    .join("\n");
}

function scratch(): { root: string; hooksDir: string; captureDir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t146-")));
  const hooksDir = join(dir, ".github", "hooks");
  const captureDir = join(dir, "capture");
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(captureDir, { recursive: true });
  copyFileSync(ADAPTER_SRC, join(hooksDir, "aidlc-copilot-adapter.ts"));
  for (const hook of CORE_HOOKS) {
    writeFileSync(join(hooksDir, hook), stubHookBody(hook), "utf-8");
  }
  return {
    root: dir,
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
      env: {
        ...process.env,
        AIDLC_PROJECT_DIR: undefined,
        CLAUDE_PROJECT_DIR: undefined,
        T146_CAPTURE: captureDir,
      } as NodeJS.ProcessEnv,
      timeout: 30_000,
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

function reached(captureDir: string, hookName: string): number {
  let names: string[];
  try {
    names = readdirSync(captureDir);
  } catch {
    return 0;
  }
  if (!names.includes(`${hookName}.jsonl`)) return 0;
  return readFileSync(join(captureDir, `${hookName}.jsonl`), "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
}

describe("t146 Copilot adapter security (fail-open + path confinement)", () => {
  // --- Fail-open on malformed stdin (guidance §1.1) --------------------------

  test("1: malformed JSON fails open (exit 0, no dispatch) on every target", () => {
    const s = scratch();
    try {
      for (const t of TARGETS) {
        const r = runAdapter(s.hooksDir, s.captureDir, t, "{ this is not json");
        expect(r.code).toBe(0);
      }
      // Nothing should have been dispatched to any core hook.
      for (const hook of CORE_HOOKS) expect(reached(s.captureDir, hook)).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("2: empty stdin fails open (exit 0) on every target", () => {
    const s = scratch();
    try {
      for (const t of TARGETS) {
        const r = runAdapter(s.hooksDir, s.captureDir, t, "");
        expect(r.code).toBe(0);
      }
    } finally {
      s.cleanup();
    }
  });

  // --- Fail-open on unknown / unmapped tool names (guidance §1.1) ------------

  test("3: an unmapped tool name allows without dispatch (pre-tool-use)", () => {
    const s = scratch();
    try {
      const r = runAdapter(s.hooksDir, s.captureDir, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "runNotebookCell", // not in the §4.1 map
        tool_input: { command: "rm -rf /" },
      });
      expect(r.code).toBe(0);
      expect(reached(s.captureDir, "aidlc-state-transition-guard.ts")).toBe(0);
      expect(reached(s.captureDir, "aidlc-reviewer-scope.ts")).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("4: an unmapped tool name is a clean no-op on post-tool-use", () => {
    const s = scratch();
    try {
      const r = runAdapter(s.hooksDir, s.captureDir, "post-tool-use", {
        hook_event_name: "PostToolUse",
        tool_name: "vscodeAPI",
        tool_input: { filePath: "x" },
      });
      expect(r.code).toBe(0);
      expect(reached(s.captureDir, "aidlc-audit-logger.ts")).toBe(0);
      expect(reached(s.captureDir, "aidlc-sensor-fire.ts")).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("5: an unknown target allows without dispatch (switch default)", () => {
    const s = scratch();
    try {
      const r = runAdapter(s.hooksDir, s.captureDir, "not-a-real-target", {
        hook_event_name: "PreToolUse",
        tool_name: "runTerminalCommand",
        tool_input: { command: "echo hi" },
      });
      expect(r.code).toBe(0);
      for (const hook of CORE_HOOKS) expect(reached(s.captureDir, hook)).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  // --- Path confinement (RT-0002, guidance §1.1/§3) --------------------------

  test("6: absolute file_path OUTSIDE the project is not forwarded (pre-tool-use)", () => {
    const s = scratch();
    try {
      const r = runAdapter(s.hooksDir, s.captureDir, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "editFiles",
        tool_input: { filePath: "/etc/passwd" },
      });
      // Fail-open: the tool call is still ALLOWED (exit 0) but the out-of-project
      // path never reaches a core hook.
      expect(r.code).toBe(0);
      expect(reached(s.captureDir, "aidlc-reviewer-scope.ts")).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("7: `..` traversal escaping the project is not forwarded (post-tool-use)", () => {
    const s = scratch();
    try {
      const r = runAdapter(s.hooksDir, s.captureDir, "post-tool-use", {
        hook_event_name: "PostToolUse",
        tool_name: "editFiles",
        tool_input: { filePath: "../../../../etc/shadow" },
      });
      expect(r.code).toBe(0);
      expect(reached(s.captureDir, "aidlc-audit-logger.ts")).toBe(0);
      expect(reached(s.captureDir, "aidlc-sensor-fire.ts")).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("8: an in-project relative file_path IS forwarded (confinement is not over-broad)", () => {
    const s = scratch();
    try {
      const r = runAdapter(s.hooksDir, s.captureDir, "post-tool-use", {
        hook_event_name: "PostToolUse",
        tool_name: "editFiles",
        tool_input: { filePath: "src/legit.ts" },
      });
      expect(r.code).toBe(0);
      expect(reached(s.captureDir, "aidlc-audit-logger.ts")).toBe(1);
    } finally {
      s.cleanup();
    }
  });

  test("9: a sibling-prefix path (projectDir + suffix, NOT a child) is rejected", () => {
    // Classic startsWith() confinement bug: "/tmp/proj-evil" starts with
    // "/tmp/proj" but is not inside it. The adapter joins with a path separator,
    // so this must be rejected.
    const s = scratch();
    try {
      const sibling = `${s.root}-evil/secret.ts`;
      const r = runAdapter(s.hooksDir, s.captureDir, "post-tool-use", {
        hook_event_name: "PostToolUse",
        tool_name: "editFiles",
        tool_input: { filePath: sibling },
      });
      expect(r.code).toBe(0);
      expect(reached(s.captureDir, "aidlc-audit-logger.ts")).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  // --- Command injection is inert: the command is DATA, never a shell ---------

  test("10: a shell-metachar command string is forwarded as an inert data field, not executed", () => {
    const s = scratch();
    try {
      const evil = "echo pwned > /tmp/t146-should-not-exist; rm -rf ~";
      runAdapter(s.hooksDir, s.captureDir, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "runTerminalCommand",
        tool_input: { command: evil },
      });
      // The guard stub received the command verbatim as a JSON string field —
      // the adapter spawns argv directly (no shell), so nothing was interpolated.
      const guard = readFileSync(
        join(s.captureDir, "aidlc-state-transition-guard.ts.jsonl"),
        "utf-8",
      );
      const parsed = JSON.parse(guard.trim()) as { tool_input: Record<string, unknown> };
      expect(parsed.tool_input.command).toBe(evil);
    } finally {
      s.cleanup();
    }
  });

  // --- Deliberate block (exit 2) IS forwarded, not swallowed ------------------

  test("11: a core-hook exit 2 (block) is forwarded with stderr; later pre-hooks are skipped", () => {
    const s = scratch();
    try {
      // Seed the state-transition guard to BLOCK. reviewer-scope must then never
      // run (the adapter returns on the first exit 2).
      writeFileSync(
        join(s.hooksDir, "aidlc-state-transition-guard.ts"),
        stubHookBody("aidlc-state-transition-guard.ts", 2, "blocked: engine-owned transition"),
        "utf-8",
      );
      const r = runAdapter(s.hooksDir, s.captureDir, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "runTerminalCommand",
        tool_input: { command: "bun .github/tools/aidlc-state.ts reject x" },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("blocked: engine-owned transition");
      // reviewer-scope is the SECOND Bash pre-hook — it must be short-circuited.
      expect(reached(s.captureDir, "aidlc-reviewer-scope.ts")).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("12: a non-2 core exit code is NOT propagated as a block (allow, exit 0)", () => {
    const s = scratch();
    try {
      // A crashed core hook (exit 1) must fail open — never mistaken for a block.
      writeFileSync(
        join(s.hooksDir, "aidlc-reviewer-scope.ts"),
        stubHookBody("aidlc-reviewer-scope.ts", 1, "boom"),
        "utf-8",
      );
      const r = runAdapter(s.hooksDir, s.captureDir, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "readFile",
        tool_input: { filePath: "src/foo.ts" },
      });
      expect(r.code).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  // --- Fail-open when a core hook is entirely absent (spawn failure) ----------

  test("13: a missing core hook binary fails open (spawn error → exit 0)", () => {
    const s = scratch();
    try {
      rmSync(join(s.hooksDir, "aidlc-mint-presence.ts"), { force: true });
      const r = runAdapter(s.hooksDir, s.captureDir, "user-prompt-submit", {
        hook_event_name: "UserPromptSubmit",
      });
      expect(r.code).toBe(0);
    } finally {
      s.cleanup();
    }
  });
});
