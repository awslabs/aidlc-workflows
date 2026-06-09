// covers: subcommand:aidlc-bolt:start, subcommand:aidlc-bolt:complete, subcommand:aidlc-bolt:fail, subcommand:aidlc-bolt:set-autonomy
//
// bun:test port of tests/unit/t33-tool-bolt.sh (TAP plan 25), mechanism = cli.
// Faithful 1:1 migration: each of the 25 .sh assertions is preserved at
// equal-or-stronger fidelity by SPAWNING the real CLI via node:child_process
// spawnSync(BUN, [TOOL, sub, ...args]) and asserting on the PROCESS boundary —
// exit code (res.status), stdout/stderr (combined like the .sh's `2>&1`), and
// the on-disk aidlc-docs/audit.md / aidlc-state.md the tool mutates.
//
// aidlc-bolt is IDEMPOTENCY/AUDIT-SENSITIVE: start/complete/fail/set-autonomy
// WRITE audit rows. Every case gets a FRESH temp project so audit state never
// bleeds between cases. The .sh's per-case create_test_project +
// seed_audit_file is mirrored exactly.
//
// SPAWN vs IN-PROCESS split: ALL 25 assertions are CLI-contract assertions —
// they test the exit code, stdout JSON ack, or the audit/state file the
// process wrote. None is a pure-function assertion, so all 25 stay spawns
// (25 CLI invocations, matching the .sh's 25 `bun "$TOOL" ...` calls:
// start x12, set-autonomy x8, complete x2, fail x2, bogus-subcommand x1).
// The .sh has NO duplicate-row idempotency assertion (no command is re-run
// and grepped for a single audit row); the closest are Test 17 (a FAILED
// set-autonomy must leave NO orphan AUTONOMY_MODE_SET — audit-first) and
// Test 24 (BOLT_STARTED precedes BOLT_COMPLETED ordering). Both are preserved
// verbatim. Reported honestly in the structured notes.
//
// .sh assertion helper semantics preserved:
//   assert_grep      -> grep -q basic-regex   -> readFileSync + .match(RegExp)
//   assert_not_grep  -> ! grep -q             -> expect(...).not.toMatch / not.toContain
//   assert_contains  -> grep -qF fixed-string -> expect(out).toContain(...)
//   assert_eq RC 1   -> string-eq on $?       -> expect(res.status).toBe(1)
//
// FIXTURE DISCIPLINE: temp projects via the shipped fixtures.ts helpers
// (createTestProject / seedAuditFile / seedStateFile / cleanupTestProject) and
// per-case mkdtemp dirs. NOTHING is written under tests/fixtures/**.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedAuditFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const TOOL = join(
  import.meta.dir,
  "..",
  "..",
  "dist", "claude",
  ".claude",
  "tools",
  "aidlc-bolt.ts",
);

interface RunResult {
  status: number;
  out: string; // stdout+stderr combined, mirroring the .sh's `2>&1`
}

