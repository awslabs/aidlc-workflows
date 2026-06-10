// covers: subcommand:aidlc-orchestrate:next, file:skills/aidlc/SKILL.md
//
// bun:test port of tests/unit/t114-orchestrate-next.sh (TAP plan 27),
// mechanism = cli. Faithful, equal-or-stronger migration of the
// aidlc-orchestrate.ts `next` CLI-contract test.
//
// SUBJECT: `next` is the read-only orchestration engine handler
// (aidlc-orchestrate.ts:785 handleNext). It reads workflow state + the compiled
// stage graph and emits EXACTLY ONE validated directive (JSON) to stdout via
// `console.log(JSON.stringify(...))` (:147), mutating no workflow state. The
// table drives it over the existing state fixtures and asserts (state + args) →
// directive kind + key fields, the flag-precedence ladder (state > flag > env >
// default), read-only dispatch (--status/--version → print), the
// mutually-exclusive --stage+--phase guard, scope resolution, and the
// regression guards for the SKILL.md cutover. Unit tier — no LLM, no model.
//
// SPAWN (not in-process): the whole contract is the argv-dispatch / process
// boundary of aidlc-orchestrate.ts. `handleNext` is NOT exported (internal,
// reached only through `main()` at :1965 via the `next` case at :1984). The
// directive lands on stdout through `console.log`; errors land through the
// composed sibling tools the non-happy-path branches shell out to
// (aidlc-jump.ts resolve/execute, aidlc-utility.ts resolve-env-scope /
// enable-test-run / init — none importable, all spawned). An in-process twin
// would forfeit both the stdout-JSON seam AND the real-tool composition the
// branches depend on. So all `next` invocations stay spawns. Mirrors the .sh's
// `bun "$TOOL" next ... 2>&1`.
//
// One structural guarantee (test 14, half a) is a file-content check on the
// shipped SKILL.md, not a spawn — preserved verbatim (read the bytes, assert
// the `next --args` wrapper is absent).
//
// FIXTURE DISCIPLINE: each case builds a fresh temp project via
// createTestProject() + seedStateFile() (the .ts analogues of fixtures.sh's
// create_test_project / seed_state_file), torn down in afterEach. resetAidlcEnv()
// clears AWS_AIDLC_DEFAULT_SCOPE so a developer's exported value can't shadow the
// fixtures — exactly the .sh's top-of-file reset_aidlc_env. The env-precedence
// cases pass AWS_AIDLC_DEFAULT_SCOPE in the spawn env only (never the test
// process env). NOTHING is written under tests/fixtures/**.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh 1  in-flight current stage -> run-stage           -> "1: in-flight current stage -> run-stage directive"
//   .sh 2  run-stage names current stage (feasibility)     -> "2: run-stage names the current stage (feasibility)"
//   .sh 3  run-stage carries lead_agent off the node       -> "3: run-stage carries lead_agent from the graph node"
//   .sh 4  brownfield bugfix active stage                  -> "4: brownfield bugfix active stage -> run-stage reverse-engineering"
//   .sh 5  invalid --scope errors over valid state (x2)    -> "5: invalid --scope errors unconditionally over valid state" (kind:error + Unknown scope)
//   .sh 6  --scope flag beats env                          -> "6: --scope flag beats AWS_AIDLC_DEFAULT_SCOPE env"
//   .sh 7  env beats default                               -> "7: env scope beats default (poc resolved)"
//   .sh 8  invalid env scope -> canonical env message      -> "8: invalid env scope -> verbatim AWS_AIDLC_DEFAULT_SCOPE error"
//   .sh 9  --status -> print                               -> "9: --status -> print directive (read-only dispatch)"
//   .sh 10 --version -> print                              -> "10: --version -> print directive (terminal read-only)"
//   .sh 11 --stage+--phase -> error                        -> "11: mutually-exclusive --stage+--phase -> error directive"
//   .sh 12 with-state --phase jump -> execute print (x2)   -> "12: with-state --phase jump -> print naming execute" (kind:print + execute cmd)
//   .sh 13 ALWAYS-execution gated stage -> gate:true       -> "13: ALWAYS-execution gated stage (intent-capture) -> gate:true"
//   .sh 14 SKILL.md no --args wrapper + flag reaches parser -> "14a: SKILL.md has no 'next --args' wrapper" + "14b: flag-bearing argv reaches the parser"
//   .sh 15 --init threads --test-run (x2)                  -> "15a: --init --test-run threads --test-run" + "15b: control without --test-run"
//   .sh 16 --test-run resume over stamp-less state (x2)    -> "16a: --test-run over stamp-less state -> print" + "16b: print names enable-test-run"
//   .sh 17 field present -> no re-emit (x2)                -> "17a: field present + --test-run does NOT re-emit" + "17b: -> run-stage"
//   .sh 18 stamp-less, no --test-run -> run-stage (x2)     -> "18a: no --test-run never emits enable-test-run" + "18b: -> run-stage"
//   .sh 19 scope-change beats test-run-persist (x2)        -> "19a: differing --scope --test-run routes to scope-change" + "19b: no enable-test-run"
//
// Source cites (dist/claude/.claude/tools/aidlc-orchestrate.ts):
//   :785 handleNext — the read-only branch ladder.
//   :793 Branch 1  --status/--version -> print.
//   :804 Branch 2  --stage + --phase -> "Cannot use --stage and --phase together".
//   :822 Branch 3  --init -> print naming the scaffold cmd; threads --test-run only when present (:838).
//   :858 Branch 3b UNCONDITIONAL invalid --scope -> "Unknown scope ...".
//   :873 Branch 4  env source -> shells resolve-env-scope -> verbatim "Invalid AWS_AIDLC_DEFAULT_SCOPE ...".
//   :934 Branch 5  scope-change print ("scope-change --scope <s>").
//   :994 Branch 5b test-run persistence -> print naming "enable-test-run" only when field absent + no --stage/--phase.
//  :1034 Branch 7  --stage/--phase jump -> emitJumpDirective; with-state -> print "aidlc-jump.ts execute --target ... --direction ...".
//  :1116 Branch 10 happy path -> run-stage for the in-flight current stage.
//   :754 computeGate -> gate:true for every EXECUTE stage except initialization (the gate axis is NOT the execution axis).

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const TOOL = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SKILL_MD = join(AIDLC_SRC, "skills", "aidlc", "SKILL.md");

