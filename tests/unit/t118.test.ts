// covers: subcommand:aidlc-jump:resolve
//
// CLI-contract port of tests/unit/t118-engine-differential.sh (TAP plan 38),
// mechanism = cli. The differential corpus — the WAVE CLOSE GATE for the
// v0.6.0 Wave 1 engine (aidlc-orchestrate.ts next), extended in Wave 2 milestone 9
// with the classified-stance anchor + the no-state workflow-birth trio. It
// proves the deterministic engine emits, FOR EACH OF THE 9 SCOPES, the same
// scope-shaped directive the prose orchestrator (skills/aidlc/SKILL.md)
// produces today — WITH NO MODEL IN THE LOOP. It NEVER calls the LLM (the .sh
// deliberately omits run_claude; the prose-orchestrator workflow tests t50-t59
// drive the model — this corpus is their deterministic mirror).
//
// The covers id is subcommand:aidlc-jump:resolve, not aidlc-orchestrate, BY
// DESIGN: this corpus exercises the explicit-jump branch of the engine
// (`next --stage <slug>`), which DELEGATES the in-scope SKIP check + target
// resolution to `aidlc-jump.ts resolve` by shelling out (aidlc-orchestrate.ts
// emitJumpDirective -> runTool("aidlc-jump.ts", ["resolve", ...])). The
// observable under test — the verbatim `Stage "..." is skipped for scope
// "<scope>".` error in diff B, and the run-stage emitted for the tool's
// resolved target_slug in diff A — is OWNED by aidlc-jump.ts resolve
// (aidlc-jump.ts:116-119, :168-180). The engine relays it unchanged; resolve
// is the unit credited.
//
// MECHANISM: SPAWN the real engine binary via node:child_process spawnSync
// (BUN + aidlc-orchestrate.ts), mirroring the .sh's `bun "$TOOL" next ...`.
// The directive is emitted as JSON to stdout (engine emit()), so we parse the
// PROCESS-boundary stdout and assert on the parsed directive's fields — same
// observable the .sh extracted with its python3 json_field helper. An
// in-process twin would lose the spawn seam the engine relies on to relay the
// resolve subprocess's verbatim error, the very contract under test.
//
// EQUAL-OR-STRONGER PARITY (every .sh `ok` line maps to an expect() here):
//
//   Diff A — per-scope fingerprint (9 .sh asserts -> 9 test() cases):
//     .sh built ACTUAL="$KIND|$STG|$PHA|$GATE" and diffed against
//     EXPECTED="run-stage|$fp|$ph|true" in ONE assert_eq per scope. Here each
//     scope is one test() that asserts the SAME four fields against the SAME
//     frozen golden — STRONGER: instead of comparing a pipe-joined string we
//     assert each parsed field individually (kind/stage/phase/gate), so a drift
//     in any single field reds with a field-named message, and gate is checked
//     as the real JSON boolean `true` (not the string "true").
//
//   Diff B — per-scope SKIP (14 .sh asserts = 7 scopes x 2 -> 7 test() cases,
//     2 expect() each):
//     The .sh fired TWO assert lines per skipping scope: assert_eq KIND "error"
//     AND assert_contains MSG `is skipped for scope "<scope>"`. Each test() here
//     reproduces BOTH observables — kind === "error" and the verbatim resolve
//     wording — keeping the .sh's 2-ok-per-scope shape inside one case.
//     STRONGER: we additionally assert the message names the SKIPPED STAGE
//     (`Stage "<skip>"`), pinning that resolve rejected the RIGHT stage, not
//     merely some stage. enterprise + feature SKIP nothing (golden "-"), so
//     they carry no diff-B case — their negative coverage is the gate-axis
//     anchor below, exactly as the .sh notes.
//
//   Gate-axis anchor (1 .sh assert -> 1 test() case):
//     The .sh diffed "$GATE|$STG" against "false|workspace-detection" for the
//     state-pre-workspace-detection fixture (Current Stage=workspace-detection,
//     an init stage, in-flight). Here: gate === false (real boolean) AND
//     stage === "workspace-detection" — the other end of the gate axis from
//     diff A, proving gate tracks the human-judgement boundary (init stages
//     auto-proceed) and NOT the conditional-inclusion axis.
//
//   Classified-stance anchor (1 .sh assert -> 1 test() case):
//     The .sh diffed "$GATE|$STG" against "unresolved|functional-design" for
//     the state-construction-bolt1 fixture (a feature workflow parked at Current
//     Stage=functional-design — the FIRST Construction Bolt's gate, the skeleton
//     gate — with no stance recorded yet). The third gate value: gate ===
//     "unresolved" (the STRING sentinel, NOT a boolean), alongside the
//     per-fingerprint gate:true (diff A) and the init gate:false (anchor above).
//     The first Construction Bolt's gate depends on a practices-derived STANCE
//     the engine cannot compute, so it defers to the conductor's classify
//     round-trip and emits the sentinel (per the engine design). Here: gate ===
//     "unresolved" AND stage === "functional-design" AND phase ===
//     "construction" AND kind === "run-stage". STRONGER than the .sh's two-field
//     diff: the .sh read only gate + stage; we additionally pin phase and kind,
//     and assert gate is the sentinel STRING (a regression that emitted a boolean
//     gate here would slip a two-field-only diff but reds the string equality).
//
//   No-state workflow-birth trio (4 .sh asserts -> 3 test() cases):
//     Every diff above seeds state then jumps; these three drive a NO-STATE
//     invocation (createTestProject makes aidlc-docs/ but NO aidlc-state.md —
//     same as the .sh's create_test_project), the workflow-birth paths the Wave
//     2 cutover leans on, which sat outside the close gate (Wave-1 audit findings
//     2 & 3 slipped through here). Post-hardening, an EXPLICITLY NAMED scope on
//     a fresh workspace BIRTHS the workflow (a run-then-continue print naming
//     `init --scope <scope>`) rather than relaying the old circular no-state
//     error; the trio's cases:
//       (1) `next bugfix` — bare KNOWN-SCOPE positional, NOT freeform: kind ===
//           "print" AND message names `intent-birth --scope bugfix` (the engine
//           recognises bugfix as the scope, finding 2, and emits the SAME
//           workflow-birth print `next --scope bugfix` emits; pre-finding-2 it
//           mis-read the literal scope as prose and emitted an `ask` defaulting
//           to "feature"). P4: the named birth move is `intent-birth`, not the
//           retired `init`. One test() bundles both observables.
//       (2) `next add dark mode toggle` — genuine freeform (<=5-word) intent,
//           NOT a scope name: kind === "ask" (the control proving the finding-2
//           fix narrows ONLY known-scope positionals; real prose still defers to
//           the human via ask). One ok line -> one test().
//       (3) bare `next`, no state, no target, no explicitly named scope:
//           kind === "error" (no position to advance from; creating one is
//           init's mutating job; env/default scope resolution is not a birth
//           signal). One ok -> one test().
//     STRONGER: case (1) additionally pins the run-then-continue shape of the
//     birth print, and case (3) re-pins the post-hardening guidance wording
//     verbatim, so a regression to the WRONG cause or the old circular clause
//     reds.
//
//   38 .sh asserts -> 38 .sh `ok` lines -> 9 + 7 + 1 + 1 + 3 = 21 test() cases
//   here (the 7 diff-B cases + the no-state-bugfix case each bundle 2 ok lines
//   for one observable group). Total expect() assertions exceed 38.
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_state_file +
// sed_i Scope-swap + cleanup_test_project per emit):
//   - emitScopeStage() builds a FRESH temp project (createTestProject, which
//     toPortablePath-converts on Windows so the project dir the tool resolves
//     through forward-slash helpers round-trips), seeds it from
//     state-initialization-done.md, and swaps ONLY the Scope field. The
//     init-done checkboxes are scope-agnostic for the jump path (resolve
//     validates SKIP against scope-mapping.json, not the checkbox suffixes), so
//     one fixture serves all 9 scopes — same single-fixture rationale as the
//     .sh. All temp dirs cleaned in afterAll.
//   - resetAidlcEnv() runs first (mirrors the .sh's reset_aidlc_env): scope is
//     partly resolved from AWS_AIDLC_DEFAULT_SCOPE, so a developer's exported
//     value must not shadow the seeded fixtures. Each spawn also passes a clean
//     env with that var deleted so the seeded Scope field is authoritative.
//   - NOTHING is written under tests/fixtures/**.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  REPO_ROOT,
  resetAidlcEnv,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const TOOL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-orchestrate.ts",
);
const JUMP_TOOL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-jump.ts",
);

