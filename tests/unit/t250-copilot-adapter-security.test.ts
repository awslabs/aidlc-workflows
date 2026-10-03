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
// not). The shell allow (#1411) goes only to VS Code's terminal tool, only for
// AI-DLC's own simple commands, after every guard exits 0; the Copilot CLI, a
// crashed guard, a deny, and every other command keep the host's own approval.
//
// WHY SUBPROCESS. Fail-open is an exit-code contract; only a real subprocess
// exercises process.exit()/uncaught-throw faithfully.
//
// covers: file:hooks/aidlc-reviewer-scope.ts, file:hooks/aidlc-state-transition-guard.ts, file:hooks/aidlc-plan-approval-guard.ts, file:hooks/aidlc-review-freeze.ts, file:hooks/aidlc-write-audit-log.ts

import { describe, expect, setDefaultTimeout, test } from "bun:test";
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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCKED_STATE_TRANSITIONS } from "../../core/hooks/aidlc-state-transition-guard.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADAPTER_SRC = join(
  REPO_ROOT,
  "harness",
  "copilot",
  "hooks",
  "aidlc-copilot-adapter.ts",
);
const RUNTIME_PATHS_SRC = join(REPO_ROOT, "core", "tools", "aidlc-runtime-paths.ts");
// The adapter reads AI-DLC's own command routes from the real dispatcher table.
const DISPATCHER_SRCS = ["aidlc.ts", "aidlc-command.ts", "aidlc-color.ts", "aidlc-version.ts"]
  .map((file) => join(REPO_ROOT, "core", "tools", file));

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

// Minimal stubs for the adapter's audit and lib tool imports (../tools/*); its
// runtime-paths import is copied as-is (node builtins only). The
// record-human-turn reads stateFilePath() + appendAuditEntry(); neither is a security
// surface here, so the stubs are inert (state file absent → no append).
const AUDIT_TOOL_STUB = `export function appendAuditEntry(_k: string, _d: unknown, _p: string): void {}\nexport function appendSubagentPromptUnmatched(_p: string, _r: unknown): void {}\nexport function appendCoordinationStoodAside(_p: string, _r: unknown): boolean { return false; }\n`;
const LIB_TOOL_STUB = `import { join } from "node:path";
export { boundDirectiveMessage } from ${JSON.stringify(join(REPO_ROOT, "core", "tools", "aidlc-lib.ts"))};
export function stateFilePath(projectDir: string): string {
  return join(projectDir, ".aidlc-state-absent.json");
}
export function humanTurnMintAllowed(): boolean {
  return process.env.AIDLC_UNATTENDED !== "1";
}
export function resolveWorkflowSelection(
  _projectDir: string,
  options: { sessionId?: string } = {},
): { space: string; intent: null; sessionId: string | null; binding: null } {
  return {
    space: "default",
    intent: null,
    sessionId: options.sessionId ?? null,
    binding: null,
  };
}
export function stateFilePathForSelection(projectDir: string): string {
  return stateFilePath(projectDir);
}
export function humanActedSinceGate(): boolean { return process.env.T250_HUMAN_ACTED === "1"; }
export function constructionPolicyReceiptApplies(_projectDir: string, field: string, value: string): boolean { return process.env.T250_POLICY_RECEIPT === field + "=" + value; }
export function isReadOnlyNextArgv(args: readonly string[]): boolean { return args.includes("--status") || (args[0] === "config" && ["set", "get", "list"].includes(args[1] ?? "")); }
export function normalizeDriveLetter(p: string): string { return p; }
export function claimCopilotCommand(): { allowed: true; attemptId: string } {
  return { allowed: true, attemptId: "00000000-0000-4000-8000-000000000001" };
}
export function settleCopilotCommand(): string { return "settled"; }
export function settleCopilotIntentBoundary(): boolean { return false; }
export function recordCopilotHumanSequence(): boolean { return true; }
export function workflowParticipation(): "participant" { return "participant"; }
export function enterHookWorkflow(projectDir: string, sessionId?: unknown) {
  return {
    selection: resolveWorkflowSelection(projectDir, typeof sessionId === "string" ? { sessionId } : {}),
    participation: "participant" as const,
    restore: () => {},
  };
}
export function hookStandsOutside(): boolean { return false; }\n`;

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
  copyFileSync(RUNTIME_PATHS_SRC, join(toolsDir, "aidlc-runtime-paths.ts"));
  for (const source of DISPATCHER_SRCS) copyFileSync(source, join(toolsDir, basename(source)));
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
  env: Record<string, string | undefined> = {},
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
        ...env,
      } as NodeJS.ProcessEnv,
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
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

/** Fault only the copied adapter's filesystem import; production has no test switch. */
function injectLedgerFault(
  s: Scratch,
  fault: "lock" | "owner-write" | "read" | "write" | "commit" | "release" | "owner-change" | "state-change",
  replacement = "",
): void {
  const adapter = join(s.hooksDir, "aidlc-copilot-adapter.ts");
  const source = readFileSync(adapter, "utf-8");
  expect(source.split('from "node:fs";')).toHaveLength(2);
  writeFileSync(adapter, source.replace('from "node:fs";', 'from "./t250-ledger-fs.ts";'));
  writeFileSync(join(s.hooksDir, "t250-ledger-fs.ts"), `
import * as fs from "node:fs";
export * from "node:fs";
const ledger = ${JSON.stringify(s.ledgerPath)};
const lock = ledger + ".lock";
const owner = ${JSON.stringify(join(`${s.ledgerPath}.lock`, "owner.json"))};
const fault = ${JSON.stringify(fault)};
const hit = ${JSON.stringify(join(s.captureDir, "ledger-fault.json"))};
function mark() { fs.writeFileSync(hit, JSON.stringify({ fault })); }
function fail() { mark(); throw Object.assign(new Error("injected ledger I/O failure"), { code: "EPERM" }); }
function staged(path) { return String(path).startsWith(ledger + ".") && String(path).endsWith(".tmp"); }
export function mkdirSync(path, ...args) {
  if (fault === "lock" && path === lock) fail();
  return fs.mkdirSync(path, ...args);
}
export function readFileSync(path, ...args) {
  if (fault === "read" && path === ledger) fail();
  return fs.readFileSync(path, ...args);
}
export function writeFileSync(path, ...args) {
  if ((fault === "owner-write" && path === owner) || (fault === "write" && staged(path))) fail();
  const result = fs.writeFileSync(path, ...args);
  if (staged(path) && fault === "owner-change") {
    mark();
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token: "successor-owner" }));
  }
  if (staged(path) && fault === "state-change") {
    mark();
    fs.writeFileSync(ledger, ${JSON.stringify(replacement)});
  }
  return result;
}
export function renameSync(from, to) {
  if (fault === "commit" && to === ledger) fail();
  return fs.renameSync(from, to);
}
export function rmSync(path, ...args) {
  if (fault === "release" && path === lock) fail();
  return fs.rmSync(path, ...args);
}
`);
}

/** Model mkdir denial on either OS without changing the host's process.platform.
 *  Only the copied adapter's platform branch and filesystem import are replaced.
 *  The ledger, ownership checks, transaction and forwarded hook remain real. */
