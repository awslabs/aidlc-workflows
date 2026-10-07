// covers: subcommand:aidlc-orchestrate:next, file:skills/aidlc/SKILL.md, function:INTENT_SELECTOR_REGEX, function:parseTeamBoardArgs
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
// createOrchestrationTestProject() + seedStateFile() (the .ts analogues of fixtures.sh's
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
//   :934 Branch 5  scope-change print ("scope change --scope <s>").
//  :1034 Branch 7  --stage/--phase jump -> emitJumpDirective; with-state -> print "aidlc-jump.ts execute --target ... --direction ...".
//  :1116 Branch 10 happy path -> run-stage for the in-flight current stage.
//   :754 computeGate -> gate:true for every EXECUTE stage except initialization (the gate axis is NOT the execution axis).

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  REPO_ROOT,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  runOrchestrateNext,
  seededAuditDir,
  seededAuditShard,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { engineTouchMarkerPath } from "../../core/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath; // the bun running this test
const TOOL = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const NATIVE_TOOL = join(
  REPO_ROOT,
  "dist-release",
  "claude",
  ".claude",
  "tools",
  "aidlc-orchestrate.ts",
);
const CODEX_TOOL = join(
  REPO_ROOT,
  "dist",
  "codex",
  ".codex",
  "tools",
  "aidlc-orchestrate.ts",
);
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const SKILL_MD = join(AIDLC_SRC, "skills", "aidlc", "SKILL.md");

const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");
const COMPLETED = join(FIXTURES_DIR, "state-completed.md");
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
  const res = runOrchestrateNext(TOOL, proj, args, {
    cwd: proj,
    env: { ...process.env, ...extraEnv },
  });
  return { rc: res.status, out: res.out };
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
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    expect(runNext(proj, []).out).toContain('"kind":"run-stage"');
  });

  test("2: run-stage names the current stage (feasibility)", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    expect(runNext(proj, []).out).toContain('"stage":"feasibility"');
  });

  test("3: run-stage carries lead_agent from the graph node", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    expect(runNext(proj, []).out).toContain('"lead_agent":"aidlc-architect-agent"');
  });

  test("4: brownfield bugfix active stage -> run-stage reverse-engineering", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, BROWNFIELD_INIT_DONE);
    expect(runNext(proj, []).out).toContain('"stage":"reverse-engineering"');
  });

  test("untracked-only completions route normally without a per-turn advisory", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const statePath = seededStateFile(proj);
    const state = readFileSync(statePath, "utf-8")
      .replace("- [-] feasibility — EXECUTE", "- [x] feasibility — EXECUTE")
      .replace("- [ ] scope-definition — EXECUTE", "- [-] scope-definition — EXECUTE")
      .replace("- **Current Stage**: feasibility", "- **Current Stage**: scope-definition")
      .replace("- **Next Stage**: scope-definition", "- **Next Stage**: team-formation");
    writeFileSync(statePath, state, "utf-8");
    const result = spawnSync(BUN, [TOOL, "next", "--project-dir", proj], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      cwd: proj,
      encoding: "utf-8",
      env: { ...process.env },
    });
    expect(result.status).toBe(0);
    const directive = JSON.parse((result.stdout ?? "").trim()) as {
      kind: string;
      rules_content?: unknown;
      stage_validity?: unknown;
    };
    // The rules ride inline on the run-stage (no load-steering hop), and an
    // untracked-only completion still carries no per-turn validity advisory.
    expect(directive.kind).toBe("run-stage");
    expect(Array.isArray(directive.rules_content)).toBe(true);
    expect(directive.stage_validity).toBeUndefined();
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
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_INCEPTION);
    const out = runNext(proj, ["--scope", "bogusscope"]).out;
    expect(out).toContain('"kind":"error"');
    expect(out).toContain("Unknown scope");
  });

  test("6: --scope flag beats AWS_AIDLC_DEFAULT_SCOPE env", () => {
    // No state file. An invalid env scope would error IF env won; a valid --scope
    // flag must take precedence, yielding a run-stage with no error.
    proj = createOrchestrationTestProject();
    const out = runNext(
      proj,
      ["--scope", "bugfix", "--stage", "requirements-analysis"],
      { AWS_AIDLC_DEFAULT_SCOPE: "bogusscope" },
    ).out;
    expect(out).toContain('"kind":"run-stage"');
  });

  test("7: env scope beats default (poc resolved, run-stage emitted)", () => {
    // Valid env scope (poc) resolves; --stage surfaces a run-stage directive.
    // The default (classic) is never reached because env supplied a valid scope.
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["--stage", "intent-capture"], {
      AWS_AIDLC_DEFAULT_SCOPE: "poc",
    }).out;
    expect(out).toContain('"stage":"intent-capture"');
  });

  test("8: invalid env scope -> verbatim AWS_AIDLC_DEFAULT_SCOPE error", () => {
    // The env path validates by composing `aidlc-utility.ts resolve-env-scope`,
    // which owns the canonical `Invalid AWS_AIDLC_DEFAULT_SCOPE "..."` wording.
    proj = createOrchestrationTestProject();
    const out = runNext(proj, [], {
      AWS_AIDLC_DEFAULT_SCOPE: "frobnicate",
    }).out;
    expect(out).toContain("Invalid AWS_AIDLC_DEFAULT_SCOPE");
  });

  test("a completed intent whose scope this install no longer defines does not block next (#1550)", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, "state-completed.md");
    const statePath = seededStateFile(proj);
    const completed = readFileSync(statePath, "utf-8").replace(/^- \*\*Scope\*\*: .*$/m, "- **Scope**: retired-lane");
    writeFileSync(statePath, completed, "utf-8");
    const directive = (args: string[]) => JSON.parse(runNext(proj, args).out.trim().split("\n").at(-1) ?? "{}") as {
      kind: string;
      message?: string;
      reason?: string;
    };

    const bare = directive([]);
    expect(bare.kind).toBe("done");
    expect(bare.reason).toContain('recorded scope "retired-lane", which this install no longer defines');
    expect(bare.reason).toContain("next --new-intent --scope");

    const created = directive(["--new-intent", "--scope", "bugfix", "fix the login redirect"]);
    expect(created.kind).toBe("print");
    expect(created.message).toContain("intent create --scope bugfix");

    // A move on the finished workflow itself needs its scope: done, not an error.
    expect(directive(["compose"]).kind).toBe("done");
    expect(directive(["--stage", "code-generation"]).kind).toBe("done");
    const bogus = directive(["--scope", "nope", "x"]);
    expect(bogus.kind).toBe("error");
    expect(bogus.message).toContain('Unknown scope "nope"');

    writeFileSync(statePath, completed.replace("- **Status**: Completed", "- **Status**: Running"), "utf-8");
    const running = directive([]);
    expect(running.kind).toBe("error");
    expect(running.message).toContain('Unknown scope "retired-lane"');
  });

  // New work started beside open work on a scope this install no longer
  // defines never routes through that scope, so it starts as it would beside
  // any open work, and the open work stays exactly as it was.
  test("new work beside open work on a retired scope starts, and the open work is untouched", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, "state-completed.md");
    const statePath = seededStateFile(proj);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8")
        .replace(/^- \*\*Scope\*\*: .*$/m, "- **Scope**: retired-lane")
        .replace("- **Status**: Completed", "- **Status**: Running"),
      "utf-8",
    );
    const registry = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
    const openState = readFileSync(statePath, "utf-8");
    const openEntries = readFileSync(registry, "utf-8");
    const directive = (args: string[]) => JSON.parse(runNext(proj, args).out.trim().split("\n").at(-1) ?? "{}") as {
      kind: string;
      ask_type?: string;
      message?: string;
    };

    const scoped = directive(["--new-intent", "--scope", "bugfix", "fix the login redirect"]);
    expect(scoped.kind, JSON.stringify(scoped)).toBe("print");
    expect(scoped.message).toContain("intent create --scope bugfix");
    // With no scope typed, the person gets the same plan offer as beside known work.
    const unscoped = directive(["--new-intent", "fix the login redirect"]);
    expect(unscoped.kind, JSON.stringify(unscoped)).toBe("ask");
    expect(unscoped.ask_type).toBe("scope-confirm");
    // A move on the open work itself still needs its scope.
    expect(directive([]).message).toContain('Unknown scope "retired-lane"');
    expect(readFileSync(statePath, "utf-8")).toBe(openState);
    expect(readFileSync(registry, "utf-8")).toBe(openEntries);

    // Running the named creation adds the new work and leaves the open one as it was.
    const created = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-utility.ts"),
      "intent-create", "--scope", "bugfix", "--label", "fix the login redirect", "--project-dir", proj,
    ], { cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(created.status, `${created.stdout}${created.stderr}`).toBe(0);
    type Entry = { scope?: string; status?: string };
    const entries = JSON.parse(readFileSync(registry, "utf-8")) as Entry[];
    const before = JSON.parse(openEntries) as Entry[];
    expect(entries).toHaveLength(before.length + 1);
    expect(entries.slice(0, before.length)).toEqual(before);
    expect(entries.at(-1)?.scope).toBe("bugfix");
    expect(readFileSync(statePath, "utf-8")).toBe(openState);
  });

  // New work never routes through the finished intent's scope, so a retired
  // one changes nothing for it: `/aidlc-init "<description>"` (next
  // --new-intent "<description>"), free text, and a typed scope with a
  // description get the answer they get over a known scope, and the plan
  // offers' answers start the work (free text's compose answer is a new-work
  // answer with no --new-intent).
  test("new work over a completed intent on a retired scope gets what a known scope gets (#1550)", () => {
    const shape = (d: Record<string, unknown>): string =>
      d.kind === "ask"
        ? `ask ${d.ask_type}`
        : `${d.kind} ${String(d.message ?? d.reason ?? "").match(
          /intent create --scope \w+|Dispatch the composer agent|Workflow complete/,
        )?.[0] ?? ""}`;
    const newWork = (scope: string) => {
      proj = createOrchestrationTestProject();
      seedStateFile(proj, "state-completed.md");
      const statePath = seededStateFile(proj);
      writeFileSync(
        statePath,
        readFileSync(statePath, "utf-8").replace(/^- \*\*Scope\*\*: .*$/m, `- **Scope**: ${scope}`),
        "utf-8",
      );
      const run = (args: string[]) =>
        JSON.parse(runNext(proj, args).out.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
      const answer = (command: unknown) => {
        const text = String(command);
        return run(text.slice(text.indexOf(" next ") + 6).split(" "));
      };
      const initOffer = run(["--new-intent", "fix the login redirect"]);
      const initComposed = answer(initOffer.compose_command);
      const freeTextOffer = run(["fix the login redirect"]);
      const freeTextComposed = answer(freeTextOffer.compose_command);
      const seen = {
        initOffer: shape(initOffer),
        initConfirmed: shape(answer(initOffer.confirm_command)),
        initComposed: shape(initComposed),
        initComposedInFlight: String(initComposed.message).includes("mode in-flight"),
        freeTextOffer: shape(freeTextOffer),
        freeTextConfirmed: shape(answer(freeTextOffer.confirm_command)),
        freeTextComposed: shape(freeTextComposed),
        freeTextComposedInFlight: String(freeTextComposed.message).includes("mode in-flight"),
        typedScope: shape(run(["--scope", "bugfix", "fix the login redirect"])),
        positionalScope: shape(run(["bugfix", "fix the login redirect"])),
      };
      cleanupTestProject(proj);
      proj = "";
      return seen;
    };

    const known = newWork("feature");
    expect(known).toEqual({
      initOffer: "ask scope-confirm",
      initConfirmed: "print intent create --scope bugfix",
      initComposed: "print Dispatch the composer agent",
      initComposedInFlight: false,
      freeTextOffer: "ask scope-confirm",
      freeTextConfirmed: "print intent create --scope bugfix",
      freeTextComposed: "print Dispatch the composer agent",
      freeTextComposedInFlight: false,
      typedScope: "print intent create --scope bugfix",
      positionalScope: "print intent create --scope bugfix",
    });
    expect(newWork("retired-lane")).toEqual(known);
  });
});

