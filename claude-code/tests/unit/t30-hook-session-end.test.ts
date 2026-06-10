// covers: hook:aidlc-session-end, function:appendAuditEntry
//
// t30 — aidlc-session-end.ts SessionEnd hook behaviour. Migrated from
// tests/unit/t30-hook-session-end.sh (TAP plan 7). Mechanism: cli.
//
// WHY CLI (process-boundary, not in-process): the SUBJECT is a hook, not a
// pure function. aidlc-session-end.ts (dist/claude/.claude/hooks/) runs at
// module top level on import and TERMINATES the process:
//   :19  projectDir = resolveProjectDirFromHook(import.meta.url)
//   :22  if (!existsSync(stateFilePath(projectDir))) process.exit(0)
//          — the "no active workflow" no-op gate (no heartbeat, no audit)
//   :25-27 mkdir aidlc-docs/.aidlc-hooks-health + write session-end.last
//          heartbeat (only reached when state IS present)
//   :32-45 reason defaults to "unknown"; if stdin is not a TTY it reads
//          Bun.stdin.text(), JSON.parses it, and pulls raw.reason when the
//          payload is a valid Claude Code hook input — malformed / empty /
//          no-reason stdin leaves reason === "unknown" (the catch swallows)
//   :47-52 appendAuditEntry("SESSION_ENDED", { Reason: reason }, projectDir)
//          — writes a "**Event**: SESSION_ENDED" block to audit.md, with a
//          "**Reason**: <reason>" field; on emit failure recordHookDrop + exit 0
// None of those seams — stdin, the env/script-path projectDir derivation, the
// exit(0) no-op gate, the heartbeat write — is reachable by importing a
// function; the module's top level RUNS on import. So this twin SPAWNS the real
// shipped hook the same way Claude Code's SessionEnd drives it from
// settings.json: `Bun.spawnSync({ cmd: [BUN, HOOK], stdin: <json bytes>,
// env: {…CLAUDE_PROJECT_DIR} })`. Same pattern as t07 (audit-logger hook twin).
//
// appendAuditEntry's on-disk block format (aidlc-audit.ts): the SESSION_ENDED
// event maps to the "## Session End" heading and renders each field as a
// "**<key>**: <value>" line — so { Reason: "logout" } becomes
// "**Reason**: logout". Asserted below against the real bytes on disk.
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_state_file +
// seed_audit_file + cleanup_test_project, one fresh project per case):
//   - createTestProject() -> a fresh temp dir with aidlc-docs/.
//   - seedStateFile(proj, state-mid-ideation.md) -> the canonical "active
//     workflow" signal the hook gates on (MID_IDEATION in the .sh, the same
//     fixture bytes).
//   - seedAuditFile() -> copies tests/fixtures/audit-sample.md to
//     aidlc-docs/audit.md (the precondition for the emit; appendAuditEntry
//     appends to it).
//   - cleanupTestProject() rm -rf's each temp project. Nothing written under
//     tests/fixtures/**.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1 (emits SESSION_ENDED w/ active workflow) -> "emits SESSION_ENDED when an active workflow exists"
//   .sh test 2 (records reason field)                   -> "records the reason field as **Reason**: <value>"
//   .sh test 3 (no-op when state absent)                -> "no-op when state file absent (audit unchanged)"
//   .sh test 4 (writes heartbeat w/ active workflow)    -> "writes the session-end.last heartbeat when active workflow exists"
//   .sh test 5 (empty stdin graceful, exit 0)           -> "handles empty stdin gracefully (exit 0)"
//   .sh test 6 (defaults reason to 'unknown')           -> "defaults reason to 'unknown' on empty/no stdin"
//   .sh test 7 (no heartbeat when state absent)         -> "no heartbeat when state file absent"
//
// 7 .sh asserts -> 7 expect()-bearing test() cases (several STRONGER: test 1
// pins the canonical start-of-line **Event**: line; test 2 pins the **Reason**
// value co-located on the SESSION_ENDED block; test 3 asserts byte-equality of
// audit.md, not just unchanged line count; test 5 also asserts the emit still
// landed; test 6 asserts the reason is exactly "unknown").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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
const HOOK = join(AIDLC_SRC, "hooks", "aidlc-session-end.ts");
const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");

let proj: string;

function auditPath(p: string): string {
  return join(p, "aidlc-docs", "audit.md");
}

function readAudit(p: string): string {
  return readFileSync(auditPath(p), "utf-8");
}

function heartbeatPath(p: string): string {
  return join(p, "aidlc-docs", ".aidlc-hooks-health", "session-end.last");
}

interface FireResult {
  exitCode: number;
}