function injectLedgerLockSequence(
  s: Scratch,
  platform: "win32" | "linux",
  codes: Array<string | null>,
): string {
  const adapter = join(s.hooksDir, "aidlc-copilot-adapter.ts");
  const source = readFileSync(adapter, "utf-8");
  const platformCheck = 'process.platform === "win32"';
  expect(source.split('from "node:fs";')).toHaveLength(2);
  expect(source.split(platformCheck)).toHaveLength(2);
  writeFileSync(adapter, source
    .replace('from "node:fs";', 'from "./t250-lock-sequence-fs.ts";')
    .replace(platformCheck, String(platform === "win32")));
  const trace = join(s.captureDir, "lock-sequence.json");
  writeFileSync(join(s.hooksDir, "t250-lock-sequence-fs.ts"), `
import * as fs from "node:fs";
export * from "node:fs";
const ledger = ${JSON.stringify(s.ledgerPath)};
const lock = ledger + ".lock";
const owner = ${JSON.stringify(join(`${s.ledgerPath}.lock`, "owner.json"))};
const before = fs.readFileSync(ledger, "utf8");
const ownerBefore = fs.readFileSync(owner, "utf8");
const codes = ${JSON.stringify(codes)};
let attempts = 0;
export function mkdirSync(path, ...args) {
  if (path !== lock) return fs.mkdirSync(path, ...args);
  attempts++;
  // Denial must never authorize changing the existing owner or ledger.
  if (fs.readFileSync(ledger, "utf8") !== before || fs.readFileSync(owner, "utf8") !== ownerBefore) {
    throw new Error("lock retry changed another owner's data");
  }
  fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ attempts }));
  const code = codes[Math.min(attempts - 1, codes.length - 1)];
  if (code) throw Object.assign(new Error("modeled mkdir failure"), { code });
  // Only the fixture retires its synthetic prior owner. The adapter must then
  // acquire a new directory and stamp its own token before updating the ledger.
  fs.rmSync(lock, { recursive: true });
  return fs.mkdirSync(path, ...args);
}
`);
  return trace;
}

// The adapter resolves the direct and tool script names to decide whether a
// command is AI-DLC's own; these stand-ins are never executed. The source
// dispatcher (aidlc.ts) is the real one the rig copies.
const TOOL_STAND_INS = ["aidlc-orchestrate.ts", "aidlc-log.ts", "aidlc-runtime.ts", "aidlc-state.ts", "aidlc-utility.ts", "aidlc-lifecycle.ts", "aidlc-worktree.ts", "aidlc-unit.ts"];
function seedAidlcScripts(s: Scratch): void {
  const toolsDir = join(s.projectRoot, ".aidlc", "tools");
  for (const file of TOOL_STAND_INS) writeFileSync(join(toolsDir, file), "// t250 stand-in tool\n", "utf-8");
}

// A null session omits the host session id.
function shellCall(command: string, session: string | null = "S-ALLOW", toolName = "run_in_terminal") {
  return {
    hook_event_name: "PreToolUse",
    ...(session === null ? {} : { session_id: session }),
    tool_name: toolName,
    tool_input: { command },
  };
}

type ShellDecision = {
  modifiedArgs?: { command?: string };
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    updatedInput?: { command?: string };
  };
};

function shellDecision(r: { stdout: string }): ShellDecision {
  return r.stdout.trim() ? JSON.parse(r.stdout) as ShellDecision : {};
}

const STUB_ATTEMPT = "--aidlc-attempt-id 00000000-0000-4000-8000-000000000001";
// Prose families that keep the host's prompt: they throw away or merge work,
// change which stages, gates, or reviews the person sees, reach the shared
// remote, or rewrite installed runner skills.
const PROMPTED_PROSE_FAMILIES = new Set([
  "engine worktree discard", "engine worktree merge", "engine worktree purge", "engine swarm finalize",
  "unit land", "engine intent archive", "engine recompose", "engine bolt set-autonomy",
  "engine state set-construction-checkpoints", "unit claim", "engine gen runners", "engine config set",
]);
const SHELL_GUARDS = [
  "aidlc-state-transition-guard.ts",
  "aidlc-reviewer-scope.ts",
  "aidlc-review-freeze.ts",
  "aidlc-plan-approval-guard.ts",
];

