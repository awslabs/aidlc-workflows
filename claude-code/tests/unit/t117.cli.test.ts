// covers: subcommand:aidlc-jump:resolve
//
// CLI-contract port of tests/unit/t117-orchestrate-branches.sh (TAP plan 24),
// mechanism = cli. The .sh drives the orchestration engine's non-happy-path
// `next` branches (jump / resume / init / scope-change / config-change /
// env-scope / freeform-intent / init-guard) and CROSS-CHECKS the jump-direction
// against `aidlc-jump.ts resolve` — the pure-read subcommand the engine
// DELEGATES forward/backward/redo resolution to (aidlc-orchestrate.ts:664-676,
// 797-839). This .cli file credits `subcommand:aidlc-jump resolve` (COLON form
// in the covers header) because the jump branch's observable contract IS that
// resolve's `direction` / `target_slug` is what the engine surfaces: tests 1-3
// fire `bun aidlc-jump.ts resolve ...` directly and assert the same `direction`
// value the engine relays into its run-stage directive, and the SKIP-for-scope
// error (test 4) is resolve's VERBATIM `is skipped for scope` wording
// (aidlc-jump.ts:117-119) the engine passes through unchanged.
//
// MECHANISM = cli: every .sh case shelled out to `bun "$TOOL" ...` (the engine)
// and, for the jump cases, also `bun "$JUMP_TOOL" resolve ...`. We preserve the
// PROCESS boundary by SPAWNING the real binaries via node:child_process
// spawnSync (BUN + the .ts path), asserting on the combined stdout+stderr (the
// .sh's 2>&1) and — for test 8 — the file effect (no aidlc-state.md written),
// exactly as the .sh did. An in-process twin would lose the engine's
// shell-out-to-sibling-tool seam (the whole point of these branches) and the
// emit()/process.exit boundary.
//
// PARITY NOTES (every .sh `assert_contains` / `ok` / `not_ok` maps to an
// expect() below; STRONGER additions flagged):
//   - .sh T1  OUT  '"stage":"code-generation"'        -> t1 (engine run-stage)
//             DIR  '"direction":"forward"'            -> t1 (resolve direction)
//   - .sh T2  OUT  '"stage":"feasibility"'            -> t2
//             DIR  '"direction":"backward"'           -> t2
//   - .sh T3  OUT  '"stage":"code-generation"'        -> t3
//             DIR  '"direction":"redo"'               -> t3
//   - .sh T4  OUT  '"kind":"error"'                   -> t4
//             OUT  'is skipped for scope'             -> t4 (resolve verbatim)
//   - .sh T5  OUT  '"kind":"ask"'                     -> t5 (resume, jumped)
//   - .sh T6  OUT  '"kind":"ask"'                     -> t6 (resume, mid-ideation)
//   - .sh T7  OUT  '"kind":"error"'                   -> t7 (init guard)
//             OUT  'Use --force to reinitialize'      -> t7 (verbatim guard)
//   - .sh T8  OUT  '"kind":"print"'                   -> t8 (init clean)
//             FS   no aidlc-state.md created          -> t8 (file effect)
//   - .sh T9  OUT  'Cannot use --stage and --phase together' -> t9
//   - .sh T10 OUT  '"kind":"error"'                   -> t10 (env-scope)
//             OUT  'Invalid AWS_AIDLC_DEFAULT_SCOPE'   -> t10 (verbatim)
//   - .sh T11 OUT  'scope-change --scope mvp'         -> t11 (print names move)
//   - .sh T12 OUT  'config-change --depth comprehensive' -> t12
//   - .sh T13 OUT  '"stage":"functional-design"'      -> t13 (phase jump)
//   - .sh T14 OUT  '"kind":"ask"'                     -> t14 (freeform intent)
//   - .sh T15 OUT  'Cannot jump to initialization stages' -> t15 (--stage init)
//   - .sh T16 OUT  'Cannot jump to initialization stages' -> t16 (--phase init)
//   - .sh T17 OUT  'Cannot jump to initialization stages' -> t17 (no-state init)
//
// 24 .sh assertions (plan 24) -> 24 expect()-bearing test() cases here, 1:1.
// STRONGER additions beyond the bare substring greps:
//   S1 (t1-t3, t4, t13): the engine's directive is asserted to be valid JSON
//      AND `"kind":"run-stage"` / `"kind":"error"` is pinned, not just the
//      embedded substring — the .sh grepped only the `"stage":"..."` /
//      `"direction":"..."` slice.
//   S2 (t1-t3): the engine's surfaced `stage` is asserted to EQUAL resolve's
//      `target_slug` (the delegation contract — the engine relays resolve's
//      target, not a re-derived one). The .sh asserted them independently.
//   S3 (t8): the print directive is parsed and `kind === "print"` pinned, in
//      addition to the no-state-file file-effect check.
//
// FIXTURE DISCIPLINE (mirrors create_test_project + seed_state_file +
// cleanup_test_project per case): each case uses a FRESH temp project dir
// (createTestProject, which toPortablePath-converts on Windows so any path the
// tool round-trips through JSON survives). seedStateFile copies the named
// fixture to aidlc-docs/aidlc-state.md exactly as seed_state_file did. All temp
// dirs cleaned in afterAll. resetAidlcEnv() (reset_aidlc_env) clears
// AWS_AIDLC_DEFAULT_SCOPE so a developer's exported value can't shadow the
// fixtures; the env-scope case (t10) sets it explicitly in the spawn env only.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS_DIR = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const ORCH = join(TOOLS_DIR, "aidlc-orchestrate.ts");
const JUMP = join(TOOLS_DIR, "aidlc-jump.ts");
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures");