const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");
const BROWNFIELD_INIT_DONE = join(FIXTURES_DIR, "state-brownfield-init-done.md");
const MID_INCEPTION = join(FIXTURES_DIR, "state-mid-inception.md");

interface RunResult {
  rc: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

// Run `bun aidlc-orchestrate.ts next <args> --project-dir <proj>`. `extraEnv`
// layers onto a COPY of process.env (used for the env-scope precedence cases —
// AWS_AIDLC_DEFAULT_SCOPE is set in the spawn env only, never the test process).
function runNext(
  proj: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): RunResult {
  const res = spawnSync(
    BUN,
    [TOOL, "next", ...args, "--project-dir", proj],
    {
      encoding: "utf-8",
      cwd: proj,
      env: { ...process.env, ...extraEnv },
    },
  );
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { rc: res.status ?? -1, out: `${stdout}${stderr}` };
}

// Stamp `Test Run Mode: true` via the REAL tool (test 17 precondition). This
// also proves the engine's resume branch no-ops once the field is present.
function enableTestRun(proj: string): void {
  spawnSync(BUN, [UTILITY, "enable-test-run", "--project-dir", proj], {
    encoding: "utf-8",
    cwd: proj,
  });
}

let proj = "";
beforeAll(() => {
  resetAidlcEnv();
});
afterEach(() => {
  resetAidlcEnv();
  cleanupTestProject(proj);
  proj = "";
});

// ===========================================================================
// Happy path — in-flight current stage -> run-stage carrying graph fields
// (.sh tests 1-4)
// ===========================================================================
describe("t114 happy path: in-flight current stage -> run-stage", () => {
  test("1: in-flight current stage -> run-stage directive", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    expect(runNext(proj, []).out).toContain('"kind":"run-stage"');
  });

  test("2: run-stage names the current stage (feasibility)", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    expect(runNext(proj, []).out).toContain('"stage":"feasibility"');
  });

  test("3: run-stage carries lead_agent from the graph node", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    expect(runNext(proj, []).out).toContain('"lead_agent":"aidlc-architect-agent"');
  });

  test("4: brownfield bugfix active stage -> run-stage reverse-engineering", () => {
    proj = createTestProject();
    seedStateFile(proj, BROWNFIELD_INIT_DONE);
    expect(runNext(proj, []).out).toContain('"stage":"reverse-engineering"');
  });
});