// ===========================================================================
// Read-only dispatch + mutual-exclusion guard (.sh tests 9-11)
// ===========================================================================
describe("t114 read-only dispatch + guards", () => {
  test("9: --status -> print directive (read-only dispatch)", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    expect(runNext(proj, ["--status"]).out).toContain('"kind":"print"');
  });

  test("10: --version -> print directive (terminal read-only)", () => {
    proj = createOrchestrationTestProject();
    expect(runNext(proj, ["--version"]).out).toContain('"kind":"print"');
  });

  test("11: mutually-exclusive --stage+--phase -> error directive", () => {
    proj = createOrchestrationTestProject();
    expect(
      runNext(proj, ["--stage", "feasibility", "--phase", "ideation"]).out,
    ).toContain("Cannot use --stage and --phase together");
  });
});

describe("t114 in-session config alias", () => {
  test("bare --config emits a terminal print contract without workflow state", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["--config"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("bun .claude/tools/aidlc.ts config <section> --show --json");
    expect(out).toContain("explicit value flags");
    expect(out).toContain("Never invent values");
    expect(out).toContain("do NOT run `next`");
    expect(out).toContain("ask which sections the human wants to consider");
    expect(out).not.toContain("even when it is already clean");
    expect(out).not.toContain('"kind":"run-stage"');
  });

  test("--config providers names the selected section and exact copy invocation", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["--config", "providers"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("Configure the providers section conversationally");
    expect(out).toContain(
      "bun .claude/tools/aidlc.ts config providers --show --json",
    );
    expect(out).toContain(
      "bun .claude/tools/aidlc.ts config <section> <explicit value flags> --yes",
    );
    // A named section always asks, even when clean: t297 saw a clean trust
    // section end without a question.
    expect(out).toContain(
      "ask what the human wants to change in it, offering the choices `bun .claude/tools/aidlc.ts config providers --help` lists and leaving it unchanged, even when it is already clean",
    );
    expect(out).not.toContain("ask which sections");
  });

  test("--config rejects unknown or extra trailing tokens as usage errors", () => {
    proj = createOrchestrationTestProject();
    for (const args of [
      ["--config", "bogus"],
      ["--config", "trust", "extra"],
    ]) {
      const out = runNext(proj, args).out;
      expect(out).toContain('"kind":"error"');
      expect(out).toContain(
        "Usage: /aidlc --config [models|runtime|providers|trust|flags|project].",
      );
      expect(out).not.toContain('"kind":"run-stage"');
      expect(existsSync(engineTouchMarkerPath(proj))).toBe(false);
    }
  });

  test("--config over an active workflow never advances or changes state", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const before = readFileSync(seededStateFile(proj), "utf-8");
    const out = runNext(proj, ["--config", "trust"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).not.toContain('"kind":"run-stage"');
    const refused = runNext(proj, ["--config", "bogus"]).out;
    expect(refused).toContain('"kind":"error"');
    expect(refused).toContain("Usage: /aidlc --config");
    // markEngineTouch self-gates without a workflow; refusal must also stay terminal with one.
    expect(existsSync(engineTouchMarkerPath(proj))).toBe(false);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(before);
  });

  test("a modifier next refuses stays terminal over an active workflow", () => {
    // Full Suite 36549553601: `/aidlc --depth extreme` must not count as
    // engagement on the marker path (Kiro CLI, opencode) either.
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const before = readFileSync(seededStateFile(proj), "utf-8");
    for (const args of [["--depth", "extreme"], ["--review", "loud"], ["--guard-policy", "loose"]]) {
      const out = runNext(proj, args).out;
      expect(out, args.join(" ")).toContain('"kind":"error"');
      expect(out, args.join(" ")).toContain(`${args[0]} requires <`);
      expect(existsSync(engineTouchMarkerPath(proj)), args.join(" ")).toBe(false);
    }
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(before);
  });

  test("native release projection renders public aidlc config invocation", () => {
    proj = createOrchestrationTestProject();
    const result = runOrchestrateNext(
      NATIVE_TOOL,
      proj,
      ["--config", "trust"],
      { cwd: proj, env: process.env },
    );
    expect(result.status).toBe(0);
    expect(result.out).toContain("aidlc config trust --show --json");
    expect(result.out).not.toContain("bun .claude/tools/aidlc.ts config trust");
  });
});