const tempDirs: string[] = [];

beforeAll(() => {
  // Mirror the .sh's reset_aidlc_env — a stray AWS_AIDLC_DEFAULT_SCOPE export
  // would shadow the seeded fixture Scope on the precedence ladder.
  resetAidlcEnv();
});

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

// A clean env for every spawn: drop AWS_AIDLC_DEFAULT_SCOPE so the seeded
// fixture Scope field (state > flag > env > default) always wins, regardless
// of the developer's shell. Mirrors the .sh sourcing reset_aidlc_env before
// the corpus runs.
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  return env;
}

interface Directive {
  kind?: string;
  stage?: string;
  phase?: string;
  // gate is the human-judgement-boundary axis: a real boolean for ordinary
  // stages (true=gates / false=bootstrap auto-proceed) OR the string sentinel
  // "unresolved" for the first Construction Bolt's skeleton gate (the engine
  // defers the practices-derived stance to the conductor's classify round-trip).
  gate?: boolean | string;
  message?: string;
  // biome-ignore lint/suspicious/noExplicitAny: directives carry many fields the corpus doesn't read
  [k: string]: any;
}

interface EmitResult {
  status: number;
  directive: Directive;
  raw: string;
}

// emit_scope_stage (t118:79-90): fresh project seeded from
// state-initialization-done.md, swap ONLY the Scope field, then spawn
// `bun aidlc-orchestrate.ts next --stage <stage> --project-dir <proj>`.
// Returns the parsed directive (the .sh piped stdout+stderr 2>&1 through
// json_field; here we JSON.parse the engine's single emitted directive).
function emitScopeStage(scope: string, stage: string): EmitResult {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedStateFile(proj, join(FIXTURES_DIR, "state-initialization-done.md"));
  const statePath = seededStateFile(proj);
  // Swap the Scope field (mirrors the .sh sed_i on `- **Scope**: ...`) AND
  // rebuild the Stage Progress suffixes to the new scope's grid column. The
  // fixture was authored for the feature scope; since the adaptive-composer
  // work the jump path honours the state's per-stage suffixes as the live
  // plan (they override the static grid, matching the router), so a state
  // whose Scope says bugfix but whose suffixes still carry feature's plan is
  // internally inconsistent - a shape the real tools (init/scope-change/
  // recompose, which all rebuild suffixes) never produce. Rebuilding keeps
  // this diff's intent intact: the target IS off the seeded plan.
  const grid = JSON.parse(
    readFileSync(join(AIDLC_SRC, "tools", "data", "scope-grid.json"), "utf-8"),
  ) as Record<string, { stages: Record<string, string> }>;
  const stages = grid[scope]?.stages ?? {};
  let swapped = readFileSync(statePath, "utf-8").replace(
    /^- \*\*Scope\*\*: .*$/m,
    `- **Scope**: ${scope}`,
  );
  swapped = swapped.replace(
    /^(- \[[ xSR?-]\] )(\S+)(\s*—\s*)(EXECUTE|SKIP)\b/gm,
    (_m, pre: string, slug: string, dash: string) =>
      `${pre}${slug}${dash}${stages[slug] === "EXECUTE" ? "EXECUTE" : "SKIP"}`,
  );
  writeFileSync(statePath, swapped, "utf-8");
  const res = spawnSync(
    BUN,
    [TOOL, "next", "--stage", stage, "--project-dir", proj],
    { encoding: "utf-8", env: cleanEnv() },
  );
  const raw = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { status: res.status ?? -1, directive: parseDirective(res.stdout ?? ""), raw };
}

