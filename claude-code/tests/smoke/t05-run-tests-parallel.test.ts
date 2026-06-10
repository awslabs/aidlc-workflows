// covers:
//
// t05 — the `--parallel N` (alias `-P`) flag on the test runner shell script.
// Migrated from tests/smoke/t05-run-tests-parallel.sh (TAP plan 14). The .sh
// had no machine-readable `# covers:` header — its SUBJECT is the runner shell
// script itself (tests/run-tests.sh), a behavioural guard over a process, not a
// unit contract — so this twin's covers id list is empty too, matching the
// smoke-guard house style in tests/smoke/t02-hook-executability.test.ts and
// tests/smoke/t-scope-mapping-guard.test.ts.
//
// Mechanism: cli. The subject is a shell script. There is nothing to import —
// the only observable surface is the runner's argv handling, exit code, banner
// lines, START/DONE markers, summary block, and the `_results` sidecar dir it
// leaves on disk. Every assertion SPAWNS the real `bash tests/run-tests.sh ...`
// via node:child_process spawnSync (the same process boundary the .sh shelled
// out across) and asserts on its combined stdout+stderr / exit status / disk.
// This is NOT a 1:1 transliteration of bash — it is a bun test that drives the
// runner and asserts in TS.
//
// Source under test (tests/run-tests.sh — line cites against this worktree):
//   :87-94   --parallel|-P  validates the value against /^[1-9][0-9]*$/; on a
//            non-match prints "ERROR: --parallel requires a positive integer
//            (got: '<x>')" to stderr and `exit 2`. A bare `--parallel` with no
//            following value consumes the next flag (or empty) as the value,
//            which fails the regex -> same exit 2 path.
//   :81      --ci enables RUN_WORKTREE=true.
//   :220     "=== START <name> ===" streams live in BOTH modes.
//   :278/:286 "=== DONE <name> (<STATUS>) ===" closes each file.
//   :556     each tier `find $RESULTS_DIR -name '*.meta' -delete` — the sidecar
//            dir ends a run empty (aggregated and cleared).
//   :573     smoke|unit|worktree force effective_parallel=1.
//   :576-579 a tier prints "## <label> (parallel=N)" ONLY when
//            effective_parallel > 1; otherwise the bare "## <label>".
//   :662-666 integration tier tags its banner with $PARALLEL (>1).
//   :689     worktree tier label is "Worktree Tests (primitive helpers)".
//   :809-822 SUMMARY block: "Test files:", "Failed files:", "Total assertions:",
//            "Failed assertions:", then "RESULT: FAIL" / "RESULT: PASS".
//   :824     `exit "$FAILED_FILES"` — non-zero exit when any file failed.
//
// Determinism note (why this twin is STRONGER than the .sh on tier scope):
//   The .sh ran the WHOLE smoke tier for its "parallel 1 matches serial"
//   comparison (test 2) and the WHOLE worktree tier for tests 7-9. But the
//   smoke tier CONTAINS t05 itself, which recursively re-invokes the runner; the
//   resulting file/assertion counts are NOT stable across runs (measured 14 vs
//   16 vs 20 on back-to-back invocations of `--smoke` in this worktree, because
//   the recursive child's contribution varies with env + timing). So this twin
//   scopes every runner invocation with --filter to a small, stable,
//   NON-recursive set (t06-claude-md-paths for smoke; t12|t30|t31|t32 for
//   feature, the .sh's own feature filter; t01-helpers for worktree). The
//   contract under test — parallel=1 ≡ serial, banner tagging, interleaving,
//   failure propagation, sidecar cleanup — is preserved exactly, on a surface
//   that does not race against the runner's own recursion.
//
// Old TAP -> new test parity (14 .sh `ok` rows -> 14 expect()-bearing test()s):
//   .sh test 1a (invalid --parallel 0 -> rc2 + msg)   -> "rejects --parallel 0 ..."
//   .sh test 1b (invalid --parallel -1 -> rc2 + msg)  -> "rejects --parallel -1 ..."
//   .sh test 1c (invalid --parallel abc -> rc2 + msg) -> "rejects --parallel abc ..."
//   .sh test 2  (--parallel with no arg -> rc2)       -> "rejects bare --parallel (no value) with exit 2"
//   .sh test 3  (parallel 1 summary == serial smoke)  -> "--parallel 1 summary matches serial (smoke tier, filtered)"
//   .sh test 4  (smoke banner omits '(parallel=')     -> "smoke tier banner omits '(parallel=N)' under --parallel 4"
//   .sh test 5  (feature banner tagged '(parallel=4)')-> "feature tier banner tagged '(parallel=4)'"
//   .sh test 6  (interleaving: >=2 STARTs before DONE)-> "feature tier interleaves: >=2 STARTs before first DONE"
//   .sh test 7  (serial counts == parallel counts)    -> "summary counts identical between serial and --parallel 4 (feature)"
//   .sh test 8  (planted fail propagates: FAIL + rc!=0)-> "planted failure propagates under --parallel 4 (RESULT: FAIL, non-zero exit)"
//   .sh test 9  (--worktree dispatches; banner)        -> "--worktree dispatches; banner printed"
//   .sh test 10 (--worktree reports >0 test files)     -> "--worktree reports >0 test files"
//   .sh test 11 (--ci dispatches worktree tier)        -> "--ci dispatches the worktree tier"
//   .sh test 12 (_results dir ends run empty)          -> "_results sidecar dir holds no leftover .meta after run"
//   (the .sh's `plan 14` = 3 invalid-value rows + 1 no-arg + 8 numbered tests;
//    this twin keeps all 14 distinct behavioural assertions.)

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