// ===========================================================================
// Help-request routing: bare help tokens and `intent help`/`space help` must
// print help, never enter the creation funnel or a switch attempt.
// ===========================================================================
describe("t114 orchestrator-verb routing", () => {
  test("sole `park` on a fresh workspace -> print naming the park command, not a creation ask", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["park"]).out;
    expect(out).toContain('"kind":"print"');
    // The engine's own park, which every tool runs without asking the person.
    expect(out).toMatch(/orchestrate(\.ts)? park`/);
    expect(out).not.toContain("aidlc.ts park`");
    expect(out).toContain("parked");
    expect(out).not.toContain('"kind":"ask"');
  });

  test("sole `park` over an active workflow -> print, never the new-work offer or a stage advance", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, ["park"]).out;
    expect(out).toContain('"kind":"print"');
    // The engine's own park, which every tool runs without asking the person.
    expect(out).toMatch(/orchestrate(\.ts)? park`/);
    expect(out).not.toContain("aidlc.ts park`");
    expect(out).not.toContain("new-work-routing");
    expect(out).not.toContain('"kind":"run-stage"');
  });

  test("`park` inside a longer description stays freeform, like `help`", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["park", "the", "car", "rental", "feature"]).out;
    expect(out).toContain('"kind":"ask"');
    expect(out).not.toContain("aidlc.ts park`");
  });

  test("`team-board` -> read-only print carrying only allowlisted args", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const bare = runNext(proj, ["team-board"]).out;
    expect(bare).toContain('"kind":"print"');
    expect(bare).toContain("aidlc.ts team-board`");
    expect(bare).toContain("do NOT run `next`");
    const withArgs = runNext(proj, ["team-board", "--snapshot", "--intent", "260901-x"]).out;
    expect(withArgs).toContain("aidlc.ts team-board --snapshot --intent 260901-x`");
    const stray = runNext(proj, ["team-board", "--status"]).out;
    expect(stray).toContain('"kind":"error"');
    expect(stray).toContain("does not accept");
    expect(stray).toContain("Usage: team-board");
    // The global --config shortcut must not pre-empt the board grammar.
    const config = runNext(proj, ["team-board", "--config", "models"]).out;
    expect(config).toContain('"kind":"error"');
    expect(config).toContain("does not accept");
    expect(config).not.toContain("/aidlc --config");
    // Selector values become path segments downstream: only the name grammars pass.
    for (const bad of [["--space", "../../tmp"], ["--space", "Team"], ["--intent", "../x"], ["--intent", "a/b"]]) {
      const out = runNext(proj, ["team-board", ...bad]).out;
      expect(out).toContain('"kind":"error"');
      expect(out).not.toContain("aidlc.ts team-board");
    }
    // Read-only, accepted or refused: none of the above touched the engine
    // marker, so the turn stays conversational for the Stop hook. Park does.
    expect(existsSync(engineTouchMarkerPath(proj))).toBe(false);
    runNext(proj, ["park"]);
    expect(existsSync(engineTouchMarkerPath(proj))).toBe(true);
  });

  test("sole `unpark` -> error naming --resume, not a creation ask", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["unpark"]).out;
    expect(out).toContain('"kind":"error"');
    expect(out).toContain("/aidlc --resume");
    expect(out).not.toContain('"kind":"ask"');
  });
});

describe("t114 help-request routing", () => {
  test("sole bare `help` on a fresh workspace -> help print, not a creation ask", () => {
    // Without the sole-token special case, `help` fell into intentWords and
    // Branch 8 offered to create an intent literally named "help".
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["help"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc.ts engine orchestrate help");
    expect(out).not.toContain('"kind":"ask"');
  });

  test("sole bare `-h` on a fresh workspace -> help print, not a creation ask", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["-h"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc.ts engine orchestrate help");
    expect(out).not.toContain('"kind":"ask"');
  });

  test("sole bare `help` over an active workflow -> help print, not a stage advance", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, ["help"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).not.toContain('"kind":"run-stage"');
  });

  test("`intent help` -> global help print, not a switch to an intent named help", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["intent", "help"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc.ts engine orchestrate help");
    expect(out).not.toContain("aidlc.ts engine intent help");
  });

  test("`space help` -> global help print, not a switch to a space named help", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["space", "help"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc.ts engine orchestrate help");
    expect(out).not.toContain("aidlc.ts engine space help");
  });

  // Live (Claude Code, poc and express): the request printed AI-DLC's version
  // and started nothing, so the person had to say it again.
  test("a utility flag inside a description stays part of the request", () => {
    for (const flag of ["--version", "--status", "--help", "--doctor"]) {
      proj = createOrchestrationTestProject();
      const said = `add a ${flag} flag that prints the version from package.json`;
      const out = runNext(proj, said.split(" ")).out;
      expect(out, flag).toContain('"kind":"ask"');
      expect(out, flag).not.toContain(" version`, print its output verbatim");
      cleanupTestProject(proj);
      proj = "";
    }
  });

  test("`help` inside a longer description stays freeform intent text", () => {
    // Only the SOLE token is a help request; a description mentioning help
    // still reaches the freeform funnel (Branch 8 ask on a fresh workspace).
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["help", "me", "build", "an", "auth", "service"]).out;
    expect(out).toContain('"kind":"ask"');
  });

  test("`intent -h` routes to help like `intent help`", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["intent", "-h"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc.ts engine orchestrate help");
  });

  test("`space -h` routes to help like `space help`", () => {
    // The engine parser and classifyTerminalCommand are supposed to mirror
    // each other; the Kiro seam is pinned elsewhere, this pins the engine.
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["space", "-h"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc.ts engine orchestrate help");
    expect(out).not.toContain("aidlc.ts engine space -h");
  });

  test("a marker-led blob stays freeform and reaches the safe ask funnel", () => {
    // The engine does NOT repair a conductor that echoes the whole invocation
    // line - re-tokenizing prose deterministically hijacked real descriptions.
    // The SKILL.md forwarding prose owns marker-stripping; a marker-led blob
    // lands in the ask funnel (a human gate), never a silent misroute.
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["/aidlc intent help"]).out;
    expect(out).toContain('"kind":"ask"');
    expect(out).not.toContain("aidlc.ts engine intent");
  });
});

describe("t114 plugin terminal routing", () => {
  test("plugin list preserves --json and never enters the workflow funnel", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, ["plugin", "list", "--json"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("bun .claude/tools/aidlc.ts engine plugin list --json");
    expect(out).not.toContain('"kind":"run-stage"');
  });

  test("plugin sync routes to the terminal utility", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["plugin", "sync"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("bun .claude/tools/aidlc.ts engine plugin sync");
  });

  test("plugin select preserves the selected names", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["plugin", "select", "aidlc,test-pro"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("bun .claude/tools/aidlc.ts engine plugin select aidlc,test-pro");
  });

  test("plugin help routes to global help", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["plugin", "help"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("bun .claude/tools/aidlc.ts engine plugin help");
    expect(out).not.toContain('"kind":"ask"');
  });

  test("missing and unknown plugin verbs are deterministic errors", () => {
    proj = createOrchestrationTestProject();
    const missing = runNext(proj, ["plugin"]).out;
    const unknown = runNext(proj, ["plugin", "remove"]).out;
    expect(missing).toContain('"kind":"error"');
    expect(missing).toContain("missing verb for noun 'plugin'");
    expect(unknown).toContain('"kind":"error"');
    expect(unknown).toContain("unknown verb 'remove' for noun 'plugin'");
    expect(`${missing}${unknown}`).not.toContain('"kind":"ask"');
  });
});

