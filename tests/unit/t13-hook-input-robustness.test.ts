// covers: hook:aidlc-write-audit-log, hook:aidlc-validate-state, hook:aidlc-session-start, hook:aidlc-statusline, hook:aidlc-log-subagent, hook:aidlc-run-sensors, hook:aidlc-rebuild-stage-graph
//
// t13 — adversarial-input robustness for the framework's stdin-driven hooks.
// Mechanism: cli.
//
// WHY CLI (process-boundary, not in-process): the SUBJECT is the set of shipped
// hooks as Claude Code drives them from settings.json, so this twin SPAWNS each
// real shipped hook, feeding adversarial bytes on stdin / into the state
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
//   hooks/aidlc-write-audit-log.ts  TTY exit0; bad-JSON exit0;
//                                   tool_name ?? ""; file_path ?? "";
//                                   emit failure -> recordHookDrop + exit0
//   hooks/aidlc-validate-state.ts   no-state-file exit0; reads STATE not stdin
//                                   (ignores stdin entirely); emit
//                                   failure non-fatal
//   hooks/aidlc-session-start.ts    no-state-file exit0; stdin read is
//                                   try/wrapped, malformed -> source="malformed";
//                                   emit failure non-fatal
//   hooks/aidlc-statusline.ts       TTY -> "" stdin; malformed JSON
//                                   swallowed; no state -> "[AIDLC] ready"
//   hooks/aidlc-log-subagent.ts   : no-state exit0 before heartbeat; TTY exit0;
//                                   bad-JSON exit0; agent_* ?? defaults; emit
//                                   failure -> recordHookDrop + exit0
//   hooks/aidlc-run-sensors.ts      "always exit 0" contract; TTY exit0;
//                                   bad-JSON exit0; empty path exit0;
//                                   no-audit exit0
//   hooks/aidlc-rebuild-stage-graph.ts TTY exit0; bad-JSON exit0;
//                                   command ?? ""; no-command-match exit0

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededAuditDir,
  seededRecordDir,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;

const HOOK_AUDIT = join(AIDLC_SRC, "hooks", "aidlc-write-audit-log.ts");
const HOOK_VALIDATE = join(AIDLC_SRC, "hooks", "aidlc-validate-state.ts");
const HOOK_SESSION = join(AIDLC_SRC, "hooks", "aidlc-session-start.ts");
const HOOK_STATUS = join(AIDLC_SRC, "hooks", "aidlc-statusline.ts");
const HOOK_SUBAGENT = join(AIDLC_SRC, "hooks", "aidlc-log-subagent.ts");
const HOOK_SENSOR = join(AIDLC_SRC, "hooks", "aidlc-run-sensors.ts");
const HOOK_RUNTIME = join(AIDLC_SRC, "hooks", "aidlc-rebuild-stage-graph.ts");

// The audit-logger gates on the file_path being UNDER the active intent's record
// root (docsRoot()), and the audit-emitting hooks self-gate on workflow state
// and/or their resolved shard existing. So injection/space/unicode artifacts are
// written UNDER the seeded record (keeping the adversarial token as an INNER
// path segment), and the audit-emitting cases pin a clone-id + create the
// resolved shard. The adversarial CONTRACT: always exit 0, token never executed.
const PINNED_CLONE_ID = "testcloneid13";
function pinnedShardName(): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return `${host}-${PINNED_CLONE_ID}.md`;
}

/** Seed the per-intent workspace shell (active-space + spaces/default/intents/<record>/
 *  + cursors + registry) into an ARBITRARY dir. The fixtures' createTestProject
 *  does this for its own mkdtemp dir; the spaced-project cases below need it on a
 *  hand-rolled dir whose NAME carries spaces. Mirrors fixtures.ts seedWorkspaceShell. */
