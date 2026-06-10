// covers: hook:aidlc-session-start, function:appendAuditEntry
//
// t10 — aidlc-session-start.ts SessionStart hook behaviour. Migrated from
// tests/unit/t10-hook-session-start.sh (TAP plan 17). Mechanism: cli.
//
// WHY CLI (process-boundary, not in-process): the SUBJECT is a hook, not a
// pure function. aidlc-session-start.ts (dist/claude/.claude/hooks/) runs at
// module top level on import and TERMINATES the process:
//   :34  projectDir = resolveProjectDirFromHook(import.meta.url)
//   :39  if (!existsSync(stateFile)) process.exit(0)
//          — the "no active workflow" no-op gate (no heartbeat, no audit,
//            no stdout)
//   :42-44 mkdir aidlc-docs/.aidlc-hooks-health + write session-start.last
//          heartbeat (only reached when state IS present)
//   :55-75 source defaults to "startup"; when stdin is not a TTY it reads
//          Bun.stdin.text(), JSON.parses it, and pulls raw.source when the
//          payload is a valid Claude Code hook input (malformed -> "malformed",
//          empty -> "startup", non-input JSON -> "unknown")
//   :80-84 source->event map: startup|clear -> SESSION_STARTED,
//          resume -> SESSION_RESUMED, malformed -> SESSION_STARTED,
//          compact|unknown -> NO emission (compact is owned by PreCompact)
//   :87-93 appendAuditEntry(eventType, { Source }, projectDir) when an event
//          is mapped — writes a "**Event**: <type>" block to audit.md
//   :96-125 reads the state file, extracts the workflow fields via getField,
//          appends a ".aidlc-recovery.md exists" NOTE iff that breadcrumb file
//          is present, then writes JSON.stringify({ additionalContext }) +"\n"
//          to stdout
// None of those seams — stdin, the env/script-path projectDir derivation, the
// exit(0) no-op gate, the heartbeat write, the additionalContext stdout — is
// reachable by importing a function; the module's top level RUNS on import. So
// this twin SPAWNS the real shipped hook the same way Claude Code's
// SessionStart drives it from settings.json:
//   `Bun.spawnSync({ cmd: [BUN, HOOK], stdin: <json bytes>,
//                    env: {…CLAUDE_PROJECT_DIR} })`.
// Same pattern as t30 (session-end hook twin) and t07 (audit-logger hook twin).
//
// appendAuditEntry's on-disk block format (aidlc-audit.ts): SESSION_STARTED
// maps to the "## Session Started" heading and SESSION_RESUMED to
// "## Session Resumed"; the **Event**: <type> line is the canonical marker the
// .sh grepped for. Asserted below against the real bytes on disk.
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_state_file +
// seed_audit_file + cleanup_test_project, one fresh project per case):
//   - createTestProject() -> a fresh temp dir with aidlc-docs/.
//   - seedStateFile(proj, <fixture>) -> the canonical "active workflow" signal
//     the hook gates on (MID_IDEATION / state-construction / state-operation /
//     state-corrupted, the same fixture bytes the .sh used).
//   - seedAuditFile() -> copies tests/fixtures/audit-sample.md to
//     aidlc-docs/audit.md (the emit appends to it).
//   - cleanupTestProject() rm -rf's each temp project. Nothing written under
//     tests/fixtures/**.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh  1 (silent exit when no state file)            -> "silent exit (no stdout) when no state file"
//   .sh  2 (no heartbeat when no state file)           -> "no heartbeat when no state file"
//   .sh  3 (outputs valid JSON w/ additionalContext)   -> "outputs valid JSON with an additionalContext key"
//   .sh  4 (extracts Lifecycle Phase = IDEATION)       -> "injects the Lifecycle Phase (IDEATION)"
//   .sh  5 (extracts Current Stage = feasibility)      -> "injects the Current Stage (feasibility)"
//   .sh  6 (extracts Active Agent)                     -> "injects the Active Agent (aidlc-architect-agent)"
//   .sh  7 (extracts Scope = feature)                  -> "injects the Scope (feature)"
//   .sh  8 (recovery breadcrumb note present)          -> "includes the recovery-breadcrumb NOTE when .aidlc-recovery.md exists"
//   .sh  9 (no recovery note when no breadcrumb)       -> "omits the recovery-breadcrumb NOTE when no breadcrumb"
//   .sh 10 (writes heartbeat when state exists)        -> "writes the session-start.last heartbeat when state exists"
//   .sh 11 (CONSTRUCTION phase from fixture)            -> "injects CONSTRUCTION from the construction fixture"
//   .sh 12 (OPERATION phase from fixture)               -> "injects OPERATION from the operation fixture"
//   .sh 13 (corrupted fixture exits 0, no crash)        -> "corrupted state fixture does not crash (exit 0)"
//   .sh 14 (source=startup emits SESSION_STARTED)       -> "source=startup emits SESSION_STARTED"
//   .sh 15 (source=resume emits SESSION_RESUMED)        -> "source=resume emits SESSION_RESUMED"
//   .sh 16 (source=clear emits SESSION_STARTED)         -> "source=clear emits SESSION_STARTED"
//   .sh 17 (source=compact does NOT emit)               -> "source=compact emits no session event (PreCompact owns it)"
//
// 17 .sh asserts -> 17 expect()-bearing test() cases (several STRONGER):
//   - tests 14/15/16 pin the canonical start-of-line **Event**: <type> field
//     (not merely the bare substring the .sh grepped), AND confirm the
//     **Source**: <source> field landed co-located in the same block.
//   - test 17 also asserts NO SESSION_STARTED / SESSION_RESUMED leaked from the
//     compact source (the .sh only forbade the never-emitted SESSION_COMPACTED).
//   - test 13 also asserts the hook still emitted a parseable additionalContext
//     JSON on the corrupted fixture (graceful, not just non-crashing).
//   - test 1 asserts EMPTY stdout (the additionalContext JSON is the only thing
//     the hook writes), strictly stronger than the .sh's `-z` on merged output.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedAuditFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-session-start.ts");
const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");
const CONSTRUCTION = join(FIXTURES_DIR, "state-construction.md");
const OPERATION = join(FIXTURES_DIR, "state-operation.md");
const CORRUPTED = join(FIXTURES_DIR, "state-corrupted.md");