describe("t114 knowledge (DocumentKB) terminal routing", () => {
  // The engine parser and the classifier are separate code paths whose comments
  // require byte-for-byte agreement. These cases assert the ENGINE half: a
  // knowledge verb must emit a terminal print directive naming
  // aidlc-knowledge.ts, never a workflow directive and never an intent-create ask.
  test("every verb routes to aidlc-knowledge.ts and never enters the workflow funnel", () => {
    for (const verb of ["onboard", "sync", "list", "show", "associate", "dissociate", "rebind"]) {
      proj = createOrchestrationTestProject();
      seedStateFile(proj, MID_IDEATION);
      const out = runNext(proj, ["knowledge", verb]).out;
      expect(out, verb).toContain('"kind":"print"');
      expect(out, verb).toContain(`aidlc-knowledge.ts ${verb}`);
      expect(out, verb).not.toContain('"kind":"run-stage"');
      expect(out, verb).not.toContain('"kind":"ask"');
    }
  });

  test("a mid-workflow knowledge command does not advance the workflow", () => {
    // The regression this guards: a terminal noun that reaches the funnel while
    // a workflow is active reads as intent prose and can advance a stage.
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, ["knowledge", "list", "--json"]).out;
    expect(out).toContain("aidlc-knowledge.ts list --json");
    expect(out).not.toContain('"kind":"run-stage"');
  });

  test("arguments survive the round trip, including a path with a space", () => {
    proj = createOrchestrationTestProject();
    expect(runNext(proj, ["knowledge", "onboard", "docs/policy.pdf"]).out)
      .toContain("aidlc-knowledge.ts onboard docs/policy.pdf");
    // shellArg quoting must keep a spaced path as ONE argument.
    const spaced = runNext(proj, ["knowledge", "onboard", "my docs/policy.pdf"]).out;
    expect(spaced).toContain("aidlc-knowledge.ts onboard");
    expect(spaced).toMatch(/'my docs\/policy\.pdf'|"my docs\/policy\.pdf"/);
  });

  test("knowledge help routes terminally", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["knowledge", "help"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc-knowledge.ts help");
    expect(out).not.toContain('"kind":"ask"');
  });

  test("missing and unknown knowledge verbs are deterministic errors", () => {
    proj = createOrchestrationTestProject();
    const missing = runNext(proj, ["knowledge"]).out;
    const unknown = runNext(proj, ["knowledge", "remove"]).out;
    expect(missing).toContain('"kind":"error"');
    expect(missing).toContain("missing verb for noun 'knowledge'");
    expect(unknown).toContain('"kind":"error"');
    expect(unknown).toContain("unknown verb 'remove' for noun 'knowledge'");
    // Not an ask: `knowledge remove` must not offer to create an intent.
    expect(`${missing}${unknown}`).not.toContain('"kind":"ask"');
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
    proj = createOrchestrationTestProject();
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
    proj = createOrchestrationTestProject();
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
    proj = createOrchestrationTestProject();
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
  test("20: `space teamB` -> print naming aidlc.ts engine space teamB (switch, not freeform)", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["space", "teamB"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc.ts engine space teamB");
    // It must NOT be misread as a new-work freeform intent that advances state.
    expect(out).not.toContain('"kind":"run-stage"');
  });

  test("21: bare `space` (no arg) -> print naming aidlc.ts engine space (read-only listing)", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["space"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc.ts engine space list");
    // No trailing name arg leaks into the directive.
    expect(out).not.toContain("aidlc.ts engine space list ");
  });

  test("22: `intent some-slug` -> print naming aidlc.ts engine intent some-slug", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["intent", "some-slug"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc.ts engine intent some-slug");
  });

  test("23: `space-create teamB` -> print naming aidlc.ts engine space create teamB", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["space-create", "teamB"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("aidlc.ts engine space create teamB");
  });

  test("24: REGRESSION -- freeform containing 'space' NOT as leading token stays freeform (i===0 guard)", () => {
    // `add a settings space` leads with "add", so "space" mid-sentence is NOT a
    // workspace verb. The engine must route it as freeform new-work, never as a
    // space-switch print naming the workspace handler.
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["add", "a", "settings", "space"]).out;
    expect(out).not.toContain("aidlc.ts engine space");
  });

  test("25: navigation ends the turn even with unfinished work; intent creation is not navigation", () => {
    // Selecting a space or intent is not a request to resume it, so the print
    // says outright that no workflow step follows, with a workflow mid-stage.
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const boundary =
      "Do not call `next` or `report`, run a stage, or offer to resume a workflow after this command";
    for (const args of [["space", "teamB"], ["space"], ["intent", "some-slug"], ["space-create", "teamB"]]) {
      const out = runNext(proj, args).out;
      expect(out, args.join(" ")).toContain('"kind":"print"');
      expect(out, args.join(" ")).toContain(boundary);
    }
    const create = runNext(proj, ["intent", "create", "--scope", "poc", "--label", "x"]).out;
    expect(create).toContain("engine intent create");
    expect(create).not.toContain(boundary);
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
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      cwd: p,
      env: directStateEnv,
    });
  }

  test("plain next on a parked workflow -> parked directive", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    park(proj);
    const out = runNext(proj, []).out;
    expect(out).toContain('"kind":"parked"');
    expect(out).toContain('"stage":"feasibility"');
  });

  test("--resume on a parked workflow self-disables (names unpark, not parked)", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    park(proj);
    const out = runNext(proj, ["--resume"]).out;
    expect(out).not.toContain('"kind":"parked"');
    expect(out).toContain("unpark");
  });

  test("--new-intent bypasses the parked terminal and keeps its description guard", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    park(proj);

    const valid = runNext(proj, [
      "--new-intent",
      "--scope",
      "bugfix",
      "fix the unrelated login bug",
    ]).out;
    expect(valid).toContain('"kind":"print"');
    expect(valid).toContain("intent create --scope bugfix");
    expect(valid).not.toContain('"kind":"parked"');

    const missing = runNext(proj, ["--new-intent", "--scope", "bugfix"]).out;
    expect(missing).toContain('"kind":"error"');
    expect(missing).toContain("requires a nonblank new-work description");
    expect(missing).not.toContain('"kind":"parked"');
  });

  test("stale parked (Current Stage advanced past Parked At Stage) is ignored", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    park(proj);
    // Advance Current Stage past the parked slug - the marker is now stale.
    spawnSync(BUN, [STATE, "set", "Current Stage=scope-definition", "--project-dir", proj], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      cwd: proj,
      env: directStateEnv,
    });
    const out = runNext(proj, []).out;
    expect(out).not.toContain('"kind":"parked"');
    expect(out).toContain('"kind":"run-stage"');
  });

  test("after unpark, a plain next no longer parks", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    park(proj);
    spawnSync(BUN, [STATE, "unpark", "--project-dir", proj], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      cwd: proj,
      env: directStateEnv,
    });
    const out = runNext(proj, []).out;
    expect(out).not.toContain('"kind":"parked"');
    expect(out).toContain('"kind":"run-stage"');
  });

  // The person parked ("stop for now"), then came back in the same chat with a
  // bare /aidlc: the work carries on, with no "resume with --resume" retype.
  // The reply that asked for the park came before it, so the agent's own loop
  // never carries on past a park; the Stop hook's probe still sees the park.
  test("a bare next after the person came back to a parked workflow carries on", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    appendAuditEntry("HUMAN_TURN", {}, proj);
    park(proj);
    expect(runNext(proj, []).out).toContain('"kind":"parked"');
    appendAuditEntry("HUMAN_TURN", { Reply: "command" }, proj);
    const back = JSON.parse(runNext(proj, []).out) as { kind: string; message: string };
    expect(back.kind).toBe("print");
    expect(back.message).toContain("aidlc-state.ts unpark");
    expect(back.message).toContain("then re-run `next` to continue");
    expect(runNext(proj, [], { AIDLC_STOP_HOOK_PROBE: "1" }).out).toContain('"kind":"parked"');
    // A setting typed after the park is not dropped for a plain carry-on.
    expect(runNext(proj, ["--depth", "minimal"]).out).not.toContain("then re-run `next` to continue");
  });

  test("the person's words after a park are read, never answered with the park", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    park(proj);
    expect(runNext(proj, ["take me back to intent capture"]).out).toContain('"kind":"parked"');
    appendAuditEntry("HUMAN_TURN", {}, proj);
    const read = JSON.parse(runNext(proj, ["take me back to intent capture"]).out) as { kind: string; message: string };
    expect(read.kind).toBe("print");
    expect(read.message).toContain("report --result resumed --choice <redo|jump|fresh>");
  });

  // The person came back after the park with words about the work, was asked
  // where they belong, and chose "part of that work, continue it": the work
  // carries on, as it does for a bare next; it is not answered with the park.
  test("after a park, choosing to continue the work in progress carries on, never parks again", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    park(proj);
    appendAuditEntry("HUMAN_TURN", {}, proj);
    const words = "also compare the two biggest competitors on pricing";
    const said = JSON.parse(runNext(proj, [words]).out) as { kind: string; message?: string };
    expect(said.kind, JSON.stringify(said)).toBe("print");
    const request = /`[^`]* next (--request [0-9a-f]{8})`/.exec(said.message ?? "")?.[1];
    expect(request, said.message).toBeDefined();
    const asked = JSON.parse(runNext(proj, (request as string).split(" ")).out) as {
      kind: string; ask_type?: string; continue_command?: string;
    };
    expect(asked.ask_type, JSON.stringify(asked)).toBe("new-work-routing");
    appendAuditEntry("HUMAN_TURN", {}, proj);
    const chosen = (asked.continue_command ?? "").replace(/^.* next /, "").split(" ");
    const back = JSON.parse(runNext(proj, chosen).out) as { kind: string; message?: string };
    expect(back.kind, JSON.stringify(back)).toBe("print");
    expect(back.message).toContain("aidlc-state.ts unpark");
    expect(back.message).toContain("then re-run `next` to continue");
    spawnSync(BUN, [STATE, "unpark", "--project-dir", proj], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: proj, env: directStateEnv,
    });
    expect(JSON.parse(runNext(proj, []).out).kind).toBe("run-stage");
  });
});

// ===========================================================================
// Branch 9c - mid-flow freeform prose -> routing ask (the offer backstop).
// Fresh-start prose gets Branch 8's routing ask; mid-flow prose used to fall
// through to Branch 10 with the typed text silently discarded, which let a
// conductor skip the continue-vs-new-work judgment and pour new-work prose
// into the active intent's stage. The engine now surfaces the question.
// ===========================================================================
describe("t114 mid-flow freeform prose -> routing ask (Branch 9c)", () => {
  // Words alone over active work may ask to redo, jump, or start fresh: the
  // engine hands the conductor both readings, and `next --request` is the
  // routing ask with the words kept.
  function askedAbout(words: string): string {
    const read = JSON.parse(runNext(proj, [words]).out) as { kind: string; message: string };
    expect(read.kind, read.message).toBe("print");
    const request = /`[^`]* next (--request [0-9a-f]{8})`/.exec(read.message)?.[1];
    expect(request, read.message).toBeDefined();
    return runNext(proj, request!.split(" ")).out;
  }

  test("words alone over an active workflow may be a redo, jump, or fresh start: both readings, the words kept", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const read = JSON.parse(runNext(proj, ["take me back to intent capture"]).out) as { kind: string; message: string };
    expect(read.kind).toBe("print");
    expect(read.message).toContain("may ask to redo, jump to a stage, or start fresh");
    expect(read.message).toContain("report --result resumed --choice <redo|jump|fresh>");
    expect(read.message).toContain("--target <stage slug>");
    expect(read.message).toMatch(/next --request [0-9a-f]{8}`/);
    // When the agent cannot tell, the engine's own question asks the person, so
    // the turn ends at a question the Stop hook honours.
    expect(read.message).toContain("or you cannot tell which, run");
    expect(read.message).not.toContain("ask the person in one short question");
    // None of the person's words ride the directive.
    expect(read.message).not.toContain("intent capture");
    // The same words asked about as work keep them.
    const ask = JSON.parse(askedAbout("take me back to intent capture")) as { ask_type?: string; new_work_description?: string };
    expect(ask.ask_type).toBe("new-work-routing");
    expect(ask.new_work_description).toBe("take me back to intent capture");
  });

  test("a setting typed with the words is asked about with them, as before", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, ["--depth", "minimal", "a completely separate standalone metrics dashboard"]).out;
    expect(out).toContain('"ask_type":"new-work-routing"');
  });

  test("freeform prose over an active workflow -> ask carrying both texts", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = askedAbout("a completely separate standalone metrics dashboard");
    const directive = JSON.parse(out) as {
      ask_type?: string;
      response_route?: string;
      question?: string;
      new_work_description?: string;
      proposed_scope?: string;
      numbered_prose_question?: string;
    };
    expect(out).toContain('"kind":"ask"');
    expect(directive.ask_type).toBe("new-work-routing");
    expect(directive.response_route).toBe("next");
    expect(directive.new_work_description).toBe(
      "a completely separate standalone metrics dashboard",
    );
    expect(directive.proposed_scope).toBeTruthy();
    // The ask names the active work and echoes the typed prose.
    expect(out).toContain("already in progress");
    expect(out).toContain("standalone metrics dashboard");
    // The three routes ride the question; the affirmative leads with Yes.
    expect(out).toContain("continue");
    expect(out).toContain("Yes, set it up alongside");
    expect(out).toContain("plan");
    expect(directive.question).toContain("(1)");
    expect(directive.question).toContain("(2)");
    expect(directive.question).toContain("(3)");
    expect(directive.numbered_prose_question).toContain(
      "1. **Part of the active work**",
    );
    expect(directive.numbered_prose_question).toContain("4. **Other**");
    expect(directive.question).toContain(
      `as "${directive.proposed_scope}" work`,
    );
  });

  test("keyword-matching prose names the scope a confirmed new intent would get", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = askedAbout("fix the broken login button");
    expect(out).toContain('"kind":"ask"');
    expect(out).toContain('as \\"bugfix\\" work');
    expect(out).toContain('"proposed_scope":"bugfix"');
  });

  test("bare next still advances the current stage (no ask without prose)", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, []).out;
    expect(out).toContain('"kind":"run-stage"');
    expect(out).not.toContain('"kind":"ask"');
  });

  // Arden decision 6: words typed with a differing --scope over open work are
  // never dropped. One question, new work first (what the words most often
  // mean): new work with that scope, or a scope change for the open work.
  test("prose WITH a differing --scope asks once: new work with it first, or change the open work's scope", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION); // scope: feature
    const out = runNext(proj, ["--scope", "bugfix", "fix the login flow"]).out;
    const directive = JSON.parse(out) as {
      kind?: string; ask_type?: string; proposed_scope?: string; question?: string; numbered_prose_question?: string;
      new_intent_command?: string; continue_command?: string; new_work_description?: string;
    };
    expect(directive.kind).toBe("ask");
    expect(directive.ask_type).toBe("new-work-routing");
    expect(directive.new_work_description).toBe("fix the login flow");
    expect(directive.proposed_scope).toBe("bugfix");
    expect(directive.new_intent_command).toContain("--new-intent --scope bugfix");
    expect(directive.continue_command).toContain("--continue --request ");
    expect(directive.continue_command).toContain("--scope bugfix");
    expect(directive.question).toContain('(1) a separate new piece of work - start new "bugfix" work for it');
    expect(directive.question).toContain('(2) part of that work - change it to "bugfix"');
    expect(directive.numbered_prose_question).toContain(
      '1. **Separate new piece of work** — Start new "bugfix" work for it; the current work stays as it is',
    );
    expect(directive.numbered_prose_question).toContain(
      '2. **Part of the active work** — Change the current workflow to "bugfix" and continue it',
    );
  });

  test("a bare 1 to that question starts the new work with the typed scope", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    runNext(proj, ["--scope", "bugfix", "fix the login flow"]);
    const out = runNext(proj, ["1"]).out;
    expect(out).toContain("intent create --scope bugfix --request ");
    expect(out).not.toContain("scope change");
  });

  // A prose harness hands the reply to `next` as the person typed it.
  for (const reply of ["2", "Part of the active work"]) {
    test(`a reply of "${reply}" to that question changes the open work's scope`, () => {
      proj = createOrchestrationTestProject();
      seedStateFile(proj, MID_IDEATION);
      runNext(proj, ["--scope", "bugfix", "fix the login flow"]);
      const out = runNext(proj, [reply]).out;
      expect(out).toContain('"kind":"print"');
      expect(out).toContain("scope change --scope bugfix");
    });
  }

  test("only the open-work answer carries the scope change", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const asked = JSON.parse(runNext(proj, ["--scope", "bugfix", "fix the login flow"]).out) as { compose_command?: string };
    expect(asked.compose_command).not.toContain("--scope");
  });

  test("the open-work answer to that question changes its scope", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const asked = JSON.parse(runNext(proj, ["--scope", "bugfix", "fix the login flow"]).out) as { continue_command?: string };
    const args = (asked.continue_command ?? "").split(" ");
    const out = runNext(proj, args.slice(args.indexOf("next") + 1)).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("scope change --scope bugfix");
  });

  test("a differing --scope with no words still changes scope", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, ["--scope", "bugfix"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("scope change --scope bugfix");
  });

  test("--new-intent with prose still creates (Branch 4a precedes the ask)", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, ["--new-intent", "--scope", "poc", "a standalone dashboard"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("intent create");
  });

  test("same-scope --scope + new description over in-flight work proposes the typed scope", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION); // scope: feature, mid-Ideation
    const out = runNext(proj, ["--scope", "feature", "a standalone metrics dashboard"]).out;
    const directive = JSON.parse(out) as { kind?: string; ask_type?: string; proposed_scope?: string; new_intent_command?: string };
    expect(directive.kind).toBe("ask");
    expect(directive.ask_type).toBe("new-work-routing");
    // The scope the person typed, never one inferred from the words.
    expect(directive.proposed_scope).toBe("feature");
    expect(directive.new_intent_command).toContain("--new-intent --scope feature");
  });
});

