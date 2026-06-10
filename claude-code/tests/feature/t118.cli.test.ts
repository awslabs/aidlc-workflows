// covers: subcommand:aidlc-jump:resolve
//
// CLI-contract port of tests/feature/t118-engine-differential.sh (TAP plan 27),
// mechanism = cli. The differential corpus: cross-component, multi-step
// next/report sequences across the v0.6.0 engine (aidlc-orchestrate.ts) for the
// 7 SPECIAL PATHS the prose orchestrator handles today, plus 3 true
// cross-component WALKS — with NO MODEL IN THE LOOP. Every step SPAWNS the real
// engine binary `bun aidlc-orchestrate.ts next|report` (and the sibling tools
// `bun aidlc-jump.ts resolve` / `bun aidlc-state.ts gate-start`) over a seeded
// fixture and diffs the emitted directive / the audit.md the tool writes against
// a frozen golden — the PROCESS boundary (exit codes, stdout JSON, file effects),
// never an in-process call.
//
// Why spawn (not in-process): the .sh shells out to FOUR binaries per walk and
// asserts on (a) the directive JSON each emits on stdout, (b) the Test-Run /
// STAGE_STARTED rows aidlc-state.ts appends to audit.md through report's THIN
// DISPATCHER, and (c) the no-state-created side effect of --init. The contract is
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
//   SP5 init (4):
//     - (a) clean -> kind==="print" + NO aidlc-state.md created by next
//       (read-only — mutation stays conductor-side).
//     - (b) state exists, no --force -> kind==="error" + out contains the
//       verbatim guard "Use --force to reinitialize".
//   SP6 scope-change (2): kind==="print" + out contains "scope-change --scope mvp".
//   SP7 test-run round-trip (4):
//     - report --result approved --test-run -> kind==="done".
//     - audit.md carries `**Test-Run**: true` on the GATE_APPROVED row
//       (STRONGER: block-scoped to the GATE_APPROVED block, not a file-wide grep).
//     - follow-up next -> stage==="scope-definition" (advanced).
//     - control WITHOUT --test-run -> NO `**Test-Run**: true` anywhere
//       (whole-file absence; the path is observable, not a no-op).
//   WALK A non-gated advance (3): N1 stage==="workspace-detection" gate===false;
//     report contains "Committed advance for"; N2 stage==="state-init".
//   WALK B gated approve (3): N1 stage==="feasibility" gate===true; STAGE_STARTED
//     count===1 (no double-advance); N2 stage==="scope-definition".
//   WALK C classify round-trip (3) — v0.6.0 Wave 2 milestone 9, vision §6:452-454,
//     .sh:235-260: the skeleton-stance classify round-trip across the report
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
// 27 .sh asserts -> 27 expect()-bearing test() cases (the .sh's two-observable
// `assert_eq "a|b"` lines are kept as two expect()s inside one test(), matching
// the single `ok` line the .sh emitted for each).
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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const ORCHESTRATE = join(TOOLS, "aidlc-orchestrate.ts");
const JUMP = join(TOOLS, "aidlc-jump.ts");
const STATE = join(TOOLS, "aidlc-state.ts");

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

/** Fresh CLEAN temp project — aidlc-docs/ exists, no state file (SP5a). */
function cleanProj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

const statePath = (p: string): string =>
  join(p, "aidlc-docs", "aidlc-state.md");
const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");

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
  const f = auditPath(p);
  if (!existsSync(f)) return 0;
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter((l) => l === `**Event**: ${ev}`).length;
}

/**
 * Block-scoped presence of `**<key>**: <value>` inside the FIRST audit block
 * whose `**Event**:` matches <ev>. STRONGER than the .sh's file-wide
 * assert_grep '\*\*Test-Run\*\*: true' — it pins the field to the GATE_APPROVED
 * block specifically. Resets at `## ` headings and `---` separators.
 */
function blockHasField(p: string, ev: string, key: string, value: string): boolean {
  const f = auditPath(p);
  if (!existsSync(f)) return false;
  let matched = false;
  for (const line of readFileSync(f, "utf-8").replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("## ") || line === "---") {
      matched = false;
      continue;
    }
    if (line.startsWith("**Event**: ")) {
      matched = line === `**Event**: ${ev}`;
      continue;
    }
    if (matched && line === `**${key}**: ${value}`) return true;
  }
  return false;
}

/** Whole-file presence of a literal needle (mirrors a bare unanchored grep). */
function fileContains(p: string, needle: string): boolean {
  const f = auditPath(p);
  if (!existsSync(f)) return false;
  return readFileSync(f, "utf-8").includes(needle);
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

  // ============================================================
  // Special path 5: INIT — (a) clean print + no state created; (b) guard error.
  // ============================================================
  test("SP5a: init (clean) -> print directive, next creates NO state (read-only)", () => {
    const p = cleanProj();
    const r = run(ORCHESTRATE, [
      "next",
      "--init",
      "--scope",
      "poc",
      "--project-dir",
      p,
    ]);
    expect(directive(r).kind).toBe("print");
    // Mutation stays conductor-side: next must not have scaffolded state.
    expect(existsSync(statePath(p))).toBe(false);
  });

  test("SP5b: init (state exists, no --force) -> error carrying the verbatim guard", () => {
    const p = projWithState("state-mid-ideation.md");
    const r = run(ORCHESTRATE, ["next", "--init", "--project-dir", p]);
    expect(directive(r).kind).toBe("error");
    expect(r.out).toContain("Use --force to reinitialize");
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
  // Special path 7: TEST-RUN round-trip — report rides --test-run through to
  // aidlc-state.ts approve, stamping Test-Run: true on GATE_APPROVED; next-after
  // reflects the advance; control without --test-run proves the stamp is absent.
  // Spawns gate-start + report + next + (control) gate-start + report = 5 procs.
  // ============================================================
  test("SP7: report --test-run -> done, Test-Run:true on GATE_APPROVED, next advances", () => {
    const p = projWithState("state-mid-ideation.md");
    const gs = run(STATE, ["gate-start", "feasibility", "--project-dir", p]);
    expect(gs.status).toBe(0);
    const reportOut = run(ORCHESTRATE, [
      "report",
      "--result",
      "approved",
      "--test-run",
      "--user-input",
      "auto",
      "--project-dir",
      p,
    ]);
    expect(directive(reportOut).kind).toBe("done");
    // Block-scoped: Test-Run: true sits on the GATE_APPROVED row.
    expect(blockHasField(p, "GATE_APPROVED", "Test-Run", "true")).toBe(true);
    const nextAfter = directive(
      run(ORCHESTRATE, ["next", "--project-dir", p]),
    );
    expect(nextAfter.stage).toBe("scope-definition");
  }, 30000);

  test("SP7-control: report WITHOUT --test-run leaves no Test-Run stamp", () => {
    const p = projWithState("state-mid-ideation.md");
    run(STATE, ["gate-start", "feasibility", "--project-dir", p]);
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
    // Whole-file absence (mirrors the .sh's unanchored assert_not_grep).
    expect(fileContains(p, "**Test-Run**: true")).toBe(false);
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
    run(STATE, ["gate-start", "feasibility", "--project-dir", p]);
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
  // computation reading that recorded stance. (v0.6.0 Wave 2 milestone 9; vision
  // §6:452-454; .sh:235-260.)
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