interface FingerprintLoopResult {
  print: Directive; // STEP 1: the print naming `execute --target <fp> --direction forward`
  printRaw: string;
  runStage: Directive; // STEP 3: the run-stage the engine lands on after the commit
  runStageRaw: string;
}

// emit_scope_fingerprint_runstage (t118.sh:107-133): drive the FULL post-cutover
// jump-commit loop for one scope's fingerprint. A WITH-STATE jump is a MUTATION
// the conductor commits, so the loop is THREE steps:
//   (1) `next --stage <fp>` emits a `print` naming `execute --target <fp>
//       --direction forward` (Current Stage is pivoted to the last init stage
//       state-init so every post-init fingerprint resolves forward, never redo);
//   (2) run `aidlc-jump.ts execute` to commit the jump (mutating state);
//   (3) bare `next` then reads the pivoted state and emits the run-stage for the
//       fingerprint — the exact stage|phase|gate of the frozen golden.
function emitScopeFingerprintLoop(scope: string, fp: string): FingerprintLoopResult {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedStateFile(proj, join(FIXTURES_DIR, "state-initialization-done.md"));
  const statePath = seededStateFile(proj);
  // Swap ONLY the Scope field, and pivot Current Stage to the last init stage so
  // the fingerprint resolves forward for every scope (mirrors the .sh's two sed_i).
  let md = readFileSync(statePath, "utf-8").replace(
    /^- \*\*Scope\*\*: .*$/m,
    `- **Scope**: ${scope}`,
  );
  md = md.replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: state-init");
  writeFileSync(statePath, md, "utf-8");
  // STEP 1: the print naming the execute delegate.
  const step1 = spawnSync(
    BUN,
    [TOOL, "next", "--stage", fp, "--project-dir", proj],
    { encoding: "utf-8", env: cleanEnv() },
  );
  // STEP 2: commit the jump the print named (mutating state).
  spawnSync(
    BUN,
    [JUMP_TOOL, "execute", "--target", fp, "--direction", "forward", "--scope", scope, "--project-dir", proj],
    { encoding: "utf-8", env: cleanEnv() },
  );
  // STEP 3: re-run `next` over the pivoted state — the landed run-stage.
  const step3 = spawnSync(BUN, [TOOL, "next", "--project-dir", proj], {
    encoding: "utf-8",
    env: cleanEnv(),
  });
  return {
    print: parseDirective(step1.stdout ?? ""),
    printRaw: `${step1.stdout ?? ""}${step1.stderr ?? ""}`,
    runStage: parseDirective(step3.stdout ?? ""),
    runStageRaw: `${step3.stdout ?? ""}${step3.stderr ?? ""}`,
  };
}

