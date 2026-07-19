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
//   SP4 resume (2): kind==="ask"; out contains "existing workflow was found".
//   SP5 birth (P4: --init retired, engine names intent-birth):
//     - (a) named scope on a clean workspace -> kind==="print" naming
//       intent-birth + NO aidlc-state.md created by next (read-only — mutation
//       stays conductor-side).
//     - (b) named scope over existing state -> NOT a birth (no intent-birth
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

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  seededAuditDir,
  seededStateFile,
  seedStateFile,
  resetAidlcEnv,
} from "../harness/fixtures.ts";

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

function run(tool: string, args: string[]): CliResult {
  const res = spawnSync(BUN, [tool, ...args], { encoding: "utf-8" });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/** Fresh temp project seeded from a FIXTURES_DIR state fixture. */
function projWithState(fixtureName: string): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedStateFile(p, join(FIXTURES_DIR, fixtureName));
  return p;
}

/** Fresh CLEAN temp project — an empty workspace, NO intent record (SP5a). P9:
 *  createTestProject seeds a default record + cursor, so strip it; otherwise the
 *  engine resolves the seeded intent instead of naming intent-birth. */
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
  // Special path 4: RESUME — engine emits ask + stops (never calls AskUserQuestion).
  // ============================================================
  test("SP4: resume -> ask directive carrying the resume-choice question", () => {
    const p = projWithState("state-jumped.md");
    const r = run(ORCHESTRATE, ["next", "--resume", "--project-dir", p]);
    expect(directive(r).kind).toBe("ask");
    expect(r.out).toContain("existing workflow was found");
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

    const fresh = report("Start fresh");
    expect(fresh.kind).toBe("print");
    expect(fresh.message).toContain("--new-intent");

    const garbage = report("something unrecognizable");
    expect(garbage.kind).toBe("error");
    expect(garbage.message).toContain("Unrecognized resume choice");

    // Every round-trip above is read-only: report routes, the conductor acts.
    expect(readFileSync(statePath(p), "utf-8")).toBe(before);
  });

  // ============================================================
  // Special path 5: BIRTH (P4: --init retired) — (a) named scope on a clean
  // workspace prints the intent-birth move + creates NO state; (b) a named scope
  // over existing state is a resume/scope-change, NOT a birth.
  // ============================================================
  test("SP5a: named scope (clean) -> print naming intent-birth, next creates NO state (read-only)", () => {
    const p = cleanProj();
    const r = run(ORCHESTRATE, [
      "next",
      "--scope",
      "poc",
      "--project-dir",
      p,
    ]);
    expect(directive(r).kind).toBe("print");
    expect(directive(r).message).toContain("intent-birth");
    // Mutation stays conductor-side: next must not have birthed/scaffolded state.
    expect(existsSync(statePath(p))).toBe(false);
  });

  test("SP5a positional scope + description -> birth preserves --arguments and does not ask", () => {
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
    expect(d.message).toContain("intent-birth --scope bugfix");
    expect(d.message).toContain(
      '--arguments "Fix duplicate todo persistence"',
    );
    expect(d.kind).not.toBe("ask");
    expect(existsSync(statePath(p))).toBe(false);
  });

  test("SP5b: named scope over existing state -> not a birth (no intent-birth print)", () => {
    const p = projWithState("state-mid-ideation.md"); // feature scope state
    const r = run(ORCHESTRATE, ["next", "--scope", "feature", "--project-dir", p]);
    expect(r.out).not.toContain("intent-birth");
    expect(r.out).not.toContain("Use --force to reinitialize");
  });

  // ============================================================
  // Special path 6: SCOPE-CHANGE — next names the scope-change command.
  // ============================================================
  test("SP6: scope-change -> print directive naming `scope-change --scope mvp`", () => {
    const p = projWithState("state-mid-ideation.md");
    const r = run(ORCHESTRATE, ["next", "--scope", "mvp", "--project-dir", p]);
    expect(directive(r).kind).toBe("print");
    expect(r.out).toContain("scope-change --scope mvp");
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
      "human ok",
      "--project-dir",
      p,
    ]);
    expect(directive(r).kind).toBe("done");
  }, 30000);

  // ============================================================
  // WALK A: non-gated advance (next -> report -> next). workspace-detection is a
  // bootstrap init stage (gate:false); report picks `advance`; next-after -> state-init.
  // ============================================================
  test("WALK A (non-gated): next gate:false -> report advance -> next state-init", () => {
    const p = projWithState("state-pre-workspace-detection.md");
    const n1 = directive(run(ORCHESTRATE, ["next", "--project-dir", p]));
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
    const n2 = directive(run(ORCHESTRATE, ["next", "--project-dir", p]));
    expect(n2.stage).toBe("state-init");
  }, 30000);

  // ============================================================
  // WALK B: gated approve (next -> report -> next). feasibility is a gated
  // ideation stage (gate:true); report picks `approve`, which owns the full
  // transition with EXACTLY ONE STAGE_STARTED (no double-advance); next-after ->
  // scope-definition.
  // ============================================================
  test("WALK B (gated): next gate:true -> approve emits one STAGE_STARTED -> next scope-definition", () => {
    const p = projWithState("state-mid-ideation.md");
    const n1 = directive(run(ORCHESTRATE, ["next", "--project-dir", p]));
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
    const n2 = directive(run(ORCHESTRATE, ["next", "--project-dir", p]));
    expect(n2.stage).toBe("scope-definition");
  }, 30000);

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
    const n1 = directive(run(ORCHESTRATE, ["next", "--project-dir", p]));
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
    const n2 = directive(run(ORCHESTRATE, ["next", "--project-dir", p]));
    expect(n2.stage).toBe("functional-design");
    expect(n2.gate).toBe(true);
  }, 30000);
});
