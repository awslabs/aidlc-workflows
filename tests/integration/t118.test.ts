// covers: subcommand:aidlc-jump:resolve
//
// CLI-contract port of tests/integration/t118-engine-differential.sh (TAP plan 27),
// mechanism = cli. The differential corpus: cross-component, multi-step
// next/report sequences across the v0.6.0 engine (aidlc-orchestrate.ts) for the
// 7 SPECIAL PATHS the prose orchestrator handles today, plus 3 true
// cross-component WALKS — with NO MODEL IN THE LOOP. Every step SPAWNS the real
// engine binary `bun aidlc-orchestrate.ts next|report` (and the sibling tool
// `bun aidlc-jump.ts resolve`) over a seeded
// fixture and diffs the emitted directive / the audit.md the tool writes against
// a frozen golden — the PROCESS boundary (exit codes, stdout JSON, file effects),
// never an in-process call.
//
// Why spawn (not in-process): the .sh shells out to the engine and jump tool and
// asserts on (a) the directive JSON each emits on stdout, (b) the STAGE_STARTED
// rows aidlc-state.ts appends to audit.md through report's
// dispatcher, and (c) the no-state-created side effect of --init. The contract is
// the subprocess boundary plus those side effects; an in-process twin would lose
// the report-dispatcher → aidlc-state.ts subprocess seam the corpus exists to pin.
//
// COVERS UNIT: the covers id is subcommand:aidlc-jump:resolve — the corpus's load-
// bearing claim is engine-vs-tool AGREEMENT on jump DIRECTION. The engine
// DELEGATES forward/backward/redo to `aidlc-jump.ts resolve` (it does not re-derive
// the comparison); special paths 1-3 each fire `resolve` and assert its
// `"direction"` field, which is exactly what crediting subcommand:aidlc-jump
// resolve pins. (Colon form — the space form `subcommand:aidlc-jump resolve` is
// truncated at the space and credits nothing.)
//
// EQUAL-OR-STRONGER PARITY (every .sh assert -> one expect()-bearing test()):
//   SP1 jump forward (2):
//     - .sh `json_field kind|stage == run-stage|code-generation` -> Test 1:
//       kind==="run-stage" AND stage==="code-generation" (split into two
//       expect()s on the parsed directive; same observable).
//     - .sh `assert_contains DIR '"direction":"forward"'` -> Test 2:
//       resolve's parsed `.direction` === "forward" (STRONGER: exact field
//       value, not a substring grep).
//   SP2 jump backward (2): mirror of SP1 with feasibility / "backward".
//   SP3 jump redo   (2): --stage == current; run-stage(code-generation) +
//       resolve `.direction` === "redo".
//   SP4 resume (2): direct routing reaches run-stage(code-generation).
//   SP5 creation (P4: --init retired, engine names intent-create):
//     - (a) named scope on a clean workspace -> kind==="print" naming
//       intent-create + NO aidlc-state.md created by next (read-only — mutation
//       stays conductor-side).
//     - (b) named scope over existing state -> NOT a creation (no intent-create
//       print; the old --force re-init guard is gone).
//   SP6 scope-change (2): kind==="print" + out contains "scope-change --scope mvp".
//   SP7 normal gate (1):
//     - report --result approved --user-input -> kind==="done".
//       (The --test-run round-trip was dropped per #369; only the normal-gate
//       control survives.)
//   WALK A non-gated advance (3): N1 stage==="workspace-detection" gate===false;
//     report contains "Committed advance for"; N2 stage==="state-init".
//   WALK B gated approve (3): N1 stage==="feasibility" gate===true; STAGE_STARTED
//     count===1 (no double-advance); N2 stage==="scope-definition".
//   WALK C classify round-trip (3) — v0.6.0 Wave 2 milestone 9, per the engine
//     design, .sh:235-260: the skeleton-stance classify round-trip across the report
//     dispatcher's STANCE branch AND the next decision rule's gate computation:
//     - .sh step 1 `stage|gate == functional-design|unresolved` -> N1
//       stage==="functional-design" AND gate==="unresolved" (the STRING, not the
//       boolean: the engine cannot compute the skeleton gate, so it emits the
//       gate UNRESOLVED for the conductor to classify).
//     - .sh step 2 `report --skeleton-stance on` kind==="print" -> the report
//       dispatcher records the typed stance and commits NO transition (a print,
//       not done/advance) — STRONGER: also pins the recorded-stance message text.
//     - .sh step 3 `stage|gate == functional-design|true` -> N2 re-emits the SAME
//       stage with the now-DETERMINED gate (boolean true). The next decision rule
//       read the recorded stance; the round-trip closes deterministically.
//
// The .sh's two-observable `assert_eq "a|b"` lines are kept as two expect()s
// inside one test(), matching the single `ok` line the .sh emitted for each.
// (The original SP7 --test-run round-trip asserts were dropped per #369 when the
// test-run mechanism was removed; only the normal-gate control survives.)
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_state_file +
// cleanup_test_project per case): each case uses a FRESH temp project dir
// (createTestProject, toPortablePath-converted on Windows so audit.md — written
// by aidlc-state.ts via toPosix(auditFilePath) — round-trips when read back),
// seeded from the same on-disk fixtures the .sh used (state-mid-ideation.md,
// state-jumped.md, state-pre-workspace-detection.md, state-construction-bolt1.md).
// Nothing is written under tests/fixtures/**. All temp dirs cleaned in afterAll.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { setDefaultTimeout, afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  runOrchestrateNext,
  seedAidlcMemory,
  seededAuditDir,
  seededStateFile,
  seedStateFile,
  resetAidlcEnv,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const ORCHESTRATE = join(TOOLS, "aidlc-orchestrate.ts");
