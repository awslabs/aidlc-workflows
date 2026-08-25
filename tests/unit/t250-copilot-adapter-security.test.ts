// t250-copilot-adapter-security: the Copilot stdin shim upholds its security
// contract — fail-open on bad input, path confinement (RT-0002) against
// traversal / injection, and faithful forwarding of a deliberate block.
//
// Ported from PR #680's t146 onto THIS fork's PR #657 adapter, whose contract
// differs in load-bearing ways the assertions here respect:
//   - Targets use the purpose-based names (record-human-turn / guard-tool-call / post-tool /
//     validate-state / subagent-start / log-subagent / session-{start,end} /
//     continue-workflow), not host event names.
//   - Tool NAMES are #657's live-captured aliases (run_in_terminal,
//     insert_edit_into_file, read_file, ...), normalized to Bash/Edit/Read.
//   - The guard-tool-call BLOCK channel is stdout deny-JSON at exit 0 (difference #4
//     in the adapter header), NOT exit 2 — so test 11 asserts the
//     permissionDecision:"deny" projection, not a propagated exit code.
//   - The engine ships at .aidlc/{hooks,tools} (the opencode layout): the
//     adapter statically imports ../tools/aidlc-{audit,lib}.ts, so the rig
//     mirrors that sibling layout with stub tools.
//
// WHAT (guidance §1.1/§3): advisory fail-open on parse error and unknown tool
// (exit 0, never throw), Stop dispatch despite malformed input, realpath-based
// path confinement, locked subagent identity transactions, and exit-code
// forwarding (a core hook's exit 2 becomes the deny projection, a non-2 does
// not).
//
// WHY SUBPROCESS. Fail-open is an exit-code contract; only a real subprocess
// exercises process.exit()/uncaught-throw faithfully.
//
// covers: file:hooks/aidlc-reviewer-scope.ts, file:hooks/aidlc-state-transition-guard.ts, file:hooks/aidlc-plan-approval-guard.ts, file:hooks/aidlc-review-freeze.ts, file:hooks/aidlc-write-audit-log.ts

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADAPTER_SRC = join(
  REPO_ROOT,
  "harness",
  "copilot",
  "hooks",
  "aidlc-copilot-adapter.ts",
);

// Core hooks the #657 adapter subprocess-dispatches (from its switch).
const CORE_HOOKS = [
  "aidlc-session-start.ts",
  "aidlc-session-end.ts",
  "aidlc-deliver-stage-rules.ts",
  "aidlc-plan-approval-guard.ts",
  "aidlc-review-freeze.ts",
  "aidlc-state-transition-guard.ts",
  "aidlc-reviewer-scope.ts",
  "aidlc-write-audit-log.ts",
  "aidlc-run-sensors.ts",
  "aidlc-rebuild-stage-graph.ts",
  "aidlc-validate-state.ts",
  "aidlc-log-subagent.ts",
  "aidlc-continue-workflow.ts",
];

// #657 dispatch targets (aidlc.json wires the adapter with one of these).
const TARGETS = [
  "session-start",
  "record-human-turn",
  "guard-tool-call",
  "post-tool",
  "validate-state",
  "subagent-start",
  "log-subagent",
  "continue-workflow",
];

/** A recording stub: append stdin to <capture>/<hook>.jsonl, exit `exitCode`.
 *  A guard stub can be seeded to exit 2 (+stderr) to prove the adapter projects
 *  a deliberate block into the Copilot deny dialect. */
