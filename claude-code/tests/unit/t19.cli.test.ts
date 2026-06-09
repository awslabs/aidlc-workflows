// covers: subcommand:aidlc-jump:resolve, subcommand:aidlc-jump:execute
//
// CLI-contract port of tests/unit/t19-tool-jump.sh (TAP plan 16),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-jump.ts resolve|execute ...` (plus the two
// `bun aidlc-state.ts get ...` reads the .sh used at cases 9 and 12) is
// preserved by SPAWNING the real CLI via node:child_process spawnSync
// (BUN + the tool .ts path), asserting on res.status / res.stdout /
// res.stderr exactly as the .sh asserted on $?/stdout, plus on the
// aidlc-state.md + audit.md the tool writes — the PROCESS boundary, not
// in-process handleResolve/handleExecute calls. An in-process twin would
// lose the process.exit(1) shell that the .sh's `|| true` SKIP-rejection
// case (Test 5) and the JSON-ack-to-stdout half rely on, and would not
// exercise the real `bun aidlc-state.ts get` round-trip the .sh used to
// observe Current Stage / Completed (cases 9, 12).
//
// SUBCOMMAND UNITS: this .cli file credits BOTH subcommand units the .sh
// exercises — `aidlc-jump resolve` (covers KEY subcommand:aidlc-jump:resolve,
// .sh cases 1-6) and `aidlc-jump execute` (covers KEY
// subcommand:aidlc-jump:execute, .sh cases 7-14). The tool's only two
// subcommands; both are fired here.
//
// PARITY NOTES (every .sh `ok` line maps to an expect() below; several are
// STRONGER than the original grep/assert_contains):
//   - .sh Test 1  resolve --stage code-generation -> '"direction":"forward"'
//       -> Test 1: stdout contains '"direction":"forward"' (same observable)
//       PLUS JSON.parse(stdout).direction === "forward" + valid:true
//       (STRONGER: structured field, not a substring).
//   - .sh Test 2  resolve --stage feasibility (from state-jumped, current
//       code-generation) -> '"direction":"backward"' -> Test 2: same +
//       parsed .direction === "backward" (STRONGER).
//   - .sh Test 3  resolve --stage feasibility (from state-mid-ideation,
//       current feasibility) -> '"direction":"redo"' -> Test 3: same +
//       parsed .direction === "redo" (STRONGER).
//   - .sh Test 4  resolve --phase construction -> '"target_slug":
//       "functional-design"' -> Test 4: same + parsed .target_slug ===
//       "functional-design" (STRONGER: pins the first-in-scope-of-phase
//       resolution exactly).
//   - .sh Test 5  resolve --stage intent-capture --scope bugfix (SKIP) ||
//       true -> "skipped for scope" -> Test 5: res.status === 1 (the .sh
//       swallowed $? with `|| true`; we PIN the non-zero exit, STRONGER) +
//       stderr/out contains "skipped for scope".
//   - .sh Test 6  resolve --stage code-generation -> "affected_stages"
//       -> Test 6: stdout contains "affected_stages" + parsed
//       Array.isArray(.affected_stages) && length > 0 (STRONGER: the forward
//       jump from intent-capture to code-generation has real in-scope
//       intermediates, so the array is non-empty, not just present).
//   - .sh Test 7  execute forward -> grep '\[S\] scope-definition'
//       -> Test 7: state-file checkbox line `- [S] scope-definition` present
//       (same observable) + STAGE_SKIPPED audit row for scope-definition
//       (STRONGER addition: the [S] transition emits one STAGE_SKIPPED).
//   - .sh Test 8  execute forward -> grep '\[x\] intent-capture'
//       -> Test 8: `- [x] intent-capture` preserved (same observable).
//   - .sh Test 9  execute forward; state get "Current Stage" == code-generation
//       -> Test 9: spawn `aidlc-state.ts get "Current Stage"` -> stdout trim
//       === "code-generation" (same observable, real CLI round-trip) +
//       exit 0 (STRONGER).
//   - .sh Test 10 execute forward -> grep "STAGE_JUMPED" in audit.md
//       -> Test 10: auditEventCount(STAGE_JUMPED) === 1 (STRONGER: exact
//       count against the seeded baseline, which has no STAGE_JUMPED) +
//       block-scoped Direction === "FORWARD", Target === "code-generation".
//   - .sh Test 11 execute backward -> grep '\[-\] feasibility' AND
//       '\[ \] code-generation' (2 asserts) -> Test 11 (split into 11a/11b
//       to keep one observable per case): `- [-] feasibility` present;
//       `- [ ] code-generation` present (same observables).
//   - .sh Test 12 execute backward; state get "Completed" == 5
//       -> Test 12: spawn `aidlc-state.ts get "Completed"` -> stdout trim
//       === "5" (same observable) + exit 0 (STRONGER).
//   - .sh Test 13 execute redo -> grep '\[-\] feasibility' AND
//       '\[ \] scope-definition' (2 asserts) -> Test 13 (split into 13a/13b):
//       `- [-] feasibility` present; `- [ ] scope-definition` untouched
//       (same observables).
//   - .sh Test 14 execute forward -> '"state_updated":true'
//       -> Test 14: stdout contains '"state_updated":true' (same observable)
//       + parsed .state_updated === true (STRONGER).
//
// 16 .sh `ok` lines -> 16 expect()-bearing test() cases here (Test 11 and
// Test 13 each carry two `ok` lines in the .sh — one assert_grep per line —
// and split into 11a/11b and 13a/13b to keep one observable per case;
// counting the split halves the file has 16 test() cases total, matching
// the .sh's 16 assertions exactly).
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_state_file
// + cleanup_test_project per case): each case uses a FRESH temp project dir
// (createTestProject, which toPortablePath-converts on Windows so the
// aidlc-state.md / audit.md the tool writes — via toPosix path helpers —
// round-trip when read back). State is seeded from the SAME on-disk fixtures
// the .sh used (FIXTURES_DIR/state-*.md) via seedStateFile, so checkbox
// baselines are byte-identical to the bash run. No audit seed is needed: the
// tool creates audit.md on first emit, and STAGE_JUMPED is the only event the
// assertions count, so a fresh (absent) audit.md yields an unambiguous
// post-fire count of 1. All temp dirs cleaned in afterAll. NOTHING is written
// under tests/fixtures/**.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-jump.ts");
const STATE_TOOL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-state.ts",
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** Fresh project seeded from a FIXTURES_DIR state fixture (create_test_project + seed_state_file). */
function proj(stateFixture: string): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedStateFile(p, stateFixture);
  return p;
}