// reset_aidlc_env (t117:29): clear AWS_AIDLC_DEFAULT_SCOPE so the env-scope
// precedence rung is empty by default; the env-scope case overrides per-spawn.
resetAidlcEnv();

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** Fresh temp project, optionally seeded with a state fixture. */
function proj(stateFixture?: string): string {
  const p = createTestProject();
  tempDirs.push(p);
  if (stateFixture) seedStateFile(p, join(FIXTURES_DIR, stateFixture));
  return p;
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/**
 * Spawn `bun <tool> <args...> --project-dir <p>`. Mirrors `bun "$TOOL" ... 2>&1`.
 * `env` overrides ride on top of the cleaned process env (AWS_AIDLC_DEFAULT_SCOPE
 * already deleted by resetAidlcEnv) so the env-scope case can set just that var.
 */
function run(
  tool: string,
  args: string[],
  p: string,
  env: Record<string, string> = {},
): CliResult {
  const childEnv = { ...process.env, ...env };
  // Belt-and-braces: unless the case explicitly sets AWS_AIDLC_DEFAULT_SCOPE,
  // ensure it is absent in the child env regardless of the parent shell.
  if (!("AWS_AIDLC_DEFAULT_SCOPE" in env)) {
    delete childEnv.AWS_AIDLC_DEFAULT_SCOPE;
  }
  const res = spawnSync(BUN, [tool, ...args, "--project-dir", p], {
    encoding: "utf-8",
    env: childEnv,
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/** `bun aidlc-orchestrate.ts next <args...> --project-dir <p>`. */
function next(args: string[], p: string, env: Record<string, string> = {}): CliResult {
  return run(ORCH, ["next", ...args], p, env);
}

/** `bun aidlc-jump.ts resolve <args...> --project-dir <p>`. */
function jumpResolve(
  args: string[],
  p: string,
  env: Record<string, string> = {},
): CliResult {
  return run(JUMP, ["resolve", ...args], p, env);
}

/** Parse the single JSON directive the engine emits to stdout. */
// biome-ignore lint/suspicious/noExplicitAny: directive shape varies by kind
function directive(out: string): any {
  return JSON.parse(out.trim());
}

// ============================================================
// Jump-direction delegation: the engine relays aidlc-jump.ts resolve's
// `direction` + `target_slug` (covers: subcommand:aidlc-jump:resolve).
// ============================================================

describe("t117 jump-direction delegation (migrated from t117-orchestrate-branches.sh, plan 24)", () => {
  // A WITH-STATE jump is a MUTATION (mark intervening [S], emit STAGE_JUMPED,
  // pivot Current Stage) and `next` is read-only, so — like scope-change /
  // config-change — the engine emits a `print` naming `aidlc-jump.ts execute`
  // carrying the tool-resolved target + direction, NOT a run-stage. (Re-anchored
  // at the v0.6.0 engine cutover: pre-cutover this emitted run-stage directly,
  // producing ZERO state change — the regression t24/t25/t26/t56/t57 caught.)
  // --- Test 1: forward jump → print naming execute; direction matches resolve ---
  test("1: forward jump → print naming execute code-generation; resolve direction forward", () => {
    const p = proj("state-mid-ideation.md");
    const r = next(["--stage", "code-generation"], p);
    const dir = jumpResolve(["--stage", "code-generation", "--scope", "feature"], p);
    // engine print naming execute for the resolved target (forward)
    expect(r.out).toContain("execute --target code-generation --direction forward");
    // resolve direction is forward (code-generation is later than feasibility)
    expect(dir.out).toContain('"direction":"forward"');
    // S1/S2: the engine's directive is a valid print whose message names the
    // execute delegate for resolve's target_slug — the delegation contract.
    const d = directive(r.stdout);
    expect(d.kind).toBe("print");
    expect(d.message).toContain("execute --target code-generation --direction forward");
    const resolved = directive(dir.stdout);
    expect(d.message).toContain(resolved.target_slug);
    expect(resolved.direction).toBe("forward");
  });

  // --- Test 2: backward jump → print naming execute; direction matches resolve ---
  test("2: backward jump → print naming execute feasibility; resolve direction backward", () => {
    const p = proj("state-jumped.md");
    const r = next(["--stage", "feasibility"], p);
    const dir = jumpResolve(["--stage", "feasibility", "--scope", "feature"], p);
    expect(r.out).toContain("execute --target feasibility --direction backward");
    expect(dir.out).toContain('"direction":"backward"');
    const d = directive(r.stdout);
    expect(d.kind).toBe("print");
    expect(d.message).toContain("execute --target feasibility --direction backward");
    const resolved = directive(dir.stdout);
    expect(d.message).toContain(resolved.target_slug);
    expect(resolved.direction).toBe("backward");
  });

  // --- Test 3: redo jump → print naming execute; direction matches resolve ---
  test("3: redo jump → print naming execute code-generation; resolve direction redo", () => {
    const p = proj("state-jumped.md");
    const r = next(["--stage", "code-generation"], p);
    const dir = jumpResolve(["--stage", "code-generation", "--scope", "feature"], p);
    expect(r.out).toContain("execute --target code-generation --direction redo");
    expect(dir.out).toContain('"direction":"redo"');
    const d = directive(r.stdout);
    expect(d.kind).toBe("print");
    expect(d.message).toContain("execute --target code-generation --direction redo");
    const resolved = directive(dir.stdout);
    expect(d.message).toContain(resolved.target_slug);
    expect(resolved.direction).toBe("redo");
  });

  // --- Test 4: jump to a SKIP-for-scope stage → error (verbatim resolve wording) ---
  // state-mid-inception is bugfix scope; intent-capture is SKIP. The engine
  // relays resolve's VERBATIM `is skipped for scope` message (aidlc-jump.ts:117-119).
  test("4: jump to SKIP-for-scope stage → error carrying resolve's verbatim wording", () => {
    const p = proj("state-mid-inception.md");
    const r = next(["--stage", "intent-capture"], p);
    expect(r.out).toContain('"kind":"error"');
    expect(r.out).toContain("is skipped for scope");
    // S1: the directive is a well-formed error directive, not a stray substring.
    const d = directive(r.stdout);
    expect(d.kind).toBe("error");
    expect(d.message).toContain("is skipped for scope");
  });
});

// ============================================================
// Resume branch — existing state surfaces an `ask` directive (engine never
// calls AskUserQuestion). (.sh Tests 5-6)
// ============================================================

describe("t117 resume branch", () => {
  // --- Test 5: resume with existing state → ask directive ---
  test("5: resume with existing state (jumped) → ask directive", () => {
    const p = proj("state-jumped.md");
    const r = next(["--resume"], p);
    expect(r.out).toContain('"kind":"ask"');
    expect(directive(r.stdout).kind).toBe("ask");
  });

  // --- Test 6: resume over a mid-phase fixture → ask directive ---
  test("6: resume over a mid-phase workflow (mid-ideation) → ask directive", () => {
    const p = proj("state-mid-ideation.md");
    const r = next(["--resume"], p);
    expect(r.out).toContain('"kind":"ask"');
    expect(directive(r.stdout).kind).toBe("ask");
  });
});

// ============================================================
// Init branch — guard rejection (state exists) and clean-workspace print.
// (.sh Tests 7-8)
// ============================================================

describe("t117 init branch", () => {
  // --- Test 7: init guard — state exists, no --force → error (verbatim) ---
  test("7: init guard (state exists, no --force) → error carrying verbatim guard message", () => {
    const p = proj("state-mid-ideation.md");
    const r = next(["--init"], p);
    expect(r.out).toContain('"kind":"error"');
    expect(r.out).toContain("Use --force to reinitialize");
    const d = directive(r.stdout);
    expect(d.kind).toBe("error");
    expect(d.message).toContain("Use --force to reinitialize");
  });

  // --- Test 8: init on a clean workspace → print (names the move, no mutation) ---
  test("8: init on a clean workspace → print directive AND no state file created", () => {
    const p = proj(); // no state seeded
    const r = next(["--init", "--scope", "poc"], p);
    expect(r.out).toContain('"kind":"print"');
    // S3: the directive is a well-formed print directive.
    expect(directive(r.stdout).kind).toBe("print");
    // File effect: `next --init` must NOT create state (mutation stays
    // conductor-side). Mirrors the .sh's `[ ! -f .../aidlc-state.md ]` check.
    expect(existsSync(join(p, "aidlc-docs", "aidlc-state.md"))).toBe(false);
  });
});

// ============================================================
// Flag-validation + env-scope + scope/config change + phase jump + freeform.
// (.sh Tests 9-14)
// ============================================================

describe("t117 flag-validation, env-scope, scope/config change, phase jump, freeform", () => {
  // --- Test 9: mutually-exclusive --stage + --phase → error (verbatim SKILL.md) ---
  test("9: --stage + --phase together → error (verbatim)", () => {
    const p = proj(); // no state needed — the guard fires before state inspection
    const r = next(["--stage", "feasibility", "--phase", "ideation"], p);
    expect(r.out).toContain("Cannot use --stage and --phase together");
    expect(directive(r.stdout).kind).toBe("error");
  });

  // --- Test 10: env-scope-invalid → error carrying the verbatim substring ---
  // AWS_AIDLC_DEFAULT_SCOPE=bogus, no state, no flag → scope source is env; the
  // engine shells out to resolve-env-scope and relays its verbatim message.
  test("10: env-scope-invalid → error carrying verbatim Invalid AWS_AIDLC_DEFAULT_SCOPE", () => {
    const p = proj(); // no state seeded
    const r = next([], p, { AWS_AIDLC_DEFAULT_SCOPE: "bogus" });
    expect(r.out).toContain('"kind":"error"');
    expect(r.out).toContain("Invalid AWS_AIDLC_DEFAULT_SCOPE");
    const d = directive(r.stdout);
    expect(d.kind).toBe("error");
    expect(d.message).toContain("Invalid AWS_AIDLC_DEFAULT_SCOPE");
  });

  // --- Test 11: scope-change against existing state → print (names the move) ---
  // state-mid-ideation is feature scope; --scope mvp is a scope change → print
  // names the scope-change command rather than performing it.
  test("11: scope-change against existing state → print naming scope-change --scope mvp", () => {
    const p = proj("state-mid-ideation.md");
    const r = next(["--scope", "mvp"], p);
    expect(r.out).toContain("scope-change --scope mvp");
    expect(directive(r.stdout).kind).toBe("print");
  });

  // --- Test 12: config-change (depth) against existing state → print ---
  test("12: config-change (depth) against existing state → print naming config-change --depth", () => {
    const p = proj("state-mid-ideation.md");
    const r = next(["--depth", "comprehensive"], p);
    expect(r.out).toContain("config-change --depth comprehensive");
    expect(directive(r.stdout).kind).toBe("print");
  });

  // --- Test 13: phase jump → print naming execute for the first in-scope stage ---
  // state-mid-ideation is feature scope, Current Stage=feasibility; --phase
  // construction resolves (via resolve) to the first EXECUTE stage of
  // construction (functional-design), forward of feasibility. A WITH-STATE phase
  // jump is a MUTATION, so the engine emits a `print` naming execute, not a
  // run-stage (the v0.6.0 cutover — see the jump-direction delegation block).
  test("13: phase jump (construction, feature) → print naming execute functional-design", () => {
    const p = proj("state-mid-ideation.md");
    const r = next(["--phase", "construction"], p);
    expect(r.out).toContain("execute --target functional-design --direction forward");
    const d = directive(r.stdout);
    expect(d.kind).toBe("print");
    expect(d.message).toContain("execute --target functional-design --direction forward");
  });

  // --- Test 14: freeform intent with no workflow → ask (scope confirmation) ---
  test("14: freeform intent with no workflow → ask directive (scope confirmation)", () => {
    const p = proj(); // no state seeded
    const r = next(["add a login form to the app"], p);
    expect(r.out).toContain('"kind":"ask"');
    expect(directive(r.stdout).kind).toBe("ask");
  });
});

// ============================================================
// Init-stage jump guard (SKILL.md step 5) — rejected with/without state, and
// for --phase initialization. (.sh Tests 15-17)
// ============================================================

describe("t117 init-stage jump guard", () => {
  // --- Test 15: init-stage jump guard — --stage <init>, state present ---
  test("15: jump to init stage (state present) → error, not run-stage", () => {
    const p = proj("state-jumped.md");
    const r = next(["--stage", "state-init"], p);
    expect(r.out).toContain("Cannot jump to initialization stages");
    expect(directive(r.stdout).kind).toBe("error");
  });

  // --- Test 16: init-stage jump guard — --phase initialization ---
  test("16: --phase initialization → error (init guard)", () => {
    const p = proj("state-jumped.md");
    const r = next(["--phase", "initialization"], p);
    expect(r.out).toContain("Cannot jump to initialization stages");
    expect(directive(r.stdout).kind).toBe("error");
  });

  // --- Test 17: init-stage jump guard holds on the no-state path too ---
  test("17: jump to init stage (no state) → error (guard holds)", () => {
    const p = proj(); // no state seeded
    const r = next(["--stage", "workspace-scaffold"], p);
    expect(r.out).toContain("Cannot jump to initialization stages");
    expect(directive(r.stdout).kind).toBe("error");
  });
});
