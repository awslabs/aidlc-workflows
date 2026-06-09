// covers: subcommand:aidlc-validate:outputs
//
// CLI-contract port of tests/feature/t45-stage-output-validation.sh (TAP
// plan 10), mechanism = cli. Equal-or-stronger migration: every .sh
// assertion that shelled out to `bun aidlc-validate.ts outputs <phase>`
// (then re-parsed the captured stdout with a second `bun -e` JSON.parse)
// is preserved by SPAWNING the real CLI via node:child_process spawnSync
// (BUN + the tool .ts path) and asserting on res.status and on the JSON
// the tool writes to stdout. The contract under test is the PROCESS
// boundary (exit code) plus the materialised result object — so it stays
// a spawn. An in-process handleOutputs() twin would lose the exit-code
// half (handleOutputs/jsonSuccess write to process.stdout and the unknown-
// phase arm is process.exit(1) via jsonError, aidlc-validate.ts:271-278)
// AND the JSON-to-stdout half the .sh's `bun -e 'JSON.parse(...)'` relies
// on for every phase.
//
// NO FIXTURE / NO PROJECT DIR: aidlc-validate `outputs` reads the SHIPPED
// stage files under dist/claude/.claude/skills/aidlc/stages/<phase>/
// (STAGES_DIR, aidlc-validate.ts:27-33) and the stage graph via
// loadStageGraph(); it writes nothing, emits no audit row, and needs no
// CLAUDE_PROJECT_DIR. So — unlike t31/t90 — there is no createTestProject /
// seedAuditFile / temp dir to manage and nothing under tests/fixtures/** is
// touched. The .sh likewise passed no project dir.
//
// PARITY NOTES (the .sh's `for phase in initialization ideation inception
// construction operation` loop emits TWO `ok` lines per phase = 10 asserts;
// each maps to an expect()-bearing test() below; several are STRONGER than
// the original):
//   - .sh Test 1 (per phase) RC==0 "$phase output validation completed"
//       -> "<phase>: tool exits 0": expect(r.status).toBe(0) — same
//       observable (the .sh's `RC=$?` intent under `set -e`).
//   - .sh Test 2 (per phase) d.pass==="true" "all declared outputs
//       referenced in steps" -> "<phase>: pass===true": parse the JSON the
//       tool wrote and expect(d.pass).toBe(true) — same observable, asserted
//       against the real boolean rather than its "true"/"false" string
//       projection. STRONGER additions on the same parse:
//         * d.phase === <phase> (response is for the requested phase),
//         * d.stages is a non-empty array, AND
//         * every stage's own .pass is true with .missing empty — i.e. the
//           per-stage rows that DRIVE the phase-level pass (pass = stages
//           .every(s=>s.pass), aidlc-validate.ts:254). The .sh only checked
//           the aggregate; on failure it printed the per-stage `missing`
//           list, so asserting the per-stage rows mirrors the diagnostic it
//           would have surfaced.
//
// STRONGER NEGATIVE COVER (no .sh counterpart — exercises the jsonError /
// process.exit(1) arm the in-process note above flags as the reason this
// stays a spawn):
//   - "unknown phase -> exit 1 + error JSON on stderr" pins the
//     handleOutputs `!phases` branch (aidlc-validate.ts:192-194).
//   - "all -> aggregate pass + phases[] of 5" pins the phaseArg==="all"
//     branch (aidlc-validate.ts:259-261), the other half of handleOutputs
//     the per-phase loop never reaches.
//
// 10 .sh asserts -> 10 expect()-bearing test() cases here (5 exit-code + 5
// pass), plus 2 STRONGER cases (unknown-phase, all-aggregate).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const VALIDATE = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-validate.ts",
);

// PHASES, in the order aidlc-lib.ts:68-74 declares them — the same five the
// .sh loops over (`for phase in initialization ideation inception
// construction operation`).
const PHASES = [
  "initialization",
  "ideation",
  "inception",
  "construction",
  "operation",
] as const;

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface StageResult {
  slug: string;
  outputs: number;
  missing: string[];
  pass: boolean;
}

interface PhaseResult {
  phase: string;
  stages: StageResult[];
  pass: boolean;
}

/** Spawn `bun aidlc-validate.ts outputs <phase>`. Mirrors `"$BUN" "$VALIDATE" outputs "$phase" 2>&1`. */
function runOutputs(phase: string): CliResult {
  const res = spawnSync(BUN, [VALIDATE, "outputs", phase], {
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe("t45 aidlc-validate outputs — CLI contract (migrated from t45-stage-output-validation.sh, plan 10)", () => {
  for (const phase of PHASES) {
    // .sh Test 1 per phase: RC == 0.
    test(`${phase}: output validation completed (exit 0)`, () => {
      const r = runOutputs(phase);
      expect(r.status).toBe(0);
    });

    // .sh Test 2 per phase: d.pass === true (+ STRONGER per-stage / shape).
    test(`${phase}: all declared outputs referenced in steps (pass===true)`, () => {
      const r = runOutputs(phase);
      const d = JSON.parse(r.stdout) as PhaseResult;
      // The .sh's `d.pass ? "true" : "false"` aggregate, asserted directly.
      expect(d.pass).toBe(true);
      // STRONGER: the response is for the requested phase and is non-empty.
      expect(d.phase).toBe(phase);
      expect(Array.isArray(d.stages)).toBe(true);
      expect(d.stages.length).toBeGreaterThan(0);
      // STRONGER: every per-stage row that drives the aggregate passes with
      // no missing outputs (the .sh printed these on failure; here we assert
      // them on success). Surfaces the offending slug + missing list in the
      // failure message, mirroring the .sh's diagnostic.
      for (const s of d.stages) {
        expect(`${s.slug}: ${s.missing.join(", ")}`).toBe(`${s.slug}: `);
        expect(s.pass).toBe(true);
      }
    });
  }

  // STRONGER negative cover: the jsonError / process.exit(1) arm (the reason
  // this port stays a spawn). No .sh counterpart.
  test("unknown phase -> exit 1 + error JSON on stderr", () => {
    const r = runOutputs("bogusphase");
    expect(r.status).toBe(1);
    const err = JSON.parse(r.stderr) as { error: string };
    expect(err.error).toContain("Unknown phase: bogusphase");
  });

  // STRONGER: the phaseArg === "all" aggregate branch (aidlc-validate.ts:
  // 259-261) — the per-phase loop above never exercises the `{ phases, pass }`
  // shape. All five phases pass today, so the aggregate is true and the
  // phases[] holds exactly five PhaseResult rows in PHASES order.
  test("all -> aggregate pass===true + phases[] of 5 in order", () => {
    const r = runOutputs("all");
    expect(r.status).toBe(0);
    const d = JSON.parse(r.stdout) as { phases: PhaseResult[]; pass: boolean };
    expect(d.pass).toBe(true);
    expect(d.phases).toHaveLength(PHASES.length);
    expect(d.phases.map((p) => p.phase)).toEqual([...PHASES]);
    for (const p of d.phases) {
      expect(p.pass).toBe(true);
    }
  });
});