const statePath = (p: string): string => join(p, "aidlc-docs", "aidlc-state.md");
const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/** Spawn `bun aidlc-jump.ts <args...> --project-dir <p>`. Mirrors `bun "$TOOL" ...`. */
function jump(args: string[], p: string): CliResult {
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

/** Spawn `bun aidlc-state.ts get <field> --project-dir <p>`. Mirrors `bun "$STATE_TOOL" get ...`. */
function stateGet(field: string, p: string): CliResult {
  const res = spawnSync(BUN, [STATE_TOOL, "get", field, "--project-dir", p], {
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/** Read the aidlc-state.md the tool wrote. */
function readState(p: string): string {
  return readFileSync(statePath(p), "utf-8");
}

/** Count audit blocks with `**Event**: <ev>` (mirrors the .sh's STAGE_JUMPED grep, as an exact count). */
function auditEventCount(file: string, ev: string): number {
  if (!existsSync(file)) return 0;
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Block-scoped: resets at `## ` headings and `---` separators; splits
 * `**label**: value` on the literal `**: ` separator. Mirrors auditField in
 * t31.cli.test.ts. Returns "" when absent.
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

// ============================================================
// resolve subcommand (covers: subcommand:aidlc-jump:resolve)
// .sh cases 1-6
// ============================================================

describe("t19 aidlc-jump resolve (migrated from t19-tool-jump.sh, plan 16)", () => {
  test("1: resolve detects forward direction", () => {
    const p = proj("state-mid-ideation.md");
    const r = jump(
      ["resolve", "--stage", "code-generation", "--scope", "feature"],
      p,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"direction":"forward"');
    const parsed = JSON.parse(r.stdout);
    expect(parsed.direction).toBe("forward"); // STRONGER: structured field
    expect(parsed.valid).toBe(true);
  });

  test("2: resolve detects backward direction", () => {
    const p = proj("state-jumped.md");
    const r = jump(
      ["resolve", "--stage", "feasibility", "--scope", "feature"],
      p,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"direction":"backward"');
    expect(JSON.parse(r.stdout).direction).toBe("backward"); // STRONGER
  });

  test("3: resolve detects redo direction", () => {
    const p = proj("state-mid-ideation.md");
    const r = jump(
      ["resolve", "--stage", "feasibility", "--scope", "feature"],
      p,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"direction":"redo"');
    expect(JSON.parse(r.stdout).direction).toBe("redo"); // STRONGER
  });

  test("4: resolve phase construction -> functional-design", () => {
    const p = proj("state-initialization-done.md");
    const r = jump(
      ["resolve", "--phase", "construction", "--scope", "feature"],
      p,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"target_slug":"functional-design"');
    expect(JSON.parse(r.stdout).target_slug).toBe("functional-design"); // STRONGER
  });

  test("5: resolve rejects SKIP stage", () => {
    const p = proj("state-initialization-done.md");
    // intent-capture is SKIP for scope bugfix. The .sh swallowed $? with
    // `|| true`; we PIN the non-zero exit (STRONGER) AND the message.
    const r = jump(
      ["resolve", "--stage", "intent-capture", "--scope", "bugfix"],
      p,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("skipped for scope");
  });

  test("6: resolve returns affected stages", () => {
    const p = proj("state-initialization-done.md");
    const r = jump(
      ["resolve", "--stage", "code-generation", "--scope", "feature"],
      p,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("affected_stages");
    const affected = JSON.parse(r.stdout).affected_stages;
    expect(Array.isArray(affected)).toBe(true);
    // Forward jump from intent-capture (current in this fixture) to
    // code-generation has real in-scope intermediates -> non-empty (STRONGER).
    expect(affected.length).toBeGreaterThan(0);
  });
});

// ============================================================
// execute subcommand (covers: subcommand:aidlc-jump:execute)
// .sh cases 7-14
// ============================================================

describe("t19 aidlc-jump execute (migrated from t19-tool-jump.sh, plan 16)", () => {
  test("7: forward marks intermediate [S]", () => {
    const p = proj("state-mid-ideation.md");
    const r = jump(
      [
        "execute",
        "--target",
        "code-generation",
        "--direction",
        "forward",
        "--scope",
        "feature",
      ],
      p,
    );
    expect(r.status).toBe(0);
    // Mirrors assert_grep '\[S\] scope-definition'.
    expect(readState(p)).toContain("- [S] scope-definition");
    // STRONGER: the [S] transition emits one STAGE_SKIPPED for that slug.
    expect(auditField(auditPath(p), "STAGE_SKIPPED", "Stage")).toBe(
      "scope-definition",
    );
  });

  test("8: forward preserves [x] stages", () => {
    const p = proj("state-mid-ideation.md");
    jump(
      [
        "execute",
        "--target",
        "code-generation",
        "--direction",
        "forward",
        "--scope",
        "feature",
      ],
      p,
    );
    // Mirrors assert_grep '\[x\] intent-capture'.
    expect(readState(p)).toContain("- [x] intent-capture");
  });

  test("9: forward updates Current Stage", () => {
    const p = proj("state-mid-ideation.md");
    jump(
      [
        "execute",
        "--target",
        "code-generation",
        "--direction",
        "forward",
        "--scope",
        "feature",
      ],
      p,
    );
    // Mirrors `ACTUAL=$(bun "$STATE_TOOL" get "Current Stage" ...)` -> assert_eq.
    const r = stateGet("Current Stage", p);
    expect(r.status).toBe(0); // STRONGER: the .sh ignored $?
    expect(r.stdout.trim()).toBe("code-generation");
  });

  test("10: forward appends STAGE_JUMPED audit", () => {
    const p = proj("state-mid-ideation.md");
    jump(
      [
        "execute",
        "--target",
        "code-generation",
        "--direction",
        "forward",
        "--scope",
        "feature",
      ],
      p,
    );
    // Mirrors assert_grep "STAGE_JUMPED". STRONGER: exact count against the
    // fresh (no STAGE_JUMPED) baseline + block-scoped field values.
    const a = auditPath(p);
    expect(auditEventCount(a, "STAGE_JUMPED")).toBe(1);
    expect(auditField(a, "STAGE_JUMPED", "Direction")).toBe("FORWARD");
    expect(auditField(a, "STAGE_JUMPED", "Target")).toBe("code-generation");
    expect(auditField(a, "STAGE_JUMPED", "Source")).toBe("feasibility");
  });

  test("11a: backward jump sets target to [-] active", () => {
    const p = proj("state-jumped.md");
    const r = jump(
      [
        "execute",
        "--target",
        "feasibility",
        "--direction",
        "backward",
        "--scope",
        "feature",
      ],
      p,
    );
    expect(r.status).toBe(0);
    // Mirrors assert_grep '\[-\] feasibility'.
    expect(readState(p)).toContain("- [-] feasibility");
  });

  test("11b: backward resets downstream to [ ]", () => {
    const p = proj("state-jumped.md");
    jump(
      [
        "execute",
        "--target",
        "feasibility",
        "--direction",
        "backward",
        "--scope",
        "feature",
      ],
      p,
    );
    // Mirrors assert_grep '\[ \] code-generation'.
    expect(readState(p)).toContain("- [ ] code-generation");
  });

  test("12: backward Completed count is 5 (init+2 ideation)", () => {
    const p = proj("state-jumped.md");
    jump(
      [
        "execute",
        "--target",
        "feasibility",
        "--direction",
        "backward",
        "--scope",
        "feature",
      ],
      p,
    );
    // Mirrors `ACTUAL=$(bun "$STATE_TOOL" get "Completed" ...)` -> assert_eq "5".
    const r = stateGet("Completed", p);
    expect(r.status).toBe(0); // STRONGER
    expect(r.stdout.trim()).toBe("5");
  });

  test("13a: redo marks target [-] active after reset", () => {
    const p = proj("state-mid-ideation.md");
    const r = jump(
      [
        "execute",
        "--target",
        "feasibility",
        "--direction",
        "redo",
        "--scope",
        "feature",
      ],
      p,
    );
    expect(r.status).toBe(0);
    // Mirrors assert_grep '\[-\] feasibility'.
    expect(readState(p)).toContain("- [-] feasibility");
  });

  test("13b: redo doesn't touch other stages", () => {
    const p = proj("state-mid-ideation.md");
    jump(
      [
        "execute",
        "--target",
        "feasibility",
        "--direction",
        "redo",
        "--scope",
        "feature",
      ],
      p,
    );
    // Mirrors assert_grep '\[ \] scope-definition' — scope-definition was [ ]
    // in the fixture and redo must leave it untouched.
    expect(readState(p)).toContain("- [ ] scope-definition");
  });

  test("14: execute returns state_updated:true", () => {
    const p = proj("state-mid-ideation.md");
    const r = jump(
      [
        "execute",
        "--target",
        "code-generation",
        "--direction",
        "forward",
        "--scope",
        "feature",
      ],
      p,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"state_updated":true');
    expect(JSON.parse(r.stdout).state_updated).toBe(true); // STRONGER
  });
});