const JUMP = join(TOOLS, "aidlc-jump.ts");

// Clear leaked AWS_AIDLC_DEFAULT_SCOPE so scope resolves from the state file
// (mirrors the .sh's reset_aidlc_env at line 54).
resetAidlcEnv();

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

function run(
  tool: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliResult {
  const res = spawnSync(BUN, [tool, ...args], { encoding: "utf-8", env });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/** Fresh temp project seeded from a FIXTURES_DIR state fixture. Seeds the
 *  shipped method tree too: since the load-steering migration, `next` on a
 *  run-stage route FAILS CLOSED when a required rule file is missing, so a
 *  walk that reaches run-stage needs the memory tree the engine ships. */
function projWithState(fixtureName: string): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAidlcMemory(p);
  seedStateFile(p, join(FIXTURES_DIR, fixtureName));
  return p;
}

/** Steering-aware `next`: consume load-steering parts, return the routing
 *  directive (t248 owns the transport; these walks assert routing). */
// biome-ignore lint/suspicious/noExplicitAny: directives are a typed union; the test reads scalar fields
function nextDirective(p: string, args: string[] = []): any {
  const r = runOrchestrateNext(ORCHESTRATE, p, args);
  expect(r.directive).not.toBeNull();
  return r.directive;
}

/** Fresh CLEAN temp project — an empty workspace, NO intent record (SP5a). P9:
 *  createTestProject seeds a default record + cursor, so strip it; otherwise the
 *  engine resolves the seeded intent instead of naming intent-create. */
function cleanProj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  removeWorkspaceRecord(p);
  return p;
}

// P9 per-intent layout. seedStateFile writes the record's aidlc-state.md; the
// audit lands in the record's per-clone shard dir (deterministic — the fixture
// pins the clone-id). statePath is the record's state file; readAudit globs the
// shard dir.
const statePath = (p: string): string => seededStateFile(p);
function readAudit(p: string): string {
  const dir = seededAuditDir(p);
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(dir, f), "utf-8"))
    .join("\n");
}

// Parse the single directive JSON the engine emits on stdout (mirrors the .sh's
// json_field python helper, but as a real JSON.parse of the whole object).
// biome-ignore lint/suspicious/noExplicitAny: directives are a typed union; the test reads scalar fields
function directive(r: CliResult): any {
  return JSON.parse(r.stdout.trim());
}

/**
 * Count audit blocks with `**Event**: <ev>` on a line by itself — mirrors the
 * .sh count_event helper `grep -c "\*\*Event\*\*: $2$"` (end-anchored).
 */
function eventCount(p: string, ev: string): number {
  return readAudit(p)
    .split("\n")
    .filter((l) => l === `**Event**: ${ev}`).length;
}

// ============================================================
// Special path 1: JUMP FORWARD — engine DELEGATES direction to aidlc-jump.ts
// resolve; corpus pins engine-vs-tool agreement (covers subcommand:aidlc-jump resolve).
// ============================================================