/**
 * Fire the real session-end hook once with the given SessionEnd JSON on stdin,
 * mirroring the .sh's `echo '<json>' | CLAUDE_PROJECT_DIR=$PROJ bun $HOOK`.
 * Piping bytes makes stdin non-TTY, so the hook's `!process.stdin.isTTY`
 * branch reads + parses the payload — exactly how Claude Code drives it.
 * Returns the exit code.
 */
function fire(json: string, p: string): FireResult {
  const r = Bun.spawnSync({
    cmd: [BUN, HOOK],
    stdin: new TextEncoder().encode(json),
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, CLAUDE_PROJECT_DIR: p },
  });
  return { exitCode: r.exitCode };
}

describe("t30 session-end SessionEnd hook (mechanism cli — spawned hook + stdin seam)", () => {
  beforeEach(() => {
    proj = createTestProject();
  });

  afterEach(() => {
    cleanupTestProject(proj);
  });

  test("emits SESSION_ENDED when an active workflow exists [.sh test 1]", () => {
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    fire('{"reason":"logout"}', proj);
    const body = readAudit(proj);
    // .sh grepped "SESSION_ENDED"; STRONGER — pin the canonical start-of-line
    // **Event**: SESSION_ENDED field the appendAuditEntry formatter writes.
    expect(body).toContain("SESSION_ENDED");
    const hasCanonical = body
      .split("\n")
      .some((l) => l.trim() === "**Event**: SESSION_ENDED");
    expect(hasCanonical).toBe(true);
  });

  test("records the reason field as **Reason**: <value> [.sh test 2]", () => {
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    fire('{"reason":"logout"}', proj);
    const body = readAudit(proj);
    // .sh grepped `\*\*Reason\*\*: logout`. STRONGER — assert the **Reason**
    // line is co-located inside the SESSION_ENDED block (the field follows the
    // **Event**: SESSION_ENDED line of the same appended entry).
    expect(body).toContain("**Reason**: logout");
    const idxEvent = body.indexOf("**Event**: SESSION_ENDED");
    const idxReason = body.indexOf("**Reason**: logout");
    expect(idxEvent).toBeGreaterThanOrEqual(0);
    expect(idxReason).toBeGreaterThan(idxEvent);
  });

  test("no-op when state file absent (audit unchanged) [.sh test 3]", () => {
    // createTestProject made no state file, so the hook hits its :22 no-op gate
    // and exits 0 before any heartbeat or audit write — the same precondition
    // the .sh set up by `rm -f aidlc-state.md`.
    expect(existsSync(join(proj, "aidlc-docs", "aidlc-state.md"))).toBe(false);
    seedAuditFile(proj);
    const before = readAudit(proj);
    const r = fire('{"reason":"logout"}', proj);
    // .sh compared line counts; STRONGER — assert byte-equality of audit.md.
    expect(r.exitCode).toBe(0);
    expect(readAudit(proj)).toBe(before);
  });

  test("writes the session-end.last heartbeat when active workflow exists [.sh test 4]", () => {
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    expect(existsSync(heartbeatPath(proj))).toBe(false);
    fire('{"reason":"logout"}', proj);
    expect(existsSync(heartbeatPath(proj))).toBe(true);
  });

  test("handles empty stdin gracefully (exit 0) [.sh test 5]", () => {
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    // .sh piped `echo ""` (a lone newline) — non-TTY, so the hook reads stdin,
    // JSON.parse throws, the catch swallows it, and the emit still lands.
    const r = fire("\n", proj);
    expect(r.exitCode).toBe(0);
    // STRONGER than the .sh (which only checked rc): the emit still fired.
    expect(readAudit(proj)).toContain("SESSION_ENDED");
  });

  test("defaults reason to 'unknown' on empty/no stdin [.sh test 6]", () => {
    seedStateFile(proj, MID_IDEATION);
    seedAuditFile(proj);
    fire("\n", proj);
    const body = readAudit(proj);
    // .sh grepped `\*\*Reason\*\*: unknown`. The parse failed on the lone
    // newline so reason kept its "unknown" default (:32).
    expect(body).toContain("**Reason**: unknown");
    // STRONGER: confirm it did NOT carry a "logout"-style reason from elsewhere.
    expect(body).not.toContain("**Reason**: logout");
  });

  test("no heartbeat when state file absent [.sh test 7]", () => {
    // No state file (createTestProject seeds none), and no audit.md either —
    // the hook's :22 gate fires before mkdir/heartbeat. Mirrors the .sh's
    // rm -f state + rm -rf .aidlc-hooks-health precondition.
    expect(existsSync(join(proj, "aidlc-docs", "aidlc-state.md"))).toBe(false);
    fire('{"reason":"logout"}', proj);
    expect(existsSync(heartbeatPath(proj))).toBe(false);
  });
});