// ===========================================================================
// Scope precedence ladder + scope validation (.sh tests 5-8)
// ===========================================================================
describe("t114 scope precedence + validation", () => {
  test("5: invalid --scope errors unconditionally over valid state [finding 4]", () => {
    // state-mid-inception has a valid Scope (bugfix); an explicit bad --scope is
    // validated regardless of the state scope and errors with the verbatim
    // `Unknown scope "..."` wording — never swallowed into a current-stage run.
    proj = createTestProject();
    seedStateFile(proj, MID_INCEPTION);
    const out = runNext(proj, ["--scope", "bogusscope"]).out;
    expect(out).toContain('"kind":"error"');
    expect(out).toContain("Unknown scope");
  });

  test("6: --scope flag beats AWS_AIDLC_DEFAULT_SCOPE env", () => {
    // No state file. An invalid env scope would error IF env won; a valid --scope
    // flag must take precedence, yielding a run-stage with no error.
    proj = createTestProject();
    const out = runNext(
      proj,
      ["--scope", "bugfix", "--stage", "requirements-analysis"],
      { AWS_AIDLC_DEFAULT_SCOPE: "bogusscope" },
    ).out;
    expect(out).toContain('"kind":"run-stage"');
  });

  test("7: env scope beats default (poc resolved, run-stage emitted)", () => {
    // Valid env scope (poc) resolves; --stage surfaces a run-stage directive.
    // The default (feature) is never reached because env supplied a valid scope.
    proj = createTestProject();
    const out = runNext(proj, ["--stage", "intent-capture"], {
      AWS_AIDLC_DEFAULT_SCOPE: "poc",
    }).out;
    expect(out).toContain('"stage":"intent-capture"');
  });

  test("8: invalid env scope -> verbatim AWS_AIDLC_DEFAULT_SCOPE error", () => {
    // The env path validates by composing `aidlc-utility.ts resolve-env-scope`,
    // which owns the canonical `Invalid AWS_AIDLC_DEFAULT_SCOPE "..."` wording.
    proj = createTestProject();
    const out = runNext(proj, [], {
      AWS_AIDLC_DEFAULT_SCOPE: "frobnicate",
    }).out;
    expect(out).toContain("Invalid AWS_AIDLC_DEFAULT_SCOPE");
  });
});

// ===========================================================================
// Read-only dispatch + mutual-exclusion guard (.sh tests 9-11)
// ===========================================================================
describe("t114 read-only dispatch + guards", () => {
  test("9: --status -> print directive (read-only dispatch)", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    expect(runNext(proj, ["--status"]).out).toContain('"kind":"print"');
  });

  test("10: --version -> print directive (terminal read-only)", () => {
    proj = createTestProject();
    expect(runNext(proj, ["--version"]).out).toContain('"kind":"print"');
  });

  test("11: mutually-exclusive --stage+--phase -> error directive", () => {
    proj = createTestProject();
    expect(
      runNext(proj, ["--stage", "feasibility", "--phase", "ideation"]).out,
    ).toContain("Cannot use --stage and --phase together");
  });
});