// ===========================================================================
// Branch 4d - a NEW description over a FINISHED workflow (issue #1535).
// A finished workflow cannot take a description. It used to fall through to
// a plain `done` (`--scope <same>`) or to Branch 9c's "work is already in
// progress" question (prose alone), so the person who asked to start new work
// was told the old work was finished, or asked whether to continue it. A typed
// scope now starts the new work with that scope; prose alone gets the
// fresh-start plan offer. A bare `next` still reports `done`.
// ===========================================================================
describe("t114 new description over a finished workflow -> new work (#1535)", () => {
  for (const typed of ["feature", "bugfix"]) {
    test(`--scope ${typed} + new description starts new ${typed} work, not done`, () => {
      proj = createOrchestrationTestProject();
      seedStateFile(proj, COMPLETED); // scope: feature, all stages [x]
      const out = runNext(proj, ["--scope", typed, "a standalone metrics dashboard"]).out;
      const directive = JSON.parse(out) as { kind?: string; message?: string };
      expect(directive.kind).toBe("print");
      expect(directive.message).toContain(`intent create --scope ${typed} --request `);
      expect(out).not.toContain("already in progress");
      expect(out).not.toContain("scope change");
    });
  }

  test("prose alone over a finished workflow gets the fresh-start plan offer", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, COMPLETED);
    const out = runNext(proj, ["a standalone metrics dashboard"]).out;
    const directive = JSON.parse(out) as { kind?: string; ask_type?: string };
    expect(directive.kind).toBe("ask");
    expect(directive.ask_type).not.toBe("new-work-routing");
    expect(out).not.toContain("already in progress");
    expect(out).not.toContain("Continue the current workflow");
  });

  test("bare next over a completed workflow still reports done (no description)", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, COMPLETED);
    const out = runNext(proj, []).out;
    expect(out).toContain('"kind":"done"');
    expect(out).not.toContain('"kind":"ask"');
  });

  test("--resume over a finished workflow keeps its own path", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, COMPLETED);
    const out = runNext(proj, ["--resume", "a standalone metrics dashboard"]).out;
    expect(out).not.toContain("intent create");
  });
});

