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
//   - .sh Test 6  (decision --test-run **Test-Run**: true) was DROPPED per #369
//       when the test-run mechanism was removed.
//   - .sh Test 7  decision missing --stage   $? == 1           -> Test 7:
//       res.status === 1 (same observable) + error message asserted.
//   - .sh Test 8  decision missing --decision $? == 1          -> Test 8.
//   - .sh Test 9  answer **Event**: QUESTION_ANSWERED          -> Test 9:
//       auditEventCount === 1 (STRONGER) + JSON ack.
//   - .sh Test 10 answer **Details**: User chose React         -> Test 10:
//       auditField "Details" exact (STRONGER) + Stage exact (the .sh msg
//       says "records Stage and Details"; the .sh only grepped Details, so
//       the Stage assert here is a STRONGER addition matching the comment).
//   - .sh Test 11 (answer --test-run **Test-Run**: true) was DROPPED per #369
//       when the test-run mechanism was removed.
//   - .sh Test 12 answer missing --stage   $? == 1             -> Test 12.
//   - .sh Test 13 answer missing --details $? == 1             -> Test 13.
//   - .sh Test 14 unknown subcommand       $? == 1             -> Test 14:
//       res.status === 1 + "Unknown subcommand" error asserted (STRONGER).
//   - .sh Test 15 (answer --test-run: canonical QUESTION_ANSWERED present AND
//       deleted QUESTION_AUTO_ANSWERED absent) was DROPPED per #369 when the
//       test-run mechanism was removed.
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
// Each .sh `ok` line maps to one expect()-bearing test() here, one observable
// per case. (The .sh's test-run cases 6, 11, and the two-assert 15 were dropped
// per #369 when the test-run mechanism was removed.)
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_audit_file
// + cleanup_test_project per case): each case uses a FRESH temp project dir
// (createTestProject, which toPortablePath-converts on Windows so audit.md —
// written by the tool via toPosix(auditFilePath) — round-trips when read
// back). Audit-emitting cases seed audit-sample.md first (matching the .sh,
// whose seed contains NONE of the events asserted here, so post-fire counts
// are unambiguous). All temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  intentsDirOf,
  removeWorkspaceRecord,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-log.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

// Every emit-success case runs against a workspace with a RESOLVABLE active
// intent — createTestProject seeds the per-intent record dir + active-intent
// cursor, but the cursor only resolves once an aidlc-state.md exists in that
// record (activeIntent gates on the state file, aidlc-lib.ts). So we seed one.
// aidlc-log refuses to emit when no active workflow resolves (the null-intent
// guard — see the "no active workflow" describe block below), which is exactly
// the path aidlc-log is exercised on: orchestrator-called mid-stage, after a
// workflow exists. With a real active intent the appended shard lands UNDER the
// per-intent record (…/intents/<record>/audit/<clone>.md), never the bare space
// root; readAllAuditShards globs every shard and merges by timestamp.
function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedStateFile(p, "state-mid-ideation.md");
  return p;
}

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