function stubHookBody(hookName: string, exitCode = 0, stderr = ""): string {
  return [
    `const raw = await Bun.stdin.text();`,
    `const dir = process.env.T250_CAPTURE ?? ".";`,
    `const { appendFileSync } = await import("node:fs");`,
    `const { join } = await import("node:path");`,
    `appendFileSync(join(dir, ${JSON.stringify(`${hookName}.jsonl`)}), raw + "\\n");`,
    stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ``,
    `process.exit(${exitCode});`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Minimal stubs for the adapter's two static tool imports (../tools/*). The
// record-human-turn reads stateFilePath() + appendAuditEntry(); neither is a security
// surface here, so the stubs are inert (state file absent → no append).
const AUDIT_TOOL_STUB = `export function appendAuditEntry(_k: string, _d: unknown, _p: string): void {}\n`;
const LIB_TOOL_STUB = `import { join } from "node:path";
export function stateFilePath(projectDir: string): string {
  return join(projectDir, ".aidlc-state-absent.json");
}
export function claimCopilotCommand(): { allowed: true; attemptId: string } {
  return { allowed: true, attemptId: "00000000-0000-4000-8000-000000000001" };
}
export function settleCopilotCommand(): string { return "settled"; }
export function settleCopilotIntentBoundary(): boolean { return false; }
export function recordCopilotHumanSequence(): boolean { return true; }\n`;

interface Scratch {
  projectRoot: string;
  hooksDir: string;
  captureDir: string;
  ledgerPath: string;
  cleanup: () => void;
}

function scratch(): Scratch {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "t250-")));
  // Mirror the shipped .aidlc/{hooks,tools} sibling layout.
  const hooksDir = join(projectRoot, ".aidlc", "hooks");
  const toolsDir = join(projectRoot, ".aidlc", "tools");
  const captureDir = join(projectRoot, "capture");
  const ledgerPath = join(
    tmpdir(),
    `aidlc-copilot-subagents-${createHash("sha256").update(projectRoot).digest("hex").slice(0, 16)}.json`,
  );
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(toolsDir, { recursive: true });
  mkdirSync(captureDir, { recursive: true });
  copyFileSync(ADAPTER_SRC, join(hooksDir, "aidlc-copilot-adapter.ts"));
  writeFileSync(join(toolsDir, "aidlc-audit.ts"), AUDIT_TOOL_STUB, "utf-8");
  writeFileSync(join(toolsDir, "aidlc-lib.ts"), LIB_TOOL_STUB, "utf-8");
  for (const hook of CORE_HOOKS) {
    writeFileSync(join(hooksDir, hook), stubHookBody(hook), "utf-8");
  }
  return {
    projectRoot,
    hooksDir,
    captureDir,
    ledgerPath,
    cleanup: () => {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(ledgerPath, { force: true });
      rmSync(`${ledgerPath}.lock`, { recursive: true, force: true });
    },
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
      // projectDir resolves to process.cwd() when AIDLC_PROJECT_DIR is unset,
      // so the project root IS the confinement boundary.
      cwd: s.projectRoot,
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_PROJECT_DIR: undefined,
        CLAUDE_PROJECT_DIR: undefined,
        T250_CAPTURE: s.captureDir,
      } as NodeJS.ProcessEnv,
      timeout: 30_000,
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

