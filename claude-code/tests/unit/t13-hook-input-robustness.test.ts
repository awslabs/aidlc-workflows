// covers: hook:aidlc-audit-logger, hook:aidlc-validate-state, hook:aidlc-session-start, hook:aidlc-statusline, hook:aidlc-log-subagent, hook:aidlc-sensor-fire, hook:aidlc-runtime-compile
//
// t13 — adversarial-input robustness for the framework's stdin-driven hooks.
// Migrated from tests/unit/t13-hook-input-robustness.sh (TAP plan 20).
// Mechanism: cli.
//
// WHY CLI (process-boundary, not in-process): the SUBJECT is the set of
// shipped hooks, not pure functions. Each hook reads its payload from STDIN
// (`await Bun.stdin.text()`) or from the state file, resolves projectDir from
// CLAUDE_PROJECT_DIR / the workspace JSON / its own script path, and
// terminates the process via `process.exit(...)` (or by falling off the end
// after a `process.stdout.write`). The module's top level RUNS on import and
// exits the process — none of the stdin seam, the env/script-path projectDir
// derivation, or the exit codes is reachable by importing a function. So this
// twin SPAWNS each real shipped hook exactly the way Claude Code drives it
// from settings.json, feeding adversarial bytes on stdin / into the state
// file: `Bun.spawnSync({ cmd: [BUN, HOOK], stdin: <bytes>, env: {…CLAUDE_PROJECT_DIR} })`.
//
// §6-E NON-GOLDEN CLASS (adversarial input): the .sh's contract is the
// always-exit-0 robustness guarantee — a hook handed a shell-injection string,
// a path with spaces, missing/null JSON keys, a backtick payload, or unicode
// must NOT crash and must NOT execute the injected command. A happy-path-only
// twin would NOT be equal-or-stronger, so every case below FIRES the exact
// adversarial payload the .sh fired. Where the .sh only checked the exit code,
// this twin is STRONGER: the injection cases also assert the injection token
// survives VERBATIM as a literal in the artifact the hook wrote (audit.md /
// recovery breadcrumb / statusline output) — proving the shell never
// interpolated `$(whoami)` / `` `whoami` `` (verified: the audit-logger writes
// the raw file_path into its `**File**:` field; the shell never expands it).
//
// SOURCE UNDER TEST — the always-exit-0 / robustness contract per hook:
//   hooks/aidlc-audit-logger.ts   :31 TTY exit0; :37-40 bad-JSON exit0;
//                                   :43 tool_name ?? ""; :44 file_path ?? "";
//                                   :100-105 emit failure -> recordHookDrop + exit0
//   hooks/aidlc-validate-state.ts :30 no-state-file exit0; reads STATE not stdin
//                                   (ignores stdin entirely); :60-72 emit
//                                   failure non-fatal
//   hooks/aidlc-session-start.ts  :39 no-state-file exit0; :58-76 stdin read is
//                                   try/wrapped, malformed -> source="malformed";
//                                   :88-93 emit failure non-fatal
//   hooks/aidlc-statusline.ts     :193 TTY -> "" stdin; :195-199 malformed JSON
//                                   swallowed; :208-211 no state -> "[AIDLC] ready"
//   hooks/aidlc-log-subagent.ts   :28 TTY exit0; :34-37 bad-JSON exit0;
//                                   :40-42 agent_* ?? defaults; :45 no-audit exit0;
//                                   :53-58 emit failure -> recordHookDrop + exit0
//   hooks/aidlc-sensor-fire.ts    :17 "always exit 0" contract; :53 TTY exit0;
//                                   :61-67 bad-JSON exit0; :74 empty path exit0;
//                                   :90 no-audit exit0
//   hooks/aidlc-runtime-compile.ts:40 TTY exit0; :45-51 bad-JSON exit0;
//                                   :52 command ?? ""; :64 no-command-match exit0
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project / seed_audit_file /
// per-case state heredocs + cleanup_test_project, one fresh project per case):
//   - createTestProject() -> a fresh temp dir with aidlc-docs/.
//   - seedAuditFile() -> copies tests/fixtures/audit-sample.md to
//     aidlc-docs/audit.md (the precondition for the audit-emitting hooks).
//   - state-file cases write the SAME state bytes the .sh heredoc'd, including
//     the injection tokens embedded in field values (Phase/Stage).
//   - tests 7-10 used a project dir whose NAME contains spaces ("aidlc test
//     space"); reproduced via mkdtemp with a spaced prefix.
//   - cleanupTestProject() rm -rf's each temp project. Nothing written under
//     tests/fixtures/**.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test();
// injection cases STRONGER via verbatim-survival assertions):
//   .sh test 1  audit-logger shell injection exits 0          -> "audit-logger: survives shell injection (exit 0, token verbatim)"
//   .sh test 2  validate-state shell injection exits 0        -> "validate-state: survives shell injection in state file (exit 0, token verbatim)"
//   .sh test 3  session-start shell injection exits 0         -> "session-start: survives shell injection in state file (exit 0, token verbatim)"
//   .sh test 4  statusline shell injection exits 0            -> "statusline: survives shell injection (exit 0, token verbatim)"
//   .sh test 5  log-subagent shell injection exits 0          -> "log-subagent: survives shell injection (exit 0, token verbatim)"
//   .sh test 6  audit-logger paths with spaces exits 0        -> "audit-logger: handles a file path with spaces (exit 0)"
//   .sh test 7  validate-state project dir with spaces exits 0-> "validate-state: handles a project dir with spaces (exit 0)"
//   .sh test 8  session-start project dir with spaces exits 0 -> "session-start: handles a project dir with spaces (exit 0)"
//   .sh test 9  statusline project dir with spaces exits 0    -> "statusline: handles a project dir with spaces (exit 0)"
//   .sh test 10 log-subagent project dir with spaces exits 0  -> "log-subagent: handles a project dir with spaces (exit 0)"
//   .sh test 11 audit-logger empty JSON exits 0               -> "audit-logger: handles empty JSON {} (exit 0)"
//   .sh test 12 log-subagent empty JSON exits 0               -> "log-subagent: handles empty JSON {} (exit 0)"
//   .sh test 13 statusline empty JSON exits 0                 -> "statusline: handles empty JSON {} (exit 0)"
//   .sh test 14 audit-logger null JSON values exits 0         -> "audit-logger: handles null JSON values (exit 0)"
//   .sh test 15 audit-logger backtick injection exits 0       -> "audit-logger: survives backtick injection (exit 0, token verbatim)"
//   .sh test 16 audit-logger unicode in path exits 0          -> "audit-logger: handles unicode in the path (exit 0)"
//   .sh test 17 validate-state ignores stdin gracefully exit 0-> "validate-state: ignores empty JSON on stdin (exit 0)"
//   .sh test 18 session-start ignores stdin gracefully exit 0 -> "session-start: ignores empty JSON on stdin (exit 0)"
//   .sh test 19 sensor-fire shell injection exits 0           -> "sensor-fire: survives shell injection (exit 0)"
//   .sh test 20 runtime-compile empty JSON exits 0            -> "runtime-compile: handles empty JSON {} (exit 0)"
//
// 20 .sh asserts -> 20 expect()-bearing test() cases (8 STRONGER: the five
// shell-injection rows + the backtick row + statusline injection + the two
// state-file injection rows additionally pin VERBATIM survival of the
// injection token in the written artifact, proving non-execution).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAuditFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test

