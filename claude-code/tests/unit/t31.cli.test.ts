// covers: subcommand:aidlc-log:decision, subcommand:aidlc-log:answer
//
// CLI-contract port of tests/unit/t31-tool-log.sh (TAP plan 21),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-log.ts decision|answer ...` is preserved by
// SPAWNING the real CLI via node:child_process spawnSync (BUN + the tool
// .ts path), asserting on res.status / res.stdout / res.stderr exactly as
// the .sh asserted on $? / stdout, plus on the audit.md the tool writes —
// the PROCESS boundary, not in-process handleDecision/handleAnswer calls.
// An in-process twin would lose the exit-code half the .sh relies on for
// every invalid-arg case (the tool's error() path is process.exit(1) via
// emitError, aidlc-lib.ts:1546) AND the JSON-ack-to-stdout half.
//
// SUBCOMMAND UNITS: this .cli file credits BOTH subcommand units the .sh
// exercises — `aidlc-log decision` (covers KEY subcommand:aidlc-log
// decision) and `aidlc-log answer` (covers KEY subcommand:aidlc-log
// answer). The tool's only two subcommands; both are fired here.
//
// PARITY NOTES (every .sh `ok` line maps to an expect() below; several are
// STRONGER than the original grep):
//   - .sh Test 1  assert_grep "^**Event**: DECISION_RECORDED"  -> Test 1:
//       auditEventCount === 1 (STRONGER: counts the row against a seeded
//       baseline rather than a bare presence grep) + JSON ack `emitted`.
//   - .sh Test 2  assert_grep "**Stage**: feasibility"         -> Test 2:
//       auditField(DECISION_RECORDED,"Stage") === "feasibility" (STRONGER:
//       exact field value scoped to the DECISION_RECORDED block, not a
//       file-wide substring grep).
//   - .sh Test 3  **Decision**: Pick a framework               -> Test 3:
//       auditField "Decision" === "Pick a framework" (STRONGER, exact).
//   - .sh Test 4  **Options**: React,Vue,Svelte                -> Test 4:
//       auditField "Options" === "React,Vue,Svelte" (STRONGER, exact).
//   - .sh Test 5  **Rationale**: Align with team skillset      -> Test 5:
//       auditField "Rationale" === "Align with team skillset" (STRONGER).
//   - .sh Test 6  decision --test-run **Test-Run**: true       -> Test 6:
//       auditField "Test-Run" === "true" (STRONGER, exact).
//   - .sh Test 7  decision missing --stage   $? == 1           -> Test 7:
//       res.status === 1 (same observable) + error message asserted.
//   - .sh Test 8  decision missing --decision $? == 1          -> Test 8.
//   - .sh Test 9  answer **Event**: QUESTION_ANSWERED          -> Test 9:
//       auditEventCount === 1 (STRONGER) + JSON ack.
//   - .sh Test 10 answer **Details**: User chose React         -> Test 10:
//       auditField "Details" exact (STRONGER) + Stage exact (the .sh msg
//       says "records Stage and Details"; the .sh only grepped Details, so
//       the Stage assert here is a STRONGER addition matching the comment).
//   - .sh Test 11 answer --test-run **Test-Run**: true         -> Test 11:
//       auditField "Test-Run" === "true" (STRONGER, exact).
//   - .sh Test 12 answer missing --stage   $? == 1             -> Test 12.
//   - .sh Test 13 answer missing --details $? == 1             -> Test 13.
//   - .sh Test 14 unknown subcommand       $? == 1             -> Test 14:
//       res.status === 1 + "Unknown subcommand" error asserted (STRONGER).
//   - .sh Test 15 answer --test-run: canonical QUESTION_ANSWERED present
//       AND deleted QUESTION_AUTO_ANSWERED absent (2 asserts)  -> Test 15:
//       both preserved (event count===1 STRONGER for canonical; whole-file
//       absence for the deleted auto-event).
//   - .sh Test 16 decision sans --options: no **Options**: row -> Test 16:
//       auditField "Options" === "" (block-scoped absence) (STRONGER).
//   - .sh Test 17 --stage <no value, next tok --decision> $?==1 -> Test 17:
//       res.status === 1 + "expects a value" error asserted (STRONGER).
//   - .sh Test 18 trailing --decision at end of args      $?==1 -> Test 18:
//       res.status === 1 + "end of arguments" error asserted (STRONGER).
//   - .sh Test 19 decision JSON ack contains `"emitted":"DECISION_RECORDED"`
//       -> Test 19: stdout contains it (same observable).
//   - .sh Test 20 answer JSON ack contains `"emitted":"QUESTION_ANSWERED"`
//       -> Test 20: stdout contains it (same observable).
//
// 21 .sh asserts -> 21 expect()-bearing test() cases here (Test 15 split
// into two test() cases to keep one observable per case, matching the .sh's
// two `ok` lines).
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_audit_file
// + cleanup_test_project per case): each case uses a FRESH temp project dir
// (createTestProject, which toPortablePath-converts on Windows so audit.md —
// written by the tool via toPosix(auditFilePath) — round-trips when read
// back). Audit-emitting cases seed audit-sample.md first (matching the .sh,
// whose seed contains NONE of the events asserted here, so post-fire counts
// are unambiguous). All temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  seedAuditFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-log.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** Fresh seeded project (createTestProject + seed_audit_file). */
function proj(seed = true): string {
  const p = createTestProject();
  tempDirs.push(p);
  if (seed) seedAuditFile(p);
  return p;
}