async function runAdapterAsync(
  s: Scratch,
  target: string,
  payload: unknown,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(
    [process.execPath, join(s.hooksDir, "aidlc-copilot-adapter.ts"), target],
    {
      cwd: s.projectRoot,
      stdin: Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        AIDLC_PROJECT_DIR: undefined,
        CLAUDE_PROJECT_DIR: undefined,
        T250_CAPTURE: s.captureDir,
      } as NodeJS.ProcessEnv,
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
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

function capturedInputs(
  captureDir: string,
  hookName: string,
): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(captureDir, `${hookName}.jsonl`), "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

interface LedgerEntry {
  hostSessionId: string;
  subagentId: string;
  name: string;
}

function ledgerEntries(s: Scratch): LedgerEntry[] {
  try {
    return JSON.parse(readFileSync(s.ledgerPath, "utf-8")) as LedgerEntry[];
  } catch {
    return [];
  }
}

describe("t250 Copilot adapter security (fail-open + path confinement)", () => {
  // --- Fail-open on malformed stdin (guidance §1.1) --------------------------

  test("1: malformed JSON dispatches Stop enforcement while advisory targets fail open", () => {
    const s = scratch();
    try {
      for (const t of TARGETS) {
        const r = runAdapter(s, t, "{ this is not json");
        expect(r.code).toBe(0);
      }
      for (const hook of CORE_HOOKS.filter((name) => name !== "aidlc-continue-workflow.ts")) {
        expect(reached(s.captureDir, hook)).toBe(0);
      }
      expect(reached(s.captureDir, "aidlc-continue-workflow.ts")).toBe(1);
      expect(readFileSync(join(s.captureDir, "aidlc-continue-workflow.ts.jsonl"), "utf-8")).toBe(
        "{ this is not json\n",
      );
    } finally {
      s.cleanup();
    }
  });

  test("2: empty stdin fails open (exit 0) on every target", () => {
    const s = scratch();
    try {
      for (const t of TARGETS) {
        const r = runAdapter(s, t, "");
        expect(r.code).toBe(0);
      }
    } finally {
      s.cleanup();
    }
  });

  // --- Fail-open on unknown / unmapped tool names (guidance §1.1) ------------

  test("3: an unmapped tool name allows without dispatch (guard-tool-call)", () => {
    const s = scratch();
    try {
      const r = runAdapter(s, "guard-tool-call", {
        hook_event_name: "PreToolUse",
        tool_name: "run_notebook_cell", // not in the alias map
        tool_input: { command: "rm -rf /" },
      });
      expect(r.code).toBe(0);
      expect(reached(s.captureDir, "aidlc-state-transition-guard.ts")).toBe(0);
      expect(reached(s.captureDir, "aidlc-reviewer-scope.ts")).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("4: an unmapped tool name is a clean no-op on post-tool", () => {
    const s = scratch();
    try {
      const r = runAdapter(s, "post-tool", {
        hook_event_name: "PostToolUse",
        tool_name: "vscode_api",
        tool_input: { path: "x" },
      });
      expect(r.code).toBe(0);
      expect(reached(s.captureDir, "aidlc-write-audit-log.ts")).toBe(0);
      expect(reached(s.captureDir, "aidlc-run-sensors.ts")).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("5: an unknown target allows without dispatch (switch default)", () => {
    const s = scratch();
    try {
      const r = runAdapter(s, "not-a-real-target", {
        hook_event_name: "PreToolUse",
        tool_name: "run_in_terminal",
        tool_input: { command: "echo hi" },
      });
      expect(r.code).toBe(0);
      for (const hook of CORE_HOOKS) expect(reached(s.captureDir, hook)).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  // --- Path confinement (RT-0002, guidance §1.1/§3) --------------------------

  test("6: absolute file_path OUTSIDE the project is not forwarded (guard-tool-call)", () => {
    const s = scratch();
    try {
      const r = runAdapter(s, "guard-tool-call", {
        hook_event_name: "PreToolUse",
        tool_name: "insert_edit_into_file", // → Edit
        tool_input: { path: "/etc/passwd" },
      });
      // Fail-open: the call is still ALLOWED (exit 0) but the out-of-project
      // path never reaches the reviewer-scope hook.
      expect(r.code).toBe(0);
      expect(reached(s.captureDir, "aidlc-reviewer-scope.ts")).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("7: `..` traversal escaping the project is not forwarded (post-tool)", () => {
    const s = scratch();
    try {
      const r = runAdapter(s, "post-tool", {
        hook_event_name: "PostToolUse",
        tool_name: "insert_edit_into_file", // → Edit
        tool_input: { path: "../../../../etc/shadow" },
      });
      expect(r.code).toBe(0);
      expect(reached(s.captureDir, "aidlc-write-audit-log.ts")).toBe(0);
      expect(reached(s.captureDir, "aidlc-run-sensors.ts")).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("8: an in-project relative file_path IS forwarded (confinement not over-broad)", () => {
    const s = scratch();
    try {
      const r = runAdapter(s, "post-tool", {
        hook_event_name: "PostToolUse",
        tool_name: "insert_edit_into_file", // → Edit
        tool_input: { path: "src/legit.ts" },
      });
      expect(r.code).toBe(0);
      expect(reached(s.captureDir, "aidlc-write-audit-log.ts")).toBe(1);
    } finally {
      s.cleanup();
    }
  });

  test("9: a sibling-prefix path (projectRoot + suffix, NOT a child) is rejected", () => {
    // Classic startsWith() confinement bug: "/tmp/proj-evil" starts with
    // "/tmp/proj" but is not inside it. The separator-aware relative() check
    // must reject it.
    const s = scratch();
    try {
      const sibling = `${s.projectRoot}-evil/secret.ts`;
      const r = runAdapter(s, "post-tool", {
        hook_event_name: "PostToolUse",
        tool_name: "insert_edit_into_file",
        tool_input: { path: sibling },
      });
      expect(r.code).toBe(0);
      expect(reached(s.captureDir, "aidlc-write-audit-log.ts")).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("10: an in-project file symlink to an external target is rejected", () => {
    const s = scratch();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "t250-outside-")));
    try {
      const externalFile = join(outside, "secret.ts");
      const linkedFile = join(s.projectRoot, "linked-secret.ts");
      writeFileSync(externalFile, "export const secret = true;\n", "utf-8");
      symlinkSync(externalFile, linkedFile, "file");

      const r = runAdapter(s, "guard-tool-call", {
        hook_event_name: "PreToolUse",
        tool_name: "read_file",
        tool_input: { path: linkedFile },
      });
      expect(r.code).toBe(0);
      expect(reached(s.captureDir, "aidlc-reviewer-scope.ts")).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      s.cleanup();
    }
  });

  test("11: a prospective write through an external directory symlink or junction is rejected", () => {
    const s = scratch();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "t250-outside-")));
    try {
      const linkedDir = join(s.projectRoot, "linked-dir");
      symlinkSync(outside, linkedDir, process.platform === "win32" ? "junction" : "dir");

      const r = runAdapter(s, "post-tool", {
        hook_event_name: "PostToolUse",
        tool_name: "create_file",
        tool_input: { path: join(linkedDir, "prospective.ts") },
      });
      expect(r.code).toBe(0);
      expect(reached(s.captureDir, "aidlc-write-audit-log.ts")).toBe(0);
      expect(reached(s.captureDir, "aidlc-run-sensors.ts")).toBe(0);
    } finally {
      s.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("11a: apply_patch confines and fans out Add, Update, Delete, and Move paths", () => {
    const s = scratch();
    try {
      const patch = `*** Begin Patch
*** Add File: src/added.ts
+export const added = true;
*** Update File: src/old.ts
@@
*** Move to: src/moved.ts
*** Delete File: src/deleted.ts
*** Add File: ../escaped.ts
*** End Patch
`;
      const payload = {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { input: patch },
      };

      const before = runAdapter(s, "guard-tool-call", payload);
      expect(before.code).toBe(0);
      const expected = [
        ["src/added.ts", "Write"],
        ["src/old.ts", "Edit"],
        ["src/moved.ts", "Write"],
        ["src/deleted.ts", "Edit"],
      ].map(([path, tool]) => [resolve(s.projectRoot, path), tool]).sort();
      for (const hook of ["aidlc-review-freeze.ts", "aidlc-reviewer-scope.ts"]) {
        const targets = capturedInputs(s.captureDir, hook)
          .map((entry) => [
            (entry.tool_input as { file_path?: string } | undefined)?.file_path ?? "",
            entry.tool_name ?? "",
          ])
          .filter(([path]) => path)
          .sort();
        expect(targets, hook).toEqual(expected);
      }

      const after = runAdapter(s, "post-tool", {
        ...payload,
        hook_event_name: "PostToolUse",
      });
      expect(after.code).toBe(0);
      for (const hook of ["aidlc-write-audit-log.ts", "aidlc-run-sensors.ts"]) {
        const targets = capturedInputs(s.captureDir, hook)
          .map((entry) => [
            (entry.tool_input as { file_path?: string } | undefined)?.file_path ?? "",
            entry.tool_name ?? "",
          ])
          .filter(([path]) => path)
          .sort();
        expect(targets, hook).toEqual(expected);
      }
    } finally {
      s.cleanup();
    }
  });

  test("11b: multi-file replacements fan out through every mutation hook", () => {
    const s = scratch();
    try {
      const payload = {
        hook_event_name: "PreToolUse",
        tool_name: "multi_replace_string_in_file",
        tool_input: {
          replacements: [
            { filePath: "src/first.ts", oldString: "a", newString: "b" },
            { file_path: "src/second.ts", oldString: "c", newString: "d" },
          ],
        },
      };
      const expected = ["src/first.ts", "src/second.ts"]
        .map((path) => resolve(s.projectRoot, path))
        .sort();

      expect(runAdapter(s, "guard-tool-call", payload).code).toBe(0);
      expect(
        capturedInputs(s.captureDir, "aidlc-review-freeze.ts")
          .map((entry) =>
            (entry.tool_input as { file_path?: string } | undefined)?.file_path ?? ""
          )
          .filter(Boolean)
          .sort(),
      ).toEqual(expected);
      expect(
        capturedInputs(s.captureDir, "aidlc-reviewer-scope.ts")
          .map((entry) =>
            (entry.tool_input as { file_path?: string } | undefined)?.file_path ?? ""
          )
          .filter(Boolean)
          .sort(),
      ).toEqual(expected);

      expect(
        runAdapter(s, "post-tool", {
          ...payload,
          hook_event_name: "PostToolUse",
        }).code,
      ).toBe(0);
      for (const hook of ["aidlc-write-audit-log.ts", "aidlc-run-sensors.ts"]) {
        const calls = capturedInputs(s.captureDir, hook);
        expect(
          calls.map((entry) =>
            (entry.tool_input as { file_path?: string } | undefined)?.file_path ?? ""
          ).filter(Boolean).sort(),
          hook,
        ).toEqual(expected);
        expect(calls.every((entry) => entry.tool_name === "Edit"), hook).toBe(true);
      }
    } finally {
      s.cleanup();
    }
  });

  // --- Command injection is inert: the command is DATA, never a shell ---------

  test("12: a shell-metachar command is forwarded as an inert data field, not executed", () => {
    const s = scratch();
    try {
      const evil = "echo pwned > /tmp/t250-should-not-exist; rm -rf ~";
      runAdapter(s, "guard-tool-call", {
        hook_event_name: "PreToolUse",
        tool_name: "run_in_terminal", // → Bash
        tool_input: { command: evil },
      });
      // The guard stub received the command verbatim as a JSON string field —
      // the adapter spawns argv directly (no shell), so nothing interpolated.
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

  // --- Deliberate block (core exit 2) → deny projection, later hooks skipped --

  test("13: a core-hook exit 2 becomes a deny-JSON projection (exit 0); reviewer-scope is skipped", () => {
    const s = scratch();
    try {
      // Seed the state-transition guard to BLOCK. reviewer-scope must then never
      // run (the adapter returns on the first exit 2), and #657 converts the
      // block to stdout deny-JSON at exit 0 rather than propagating exit 2.
      writeFileSync(
        join(s.hooksDir, "aidlc-state-transition-guard.ts"),
        stubHookBody("aidlc-state-transition-guard.ts", 2, "blocked: engine-owned transition"),
        "utf-8",
      );
      const r = runAdapter(s, "guard-tool-call", {
        hook_event_name: "PreToolUse",
        tool_name: "run_in_terminal", // → Bash
        tool_input: { command: "bun .aidlc/tools/aidlc-state.ts reject x" },
      });
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain(
        "blocked: engine-owned transition",
      );
      // reviewer-scope is the SECOND Bash pre-hook — it must be short-circuited.
      expect(reached(s.captureDir, "aidlc-reviewer-scope.ts")).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("13a: plan approval normalizes Copilot agent input and blocks before rule injection", () => {
    const s = scratch();
    try {
      writeFileSync(
        join(s.hooksDir, "aidlc-plan-approval-guard.ts"),
        stubHookBody("aidlc-plan-approval-guard.ts", 2, "plan approval required"),
        "utf-8",
      );
      const r = runAdapter(s, "guard-tool-call", {
        hook_event_name: "PreToolUse",
        tool_name: "agent",
        tool_input: {
          subagent_type: "",
          agent: "aidlc-developer-agent",
          prompt: "AIDLC-UNIT: U01\nGenerate code.",
        },
      });
      expect(r.code).toBe(0);
      expect(
        (JSON.parse(r.stdout) as {
          hookSpecificOutput?: { permissionDecision?: string };
        }).hookSpecificOutput?.permissionDecision,
      ).toBe("deny");
      const forwarded = capturedInputs(
        s.captureDir,
        "aidlc-plan-approval-guard.ts",
      )[0];
      expect(forwarded.tool_name).toBe("Agent");
      expect(
        (forwarded.tool_input as { subagent_type?: string }).subagent_type,
      ).toBe("aidlc-developer-agent");
      expect(reached(s.captureDir, "aidlc-deliver-stage-rules.ts")).toBe(1);
    } finally {
      s.cleanup();
    }
  });

  test("13b: dispatch-rule failures block before plan approval", () => {
    const s = scratch();
    try {
      writeFileSync(
        join(s.hooksDir, "aidlc-deliver-stage-rules.ts"),
        stubHookBody("aidlc-deliver-stage-rules.ts", 2, "mandatory rules unavailable"),
        "utf-8",
      );
      const r = runAdapter(s, "guard-tool-call", {
        hook_event_name: "PreToolUse",
        tool_name: "agent",
        tool_input: {
          agent: "aidlc-developer-agent",
          prompt: "AIDLC-UNIT: U01\nGenerate code.",
        },
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("mandatory rules unavailable");
      expect(reached(s.captureDir, "aidlc-plan-approval-guard.ts")).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("13c: review freeze blocks shell writes after reviewer scope", () => {
    const s = scratch();
    try {
      writeFileSync(
        join(s.hooksDir, "aidlc-review-freeze.ts"),
        stubHookBody("aidlc-review-freeze.ts", 2, "review receipt is frozen"),
        "utf-8",
      );
      const r = runAdapter(s, "guard-tool-call", {
        hook_event_name: "PreToolUse",
        tool_name: "run_in_terminal",
        tool_input: { command: "printf changed > artifact.md" },
      });
      expect(r.code).toBe(0);
      expect(
        (JSON.parse(r.stdout) as {
          hookSpecificOutput?: { permissionDecision?: string };
        }).hookSpecificOutput?.permissionDecision,
      ).toBe("deny");
      expect(reached(s.captureDir, "aidlc-state-transition-guard.ts")).toBe(1);
      expect(reached(s.captureDir, "aidlc-review-freeze.ts")).toBe(1);
      expect(reached(s.captureDir, "aidlc-reviewer-scope.ts")).toBe(1);
    } finally {
      s.cleanup();
    }
  });

  test("13d: reviewer-scope failures block before review freeze", () => {
    const s = scratch();
    try {
      writeFileSync(
        join(s.hooksDir, "aidlc-reviewer-scope.ts"),
        stubHookBody("aidlc-reviewer-scope.ts", 2, "outside reviewer scope"),
        "utf-8",
      );
      const r = runAdapter(s, "guard-tool-call", {
        hook_event_name: "PreToolUse",
        tool_name: "run_in_terminal",
        tool_input: { command: "printf changed > artifact.md" },
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("outside reviewer scope");
      expect(reached(s.captureDir, "aidlc-review-freeze.ts")).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  test("14: a non-2 core exit code is NOT a block (allow, exit 0, no deny-JSON)", () => {
    const s = scratch();
    try {
      // A crashed core hook (exit 1) must fail open — never mistaken for a block.
      writeFileSync(
        join(s.hooksDir, "aidlc-reviewer-scope.ts"),
        stubHookBody("aidlc-reviewer-scope.ts", 1, "boom"),
        "utf-8",
      );
      const r = runAdapter(s, "guard-tool-call", {
        hook_event_name: "PreToolUse",
        tool_name: "read_file", // → Read (in-project path so it forwards)
        tool_input: { path: "src/foo.ts" },
      });
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      s.cleanup();
    }
  });

  // --- Fail-open when a dispatched core hook is entirely absent ----------------

  test("15: a missing core hook binary fails open (spawn error → exit 0)", () => {
    const s = scratch();
    try {
      rmSync(join(s.hooksDir, "aidlc-session-start.ts"), { force: true });
      const r = runAdapter(s, "session-start", { hook_event_name: "SessionStart" });
      expect(r.code).toBe(0);
    } finally {
      s.cleanup();
    }
  });

  // --- Locked, session-namespaced reviewer identity ledger -------------------

  test("16: concurrent SubagentStart transactions retain every entry and remain ambiguous", async () => {
    const s = scratch();
    try {
      const hostSessionId = "vscode-session-concurrent-start";
      const agents = Array.from({ length: 16 }, (_, index) => ({
        id: `reviewer-${index}`,
        name: `aidlc-reviewer-${index}-agent`,
      }));
      const results = await Promise.all(
        agents.map((agent) =>
          runAdapterAsync(s, "subagent-start", {
            hook_event_name: "SubagentStart",
            session_id: hostSessionId,
            agent_id: agent.id,
            agent_type: agent.name,
          }),
        ),
      );
      expect(results.every((result) => result.code === 0)).toBe(true);
      expect(ledgerEntries(s).map((entry) => entry.subagentId).sort()).toEqual(
        agents.map((agent) => agent.id).sort(),
      );

      runAdapter(s, "guard-tool-call", {
        hook_event_name: "PreToolUse",
        session_id: hostSessionId,
        tool_name: "read_file",
        tool_input: { path: "src/ambiguous.ts" },
      });
      const forwarded = capturedInputs(s.captureDir, "aidlc-reviewer-scope.ts").at(-1);
      expect(forwarded?.agent_type).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });

  test("17: concurrent SubagentStop transactions remove every matching entry", async () => {
    const s = scratch();
    try {
      const hostSessionId = "vscode-session-concurrent-stop";
      const agents = Array.from({ length: 16 }, (_, index) => ({
        id: `reviewer-${index}`,
        name: `aidlc-reviewer-${index}-agent`,
      }));
      for (const agent of agents) {
        runAdapter(s, "subagent-start", {
          hook_event_name: "SubagentStart",
          session_id: hostSessionId,
          agent_id: agent.id,
          agent_type: agent.name,
        });
      }
      expect(ledgerEntries(s)).toHaveLength(agents.length);

      const results = await Promise.all(
        agents.map((agent) =>
          runAdapterAsync(s, "log-subagent", {
            hook_event_name: "SubagentStop",
            session_id: hostSessionId,
            agent_id: agent.id,
            agent_type: agent.name,
          }),
        ),
      );
      expect(results.every((result) => result.code === 0)).toBe(true);
      expect(ledgerEntries(s)).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  test("18: ordinary VS Code session ids isolate active reviewers across host sessions", () => {
    const s = scratch();
    try {
      const first = {
        session_id: "vscode-host-session-a",
        agent_id: "reviewer-a",
        agent_type: "aidlc-reviewer-a-agent",
      };
      const second = {
        session_id: "vscode-host-session-b",
        agent_id: "reviewer-b",
        agent_type: "aidlc-reviewer-b-agent",
      };
      for (const identity of [first, second]) {
        runAdapter(s, "subagent-start", {
          hook_event_name: "SubagentStart",
          ...identity,
        });
      }

      for (const session_id of [first.session_id, second.session_id]) {
        runAdapter(s, "guard-tool-call", {
          hook_event_name: "PreToolUse",
          session_id,
          tool_name: "read_file",
          tool_input: { path: "src/session-scoped.ts" },
        });
      }
      let forwarded = capturedInputs(s.captureDir, "aidlc-reviewer-scope.ts");
      expect(forwarded.at(-2)?.agent_type).toBe(first.agent_type);
      expect(forwarded.at(-1)?.agent_type).toBe(second.agent_type);

      runAdapter(s, "log-subagent", {
        hook_event_name: "SubagentStop",
        ...first,
      });
      for (const session_id of [first.session_id, second.session_id]) {
        runAdapter(s, "guard-tool-call", {
          hook_event_name: "PreToolUse",
          session_id,
          tool_name: "read_file",
          tool_input: { path: "src/session-scoped.ts" },
        });
      }
      forwarded = capturedInputs(s.captureDir, "aidlc-reviewer-scope.ts");
      expect(forwarded.at(-2)?.agent_type).toBeUndefined();
      expect(forwarded.at(-1)?.agent_type).toBe(second.agent_type);
    } finally {
      s.cleanup();
    }
  });

  test("19: an interrupted process's stale ledger lock is reclaimed", () => {
    const s = scratch();
    try {
      const lockDir = `${s.ledgerPath}.lock`;
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, "owner.json"),
        JSON.stringify({
          pid: 999_999,
          acquiredAt: Date.now() - 60_000,
          token: "stale-owner",
        }),
        "utf-8",
      );

      const result = runAdapter(s, "subagent-start", {
        hook_event_name: "SubagentStart",
        session_id: "vscode-stale-lock-session",
        agent_id: "reviewer-after-recovery",
        agent_type: "aidlc-reviewer-after-recovery-agent",
      });

      expect(result.code).toBe(0);
      expect(ledgerEntries(s).map((entry) => entry.subagentId)).toContain(
        "reviewer-after-recovery",
      );
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      s.cleanup();
    }
  });
});
