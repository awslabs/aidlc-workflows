// covers: subcommand:aidlc-jump:resolve
//
// Engine differential corpus for `aidlc-orchestrate next`, mechanism = cli. It
// drives the engine's explicit-jump path for every scope with no model in the
// loop and pins each emitted directive against the frozen GOLDEN table below.
//
// The covers id is subcommand:aidlc-jump:resolve, not aidlc-orchestrate, BY
// DESIGN: this corpus exercises the explicit-jump branch of the engine
// (`next --stage <slug>`), which DELEGATES the in-scope SKIP check + target
// resolution to `aidlc-jump.ts resolve` by shelling out (aidlc-orchestrate.ts
// emitJumpDirective -> runTool("aidlc-jump.ts", ["resolve", ...])). The
// observable under test (the skipped-target mark behind diff B, and the
// run-stage emitted for the tool's resolved target_slug in diff A) is OWNED
// by aidlc-jump.ts resolve (handleResolve in aidlc-jump.ts). resolve is the
// unit credited.
//
// MECHANISM: SPAWN the real engine binary via node:child_process spawnSync
// (BUN + aidlc-orchestrate.ts). The directive is emitted as JSON to stdout
// (engine emit()), so we parse the PROCESS-boundary stdout and assert on the
// parsed directive's fields. An in-process twin would lose the spawn seam the
// engine relies on to relay the resolve subprocess's verbatim error, the very
// contract under test.
//
// Classified-stance anchor: the state-construction-bolt1 fixture is a feature
// workflow parked at Current Stage=functional-design (the first Construction
// Bolt's gate, the skeleton gate) with no stance recorded yet. Its gate is
// "unresolved" (the STRING sentinel, NOT a boolean), beside the
// per-fingerprint gate:true (diff A) and the init gate:false (the gate-axis
// anchor): the first Construction Bolt's gate depends on a practices-derived
// STANCE the engine cannot compute, so it defers to the conductor's classify
// round-trip and emits the sentinel. The case pins gate, stage, phase and kind.
//
// Nothing is written under tests/fixtures/**.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  proposalFollowUp,
  removeWorkspaceRecord,
  REPO_ROOT,
  resetAidlcEnv,
  runOrchestrateNext,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
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
  resetAidlcEnv();
});

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

// A clean env for every spawn: drop AWS_AIDLC_DEFAULT_SCOPE so a developer's
// shell cannot reach the no-state cases (resolveScope reads the env only after
// state, --scope and a positional scope, so seeded state never needed this).
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
  proj?: string;
}

function emitScopeStage(scope: string, stage: string): EmitResult {
  const proj = createOrchestrationTestProject();
  tempDirs.push(proj);
  seedStateFile(proj, join(FIXTURES_DIR, "state-initialization-done.md"));
  const statePath = seededStateFile(proj);
  // Swap the Scope field AND rebuild the Stage Progress suffixes to the new scope's
  // grid column. The fixture was authored for the feature scope; the jump path
  // honours the state's per-stage suffixes as the live plan (they override the
  // static grid, matching the router), so a state whose Scope says bugfix but whose
  // suffixes still carry feature's plan is internally inconsistent - a shape the
  // real tools (intent create/scope-change/recompose, which all rebuild suffixes)
  // never produce. Rebuilding keeps this diff's intent intact: the target IS off
  // the seeded plan.
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
  const res = runOrchestrateNext(TOOL, proj, ["--stage", stage], {
    env: cleanEnv(),
  });
  return {
    status: res.status,
    directive: parseDirective(res.stdout),
    raw: res.out,
  };
}

interface FingerprintLoopResult {
  print: Directive; // STEP 1: the print naming `execute --target <fp> --direction forward`
  printRaw: string;
  runStage: Directive; // STEP 3: the run-stage the engine lands on after the commit
  runStageRaw: string;
}