const HOOK_AUDIT = join(AIDLC_SRC, "hooks", "aidlc-audit-logger.ts");
const HOOK_VALIDATE = join(AIDLC_SRC, "hooks", "aidlc-validate-state.ts");
const HOOK_SESSION = join(AIDLC_SRC, "hooks", "aidlc-session-start.ts");
const HOOK_STATUS = join(AIDLC_SRC, "hooks", "aidlc-statusline.ts");
const HOOK_SUBAGENT = join(AIDLC_SRC, "hooks", "aidlc-log-subagent.ts");
const HOOK_SENSOR = join(AIDLC_SRC, "hooks", "aidlc-sensor-fire.ts");
const HOOK_RUNTIME = join(AIDLC_SRC, "hooks", "aidlc-runtime-compile.ts");

interface FireResult {
  exitCode: number;
  stdout: string;
}

/**
 * Fire a stdin-driven hook once with `json` on stdin under the given project
 * dir — the .sh's `echo '<json>' | CLAUDE_PROJECT_DIR=$PROJ bun $HOOK`. stderr
 * is discarded (the .sh ran `2>/dev/null`); stdout is captured so injection
 * cases can assert the written output carries the token verbatim.
 */
function fireStdin(hook: string, json: string, proj: string): FireResult {
  const r = Bun.spawnSync({
    cmd: [BUN, hook],
    stdin: new TextEncoder().encode(json),
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  return { exitCode: r.exitCode, stdout: new TextDecoder().decode(r.stdout) };
}

/**
 * Fire a state-file-driven hook (validate-state / session-start) that reads no
 * meaningful stdin — the .sh ran `CLAUDE_PROJECT_DIR=$PROJ bun $HOOK` with no
 * pipe. We attach an empty stdin so neither blocks on a terminal read.
 */
function fireState(hook: string, proj: string): FireResult {
  return fireStdin(hook, "", proj);
}

/** Write the given aidlc-state.md body into <proj>/aidlc-docs/. */
function writeState(proj: string, body: string): void {
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
  writeFileSync(join(proj, "aidlc-docs", "aidlc-state.md"), body, "utf-8");
}

function auditPath(proj: string): string {
  return join(proj, "aidlc-docs", "audit.md");
}

function writeJson(filePath: string): string {
  return JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath } });
}