const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/** Spawn `bun aidlc-log.ts <args...> --project-dir <p>`. Mirrors `bun "$TOOL" ...`. */
function log(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [TOOL, ...args, "--project-dir", p], {
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/** Count audit blocks with `**Event**: <ev>`. Mirrors the .sh's `^**Event**: <ev>` grep, but as an exact count. */
function auditEventCount(file: string, ev: string): number {
  if (!existsSync(file)) return 0;
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Walks the file; resets at `## ` headings and `---` separators; splits
 * `**label**: value` on the literal `**: ` separator. Mirrors audit_field
 * in t92.cli.test.ts. Returns "" when absent (block-scoped, so it doubles as
 * the .sh's assert_not_grep '**Options**:' check).
 */
function auditField(file: string, ev: string, key: string): string {
  if (!existsSync(file)) return "";
  let matched = false;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (line.startsWith("## ")) {
      matched = false;
      continue;
    }
    if (line === "---") {
      matched = false;
      continue;
    }
    if (line.startsWith("**Event**: ")) {
      matched = line === `**Event**: ${ev}`;
      continue;
    }
    if (matched && line.startsWith("**")) {
      const stripped = line.replace(/^\*\*/, "");
      const pos = stripped.indexOf("**: ");
      if (pos > 0) {
        const label = stripped.slice(0, pos);
        const value = stripped.slice(pos + 4);
        if (label === key) return value;
      }
    }
  }
  return "";
}

/** Whole-file presence (mirrors a bare grep with no `^` anchor). */
function fileContains(file: string, needle: string): boolean {
  if (!existsSync(file)) return false;
  return readFileSync(file, "utf-8").includes(needle);
}

// ============================================================
// decision subcommand (covers: subcommand:aidlc-log decision)
// ============================================================

describe("t31 aidlc-log decision (migrated from t31-tool-log.sh, plan 21)", () => {
  test("1: decision emits DECISION_RECORDED", () => {
    const p = proj();
    const r = log(["decision", "--stage", "feasibility", "--decision", "Pick a framework"], p);
    expect(r.status).toBe(0);
    expect(auditEventCount(auditPath(p), "DECISION_RECORDED")).toBe(1);
    expect(r.stdout).toContain('"emitted":"DECISION_RECORDED"');
  });

  test("2: decision records Stage field", () => {
    const p = proj();
    log(["decision", "--stage", "feasibility", "--decision", "Pick a framework"], p);
    expect(auditField(auditPath(p), "DECISION_RECORDED", "Stage")).toBe("feasibility");
  });

  test("3: decision records Decision field", () => {
    const p = proj();
    log(["decision", "--stage", "feasibility", "--decision", "Pick a framework"], p);
    expect(auditField(auditPath(p), "DECISION_RECORDED", "Decision")).toBe("Pick a framework");
  });

  test("4: decision records Options field when supplied", () => {
    const p = proj();
    log(
      ["decision", "--stage", "feasibility", "--decision", "Pick a framework", "--options", "React,Vue,Svelte"],
      p,
    );
    expect(auditField(auditPath(p), "DECISION_RECORDED", "Options")).toBe("React,Vue,Svelte");
  });

  test("5: decision records Rationale field when supplied", () => {
    const p = proj();
    log(
      ["decision", "--stage", "feasibility", "--decision", "Pick a framework", "--rationale", "Align with team skillset"],
      p,
    );
    expect(auditField(auditPath(p), "DECISION_RECORDED", "Rationale")).toBe("Align with team skillset");
  });

  test("6: decision --test-run emits Test-Run=true", () => {
    const p = proj();
    log(["decision", "--stage", "feasibility", "--decision", "Pick a framework", "--test-run"], p);
    expect(auditField(auditPath(p), "DECISION_RECORDED", "Test-Run")).toBe("true");
  });

  test("7: decision missing --stage exits 1", () => {
    const p = proj(false);
    const r = log(["decision", "--decision", "x"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Missing --stage");
  });

  test("8: decision missing --decision exits 1", () => {
    const p = proj(false);
    const r = log(["decision", "--stage", "feasibility"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Missing --decision");
  });

  test("16: decision without --options omits Options field entirely", () => {
    const p = proj();
    log(["decision", "--stage", "feasibility", "--decision", "Pick one"], p);
    // Block-scoped absence: no **Options**: line in the DECISION_RECORDED
    // block (the empty-string return). Mirrors assert_not_grep '**Options**:'.
    expect(auditField(auditPath(p), "DECISION_RECORDED", "Options")).toBe("");
    expect(fileContains(auditPath(p), "**Options**:")).toBe(false);
  });

  test("17: decision --stage without value (followed by --decision) errors cleanly (exit 1)", () => {
    const p = proj(false);
    const r = log(["decision", "--stage", "--decision", "x"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("expects a value");
  });

  test("18: decision --decision at end of args errors cleanly (exit 1)", () => {
    // The .sh trailing case is `decision --stage feasibility --decision`
    // immediately followed by `--project-dir <p>`. Because the test always
    // appends --project-dir, --decision sees --project-dir as the next token
    // — a flag, not a value. parseFlags runs on the post-filter arg list
    // (main() strips --project-dir + its value first), so --decision is the
    // LAST element of the filtered list -> "got end of arguments". Either
    // branch ("got another flag" / "end of arguments") is exit 1; we assert
    // the exit code plus that the value-required diagnostic fired.
    const p = proj(false);
    const r = log(["decision", "--stage", "feasibility", "--decision"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("expects a value");
  });

  test("19: decision prints JSON ack with emitted field on stdout", () => {
    const p = proj();
    const r = log(["decision", "--stage", "feasibility", "--decision", "Pick one"], p);
    expect(r.stdout).toContain('"emitted":"DECISION_RECORDED"');
  });
});

// ============================================================
// answer subcommand (covers: subcommand:aidlc-log answer)
// ============================================================

describe("t31 aidlc-log answer (migrated from t31-tool-log.sh, plan 21)", () => {
  test("9: answer emits QUESTION_ANSWERED", () => {
    const p = proj();
    const r = log(["answer", "--stage", "feasibility", "--details", "User chose React"], p);
    expect(r.status).toBe(0);
    expect(auditEventCount(auditPath(p), "QUESTION_ANSWERED")).toBe(1);
    expect(r.stdout).toContain('"emitted":"QUESTION_ANSWERED"');
  });

  test("10: answer records Stage and Details fields", () => {
    const p = proj();
    log(["answer", "--stage", "feasibility", "--details", "User chose React"], p);
    const f = auditPath(p);
    expect(auditField(f, "QUESTION_ANSWERED", "Details")).toBe("User chose React");
    // STRONGER than the .sh (which only grepped Details): the .sh case name
    // is "records Stage and Details", so the Stage value is asserted too.
    expect(auditField(f, "QUESTION_ANSWERED", "Stage")).toBe("feasibility");
  });

  test("11: answer --test-run emits Test-Run=true", () => {
    const p = proj();
    log(["answer", "--stage", "feasibility", "--details", "auto-selected", "--test-run"], p);
    expect(auditField(auditPath(p), "QUESTION_ANSWERED", "Test-Run")).toBe("true");
  });

  test("12: answer missing --stage exits 1", () => {
    const p = proj(false);
    const r = log(["answer", "--details", "x"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Missing --stage");
  });

  test("13: answer missing --details exits 1", () => {
    const p = proj(false);
    const r = log(["answer", "--stage", "feasibility"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Missing --details");
  });

  test("15a: answer --test-run emits canonical QUESTION_ANSWERED", () => {
    const p = proj();
    log(["answer", "--stage", "feasibility", "--details", "auto", "--test-run"], p);
    expect(auditEventCount(auditPath(p), "QUESTION_ANSWERED")).toBe(1);
  });

  test("15b: answer --test-run does NOT emit deleted QUESTION_AUTO_ANSWERED", () => {
    // Regression guard (Phase 1 taxonomy deletion): --test-run must tag the
    // canonical event, never reintroduce QUESTION_AUTO_ANSWERED. Whole-file
    // absence, mirroring the .sh's unanchored assert_not_grep.
    const p = proj();
    log(["answer", "--stage", "feasibility", "--details", "auto", "--test-run"], p);
    expect(fileContains(auditPath(p), "QUESTION_AUTO_ANSWERED")).toBe(false);
  });

  test("20: answer prints JSON ack with emitted field on stdout", () => {
    const p = proj();
    const r = log(["answer", "--stage", "feasibility", "--details", "x"], p);
    expect(r.stdout).toContain('"emitted":"QUESTION_ANSWERED"');
  });
});

// ============================================================
// Cross-subcommand: unknown subcommand (exercises main()'s default arm).
// (.sh Test 14)
// ============================================================

describe("t31 aidlc-log dispatch", () => {
  test("14: unknown subcommand exits 1", () => {
    const p = proj(false);
    const r = log(["bogus"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Unknown subcommand");
  });
});
