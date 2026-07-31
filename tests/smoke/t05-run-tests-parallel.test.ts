// covers:
//
// t05 — the `--parallel N` (alias `-P`) flag on the test runner shell script.
// Migrated from tests/smoke/t05-run-tests-parallel.sh (TAP plan 14) and extended
// in MR8 with shell-test-discovery and shell-file allowlist retirement guards. The .sh
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
//   :81      --ci enables RUN_INTEGRATION=true.
//   :220     "=== START <name> ===" streams live in BOTH modes.
//   :278/:286 "=== DONE <name> (<STATUS>) ===" closes each file.
//   :556     each tier `find $RESULTS_DIR -name '*.meta' -delete` — the sidecar
//            dir ends a run empty (aggregated and cleared).
//   :573     smoke|unit force effective_parallel=1.
//   :576-579 a tier prints "## <label> (parallel=N)" ONLY when
//            effective_parallel > 1; otherwise the bare "## <label>".
//   :662-666 integration level tags its banner with $PARALLEL (>1).
//   :689     e2e level label is "E2E Tests (full lifecycle)".
//   :809-822 SUMMARY block: "Test files:", "Failed files:", "Total assertions:",
//            "Failed assertions:", then "RESULT: FAIL" / "RESULT: PASS".
//   :824     `exit "$FAILED_FILES"` — non-zero exit when any file failed.
//
// Determinism note (why this twin is STRONGER than the .sh on tier scope):
//   The .sh ran the WHOLE smoke tier for its "parallel 1 matches serial"
//   comparison (test 2) and the WHOLE e2e level for tests 7-9. But the
//   smoke tier CONTAINS t05 itself, which recursively re-invokes the runner; the
//   resulting file/assertion counts are NOT stable across runs (measured 14 vs
//   16 vs 20 on back-to-back invocations of `--smoke` in this worktree, because
//   the recursive child's contribution varies with env + timing). So this twin
//   scopes every runner invocation with --filter to a small, stable,
//   NON-recursive set (t06-claude-md-paths for smoke; selected deterministic
//   integration tests; t01-helpers for e2e). The
//   contract under test — parallel=1 ≡ serial, banner tagging, interleaving,
//   failure propagation, sidecar cleanup — is preserved exactly, on a surface
//   that does not race against the runner's own recursion.
//
// Old TAP -> new test parity (14 .sh `ok` rows -> 14 expect-bearing test()s)
// plus the MR8 shell-discovery retirement assertions:
//   .sh test 1a (invalid --parallel 0 -> rc2 + msg)   -> "rejects --parallel 0 ..."
//   .sh test 1b (invalid --parallel -1 -> rc2 + msg)  -> "rejects --parallel -1 ..."
//   .sh test 1c (invalid --parallel abc -> rc2 + msg) -> "rejects --parallel abc ..."
//   .sh test 2  (--parallel with no arg -> rc2)       -> "rejects bare --parallel (no value) with exit 2"
//   .sh test 3  (parallel 1 summary == serial smoke)  -> "--parallel 1 summary matches serial (smoke tier, filtered)"
//   .sh test 4  (smoke banner omits '(parallel=')     -> "smoke tier banner omits '(parallel=N)' under --parallel 4"
//   .sh test 5  (feature banner tagged '(parallel=4)')-> "integration level banner tagged '(parallel=4)'"
//   .sh test 6  (interleaving: >=2 STARTs before DONE)-> "integration level interleaves: >=2 STARTs before first DONE"
//   .sh test 7  (serial counts == parallel counts)    -> "summary counts identical between serial and --parallel 4 (integration)"
//   .sh test 8  (planted fail propagates: FAIL + rc!=0)-> "planted failure propagates under --parallel 4 (RESULT: FAIL, non-zero exit)"
//   .sh test 9  (e2e dispatches; banner)               -> "--e2e dispatches; banner printed"
//   .sh test 10 (e2e reports >0 test files)            -> "--e2e reports >0 test files"
//   .sh test 11 (--ci dispatches integration level)    -> "--ci dispatches the integration level"
//   .sh test 12 (_results dir ends run empty)          -> "_results sidecar dir holds no leftover .meta after run"
//   MR8       (legacy t*.sh no longer discovered)        -> "legacy t*.sh files are ignored by level discovery"
//   MR8       (only allowlisted .sh files remain)         -> "retired shell harness files are gone except runner allowlist"
//   (the .sh's `plan 14` = 3 invalid-value rows + 1 no-arg + 8 numbered tests;
//    this twin keeps all 14 distinct behavioural assertions and adds 2 MR8 assertions.)

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
function run(args: string[], envOverrides: Record<string, string | undefined> = {}): RunResult {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  const res = spawnSync("bash", [RUNNER, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env,
    // Plenty of headroom — filtered tiers finish in seconds, but cold bun +
    // worktree git-repo setup can spike. Well under the per-test timeout below.
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

function plantedBunTestSource(name: string, body: string): string {
  return [
    'import { expect, test } from "bun:test";',
    "",
    `test(${JSON.stringify(name)}, async () => {`,
    body,
    "});",
    "",
  ].join("\n");
}

function shellFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...shellFilesUnder(full));
    } else if (entry.isFile() && entry.name.endsWith(".sh")) {
      files.push(full.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"));
    }
  }
  return files.sort();
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

describe("t05 run-tests.sh --parallel flag (migrated from t05-run-tests-parallel.sh, plan 14 + MR8)", () => {
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

  // --- 5. Integration level honours --parallel: banner tagged --------------
  // The integration level is NOT pinned serial, so effective_parallel=4 and the
  // banner carries "(parallel=4)" (run-tests.sh:577).
  test("integration level banner tagged '(parallel=4)'", () => {
    const r = run([
      "--integration", "--parallel", "4", "--filter", "t12-state|t30-scope|t31-help|t32-stage",
    ]);
    const banner =
      r.out.split("\n").find((l) => l.startsWith("## Integration Tests")) ?? "";
    expect(banner).toContain("(parallel=4)");
  }, PER_TEST_TIMEOUT);

  // --- 6. Interleaving observed under --parallel 4 -------------------------
  // With >=4 files fanned out 4-wide, at least two "=== START ===" markers
  // should print before the first "=== DONE ===" (run-tests.sh:220 START
  // streams live in both modes; :278/:286 DONE).
  test("integration level interleaves: >=2 STARTs before first DONE under --parallel 4", () => {
    const plants = [1, 2, 3, 4].map((i) =>
      join(TESTS_ROOT, "integration", `tZ${i}-slow-t05.test.ts`),
    );
    for (const [idx, plant] of plants.entries()) {
      writeFileSync(
        plant,
        plantedBunTestSource(
          `planted slow ${idx + 1}`,
          "  await new Promise((resolve) => setTimeout(resolve, 300));\n  expect(true).toBe(true);",
        ),
        "utf-8",
      );
    }
    try {
      const r = run([
        "--integration", "--parallel", "4", "--filter", "tZ[0-9]-slow-t05",
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
    } finally {
      for (const plant of plants) rmSync(plant, { force: true });
    }
  }, PER_TEST_TIMEOUT);

  // --- 7. Summary counts identical: serial vs --parallel 4 (integration) ---
  // .sh compared (Test files / Total assertions / Failed files / Failed
  // assertions) sorted between serial and parallel runs.
  test("summary counts identical between serial and --parallel 4 (integration)", () => {
    const plants = [1, 2, 3, 4].map((i) =>
      join(TESTS_ROOT, "integration", `tY${i}-summary-t05.test.ts`),
    );
    for (const [idx, plant] of plants.entries()) {
      writeFileSync(
        plant,
        plantedBunTestSource(
          `planted summary ${idx + 1}`,
          "  expect(true).toBe(true);",
        ),
        "utf-8",
      );
    }
    try {
      const filter = "tY[0-9]-summary-t05";
      const serial = run(["--integration", "--filter", filter]);
      const parallel = run(["--integration", "--parallel", "4", "--filter", filter]);
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
    } finally {
      for (const plant of plants) rmSync(plant, { force: true });
    }
  }, PER_TEST_TIMEOUT);

  // --- 8. Failure propagation under parallelism (§6-E: the failure FIRES) ---
  // The .sh planted a real failing TAP file into a runnable test level and asserted
  // the run reports RESULT: FAIL and exits non-zero under --parallel 4. We do
  // the same — a genuine `not ok` must drive the failure; a happy path would
  // NOT be equal-or-stronger. The planted file is removed in finally.
  test("planted failure propagates under --parallel 4 (RESULT: FAIL, non-zero exit)", () => {
    const plant = join(TESTS_ROOT, "integration", "tZZ-planted-fail-t05.test.ts");
    writeFileSync(
      plant,
      plantedBunTestSource(
        "planted failure for t05 propagation test",
        "  expect(false).toBe(true);",
      ),
      "utf-8",
    );
    try {
      const r = run([
        "--integration",
        "--filter",
        "t12-state|tZZ-planted-fail-t05",
        "--parallel",
        "4",
      ]);
      // The failure event actually fired: the summary verdict flipped to FAIL
      // with a non-zero exit (run-tests.sh:818).
      expect(r.out.split("\n").some((l) => l.startsWith("RESULT: FAIL"))).toBe(
        true,
      );
      expect(r.status).not.toBe(0);
    } finally {
      rmSync(plant, { force: true });
    }
  }, PER_TEST_TIMEOUT);

  // --- MR8. Legacy t*.sh files are no longer discovered --------------------
  // The runner is still a bash script, but the test suite it dispatches is now
  // all Bun. A planted failing shell TAP file must be invisible to discovery.
  test("legacy t*.sh files are ignored by level discovery", () => {
    const plant = join(TESTS_ROOT, "integration", "tZZ-ignored-shell-t05.sh");
    writeFileSync(
      plant,
      [
        "#!/bin/bash",
        "echo '1..1'",
        "echo 'not ok 1 - this shell file should not run'",
        "exit 1",
        "",
      ].join("\n"),
      "utf-8",
    );
    try {
      const r = run(["--integration", "--filter", "tZZ-ignored-shell-t05"]);
      expect(r.status).toBe(0);
      expect(r.out).toContain("Test files: 0");
      expect(r.out).toContain("RESULT: PASS");
      expect(r.out).not.toContain("this shell file should not run");
    } finally {
      rmSync(plant, { force: true });
    }
  }, PER_TEST_TIMEOUT);

  test("retired shell harness files are gone except runner allowlist", () => {
    expect(shellFilesUnder(TESTS_ROOT)).toEqual([
      "tests/harness/windows/sync.sh",
      "tests/run-tests.sh",
    ]);
  }, PER_TEST_TIMEOUT);

  // --- 9. --e2e dispatches; banner printed --------------------------------
  // The e2e level registers and prints its label (run-tests.sh:689).
  // Scoped to t01-helpers for speed; the .sh's test 8 already declares the
  // count "no longer pinned — assert > 0", so a 1-file filter is faithful.
  test("--e2e dispatches; banner printed", () => {
    const r = run(["--e2e", "--parallel", "4", "--filter", "t01-helpers"]);
    expect(
      r.out.split("\n").some((l) => l.startsWith("## E2E Tests")),
    ).toBe(true);
  }, PER_TEST_TIMEOUT);

  // --- 10. --e2e reports a positive test-file count ------------------------
  test("--e2e reports >0 test files", () => {
    const r = run(["--e2e", "--parallel", "4", "--filter", "t01-helpers"]);
    const line =
      r.out.split("\n").find((l) => /^Test files: \d+$/.test(l)) ?? "";
    const m = line.match(/^Test files: (\d+)$/);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(0);
  }, PER_TEST_TIMEOUT);

  // --- 11. --ci profile dispatches the integration level -------------------
  // run-tests.sh:81 — --ci enables RUN_INTEGRATION=true, so the integration
  // banner appears under --ci with a matching filter.
  test("--ci dispatches the integration level", () => {
    const r = run(["--ci", "--filter", "t12-state-fixture-validation"]);
    expect(
      r.out.split("\n").some((l) => l.startsWith("## Integration Tests")),
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

  test("--all --debug defaults live TUI coverage unless AIDLC_TUI_LIVE is explicit", () => {
    const defaulted = run(
      ["--all", "--debug", "--filter", "t01-helpers"],
      { AIDLC_TUI_LIVE: undefined },
    );
    expect(defaulted.status).toBe(0);
    expect(defaulted.out).toContain("Live TUI coverage: AIDLC_TUI_LIVE=1 (defaulted");

    const explicitOff = run(
      ["--all", "--debug", "--filter", "NO_SUCH_T05_TEST"],
      { AIDLC_TUI_LIVE: "0" },
    );
    expect(explicitOff.status).toBe(0);
    expect(explicitOff.out).toContain("Live TUI coverage: AIDLC_TUI_LIVE=0 (explicit");

    const noLlm = run(
      ["--all", "--debug", "--no-llm", "--filter", "NO_SUCH_T05_TEST"],
      { AIDLC_TUI_LIVE: undefined },
    );
    expect(noLlm.status).toBe(0);
    expect(noLlm.out).toContain("Live TUI coverage: AIDLC_TUI_LIVE=0 (explicit");
    expect(noLlm.out).not.toContain("AIDLC_TUI_LIVE=1 (defaulted");
  }, PER_TEST_TIMEOUT);

  // --- --no-llm closes every live-model gate --------------------------------
  // The derived Claude gate skips Claude-dependent files while deterministic
  // siblings run. Independent harness live gates are forced to 0 below.
  const NO_LLM_FILTER = "t141-enterprise-scope-routing|t12-state-fixture-validation";
  const NO_LLM_LIVE = "t141-enterprise-scope-routing.test.ts";
  const NO_LLM_DETERMINISTIC = "t12-state-fixture-validation.test.ts";

  test("--no-llm skips claude-required integration files while deterministic ones run", () => {
    const r = run(["--integration", "--no-llm", "--filter", NO_LLM_FILTER]);
    // The gate-closed banner is emitted.
    expect(r.out).toContain("--no-llm: forcing all live-model gates closed");
    // The claude-required file is SKIPPED (per-file SKIP done marker).
    expect(r.out).toContain(`=== DONE ${NO_LLM_LIVE} (SKIP) ===`);
    // The deterministic file actually RAN (its START marker fired and it did not
    // take the SKIP path).
    expect(r.out).toContain(`=== START ${NO_LLM_DETERMINISTIC} ===`);
    expect(r.out).not.toContain(`=== DONE ${NO_LLM_DETERMINISTIC} (SKIP) ===`);
    // A gate-closed run over deterministic content still passes and exits 0.
    expect(r.status).toBe(0);
    expect(r.out.split("\n").some((l) => l.startsWith("RESULT: PASS"))).toBe(true);
  }, PER_TEST_TIMEOUT);

  test("AIDLC_NO_LLM=1 forces the Claude gate closed like --no-llm", () => {
    const r = run(["--integration", "--filter", NO_LLM_FILTER], {
      AIDLC_NO_LLM: "1",
    });
    expect(r.out).toContain("--no-llm: forcing all live-model gates closed");
    expect(r.out).toContain(`=== DONE ${NO_LLM_LIVE} (SKIP) ===`);
    expect(r.out).toContain(`=== START ${NO_LLM_DETERMINISTIC} ===`);
    expect(r.status).toBe(0);
  }, PER_TEST_TIMEOUT);

  test("--no-llm closes every live-model environment gate", () => {
    const plant = join(TESTS_ROOT, "integration", "tZZ-no-llm-gates-t05.test.ts");
    const gates = [
      "AIDLC_TUI_LIVE",
      "AIDLC_KIRO_ACP_LIVE",
      "AIDLC_KIRO_TUI_LIVE",
      "AIDLC_CODEX_EXEC_LIVE",
      "AIDLC_KIRO_IDE_LIVE",
      "AIDLC_OPENCODE_RUN_LIVE",
    ];
    writeFileSync(
      plant,
      plantedBunTestSource(
        "all live-model gates are forced closed",
        [
          `  const gates = ${JSON.stringify(gates)};`,
          '  for (const gate of gates) expect(process.env[gate]).toBe("0");',
        ].join("\n"),
      ),
      "utf8",
    );
    try {
      const liveEnv = Object.fromEntries(gates.map((gate) => [gate, "1"]));
      const r = run(
        ["--integration", "--no-llm", "--filter", "tZZ-no-llm-gates-t05"],
        liveEnv,
      );
      expect(r.status).toBe(0);
      expect(r.out).toContain("=== START tZZ-no-llm-gates-t05.test.ts ===");
    } finally {
      rmSync(plant, { force: true });
    }
  }, PER_TEST_TIMEOUT);

  test("--no-llm runs the deterministic TUI substrate preflight", () => {
    const r = run(["--e2e", "--no-llm", "--filter", "t-tui-preflight"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("=== START t-tui-preflight.serial.test.ts ===");
    expect(r.out).not.toContain("=== DONE t-tui-preflight.serial.test.ts (SKIP) ===");
  }, PER_TEST_TIMEOUT);

  test("isolated git config preserves safe.directory and disables signing", () => {
    const plant = join(TESTS_ROOT, "integration", "tZZ-git-config-t05.test.ts");
    const fixtureDir = mkdtempSync(join(tmpdir(), "aidlc-t05-git-config-"));
    const inheritedGlobalConfig = join(fixtureDir, "global.gitconfig");
    const inheritedSystemConfig = join(fixtureDir, "system.gitconfig");
    const globalSafeDirectory = "/aidlc/t05-global-safe-directory";
    const systemSafeDirectory = "/aidlc/t05-system-safe-directory";
    const countSafeDirectory = "/aidlc/t05-count-safe-directory";
    const parametersSafeDirectory = "/aidlc/t05-parameters-safe-directory";
    writeFileSync(
      inheritedGlobalConfig,
      [
        "[safe]",
        `\tdirectory = ${globalSafeDirectory}`,
        "[commit]",
        "\tgpgsign = true",
        "[tag]",
        "\tgpgsign = true",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      inheritedSystemConfig,
      ["[safe]", `\tdirectory = ${systemSafeDirectory}`, ""].join("\n"),
      "utf8",
    );
    writeFileSync(
      plant,
      [
        'import { expect, test } from "bun:test";',
        'import { spawnSync } from "node:child_process";',
        'import { tmpdir } from "node:os";',
        "",
        'function config(...args: string[]): string {',
        '  const result = spawnSync("git", ["config", ...args], { cwd: tmpdir(), encoding: "utf8" });',
        "  expect(result.status).toBe(0);",
        '  return (result.stdout ?? "").trim();',
        "}",
        "",
        'test("git config is isolated without losing protected safety entries", () => {',
        '  const safeDirectories = config("--get-all", "safe.directory").split(/\\r?\\n/);',
        `  expect(safeDirectories).toContain(${JSON.stringify(globalSafeDirectory)});`,
        `  expect(safeDirectories).toContain(${JSON.stringify(systemSafeDirectory)});`,
        `  expect(safeDirectories).toContain(${JSON.stringify(countSafeDirectory)});`,
        `  expect(safeDirectories).toContain(${JSON.stringify(parametersSafeDirectory)});`,
        '  expect(config("--get", "commit.gpgsign")).toBe("false");',
        '  expect(config("--get", "tag.gpgsign")).toBe("false");',
        '  expect(process.env.GIT_CONFIG_GLOBAL).not.toBe("/dev/null");',
        '  expect(process.env.GIT_CONFIG_GLOBAL).not.toBe("NUL");',
        '  expect(process.env.GIT_CONFIG_GLOBAL).toMatch(/\\.gitconfig-aidlc-tests-[0-9]+$/);',
        "  expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();",
        "  expect(process.env.GIT_CONFIG_PARAMETERS).toBeUndefined();",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      const r = run(
        ["--integration", "--filter", "tZZ-git-config-t05"],
        {
          GIT_CONFIG_GLOBAL: inheritedGlobalConfig,
          GIT_CONFIG_SYSTEM: inheritedSystemConfig,
          GIT_CONFIG_COUNT: "3",
          GIT_CONFIG_KEY_0: "safe.directory",
          GIT_CONFIG_VALUE_0: countSafeDirectory,
          GIT_CONFIG_KEY_1: "commit.gpgsign",
          GIT_CONFIG_VALUE_1: "true",
          GIT_CONFIG_KEY_2: "tag.gpgsign",
          GIT_CONFIG_VALUE_2: "true",
          GIT_CONFIG_PARAMETERS:
            `'safe.directory'='${parametersSafeDirectory}' ` +
            "'commit.gpgsign'='true'",
        },
      );
      expect(r.status).toBe(0);
      expect(r.out).toContain("=== START tZZ-git-config-t05.test.ts ===");
    } finally {
      rmSync(plant, { force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, PER_TEST_TIMEOUT);
});