let proj: string;

function statePath(p: string): string {
  return join(p, "aidlc-docs", "aidlc-state.md");
}

function auditPath(p: string): string {
  return join(p, "aidlc-docs", "audit.md");
}

function readAudit(p: string): string {
  return readFileSync(auditPath(p), "utf-8");
}

function heartbeatPath(p: string): string {
  return join(p, "aidlc-docs", ".aidlc-hooks-health", "session-start.last");
}

function recoveryPath(p: string): string {
  return join(p, "aidlc-docs", ".aidlc-recovery.md");
}

interface FireResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Fire the real session-start hook once, mirroring the .sh's
 * `[echo '<json>' |] CLAUDE_PROJECT_DIR=$PROJ bun $HOOK`.
 *
 * When `json` is provided, the bytes are piped to stdin (non-TTY), so the
 * hook's `!process.stdin.isTTY` branch reads + parses the payload — exactly
 * how Claude Code drives it (the .sh's source=… cases). When `json` is
 * undefined we pipe an empty stdin (still non-TTY, source defaults to
 * "startup") — the .sh's context-only cases that invoked the hook with no
 * piped JSON.
 */
function fire(p: string, json?: string): FireResult {
  const r = Bun.spawnSync({
    cmd: [BUN, HOOK],
    stdin: new TextEncoder().encode(json ?? ""),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PROJECT_DIR: p },
  });
  return {
    exitCode: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  };
}