// Drive the FULL jump-commit loop for one scope's fingerprint. A WITH-STATE jump
// is a MUTATION the conductor commits, so the loop is THREE steps:
//   (1) `next --stage <fp>` emits a `print` naming `execute --target <fp>
//       --direction forward` (Current Stage is pivoted to the last init stage
//       state-init so every post-init fingerprint resolves forward, never redo);
//   (2) run `aidlc-jump.ts execute` to commit the jump (mutating state);
//   (3) bare `next` then reads the pivoted state and emits the run-stage for the
//       fingerprint — the exact stage|phase|gate of the frozen golden.
function emitScopeFingerprintLoop(scope: string, fp: string): FingerprintLoopResult {
  const proj = createOrchestrationTestProject();
  tempDirs.push(proj);
  seedStateFile(proj, join(FIXTURES_DIR, "state-initialization-done.md"));
  const statePath = seededStateFile(proj);
  // Swap ONLY the Scope field, and pivot Current Stage to the last init stage so
  // the fingerprint resolves forward for every scope.
  let md = readFileSync(statePath, "utf-8").replace(
    /^- \*\*Scope\*\*: .*$/m,
    `- **Scope**: ${scope}`,
  );
  md = md.replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: state-init");
  writeFileSync(statePath, md, "utf-8");
  // STEP 1: the print naming the execute delegate.
  const step1 = runOrchestrateNext(TOOL, proj, ["--stage", fp], {
    env: cleanEnv(),
  });
  // STEP 2: commit the jump the print named (mutating state).
  spawnSync(
    BUN,
    [JUMP_TOOL, "execute", "--target", fp, "--direction", "forward", "--scope", scope, "--project-dir", proj],
    { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: cleanEnv() },
  );
  // STEP 3: re-run `next` over the pivoted state — the landed run-stage.
  const step3 = runOrchestrateNext(TOOL, proj, [], {
    env: cleanEnv(),
  });
  return {
    print: parseDirective(step1.stdout),
    printRaw: step1.out,
    runStage: parseDirective(step3.stdout),
    runStageRaw: step3.out,
  };
}

// Spawn `next` (no --stage) over a directly-seeded fixture — used by the
// gate-axis anchor, where the happy path runs the in-flight init stage straight
// from state.
function emitNext(fixtureFile: string): EmitResult {
  const proj = createOrchestrationTestProject();
  tempDirs.push(proj);
  seedStateFile(proj, join(FIXTURES_DIR, fixtureFile));
  const res = runOrchestrateNext(TOOL, proj, [], {
    env: cleanEnv(),
  });
  return {
    status: res.status,
    directive: parseDirective(res.stdout),
    raw: res.out,
  };
}

function emitNextNoState(...args: string[]): EmitResult {
  const proj = createTestProject();
  tempDirs.push(proj);
  // createTestProject seeds a default intent record; the no-state creation path
  // requires a GENUINELY empty workspace (zero intents), else the engine asks to
  // SELECT the existing intent instead of creating. Strip the seeded record.
  removeWorkspaceRecord(proj);
  // This engine's own option rides ahead of the person's words, which is
  // where every caller of `next` puts it.
  const res = spawnSync(BUN, [TOOL, "next", "--project-dir", proj, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: cleanEnv(),
  });
  const raw = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { status: res.status ?? -1, directive: parseDirective(res.stdout ?? ""), raw, proj };
}

// The same line, then the agent's step after the plan proposal print (the
// test's stand-in reading of the words), on the same fresh workspace.
function emitNextNoStateThroughProposal(...args: string[]): EmitResult {
  const first = emitNextNoState(...args);
  const proposal = proposalFollowUp(first.directive);
  if (proposal === null) return first;
  const res = spawnSync(BUN, [TOOL, "next", "--project-dir", first.proj ?? "", ...proposal], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: cleanEnv(),
  });
  const raw = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return { status: res.status ?? -1, directive: parseDirective(res.stdout ?? ""), raw, proj: first.proj };
}

// The creation print names the request by question id; the exact text lives in
// the private question copy.
function questionText(r: EmitResult): string {
  const id = (r.directive.message ?? "").match(/--request ([0-9a-f]{8})/)?.[1] ?? "";
  expect(id).toMatch(/^[0-9a-f]{8}$/);
  return JSON.parse(
    readFileSync(join(r.proj ?? "", "aidlc", ".aidlc-sessions", "questions", `${id}.json`), "utf-8"),
  ).text;
}