// Spawn `next` (no --stage) over a directly-seeded fixture — used by the
// gate-axis anchor (t118:186-193), where the happy path runs the in-flight
// init stage straight from state.
function emitNext(fixtureFile: string): EmitResult {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedStateFile(proj, join(FIXTURES_DIR, fixtureFile));
  const res = spawnSync(BUN, [TOOL, "next", "--project-dir", proj], {
    encoding: "utf-8",
    env: cleanEnv(),
  });
  const raw = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { status: res.status ?? -1, directive: parseDirective(res.stdout ?? ""), raw };
}

// emitNextNoState (t118.sh:289-315): spawn `next [...args]` against a FRESH
// project that has aidlc-docs/ but NO aidlc-state.md (createTestProject seeds
// neither) — the no-state workflow-birth paths of the trio. Pass zero args for
// bare `next`, one for a known-scope positional (`next bugfix`), or several for
// freeform intent (`next add dark mode toggle`). Mirrors the .sh's bare
// `bun "$TOOL" next <args> --project-dir "$proj"` over an unseeded project.
function emitNextNoState(...args: string[]): EmitResult {
  const proj = createTestProject();
  tempDirs.push(proj);
  // P9: createTestProject seeds a default intent record; the no-state birth path
  // requires a GENUINELY empty workspace (zero intents), else the engine asks to
  // SELECT the existing intent instead of birthing. Strip the seeded record.
  removeWorkspaceRecord(proj);
  const res = spawnSync(BUN, [TOOL, "next", ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env: cleanEnv(),
  });
  const raw = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { status: res.status ?? -1, directive: parseDirective(res.stdout ?? ""), raw };
}