describe("t118 differential corpus — engine vs aidlc-jump resolve (migrated from t118-engine-differential.sh, plan 24)", () => {
  // A WITH-STATE jump is a MUTATION (mark intervening [S], emit STAGE_JUMPED,
  // pivot Current Stage) the conductor commits, so `next --stage <fp>` emits a
  // `print` naming `aidlc-jump.ts execute` carrying the resolved target +
  // direction, NOT a run-stage (the v0.6.0 engine cutover; pre-cutover this
  // emitted run-stage directly, producing ZERO state change — the regression
  // t24/t25/t26/t56/t57 caught). The corpus still pins engine-vs-tool agreement
  // on the resolved direction.
  test("SP1: jump forward -> print naming execute(code-generation), resolve direction=forward", () => {
    const p = projWithState("state-mid-ideation.md");
    const out = directive(
      run(ORCHESTRATE, ["next", "--stage", "code-generation", "--project-dir", p]),
    );
    expect(out.kind).toBe("print");
    expect(out.message).toContain("execute --target code-generation --direction forward");
    const res = run(JUMP, [
      "resolve",
      "--stage",
      "code-generation",
      "--scope",
      "feature",
      "--project-dir",
      p,
    ]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim()).direction).toBe("forward");
  });

  // SP1-exec: a forward `aidlc-jump.ts execute` does NOT auto-terminate the
  // workflow (issue #369: the test-run forward-jump terminal-stop branch was
  // removed; a forward jump now ALWAYS lands Running). The deterministic guard
  // the deleted t54-compaction-and-test-run.test.ts used to carry - its SDK twin
  // (t56/t26) is claude-gated and skips without the live CLI, so this is the only
  // non-live test that pins the always-Running invariant. Asserts all three
  // observables: the tool's stdout JSON workflow_stopped:false, the post-jump
  // state Status:Running, and the audit STAGE_STARTED-present / WORKFLOW_COMPLETED-
  // absent pair (a re-introduced terminal branch would flip any one of these).
  test("SP1-exec: forward execute lands Running (workflow_stopped:false, STAGE_STARTED, no WORKFLOW_COMPLETED)", () => {
    const p = projWithState("state-mid-ideation.md");
    const res = run(JUMP, [
      "execute",
      "--target",
      "code-generation",
      "--direction",
      "forward",
      "--scope",
      "feature",
      "--project-dir",
      p,
    ]);
    expect(res.status).toBe(0);
    const jump = JSON.parse(res.stdout.trim());
    // The jump committed and did NOT stop the workflow.
    expect(jump.workflow_stopped).toBe(false);
    // Post-jump state: the target is Active and Running, never Completed.
    const state = readFileSync(statePath(p), "utf-8");
    expect(state).toContain("- **Status**: Running");
    expect(state).toContain("- **Current Stage**: code-generation");
    // Audit symmetry: the target emitted STAGE_STARTED; no terminal row.
    expect(eventCount(p, "STAGE_STARTED")).toBeGreaterThanOrEqual(1);
    expect(eventCount(p, "WORKFLOW_COMPLETED")).toBe(0);
  });

  // ============================================================
  // Special path 2: JUMP BACKWARD
  // ============================================================
  test("SP2: jump backward -> print naming execute(feasibility), resolve direction=backward", () => {
    const p = projWithState("state-jumped.md");
    const out = directive(
      run(ORCHESTRATE, ["next", "--stage", "feasibility", "--project-dir", p]),
    );
    expect(out.kind).toBe("print");
    expect(out.message).toContain("execute --target feasibility --direction backward");
    const res = run(JUMP, [
      "resolve",
      "--stage",
      "feasibility",
      "--scope",
      "feature",
      "--project-dir",
      p,
    ]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim()).direction).toBe("backward");
  });

  // ============================================================
  // Special path 3: JUMP REDO — --stage == current (golden derived from the
  // tool, proven in t19-tool-jump: resolve -> "redo").
  // ============================================================
  test("SP3: jump redo -> print naming execute(code-generation), resolve direction=redo", () => {
    const p = projWithState("state-jumped.md");
    const out = directive(
      run(ORCHESTRATE, ["next", "--stage", "code-generation", "--project-dir", p]),
    );
    expect(out.kind).toBe("print");
    expect(out.message).toContain("execute --target code-generation --direction redo");
    const res = run(JUMP, [
      "resolve",
      "--stage",
      "code-generation",
      "--scope",
      "feature",
      "--project-dir",
      p,
    ]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim()).direction).toBe("redo");
  });

  // ============================================================
  // Special path 4: RESUME — explicit intent continues through normal routing.
  // ============================================================
  test("SP4: resume -> run-stage(code-generation) through steering-aware routing", () => {
    const p = projWithState("state-jumped.md");
    const d = nextDirective(p, ["--resume"]);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("code-generation");
  });

  test("SP4b: resume answer -> read-only print that continues through next", () => {
    const p = projWithState("state-jumped.md");
    const before = readFileSync(statePath(p), "utf-8");
    const r = run(ORCHESTRATE, [
      "report",
      "--result",
      "resumed",
      "--user-input",
      "Resume from last checkpoint",
      "--project-dir",
      p,
    ]);
    const d = directive(r);
    expect(d.kind).toBe("print");
    expect(d.message).toContain("Re-run `next`");
    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
  });

  test("SP4c: every resume-menu choice routes to its own move; garbage errors; state untouched", () => {
    const p = projWithState("state-jumped.md");
    const before = readFileSync(statePath(p), "utf-8");
    const report = (answer: string) =>
      directive(run(ORCHESTRATE, [
        "report",
        "--result",
        "resumed",
        "--user-input",
        answer,
        "--project-dir",
        p,
      ]));

    const redo = report("Redo the current stage");
    expect(redo.kind).toBe("print");
    expect(redo.message).toContain("aidlc-jump.ts execute");
    expect(redo.message).toContain("--direction redo");

    const jump = report("Jump to a stage");
    expect(jump.kind).toBe("print");
    expect(jump.message).toContain("next --stage");
    // A stage the person already named is never asked for again.
    expect(jump.message).toContain("for the stage the person named");
    expect(jump.message).not.toContain("Ask the human which stage to jump to");

    const fresh = report("Start fresh");
    expect(fresh.kind).toBe("print");
    expect(fresh.message).toContain("--new-intent");

    const garbage = report("something unrecognizable");
    expect(garbage.kind).toBe("error");
    expect(garbage.message).toContain("Unrecognized resume choice");

    // Every round-trip above is read-only: report routes, the conductor acts.
    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
  });

  test("SP4d: exact numbered resume-menu answers map to the four semantic choices", () => {
    const p = projWithState("state-jumped.md");
    const before = readFileSync(statePath(p), "utf-8");
    const report = (answer: string) =>
      directive(run(ORCHESTRATE, [
        "report",
        "--result",
        "resumed",
        "--user-input",
        answer,
        "--project-dir",
        p,
      ]));

    expect(report("1").message).toContain("Re-run `next`");
    expect(report("2").message).toContain("--direction redo");
    expect(report("3").message).toContain("next --stage");
    expect(report("4").message).toContain("--new-intent");

    const outOfRange = report("5");
    expect(outOfRange.kind).toBe("error");
    expect(outOfRange.message).toContain("Accepted choices: 1/resume");
    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
  });

  test("SP4f: a redo never runs text from the state file", () => {
    const p = projWithState("state-jumped.md");
    const state = readFileSync(statePath(p), "utf-8");
    const report = (...extra: string[]) =>
      directive(run(ORCHESTRATE, ["report", "--result", "resumed", ...extra, "--project-dir", p]));
    writeFileSync(statePath(p), state.replace(/^- \*\*Scope\*\*: .*$/m, "- **Scope**: feature; touch pwned"), "utf-8");
    // A saved scope that is not a scope name prints no command, as everywhere.
    for (const extra of [["--choice", "redo"], ["--user-input", "2"]]) {
      const r = run(ORCHESTRATE, ["report", "--result", "resumed", ...extra, "--project-dir", p]);
      expect(r.status).not.toBe(0);
      expect(r.stdout).toBe("");
      expect(r.out).toContain("is not a scope name, so no command was printed");
      expect(r.out).not.toContain("touch pwned");
    }
    // A blank or unknown saved scope gets no redo command either, never a default plan.
    for (const saved of ["", "nosuchscope"]) {
      writeFileSync(statePath(p), state.replace(/^- \*\*Scope\*\*: .*$/m, `- **Scope**: ${saved}`), "utf-8");
      for (const r of [report("--choice", "redo"), report("--user-input", "2")]) {
        expect(r.kind, saved).toBe("error");
        expect(r.message).toContain("cannot be redone from here");
        expect(r.message).not.toContain("--direction redo");
      }
    }
    writeFileSync(statePath(p), state.replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation$(touch pwned)"), "utf-8");
    for (const r of [
      report("--choice", "redo"),
      report("--user-input", "2"),
      report("--choice", "redo", "--unit", "beta"),
      report("--choice", "redo", "--every-unit"),
    ]) {
      expect(r.kind).toBe("error");
      expect(r.message).not.toContain("touch pwned");
    }
  });

  test("SP4e: a typed re-entry request gets a complete command; the person's words are never classified", () => {
    const p = projWithState("state-jumped.md");
    const before = readFileSync(statePath(p), "utf-8");
    const report = (...extra: string[]) =>
      directive(run(ORCHESTRATE, [
        "report", "--result", "resumed", ...extra, "--project-dir", p,
      ]));
    const words = (text: string) => ["--user-input", text];

    // Words no keyword would match still route, because the conductor typed them.
    const back = report("--choice", "jump", "--target", "requirements-analysis",
      ...words("take me back to requirements analysis"));
    expect(back.kind).toBe("print");
    expect(back.message).toContain("Run `next --stage requirements-analysis`");
    expect(back.message).not.toContain("<slug>");

    const unnamed = report("--choice", "jump", ...words("let's go somewhere else"));
    expect(unnamed.kind).toBe("print");
    expect(unnamed.message).toContain("Ask the person which stage");

    const unknown = report("--choice", "jump", "--target", "no-such-stage", ...words("go to the moon"));
    expect(unknown.kind).toBe("error");
    expect(unknown.message).toBe('No stage is named "no-such-stage". Say the stage again by its name.');

    // A fresh start carries none of the person's words: the new work starts the
    // way new work always does, with their description quoted shell-safe.
    const fresh = report("--choice", "fresh");
    expect(fresh.kind).toBe("print");
    expect(fresh.message).toContain("run `next --new-intent` with their description as one single-quoted argument");
    expect(fresh.message).toContain("ask them if they have not");
    expect(fresh.message).not.toContain("<scope>");

    const redo = report("--choice", "redo", ...words("do this one again please"));
    expect(redo.message).toContain("--direction redo");

    const resume = report("--choice", "resume", ...words("keep going"));
    expect(resume.message).toContain("Re-run `next`");

    const wrong = report("--choice", "sideways", ...words("hmm"));
    expect(wrong.kind).toBe("error");
    expect(wrong.message).toContain('Unknown --choice "sideways"');

    // "Redo <stage>" never drops the stage it names: the current stage is a
    // plain redo, a stage that ran is the jump back to it, and a stage that has
    // not run has nothing to redo.
    const redoHere = report("--choice", "redo", "--target", "code-generation");
    expect(redoHere.kind).toBe("print");
    expect(redoHere.message).toContain("--direction redo");
    const redoThere = report("--choice", "redo", "--target", "market-research");
    expect(redoThere.kind).toBe("print");
    expect(redoThere.message).toContain("Run `next --stage market-research`");
    // The error is shown to the person as written: it says what happened and
    // what they can say, never an agent's instruction or a flag.
    const forThePerson = (message: string) => {
      for (const internal of ["Tell the person", "--target", "--choice", "Report again"]) {
        expect(message).not.toContain(internal);
      }
    };
    for (const [notRun, name] of [["requirements-analysis", "Requirements Analysis"], ["build-and-test", "Build and Test"]]) {
      const r = report("--choice", "redo", "--target", notRun);
      expect(r.kind).toBe("error");
      expect(r.message).toBe(
        `${name} has not run yet, so there is nothing to redo. ` +
          `Say "jump to ${name}" to go there now, or "redo" to redo the step you are on.`,
      );
      forThePerson(r.message);
      // Asked for named Units or every Unit, a stage that is not a per-unit
      // step and has not run is still not run: never a jump ahead to it.
      for (const units of [["--every-unit"], ["--unit", "beta"]]) {
        const forUnits = report("--choice", "redo", "--target", notRun, ...units);
        expect(forUnits.kind, units.join(" ")).toBe("error");
        expect(forUnits.message).toBe(r.message);
      }
    }
    const unknownRedo = report("--choice", "redo", "--target", "no-such-stage");
    expect(unknownRedo.kind).toBe("error");
    expect(unknownRedo.message).toBe(
      'No stage is named "no-such-stage". Say the stage again by its name, or "redo" to redo the step you are on.',
    );
    forThePerson(unknownRedo.message);
    forThePerson(unknown.message);
    // Stage by stage, a per-unit step after the current one has run for no
    // Unit: a redo of it for every Unit is not run either.
    writeFileSync(
      statePath(p),
      before
        .replace("- [S] functional-design", "- [-] functional-design")
        .replace("- [-] code-generation", "- [ ] code-generation")
        .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: functional-design"),
      "utf-8",
    );
    const laterStep = report("--choice", "redo", "--target", "code-generation", "--every-unit");
    expect(laterStep.kind).toBe("error");
    expect(laterStep.message).toContain("Code Generation has not run yet, so there is nothing to redo.");
    writeFileSync(statePath(p), before, "utf-8");
    // Unit by Unit, the step the Unit is on is the current one too.
    const unitMajor = readFileSync(statePath(p), "utf-8");
    writeFileSync(
      statePath(p),
      unitMajor
        .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: functional-design\n- **Unit Stage**: code-generation"),
      "utf-8",
    );
    // Redone, never just navigated to, and never the block's first stage.
    const forTheStep = report("--choice", "redo", "--target", "code-generation");
    expect(forTheStep.kind).toBe("print");
    expect(forTheStep.message).toContain('Redo accepted at "code-generation"');
    expect(forTheStep.message).not.toContain("functional-design");
    expect(forTheStep.message).not.toContain("Run `next --stage");
    const forBetaStep = report("--choice", "redo", "--target", "code-generation", "--unit", "beta");
    expect(forBetaStep.message).toContain("Run `next --stage code-generation --unit beta`");
    // The block's first stage named for a Unit is that stage, not the Unit's step.
    const forBetaFirst = report("--choice", "redo", "--target", "functional-design", "--unit", "beta");
    expect(forBetaFirst.kind).toBe("print");
    expect(forBetaFirst.message).toContain("Run `next --stage functional-design --unit beta`");
    // A step beta finished while the stage's own checkbox still waits is
    // reopened for beta, never refused as not run.
    const forBetaEarlier = report("--choice", "redo", "--target", "nfr-design", "--unit", "beta");
    expect(forBetaEarlier.kind).toBe("print");
    expect(forBetaEarlier.message).toContain("Run `next --stage nfr-design --unit beta`");
    writeFileSync(
      statePath(p),
      unitMajor.replace(
        /^- \*\*Current Stage\*\*: .*$/m,
        "- **Current Stage**: functional-design\n- **Unit Stage**: code-generation\n- **Active Unit**: alpha",
      ),
      "utf-8",
    );
    const forActive = report("--choice", "redo", "--target", "code-generation");
    expect(forActive.message).toContain('Redo accepted at "code-generation"');
    expect(forActive.message).not.toContain("functional-design");
    writeFileSync(statePath(p), unitMajor, "utf-8");
    // The choice alone is enough; the person's words are not needed in the command.
    expect(report("--choice", "resume").message).toContain("Re-run `next`");

    // A jump for a Unit the person named, or for every Unit, keeps that scope.
    const forBeta = report("--choice", "jump", "--target", "requirements-analysis", "--unit", "beta");
    expect(forBeta.kind).toBe("print");
    expect(forBeta.message).toContain("Run `next --stage requirements-analysis --unit beta`");
    const forEvery = report("--choice", "jump", "--target", "requirements-analysis", "--every-unit");
    expect(forEvery.message).toContain("Run `next --stage requirements-analysis --every-unit`");
    // Redoing the step for a named Unit reopens that step for it.
    const redoBeta = report("--choice", "redo", "--unit", "beta");
    expect(redoBeta.kind).toBe("print");
    expect(redoBeta.message).toMatch(/Run `next --stage [a-z-]+ --unit beta`/);
    for (const [extra, refusal] of [
      [["--choice", "fresh", "--every-unit"], "go only with --choice redo or jump"],
      [["--choice", "resume", "--unit", "beta"], "go only with --choice redo or jump"],
      [["--choice", "jump", "--target", "requirements-analysis", "--skeleton-stance", "on"], "a report of its own"],
      [["--choice", "redo", "--single"], "a report of its own"],
      [["--choice", "jump", "--target", "requirements-analysis", "--unit", "beta", "--every-unit"], "not both"],
      [["--choice", "jump", "--target", "requirements-analysis", "--unit", "../beta"], "Invalid Unit name"],
    ] as const) {
      const refused = report(...extra);
      expect(refused.kind, extra.join(" ")).toBe("error");
      expect(refused.message, extra.join(" ")).toContain(refusal);
    }

    // The typed flags belong only to a re-entry request.
    const misplaced = directive(run(ORCHESTRATE, [
      "report", "--stage", "code-generation", "--result", "approved", "--choice", "redo", "--project-dir", p,
    ]));
    expect(misplaced.kind).toBe("error");
    expect(misplaced.message).toContain("go only with --result resumed");
    // Nor does a single-stage completion or a stance report run with them dropped.
    for (const extra of [
      ["--single", "--stage", "requirements-analysis", "--result", "completed", "--choice", "redo"],
      ["--skeleton-stance", "on", "--choice", "jump", "--target", "requirements-analysis"],
      ["--stage", "code-generation", "--result", "approved", "--every-unit"],
    ]) {
      const dropped = directive(run(ORCHESTRATE, ["report", ...extra, "--project-dir", p]));
      expect(dropped.kind, extra.join(" ")).toBe("error");
      expect(dropped.message, extra.join(" ")).toContain("go only with --result resumed");
    }

    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
  });

  test("SP4f: a redo, jump, or fresh request at an open gate is that request, never a rejection", () => {
    const p = projWithState("state-mid-ideation.md");
    run(ORCHESTRATE, [
      "report", "--stage", "feasibility", "--result", "awaiting-approval", "--project-dir", p,
    ]);
    const atGate = readFileSync(statePath(p), "utf-8");
    expect(atGate).toContain("- [?] feasibility");
    const report = (...extra: string[]) =>
      directive(run(ORCHESTRATE, ["report", "--result", "resumed", ...extra, "--project-dir", p]));

    const jump = report("--choice", "jump", "--target", "requirements-analysis");
    expect(jump.kind).toBe("print");
    expect(jump.message).toContain("Run `next --stage requirements-analysis`");
    const fresh = report("--choice", "fresh");
    expect(fresh.kind).toBe("print");
    expect(fresh.message).toContain("next --new-intent");
    const redo = report("--choice", "redo");
    expect(redo.kind).toBe("print");
    const command = /(execute --target feasibility --direction redo --scope [^`\s]+)`/
      .exec(redo.message)?.[1];
    expect(command, redo.message).toBeDefined();
    // The answers change nothing by themselves, and none is a gate answer.
    expect(readFileSync(statePath(p), "utf-8")).toBe(atGate);
    expect(eventCount(p, "GATE_REJECTED")).toBe(0);

    // The redo it names starts the stage over from the open gate, with no rejection.
    const reset = run(JUMP, [...(command as string).split(" "), "--project-dir", p]);
    expect(reset.status, reset.out).toBe(0);
    const after = readFileSync(statePath(p), "utf-8");
    expect(after).toContain("- [-] feasibility");
    expect(after).not.toContain("- [?] feasibility");
    expect(eventCount(p, "GATE_REJECTED")).toBe(0);
    expect(eventCount(p, "STAGE_REVISING")).toBe(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("SP4g: \"take me back to X and stop there\" makes the move, then parks instead of carrying on", () => {
    const p = projWithState("state-jumped.md");
    const report = (...extra: string[]) =>
      directive(run(ORCHESTRATE, ["report", "--result", "resumed", ...extra, "--project-dir", p]));
    const stopAsked = "The person also asked to stop there for now: make the move";
    const parkInstead = " park` in place of that `next` and act on its `parked` directive.";
    // Every move a re-entry request names keeps the stop the person asked for,
    // and without --park the conductor still checks their words for one.
    for (const extra of [
      ["--choice", "jump", "--target", "market-research"],
      ["--choice", "redo"],
      ["--choice", "redo", "--target", "market-research"],
      ["--choice", "redo", "--unit", "beta"],
      ["--choice", "resume"],
      ["--choice", "fresh"],
    ]) {
      const stopped = report(...extra, "--park");
      expect(stopped.kind, extra.join(" ")).toBe("print");
      expect(stopped.message, extra.join(" ")).toContain(stopAsked);
      expect(stopped.message, extra.join(" ")).toContain(parkInstead);
      const plain = report(...extra);
      expect(plain.message, extra.join(" ")).not.toContain(stopAsked);
      expect(plain.message, extra.join(" ")).toContain("If the person also asked to stop there for now, make the move");
      expect(plain.message, extra.join(" ")).toContain(parkInstead);
    }
    // An error or a question back to the person names no move to stop after.
    expect(report("--choice", "jump", "--target", "no-such-stage", "--park").message).not.toContain("park`");
    expect(report("--choice", "jump", "--park").message).not.toContain("park`");

    // Followed through: the jump is made, the park lands on the stage jumped
    // to, and nothing after it starts.
    const asked = report("--choice", "jump", "--target", "market-research", "--park");
    expect(asked.message).toContain("Run `next --stage market-research`");
    const move = directive(run(ORCHESTRATE, ["next", "--stage", "market-research", "--project-dir", p]));
    const command = /`[^`]*aidlc-jump\.ts (execute [^`]+)`/.exec(move.message)?.[1];
    expect(command, move.message).toBeDefined();
    const jumped = run(JUMP, [...(command as string).split(" "), "--project-dir", p]);
    expect(jumped.status, jumped.out).toBe(0);
    const parked = directive(run(ORCHESTRATE, ["park", "--project-dir", p]));
    expect(parked.kind).toBe("parked");
    const state = readFileSync(statePath(p), "utf-8");
    expect(state).toMatch(/^- \*\*Current Stage\*\*: market-research$/m);
    expect(state).toMatch(/^- \*\*Parked At Stage\*\*: market-research$/m);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // ============================================================
  // Special path 5: CREATE (P4: --init retired) — (a) named scope on a clean
  // workspace prints the intent-create move + creates NO state; (b) a named scope
  // over existing state is a resume/scope-change, NOT a creation.
  // ============================================================
  test("SP5a: named scope (clean) -> print naming intent-create, next creates NO state (read-only)", () => {
    const p = cleanProj();
    const r = run(ORCHESTRATE, [
      "next",
      "--scope",
      "poc",
      "--project-dir",
      p,
    ]);
    expect(directive(r).kind).toBe("print");
    expect(directive(r).message).toContain("intent create");
    // Mutation stays conductor-side: next must not have created/scaffolded state.
    expect(existsSync(statePath(p))).toBe(false);
  });

  test("SP5a positional scope + description -> creation preserves the request and does not ask", () => {
    const p = cleanProj();
    const r = run(ORCHESTRATE, [
      "next",
      "bugfix",
      "Fix",
      "duplicate",
      "todo",
      "persistence",
      "--project-dir",
      p,
    ]);
    const d = directive(r);
    expect(d.kind).toBe("print");
    expect(d.message).toContain("intent create --scope bugfix");
    const id = String(d.message).match(/--request ([0-9a-f]{8})/)?.[1] ?? "";
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const stored = JSON.parse(readFileSync(join(p, "aidlc", ".aidlc-sessions", "questions", `${id}.json`), "utf-8"));
    expect(stored.text).toBe("Fix duplicate todo persistence");
    expect(d.kind).not.toBe("ask");
    expect(existsSync(statePath(p))).toBe(false);
  });

  test("SP5b: named scope over existing state -> not a creation (no intent-create print)", () => {
    const p = projWithState("state-mid-ideation.md"); // feature scope state
    const r = run(ORCHESTRATE, ["next", "--scope", "feature", "--project-dir", p]);
    expect(r.out).not.toContain("intent-create");
    expect(r.out).not.toContain("Use --force to reinitialize");
  });

  // ============================================================
  // Special path 6: SCOPE-CHANGE — next names the scope-change command.
  // ============================================================
  test("SP6: scope-change -> print directive naming `scope change --scope mvp`", () => {
    const p = projWithState("state-mid-ideation.md");
    const r = run(ORCHESTRATE, ["next", "--scope", "mvp", "--project-dir", p]);
    expect(directive(r).kind).toBe("print");
    expect(r.out).toContain("scope change --scope mvp");
  });

  // ============================================================
  // Special path 7: NORMAL GATE - report drives aidlc-state.ts approve through
  // the report dispatcher; the gate closes (kind==="done"). The --test-run
  // round-trip that used to sit here was removed with the test-run mechanism
  // (#369); this control proves the normal gate path is observable, not a no-op.
  // ============================================================
  test("SP7-control: report --result approved --user-input -> done", () => {
    const p = projWithState("state-mid-ideation.md");
    run(ORCHESTRATE, [
      "report",
      "--stage",
      "feasibility",
      "--result",
      "awaiting-approval",
      "--project-dir",
      p,
    ]);
    const r = run(ORCHESTRATE, [
      "report",
      "--result",
      "approved",
      "--user-input",
      "Approve",
      "--project-dir",
      p,
    ]);
    expect(directive(r).kind).toBe("done");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // The agent reads the person's reply and reports the choice they made; the
  // engine requires a reply since the gate was shown and a named choice.
  function heldGate(revisions = 0): { p: string; guardedEnv: NodeJS.ProcessEnv } {
    const p = projWithState("state-mid-ideation.md");
    const guardedEnv = { ...process.env };
    delete guardedEnv.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    if (revisions > 0) {
      writeFileSync(
        statePath(p),
        readFileSync(statePath(p), "utf-8").replace("- **Revision Count**: 0", `- **Revision Count**: ${revisions}`),
      );
    }
    run(ORCHESTRATE, [
      "report",
      "--stage",
      "feasibility",
      "--result",
      "awaiting-approval",
      "--project-dir",
      p,
    ]);
    appendAuditEntry("HUMAN_TURN", {}, p);
    return { p, guardedEnv };
  }
  const report = (p: string, env: NodeJS.ProcessEnv, args: string[]) =>
    directive(run(ORCHESTRATE, ["report", ...args, "--project-dir", p], env));

  test("SP7-invalid: a report that names no choice leaves the gate open; the agent's approval then records", () => {
    const { p, guardedEnv } = heldGate();
    const invalid = report(p, guardedEnv, ["--result", "approved"]);
    // The agent's next step, not an error for the person.
    expect(invalid.kind, JSON.stringify(invalid)).toBe("print");
    expect(invalid.message).toContain("names no choice");
    // Their reply is on record: the agent reports the choice it read, and the
    // person is not asked again.
    expect(invalid.message).toContain("The person has replied since the gate was shown");
    expect(invalid.message).toContain("without asking them again");
    expect(invalid.message).not.toContain("show the gate");
    expect(readFileSync(statePath(p), "utf-8")).toContain("- [?] feasibility");
    expect(eventCount(p, "GATE_APPROVED")).toBe(0);

    const accepted = report(p, guardedEnv, ["--result", "approved", "--user-input", "Approve"]);
    expect(accepted.kind).toBe("done");
    expect(eventCount(p, "GATE_APPROVED")).toBe(1);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("SP7-reject: a change request needs what should change; with it, the gate is sent back", () => {
    const { p, guardedEnv } = heldGate();
    const bare = report(p, guardedEnv, ["--result", "rejected", "--user-input", "Request Changes"]);
    expect(bare.kind, JSON.stringify(bare)).toBe("print");
    expect(bare.message).toContain("Request Changes requires nonblank revision feedback");
    expect(eventCount(p, "GATE_REJECTED")).toBe(0);

    const accepted = report(p, guardedEnv, [
      "--result", "rejected", "--user-input", "Request Changes", "--reason", "tighten the schema",
    ]);
    expect(accepted.kind).toBe("print");
    expect(eventCount(p, "GATE_REJECTED")).toBe(1);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("SP7-escape: Accept as-is is recorded only once it is on offer, after three revision cycles", () => {
    const early = heldGate();
    expect(report(early.p, early.guardedEnv, ["--result", "approved", "--user-input", "Accept as-is"]).kind).toBe("done");
    expect(readAudit(early.p)).toContain("**User Input**: Approve\n");
    expect(readAudit(early.p)).not.toContain("**User Input**: Accept as-is");

    const offered = heldGate(3);
    expect(report(offered.p, offered.guardedEnv, ["--result", "approved", "--user-input", "Accept as-is"]).kind).toBe("done");
    expect(readAudit(offered.p)).toContain("**User Input**: Accept as-is\n");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // ============================================================
  // WALK A: non-gated advance (next -> report -> next). workspace-detection is a
  // bootstrap init stage (gate:false); report picks `advance`; next-after -> state-init.
  // ============================================================
  test("WALK A (non-gated): next gate:false -> report advance -> next state-init", () => {
    const p = projWithState("state-pre-workspace-detection.md");
    const n1 = nextDirective(p);
    expect(n1.stage).toBe("workspace-detection");
    expect(n1.gate).toBe(false);
    const r = run(ORCHESTRATE, [
      "report",
      "--result",
      "completed",
      "--project-dir",
      p,
    ]);
    // report dispatched advance (not approve) — the done reason names it.
    expect(r.out).toContain("Committed advance for");
    const n2 = nextDirective(p);
    expect(n2.stage).toBe("state-init");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // ============================================================
  // WALK B: gated approve (next -> report -> next). feasibility is a gated
  // ideation stage (gate:true); report picks `approve`, which owns the full
  // transition with EXACTLY ONE STAGE_STARTED (no double-advance); next-after ->
  // scope-definition.
  // ============================================================
  test("WALK B (gated): next gate:true -> approve emits one STAGE_STARTED -> next scope-definition", () => {
    const p = projWithState("state-mid-ideation.md");
    const n1 = nextDirective(p);
    expect(n1.stage).toBe("feasibility");
    expect(n1.gate).toBe(true);
    run(ORCHESTRATE, [
      "report",
      "--stage",
      "feasibility",
      "--result",
      "awaiting-approval",
      "--project-dir",
      p,
    ]);
    run(ORCHESTRATE, [
      "report",
      "--result",
      "approved",
      "--user-input",
      "ok",
      "--project-dir",
      p,
    ]);
    expect(eventCount(p, "STAGE_STARTED")).toBe(1);
    const n2 = nextDirective(p);
    expect(n2.stage).toBe("scope-definition");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // ============================================================
  // WALK C: the classify round-trip (next -> report --skeleton-stance -> next).
  // state-construction-bolt1: feature, Construction Active, Current Stage=
  // functional-design (the first construction EXECUTE stage = the skeleton gate).
  // The first Bolt's gate depends on the walking-skeleton STANCE — knowledge the
  // engine cannot compute — so next emits the gate UNRESOLVED (the string), the
  // conductor hands the typed stance back via `report --skeleton-stance` (the
  // test SUPPLIES the stance — no model), and the follow-up next re-emits the
  // SAME stage with the now-DETERMINED gate (true). This is the THIRD component
  // walk: it exercises the report dispatcher's STANCE branch (records state
  // without committing a transition) AND the next decision rule's gate
  // computation reading that recorded stance. (v0.6.0 Wave 2 milestone 9; per the
  // engine design; .sh:235-260.)
  test("WALK C (classify): next gate:unresolved -> report --skeleton-stance on (print, no transition) -> next gate:true", () => {
    const p = projWithState("state-construction-bolt1.md");
    // Step 1: the next decision rule defers the skeleton gate -> gate is the
    // STRING "unresolved" (not the boolean), still naming the same EXECUTE stage.
    const n1 = nextDirective(p);
    expect(n1.stage).toBe("functional-design");
    expect(n1.gate).toBe("unresolved");
    // Step 2: the report dispatcher's STANCE branch records the typed stance and
    // commits NO transition — a `print` (not done/advance). STRONGER than the
    // .sh's `kind == print`: also pin the recorded-stance message so the branch
    // is proven to be the stance-record path, not a generic print.
    const r = run(ORCHESTRATE, [
      "report",
      "--skeleton-stance",
      "on",
      "--project-dir",
      p,
    ]);
    const stance = directive(r);
    expect(stance.kind).toBe("print");
    expect(stance.message).toContain('Recorded walking-skeleton stance "on"');
    // No transition committed by the stance report: still functional-design,
    // and no STAGE_STARTED/STAGE_COMPLETED rows were appended by the stance step.
    expect(eventCount(p, "STAGE_COMPLETED")).toBe(0);
    // Step 3: the next decision rule reads the recorded stance and re-emits the
    // SAME stage with the now-DETERMINED gate (the boolean true). The round-trip
    // closes deterministically — no model in the loop.
    const n2 = nextDirective(p);
    expect(n2.stage).toBe("functional-design");
    expect(n2.gate).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
