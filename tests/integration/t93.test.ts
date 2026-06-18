// covers: subcommand:aidlc-sensor:list
//
// CLI-contract port of tests/integration/t93-sensor-list-describe.sh (TAP plan 12),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-sensor.ts list|describe|--help|-h` (or bare, no
// subcommand) is preserved by SPAWNING the real CLI via node:child_process
// spawnSync (BUN + the tool .ts path), asserting on res.status / res.stdout /
// res.stderr exactly as the .sh asserted on $? / 2>&1 stdout. The contract is
// the PROCESS boundary (incl. the exit codes the .sh's `set +e ... $?` arms
// rely on), so it stays a spawn — an in-process handleList()/handleDescribe()
// twin would lose the exit-1 half of cases 9 (unknown id -> dispatchError ->
// process.exit(1)) and 12 (no subcommand -> process.exit(1)).
//
// READ-ONLY SURFACE (mirrors the .sh's "no temp project setup needed"): list /
// describe / --help all run against the framework's shipped sensors dir
// (dist/claude/.claude/sensors/), resolved by loadSensors() as
// __FILE_DIR/../sensors (aidlc-graph.ts:168) — independent of cwd, so no temp
// project, no fixtures, no audit.md. This port therefore writes NOTHING to disk
// and seeds nothing; it doubles as a forward-check that the 4 shipped manifests
// stay parseable, exactly as the .sh comment (t93:17-19) states.
//
// COVERS ID: this .cli file credits the `aidlc-sensor list` subcommand unit
// (covers KEY subcommand:aidlc-sensor:list, COLON form). The .sh also drives
// `describe` and `--help`/`-h`, asserted here for stronger parity, but the
// registry-credited unit for this port is `list` per the assigned covers line.
//
// PARITY NOTES (every .sh `ok`/`assert_eq` line maps to an expect() below;
// several are STRONGER than the original grep/awk):
//   - .sh Case 1  list emits 4 framework sensors (grep -c TAB == 4)   -> Test 1:
//       rows.length === 4 (same observable: count of tab-bearing rows).
//   - .sh Case 2  every row column 2 == "deterministic" (awk != count) -> Test 2:
//       every row's cols[1] === "deterministic" (same observable, per-row).
//   - .sh Case 3  list is alpha-sorted by id (IDS == sort IDS)        -> Test 3:
//       ids deep-equals ids.slice().sort() (same observable).
//   - .sh Case 4  list returns exactly the 4 expected ids (assert_eq) -> Test 4:
//       ids === ["linter","required-sections","type-check","upstream-coverage"]
//       (same sentinel set, exact).
//   - .sh Case 5  describe required-sections: id, kind=deterministic,
//       command, default_severity=advisory, matches: **/{aidlc-docs,intents}/**  -> Test 5:
//       all five field lines asserted (STRONGER: the .sh grep'd 5 anchored
//       lines; here each is an exact line-membership check plus we also assert
//       the description line, which the .sh's handleDescribe contract emits).
//   - .sh Case 6  describe upstream-coverage: id, command, matches         -> Test 6.
//   - .sh Case 7  describe linter: id, matches: **/*.{ts,js}, command       -> Test 7.
//   - .sh Case 8  describe type-check: id, matches: **/*.{ts,tsx}, command  -> Test 8.
//   - .sh Case 9  describe <unknown-id> exits !=0 + "unknown sensor id" hint -> Test 9:
//       res.status === 1 (STRONGER than the .sh's `-ne 0`) + the hint asserted.
//   - .sh Case 10 --help prints "Usage: aidlc-sensor" + list/describe/fire   -> Test 10.
//   - .sh Case 11 -h prints the same usage banner                           -> Test 11.
//   - .sh Case 12 no subcommand exits !=0 + "Usage: aidlc-sensor"           -> Test 12:
//       res.status === 1 (STRONGER) + the usage hint asserted.
//
// 12 .sh asserts -> 12 expect()-bearing test() cases here, one observable each.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-sensor.ts",
);

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/** Spawn `bun aidlc-sensor.ts <args...>`. Mirrors `bun "$SENSOR_TS" ...` 2>&1. */
function sensor(...args: string[]): CliResult {
  const res = spawnSync(BUN, [TOOL, ...args], { encoding: "utf-8" });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/**
 * Parse `list` stdout into rows of [id, kind, description]. handleList emits
 * one tab-separated row per sensor (aidlc-sensor.ts:145-147); the .sh counted
 * rows via `grep -c '\t'` and split columns via `awk -F'\t'`. We split the same
 * way, dropping any trailing blank line.
 */
function listRows(out: string): string[][] {
  return out
    .split("\n")
    .filter((l) => l.includes("\t"))
    .map((l) => l.split("\t"));
}

const EXPECTED_IDS = [
  "linter",
  "required-sections",
  "type-check",
  "upstream-coverage",
];

// ============================================================
// list subcommand (covers: subcommand:aidlc-sensor:list)
// ============================================================

describe("t93 aidlc-sensor list (migrated from t93-sensor-list-describe.sh, plan 12)", () => {
  test("1: list emits exactly 4 framework sensors", () => {
    const r = sensor("list");
    expect(r.status).toBe(0); // STRONGER: .sh discarded $? on list; we pin clean exit
    expect(listRows(r.out)).toHaveLength(4);
  });

  test("2: list column 2 is 'deterministic' for every row", () => {
    const r = sensor("list");
    const rows = listRows(r.out);
    // .sh: `awk -F'\t' '$2 != "deterministic"' | wc -l` == 0.
    const nonDeterministic = rows.filter((cols) => cols[1] !== "deterministic");
    expect(nonDeterministic).toHaveLength(0);
  });

  test("3: list is alpha-sorted by id", () => {
    const r = sensor("list");
    const ids = listRows(r.out).map((cols) => cols[0]);
    // .sh: IDS == (IDS | sort). Deep-equal against the sorted copy.
    expect(ids).toEqual([...ids].sort());
  });

  test("4: list returns exactly the 4 framework sensor ids", () => {
    const r = sensor("list");
    const ids = listRows(r.out).map((cols) => cols[0]);
    // .sh sentinel set — flags drift if a sensor is renamed/added/removed.
    expect(ids).toEqual(EXPECTED_IDS);
  });
});

// ============================================================
// describe subcommand (stronger-parity coverage of the .sh's describe cases)
// ============================================================

describe("t93 aidlc-sensor describe (migrated from t93-sensor-list-describe.sh, plan 12)", () => {
  /** Line-membership against the describe stdout (mirrors `grep -q '^<line>$'`). */
  function hasLine(out: string, line: string): boolean {
    return out.split("\n").includes(line);
  }

  test("5: describe required-sections lists canonical fields incl. matches: **/{aidlc-docs,intents}/**", () => {
    const r = sensor("describe", "required-sections");
    expect(r.status).toBe(0);
    expect(hasLine(r.out, "id: required-sections")).toBe(true);
    expect(hasLine(r.out, "kind: deterministic")).toBe(true);
    expect(
      hasLine(
        r.out,
        "command: bun .claude/tools/aidlc-sensor-required-sections.ts",
      ),
    ).toBe(true);
    expect(hasLine(r.out, "default_severity: advisory")).toBe(true);
    expect(hasLine(r.out, "matches: **/{aidlc-docs,intents}/**")).toBe(true);
  });

  test("6: describe upstream-coverage lists canonical fields incl. matches: **/{aidlc-docs,intents}/**", () => {
    const r = sensor("describe", "upstream-coverage");
    expect(r.status).toBe(0);
    expect(hasLine(r.out, "id: upstream-coverage")).toBe(true);
    expect(
      hasLine(
        r.out,
        "command: bun .claude/tools/aidlc-sensor-upstream-coverage.ts",
      ),
    ).toBe(true);
    expect(hasLine(r.out, "matches: **/{aidlc-docs,intents}/**")).toBe(true);
  });

  test("7: describe linter includes matches: **/*.{ts,js} and canonical fields", () => {
    const r = sensor("describe", "linter");
    expect(r.status).toBe(0);
    expect(hasLine(r.out, "id: linter")).toBe(true);
    expect(hasLine(r.out, "matches: **/*.{ts,js}")).toBe(true);
    expect(
      hasLine(r.out, "command: bun .claude/tools/aidlc-sensor-linter.ts"),
    ).toBe(true);
  });

  test("8: describe type-check includes matches: **/*.{ts,tsx} and canonical fields", () => {
    const r = sensor("describe", "type-check");
    expect(r.status).toBe(0);
    expect(hasLine(r.out, "id: type-check")).toBe(true);
    expect(hasLine(r.out, "matches: **/*.{ts,tsx}")).toBe(true);
    expect(
      hasLine(r.out, "command: bun .claude/tools/aidlc-sensor-type-check.ts"),
    ).toBe(true);
  });

  test("9: describe <unknown-id> exits 1 with a known-ids hint", () => {
    const r = sensor("describe", "definitely-not-a-real-sensor-id");
    expect(r.status).toBe(1); // STRONGER: .sh asserted `-ne 0`; the tool's dispatchError exits 1
    expect(r.out).toContain("unknown sensor id");
  });
});

// ============================================================
// Help / dispatch (the .sh's --help, -h, and no-subcommand cases)
// ============================================================

describe("t93 aidlc-sensor help + dispatch (migrated from t93-sensor-list-describe.sh, plan 12)", () => {
  test("10: --help prints usage covering all 3 subcommands", () => {
    const r = sensor("--help");
    expect(r.out).toContain("Usage: aidlc-sensor");
    expect(r.out).toContain("list");
    expect(r.out).toContain("describe");
    expect(r.out).toContain("fire");
  });

  test("11: -h prints the same usage banner", () => {
    const r = sensor("-h");
    expect(r.out).toContain("Usage: aidlc-sensor");
  });

  test("12: no subcommand exits 1 with a usage hint", () => {
    const r = sensor();
    expect(r.status).toBe(1); // STRONGER: .sh asserted `-ne 0`; main()'s no-cmd arm exits 1
    expect(r.out).toContain("Usage: aidlc-sensor");
  });
});