function ledgerDiagnostic(result: { stderr: string }): Record<string, unknown> {
  const line = result.stderr.split("\n").find(value => value.startsWith("Copilot subagent ledger transaction failed: "));
  expect(line, result.stderr).toBeDefined();
  return JSON.parse(line!.slice("Copilot subagent ledger transaction failed: ".length)) as Record<string, unknown>;
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

  test("12a: a bare continue gains only the attempt flag; chained or extra-receipt forms are denied", () => {
    const s = scratch();
    try {
      // The CLI payload (snake_case, run_in_terminal) and the VS Code one
      // (camelCase, runTerminalCommand) both normalize to Bash.
      const dialects = {
        cli: (command: string) => ({
          hook_event_name: "PreToolUse",
          session_id: "t250-continue-owner",
          tool_name: "run_in_terminal",
          tool_input: { command },
        }),
        vscode: (command: string) => ({
          hook_event_name: "PreToolUse",
          session_id: "t250-continue-owner",
          toolName: "runTerminalCommand",
          toolInput: { command },
        }),
      };
      for (const [dialect, payload] of Object.entries(dialects)) {
        const guard = (command: string) => runAdapter(s, "guard-tool-call", payload(command));
        const bare = JSON.parse(guard("aidlc continue").stdout) as {
          modifiedArgs?: { command?: string };
          hookSpecificOutput?: { hookEventName?: string; updatedInput?: { command?: string } };
        };
        const rewritten = "aidlc continue --aidlc-attempt-id 00000000-0000-4000-8000-000000000001";
        expect(bare.modifiedArgs?.command, dialect).toBe(rewritten);
        expect(bare.hookSpecificOutput?.hookEventName, dialect).toBe("PreToolUse");
        expect(bare.hookSpecificOutput?.updatedInput?.command, dialect).toBe(rewritten);
        for (const command of [
          "aidlc continue; rm -rf ~",
          "aidlc continue && echo pwned",
          "aidlc continue ABCD1234 EFGH5678",
        ]) {
          const denied = guard(command);
          expect(denied.code, `${dialect}: ${command}`).toBe(0);
          expect(denied.stdout, `${dialect}: ${command}`).toContain('"permissionDecision":"deny"');
          expect(denied.stdout, `${dialect}: ${command}`).not.toContain("modifiedArgs");
          expect(denied.stdout, `${dialect}: ${command}`).not.toContain("updatedInput");
        }
      }
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

  test("13a2: plan approval receives the Copilot session id on dispatch and file writes", () => {
    const s = scratch();
    try {
      for (const payload of [
        {
          tool_name: "agent",
          tool_input: { agent: "aidlc-developer-agent", prompt: "AIDLC-UNIT: U01\nGenerate code." },
        },
        {
          tool_name: "apply_patch",
          tool_input: { input: "*** Begin Patch\n*** Add File: src/added.ts\n+x\n*** End Patch\n" },
        },
      ]) {
        const r = runAdapter(s, "guard-tool-call", { hook_event_name: "PreToolUse", session_id: "S-COP", ...payload });
        expect(r.code).toBe(0);
      }
      const forwarded = capturedInputs(s.captureDir, "aidlc-plan-approval-guard.ts");
      expect(forwarded.length).toBe(2);
      expect(forwarded.map((entry) => entry.session_id)).toEqual(["S-COP", "S-COP"]);
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
      expect(results.every((result) => result.code === 0),
        JSON.stringify(results.map(({ code, stderr }) => ({ code, stderr: stderr.slice(0, 512) })))).toBe(true);
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
      expect(results.every((result) => result.code === 0),
        JSON.stringify(results.map(({ code, stderr }) => ({ code, stderr: stderr.slice(0, 512) })))).toBe(true);
      expect(ledgerEntries(s)).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  for (const { platform, codes, attempts, failure } of [
    { platform: "win32", codes: ["EPERM", "EEXIST", null], attempts: 3, failure: null },
    { platform: "win32", codes: ["EPERM"], attempts: 200, failure: "EPERM" },
    { platform: "linux", codes: ["EPERM", null], attempts: 1, failure: "EPERM" },
    { platform: "win32", codes: ["EACCES", null], attempts: 1, failure: "EACCES" },
  ] as const) {
    test(`17a: ${platform} mkdir ${JSON.stringify(codes)} preserves ownership and reports persistent denial`, () => {
      const s = scratch();
      const first = { session_id: "host-a", agent_id: "shared-id", agent_type: "aidlc-reviewer-a-agent" };
      const other = { session_id: "host-b", agent_id: "shared-id", agent_type: "aidlc-reviewer-b-agent" };
      try {
        for (const identity of [first, other]) {
          expect(runAdapter(s, "subagent-start", identity).code).toBe(0);
        }
        const before = readFileSync(s.ledgerPath, "utf-8");
        const lockDir = `${s.ledgerPath}.lock`;
        const ownerPath = join(lockDir, "owner.json");
        const ownerBefore = JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token: "prior-owner" });
        mkdirSync(lockDir);
        writeFileSync(ownerPath, ownerBefore);
        const trace = injectLedgerLockSequence(s, platform, [...codes]);
        const result = runAdapter(s, "log-subagent", first);
        expect(JSON.parse(readFileSync(trace, "utf-8"))).toEqual({ attempts });
        if (failure) {
          expect(result.code, result.stderr).toBe(1);
          expect(ledgerDiagnostic(result)).toEqual({ operation: "lock", code: failure, committed: false });
          expect(readFileSync(s.ledgerPath, "utf-8")).toBe(before);
          expect(readFileSync(ownerPath, "utf-8")).toBe(ownerBefore);
          expect(reached(s.captureDir, "aidlc-log-subagent.ts")).toBe(0);
        } else {
          expect(result.code, result.stderr).toBe(0);
          expect(ledgerEntries(s).map(entry => entry.hostSessionId)).toEqual(["host-b"]);
          expect(existsSync(lockDir)).toBe(false);
          expect(reached(s.captureDir, "aidlc-log-subagent.ts")).toBe(1);
        }
      } finally {
        s.cleanup();
      }
    });
  }

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

  test.each(["lock", "owner-write", "read", "write", "commit", "release"] as const)(
    "20: %s failure cannot acknowledge a SubagentStop as successful", (fault) => {
      const s = scratch();
      const first = { session_id: "host-a", agent_id: "shared-id", agent_type: "aidlc-reviewer-a-agent" };
      const other = { session_id: "host-b", agent_id: "shared-id", agent_type: "aidlc-reviewer-b-agent" };
      try {
        for (const identity of [first, other]) {
          expect(runAdapter(s, "subagent-start", identity).code).toBe(0);
        }
        const before = readFileSync(s.ledgerPath, "utf-8");
        injectLedgerFault(s, fault);
        const failed = runAdapter(s, "log-subagent", first);
        expect(failed.code).toBe(1);
        expect(ledgerDiagnostic(failed)).toEqual({ operation: fault, code: "EPERM", committed: fault === "release" });
        expect(existsSync(join(s.captureDir, "ledger-fault.json"))).toBe(true);
        expect(reached(s.captureDir, "aidlc-log-subagent.ts")).toBe(0);
        if (fault === "release") {
          // The diagnostic distinguishes committed data from a cleanup failure;
          // replaying an anonymous stop after this would not be safe.
          expect(ledgerEntries(s).map(entry => entry.hostSessionId)).toEqual(["host-b"]);
          expect(existsSync(`${s.ledgerPath}.lock`)).toBe(true);
        } else {
          expect(readFileSync(s.ledgerPath, "utf-8")).toBe(before);
          expect(existsSync(`${s.ledgerPath}.lock`)).toBe(false);
          copyFileSync(ADAPTER_SRC, join(s.hooksDir, "aidlc-copilot-adapter.ts"));
          const recovered = runAdapter(s, "log-subagent", first);
          expect(recovered.code, recovered.stderr).toBe(0);
          expect(ledgerEntries(s).map(entry => entry.hostSessionId)).toEqual(["host-b"]);
          expect(reached(s.captureDir, "aidlc-log-subagent.ts")).toBe(1);
        }
      } finally {
        s.cleanup();
      }
    },
  );

  test("21: a failed SubagentStart does not report success or replace another identity", () => {
    const s = scratch();
    try {
      const identity = { session_id: "host", agent_id: "existing", agent_type: "aidlc-reviewer-agent" };
      expect(runAdapter(s, "subagent-start", identity).code).toBe(0);
      const before = readFileSync(s.ledgerPath, "utf-8");
      injectLedgerFault(s, "commit");
      const failed = runAdapter(s, "subagent-start", { ...identity, agent_id: "new" });
      expect(failed.code).toBe(1);
      expect(ledgerDiagnostic(failed)).toEqual({ operation: "commit", code: "EPERM", committed: false });
      expect(readFileSync(s.ledgerPath, "utf-8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test.each(["owner-change", "state-change"] as const)("22: %s preserves the successor rather than publishing an old snapshot", (fault) => {
    const s = scratch();
    try {
      const identity = { session_id: "host", agent_id: "reviewer", agent_type: "aidlc-reviewer-agent" };
      expect(runAdapter(s, "subagent-start", identity).code).toBe(0);
      const before = readFileSync(s.ledgerPath, "utf-8");
      const successor = JSON.stringify([{
        hostSessionId: "successor-host", subagentId: "successor-agent", name: "aidlc-successor-agent",
        hostCorrelated: true, ts: Date.now(),
      }]);
      injectLedgerFault(s, fault, successor);
      const failed = runAdapter(s, "log-subagent", identity);
      expect(failed.code).toBe(1);
      expect(ledgerDiagnostic(failed)).toEqual({
        operation: "commit", code: fault === "owner-change" ? "OWNER_CHANGED" : "STATE_CHANGED", committed: false,
      });
      expect(readFileSync(s.ledgerPath, "utf-8")).toBe(fault === "owner-change" ? before : successor);
      expect(reached(s.captureDir, "aidlc-log-subagent.ts")).toBe(0);
      if (fault === "owner-change") {
        expect(JSON.parse(readFileSync(join(`${s.ledgerPath}.lock`, "owner.json"), "utf-8")).token).toBe("successor-owner");
      } else {
        expect(existsSync(`${s.ledgerPath}.lock`)).toBe(false);
      }
    } finally {
      s.cleanup();
    }
  });

  test("23: a held lock returns an explicit failure without modifying its owner or ledger", () => {
    const s = scratch();
    try {
      const identity = { session_id: "host", agent_id: "reviewer", agent_type: "aidlc-reviewer-agent" };
      expect(runAdapter(s, "subagent-start", identity).code).toBe(0);
      const before = readFileSync(s.ledgerPath, "utf-8");
      const owner = JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token: "held-owner" });
      const ownerPath = join(`${s.ledgerPath}.lock`, "owner.json");
      mkdirSync(`${s.ledgerPath}.lock`);
      writeFileSync(ownerPath, owner);
      const failed = runAdapter(s, "log-subagent", identity);
      expect(failed.code).toBe(1);
      expect(ledgerDiagnostic(failed)).toEqual({ operation: "lock", code: "LOCK_TIMEOUT", committed: false });
      expect(readFileSync(ownerPath, "utf-8")).toBe(owner);
      expect(readFileSync(s.ledgerPath, "utf-8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test("24: malformed ledger data is preserved on mutation while guard lookup remains advisory", () => {
    const s = scratch();
    try {
      const malformed = '{"incomplete":';
      writeFileSync(s.ledgerPath, malformed);
      const failed = runAdapter(s, "subagent-start", { session_id: "host", agent_id: "reviewer", agent_type: "aidlc-reviewer-agent" });
      expect(failed.code).toBe(1);
      expect(ledgerDiagnostic(failed)).toEqual({ operation: "read", code: "INVALID_LEDGER", committed: false });
      expect(readFileSync(s.ledgerPath, "utf-8")).toBe(malformed);
      const guard = runAdapter(s, "guard-tool-call", {
        session_id: "host", tool_name: "read_file", tool_input: { path: "src/file.ts" },
      });
      expect(guard.code, guard.stderr).toBe(0);
      expect(capturedInputs(s.captureDir, "aidlc-reviewer-scope.ts").at(-1)?.agent_type).toBeUndefined();
      expect(readFileSync(s.ledgerPath, "utf-8")).toBe(malformed);
    } finally {
      s.cleanup();
    }
  });

  test("25: the inferred SessionEnd names the prior session and skips a heartbeat without one", () => {
    const s = scratch();
    try {
      // reconcile runs only once the workspace shell exists.
      mkdirSync(join(s.projectRoot, "aidlc"), { recursive: true });
      expect(runAdapter(s, "session-start", { hook_event_name: "SessionStart", sessionId: "copilot-first" }).code).toBe(0);
      expect(runAdapter(s, "session-start", { hook_event_name: "SessionStart", sessionId: "copilot-second" }).code).toBe(0);
      const ends = capturedInputs(s.captureDir, "aidlc-session-end.ts");
      expect(ends).toHaveLength(1);
      expect(ends[0]?.session_id).toBe("copilot-first");

      // A session without an id leaves the "unknown" placeholder, which names
      // no session: the next start must not end anything on its behalf.
      expect(runAdapter(s, "session-start", { hook_event_name: "SessionStart" }).code).toBe(0);
      expect(runAdapter(s, "session-start", { hook_event_name: "SessionStart", sessionId: "copilot-third" }).code).toBe(0);
      expect(capturedInputs(s.captureDir, "aidlc-session-end.ts").map((end) => end.session_id)).toEqual([
        "copilot-first",
        "copilot-second",
      ]);
    } finally {
      s.cleanup();
    }
  });

  // --- No Allow click for AI-DLC's own commands in VS Code (#1411) -------------

  test("26: AI-DLC workflow commands get an allow beside the rewrite in VS Code, and only the rewrite on the CLI", () => {
    const s = scratch();
    try {
      seedAidlcScripts(s);
      for (const command of [
        "bun .aidlc/tools/aidlc-orchestrate.ts next",
        "bun .aidlc/tools/aidlc.ts engine orchestrate next",
        "aidlc engine orchestrate next",
        "aidlc engine orchestrate continue TOKEN123",
        "aidlc engine orchestrate report --stage requirements-analysis --result completed",
        "bun .aidlc/tools/aidlc.ts park",
        "aidlc engine orchestrate next 2>&1",
      ]) {
        for (const toolName of ["run_in_terminal", "runTerminalCommand"]) {
          const out = shellDecision(runAdapter(s, "guard-tool-call", shellCall(command, "S-ALLOW", toolName)));
          expect(out.hookSpecificOutput?.permissionDecision, `${toolName}: ${command}`).toBe("allow");
          expect(out.hookSpecificOutput?.permissionDecisionReason, command).toContain("AI-DLC");
          expect(out.hookSpecificOutput?.updatedInput?.command, command).toContain(STUB_ATTEMPT);
          expect(out.modifiedArgs?.command, command).toBe(out.hookSpecificOutput?.updatedInput?.command);
        }
        // The Copilot CLI keeps today's answer: the rewrite with no permission
        // decision, so the team's own --allow-tool/--deny-tool rules decide.
        for (const toolName of ["Bash", "bash"]) {
          const cli = shellDecision(runAdapter(s, "guard-tool-call", shellCall(command, "S-ALLOW", toolName)));
          expect(cli.hookSpecificOutput?.permissionDecision, `${toolName}: ${command}`).toBeUndefined();
          expect(cli.modifiedArgs?.command, `${toolName}: ${command}`).toContain(STUB_ATTEMPT);
          expect(cli.hookSpecificOutput?.updatedInput?.command, command).toBe(cli.modifiedArgs?.command);
        }
      }
      // Without a host session the coordination claim cannot run, so the
      // command runs untracked exactly as before and AI-DLC does not vouch,
      // and it vouches for no other command from a call without one either.
      for (const command of ["aidlc engine orchestrate next", "aidlc engine log answers", "aidlc doctor", "bun .aidlc/tools/aidlc-log.ts answers"]) {
        const untracked = runAdapter(s, "guard-tool-call", shellCall(command, null));
        expect(untracked.code, command).toBe(0);
        expect(untracked.stdout, command).toBe("");
      }
    } finally {
      s.cleanup();
    }
  });

  test("27: every AI-DLC command family a stage runs gets an allow in VS Code and no decision on the CLI", () => {
    const s = scratch();
    try {
      seedAidlcScripts(s);
      const families = [
        // read-only next forms and utilities
        "aidlc engine orchestrate next --status",
        "bun .aidlc/tools/aidlc-orchestrate.ts next --status",
        "aidlc doctor",
        "bun .aidlc/tools/aidlc.ts doctor --verbose",
        "aidlc doctor --export --output aidlc/diagnostics",
        "aidlc engine status",
        "aidlc engine status --json",
        "aidlc version",
        "aidlc help",
        "aidlc engine orchestrate help",
        "aidlc team-board",
        "bun .aidlc/tools/aidlc-orchestrate.ts team-board --snapshot",
        "aidlc engine orchestrate wait --stage application-design --for review",
        // what the stage protocol and the stages tell the conductor to run
        "aidlc engine log decision --stage requirements-analysis --decision scope --options a,b",
        "aidlc engine log answer --stage requirements-analysis --question q1 --answer A",
        "aidlc engine log answers --stage requirements-analysis",
        "aidlc engine log review --stage application-design --verdict approve",
        "aidlc engine log link --stage application-design --artifact a.md",
        "aidlc engine runtime summary",
        "aidlc engine runtime compile",
        "aidlc engine intent list --json",
        "aidlc engine space list",
        "aidlc engine learnings surface --stage code-generation",
        "aidlc engine learnings persist --stage code-generation",
        "aidlc engine testing-posture verify --unit U01",
        "aidlc engine state lookup requirements-analysis",
        "aidlc engine state set-construction-iteration stage-major",
        "aidlc engine state reuse-artifact --stage requirements-analysis",
        "aidlc engine bolt checkpoint --unit U01",
        "aidlc engine swarm prepare --stage code-generation",
        "aidlc engine worktree list",
        "aidlc engine worktree create --unit U01",
        "aidlc engine audit history --stage requirements-analysis",
        "aidlc engine audit append-raw --event SENSOR_NOTE",
        "aidlc engine graph compile",
        "aidlc engine gen stage-table",
        "aidlc engine scope save feature-lite",
        "aidlc engine workspace codekb-scope-diff",
        "aidlc engine config get depth",
        "aidlc engine sensor list",
        "aidlc unit merge-status U01",
        "aidlc engine swarm check U01",
        "aidlc engine jump resolve --target code-generation",
        "aidlc engine scope detect",
        "aidlc engine intent create auth-service",
        // the same routes in the source spelling and as the tool scripts the
        // engine names on a source install
        "bun .aidlc/tools/aidlc.ts engine log answer --stage requirements-analysis --question q1 --answer A",
        "bun .aidlc/tools/aidlc.ts engine runtime summary 2>&1",
        "bun .aidlc/tools/aidlc-log.ts answer --stage requirements-analysis --question q1 --answer A",
        "bun .aidlc/tools/aidlc-runtime.ts compile",
        "bun .aidlc/tools/aidlc-state.ts unpark",
      ];
      for (const command of families) {
        const out = shellDecision(runAdapter(s, "guard-tool-call", shellCall(command)));
        expect(out.hookSpecificOutput?.permissionDecision, command).toBe("allow");
        expect(out.hookSpecificOutput?.updatedInput, command).toBeUndefined();
        expect(out.modifiedArgs, command).toBeUndefined();
        const cli = runAdapter(s, "guard-tool-call", shellCall(command, "S-ALLOW", "Bash"));
        expect(cli.code, command).toBe(0);
        expect(cli.stdout, command).toBe("");
      }
      // Every guard still ran before each answer.
      for (const hook of SHELL_GUARDS) expect(reached(s.captureDir, hook), hook).toBe(families.length * 2);
    } finally {
      s.cleanup();
    }
  });

  test("27b: each AI-DLC command family the shipped stage prose names runs without an Allow prompt", () => {
    // The prose names commands as `{{INVOKE}} engine <noun> <verb>`. Every
    // complete family must classify as AI-DLC's own, so a stage needs no click
    // for anything AI-DLC does itself; an unresolved entry is a bare noun.
    const roots = ["core/aidlc-common", "core/skills", "core/agents", "core/knowledge", "core/sensors", "core/templates", "harness/copilot/skills"];
    const families = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".md")) {
          for (const match of readFileSync(path, "utf-8").matchAll(/\{\{INVOKE\}\} (engine [a-z][a-z-]*|unit)(?: ([a-z][a-z-]*))?/g)) {
            families.add(match[2] ? `${match[1]} ${match[2]}` : match[1]);
          }
        }
      }
    };
    for (const root of roots) walk(join(REPO_ROOT, root));
    expect(families.size).toBeGreaterThan(40);
    for (const named of ["engine log decision", "engine log answer", "engine log review", "engine runtime summary", "engine intent list", "engine learnings persist", "engine testing-posture verify", "engine state lookup"]) {
      expect(families.has(named), named).toBe(true);
    }
    const s = scratch();
    try {
      seedAidlcScripts(s);
      const fragments: string[] = [];
      for (const family of [...families].sort()) {
        // `continue` needs its delivery token to be a complete command.
        const command = family === "engine orchestrate continue" ? "aidlc engine orchestrate continue TOKEN123" : `aidlc ${family}`;
        const out = shellDecision(runAdapter(s, "guard-tool-call", shellCall(command)));
        if (out.hookSpecificOutput?.permissionDecision === "allow") continue;
        fragments.push(family);
      }
      // Only verb-less mentions ("`engine worktree` subcommands") and the
      // commands 27c and 27d keep the host's prompt.
      expect(fragments.every((family) =>
        family.split(" ").length === 2 || PROMPTED_PROSE_FAMILIES.has(family)
      ), fragments.join(", ")).toBe(true);
      for (const family of PROMPTED_PROSE_FAMILIES) {
        if (families.has(family)) expect(fragments, family).toContain(family);
      }
    } finally {
      s.cleanup();
    }
  });

  test("27c: commands that throw away or merge the person's work keep the Allow prompt; routine siblings stay click-free", () => {
    const s = scratch();
    try {
      seedAidlcScripts(s);
      for (const command of [
        "aidlc engine worktree discard --slug bolt-a",
        "aidlc engine worktree purge --slug bolt-a --parked 20260101T000000Z",
        "aidlc engine worktree merge --slug bolt-a --target main --strategy merge",
        "aidlc unit land U01",
        "aidlc unit land U01 --step git --target main",
        "aidlc engine intent archive auth-service --reason done",
        "aidlc engine swarm finalize --batch 1 --units a,b --claimed a",
        "aidlc engine bolt abort --name b1 --slug bolt-a --reason stuck --discard",
        // aborting a Bolt needs the person's consent, discarded or not
        "aidlc engine bolt abort --name b1 --slug bolt-a --reason stuck",
        "aidlc engine plugin sync --prune-missing --yes",
        "bun .aidlc/tools/aidlc.ts engine worktree discard --slug bolt-a",
        "bun .aidlc/tools/aidlc-worktree.ts discard --slug bolt-a",
        "bun .aidlc/tools/aidlc-worktree.ts merge --slug bolt-a --target main --strategy squash",
        "bun .aidlc/tools/aidlc-unit.ts land U01",
        // recomposing drops or adds stages the person would review
        "aidlc engine recompose --skip security-review",
        "aidlc engine recompose --add security-review",
        "bun .aidlc/tools/aidlc.ts engine recompose --skip security-review",
      ]) {
        const vscode = runAdapter(s, "guard-tool-call", shellCall(command));
        expect(vscode.code, command).toBe(0);
        expect(vscode.stdout, command).toBe("");
      }
      for (const command of [
        "aidlc engine worktree list",
        "aidlc engine worktree create --slug bolt-a --base main",
        "aidlc engine worktree restore --slug bolt-a --parked 20260101T000000Z",
        "aidlc engine worktree info --slug bolt-a",
        "aidlc unit merge-status U01",
        "aidlc engine intent unarchive auth-service",
        "aidlc engine bolt complete --name b1 --batch 1 --merge --slug bolt-a",
        "aidlc engine swarm prepare --batch 1 --units a,b",
        "aidlc engine plugin list",
        "bun .aidlc/tools/aidlc-worktree.ts list",
        "bun .aidlc/tools/aidlc-unit.ts merge-status U01",
      ]) {
        const out = shellDecision(runAdapter(s, "guard-tool-call", shellCall(command)));
        expect(out.hookSpecificOutput?.permissionDecision, command).toBe("allow");
      }
    } finally {
      s.cleanup();
    }
  });

  test("27d: commands that change the stages, gates, or reviews the person sees, reach the remote, or run outside code keep the Allow prompt", () => {
    const s = scratch();
    try {
      seedAidlcScripts(s);
      const prompted = [
        // drop, skip, or add stages; change gates, reviews, or the settings behind them
        "aidlc engine recompose --skip security-review",
        "aidlc engine orchestrate next --skip security-review",
        "aidlc engine orchestrate next --skip=security-review",
        "aidlc engine jump execute --target code-generation --direction forward",
        "aidlc engine scope change --scope bugfix",
        "aidlc engine intent create auth-service --skip security-review",
        "aidlc engine config set review none",
        "aidlc engine config set depth minimal",
        "aidlc engine config set guard-policy off",
        "aidlc engine state set-unit-gate-rhythm unit-end",
        "aidlc engine state set-construction-checkpoints disabled",
        "aidlc engine state set-skeleton-stance skip",
        "aidlc engine state set-status Completed",
        "aidlc engine bolt set-autonomy --mode autonomous",
        "aidlc engine orchestrate next --add security-review",
        "aidlc engine orchestrate next --add=security-review",
        "aidlc engine orchestrate next config set review none",
        // switching the active intent or space redirects the work that follows
        "aidlc engine intent switch billing",
        "aidlc engine intent billing",
        "aidlc engine space switch team-b",
        "aidlc engine space team-b",
        // team Unit commands share claims and approvals through the remote
        "aidlc unit claim U01",
        "aidlc unit gate U01 --decision approve --user-input ok",
        "aidlc unit publish U01",
        "aidlc unit status",
        "bun .aidlc/tools/aidlc-unit.ts claim U01",
        // project linters, type checkers, and host plugins are not AI-DLC's code
        "aidlc engine sensor-linter --file-path src/a.ts",
        "aidlc engine sensor-type-check --file-path src/a.ts",
        "aidlc engine sensor fire linter",
        "aidlc engine plugin sync",
        "aidlc engine plugin select test-pro",
        "aidlc plugin build plugins/test-pro",
        "aidlc engine orchestrate next plugin sync",
        // knowledge onboarding and sync run the extractor the harness names
        "aidlc engine knowledge onboard --source docs/spec.pdf",
        "aidlc engine knowledge sync",
        "aidlc engine orchestrate next knowledge onboard --source docs/spec.pdf",
        // rewrite the installed runner skills
        "aidlc engine gen runners",
        "aidlc engine gen runner-scopes",
      ];
      for (const command of prompted) {
        const r = runAdapter(s, "guard-tool-call", shellCall(command));
        expect(r.code, command).toBe(0);
        expect(shellDecision(r).hookSpecificOutput?.permissionDecision, command).toBeUndefined();
      }
      // Every stage-status change the state-transition guard refuses keeps the
      // prompt even when a lowered Guard Policy lets it through.
      for (const verb of BLOCKED_STATE_TRANSITIONS) {
        const command = `aidlc engine state ${verb} requirements-analysis`;
        const r = runAdapter(s, "guard-tool-call", shellCall(command));
        expect(r.stdout, command).toBe("");
      }
      // Their read-only and routine siblings stay click-free.
      for (const command of [
        "aidlc engine gen runners --check",
        "aidlc engine gen stage-table",
        "aidlc engine sensor list",
        "aidlc engine plugin list",
        "aidlc engine config get depth",
        "aidlc engine scope save --name feature-lite",
        "aidlc engine intent list",
        "aidlc engine space list",
        "aidlc engine orchestrate next config get depth",
        "aidlc engine orchestrate next --scope feature -- add --skip to the parser",
        "aidlc engine state set-construction-iteration stage-major",
      ]) {
        const out = shellDecision(runAdapter(s, "guard-tool-call", shellCall(command)));
        expect(out.hookSpecificOutput?.permissionDecision, command).toBe("allow");
      }
      // `next --skip` and `next --add` are still claimed and rewritten; only the allow is withheld.
      for (const command of ["aidlc engine orchestrate next --skip security-review", "aidlc engine orchestrate next --add security-review"]) {
        const claimed = shellDecision(runAdapter(s, "guard-tool-call", shellCall(command)));
        expect(claimed.hookSpecificOutput?.updatedInput?.command, command).toContain(STUB_ATTEMPT);
      }
    } finally {
      s.cleanup();
    }
  });

  test("27e: a caller's own command, script, or a path outside the project keeps the Allow prompt", () => {
    const s = scratch();
    try {
      seedAidlcScripts(s);
      const outside = mkdtempSync(join(tmpdir(), "t250-outside-"));
      try {
        writeFileSync(join(outside, "notes.txt"), "x\n", "utf-8");
        symlinkSync(outside, join(s.projectRoot, "linked"));
        for (const command of [
          // a command the caller supplies
          'aidlc engine swarm check U01 --check-cmd "npm test"',
          "aidlc engine swarm check U01 --check-cmd=make",
          "bun .aidlc/tools/aidlc.ts engine swarm check U01 --check-cmd make",
          // a path outside the project, directly, through .., or through a symlink
          `aidlc doctor --export --output ${outside}`,
          "aidlc doctor --export --output ../elsewhere",
          `aidlc engine knowledge summarize --text-file ${join(outside, "notes.txt")}`,
          "aidlc engine knowledge summarize --text-file linked/notes.txt",
          "aidlc engine learnings persist --slug x --selections-json ../selections.json",
          `aidlc engine learnings persist --slug x --selections-json=${join(outside, "s.json")}`,
          `bun .aidlc/tools/aidlc-log.ts answers --project-dir=${outside}`,
          // the workflow commands too
          `aidlc engine orchestrate next --report ${join(outside, "notes.txt")}`,
          "aidlc engine orchestrate next --report ../elsewhere/report.md",
        ]) {
          const r = runAdapter(s, "guard-tool-call", shellCall(command));
          expect(r.code, command).toBe(0);
          expect(shellDecision(r).hookSpecificOutput?.permissionDecision, command).toBeUndefined();
        }
        for (const command of [
          "aidlc doctor --export --output aidlc/diagnostics",
          "aidlc engine knowledge summarize --text-file docs/notes.txt",
          "aidlc engine learnings persist --slug x --selections-json aidlc/selections.json",
          `bun .aidlc/tools/aidlc-log.ts answers --project-dir ${s.projectRoot}`,
        ]) {
          const out = shellDecision(runAdapter(s, "guard-tool-call", shellCall(command)));
          expect(out.hookSpecificOutput?.permissionDecision, command).toBe("allow");
        }
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      s.cleanup();
    }
  });

  test("27f: a bare aidlc the project could supply itself keeps the Allow prompt", () => {
    const s = scratch();
    try {
      seedAidlcScripts(s);
      const bare = "aidlc engine log answers";
      const source = "bun .aidlc/tools/aidlc-log.ts answers";
      const decision = (command: string, env: Record<string, string | undefined> = {}) =>
        shellDecision(runAdapter(s, "guard-tool-call", shellCall(command), env)).hookSpecificOutput?.permissionDecision;
      // The project's own aidlc/ folder is not a launcher.
      mkdirSync(join(s.projectRoot, "aidlc"), { recursive: true });
      expect(statSync(join(s.projectRoot, "aidlc")).isDirectory()).toBe(true);
      expect(decision(bare)).toBe("allow");
      // cmd runs a matching file in the working directory before PATH.
      for (const name of ["aidlc.cmd", "aidlc.bat", "aidlc.exe"]) {
        writeFileSync(join(s.projectRoot, name), "@echo off\r\n", "utf-8");
        expect(decision(bare), name).toBeUndefined();
        expect(decision(source), name).toBe("allow");
        rmSync(join(s.projectRoot, name));
      }
      // A PATH entry inside the project holds the project's own code.
      mkdirSync(join(s.projectRoot, "tools-bin"), { recursive: true });
      writeFileSync(join(s.projectRoot, "tools-bin", "aidlc"), "#!/bin/sh\n", "utf-8");
      const insidePath = `${join(s.projectRoot, "tools-bin")}${delimiter}${process.env.PATH ?? ""}`;
      expect(decision(bare, { PATH: insidePath })).toBeUndefined();
      expect(decision(bare, { PATH: `tools-bin${delimiter}${process.env.PATH ?? ""}` })).toBeUndefined();
      expect(decision(bare)).toBe("allow");
      rmSync(join(s.projectRoot, "tools-bin"), { recursive: true, force: true });
      // cmd also tries every extension PATHEXT lists, such as Python's .PY.
      writeFileSync(join(s.projectRoot, "aidlc.py"), "print(1)\n", "utf-8");
      expect(decision(bare, { PATHEXT: ".COM;.EXE;.BAT;.CMD;.PY" })).toBeUndefined();
      expect(decision(bare, { PATHEXT: ".COM;.EXE;.BAT;.CMD" })).toBe("allow");
      rmSync(join(s.projectRoot, "aidlc.py"));
    } finally {
      s.cleanup();
    }
  });

  test("27g: a recompose runs click-free only once the person has answered since the last gate", () => {
    const s = scratch();
    try {
      seedAidlcScripts(s);
      const decision = (command: string, acted: boolean) =>
        shellDecision(runAdapter(s, "guard-tool-call", shellCall(command), { T250_HUMAN_ACTED: acted ? "1" : undefined })).hookSpecificOutput?.permissionDecision;
      for (const command of [
        "aidlc engine recompose --skip security-review",
        "aidlc engine recompose --add security-review --review advisory",
        "bun .aidlc/tools/aidlc.ts engine recompose --skip security-review",
      ]) {
        // The person approved the reshape in chat: no second confirmation.
        expect(decision(command, true), command).toBe("allow");
        // The agent reshaping with no reply from the person keeps the prompt.
        expect(decision(command, false), command).toBeUndefined();
      }
      // Other stage changes keep the prompt either way.
      expect(decision("aidlc engine jump execute --target code-generation --direction forward", true)).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });

  test("27i: a Construction checkpoints change the person already chose runs click-free; autonomy keeps the prompt", () => {
    const s = scratch();
    try {
      seedAidlcScripts(s);
      const decision = (command: string, receipt?: string) =>
        shellDecision(runAdapter(s, "guard-tool-call", shellCall(command), { T250_POLICY_RECEIPT: receipt })).hookSpecificOutput?.permissionDecision;
      for (const command of [
        "aidlc engine state set-construction-checkpoints disabled",
        "bun .aidlc/tools/aidlc-state.ts set-construction-checkpoints disabled",
      ]) {
        // The receipt for exactly this value: no second confirmation.
        expect(decision(command, "Construction Checkpoints=disabled"), command).toBe("allow");
        // No receipt, or one for the other value, keeps the prompt.
        expect(decision(command), command).toBeUndefined();
        expect(decision(command, "Construction Checkpoints=enabled"), command).toBeUndefined();
      }
      // Autonomy has no recorded-choice receipt to bind to, so it keeps the prompt.
      expect(decision("aidlc engine bolt set-autonomy --mode autonomous", "Construction Checkpoints=disabled")).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });

  test("27h: in a Windows terminal a backslash is a plain path separator; under a POSIX shell it keeps the prompt", () => {
    // VS Code's Windows terminal is PowerShell or cmd, where `C:\work\app` is
    // an ordinary path (#1411). The payload's shell is simulated
    // here so the Windows rule also runs on Linux.
    const s = scratch();
    try {
      seedAidlcScripts(s);
      const outside = mkdtempSync(join(tmpdir(), "t250-outside-"));
      try {
        const win = (path: string) => path.replaceAll("/", "\\");
        const decision = (command: string, shell?: string) =>
          shellDecision(runAdapter(s, "guard-tool-call", { ...shellCall(command), tool_input: { command, ...(shell ? { shell } : {}) } })).hookSpecificOutput?.permissionDecision;
        const windowsShells = ["powershell", "C:\\Windows\\System32\\cmd.exe", "pwsh.exe", ...(process.platform === "win32" ? [undefined] : [])];
        for (const shell of windowsShells) {
          for (const command of [
            "aidlc engine knowledge summarize --text-file docs\\notes.txt",
            'aidlc engine knowledge summarize --text-file "docs\\my notes.txt"',
            "bun .aidlc\\tools\\aidlc-log.ts answers",
            `bun .aidlc/tools/aidlc-log.ts answers --project-dir ${win(s.projectRoot)}`,
          ]) expect(decision(command, shell), `${shell}: ${command}`).toBe("allow");
          for (const command of [
            // a Windows path outside the project still keeps the prompt
            "aidlc engine knowledge summarize --text-file ..\\elsewhere\\notes.txt",
            `aidlc engine knowledge summarize --text-file ${win(join(outside, "notes.txt"))}`,
            // a backslash right before a quote changes how the words split
            'aidlc engine knowledge summarize --text-file "docs\\"',
          ]) expect(decision(command, shell), `${shell}: ${command}`).toBeUndefined();
          // A plain backslash word is an ordinary word there, and what POSIX
          // reads as one quoted word is a chained `calc` in PowerShell, so the
          // hook refuses it as it refuses any chained AI-DLC command.
          expect(decision("aidlc engine log answers --stage a\\b", shell), String(shell)).toBe("allow");
          expect(decision('aidlc engine log answers --stage "a\\"; calc; \\"b"', shell), String(shell)).toBe("deny");
        }
        // A tool named for its shell is that shell, wherever the hook runs.
        const named = (command: string, toolName: string) =>
          shellDecision(runAdapter(s, "guard-tool-call", shellCall(command, "S-ALLOW", toolName))).hookSpecificOutput?.permissionDecision;
        expect(named("aidlc engine knowledge summarize --text-file docs\\notes.txt", "Bash")).toBeUndefined();
        // Under a POSIX shell (Git Bash, WSL) a backslash escapes the next
        // character, so it keeps today's rule.
        for (const shell of ["bash", "C:\\Program Files\\Git\\bin\\bash.exe", "wsl", ...(process.platform === "win32" ? [] : [undefined])]) {
          expect(decision("aidlc engine knowledge summarize --text-file docs\\notes.txt", shell), String(shell)).toBeUndefined();
          expect(decision("aidlc engine knowledge summarize --text-file docs/notes.txt", shell), String(shell)).toBe("allow");
        }
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      s.cleanup();
    }
  });

  test("28: chained, redirected, substituted, wrapped, host-only, machine, and other commands get no allow; denies are unchanged", () => {
    const s = scratch();
    try {
      seedAidlcScripts(s);
      for (const command of [
        "aidlc engine orchestrate next && echo done",
        "aidlc engine orchestrate next; rm -rf build",
        "aidlc engine orchestrate next | tee out.txt",
        "aidlc doctor > doctor.txt",
        "aidlc engine log answers > answers.txt",
        "aidlc engine orchestrate next $(whoami)",
        "bun .aidlc/tools/aidlc.ts doctor `whoami`",
      ]) {
        const out = shellDecision(runAdapter(s, "guard-tool-call", shellCall(command)));
        expect(out.hookSpecificOutput?.permissionDecision, command).toBe("deny");
        expect(out.hookSpecificOutput?.permissionDecisionReason, command).toContain("Use one simple");
        expect(out.hookSpecificOutput?.updatedInput, command).toBeUndefined();
      }
      for (const command of [
        "echo hello",
        "git status",
        "npm test",
        'bash -lc "aidlc engine orchestrate next"',
        "env AIDLC_X=1 aidlc engine orchestrate next",
        'aidlc engine orchestrate next --scope "$SCOPE"',
        "aidlc engine orchestrate next src/*.ts",
        // host-only and internal routes: hooks, adapters, statusline
        "aidlc engine hook record-human-turn",
        "aidlc engine adapter copilot record-human-turn",
        "bun .aidlc/tools/aidlc.ts engine adapter copilot guard-tool-call",
        "aidlc engine statusline",
        "aidlc engine __sensor-script linter",
        "aidlc --internal-aidlc-record-human-turn .aidlc/hooks/aidlc-record-human-turn.ts",
        "aidlc engine log answers --internal-aidlc-record-human-turn",
        "bun .aidlc/hooks/aidlc-record-human-turn.ts",
        // machine-level commands the person runs, not a stage
        "aidlc update",
        "aidlc uninstall --yes",
        "aidlc use 2.9.0",
        "aidlc config --harness copilot --yes",
        "aidlc system lifecycle install-apply",
        "aidlc system config global --show",
        "aidlc doctor --check-updates",
        "aidlc doctor --release-base-url https://example.test",
        "aidlc doctor --output",
        // not a route, or not the route the script serves
        "aidlc status",
        "aidlc engine log bogus",
        "bun .aidlc/tools/aidlc-orchestrate.ts doctor",
        "bun .aidlc/tools/aidlc-orchestrate.ts help",
        "bun .aidlc/tools/aidlc-utility.ts status",
        "bun .aidlc/tools/aidlc-lifecycle.ts update",
        "bun .aidlc/tools/aidlc-missing.ts answer",
        // a tool script with shell syntax keeps today's no-decision answer
        "bun .aidlc/tools/aidlc-log.ts answers && echo done",
        "bun .aidlc/tools/aidlc-log.ts answers --project-dir /tmp",
      ]) {
        const r = runAdapter(s, "guard-tool-call", shellCall(command));
        expect(r.code, command).toBe(0);
        expect(r.stdout, command).toBe("");
      }
    } finally {
      s.cleanup();
    }
  });

  test("29: a guard that denies keeps its deny, and a guard that crashes withholds the allow", () => {
    for (const hook of SHELL_GUARDS) {
      const denied = scratch();
      try {
        seedAidlcScripts(denied);
        writeFileSync(join(denied.hooksDir, hook), stubHookBody(hook, 2, `blocked by ${hook}`), "utf-8");
        for (const command of ["aidlc engine orchestrate next", "aidlc doctor", "aidlc engine log answers"]) {
          const out = shellDecision(runAdapter(denied, "guard-tool-call", shellCall(command)));
          expect(out.hookSpecificOutput?.permissionDecision, `${hook}: ${command}`).toBe("deny");
          expect(out.hookSpecificOutput?.permissionDecisionReason, `${hook}: ${command}`).toContain(`blocked by ${hook}`);
          expect(out.hookSpecificOutput?.updatedInput, `${hook}: ${command}`).toBeUndefined();
          expect(out.modifiedArgs, `${hook}: ${command}`).toBeUndefined();
        }
      } finally {
        denied.cleanup();
      }
      const crashed = scratch();
      try {
        seedAidlcScripts(crashed);
        writeFileSync(join(crashed.hooksDir, hook), stubHookBody(hook, 1, "boom"), "utf-8");
        // The crash still fails open exactly as before: the rewrite stands, but
        // AI-DLC does not vouch, so the host's own approval applies.
        const rewritten = shellDecision(runAdapter(crashed, "guard-tool-call", shellCall("aidlc engine orchestrate next")));
        expect(rewritten.hookSpecificOutput?.permissionDecision, hook).toBeUndefined();
        expect(rewritten.hookSpecificOutput?.updatedInput?.command, hook).toContain(STUB_ATTEMPT);
        expect(rewritten.modifiedArgs?.command, hook).toContain(STUB_ATTEMPT);
        for (const command of ["aidlc doctor", "aidlc engine log answers"]) {
          const utility = runAdapter(crashed, "guard-tool-call", shellCall(command));
          expect(utility.code, `${hook}: ${command}`).toBe(0);
          expect(utility.stdout, `${hook}: ${command}`).toBe("");
        }
      } finally {
        crashed.cleanup();
      }
    }
  });

  test("30: an argument another shell would read differently keeps the prompt: PowerShell, cmd, and aidlc.cmd's re-parse", () => {
    // VS Code runs the command in the person's own terminal: PowerShell or cmd
    // on Windows, where AI-DLC's aidlc.cmd also re-reads its arguments through
    // %*. A character any of them treats specially, inside quotes or not,
    // means no decision (the host's prompt), never a deny.
    const s = scratch();
    try {
      seedAidlcScripts(s);
      const risky = [
        // PowerShell: subexpressions, splatting, script blocks, variables, escapes, comments
        "--stage (calc)",
        "--stage @(calc)",
        "--stage '@(calc)'",
        "--stage {calc}",
        "--stage '$(calc)'",
        "--stage '$env:USERPROFILE'",
        '--stage "a\\"; calc; \\"b"',
        "--stage 'a`b'",
        "--stage x #comment",
        "--stage 'a<#b'",
        // a typographic quote PowerShell reads as the end of the string
        '--stage "a\u201d; calc; \u201cb"',
        "--stage 'a\u2019; calc; \u2018b'",
        // PowerShell's doubled-quote escapes inside one word
        "--stage 'a''b'",
        '--stage "a""b"',
        // cmd: separators, pipes, redirects, carets, and variable expansion
        '--stage "a&calc"',
        '--stage "a|calc"',
        '--stage "a>out.txt"',
        '--stage "a<in.txt"',
        '--stage "a^&calc"',
        '--stage "%USERPROFILE%"',
        '--stage "!PATH!"',
        "--stage a;calc",
        // a backslash (an escape outside Windows; 27h covers PowerShell and cmd),
        // a tab, a line break, and characters outside plain ASCII
        ...(process.platform === "win32" ? [] : ["--stage a\\b"]),
        "--stage\ta",
        "--stage a\r\ncalc",
        '--stage "caf\u00e9"',
        '--stage "a\uff02b"',
        // a single quote inside single quotes, a double quote inside single quotes
        "--stage 'a\"b'",
      ];
      for (const args of risky) {
        for (const command of [
          `aidlc engine log answers ${args}`,
          `bun .aidlc/tools/aidlc.ts engine log answers ${args}`,
          `bun .aidlc/tools/aidlc-log.ts answers ${args}`,
        ]) {
          const r = runAdapter(s, "guard-tool-call", shellCall(command));
          expect(r.code, command).toBe(0);
          const out = shellDecision(r);
          expect(out.hookSpecificOutput?.permissionDecision, command).not.toBe("allow");
        }
        // A workflow command is still claimed and rewritten, without the allow.
        const report = `aidlc engine orchestrate report --stage requirements-analysis --result completed --user-input ${args.replace(/^--stage /, "")}`;
        const out = shellDecision(runAdapter(s, "guard-tool-call", shellCall(report)));
        expect(out.hookSpecificOutput?.permissionDecision, report).not.toBe("allow");
      }
      // None of the risky forms that the POSIX reading calls simple is denied:
      // the person sees the host's own prompt and decides.
      for (const command of [
        "aidlc engine log answers --stage @(calc)",
        // PowerShell and cmd read this as a chained `calc` (27h), so only a
        // POSIX terminal calls it simple
        ...(process.platform === "win32" ? [] : ['aidlc engine log answers --stage "a\\"; calc; \\"b"']),
        'aidlc engine log answers --stage "a&calc"',
        'aidlc engine log answers --stage "%USERPROFILE%"',
        'aidlc engine log answers --stage "a\u201d; calc; \u201cb"',
      ]) {
        const r = runAdapter(s, "guard-tool-call", shellCall(command));
        expect(r.code, command).toBe(0);
        expect(r.stdout, command).toBe("");
      }
      // Plain words, a quoted phrase, an apostrophe or question mark inside
      // double quotes, `--key=value`, and one terminal 2>&1 stay click-free.
      for (const command of [
        'aidlc engine log answer --stage requirements-analysis --question q1 --answer "Yes, use the default"',
        "aidlc engine log answer --stage requirements-analysis --question q1 --answer 'option B'",
        `aidlc engine log answer --stage requirements-analysis --question q1 --answer "Let's keep it, why not?"`,
        'aidlc engine log answers --stage="requirements-analysis"',
        "bun .aidlc/tools/aidlc-log.ts answers --stage requirements-analysis 2>&1",
      ]) {
        const out = shellDecision(runAdapter(s, "guard-tool-call", shellCall(command)));
        expect(out.hookSpecificOutput?.permissionDecision, command).toBe("allow");
      }
      const plainReport = shellDecision(runAdapter(s, "guard-tool-call", shellCall(
        'aidlc engine orchestrate report --stage requirements-analysis --result completed --user-input "approve it"',
      )));
      expect(plainReport.hookSpecificOutput?.permissionDecision).toBe("allow");
      expect(plainReport.hookSpecificOutput?.updatedInput?.command).toContain(STUB_ATTEMPT);
    } finally {
      s.cleanup();
    }
  });

  test("30b: a command behind an environment assignment in any shell keeps the prompt", () => {
    const s = scratch();
    try {
      seedAidlcScripts(s);
      for (const command of [
        "AIDLC_UNATTENDED=1 aidlc engine log answers",
        "env AIDLC_UNATTENDED=1 aidlc engine log answers",
        "$env:AIDLC_UNATTENDED=1; aidlc engine log answers",
        '$env:AIDLC_UNATTENDED = "1"; aidlc engine log answers',
        "set AIDLC_UNATTENDED=1 && aidlc engine log answers",
        "cmd /c aidlc engine log answers",
        "powershell -Command aidlc engine log answers",
        "& aidlc engine log answers",
        ". aidlc engine log answers",
      ]) {
        const r = runAdapter(s, "guard-tool-call", shellCall(command));
        expect(r.code, command).toBe(0);
        expect(shellDecision(r).hookSpecificOutput?.permissionDecision, command).not.toBe("allow");
      }
    } finally {
      s.cleanup();
    }
  });

  test("31: a global flag before the verb reads the same verb the dispatcher routes", () => {
    const s = scratch();
    try {
      seedAidlcScripts(s);
      // The dispatcher drops --json, --quiet, --no-color, --yes, --offline, and
      // --verbose before routing, so these are the destructive verbs.
      for (const command of [
        "aidlc engine intent --json archive auth-service --reason done",
        "aidlc unit --json land U01",
        "aidlc unit --quiet --yes land U01",
        "aidlc engine swarm --json finalize --batch 1 --units a,b --claimed a",
        "aidlc engine worktree --no-color discard --slug bolt-a",
        "aidlc engine worktree --verbose merge --slug bolt-a --target main --strategy merge",
        "aidlc --json engine intent archive auth-service --reason done",
        "bun .aidlc/tools/aidlc.ts engine intent --offline archive auth-service --reason done",
        "bun .aidlc/tools/aidlc-unit.ts --json land U01",
        "bun .aidlc/tools/aidlc-worktree.ts --json discard --slug bolt-a",
        // The workflow verbs are claimed only in their exact form; behind a
        // flag or an alias they are not AI-DLC's vouched-for command.
        "aidlc engine orchestrate --json next",
        "aidlc engine orchestrate --quiet report --stage requirements-analysis --result completed",
        "bun .aidlc/tools/aidlc-orchestrate.ts --json next",
        "aidlc --scope feature",
        "aidlc compose add a login page",
      ]) {
        const r = runAdapter(s, "guard-tool-call", shellCall(command));
        expect(r.code, command).toBe(0);
        expect(r.stdout, command).toBe("");
      }
      // Their routine siblings keep the allow with the same flags.
      for (const command of [
        "aidlc engine intent --json list",
        "aidlc unit --json merge-status U01",
        "aidlc engine worktree --json list",
        "bun .aidlc/tools/aidlc-unit.ts --json merge-status U01",
      ]) {
        const out = shellDecision(runAdapter(s, "guard-tool-call", shellCall(command)));
        expect(out.hookSpecificOutput?.permissionDecision, command).toBe("allow");
      }
    } finally {
      s.cleanup();
    }
  });
});
