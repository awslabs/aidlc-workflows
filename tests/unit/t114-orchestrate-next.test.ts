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
// init — none importable, all spawned). An in-process twin
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
//
// (The .sh's tests 15-19 exercised the now-removed --test-run / Test Run Mode
// mechanism and were dropped with it; issue #369.)
//
// Source cites (dist/claude/.claude/tools/aidlc-orchestrate.ts):
//   :785 handleNext — the read-only branch ladder.
//   :793 Branch 1  --status/--version -> print.
//   :804 Branch 2  --stage + --phase -> "Cannot use --stage and --phase together".
//   :822 Branch 3  --init -> print naming the scaffold cmd.
//   :858 Branch 3b UNCONDITIONAL invalid --scope -> "Unknown scope ...".
//   :873 Branch 4  env source -> shells resolve-env-scope -> verbatim "Invalid AWS_AIDLC_DEFAULT_SCOPE ...".
//   :934 Branch 5  scope-change print ("scope-change --scope <s>").
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
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
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
// Help-request routing: bare help tokens and `intent help`/`space help` must
// print help, never enter the birth funnel or a switch attempt.
// ===========================================================================
describe("t114 help-request routing", () => {
  test("sole bare `help` on a fresh workspace -> help print, not a birth ask", () => {
    // Without the sole-token special case, `help` fell into intentWords and
    // Branch 8 offered to birth an intent literally named "help".
    proj = createTestProject();
    const out = runNext(proj, ["help"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc-utility.ts help");
    expect(out).not.toContain('"kind":"ask"');
  });

  test("sole bare `-h` on a fresh workspace -> help print, not a birth ask", () => {
    proj = createTestProject();
    const out = runNext(proj, ["-h"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc-utility.ts help");
    expect(out).not.toContain('"kind":"ask"');
  });

  test("sole bare `help` over an active workflow -> help print, not a stage advance", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, ["help"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).not.toContain('"kind":"run-stage"');
  });

  test("`intent help` -> global help print, not a switch to an intent named help", () => {
    proj = createTestProject();
    const out = runNext(proj, ["intent", "help"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc-utility.ts help");
    expect(out).not.toContain("aidlc-utility.ts intent help");
  });

  test("`space help` -> global help print, not a switch to a space named help", () => {
    proj = createTestProject();
    const out = runNext(proj, ["space", "help"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc-utility.ts help");
    expect(out).not.toContain("aidlc-utility.ts space help");
  });

  test("`help` inside a longer description stays freeform intent text", () => {
    // Only the SOLE token is a help request; a description mentioning help
    // still reaches the freeform funnel (Branch 8 ask on a fresh workspace).
    proj = createTestProject();
    const out = runNext(proj, ["help", "me", "build", "an", "auth", "service"]).out;
    expect(out).toContain('"kind":"ask"');
  });

  test("`intent -h` routes to help like `intent help`", () => {
    proj = createTestProject();
    const out = runNext(proj, ["intent", "-h"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc-utility.ts help");
  });

  test("`space -h` routes to help like `space help`", () => {
    // The engine parser and classifyTerminalCommand are supposed to mirror
    // each other; the Kiro seam is pinned elsewhere, this pins the engine.
    proj = createTestProject();
    const out = runNext(proj, ["space", "-h"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc-utility.ts help");
    expect(out).not.toContain("aidlc-utility.ts space -h");
  });

  test("a marker-led blob stays freeform and reaches the safe ask funnel", () => {
    // The engine does NOT repair a conductor that echoes the whole invocation
    // line - re-tokenizing prose deterministically hijacked real descriptions.
    // The SKILL.md forwarding prose owns marker-stripping; a marker-led blob
    // lands in the ask funnel (a human gate), never a silent misroute.
    proj = createTestProject();
    const out = runNext(proj, ["/aidlc intent help"]).out;
    expect(out).toContain('"kind":"ask"');
    expect(out).not.toContain("aidlc-utility.ts intent");
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
// Workspace navigation verbs route through the conductor (Branch 1b). A LEADING
// space/space-create/intent token is the explicit "cd" between teams/intents
// (workspace-vision §3). It dispatches BEFORE any state inspection and maps to a
// TERMINAL print naming the deterministic aidlc-utility.ts handler, so the
// engine never treats it as freeform new-work text that advances the active
// intent (the bug this fixes). The handler itself branches list-vs-switch on the
// <name> arg, so the engine just passes args[1] through when present.
// ===========================================================================
describe("t114 workspace verbs -> terminal print naming the handler", () => {
  test("20: `space teamB` -> print naming aidlc-utility.ts space teamB (switch, not freeform)", () => {
    proj = createTestProject();
    const out = runNext(proj, ["space", "teamB"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc-utility.ts space teamB");
    // It must NOT be misread as a new-work freeform intent that advances state.
    expect(out).not.toContain('"kind":"run-stage"');
  });

  test("21: bare `space` (no arg) -> print naming aidlc-utility.ts space (read-only listing)", () => {
    proj = createTestProject();
    const out = runNext(proj, ["space"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc-utility.ts space");
    // No trailing name arg leaks into the directive.
    expect(out).not.toContain("aidlc-utility.ts space ");
  });

  test("22: `intent some-slug` -> print naming aidlc-utility.ts intent some-slug", () => {
    proj = createTestProject();
    const out = runNext(proj, ["intent", "some-slug"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc-utility.ts intent some-slug");
  });

  test("23: `space-create teamB` -> print naming aidlc-utility.ts space-create teamB", () => {
    proj = createTestProject();
    const out = runNext(proj, ["space-create", "teamB"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc-utility.ts space-create teamB");
  });

  test("24: REGRESSION -- freeform containing 'space' NOT as leading token stays freeform (i===0 guard)", () => {
    // `add a settings space` leads with "add", so "space" mid-sentence is NOT a
    // workspace verb. The engine must route it as freeform new-work, never as a
    // space-switch print naming the workspace handler.
    proj = createTestProject();
    const out = runNext(proj, ["add", "a", "settings", "space"]).out;
    expect(out).not.toContain("aidlc-utility.ts space");
  });
});

// ===========================================================================
// Parked workflow (#367) - the persisted-field branch the Stop hook relies on.
// `park` writes the marker via aidlc-state.ts; a PLAIN `next` then re-emits the
// `parked` directive (Branch 2.5). Explicit re-entry self-disables it, and a
// stale marker (Current Stage moved past Parked At Stage) is ignored.
// ===========================================================================
describe("t114 parked branch (#367)", () => {
  const directStateEnv = {
    ...process.env,
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  };

  function park(p: string): void {
    spawnSync(BUN, [STATE, "park", "--project-dir", p], {
      encoding: "utf-8",
      cwd: p,
      env: directStateEnv,
    });
  }

  test("plain next on a parked workflow -> parked directive", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    park(proj);
    const out = runNext(proj, []).out;
    expect(out).toContain('"kind":"parked"');
    expect(out).toContain('"stage":"feasibility"');
  });

  test("--resume on a parked workflow self-disables (names unpark, not parked)", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    park(proj);
    const out = runNext(proj, ["--resume"]).out;
    expect(out).not.toContain('"kind":"parked"');
    expect(out).toContain("unpark");
  });

  test("stale parked (Current Stage advanced past Parked At Stage) is ignored", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    park(proj);
    // Advance Current Stage past the parked slug - the marker is now stale.
    spawnSync(BUN, [STATE, "set", "Current Stage=scope-definition", "--project-dir", proj], {
      encoding: "utf-8",
      cwd: proj,
      env: directStateEnv,
    });
    const out = runNext(proj, []).out;
    expect(out).not.toContain('"kind":"parked"');
    expect(out).toContain('"kind":"run-stage"');
  });

  test("after unpark, a plain next no longer parks", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    park(proj);
    spawnSync(BUN, [STATE, "unpark", "--project-dir", proj], {
      encoding: "utf-8",
      cwd: proj,
      env: directStateEnv,
    });
    const out = runNext(proj, []).out;
    expect(out).not.toContain('"kind":"parked"');
    expect(out).toContain('"kind":"run-stage"');
  });
});