// The engine emits exactly one directive as JSON to stdout. Parse it; an
// unparseable payload yields {} so a field read surfaces as undefined (mirrors
// the .sh json_field's "<PARSE-ERR>" / "<MISSING>" sentinels reding the diff).
function parseDirective(stdout: string): Directive {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as Directive;
  } catch {
    return {};
  }
}

// --- The FROZEN golden table (derived once, cross-validated, now static).
// Mirrors the .sh's GOLDEN_SCOPES / GOLDEN_FINGERPRINT / GOLDEN_PHASE /
// GOLDEN_SKIP_STAGE parallel arrays (t118:113-135). Each row: scope, the first
// non-init EXECUTE stage (fingerprint) + its phase, and a representative
// SKIP-for-scope stage (null when the scope skips nothing — enterprise/feature
// run every stage). gate is always true for every fingerprint (no scope's first
// post-init EXECUTE stage is an initialization stage). ---
interface GoldenRow {
  scope: string;
  fingerprint: string;
  phase: string;
  skip: string | null;
}

const GOLDEN: GoldenRow[] = [
  { scope: "enterprise", fingerprint: "intent-capture", phase: "ideation", skip: null },
  { scope: "feature", fingerprint: "intent-capture", phase: "ideation", skip: null },
  { scope: "mvp", fingerprint: "intent-capture", phase: "ideation", skip: "approval-handoff" },
  { scope: "poc", fingerprint: "intent-capture", phase: "ideation", skip: "feasibility" },
  { scope: "bugfix", fingerprint: "reverse-engineering", phase: "inception", skip: "intent-capture" },
  { scope: "refactor", fingerprint: "reverse-engineering", phase: "inception", skip: "market-research" },
  { scope: "infra", fingerprint: "practices-discovery", phase: "inception", skip: "reverse-engineering" },
  { scope: "security-patch", fingerprint: "reverse-engineering", phase: "inception", skip: "user-stories" },
  { scope: "workshop", fingerprint: "reverse-engineering", phase: "inception", skip: "intent-capture" },
];

