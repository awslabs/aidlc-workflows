// covers: subcommand:aidlc-utility:doctor
//
// CLI-contract port of tests/unit/t85-doctor-practices-staleness.sh (TAP
// plan 6), mechanism = cli. Equal-or-stronger migration: every .sh
// assertion that shelled out to `bun aidlc-utility.ts doctor
// --project-dir <p>` and grepped the combined stdout/stderr is preserved by
// SPAWNING the real CLI via node:child_process spawnSync (BUN + the tool
// .ts path), asserting on the same `out` (stdout+stderr, mirroring the .sh's
// `2>&1`) and — STRONGER — on res.status. handleDoctor is a process.exit
// entrypoint (aidlc-utility.ts:1385, `import.meta.main` at :2861), so it
// stays a spawn: an in-process twin would lose the exit-code half AND the
// process.stdout.write report half the practices-staleness contract renders.
//
// CONTRACT UNDER TEST (aidlc-utility.ts:894-945, Check 5 — Practices
// staleness): reads `Practices Affirmed Timestamp` from main state, compares
// to now.
//   - state file absent / empty / `[`-placeholder / missing field ->
//       pass=true, "never affirmed (informational)" (well — "state file
//       absent" for the no-state arm; the .sh only exercises the empty /
//       placeholder / missing-field arms, all of which land on "never
//       affirmed (informational)").
//   - within PRACTICES_STALENESS_DAYS (90, aidlc-utility.ts:321) -> pass=true,
//       "affirmed N day(s) ago" with NO "advisory".
//   - beyond 90 days -> pass=true, "affirmed N days ago (advisory — > 90
//       days; consider re-running practices-discovery)".
//   - unparseable ISO -> pass=FALSE, "timestamp unreadable" + the bad value
//       echoed in the fix clause. This is the ONLY failing check the .sh
//       exercises, so it forces doctor's overall exit to 1 (failed > 0,
//       aidlc-utility.ts:1385) — pinned here, STRONGER than the .sh's
//       `|| true` swallow.
//   - future-dated -> pass=true, "affirmed in the future (clock skew or
//       hand-edited timestamp N day(s) ahead)" (regression for the MINOR fix
//       that pre-fix produced "affirmed -26525 days ago").
//
// The report renderer (aidlc-utility.ts:1359-1369) prints `✓  <label>` for
// a passing check and `✗  <label> — <fix>` for a failing one, so the .sh's
// `grep -qE "✓.*Practices staleness…"` and `grep -q "Practices staleness:
// timestamp unreadable"` map directly onto the combined output here.
//
// PARITY NOTES (every .sh `ok` line maps to an expect()-bearing test() case;
// several are STRONGER than the original grep):
//   - .sh Test 1 (empty/template-default placeholder) -> Test 1: out matches
//       "Practices staleness: never affirmed (informational)". STRONGER: the
//       passing-check `✓ ` prefix is also asserted (the .sh grepped the bare
//       label with no prefix anchor).
//   - .sh Test 2 (within 90 days -> day count, no advisory) -> Test 2:
//       out matches /Practices staleness: affirmed \d+ days? ago$/m AND does
//       NOT contain "advisory" on that line. Same two observables as the .sh's
//       `grep -qE … && ! grep -q advisory`.
//   - .sh Test 3 (> 90 days -> advisory pass=true) -> Test 3: out matches the
//       `✓ …affirmed \d+ days ago (advisory` line AND contains "> 90 days".
//       Same two observables. STRONGER: exit code is NOT pinned to 1 here
//       because this is a pass=true row (the .sh likewise relied on the row
//       staying pass=true via the ✓ in its regex).
//   - .sh Test 4 (invalid ISO -> ✗ readable) -> Test 4: out contains
//       "Practices staleness: timestamp unreadable" AND the bad value
//       "not-a-real-iso-string". STRONGER: res.status === 1 is asserted (the
//       only failing check -> doctor exits 1; the .sh swallowed $? with
//       `|| true`).
//   - .sh Test 5 (missing field entirely -> informational) -> Test 5: out
//       matches "Practices staleness: never affirmed (informational)".
//       STRONGER: `✓ ` prefix asserted.
//   - .sh Test 6 (future-dated -> advisory pass with clock-skew label) ->
//       Test 6: out matches the `✓ …affirmed in the future` line AND
//       contains "clock skew". Same two observables.
//
// 6 .sh `ok` lines -> 6 expect()-bearing test() cases here.
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_audit_file
// + seed_state_file <state-mid-ideation.md> + per-case cleanup_test_project):
// each case uses a FRESH temp project dir (createTestProject, which
// toPortablePath-converts on Windows so the tool's path resolution
// round-trips), seeds audit-sample.md (seedAuditFile) and the shipped
// state-mid-ideation.md fixture (seedStateFile), then mutates the
// `Practices Affirmed Timestamp` bullet in-place via sedReplaceInFile (the
// TS port of sed_i). state-mid-ideation.md ships with the bare template
// default (an empty value after the colon), so Test 1 needs no mutation —
// matching the .sh comment "ships with the v7 template default value." All
// temp dirs cleaned in afterAll. NOTHING is written under tests/fixtures/**.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  REPO_ROOT,
  seedAuditFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const TOOL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-utility.ts",
);
const STATE_FIXTURE = join(REPO_ROOT, "tests", "fixtures", "state-mid-ideation.md");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/** Spawn `bun aidlc-utility.ts doctor --project-dir <p>`. Mirrors `bun "$UTIL" doctor --project-dir "$PROJ"`. */
function doctor(p: string): CliResult {
  const res = spawnSync(BUN, [TOOL, "doctor", "--project-dir", p], {
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/**
 * Fresh project seeded with audit-sample.md + state-mid-ideation.md.
 * Mirrors create_test_project + seed_audit_file + seed_state_file per case.
 */
function seededProject(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAuditFile(p);
  seedStateFile(p, STATE_FIXTURE);
  return p;
}

const statePath = (p: string): string =>
  join(p, "aidlc-docs", "aidlc-state.md");

/**
 * Replace the entire `- **Practices Affirmed Timestamp**: …` bullet line with
 * the given value. Mirrors the .sh's
 * `sed_i 's|^- \*\*Practices Affirmed Timestamp\*\*:.*$|- **Practices Affirmed Timestamp**: <v>|'`.
 */
function setAffirmedTimestamp(p: string, value: string): void {
  const f = statePath(p);
  const text = readFileSync(f, "utf-8");
  const replaced = text.replace(
    /^- \*\*Practices Affirmed Timestamp\*\*:.*$/m,
    `- **Practices Affirmed Timestamp**: ${value}`,
  );
  writeFileSync(f, replaced, "utf-8");
}

/**
 * Delete the entire `- **Practices Affirmed Timestamp**:` bullet line.
 * Mirrors the .sh's `sed_i '/^- \*\*Practices Affirmed Timestamp\*\*:/d'`.
 */
function deleteAffirmedTimestamp(p: string): void {
  const f = statePath(p);
  const kept = readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => !/^- \*\*Practices Affirmed Timestamp\*\*:/.test(l))
    .join("\n");
  writeFileSync(f, kept, "utf-8");
}

/** N days ago as an ISO-8601 Z timestamp (replaces the .sh's `date -u -v-Nd`). */
function isoDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

describe("t85 aidlc-utility doctor — practices staleness (migrated from t85-doctor-practices-staleness.sh, plan 6)", () => {
  // --- Test 1: empty/template-default placeholder -> never affirmed (info) ---
  test("1: empty/template-default Practices Affirmed Timestamp -> never affirmed (informational)", () => {
    // state-mid-ideation.md ships with the bare template default (empty value
    // after the colon) — no mutation needed, matching the .sh.
    const p = seededProject();
    const r = doctor(p);
    expect(r.out).toContain(
      "Practices staleness: never affirmed (informational)",
    );
    // STRONGER: the passing-check `✓ ` prefix is rendered for this row.
    expect(r.out).toMatch(
      /✓ {2}Practices staleness: never affirmed \(informational\)/,
    );
  });

  // --- Test 2: affirmed within 90 days -> day count, NO advisory ---
  test("2: affirmed within 90 days reports day count without advisory", () => {
    const p = seededProject();
    setAffirmedTimestamp(p, isoDaysAgo(30));
    const r = doctor(p);
    // Same two observables as the .sh: a day-count line AND no "advisory"
    // on the practices-staleness line.
    expect(r.out).toMatch(/Practices staleness: affirmed \d+ days? ago$/m);
    const practicesLine = r.out
      .split("\n")
      .find((l) => l.includes("Practices staleness:"));
    expect(practicesLine).toBeDefined();
    expect(practicesLine).not.toContain("advisory");
  });

  // --- Test 3: affirmed beyond 90 days -> advisory pass=true ---
  test("3: affirmed > 90 days is advisory pass=true with explanatory label", () => {
    const p = seededProject();
    setAffirmedTimestamp(p, isoDaysAgo(180));
    const r = doctor(p);
    // pass=true (✓ on the practices-staleness line) but carries "advisory"
    // AND the threshold value "> 90 days".
    expect(r.out).toMatch(
      /✓ {2}Practices staleness: affirmed \d+ days ago \(advisory/,
    );
    expect(r.out).toContain("> 90 days");
  });

  // --- Test 4: invalid ISO string -> ✗ readable + doctor exits 1 ---
  test("4: invalid ISO 8601 timestamp is flagged readable (✗, exit 1)", () => {
    const p = seededProject();
    setAffirmedTimestamp(p, "not-a-real-iso-string");
    const r = doctor(p);
    expect(r.out).toContain("Practices staleness: timestamp unreadable");
    expect(r.out).toContain("not-a-real-iso-string");
    // STRONGER: this is the only failing check the .sh exercises, so
    // failed > 0 -> doctor exits 1 (aidlc-utility.ts:1385). The .sh swallowed
    // $? with `|| true`; we pin it.
    expect(r.status).toBe(1);
  });

  // --- Test 5: missing field entirely -> never affirmed (informational) ---
  test("5: missing Practices Affirmed Timestamp field treated as never-affirmed (informational)", () => {
    const p = seededProject();
    deleteAffirmedTimestamp(p);
    const r = doctor(p);
    expect(r.out).toContain(
      "Practices staleness: never affirmed (informational)",
    );
    // STRONGER: `✓ ` prefix asserted.
    expect(r.out).toMatch(
      /✓ {2}Practices staleness: never affirmed \(informational\)/,
    );
  });

  // --- Test 6: future-dated timestamp -> advisory pass with clock-skew label ---
  test("6: future-dated timestamp is advisory pass with clock-skew label", () => {
    const p = seededProject();
    setAffirmedTimestamp(p, "2099-01-01T00:00:00Z");
    const r = doctor(p);
    expect(r.out).toMatch(
      /✓ {2}Practices staleness: affirmed in the future/,
    );
    expect(r.out).toContain("clock skew");
  });
});
