// t148-copilot-adapter-dispatch: the Copilot stdin shim routes each lifecycle
// event to the right core hook(s) with the right blocking semantics (data-flows
// §3, Flows 3.1/3.2/3.3 + system-architecture.md §4.1 Stop wiring).
//
// WHAT. Three dispatch contracts, each an observable behavior of the adapter as
// a subprocess:
//   - PreToolUse is BLOCKING: a core hook's exit 2 is forwarded as the adapter's
//     own exit 2 (with stderr), so VS Code refuses the tool call (Flow 3.1).
//   - PostToolUse is NON-BLOCKING: it is observability only — even if a core
//     hook exits non-zero, the adapter exits 0 (Flow 3.2).
//   - Stop calls aidlc-stop.ts FIRST (enforcement — its {"decision":"block"}
//     stdout + exit code are forwarded) THEN aidlc-session-end.ts (observability)
//     — in that order, and session-end never alters the stop decision (§4.1).
//
// The rig copies the authored adapter beside STUB core hooks that append to a
// SHARED ordered ledger (one line per invocation, in call order), so the test
// can assert both WHICH hooks fired and IN WHAT ORDER — without the generated
// dist/copilot/ tree or real core side effects.
//
// WHY SUBPROCESS. Blocking is an exit-code contract and ordering is a real
// call-sequence property; only a live subprocess exercises them faithfully.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

// A stub that appends its OWN name to the shared ordered ledger, optionally
// writes stdout/stderr, then exits `exitCode`. The ledger records call ORDER
// across all hooks in a single adapter run.
function stubHookBody(
  hookName: string,
  opts: { exitCode?: number; stdout?: string; stderr?: string } = {},
): string {
  const { exitCode = 0, stdout = "", stderr = "" } = opts;
  return [
    `await Bun.stdin.text();`,
    `const ledger = process.env.T148_LEDGER;`,
    `const { appendFileSync } = await import("node:fs");`,
    `if (ledger) appendFileSync(ledger, ${JSON.stringify(hookName)} + "\\n");`,
    stdout ? `process.stdout.write(${JSON.stringify(stdout)});` : ``,
    stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ``,
    `process.exit(${exitCode});`,
  ]
    .filter(Boolean)
    .join("\n");
}

interface Scratch {
  hooksDir: string;
  ledger: string;
  writeHook: (name: string, opts?: { exitCode?: number; stdout?: string; stderr?: string }) => void;
  order: () => string[];
  cleanup: () => void;
}