// A project dir whose NAME contains spaces (the .sh's
// `mktemp -d "/tmp/aidlc test space XXXXXX"`). Returned dirs are tracked and
// torn down in afterEach.
const spacedDirs: string[] = [];
function makeSpacedProject(): string {
  const proj = mkdtempSync(join(tmpdir(), "aidlc test space "));
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
  spacedDirs.push(proj);
  return proj;
}

let proj: string;

describe("t13 hook input robustness (mechanism cli — spawned hooks + adversarial stdin/state seam)", () => {
  beforeEach(() => {
    proj = createTestProject();
  });

  afterEach(() => {
    cleanupTestProject(proj);
    while (spacedDirs.length) rmSync(spacedDirs.pop() as string, { recursive: true, force: true });
  });

  // ===========================================================================
  // Test A — shell injection: hooks must not execute injected commands.
  // ===========================================================================

  test("audit-logger: survives shell injection (exit 0, token verbatim) [.sh test 1]", () => {
    seedAuditFile(proj);
    const r = fireStdin(HOOK_AUDIT, writeJson(join(proj, "aidlc-docs", "$(whoami)", "test.md")), proj);
    expect(r.exitCode).toBe(0);
    // STRONGER: the injected path lands verbatim in the **File**: field — the
    // shell never interpolated `$(whoami)` (would otherwise have been expanded
    // to the username and the literal token would be gone).
    expect(readFileSync(auditPath(proj), "utf-8")).toContain("$(whoami)/test.md");
  });

  test("validate-state: survives shell injection in state file (exit 0, token verbatim) [.sh test 2]", () => {
    writeState(
      proj,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: $(whoami)\n- **Current Stage**: `whoami`\n## Stage Progress\n### $(whoami) PHASE\n- [ ] test — EXECUTE\n",
    );
    const r = fireState(HOOK_VALIDATE, proj);
    expect(r.exitCode).toBe(0);
    // STRONGER: validate-state writes the **Current stage** verbatim into the
    // recovery breadcrumb; the backtick `whoami` survives, never executed.
    const recovery = join(proj, "aidlc-docs", ".aidlc-recovery.md");
    expect(existsSync(recovery)).toBe(true);
    expect(readFileSync(recovery, "utf-8")).toContain("`whoami`");
  });

  test("session-start: survives shell injection in state file (exit 0, token verbatim) [.sh test 3]", () => {
    writeState(
      proj,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: $(whoami)\n- **Current Stage**: `whoami`\n- **Active Agent**: aidlc-product-agent\n- **Scope**: feature\n## Stage Progress\n### $(whoami) PHASE\n- [ ] test — EXECUTE\n",
    );
    const r = fireState(HOOK_SESSION, proj);
    expect(r.exitCode).toBe(0);
    // STRONGER: session-start injects the field values into its additionalContext
    // JSON on stdout; the injection tokens survive verbatim, never executed.
    expect(r.stdout).toContain("$(whoami)");
    expect(r.stdout).toContain("`whoami`");
  });

  test("statusline: survives shell injection (exit 0, token verbatim) [.sh test 4]", () => {
    writeState(
      proj,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: IDEATION\n- **Current Stage**: $(whoami)\n- **Active Agent**: aidlc-product-agent\n## Stage Progress\n### IDEATION PHASE\n- [ ] test — EXECUTE\n",
    );
    const r = fireStdin(HOOK_STATUS, JSON.stringify({ workspace: { project_dir: proj } }), proj);
    expect(r.exitCode).toBe(0);
    // STRONGER: the unmapped stage value renders verbatim into the statusline
    // (STAGE_DISPLAY has no entry for the injected token, so it falls through);
    // the shell never expanded it.
    expect(r.stdout).toContain("$(whoami)");
  });

  test("log-subagent: survives shell injection (exit 0, token verbatim) [.sh test 5]", () => {
    seedAuditFile(proj);
    const r = fireStdin(
      HOOK_SUBAGENT,
      JSON.stringify({ agent_type: "$(whoami)", agent_id: "`whoami`", last_assistant_message: "done" }),
      proj,
    );
    expect(r.exitCode).toBe(0);
    // STRONGER: both injection tokens land verbatim in the SUBAGENT_COMPLETED
    // audit block's Agent Type / Agent ID fields — neither was executed.
    const audit = readFileSync(auditPath(proj), "utf-8");
    expect(audit).toContain("$(whoami)");
    expect(audit).toContain("`whoami`");
  });

  // ===========================================================================
  // Test B — paths with spaces: hooks handle spaces gracefully.
  // ===========================================================================

  test("audit-logger: handles a file path with spaces (exit 0) [.sh test 6]", () => {
    seedAuditFile(proj);
    const r = fireStdin(HOOK_AUDIT, writeJson(join(proj, "aidlc-docs", "my folder", "test file.md")), proj);
    expect(r.exitCode).toBe(0);
    // The spaced path is logged verbatim — no word-splitting truncation.
    expect(readFileSync(auditPath(proj), "utf-8")).toContain("my folder/test file.md");
  });

  test("validate-state: handles a project dir with spaces (exit 0) [.sh test 7]", () => {
    const spaced = makeSpacedProject();
    writeState(
      spaced,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: IDEATION\n- **Current Stage**: feasibility\n## Stage Progress\n### IDEATION PHASE\n- [ ] feasibility — EXECUTE\n",
    );
    expect(fireState(HOOK_VALIDATE, spaced).exitCode).toBe(0);
    // The recovery breadcrumb landed under the spaced project dir.
    expect(existsSync(join(spaced, "aidlc-docs", ".aidlc-recovery.md"))).toBe(true);
  });

  test("session-start: handles a project dir with spaces (exit 0) [.sh test 8]", () => {
    const spaced = makeSpacedProject();
    writeState(
      spaced,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: IDEATION\n- **Current Stage**: feasibility\n- **Active Agent**: aidlc-product-agent\n- **Scope**: feature\n## Stage Progress\n### IDEATION PHASE\n- [ ] feasibility — EXECUTE\n",
    );
    const r = fireState(HOOK_SESSION, spaced);
    expect(r.exitCode).toBe(0);
    // The context payload resolved against the spaced dir's state file.
    expect(r.stdout).toContain("AIDLC WORKFLOW ACTIVE");
  });

  test("statusline: handles a project dir with spaces (exit 0) [.sh test 9]", () => {
    const spaced = makeSpacedProject();
    writeState(
      spaced,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: IDEATION\n- **Current Stage**: feasibility\n- **Active Agent**: aidlc-product-agent\n## Stage Progress\n### IDEATION PHASE\n- [ ] feasibility — EXECUTE\n",
    );
    const r = fireStdin(HOOK_STATUS, JSON.stringify({ workspace: { project_dir: spaced } }), spaced);
    expect(r.exitCode).toBe(0);
    // The state under the spaced dir resolved — the rendered line is not the
    // bare "[AIDLC] ready" no-state fallback.
    expect(r.stdout).toContain("[AIDLC] IDEATION");
  });

  test("log-subagent: handles a project dir with spaces (exit 0) [.sh test 10]", () => {
    const spaced = makeSpacedProject();
    seedAuditFile(spaced);
    expect(
      fireStdin(
        HOOK_SUBAGENT,
        JSON.stringify({ agent_type: "developer", agent_id: "test-123", last_assistant_message: "done" }),
        spaced,
      ).exitCode,
    ).toBe(0);
    // The emit landed in the audit file under the spaced dir.
    expect(readFileSync(join(spaced, "aidlc-docs", "audit.md"), "utf-8")).toContain("SUBAGENT_COMPLETED");
  });

  // ===========================================================================
  // Test C — missing JSON keys: empty JSON {} to stdin hooks.
  // ===========================================================================

  test("audit-logger: handles empty JSON {} (exit 0) [.sh test 11]", () => {
    seedAuditFile(proj);
    const before = readFileSync(auditPath(proj), "utf-8");
    const r = fireStdin(HOOK_AUDIT, "{}", proj);
    expect(r.exitCode).toBe(0);
    // No file_path -> the includes("aidlc-docs/") gate fails -> exit 0, no write.
    expect(readFileSync(auditPath(proj), "utf-8")).toBe(before);
  });

  test("log-subagent: handles empty JSON {} (exit 0) [.sh test 12]", () => {
    seedAuditFile(proj);
    expect(fireStdin(HOOK_SUBAGENT, "{}", proj).exitCode).toBe(0);
    // {} is a valid ClaudeCodeHookInput shape -> agent fields default; audit.md
    // exists so a SUBAGENT_COMPLETED block is emitted with the default type.
    expect(readFileSync(auditPath(proj), "utf-8")).toContain("SUBAGENT_COMPLETED");
  });

  test("statusline: handles empty JSON {} (exit 0) [.sh test 13]", () => {
    const r = fireStdin(HOOK_STATUS, "{}", proj);
    expect(r.exitCode).toBe(0);
    // No project_dir in the JSON, no state file under proj -> ready fallback.
    expect(r.stdout).toContain("[AIDLC] ready");
  });

  // ===========================================================================
  // Edge cases — null values, backticks, unicode, stdin-ignoring hooks.
  // ===========================================================================

  test("audit-logger: handles null JSON values (exit 0) [.sh test 14]", () => {
    seedAuditFile(proj);
    const before = readFileSync(auditPath(proj), "utf-8");
    const r = fireStdin(HOOK_AUDIT, '{"tool_name":null,"tool_input":null}', proj);
    expect(r.exitCode).toBe(0);
    // tool_input null -> file_path ?? "" -> empty -> gate fails -> no write.
    expect(readFileSync(auditPath(proj), "utf-8")).toBe(before);
  });

  test("audit-logger: survives backtick injection (exit 0, token verbatim) [.sh test 15]", () => {
    seedAuditFile(proj);
    // The .sh's path was `whoami`/aidlc-docs/test.md — the backtick group is the
    // leading segment, with an aidlc-docs/ segment so the logging gate passes.
    const r = fireStdin(HOOK_AUDIT, writeJson("`whoami`/aidlc-docs/test.md"), proj);
    expect(r.exitCode).toBe(0);
    // STRONGER: the backtick token survives verbatim in the **File**: field.
    expect(readFileSync(auditPath(proj), "utf-8")).toContain("`whoami`/aidlc-docs/test.md");
  });

  test("audit-logger: handles unicode in the path (exit 0) [.sh test 16]", () => {
    seedAuditFile(proj);
    const r = fireStdin(HOOK_AUDIT, writeJson(join(proj, "aidlc-docs", "éèê", "tëst.md")), proj);
    expect(r.exitCode).toBe(0);
    // The non-ASCII path round-trips into the audit log without mangling.
    expect(readFileSync(auditPath(proj), "utf-8")).toContain("éèê/tëst.md");
  });

  test("validate-state: ignores empty JSON on stdin (exit 0) [.sh test 17]", () => {
    writeState(
      proj,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: IDEATION\n- **Current Stage**: feasibility\n## Stage Progress\n### IDEATION PHASE\n- [ ] feasibility — EXECUTE\n",
    );
    // validate-state reads the STATE file, not stdin; piping {} must be ignored.
    const r = fireStdin(HOOK_VALIDATE, "{}", proj);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(proj, "aidlc-docs", ".aidlc-recovery.md"))).toBe(true);
  });

  test("session-start: ignores empty JSON on stdin (exit 0) [.sh test 18]", () => {
    writeState(
      proj,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: IDEATION\n- **Current Stage**: feasibility\n- **Active Agent**: aidlc-product-agent\n- **Scope**: feature\n## Stage Progress\n### IDEATION PHASE\n- [ ] feasibility — EXECUTE\n",
    );
    const r = fireStdin(HOOK_SESSION, "{}", proj);
    expect(r.exitCode).toBe(0);
    // {} parses, carries no source -> treated as "unknown" (no event), but the
    // context-injection path still runs and emits the workflow header.
    expect(r.stdout).toContain("AIDLC WORKFLOW ACTIVE");
  });

  // ===========================================================================
  // Test D — v0.5.0 PostToolUse hooks (sensor-fire, runtime-compile): same
  // always-exit-0 contract under adversarial input.
  // ===========================================================================

  test("sensor-fire: survives shell injection (exit 0) [.sh test 19]", () => {
    seedAuditFile(proj);
    // sensor-fire's exit-code contract (G5) is "always exit 0"; with no active
    // workflow state it self-gates early. The injection token must not crash it.
    const r = fireStdin(HOOK_SENSOR, writeJson(join(proj, "aidlc-docs", "$(whoami)", "test.md")), proj);
    expect(r.exitCode).toBe(0);
  });

  test("runtime-compile: handles empty JSON {} (exit 0) [.sh test 20]", () => {
    seedAuditFile(proj);
    // {} carries no tool_input.command -> the command-match gate fails -> exit 0.
    const r = fireStdin(HOOK_RUNTIME, "{}", proj);
    expect(r.exitCode).toBe(0);
  });
});