// ===========================================================================
// Branch 9c - replies that are not new work. The answer to the current
// stage's open logged question (the Stop hook's DECISION_RECORDED pairing) and
// the routing ask's own option given back as prose used to come back as a
// fresh new-work routing ask, which asked the same question again forever.
// ===========================================================================
describe("t114 Branch 9c: replies that are not new work", () => {
  const ANSWER =
    "Keep phase-readiness interpretation, Keep no-budget-ceiling interpretation";
  const NEW_WORK = "a completely separate standalone metrics dashboard";
  type Row = { event: string; stage?: string; at?: string; checkpoint?: string };
  function seedAudit(rows: Row[]): void {
    mkdirSync(seededAuditDir(proj), { recursive: true });
    appendFileSync(
      seededAuditShard(proj),
      rows
        .map(({ event, stage, at, checkpoint }, i) =>
          `## ${event}\n**Timestamp**: ${at ?? `2026-09-28T23:0${i}:00Z`}\n**Event**: ${event}\n` +
          (stage ? `**Stage**: ${stage}\n` : "") +
          (checkpoint ? `**Checkpoint**: ${checkpoint}\n` : "") +
          (event === "DECISION_RECORDED"
            ? "**Decision**: Feasibility learning candidates\n**Options**: Keep phase-readiness interpretation,Keep no-budget-ceiling interpretation\n"
            : "") +
          "\n---\n")
        .join(""),
      "utf-8",
    );
  }
  const openDecision: Row[] = [
    { event: "STAGE_STARTED", stage: "feasibility" },
    { event: "DECISION_RECORDED", stage: "feasibility" },
  ];
  const questionDir = () => join(proj, "aidlc", ".aidlc-sessions", "questions");
  const storedQuestions = (): Array<{ id: string; text: string; stateSha256?: string }> =>
    existsSync(questionDir())
      ? readdirSync(questionDir()).map((name) => JSON.parse(readFileSync(join(questionDir(), name), "utf-8")))
      : [];
  type Directive = {
    kind: string;
    ask_type?: string;
    message?: string;
    stage?: string;
    new_work_description?: string;
    numbered_prose_question?: string;
    continue_command?: string;
    new_intent_command?: string;
    compose_command?: string;
  };
  const directive = (args: string[]) => JSON.parse(runNext(proj, args).out) as Directive;
  // The engine's own command, run as emitted (every word after `next`).
  const runCommand = (command: string) =>
    directive(command.slice(command.indexOf(" next ") + " next ".length).split(" ").filter(Boolean));
  const requestCommand = (message: string): string =>
    (message.match(/`([^`]*next --request [0-9a-f]{8})`/) ?? [])[1] ?? "";
  // Words alone over active work first get the re-entry readings (a redo,
  // jump, or fresh start, or else this); their `next --request` asks about
  // them as work, the words kept.
  const asWork = (args: string[]): Directive => {
    const read = directive(args);
    expect(read.kind, JSON.stringify(read).slice(0, 300)).toBe("print");
    expect(read.message).toContain("may ask to redo, jump to a stage, or start fresh");
    return runCommand(requestCommand(read.message!));
  };
  const routingAsk = (): Directive => {
    const ask = asWork([NEW_WORK]);
    expect(ask.ask_type).toBe("new-work-routing");
    return ask;
  };

  test("prose over the [-] stage's open logged question gets a command for each reading", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAudit(openDecision);
    const d = directive([ANSWER]);
    expect(d.kind).toBe("print");
    expect(d.ask_type).toBeUndefined();
    expect(d.message).toContain('Stage "feasibility" has a question you asked');
    expect(d.message).toContain("answer --stage feasibility --details");
    expect(requestCommand(d.message!)).not.toBe("");
    expect(d.message).toContain("If you cannot tell which it is, ask the person");
    // The person's words are kept for the other reading; neither they nor the
    // question's audit text ride the directive.
    expect(storedQuestions().map((q) => q.text)).toEqual([ANSWER]);
    expect(storedQuestions()[0].stateSha256).toBeUndefined();
    expect(d.message).not.toContain("Feasibility learning candidates");
    expect(d.message).not.toContain(ANSWER);
  });

  test("new work said over an open question is asked about, never re-shown the question", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAudit(openDecision);
    const d = directive([NEW_WORK]);
    const routed = runCommand(requestCommand(d.message!));
    expect(routed.ask_type, JSON.stringify(routed).slice(0, 300)).toBe("new-work-routing");
    expect(routed.new_work_description).toBe(NEW_WORK);
    // Its own options still answer it while the question stays open.
    expect(directive(["2"])).toEqual(runCommand(routed.new_intent_command!));
  });

  // Non-default values, so a scope's own defaults cannot hide a loss.
  test("settings typed with new work over an open question ride on to the work it becomes", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAudit(openDecision);
    const d = directive(["--depth", "comprehensive", "--test-strategy", "minimal", "--learnings", "on", NEW_WORK]);
    expect(d.message).toContain('Stage "feasibility" has a question you asked');
    const routed = runCommand(requestCommand(d.message!));
    expect(routed.ask_type, JSON.stringify(routed).slice(0, 300)).toBe("new-work-routing");
    expect(routed.new_intent_command).toContain("--depth comprehensive --test-strategy minimal --learnings on");
    // A bare "2" is that option's command, settings included.
    const created = directive(["2"]);
    expect(created.message).toContain("--depth comprehensive --test-strategy minimal");
    expect(created.message).toContain("--learnings on");
  });

  test("a bare number answers the open logged question", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAudit(openDecision);
    expect(directive(["1"]).message).toContain("answer --stage feasibility");
  });

  test("a unit or batch checkpoint is answered through its own command, never log answer", () => {
    for (const [checkpoint, command] of [
      ["Construction Unit Approval", "aidlc-bolt.ts checkpoint --action approve"],
      ["Swarm Batch Approval", "aidlc-bolt.ts swarm-checkpoint --action approve"],
    ]) {
      proj = createOrchestrationTestProject();
      seedStateFile(proj, MID_IDEATION);
      seedAudit([openDecision[0], { ...openDecision[1], checkpoint }]);
      const d = directive(["looks good, approve"]);
      expect(d.message).toContain(command);
      expect(d.message).toContain("--user-input");
      expect(d.message).not.toContain("answer --stage feasibility --details");
      cleanupTestProject(proj);
    }
  });

  test("control: autonomous Construction leaves prose to the routing ask, as the Stop hook does", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const statePath = seededStateFile(proj);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace("- **Scope**: feature", "- **Scope**: feature\n- **Construction Autonomy Mode**: autonomous"),
      "utf-8",
    );
    seedAudit(openDecision);
    expect(asWork([ANSWER]).ask_type).toBe("new-work-routing");
  });

  test("control: an answered question leaves prose to the routing ask", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAudit([...openDecision, { event: "QUESTION_ANSWERED", stage: "feasibility" }]);
    expect(asWork([ANSWER]).ask_type).toBe("new-work-routing");
  });

  test("control: another stage's open question leaves prose to the routing ask", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedAudit([
      { event: "STAGE_STARTED", stage: "scope-definition" },
      { event: "DECISION_RECORDED", stage: "scope-definition" },
    ]);
    expect(asWork([ANSWER]).ask_type).toBe("new-work-routing");
  });

  test("control: a stage that is not [-] leaves prose to the routing ask", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const statePath = seededStateFile(proj);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace("- [-] feasibility — EXECUTE", "- [ ] feasibility — EXECUTE"),
      "utf-8",
    );
    seedAudit(openDecision);
    expect(asWork([ANSWER]).ask_type).toBe("new-work-routing");
  });

  test("a stage held at its approval gate [?] reads prose as the gate's answer first", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const statePath = seededStateFile(proj);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace("- [-] feasibility — EXECUTE", "- [?] feasibility — EXECUTE"),
      "utf-8",
    );
    seedAudit(openDecision);
    const read = directive([ANSWER]);
    expect(read.kind).toBe("print");
    expect(read.ask_type).toBeUndefined();
    expect(String((read as { message?: string }).message)).toContain("report --stage feasibility --result approved");
  });

  const numberedLine = (ask: Directive, n: number): string =>
    ask.numbered_prose_question!.split("\n").find((line) => line.startsWith(`${n}. `))!;

  for (const reply of [
    "Part of the active work",
    "part of the active work.",
    "1",
    "(1)",
    "1. Part of the active work",
    "<line 1>",
  ]) {
    test(`the routing ask's continue option given back as prose (${JSON.stringify(reply)}) continues`, () => {
      proj = createOrchestrationTestProject();
      seedStateFile(proj, MID_IDEATION);
      const ask = routingAsk();
      const d = directive([reply === "<line 1>" ? numberedLine(ask, 1) : reply]);
      expect(d.kind).toBe("run-stage");
      expect(d.stage).toBe("feasibility");
      expect(d).toEqual(runCommand(ask.continue_command!));
    });
  }

  for (const reply of ["2", "Separate new piece of work", "<line 2>"]) {
    test(`the separate-work option given back as prose (${JSON.stringify(reply)}) runs the ask's own command`, () => {
      proj = createOrchestrationTestProject();
      seedStateFile(proj, MID_IDEATION);
      const ask = routingAsk();
      const d = directive([reply === "<line 2>" ? numberedLine(ask, 2) : reply]);
      expect(d.kind, JSON.stringify(d).slice(0, 300)).not.toBe("ask");
      expect(d).toEqual(runCommand(ask.new_intent_command!));
    });
  }

  for (const reply of ["3", "3. Reshape the active work", "Reshape the active work"]) {
    test(`the reshape option given back as prose (${JSON.stringify(reply)}) runs the ask's own command`, () => {
      proj = createOrchestrationTestProject();
      seedStateFile(proj, MID_IDEATION);
      const ask = routingAsk();
      const d = directive([reply]);
      expect(d.kind, JSON.stringify(d).slice(0, 300)).not.toBe("ask");
      expect(d).toEqual(runCommand(ask.compose_command!));
    });
  }

  for (const reply of ["1", "2", "Separate new piece of work"]) {
    test(`an option with no routing question asked (${JSON.stringify(reply)}) is asked about, never acted on`, () => {
      proj = createOrchestrationTestProject();
      seedStateFile(proj, MID_IDEATION);
      const d = asWork([reply]);
      expect(d.ask_type).toBe("new-work-routing");
      expect(d.new_work_description).toBe(reply);
    });
  }

  // The workflow the question asked about moves on before the person answers:
  // a revision, or a stage finished in this chat or another.
  const moveOn: Array<[string, (state: string) => string]> = [
    ["a revision", (state) => state.replace("- **Revision Count**: 0", "- **Revision Count**: 1")],
    [
      "the next stage",
      (state) =>
        state
          .replace("- [-] feasibility — EXECUTE", "- [x] feasibility — EXECUTE")
          .replace("- [ ] scope-definition — EXECUTE", "- [-] scope-definition — EXECUTE")
          .replace("- **In Progress**: feasibility", "- **In Progress**: scope-definition")
          .replace("- **Current Stage**: feasibility", "- **Current Stage**: scope-definition"),
    ],
  ];
  for (const [moved, move] of moveOn) {
    for (const [reply, route] of [
      ["2", "new_intent_command"],
      ["Separate new piece of work", "new_intent_command"],
      ["1", "continue_command"],
      ["3", "compose_command"],
    ] as const) {
      test(`an option (${JSON.stringify(reply)}) still answers after the workflow moved on to ${moved}`, () => {
        proj = createOrchestrationTestProject();
        seedStateFile(proj, MID_IDEATION);
        const ask = routingAsk();
        const statePath = seededStateFile(proj);
        const before = readFileSync(statePath, "utf-8");
        writeFileSync(statePath, move(before), "utf-8");
        expect(readFileSync(statePath, "utf-8")).not.toBe(before);
        const d = directive([reply]);
        expect(d.ask_type, JSON.stringify(d).slice(0, 300)).not.toBe("new-work-routing");
        expect(d).toEqual(runCommand(ask[route]!));
      });
    }
  }

  test("a bare number after another turn or a later question is not the routing answer; its label still is", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const ask = routingAsk();
    seedAudit([
      { event: "HUMAN_TURN", at: "2099-01-01T00:00:00Z" },
      { event: "HUMAN_TURN", at: "2099-01-01T00:01:00Z" },
    ]);
    expect(directive(["Separate new piece of work"])).toEqual(runCommand(ask.new_intent_command!));
    expect(asWork(["2"]).ask_type).toBe("new-work-routing");
  });

  test("a bare number answers a question logged after the routing question", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    routingAsk();
    seedAudit([
      { event: "STAGE_STARTED", stage: "feasibility", at: "2099-01-01T00:00:00Z" },
      { event: "DECISION_RECORDED", stage: "feasibility", at: "2099-01-01T00:01:00Z" },
    ]);
    expect(directive(["1"]).message).toContain("answer --stage feasibility");
  });

  for (const reply of [
    "Part of the active work - also add a CSV export",
    "Part of the active work, plus a metrics export",
    "1. Part of the active work - Continue the current workflow, and add CSV export",
    "2. Part of the active work",
    "4",
    "12",
  ]) {
    test(`prose that only resembles an option (${JSON.stringify(reply)}) is still asked about`, () => {
      proj = createOrchestrationTestProject();
      seedStateFile(proj, MID_IDEATION);
      routingAsk();
      const d = asWork([reply]);
      expect(d.ask_type).toBe("new-work-routing");
      expect(d.new_work_description).toBe(reply);
    });
  }
});