// ===========================================================================
// With-state jump commits via an `execute` print directive (.sh test 12)
// ===========================================================================
describe("t114 with-state jump -> execute print", () => {
  test("12: with-state --phase jump -> print naming execute (commit is a mutation, next stays read-only)", () => {
    // state-mid-ideation is feature scope, Current Stage=feasibility; --phase
    // construction resolves forward to functional-design. A jump against an
    // existing workflow is a MUTATION, and `next` is read-only — so the engine
    // emits a `print` naming `aidlc-jump.ts execute`, carrying the tool-resolved
    // target + direction.
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, ["--phase", "construction"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain(
      "aidlc-jump.ts execute --target functional-design --direction forward",
    );
  });
});

// ===========================================================================
// gate axis is the human-judgement boundary, NOT conditional-inclusion
// (.sh test 13 — regression guard for the gate-derivation fix)
// ===========================================================================
describe("t114 gate axis != execution axis", () => {
  test("13: ALWAYS-execution gated stage (intent-capture) -> gate:true (not derived from execution axis)", () => {
    // intent-capture is execution:ALWAYS yet presents a standard approval gate.
    // A rule reading gate from `execution !== ALWAYS` would emit gate:false here
    // — wrong. Every EXECUTE stage gates except bootstrap initialization stages,
    // so intent-capture (an ideation stage) MUST carry gate:true.
    proj = createTestProject();
    const out = runNext(proj, ["--stage", "intent-capture"], {
      AWS_AIDLC_DEFAULT_SCOPE: "poc",
    }).out;
    expect(out).toContain('"gate":true');
  });
});

// ===========================================================================
// Cutover invocation is engine-compatible: no dropped-arg wrapper (.sh test 14)
// ===========================================================================
describe("t114 cutover: no --args swallow", () => {
  test("14a: SKILL.md forwarding loop has no 'next --args' wrapper", () => {
    // SKILL.md invokes the engine as `next $ARGUMENTS` (argv word-split into the
    // parser). A `next --args "$ARGUMENTS"` wrapper would silently drop every
    // flag-bearing invocation. Pin half (a): the shipped prose must NOT document
    // a `--args` wrapper. (The .sh grepped the file directly; we read the bytes.)
    expect(existsSync(SKILL_MD)).toBe(true);
    const skill = readFileSync(SKILL_MD, "utf-8");
    expect(skill.includes("next --args")).toBe(false);
  });

  test("14b: flag-bearing argv reaches the parser (no --args swallow): --stage <bad> -> unknown-stage error", () => {
    // Pin half (b): a flag-bearing jump reaches the parser (unknown-stage error),
    // it does NOT fall through to a bare next ("run current stage").
    proj = createTestProject();
    const out = runNext(proj, ["--stage", "nonexistent-stage"], {
      AWS_AIDLC_DEFAULT_SCOPE: "poc",
    }).out;
    expect(out).toContain("Unknown stage");
  });
});

// ===========================================================================
// --init threads --test-run into the scaffold command (.sh test 15)
// ===========================================================================
describe("t114 --init test-run threading", () => {
  test("15a: --init --test-run threads --test-run into the scaffold command (birth test-run persistence)", () => {
    proj = createTestProject();
    expect(
      runNext(proj, ["--init", "--scope", "bugfix", "--test-run"]).out,
    ).toContain("--test-run");
  });

  test("15b: --init without --test-run does NOT thread --test-run (control)", () => {
    proj = createTestProject();
    expect(runNext(proj, ["--init", "--scope", "bugfix"]).out).not.toContain(
      "--test-run",
    );
  });
});

// ===========================================================================
// --test-run RESUME over a stamp-less workflow -> enable-test-run print
// (.sh test 16). state-brownfield-init-done is bugfix scope, in-flight
// reverse-engineering, has a Revision Count line, NO Test Run Mode field —
// the exact t55 resume shape.
// ===========================================================================
describe("t114 test-run resume persistence", () => {
  test("16a: --test-run over stamp-less state -> print directive (resume test-run persistence)", () => {
    proj = createTestProject();
    seedStateFile(proj, BROWNFIELD_INIT_DONE);
    expect(runNext(proj, ["bugfix", "--test-run"]).out).toContain('"kind":"print"');
  });

  test("16b: the print names aidlc-utility.ts enable-test-run for the conductor to run", () => {
    proj = createTestProject();
    seedStateFile(proj, BROWNFIELD_INIT_DONE);
    expect(runNext(proj, ["bugfix", "--test-run"]).out).toContain("enable-test-run");
  });
});

// ===========================================================================
// Control — field ALREADY present -> does NOT re-emit enable-test-run
// (.sh test 17). Stamp via the real tool, then re-run next.
// ===========================================================================
describe("t114 test-run resume — field present no-op", () => {
  test("17a: --test-run with the field already present does NOT re-emit enable-test-run (loop advances)", () => {
    proj = createTestProject();
    seedStateFile(proj, BROWNFIELD_INIT_DONE);
    enableTestRun(proj);
    expect(runNext(proj, ["bugfix", "--test-run"]).out).not.toContain(
      "enable-test-run",
    );
  });

  test("17b: field present + --test-run -> run-stage (the resume persist branch no-ops)", () => {
    proj = createTestProject();
    seedStateFile(proj, BROWNFIELD_INIT_DONE);
    enableTestRun(proj);
    expect(runNext(proj, ["bugfix", "--test-run"]).out).toContain('"kind":"run-stage"');
  });
});

// ===========================================================================
// Control — stamp-less state, NO --test-run -> never emits enable-test-run
// (.sh test 18)
// ===========================================================================
describe("t114 test-run resume — gated on flag", () => {
  test("18a: no --test-run -> never emits enable-test-run (normal run-stage)", () => {
    proj = createTestProject();
    seedStateFile(proj, BROWNFIELD_INIT_DONE);
    expect(runNext(proj, ["bugfix"]).out).not.toContain("enable-test-run");
  });

  test("18b: stamp-less state without --test-run -> run-stage", () => {
    proj = createTestProject();
    seedStateFile(proj, BROWNFIELD_INIT_DONE);
    expect(runNext(proj, ["bugfix"]).out).toContain('"kind":"run-stage"');
  });
});

// ===========================================================================
// Branch order — --scope X --test-run over a DIFFERING scope routes to
// scope-change FIRST, not test-run-persist (.sh test 19). Pins the
// branch_order_check guarantee.
// ===========================================================================
describe("t114 branch order: scope-change beats test-run-persist", () => {
  test("19a: differing --scope --test-run routes to scope-change first (test-run persist does not shadow it)", () => {
    proj = createTestProject();
    seedStateFile(proj, BROWNFIELD_INIT_DONE);
    expect(runNext(proj, ["--scope", "feature", "--test-run"]).out).toContain(
      "scope-change --scope feature",
    );
  });

  test("19b: the scope-change combo does NOT emit enable-test-run (test-run persist rides the next loop iteration)", () => {
    proj = createTestProject();
    seedStateFile(proj, BROWNFIELD_INIT_DONE);
    expect(runNext(proj, ["--scope", "feature", "--test-run"]).out).not.toContain(
      "enable-test-run",
    );
  });
});