// Spawn the real CLI in the project dir. Passes --project-dir like every .sh
// invocation (the authoritative project seam) and combines stdout+stderr.
function runBolt(proj: string, ...args: string[]): RunResult {
  const res = spawnSync(BUN, [TOOL, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    cwd: proj,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function readAudit(proj: string): string {
  return readFileSync(join(proj, "aidlc-docs", "audit.md"), "utf-8");
}
function readState(proj: string): string {
  return readFileSync(join(proj, "aidlc-docs", "aidlc-state.md"), "utf-8");
}

// Mirror the .sh's setup_construction_project (lines 89-98): seed the
// Construction state fixture + audit, then append the Construction Autonomy
// Mode field (the fixture pre-dates it; setFieldStrict parses by key, not
// location, so end-of-file append is fine).
function setupConstructionProject(): string {
  const proj = createTestProject();
  seedStateFile(proj, join(FIXTURES_DIR, "state-construction.md"));
  seedAuditFile(proj);
  const statePath = join(proj, "aidlc-docs", "aidlc-state.md");
  writeFileSync(
    statePath,
    `${readFileSync(statePath, "utf-8")}\n- **Construction Autonomy Mode**: gated\n`,
    "utf-8",
  );
  return proj;
}

// --- Tests 1-4, 21: start writes the expected BOLT_STARTED audit fields -----
describe("t33 start: BOLT_STARTED audit emission", () => {
  let proj = "";
  afterEach(() => {
    cleanupTestProject(proj);
    proj = "";
  });

  // Test 1: start emits BOLT_STARTED
  test("start emits BOLT_STARTED", () => {
    proj = createTestProject();
    seedAuditFile(proj);
    runBolt(proj, "start", "--name", "auth-service", "--batch", "1");
    // .sh: assert_grep '^\*\*Event\*\*: BOLT_STARTED' (line-anchored literal)
    expect(readAudit(proj)).toMatch(/^\*\*Event\*\*: BOLT_STARTED/m);
  });

  // Test 2: start records Batch number
  test("start records Batch number", () => {
    proj = createTestProject();
    seedAuditFile(proj);
    runBolt(proj, "start", "--name", "auth-service", "--batch", "1");
    expect(readAudit(proj)).toContain("**Batch number**: 1");
  });

  // Test 3: start accepts CSV bolt names (parallel batch)
  test("start records CSV bolt names", () => {
    proj = createTestProject();
    seedAuditFile(proj);
    runBolt(
      proj,
      "start",
      "--name",
      "auth-service,payment-service,user-service",
      "--batch",
      "2",
    );
    expect(readAudit(proj)).toContain("auth-service,payment-service,user-service");
  });

  // Test 4: start --walking-skeleton true flags Walking skeleton=true
  test("start --walking-skeleton true flags correctly", () => {
    proj = createTestProject();
    seedAuditFile(proj);
    runBolt(proj, "start", "--name", "b1", "--batch", "1", "--walking-skeleton", "true");
    expect(readAudit(proj)).toContain("**Walking skeleton**: true");
  });

  // Test 21: start without --walking-skeleton defaults to false
  test("start without --walking-skeleton defaults to false", () => {
    proj = createTestProject();
    seedAuditFile(proj);
    runBolt(proj, "start", "--name", "b1", "--batch", "1");
    expect(readAudit(proj)).toContain("**Walking skeleton**: false");
  });
});

// --- Tests 5, 6, 18, 19, 20: start input validation exits 1 -----------------
describe("t33 start: input validation", () => {
  let proj = "";
  afterEach(() => {
    cleanupTestProject(proj);
    proj = "";
  });

  // Test 5: start missing --name exits 1
  test("start missing --name exits 1", () => {
    proj = createTestProject();
    expect(runBolt(proj, "start", "--batch", "1").status).toBe(1);
  });

  // Test 6: start missing --batch exits 1
  test("start missing --batch exits 1", () => {
    proj = createTestProject();
    expect(runBolt(proj, "start", "--name", "b1").status).toBe(1);
  });

  // Test 18: start --batch non-numeric exits 1
  test("start --batch non-numeric exits 1", () => {
    proj = createTestProject();
    seedAuditFile(proj);
    expect(runBolt(proj, "start", "--name", "b1", "--batch", "not-a-number").status).toBe(1);
  });

  // Test 19: start --batch 0 exits 1 (must be positive)
  test("start --batch 0 exits 1 (must be positive)", () => {
    proj = createTestProject();
    seedAuditFile(proj);
    expect(runBolt(proj, "start", "--name", "b1", "--batch", "0").status).toBe(1);
  });

  // Test 20: parseFlags rejects --flag without value (no silent flag-as-value)
  test("start --name without value (followed by --batch) errors cleanly", () => {
    proj = createTestProject();
    seedAuditFile(proj);
    expect(runBolt(proj, "start", "--name", "--batch", "1").status).toBe(1);
  });
});

// --- Tests 22, 7: start/complete JSON ack + BOLT_COMPLETED ------------------
describe("t33 start/complete: JSON ack + completion audit", () => {
  let proj = "";
  afterEach(() => {
    cleanupTestProject(proj);
    proj = "";
  });

  // Test 22: start prints JSON ack on stdout
  test("start prints JSON with emitted field", () => {
    proj = createTestProject();
    seedAuditFile(proj);
    const res = runBolt(proj, "start", "--name", "b1", "--batch", "1");
    // .sh: assert_contains "$OUT" '"emitted":"BOLT_STARTED"' (fixed-string)
    expect(res.out).toContain('"emitted":"BOLT_STARTED"');
  });

  // Test 7: complete emits BOLT_COMPLETED
  test("complete emits BOLT_COMPLETED", () => {
    proj = createTestProject();
    seedAuditFile(proj);
    runBolt(proj, "complete", "--name", "auth-service", "--batch", "1");
    expect(readAudit(proj)).toMatch(/^\*\*Event\*\*: BOLT_COMPLETED/m);
  });
});

// --- Tests 8, 9: fail records Error summary + Succeeded siblings ------------
describe("t33 fail: BOLT_FAILED audit fields", () => {
  let proj = "";
  afterEach(() => {
    cleanupTestProject(proj);
    proj = "";
  });

  // Test 8: fail emits BOLT_FAILED with error summary
  test("fail records Error summary", () => {
    proj = createTestProject();
    seedAuditFile(proj);
    runBolt(proj, "fail", "--name", "auth-service", "--error", "Compilation failed");
    expect(readAudit(proj)).toContain("**Error summary**: Compilation failed");
  });

  // Test 9: fail --succeeded-siblings records sibling bolts
  test("fail records Succeeded siblings", () => {
    proj = createTestProject();
    seedAuditFile(proj);
    runBolt(
      proj,
      "fail",
      "--name",
      "auth",
      "--error",
      "boom",
      "--succeeded-siblings",
      "payment,user",
    );
    expect(readAudit(proj)).toContain("**Succeeded siblings**: payment,user");
  });
});

// --- Tests 10-14, 23: set-autonomy happy path + validation ------------------
describe("t33 set-autonomy: emission, state update, validation", () => {
  let proj = "";
  afterEach(() => {
    cleanupTestProject(proj);
    proj = "";
  });

  // Test 10: set-autonomy emits AUTONOMY_MODE_SET
  test("set-autonomy emits AUTONOMY_MODE_SET", () => {
    proj = setupConstructionProject();
    runBolt(proj, "set-autonomy", "--mode", "autonomous");
    expect(readAudit(proj)).toMatch(/^\*\*Event\*\*: AUTONOMY_MODE_SET/m);
  });

  // Test 11: set-autonomy updates Construction Autonomy Mode in state file
  test("set-autonomy updates state field", () => {
    proj = setupConstructionProject();
    runBolt(proj, "set-autonomy", "--mode", "autonomous");
    // .sh: assert_grep 'Construction Autonomy Mode.*autonomous' (basic regex)
    expect(readState(proj)).toMatch(/Construction Autonomy Mode.*autonomous/);
  });

  // Test 12: set-autonomy --mode gated is accepted
  test("set-autonomy --mode gated updates state", () => {
    proj = setupConstructionProject();
    runBolt(proj, "set-autonomy", "--mode", "gated");
    expect(readState(proj)).toMatch(/Construction Autonomy Mode.*gated/);
  });

  // Test 13: set-autonomy --mode bogus exits 1
  test("set-autonomy --mode bogus exits 1", () => {
    proj = setupConstructionProject();
    expect(runBolt(proj, "set-autonomy", "--mode", "bogus").status).toBe(1);
  });

  // Test 14: set-autonomy missing --mode exits 1
  test("set-autonomy missing --mode exits 1", () => {
    proj = setupConstructionProject();
    expect(runBolt(proj, "set-autonomy").status).toBe(1);
  });

  // Test 23: set-autonomy JSON ack includes state_updated:true
  test("set-autonomy JSON ack includes state_updated:true", () => {
    proj = setupConstructionProject();
    const res = runBolt(proj, "set-autonomy", "--mode", "autonomous");
    expect(res.out).toContain('"state_updated":true');
  });
});

// --- Tests 15, 17: v4 state-file guard (no Construction Autonomy Mode field) -
describe("t33 set-autonomy: v4 state-file guard (audit-first)", () => {
  let proj = "";
  // Minimal v4-shaped state file WITHOUT the Construction Autonomy Mode field
  // (mirrors the heredoc in .sh Tests 15 & 17).
  const V4_STATE = `# AIDLC State
- **Scope**: feature
- **Status**: Running
## Stage Progress
- [-] feasibility — EXECUTE
`;
  function seedV4(): void {
    proj = createTestProject();
    writeFileSync(join(proj, "aidlc-docs", "aidlc-state.md"), V4_STATE, "utf-8");
    seedAuditFile(proj);
  }
  afterEach(() => {
    cleanupTestProject(proj);
    proj = "";
  });

  // Test 15: set-autonomy errors cleanly when state field is absent
  test("set-autonomy exits 1 when Construction Autonomy Mode absent (v4 state file guard)", () => {
    seedV4();
    expect(runBolt(proj, "set-autonomy", "--mode", "autonomous").status).toBe(1);
  });

  // Test 17: set-autonomy on v4 state file leaves NO orphan audit (audit-first).
  // Regression: previously emitted AUTONOMY_MODE_SET before validating the
  // state field, leaving an orphan audit row when the field was absent. ONE
  // process invocation drives BOTH assertions, exactly as the .sh did.
  test("set-autonomy on v4 state file exits 1 AND leaves no orphan AUTONOMY_MODE_SET in audit", () => {
    seedV4();
    const res = runBolt(proj, "set-autonomy", "--mode", "autonomous");
    expect(res.status).toBe(1); // .sh: assert_eq "$RC" "1"
    // .sh: assert_not_grep "AUTONOMY_MODE_SET" in audit.md
    expect(readAudit(proj)).not.toContain("AUTONOMY_MODE_SET");
  });
});

// --- Test 16: unknown subcommand exits 1 -----------------------------------
describe("t33 dispatch: unknown subcommand", () => {
  let proj = "";
  afterEach(() => {
    cleanupTestProject(proj);
    proj = "";
  });

  test("unknown subcommand exits 1", () => {
    proj = createTestProject();
    expect(runBolt(proj, "bogus").status).toBe(1);
  });
});

// --- Test 24: full bolt lifecycle — start precedes complete in audit --------
describe("t33 lifecycle: BOLT_STARTED precedes BOLT_COMPLETED", () => {
  let proj = "";
  afterEach(() => {
    cleanupTestProject(proj);
    proj = "";
  });

  test("bolt lifecycle: BOLT_STARTED precedes BOLT_COMPLETED for same bolt", () => {
    proj = createTestProject();
    seedAuditFile(proj);
    runBolt(
      proj,
      "start",
      "--name",
      "auth-service",
      "--batch",
      "1",
      "--walking-skeleton",
      "true",
    );
    runBolt(proj, "complete", "--name", "auth-service", "--batch", "1");
    // .sh: grep -n line numbers, assert START_LINE < COMPLETE_LINE.
    const lines = readAudit(proj).split("\n");
    const startLine = lines.findIndex((l) => /^\*\*Event\*\*: BOLT_STARTED/.test(l));
    const completeLine = lines.findIndex((l) => /^\*\*Event\*\*: BOLT_COMPLETED/.test(l));
    expect(startLine).toBeGreaterThanOrEqual(0);
    expect(completeLine).toBeGreaterThanOrEqual(0);
    expect(startLine).toBeLessThan(completeLine);
  });
});