// The runner lives at <repo>/tests/run-tests.sh. We invoke it with `bash` to
// match how the suite (and the .sh) ran it — the runner is not chmod-dependent
// in the test path, and `bash <script>` is the runner's documented entrypoint.
const TESTS_ROOT = join(REPO_ROOT, "tests");
const RUNNER = join(TESTS_ROOT, "run-tests.sh");

interface RunResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's `2>&1`)
}

/**
 * Spawn `bash tests/run-tests.sh <args>` and capture combined stdout+stderr and
 * the exit status. AIDLC_T05_CHILD is left untouched: the .sh self-recursion
 * guard is moot here because this twin never lands inside a smoke run of itself
 * (it scopes smoke to t06-claude-md-paths, which does not re-invoke the runner).
 */
function run(args: string[]): RunResult {
  const res = spawnSync("bash", [RUNNER, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    // Plenty of headroom — filtered tiers finish in seconds, but cold bun +
    // worktree git-repo setup can spike. Well under the per-test timeout below.
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

// Track any verbose log dirs the runner creates so we tear them down — the
// runner writes them under tests/logs/<ISO>/ and only auto-cleans the mktemp
// (non-verbose) dir. We parse the dir from the runner's own stdout (stronger
// and race-free vs the .sh's `find tests/logs | tail -1`).
const createdLogDirs: string[] = [];

afterAll(() => {
  for (const d of createdLogDirs) rmSync(d, { recursive: true, force: true });
});

const PER_TEST_TIMEOUT = 120000;

describe("t05 run-tests.sh --parallel flag (migrated from t05-run-tests-parallel.sh, plan 14)", () => {
  // --- 1. Invalid --parallel values exit 2 with the error message ----------
  // .sh looped `for bad in 0 -1 abc` asserting rc==2 AND the error grep. Each
  // value is its own distinct behavioural assertion -> three test()s.
  for (const bad of ["0", "-1", "abc"]) {
    test(`rejects --parallel ${bad} with exit 2 and the positive-integer error`, () => {
      const r = run(["--parallel", bad]);
      expect(r.status).toBe(2);
      expect(r.out).toContain("ERROR: --parallel requires a positive integer");
      // STRONGER than the .sh's bare label grep: the message echoes the bad
      // value back (run-tests.sh:90 `(got: '${PARALLEL...}')`).
      expect(r.out).toContain(`(got: '${bad}')`);
    }, PER_TEST_TIMEOUT);
  }

  // --- 2. Bare --parallel (no following value) -> exit 2 --------------------
  // .sh test "--parallel with no argument exits 2": with nothing after it the
  // flag consumes "" (or the next flag), which fails /^[1-9][0-9]*$/.
  test("rejects bare --parallel (no value) with exit 2", () => {
    const r = run(["--parallel"]);
    expect(r.status).toBe(2);
    // The same guard fires; the captured value is empty -> "<missing>" sentinel
    // (run-tests.sh:90 `${PARALLEL:-<missing>}`). STRONGER than the .sh, which
    // only checked rc==2 here.
    expect(r.out).toContain("ERROR: --parallel requires a positive integer");
  }, PER_TEST_TIMEOUT);

  // --- 3. --parallel 1 ≡ serial on the smoke tier --------------------------
  // .sh compared the (Test files / Total assertions) summary lines between
  // `--smoke` and `--smoke --parallel 1`. (The .sh's `^Failed:` alternative
  // never matches — the real lines are "Failed files:"/"Failed assertions:" —
  // so the comparison is over those two lines; we compare them explicitly.)
  // Scoped to the stable, non-recursive t06-claude-md-paths filter.
  test("--parallel 1 summary matches serial (smoke tier, filtered)", () => {
    const filter = "t06-claude-md-paths";
    const serial = run(["--smoke", "--filter", filter]);
    const p1 = run(["--smoke", "--parallel", "1", "--filter", filter]);
    const summary = (out: string): string =>
      out
        .split("\n")
        .filter((l) => /^(Test files|Total assertions):/.test(l))
        .join("|");
    const s = summary(serial.out);
    const p = summary(p1.out);
    // Both runs pass (exit 0) and report the same counts.
    expect(serial.status).toBe(0);
    expect(p1.status).toBe(0);
    expect(s).toBe(p);
    // Sanity: the comparison is over real, populated lines, not two empties.
    expect(s).toContain("Test files:");
    expect(s).toContain("Total assertions:");
  }, PER_TEST_TIMEOUT);

  // --- 4. Smoke tier stays serial under --parallel 4 -----------------------
  // run-tests.sh:573 forces smoke -> effective_parallel=1, so :576-579 prints
  // the BARE "## Smoke Tests" banner — no "(parallel=N)" tag.
  test("smoke tier banner omits '(parallel=N)' under --parallel 4", () => {
    const r = run(["--smoke", "--parallel", "4", "--filter", "t06-claude-md-paths"]);
    const banner =
      r.out.split("\n").find((l) => l.startsWith("## Smoke Tests")) ?? "";
    expect(banner).not.toBe("");
    expect(banner).not.toContain("(parallel=");
  }, PER_TEST_TIMEOUT);

  // --- 5. Feature tier honours --parallel: banner tagged -------------------
  // The feature tier is NOT pinned serial, so effective_parallel=4 and the
  // banner carries "(parallel=4)" (run-tests.sh:577).
  test("feature tier banner tagged '(parallel=4)'", () => {
    const r = run([
      "--feature", "--parallel", "4", "--filter", "t12|t30|t31|t32",
    ]);
    const banner =
      r.out.split("\n").find((l) => l.startsWith("## Feature Tests")) ?? "";
    expect(banner).toContain("(parallel=4)");
  }, PER_TEST_TIMEOUT);

  // --- 6. Interleaving observed under --parallel 4 -------------------------
  // With >=4 files fanned out 4-wide, at least two "=== START ===" markers
  // should print before the first "=== DONE ===" (run-tests.sh:220 START
  // streams live in both modes; :278/:286 DONE).
  test("feature tier interleaves: >=2 STARTs before first DONE under --parallel 4", () => {
    const r = run([
      "--feature", "--parallel", "4", "--filter", "t12|t30|t31|t32",
    ]);
    const markers = r.out
      .split("\n")
      .filter((l) => /^=== (START|DONE)/.test(l));
    const firstDoneIdx = markers.findIndex((l) => l.startsWith("=== DONE"));
    // There must be a DONE at all (the tier actually ran files).
    expect(firstDoneIdx).toBeGreaterThanOrEqual(0);
    const startsBeforeFirstDone = markers
      .slice(0, firstDoneIdx)
      .filter((l) => l.startsWith("=== START")).length;
    expect(startsBeforeFirstDone).toBeGreaterThanOrEqual(2);
  }, PER_TEST_TIMEOUT);

  // --- 7. Summary counts identical: serial vs --parallel 4 (feature) -------
  // .sh compared (Test files / Total assertions / Failed files / Failed
  // assertions) sorted between serial and parallel feature runs.
  test("summary counts identical between serial and --parallel 4 (feature)", () => {
    const filter = "t12|t30|t31|t32";
    const serial = run(["--feature", "--filter", filter]);
    const parallel = run(["--feature", "--parallel", "4", "--filter", filter]);
    const counts = (out: string): string =>
      out
        .split("\n")
        .filter((l) =>
          /^(Test files|Total assertions|Failed files|Failed assertions):/.test(l),
        )
        .sort()
        .join("|");
    expect(serial.status).toBe(0);
    expect(parallel.status).toBe(0);
    expect(counts(serial.out)).toBe(counts(parallel.out));
    // Sanity: the compared block is non-empty.
    expect(counts(serial.out)).toContain("Test files:");
  }, PER_TEST_TIMEOUT);

  // --- 8. Failure propagation under parallelism (§6-E: the failure FIRES) ---
  // The .sh planted a real failing TAP file into tests/feature/ and asserted
  // the run reports RESULT: FAIL and exits non-zero under --parallel 4. We do
  // the same — a genuine `not ok` must drive the failure; a happy path would
  // NOT be equal-or-stronger. The planted file is removed in finally.
  test("planted failure propagates under --parallel 4 (RESULT: FAIL, non-zero exit)", () => {
    const plant = join(TESTS_ROOT, "feature", "tZZ-planted-fail-t05.sh");
    writeFileSync(
      plant,
      [
        "#!/bin/bash",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell ${...} in a fixture script, not a JS template
        'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
        'source "$SCRIPT_DIR/../lib/tap.sh"',
        "plan 1",
        'not_ok "planted failure for t05 propagation test" "expected"',
        "finish",
        "",
      ].join("\n"),
      "utf-8",
    );
    try {
      const r = run([
        "--feature",
        "--filter",
        "t12|tZZ-planted-fail-t05",
        "--parallel",
        "4",
      ]);
      // The failure event actually fired: a "not ok" line was emitted and the
      // summary verdict flipped to FAIL with a non-zero exit (run-tests.sh:818).
      expect(r.out).toContain("not ok");
      expect(r.out.split("\n").some((l) => l.startsWith("RESULT: FAIL"))).toBe(
        true,
      );
      expect(r.status).not.toBe(0);
    } finally {
      rmSync(plant, { force: true });
    }
  }, PER_TEST_TIMEOUT);

  // --- 9. --worktree dispatches; banner printed ----------------------------
  // The worktree tier registers and prints its label (run-tests.sh:689).
  // Scoped to t01-helpers for speed; the .sh's test 8 already declares the
  // count "no longer pinned — assert > 0", so a 1-file filter is faithful.
  test("--worktree dispatches; banner printed", () => {
    const r = run(["--worktree", "--parallel", "4", "--filter", "t01-helpers"]);
    expect(
      r.out.split("\n").some((l) => l.startsWith("## Worktree Tests")),
    ).toBe(true);
  }, PER_TEST_TIMEOUT);

  // --- 10. --worktree reports a positive test-file count -------------------
  test("--worktree reports >0 test files", () => {
    const r = run(["--worktree", "--parallel", "4", "--filter", "t01-helpers"]);
    const line =
      r.out.split("\n").find((l) => /^Test files: \d+$/.test(l)) ?? "";
    const m = line.match(/^Test files: (\d+)$/);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(0);
  }, PER_TEST_TIMEOUT);

  // --- 11. --ci profile dispatches the worktree tier -----------------------
  // run-tests.sh:81 — --ci enables RUN_WORKTREE=true, so the worktree banner
  // appears under --ci even with an unrelated filter.
  test("--ci dispatches the worktree tier", () => {
    const r = run(["--ci", "--filter", "t01-helpers"]);
    expect(
      r.out.split("\n").some((l) => l.startsWith("## Worktree Tests")),
    ).toBe(true);
  }, PER_TEST_TIMEOUT);

  // --- 12. _results sidecar dir ends the run empty -------------------------
  // run-tests.sh:556 deletes every *.meta after each tier aggregates. The .sh
  // ran verbose so the dir is inspectable on disk, then `find ... | tail -1` to
  // locate it. We capture the EXACT log dir from the runner's own stdout
  // ("Verbose mode: logging to <abs>") — race-free and stronger than tail -1.
  test("_results sidecar dir holds no leftover .meta after run (verbose, inspectable)", () => {
    const r = run([
      "--smoke",
      "--parallel",
      "2",
      "--verbose",
      "--filter",
      "t06-claude-md-paths",
    ]);
    const logLine =
      r.out.split("\n").find((l) => l.startsWith("Verbose mode: logging to ")) ??
      "";
    const logDir = logLine.replace("Verbose mode: logging to ", "").trim();
    expect(logDir).not.toBe("");
    createdLogDirs.push(logDir);
    const resultsDir = join(logDir, "_results");
    expect(existsSync(resultsDir)).toBe(true);
    const leftoverMeta = readdirSync(resultsDir).filter((f) =>
      f.endsWith(".meta"),
    );
    expect(leftoverMeta.length).toBe(0);
  }, PER_TEST_TIMEOUT);
});