// The engine emits exactly one directive as JSON to stdout. Parse it; an
// unparseable payload yields {} so a field read surfaces as undefined.
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
// Each row: scope, the first non-init EXECUTE stage (fingerprint) + its phase,
// and a representative SKIP-for-scope stage (null when the scope skips nothing -
// enterprise/feature run every stage). gate is always true for every fingerprint
// (no scope's first post-init EXECUTE stage is an initialization stage). ---
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
  { scope: "classic", fingerprint: "reverse-engineering", phase: "inception", skip: "intent-capture" },
  { scope: "workshop", fingerprint: "reverse-engineering", phase: "inception", skip: "intent-capture" },
  { scope: "express", fingerprint: "reverse-engineering", phase: "inception", skip: "intent-capture" },
];

describe("t118 engine differential corpus — aidlc-orchestrate next (migrated from t118-engine-differential.sh, plan 24)", () => {
  // --- Diff A: fingerprint stage in scope -> print->execute->run-stage (11 cases) ---
  // A WITH-STATE jump is a MUTATION the conductor commits, so the differential runs
  // END-TO-END through the loop (emitScopeFingerprintLoop):
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
        // Assert the real JSON boolean, not the rendered "true" token. gate is the
        // human-judgement-boundary axis.
        expect(r.runStage.gate).toBe(true);
      });
    }
  });

  // --- Diff B: a SKIP-for-scope stage -> the jump does what was asked (9 cases) ---
  // The negative half of the fingerprint. 9 scopes SKIP at least one stage.
  // resolve marks the skipped target (the engine asks with --allow-skipped) and
  // the engine names the move: a stage AHEAD of the cursor goes back on the plan
  // (recompose --add, with the jump as its reason) and the jump follows; the
  // fixture's own cursor stage (intent-capture) is the current stage, which the
  // plan moves past, so the engine names the isolated run instead. enterprise +
  // feature SKIP nothing (golden skip=null); their negative coverage is the
  // gate-axis anchor below.
  describe("diff B: per-scope SKIP stage -> back on the plan, or the isolated run", () => {
    for (const row of GOLDEN) {
      if (row.skip === null) continue;
      const skip = row.skip;
      test(`scope '${row.scope}' SKIP stage '${skip}' -> named move for a stage the plan skips`, () => {
        const r = emitScopeStage(row.scope, skip);
        const msg = r.directive.message ?? "";
        expect(msg).toContain(`is not part of this work: its ${row.scope} scope (the set of stages this work runs) leaves it out`);
        if (skip === "intent-capture") {
          expect(r.directive.kind).toBe("print");
          expect(msg).toContain("Do you want me to run it on its own now");
          expect(msg).toContain("it is the current stage");
          expect(msg).toContain(`--stage ${skip} --single`);
        } else {
          expect(r.directive.kind).toBe("print");
          expect(msg).toContain(`engine recompose --add ${skip} --reason 'jump to ${skip}'`);
          expect(msg).toContain(`execute --target ${skip} --direction forward --scope ${row.scope}`);
        }
        expect(msg).not.toContain("change scope");
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
      expect(r.directive.gate).toBe(false);
      expect(r.directive.stage).toBe("workspace-detection");
      expect(r.directive.kind).toBe("run-stage");
    });
  });

  // --- Classified-stance anchor: the skeleton gate emits gate:"unresolved" (1
  // case) --- The THIRD gate value, alongside the per-fingerprint gate:true (diff A)
  // and the init gate:false (anchor above). The FIRST Construction Bolt's gate
  // depends on a practices-derived STANCE the engine cannot compute, so it emits
  // the sentinel string gate:"unresolved" and defers to the conductor's classify
  // round-trip (per the engine design). state-construction-bolt1 is a feature
  // workflow parked at Current Stage=functional-design (the first construction
  // EXECUTE stage = the skeleton gate) with no stance recorded, so bare `next`
  // emits the run-stage for it carrying gate:"unresolved" - NOT a boolean. The
  // full classify round-trip is WALK C in the integration-tier t118; this
  // single-directive anchor pins the engine's emit of the sentinel itself.
  describe("classified-stance anchor — skeleton gate -> run-stage gate:\"unresolved\"", () => {
    test("skeleton-gate stage (functional-design, Bolt 1, no stance) -> run-stage gate:\"unresolved\" (classify-round-trip sentinel)", () => {
      const r = emitNext("state-construction-bolt1.md");
      expect(r.directive.gate).toBe("unresolved");
      expect(r.directive.stage).toBe("functional-design");
      expect(r.directive.phase).toBe("construction");
      expect(r.directive.kind).toBe("run-stage");
    });
  });

  // --- No-state workflow creation cases --- Every diff above seeds state then
  // jumps; these drive a NO-STATE invocation. Each pins the resolved scope /
  // directive kind the engine emits for a fresh workspace.
  describe("no-state workflow creation trio - fresh workspace, no aidlc-state.md", () => {
    test("no-state bare known-scope 'bugfix' -> the plan is kept and the person is asked what it is for (recognised as scope, not freeform) [finding 2]", () => {
      const r = emitNextNoState("bugfix");
      expect(r.directive.kind).toBe("print");
      // The scope is the person's pick with nothing described yet (#2355): no
      // creation is named, and the answer's command keeps the plan.
      expect(r.directive.message ?? "").not.toContain("intent create");
      expect(r.directive.message ?? "").toContain("next --scope bugfix -- <their words>");
      // A regression that mis-read bugfix as freeform would emit an `ask` - assert it
      // is NOT an ask.
      expect(r.directive.kind).not.toBe("ask");
    });

    test("no-state positional scope plus loose words -> both readings, the request preserved, never ask", () => {
      // A plan's name at the start of their own sentence, with loose words
      // after it, is ambiguous with their first word, so the engine takes
      // nothing and names both readings (t-three-ways-to-read-a-line). Nothing
      // is asked of the person and not a word of theirs is spent.
      const r = emitNextNoState(
        "bugfix",
        "Fix",
        "duplicate",
        "todo",
        "persistence",
      );
      expect(r.directive.kind).toBe("print");
      expect(r.directive.message ?? "").toContain("--scope bugfix -- 'Fix duplicate todo persistence'");
      expect(r.directive.message ?? "").toContain("'bugfix Fix duplicate todo persistence'");
      expect(r.directive.kind).not.toBe("ask");
    });

    // (1b) A plan name with a colon is the person naming the plan, whether the
    // agent quotes the whole request as one argument (Kiro IDE's PowerShell
    // does) or passes words: "/aidlc classic: Build a notes app" starts the
    // classic plan with no question, in any letter case.
    test("no-state '<scope>: description' -> direct creation, also as one quoted argument", () => {
      for (const args of [
        ["bugfix: Fix duplicate todo persistence"],
        ["bugfix:", "Fix", "duplicate", "todo", "persistence"],
        ["Bugfix: Fix duplicate todo persistence"],
      ]) {
        const r = emitNextNoState(...args);
        expect(r.directive.kind).toBe("print");
        expect(r.directive.message ?? "").toContain("intent create --scope bugfix");
        expect(questionText(r)).toBe("Fix duplicate todo persistence");
      }
    });

    // (1c) One quoted argument that only OPENS with a plan's name and no colon
    // stays the person's request: "classic car rental website" describes a car
    // site, and only the agent, reading the person's words, may split a plan
    // name off as its own argument.
    test("no-state one quoted argument opening with a scope word and no colon -> not read as the plan", () => {
      // Opening with a plan's name, the one-argument form reads the same way as
      // the split one: both readings go to the agent, and the plan is not
      // assumed. A word that is no plan's name is still their request.
      const opening = emitNextNoState("classic car rental website");
      expect(opening.directive.message ?? "").not.toContain("intent create --scope classic");
      expect(opening.directive.kind).toBe("print");
      expect(opening.directive.message ?? "").toContain("'classic car rental website'");
      const other = emitNextNoState("note: build a classic car site");
      expect(other.directive.message ?? "").not.toContain("intent create --scope classic");
      // A plan's name inside the sentence is their word: the request reaches the
      // agent's plan proposal step, never a plan picked from it.
      expect(other.directive.kind).toBe("print");
      expect(other.directive.message ?? "").toContain("--propose <plan> --request");
    });

    // (2) Freeform (<=5-word) intent: `next add dark mode toggle` — genuine prose,
    // NOT a scope name. After the agent's plan proposal step, the engine emits an
    // `ask` (scope confirmation, the read-only stand-in for the conductor's
    // detect-scope + confirm). The control proving scope recognition narrows ONLY
    // known-scope positionals.
    test("no-state freeform intent -> ask (scope confirmation; engine never calls AskUserQuestion)", () => {
      // The words reach the agent as the plan proposal step first; its plan
      // returns the plan question (t-plan-proposed-by-the-agent).
      const r = emitNextNoStateThroughProposal("add", "dark", "mode", "toggle");
      expect(r.directive.kind).toBe("ask");
    });

    // (3) Bare `next`, no state and NO explicitly named scope (env/default
    // resolution is not a creation signal): the engine cannot read a position to
    // advance from and creating one is intent create's (mutating) job, so it emits
    // the no-state error rather than guessing. The wording names the two explicit
    // moves that DO start a workflow — it must never be the circular "Start a
    // workflow with /aidlc <scope>" clause.
    test("no-state bare next -> error directive (no position to advance from)", () => {
      const r = emitNextNoState();
      expect(r.directive.kind).toBe("error");
      // Pin the no-state wording so a regression emitting an error of a DIFFERENT
      // cause reds.
      expect(r.directive.message ?? "").toContain("No workflow state found");
      // Pin the guidance wording exactly: describe-what-to-build or
      // describe-what-to-build and name-a-scope both create intents; there is no
      // --init. A regression back to the
      // circular clause (or a re-introduced --init) reds here.
      expect(r.directive.message ?? "").toContain(
        'Start one by describing what to build (/aidlc "build the auth service") or by naming a scope (/aidlc --scope <scope>).',
      );
    });

    // (4) Conflicting explicit namings: `next bugfix --scope mvp` names TWO
    // scopes at once. The precedence ladder's top rung is the explicit --scope
    // flag, so the creation must name the FLAG's scope - a positional that silently
    // outranked the flag would create a workflow the user didn't ask for. And
    // with --scope routing explicitly, the positional text is pure description:
    // the parser must NOT peel its leading word, or an intent that happens to
    // OPEN with a scope word (`--scope feature "feature flags for billing"`)
    // silently loses it.
    test("no-state positional+flag conflict -> creation print names the FLAG's scope", () => {
      const r = emitNextNoState(
        "bugfix",
        "Fix",
        "duplicate",
        "todo",
        "--scope",
        "mvp",
      );
      expect(r.directive.kind).toBe("print");
      expect(r.directive.message ?? "").toContain("intent create --scope mvp");
      expect(r.directive.message ?? "").not.toContain("intent create --scope bugfix");
      expect(questionText(r)).toBe("bugfix Fix duplicate todo");
    });

    // (4b) The description keeps its leading scope word under explicit routing:
    // `--scope feature "feature flags for billing"` describes feature flags:
    // "feature" is prose, not positional-scope syntax, because --scope already
    // named the route.
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
      expect(r.directive.message ?? "").toContain("intent create --scope feature");
      expect(questionText(r)).toBe("feature flags for billing");
    });

    // (5) --resume never creates: resuming is a claim that a workflow already
    // exists, so with no state it must land on the no-state error even when a
    // scope is explicitly named (flag or positional) — not start a NEW workflow
    // the user didn't ask for.
    test("no-state --resume with a named scope -> error, never a creation print", () => {
      for (const args of [["--resume", "--scope", "mvp"], ["mvp", "--resume"], ["--resume"]]) {
        const r = emitNextNoState(...args);
        expect(r.directive.kind).toBe("error");
        expect(r.directive.message ?? "").toContain("No workflow state found");
      }
    });
  });
});