describe("t10 session-start SessionStart hook (mechanism cli — spawned hook + stdin/stdout/disk seams)", () => {
  beforeEach(() => {
    proj = createTestProject();
  });

  afterEach(() => {
    cleanupTestProject(proj);
  });

  test("silent exit (no stdout) when no state file [.sh test 1]", () => {
    // createTestProject seeds no aidlc-state.md, so the hook hits its :39 no-op
    // gate and exits 0 before any heartbeat / audit / stdout. The .sh checked
    // the merged stdout+stderr was empty; STRONGER — assert stdout is exactly
    // empty (the additionalContext JSON is the hook's only stdout write).
    expect(existsSync(statePath(proj))).toBe(false);
    const r = fire(proj);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("no heartbeat when no state file [.sh test 2]", () => {
    expect(existsSync(statePath(proj))).toBe(false);
    fire(proj);
    // The :39 gate fires before the mkdir/heartbeat at :42-44.
    expect(existsSync(heartbeatPath(proj))).toBe(false);
  });

  test("outputs valid JSON with an additionalContext key [.sh test 3]", () => {
    seedStateFile(proj, MID_IDEATION);
    const r = fire(proj);
    // .sh: `echo "$OUTPUT" | jq -e '.additionalContext'`. STRONGER — parse the
    // stdout as JSON in-process and assert the key exists and is a string.
    const parsed = JSON.parse(r.stdout.trim());
    expect(typeof parsed.additionalContext).toBe("string");
    expect(parsed.additionalContext.length).toBeGreaterThan(0);
  });

  test("injects the Lifecycle Phase (IDEATION) [.sh test 4]", () => {
    seedStateFile(proj, MID_IDEATION);
    const r = fire(proj);
    const ctx = JSON.parse(r.stdout.trim()).additionalContext as string;
    // .sh grepped "IDEATION" in the raw JSON; STRONGER — assert the rendered
    // "Lifecycle Phase: IDEATION" line in the decoded additionalContext.
    expect(ctx).toContain("Lifecycle Phase: IDEATION");
  });

  test("injects the Current Stage (feasibility) [.sh test 5]", () => {
    seedStateFile(proj, MID_IDEATION);
    const r = fire(proj);
    const ctx = JSON.parse(r.stdout.trim()).additionalContext as string;
    expect(ctx).toContain("Current Stage: feasibility");
  });

  test("injects the Active Agent (aidlc-architect-agent) [.sh test 6]", () => {
    seedStateFile(proj, MID_IDEATION);
    const r = fire(proj);
    const ctx = JSON.parse(r.stdout.trim()).additionalContext as string;
    expect(ctx).toContain("Active Agent: aidlc-architect-agent");
  });

  test("injects the Scope (feature) [.sh test 7]", () => {
    seedStateFile(proj, MID_IDEATION);
    const r = fire(proj);
    const ctx = JSON.parse(r.stdout.trim()).additionalContext as string;
    expect(ctx).toContain("Scope: feature");
  });

  test("includes the recovery-breadcrumb NOTE when .aidlc-recovery.md exists [.sh test 8]", () => {
    seedStateFile(proj, MID_IDEATION);
    writeFileSync(recoveryPath(proj), "# Recovery breadcrumb\n", "utf-8");
    const r = fire(proj);
    const ctx = JSON.parse(r.stdout.trim()).additionalContext as string;
    // .sh grepped "recovery breadcrumb"; STRONGER — assert the exact NOTE the
    // hook injects (aidlc-session-start.ts :110-112).
    expect(ctx).toContain("recovery breadcrumb");
    expect(ctx).toContain(
      "NOTE: A compaction recovery breadcrumb exists at .aidlc-recovery.md",
    );
  });

  test("omits the recovery-breadcrumb NOTE when no breadcrumb [.sh test 9]", () => {
    seedStateFile(proj, MID_IDEATION);
    // createTestProject seeds no .aidlc-recovery.md (the .sh rm -f'd it).
    expect(existsSync(recoveryPath(proj))).toBe(false);
    const r = fire(proj);
    const ctx = JSON.parse(r.stdout.trim()).additionalContext as string;
    expect(ctx).not.toContain("recovery breadcrumb");
  });

  test("writes the session-start.last heartbeat when state exists [.sh test 10]", () => {
    seedStateFile(proj, MID_IDEATION);
    expect(existsSync(heartbeatPath(proj))).toBe(false);
    fire(proj);
    expect(existsSync(heartbeatPath(proj))).toBe(true);
  });

  test("injects CONSTRUCTION from the construction fixture [.sh test 11]", () => {
    seedStateFile(proj, CONSTRUCTION);
    const r = fire(proj);
    const ctx = JSON.parse(r.stdout.trim()).additionalContext as string;
    expect(ctx).toContain("Lifecycle Phase: CONSTRUCTION");
  });

  test("injects OPERATION from the operation fixture [.sh test 12]", () => {
    seedStateFile(proj, OPERATION);
    const r = fire(proj);
    const ctx = JSON.parse(r.stdout.trim()).additionalContext as string;
    expect(ctx).toContain("Lifecycle Phase: OPERATION");
  });

  test("corrupted state fixture does not crash (exit 0) [.sh test 13]", () => {
    seedStateFile(proj, CORRUPTED);
    const r = fire(proj);
    // .sh asserted RC == 0 on the corrupted fixture. STRONGER — the hook still
    // emits a parseable additionalContext JSON (graceful degrade: getField
    // finds the heading lines but their values are blank, so the fields render
    // empty rather than crashing or throwing). The corrupted fixture's
    // "- **Lifecycle Phase**:" line is PRESENT with an empty value, so getField
    // returns "" (not undefined) and the ?? "unknown" fallback does not fire —
    // the rendered line is the bare "Lifecycle Phase: ".
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(typeof parsed.additionalContext).toBe("string");
    expect(parsed.additionalContext).toContain("AIDLC WORKFLOW ACTIVE");
    expect(parsed.additionalContext).toContain("Lifecycle Phase:");
  });

  test("source=startup emits SESSION_STARTED [.sh test 14]", () => {
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    // The seed audit-sample.md already carries one SESSION_STARTED block, so a
    // bare presence grep (what the .sh did) is a tautology that passes with zero
    // hook emission. STRONGER: assert the COUNT of canonical start-of-line
    // **Event**: SESSION_STARTED rows actually ROSE after the hook fired (a real
    // emission), and that the new block co-locates **Source**: startup.
    const countStarted = (b: string): number =>
      b.split("\n").filter((l) => l.trim() === "**Event**: SESSION_STARTED").length;
    const before = countStarted(readAudit(proj));
    fire(proj, '{"source":"startup"}');
    const body = readAudit(proj);
    expect(countStarted(body)).toBe(before + 1);
    const idxEvent = body.lastIndexOf("**Event**: SESSION_STARTED");
    const idxSource = body.indexOf("**Source**: startup", idxEvent);
    expect(idxSource).toBeGreaterThan(idxEvent);
  });

  test("source=resume emits SESSION_RESUMED [.sh test 15]", () => {
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    fire(proj, '{"source":"resume"}');
    const body = readAudit(proj);
    expect(
      body.split("\n").some((l) => l.trim() === "**Event**: SESSION_RESUMED"),
    ).toBe(true);
    const idxEvent = body.indexOf("**Event**: SESSION_RESUMED");
    const idxSource = body.indexOf("**Source**: resume");
    expect(idxSource).toBeGreaterThan(idxEvent);
  });

  test("source=clear emits SESSION_STARTED [.sh test 16]", () => {
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    fire(proj, '{"source":"clear"}');
    const body = readAudit(proj);
    // clear maps to SESSION_STARTED (aidlc-session-start.ts :81), with the
    // Source field carrying the original "clear".
    expect(
      body.split("\n").some((l) => l.trim() === "**Event**: SESSION_STARTED"),
    ).toBe(true);
    const idxEvent = body.indexOf("**Event**: SESSION_STARTED");
    const idxSource = body.indexOf("**Source**: clear");
    expect(idxSource).toBeGreaterThan(idxEvent);
  });

  test("source=compact emits no session event (PreCompact owns it) [.sh test 17]", () => {
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    const before = readAudit(proj);
    fire(proj, '{"source":"compact"}');
    const body = readAudit(proj);
    // .sh forbade "SESSION_COMPACTED" (which this hook never emits). STRONGER —
    // assert compact emits NEITHER session event, so audit.md is byte-unchanged
    // (no new block) and carries no SESSION_COMPACTED.
    expect(body).not.toContain("SESSION_COMPACTED");
    expect(body).toBe(before);
  });
});