/** Count audit blocks with `**Event**: <ev>` in a buffer. */
function auditEventCount(body: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return body
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
function auditField(body: string, ev: string, key: string): string {
  let matched = false;
  for (const line of body.split("\n")) {
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

/** Whole-buffer presence (mirrors a bare grep with no `^` anchor). */
function fileContains(body: string, needle: string): boolean {
  return body.includes(needle);
}

// ============================================================
// decision subcommand (covers: subcommand:aidlc-log decision)
// ============================================================

describe("t31 aidlc-log decision (migrated from t31-tool-log.sh, plan 21)", () => {
  test("1: decision emits DECISION_RECORDED", () => {
    const p = proj();
    const r = log(["decision", "--stage", "feasibility", "--decision", "Pick a framework"], p);
    expect(r.status).toBe(0);
    expect(auditEventCount(readAllAuditShards(p), "DECISION_RECORDED")).toBe(1);
    expect(r.stdout).toContain('"emitted":"DECISION_RECORDED"');
  });

  test("2: decision records Stage field", () => {
    const p = proj();
    log(["decision", "--stage", "feasibility", "--decision", "Pick a framework"], p);
    expect(auditField(readAllAuditShards(p), "DECISION_RECORDED", "Stage")).toBe("feasibility");
  });

  test("3: decision records Decision field", () => {
    const p = proj();
    log(["decision", "--stage", "feasibility", "--decision", "Pick a framework"], p);
    expect(auditField(readAllAuditShards(p), "DECISION_RECORDED", "Decision")).toBe("Pick a framework");
  });

  test("4: decision records Options field when supplied", () => {
    const p = proj();
    log(
      ["decision", "--stage", "feasibility", "--decision", "Pick a framework", "--options", "React,Vue,Svelte"],
      p,
    );
    expect(auditField(readAllAuditShards(p), "DECISION_RECORDED", "Options")).toBe("React,Vue,Svelte");
  });

  test("5: decision records Rationale field when supplied", () => {
    const p = proj();
    log(
      ["decision", "--stage", "feasibility", "--decision", "Pick a framework", "--rationale", "Align with team skillset"],
      p,
    );
    expect(auditField(readAllAuditShards(p), "DECISION_RECORDED", "Rationale")).toBe("Align with team skillset");
  });

  test("7: decision missing --stage exits 1", () => {
    const p = proj();
    const r = log(["decision", "--decision", "x"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Missing --stage");
  });

  test("8: decision missing --decision exits 1", () => {
    const p = proj();
    const r = log(["decision", "--stage", "feasibility"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Missing --decision");
  });

  test("16: decision without --options omits Options field entirely", () => {
    const p = proj();
    log(["decision", "--stage", "feasibility", "--decision", "Pick one"], p);
    // Block-scoped absence: no **Options**: line in the DECISION_RECORDED
    // block (the empty-string return). Mirrors assert_not_grep '**Options**:'.
    expect(auditField(readAllAuditShards(p), "DECISION_RECORDED", "Options")).toBe("");
    expect(fileContains(readAllAuditShards(p), "**Options**:")).toBe(false);
  });

  test("17: decision --stage without value (followed by --decision) errors cleanly (exit 1)", () => {
    const p = proj();
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
    const p = proj();
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
    expect(auditEventCount(readAllAuditShards(p), "QUESTION_ANSWERED")).toBe(1);
    expect(r.stdout).toContain('"emitted":"QUESTION_ANSWERED"');
  });

  test("10: answer records Stage and Details fields", () => {
    const p = proj();
    log(["answer", "--stage", "feasibility", "--details", "User chose React"], p);
    const f = readAllAuditShards(p);
    expect(auditField(f, "QUESTION_ANSWERED", "Details")).toBe("User chose React");
    // STRONGER than the .sh (which only grepped Details): the .sh case name
    // is "records Stage and Details", so the Stage value is asserted too.
    expect(auditField(f, "QUESTION_ANSWERED", "Stage")).toBe("feasibility");
  });

  test("12: answer missing --stage exits 1", () => {
    const p = proj();
    const r = log(["answer", "--details", "x"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Missing --stage");
  });

  test("13: answer missing --details exits 1", () => {
    const p = proj();
    const r = log(["answer", "--stage", "feasibility"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Missing --details");
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
    const p = proj();
    const r = log(["bogus"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Unknown subcommand");
  });
});

// ============================================================
// Null-resolved-intent guard: aidlc-log refuses to emit (and never drops a
// shard into the BARE space record root) when no active workflow resolves.
//
// WHY this matters: aidlc-log threads no --intent/--space, so it relies on
// default resolution. On a fresh shell (no record) or a >1-intent workspace
// with no active-intent cursor, activeIntent() → null and the path helpers
// collapse to the bare aidlc/spaces/<space>/intents/ root. An unguarded emit
// would write a state/audit shard DIRECTLY there, breaking the invariant that
// no aidlc-state.md / audit/ ever lives in the bare intents root (aidlc-lib.ts).
// aidlc-log was the lone emitter missing the "no active workflow → clean error"
// guard every other emitter has (the hooks no-op via existsSync(stateFilePath);
// emitError gates on the same check). Mirrors that.
//
// These cases REMOVE the seeded record (removeWorkspaceRecord, the no-layout
// option) so no intent resolves at all — the strongest form of the at-risk
// state. The guard fires identically for the >1-intent-no-cursor case (both
// resolve to null), so the no-record case is the representative test.
// ============================================================

describe("t31 aidlc-log null-intent guard", () => {
  // The bare space record root: aidlc/spaces/default/intents/. A guarded emit
  // must leave NO aidlc-state.md and NO audit/ dir directly under it.
  function bareIntentsRootEntries(p: string): string[] {
    const root = intentsDirOf(p);
    if (!existsSync(root)) return [];
    return readdirSync(root);
  }

  test("g1: decision with no resolvable active intent errors cleanly (exit 1)", () => {
    const p = proj();
    removeWorkspaceRecord(p); // tear the record + cursor down — activeIntent → null
    const r = log(["decision", "--stage", "feasibility", "--decision", "Pick a framework"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("No active workflow");
    // The error path emits nothing — no DECISION_RECORDED anywhere.
    expect(fileContains(readAllAuditShards(p), "DECISION_RECORDED")).toBe(false);
  });

  test("g2: decision with no resolvable intent drops NO state/audit in the bare intents root", () => {
    const p = proj();
    removeWorkspaceRecord(p);
    log(["decision", "--stage", "feasibility", "--decision", "Pick a framework"], p);
    const entries = bareIntentsRootEntries(p);
    // removeWorkspaceRecord rm's the whole intents dir; a guarded emit must not
    // recreate it with a stray state file or audit shard directly inside it.
    expect(entries).not.toContain("aidlc-state.md");
    expect(entries).not.toContain("audit");
  });

  test("g3: answer with no resolvable active intent errors cleanly (exit 1)", () => {
    const p = proj();
    removeWorkspaceRecord(p);
    const r = log(["answer", "--stage", "feasibility", "--details", "User chose React"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain("No active workflow");
    expect(fileContains(readAllAuditShards(p), "QUESTION_ANSWERED")).toBe(false);
  });

  test("g4: answer with no resolvable intent drops NO state/audit in the bare intents root", () => {
    const p = proj();
    removeWorkspaceRecord(p);
    log(["answer", "--stage", "feasibility", "--details", "User chose React"], p);
    const entries = bareIntentsRootEntries(p);
    expect(entries).not.toContain("aidlc-state.md");
    expect(entries).not.toContain("audit");
  });
});