function scratch(): Scratch {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t148-")));
  const hooksDir = join(dir, ".github", "hooks");
  const ledger = join(dir, "ledger.txt");
  mkdirSync(hooksDir, { recursive: true });
  copyFileSync(ADAPTER_SRC, join(hooksDir, "aidlc-copilot-adapter.ts"));
  for (const hook of CORE_HOOKS) {
    writeFileSync(join(hooksDir, hook), stubHookBody(hook), "utf-8");
  }
  return {
    hooksDir,
    ledger,
    writeHook: (name, opts) =>
      writeFileSync(join(hooksDir, name), stubHookBody(name, opts), "utf-8"),
    order: () =>
      existsSync(ledger)
        ? readFileSync(ledger, "utf-8").split("\n").filter((l) => l.trim().length > 0)
        : [],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runAdapter(
  s: Scratch,
  target: string,
  payload: unknown,
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(
    process.execPath,
    [join(s.hooksDir, "aidlc-copilot-adapter.ts"), target],
    {
      cwd: dirname(dirname(s.hooksDir)),
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_PROJECT_DIR: undefined,
        CLAUDE_PROJECT_DIR: undefined,
        T148_LEDGER: s.ledger,
      } as NodeJS.ProcessEnv,
      timeout: 30_000,
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

describe("t148 Copilot adapter hook dispatch", () => {
  // --- PreToolUse is blocking (Flow 3.1) -------------------------------------

  test("1: PreToolUse allows (exit 0) when the guard allows", () => {
    const s = scratch();
    try {
      const r = runAdapter(s, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "runTerminalCommand",
        tool_input: { command: "echo hi" },
      });
      expect(r.code).toBe(0);
      // Bash runs BOTH pre-hooks in order: guard then reviewer-scope.
      expect(s.order()).toEqual([
        "aidlc-state-transition-guard.ts",
        "aidlc-reviewer-scope.ts",
      ]);
    } finally {
      s.cleanup();
    }
  });

  test("2: PreToolUse forwards a core exit-2 block (exit 2 + stderr) and short-circuits", () => {
    const s = scratch();
    try {
      s.writeHook("aidlc-state-transition-guard.ts", {
        exitCode: 2,
        stderr: "AIDLC: direct state transition is engine-owned",
      });
      const r = runAdapter(s, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "runTerminalCommand",
        tool_input: { command: "bun .github/tools/aidlc-state.ts reject x" },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("engine-owned");
      // The block short-circuits: reviewer-scope must NOT have run.
      expect(s.order()).toEqual(["aidlc-state-transition-guard.ts"]);
    } finally {
      s.cleanup();
    }
  });

  test("3: PreToolUse block from the SECOND pre-hook (reviewer-scope) is forwarded", () => {
    const s = scratch();
    try {
      s.writeHook("aidlc-reviewer-scope.ts", {
        exitCode: 2,
        stderr: "AIDLC: file outside reviewer read-scope",
      });
      const r = runAdapter(s, "pre-tool-use", {
        hook_event_name: "PreToolUse",
        tool_name: "runTerminalCommand",
        tool_input: { command: "cat other-unit/file" },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("read-scope");
      expect(s.order()).toEqual([
        "aidlc-state-transition-guard.ts",
        "aidlc-reviewer-scope.ts",
      ]);
    } finally {
      s.cleanup();
    }
  });

  // --- PostToolUse is non-blocking (Flow 3.2) --------------------------------

  test("4: PostToolUse is non-blocking — a core exit 2 does NOT block (adapter exits 0)", () => {
    const s = scratch();
    try {
      // Even a pathological non-zero audit-logger must not turn into a block.
      s.writeHook("aidlc-audit-logger.ts", { exitCode: 2, stderr: "noise" });
      const r = runAdapter(s, "post-tool-use", {
        hook_event_name: "PostToolUse",
        tool_name: "editFiles",
        tool_input: { filePath: "src/foo.ts" },
      });
      expect(r.code).toBe(0);
      // audit THEN sensor (Claude settings.json registration order).
      expect(s.order()).toEqual(["aidlc-audit-logger.ts", "aidlc-sensor-fire.ts"]);
    } finally {
      s.cleanup();
    }
  });

  test("5: PostToolUse Bash routes only to runtime-compile (no audit/sensor)", () => {
    const s = scratch();
    try {
      const r = runAdapter(s, "post-tool-use", {
        hook_event_name: "PostToolUse",
        tool_name: "runTerminalCommand",
        tool_input: { command: "bun test" },
      });
      expect(r.code).toBe(0);
      expect(s.order()).toEqual(["aidlc-runtime-compile.ts"]);
    } finally {
      s.cleanup();
    }
  });

  // --- Stop: enforcement THEN observability, in order (§4.1) -----------------

  test("6: Stop calls aidlc-stop.ts THEN aidlc-session-end.ts, in that order", () => {
    const s = scratch();
    try {
      const r = runAdapter(s, "stop", {
        hook_event_name: "Stop",
        stop_hook_active: false,
      });
      expect(r.code).toBe(0);
      expect(s.order()).toEqual(["aidlc-stop.ts", "aidlc-session-end.ts"]);
    } finally {
      s.cleanup();
    }
  });

  test("7: Stop forwards the enforcement {\"decision\":\"block\"} stdout verbatim", () => {
    const s = scratch();
    try {
      const decision = JSON.stringify({ decision: "block", reason: "work remains" });
      s.writeHook("aidlc-stop.ts", { stdout: `${decision}\n` });
      const r = runAdapter(s, "stop", { hook_event_name: "Stop" });
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { decision?: string; reason?: string };
      expect(out.decision).toBe("block");
      expect(out.reason).toBe("work remains");
      // session-end still runs AFTER the enforcement hook.
      expect(s.order()).toEqual(["aidlc-stop.ts", "aidlc-session-end.ts"]);
    } finally {
      s.cleanup();
    }
  });

  test("8: session-end does NOT override the stop decision even if it misbehaves", () => {
    const s = scratch();
    try {
      const decision = JSON.stringify({ decision: "block", reason: "keep going" });
      s.writeHook("aidlc-stop.ts", { stdout: `${decision}\n` });
      // A session-end that prints junk + exits non-zero must not leak into the
      // adapter's stdout or exit code (observability only).
      s.writeHook("aidlc-session-end.ts", { exitCode: 3, stdout: "SESSION-END-JUNK" });
      const r = runAdapter(s, "stop", { hook_event_name: "Stop" });
      expect(r.code).toBe(0); // stop's exit 0, not session-end's 3
      const out = JSON.parse(r.stdout) as { decision?: string };
      expect(out.decision).toBe("block");
      expect(r.stdout).not.toContain("SESSION-END-JUNK");
    } finally {
      s.cleanup();
    }
  });

  test("9: Stop with no enforcement output is a silent allow (exit 0, empty stdout)", () => {
    const s = scratch();
    try {
      const r = runAdapter(s, "stop", { hook_event_name: "Stop" });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
      // Both still fired (session-end is observability).
      expect(s.order()).toEqual(["aidlc-stop.ts", "aidlc-session-end.ts"]);
    } finally {
      s.cleanup();
    }
  });
});