function seedShell(proj: string, space = DEFAULT_SPACE): void {
  const intentsDir = intentsDirOf(proj, space);
  mkdirSync(join(proj, "aidlc", "spaces", space, "memory"), { recursive: true });
  mkdirSync(join(intentsDir, DEFAULT_RECORD_DIR), { recursive: true });
  writeFileSync(join(proj, "aidlc", "active-space"), `${space}\n`, "utf-8");
  writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
  writeFileSync(
    join(intentsDir, "intents.json"),
    `${JSON.stringify(
      [{ uuid: "00000000-0000-7000-8000-000000000001", slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""), status: "in-flight" }],
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

/** Pin the clone-id + create the resolved empty audit shard for hooks that require
 *  it and for deterministic log-subagent reads. Returns the audit DIR. */
function seedAuditShard(proj: string): string {
  writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
  const auditDir = seededAuditDir(proj);
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(auditDir, pinnedShardName()), "", "utf-8");
  return auditDir;
}

function readShards(proj: string): string {
  const auditDir = seededAuditDir(proj);
  let names: string[];
  try {
    names = readdirSync(auditDir);
  } catch {
    return "";
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => readFileSync(join(auditDir, n), "utf-8"))
    .join("\n");
}

interface FireResult {
  exitCode: number;
  stdout: string;
}

/**
 * Fire a stdin-driven hook once with `json` on stdin under the given project
 * dir. stderr is discarded; stdout is captured so injection cases can assert
 * the written output carries the token verbatim.
 */
function fireStdin(hook: string, json: string, proj: string): FireResult {
  const r = Bun.spawnSync({
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cmd: [BUN, hook],
    stdin: new TextEncoder().encode(json),
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  return { exitCode: r.exitCode, stdout: new TextDecoder().decode(r.stdout) };
}

/**
 * Fire a state-file-driven hook (validate-state / session-start) with an empty
 * stdin so neither blocks on a terminal read.
 */
function fireState(hook: string, proj: string): FireResult {
  return fireStdin(hook, "", proj);
}

/** Write the given aidlc-state.md body into the default intent's record (so the
 *  active-intent cursor resolves and the hooks anchor under the record dir). */
function writeState(proj: string, body: string): void {
  mkdirSync(seededRecordDir(proj), { recursive: true });
  writeFileSync(join(seededRecordDir(proj), "aidlc-state.md"), body, "utf-8");
}

function recoveryPath(proj: string): string {
  return join(seededRecordDir(proj), ".aidlc-engine/recovery.md");
}

function writeJson(filePath: string): string {
  return JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath } });
}

const spacedDirs: string[] = [];
function makeSpacedProject(): string {
  const proj = mkdtempSync(join(tmpdir(), "aidlc test space "));
  seedShell(proj);
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
    writeState(proj, "# AI-DLC State Tracking\n## Current Status\n## Stage Progress\n");
    seedAuditShard(proj);
    const r = fireStdin(HOOK_AUDIT, writeJson(join(seededRecordDir(proj), "$(whoami)", "test.md")), proj);
    expect(r.exitCode).toBe(0);
    // The injected path lands verbatim in the **File**: field - the
    // shell never interpolated `$(whoami)` (would otherwise have been expanded
    // to the username and the literal token would be gone).
    expect(readShards(proj)).toContain("$(whoami)/test.md");
  });

  test("validate-state: survives shell injection in state file (exit 0, token verbatim) [.sh test 2]", () => {
    writeState(
      proj,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: $(whoami)\n- **Current Stage**: `whoami`\n## Stage Progress\n### $(whoami) PHASE\n- [ ] test — EXECUTE\n",
    );
    const r = fireState(HOOK_VALIDATE, proj);
    expect(r.exitCode).toBe(0);
    // validate-state writes the **Current stage** verbatim into the
    // recovery breadcrumb; the backtick `whoami` survives, never executed.
    const recovery = recoveryPath(proj);
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
    // session-start injects the field values into its additionalContext
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
    // The unmapped stage value renders verbatim into the statusline
    // (STAGE_DISPLAY has no entry for the injected token, so it falls through);
    // the shell never expanded it.
    expect(r.stdout).toContain("$(whoami)");
  });

  test("log-subagent: survives shell injection (exit 0, token verbatim) [.sh test 5]", () => {
    writeState(
      proj,
      "# AI-DLC State Tracking\n## Current Status\n- **Status**: Running\n## Stage Progress\n",
    );
    seedAuditShard(proj);
    const r = fireStdin(
      HOOK_SUBAGENT,
      JSON.stringify({ agent_type: "$(whoami)", agent_id: "`whoami`", last_assistant_message: "done" }),
      proj,
    );
    expect(r.exitCode).toBe(0);
    // Both injection tokens land verbatim in the SUBAGENT_COMPLETED
    // audit block's Agent Type / Agent ID fields — neither was executed.
    const audit = readShards(proj);
    expect(audit).toContain("$(whoami)");
    expect(audit).toContain("`whoami`");
  });

  // ===========================================================================
  // Test B — paths with spaces: hooks handle spaces gracefully.
  // ===========================================================================

  test("audit-logger: handles a file path with spaces (exit 0) [.sh test 6]", () => {
    writeState(proj, "# AI-DLC State Tracking\n## Current Status\n## Stage Progress\n");
    seedAuditShard(proj);
    const r = fireStdin(HOOK_AUDIT, writeJson(join(seededRecordDir(proj), "my folder", "test file.md")), proj);
    expect(r.exitCode).toBe(0);
    // The spaced path is logged verbatim — no word-splitting truncation.
    expect(readShards(proj)).toContain("my folder/test file.md");
  });

  test("validate-state: handles a project dir with spaces (exit 0) [.sh test 7]", () => {
    const spaced = makeSpacedProject();
    writeState(
      spaced,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: IDEATION\n- **Current Stage**: feasibility\n## Stage Progress\n### IDEATION PHASE\n- [ ] feasibility — EXECUTE\n",
    );
    expect(fireState(HOOK_VALIDATE, spaced).exitCode).toBe(0);
    expect(existsSync(recoveryPath(spaced))).toBe(true);
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
    // The state under the spaced dir resolved — the rendered line carries the
    // phase, not the bare "[AIDLC] ready" no-state fallback. (The per-intent
    // layout prefixes the intent slug: "[AIDLC] <slug> · IDEATION …".)
    expect(r.stdout).toContain("IDEATION");
    expect(r.stdout.trim()).not.toBe("[AIDLC] ready");
  });

  test("log-subagent: handles a project dir with spaces (exit 0) [.sh test 10]", () => {
    const spaced = makeSpacedProject();
    writeState(
      spaced,
      "# AI-DLC State Tracking\n## Current Status\n- **Status**: Running\n## Stage Progress\n",
    );
    seedAuditShard(spaced);
    expect(
      fireStdin(
        HOOK_SUBAGENT,
        JSON.stringify({ agent_type: "developer", agent_id: "test-123", last_assistant_message: "done" }),
        spaced,
      ).exitCode,
    ).toBe(0);
    expect(readShards(spaced)).toContain("SUBAGENT_COMPLETED");
  });

  // ===========================================================================
  // Test C — missing JSON keys: empty JSON {} to stdin hooks.
  // ===========================================================================

  test("audit-logger: handles empty JSON {} (exit 0) [.sh test 11]", () => {
    writeState(proj, "# AI-DLC State Tracking\n## Current Status\n## Stage Progress\n");
    const auditDir = seedAuditShard(proj);
    const before = readShards(proj);
    const r = fireStdin(HOOK_AUDIT, "{}", proj);
    expect(r.exitCode).toBe(0);
    // No file_path -> the under-record gate fails -> exit 0, no write.
    expect(readShards(proj)).toBe(before);
    void auditDir;
  });

  test("log-subagent: handles empty JSON {} (exit 0) [.sh test 12]", () => {
    writeState(
      proj,
      "# AI-DLC State Tracking\n## Current Status\n- **Status**: Running\n## Stage Progress\n",
    );
    seedAuditShard(proj);
    expect(fireStdin(HOOK_SUBAGENT, "{}", proj).exitCode).toBe(0);
    // {} is a valid ClaudeCodeHookInput shape -> agent fields default; the audit
    // shard exists so a SUBAGENT_COMPLETED block is emitted with the default type.
    expect(readShards(proj)).toContain("SUBAGENT_COMPLETED");
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
    writeState(proj, "# AI-DLC State Tracking\n## Current Status\n## Stage Progress\n");
    seedAuditShard(proj);
    const before = readShards(proj);
    const r = fireStdin(HOOK_AUDIT, '{"tool_name":null,"tool_input":null}', proj);
    expect(r.exitCode).toBe(0);
    // tool_input null -> file_path ?? "" -> empty -> gate fails -> no write.
    expect(readShards(proj)).toBe(before);
  });

  test("audit-logger: survives backtick injection (exit 0, token verbatim) [.sh test 15]", () => {
    writeState(proj, "# AI-DLC State Tracking\n## Current Status\n## Stage Progress\n");
    seedAuditShard(proj);
    // The gate keys on the record root, so the artifact lives UNDER the record - the
    // backtick token stays an inner segment, preserving the non-execution assertion.
    const r = fireStdin(HOOK_AUDIT, writeJson(join(seededRecordDir(proj), "`whoami`", "test.md")), proj);
    expect(r.exitCode).toBe(0);
    expect(readShards(proj)).toContain("`whoami`/test.md");
  });

  test("audit-logger: handles unicode in the path (exit 0) [.sh test 16]", () => {
    writeState(proj, "# AI-DLC State Tracking\n## Current Status\n## Stage Progress\n");
    seedAuditShard(proj);
    const r = fireStdin(HOOK_AUDIT, writeJson(join(seededRecordDir(proj), "éèê", "tëst.md")), proj);
    expect(r.exitCode).toBe(0);
    expect(readShards(proj)).toContain("éèê/tëst.md");
  });

  test("validate-state: ignores empty JSON on stdin (exit 0) [.sh test 17]", () => {
    writeState(
      proj,
      "# AI-DLC State Tracking\n## Current Status\n- **Lifecycle Phase**: IDEATION\n- **Current Stage**: feasibility\n## Stage Progress\n### IDEATION PHASE\n- [ ] feasibility — EXECUTE\n",
    );
    // validate-state reads workflow content from the STATE file; an empty stdin
    // object supplies no session metadata.
    const r = fireStdin(HOOK_VALIDATE, "{}", proj);
    expect(r.exitCode).toBe(0);
    expect(existsSync(recoveryPath(proj))).toBe(true);
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
  // Test D - PostToolUse hooks (sensor-fire, runtime-compile): same always-exit-0
  // contract under adversarial input.
  // ===========================================================================

  test("sensor-fire: survives shell injection (exit 0) [.sh test 19]", () => {
    // sensor-fire's exit-code contract (G5) is "always exit 0"; with no active
    // workflow state it self-gates early. The injection token must not crash it.
    const r = fireStdin(HOOK_SENSOR, writeJson(join(seededRecordDir(proj), "$(whoami)", "test.md")), proj);
    expect(r.exitCode).toBe(0);
  });

  test("runtime-compile: handles empty JSON {} (exit 0) [.sh test 20]", () => {
    // {} carries no tool_input.command -> the command-match gate fails -> exit 0.
    const r = fireStdin(HOOK_RUNTIME, "{}", proj);
    expect(r.exitCode).toBe(0);
  });
});