// ===========================================================================
// Retired flags (--init / --force) are consumed, never intent text
// ===========================================================================
// Branch 3 (`--init`) retired in P4; #847 later made unknown flag-looking
// tokens lossless task text. Together they leaked retired flags into the
// created intent's DESCRIPTION (`--arguments=--init`). These pin the repair:
// retired flags vanish, genuinely-unknown tokens still ride as task text,
// the `--` delimiter still passes a literal `--init` through, and an invocation
// containing only retired flags stops with current replacement guidance.
describe("t114 retired flags are consumed, not description text", () => {
  test("--init with --new-intent + prose creates without leaking the flag", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, [
      "--init",
      "--new-intent",
      "--scope",
      "bugfix",
      "fix the login flow",
    ]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("intent create --scope bugfix");
    expect(out).not.toContain("--init");
    expect(existsSync(engineTouchMarkerPath(proj))).toBe(true);
  });

  test("--force is likewise consumed", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, [
      "--force",
      "--new-intent",
      "--scope",
      "poc",
      "a standalone dashboard",
    ]).out;
    expect(out).toContain("intent create");
    expect(out).not.toContain("--force");
  });

  // The creation print names the request by id; the text lives in the question store.
  const pendingDescription = (project: string, out: string): string => {
    const id = out.match(/--request ([0-9a-f]{8})/)?.[1] ?? "";
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const file = join(project, "aidlc", ".aidlc-sessions", "questions", `${id}.json`);
    return JSON.parse(readFileSync(file, "utf-8")).text;
  };

  // The entry word is how the person reaches AI-DLC, never part of the work's
  // name: an agent that passes `/aidlc` or Codex's `$aidlc` on as an argument
  // still records only what the person asked for.
  test.each([
    [["/aidlc", "--new-intent", "--scope", "poc", "build auth across both repos"]],
    [["$aidlc", "--new-intent", "--scope", "poc", "build auth across both repos"]],
    [["--new-intent", "--scope", "poc", "/aidlc build auth across both repos"]],
  ])("the entry word never becomes part of the work's description: %j", (args) => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, args).out;
    expect(out).toContain("intent create");
    expect(pendingDescription(proj, out)).toBe("build auth across both repos");
  });

  test("genuinely unknown flag-looking tokens remain lossless task text (#847)", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, [
      "--new-intent",
      "--scope",
      "poc",
      "a dashboard with",
      "--dark-mode",
    ]).out;
    expect(out).toContain("intent create");
    expect(pendingDescription(proj, out)).toBe("a dashboard with --dark-mode");
  });

  test("the -- delimiter still passes a literal --init through as text", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, [
      "--new-intent",
      "--scope",
      "poc",
      "document the retired",
      "--",
      "--init",
    ]).out;
    expect(out).toContain("intent create");
    expect(pendingDescription(proj, out)).toBe("document the retired --init");
  });

  test("retired flags alone do not advance an active workflow", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const out = runNext(proj, ["--init", "--force"]).out;
    expect(out).toContain('"kind":"error"');
    expect(out).toContain("are retired");
    expect(out).toContain("--new-intent");
    expect(out).toContain("No workflow stage was run");
    expect(out).not.toContain('"kind":"run-stage"');
    expect(existsSync(engineTouchMarkerPath(proj))).toBe(false);
  });

  test("retired flags alone do not create or advance a fresh workspace", () => {
    proj = createOrchestrationTestProject();
    const out = runNext(proj, ["--force", "--init"]).out;
    expect(out).toContain('"kind":"error"');
    expect(out).toContain("are retired");
    expect(out).toContain("--scope <scope>");
    expect(out).toContain("No workflow stage was run");
    expect(out).not.toContain('"kind":"run-stage"');
    expect(out).not.toContain("intent create");
  });

  test("Codex projection keeps retired-only guidance command-neutral", () => {
    proj = createOrchestrationTestProject();
    const result = runOrchestrateNext(
      CODEX_TOOL,
      proj,
      ["--init", "--force"],
      { cwd: proj, env: process.env },
    );
    expect(result.status).toBe(0);
    expect(result.out).toContain("invoking the AI-DLC skill");
    expect(result.out).toContain("--scope <scope>");
    expect(result.out).toContain("--new-intent --scope <scope>");
    expect(result.out).not.toContain("/aidlc");
    expect(result.out).not.toContain("bun .codex");
    expect(result.out).not.toContain('"kind":"run-stage"');
  });

  test("Codex projection names doctor through its own skill prefix", () => {
    // Codex routes `$aidlc`, not `/aidlc`. The doctor pointers sit on failure
    // paths no fixture can reach, so pin the shipped source instead.
    const source = readFileSync(CODEX_TOOL, "utf-8");
    expect(source).not.toContain("/aidlc --doctor");
    expect(source).toContain("entrySkillInvocation()} --doctor");
  });
});