describe("t118 engine differential corpus — aidlc-orchestrate next (migrated from t118-engine-differential.sh, plan 24)", () => {
  // --- Diff A: fingerprint stage IS in scope -> print→execute→run-stage (9 cases) ---
  // At the v0.6.0 engine cutover a WITH-STATE jump became a MUTATION the conductor
  // commits, so the differential is re-anchored END-TO-END through the post-cutover
  // loop (emitScopeFingerprintLoop):
  //   A1: STEP 1 — `next --stage <fp>` emits a `print` naming `execute --target
  //       <fp> --direction forward` (Current Stage pivoted to state-init so the
  //       fingerprint resolves forward for every scope).
  //   A2: after the conductor runs that execute and re-runs `next`, the engine
  //       lands on the fingerprint run-stage with the exact stage|phase|GATE of
  //       the frozen golden. gate is true for every fingerprint (no scope's first
  //       post-init EXECUTE stage is an initialization stage).
  describe("diff A — per-scope fingerprint -> run-stage gate:true [golden diff]", () => {
    for (const row of GOLDEN) {
      test(`scope '${row.scope}' fingerprint -> run-stage ${row.fingerprint} (${row.phase}) gate:true`, () => {
        const r = emitScopeFingerprintLoop(row.scope, row.fingerprint);
        // A1: STEP 1 print names the execute delegate (forward).
        expect(r.print.kind).toBe("print");
        expect(r.print.message ?? "").toContain(
          `execute --target ${row.fingerprint} --direction forward --scope ${row.scope}`,
        );
        // A2: after the commit + re-run, the engine lands on the fingerprint.
        expect(r.runStage.kind).toBe("run-stage");
        expect(r.runStage.stage).toBe(row.fingerprint);
        expect(r.runStage.phase).toBe(row.phase);
        // STRONGER than the .sh string-diff: assert the real JSON boolean, not
        // the rendered "true" token. gate is the human-judgement-boundary axis.
        expect(r.runStage.gate).toBe(true);
      });
    }
  });

  // --- Diff B: a SKIP-for-scope stage -> verbatim resolve skip error (7 cases,
  // each bundling the .sh's 2 ok lines: kind=error + verbatim wording) ---
  // The negative half of the fingerprint. 7 scopes SKIP at least one stage;
  // jumping to a SKIP stage must emit an error carrying the verbatim
  // `Stage "..." is skipped for scope "<scope>".` wording relayed from
  // aidlc-jump.ts resolve (aidlc-jump.ts:116-119). enterprise + feature SKIP
  // nothing (golden skip=null) — their negative coverage is the gate-axis
  // anchor below.
  describe("diff B — per-scope SKIP stage -> verbatim resolve skip error", () => {
    for (const row of GOLDEN) {
      if (row.skip === null) continue;
      const skip = row.skip;
      test(`scope '${row.scope}' SKIP stage '${skip}' -> error directive + verbatim resolve wording`, () => {
        const r = emitScopeStage(row.scope, skip);
        // .sh ok #1: assert_eq KIND "error"
        expect(r.directive.kind).toBe("error");
        const msg = r.directive.message ?? "";
        // .sh ok #2: assert_contains MSG `is skipped for scope "<scope>"`
        expect(msg).toContain(`is skipped for scope "${row.scope}"`);
        // STRONGER: the message names the SKIPPED stage, proving resolve
        // rejected the RIGHT stage (aidlc-jump.ts:118 emits Stage "<slug>" ...).
        expect(msg).toContain(`Stage "${skip}"`);
      });
    }
  });

  // --- Gate-axis anchor: an INITIALIZATION stage emits gate:false (1 case) ---
  // The other end of the gate axis from diff A. The bootstrap initialization
  // stages auto-proceed with NO governance boundary, so their run-stage carries
  // gate:false. The happy path on state-pre-workspace-detection (Current
  // Stage=workspace-detection, an init stage, in-flight) emits a run-stage for
  // it with gate:false — proving gate tracks the human-judgement boundary, not
  // the conditional-inclusion (execution ALWAYS/CONDITIONAL) axis.
  describe("gate-axis anchor — initialization stage -> run-stage gate:false", () => {
    test("initialization stage (workspace-detection) -> run-stage gate:false (bootstrap auto-proceed)", () => {
      const r = emitNext("state-pre-workspace-detection.md");
      // .sh: assert_eq "$GATE|$STG" "false|workspace-detection"
      expect(r.directive.gate).toBe(false);
      expect(r.directive.stage).toBe("workspace-detection");
      // STRONGER: pin the directive kind too (the .sh read only gate + stage).
      expect(r.directive.kind).toBe("run-stage");
    });
  });

  // --- Classified-stance anchor: the skeleton gate emits gate:"unresolved" (1
  // case) --- (t118.sh:255-274). The THIRD gate value, alongside the
  // per-fingerprint gate:true (diff A) and the init gate:false (anchor above).
  // The FIRST Construction Bolt's gate depends on a practices-derived STANCE the
  // engine cannot compute, so it emits the sentinel string gate:"unresolved" and
  // defers to the conductor's classify round-trip (v0.6.0 Wave 2 milestone 9, per
  // the engine design). state-construction-bolt1 is a feature workflow parked at Current
  // Stage=functional-design (the first construction EXECUTE stage = the skeleton
  // gate) with no stance recorded, so bare `next` emits the run-stage for it
  // carrying gate:"unresolved" — NOT a boolean. The full classify round-trip is
  // the feature-tier WALK C; this single-directive anchor pins the engine's emit
  // of the sentinel itself.
  describe("classified-stance anchor — skeleton gate -> run-stage gate:\"unresolved\"", () => {
    test("skeleton-gate stage (functional-design, Bolt 1, no stance) -> run-stage gate:\"unresolved\" (classify-round-trip sentinel)", () => {
      const r = emitNext("state-construction-bolt1.md");
      // .sh: assert_eq "$GATE|$STG" "unresolved|functional-design"
      // STRONGER: gate is the sentinel STRING, asserted as a strict ===
      // "unresolved" — a regression emitting a boolean gate (true/false) here
      // would slip the .sh's pipe-joined diff if it rendered the same token, but
      // reds this strict string equality.
      expect(r.directive.gate).toBe("unresolved");
      expect(r.directive.stage).toBe("functional-design");
      // STRONGER than the .sh's two-field diff: pin phase + kind too.
      expect(r.directive.phase).toBe("construction");
      expect(r.directive.kind).toBe("run-stage");
    });
  });

  // --- No-state workflow-birth trio (3 cases) --- (t118.sh:276-315). Every diff
  // above seeds state then jumps; these drive a NO-STATE invocation
  // (createTestProject makes aidlc-docs/ but NO aidlc-state.md), the
  // workflow-birth paths the Wave 2 cutover leans on. They sat outside the close
  // gate, which is how the engine's known-scope / no-state defects (Wave-1 audit
  // findings 2 & 3) slipped through. Each pins the resolved scope / directive
  // kind the engine emits for a fresh workspace.
  describe("no-state workflow-birth trio — fresh workspace, no aidlc-state.md", () => {
    // (1) Bare KNOWN-SCOPE positional: `next bugfix` — the literal scope name is
    // NOT freeform intent. The engine recognises it as the scope (finding 2) and
    // emits the SAME workflow-birth print `next --scope bugfix` emits: a
    // run-then-continue directive naming `init --scope bugfix` (an explicitly
    // named scope on a fresh workspace is a request to START a workflow; the
    // pre-hardening engine relayed a circular no-state error here that told the
    // user to do exactly what they had just done). Pre-finding-2 this mis-read
    // the scope as prose and emitted an `ask` defaulting to "feature".
    test("no-state bare known-scope 'bugfix' -> birth print naming intent-birth (recognised as scope, not freeform) [finding 2]", () => {
      const r = emitNextNoState("bugfix");
      expect(r.directive.kind).toBe("print");
      // The print names the intent-birth move for the EXPLICITLY NAMED scope
      // (P4: --init retired; the engine NAMES the deterministic birth handler).
      expect(r.directive.message ?? "").toContain("intent-birth --scope bugfix");
      // Run-then-continue shape: the conductor births, then re-enters the loop.
      expect(r.directive.message ?? "").toContain("re-run `next` to continue");
      // STRONGER: a regression that mis-read bugfix as freeform would emit an
      // `ask` (the pre-fix bug) — assert it is NOT an ask, pinning finding 2.
      expect(r.directive.kind).not.toBe("ask");
    });

    test("no-state positional scope plus description -> direct birth with preserved arguments, never ask", () => {
      const r = emitNextNoState(
        "bugfix",
        "Fix",
        "duplicate",
        "todo",
        "persistence",
      );
      expect(r.directive.kind).toBe("print");
      expect(r.directive.message ?? "").toContain(
        "intent-birth --scope bugfix",
      );
      expect(r.directive.message ?? "").toContain(
        '--arguments "Fix duplicate todo persistence"',
      );
      expect(r.directive.kind).not.toBe("ask");
    });

    // (2) Freeform (<=5-word) intent: `next add dark mode toggle` — genuine prose,
    // NOT a scope name. The engine emits an `ask` (scope confirmation, the
    // read-only stand-in for the conductor's detect-scope + confirm). The control
    // proving the finding-2 fix narrows ONLY known-scope positionals.
    test("no-state freeform intent -> ask (scope confirmation; engine never calls AskUserQuestion)", () => {
      const r = emitNextNoState("add", "dark", "mode", "toggle");
      // .sh: assert_eq "$(json_field "$OUT" kind)" "ask"
      expect(r.directive.kind).toBe("ask");
    });

    // (3) Bare `next`, no state and NO explicitly named scope (env/default
    // resolution is not a birth signal): the engine cannot read a position to
    // advance from and creating one is init's (mutating) job, so it emits the
    // no-state error rather than guessing. The wording names the two explicit
    // moves that DO start a workflow — it must never be the circular "Start a
    // workflow with /aidlc <scope>" clause (an explicitly named scope births
    // via print now, so telling the user to retype it would be a lie).
    test("no-state bare next -> error directive (no position to advance from)", () => {
      const r = emitNextNoState();
      // .sh: assert_eq "$(json_field "$OUT" kind)" "error"
      expect(r.directive.kind).toBe("error");
      // STRONGER: pin the verbatim no-state wording (the .sh read only kind) so a
      // regression emitting an error of a DIFFERENT cause reds.
      expect(r.directive.message ?? "").toContain("No workflow state found");
      // RE-PIN the post-P4 guidance wording exactly: describe-what-to-build or
      // name-a-scope both birth; there is no --init. A regression back to the
      // circular clause (or a re-introduced --init) reds here.
      expect(r.directive.message ?? "").toContain(
        'Start one by describing what to build (/aidlc "build the auth service") or by naming a scope (/aidlc --scope <scope>).',
      );
    });

    // (4) Conflicting explicit namings: `next bugfix --scope mvp` names TWO
    // scopes at once. The precedence ladder's top rung is the explicit --scope
    // flag, so the birth must name the FLAG's scope — a positional that silently
    // outranked the flag would birth a workflow the user didn't ask for. And
    // with --scope routing explicitly, the positional text is pure description:
    // the parser must NOT peel its leading word, or an intent that happens to
    // OPEN with a scope word (`--scope feature "feature flags for billing"`)
    // silently loses it.
    test("no-state positional+flag conflict -> birth print names the FLAG's scope", () => {
      const r = emitNextNoState(
        "bugfix",
        "Fix",
        "duplicate",
        "todo",
        "--scope",
        "mvp",
      );
      expect(r.directive.kind).toBe("print");
      expect(r.directive.message ?? "").toContain("intent-birth --scope mvp");
      expect(r.directive.message ?? "").not.toContain("intent-birth --scope bugfix");
      expect(r.directive.message ?? "").toContain(
        '--arguments "bugfix Fix duplicate todo"',
      );
    });

    // (4b) The description keeps its leading scope word under explicit routing:
    // `--scope feature "feature flags for billing"` describes feature flags —
    // "feature" is prose, not positional-scope syntax, because --scope already
    // named the route (the pre-fix peel truncated this to "flags for billing").
    test("no-state --scope + description opening with a scope word -> description intact", () => {
      const r = emitNextNoState(
        "--scope",
        "feature",
        "feature",
        "flags",
        "for",
        "billing",
      );
      expect(r.directive.kind).toBe("print");
      expect(r.directive.message ?? "").toContain("intent-birth --scope feature");
      expect(r.directive.message ?? "").toContain(
        '--arguments "feature flags for billing"',
      );
    });

    // (5) --resume never births: resuming is a claim that a workflow already
    // exists, so with no state it must land on the no-state error even when a
    // scope is explicitly named (flag or positional) — not start a NEW workflow
    // the user didn't ask for.
    test("no-state --resume with a named scope -> error, never a birth print", () => {
      for (const args of [["--resume", "--scope", "mvp"], ["mvp", "--resume"], ["--resume"]]) {
        const r = emitNextNoState(...args);
        expect(r.directive.kind).toBe("error");
        expect(r.directive.message ?? "").toContain("No workflow state found");
      }
    });
  });
});
