// covers: hook:aidlc-statusline
//
// Port of tests/unit/t11-hook-statusline.sh (TAP plan 62), mechanism = none.
// aidlc-statusline.ts is a HOOK, not a CLI tool — Claude Code registers it via
// the `statusLine` setting and pipes a JSON blob on stdin, expecting a single
// rendered status line on stdout. There is no subcommand surface and no
// process.exit contract to assert (the hook always exits 0 and writes via
// process.stdout.write). The hook reads project state off disk and renders the
// phase / progress-bar / breadcrumb / model+ctx suffix. It is mechanism=none
// (no LLM, no tokens), but it is NOT a pure importable function: `main()` runs
// at module top-level and reads `Bun.stdin.text()`. So — exactly as the .sh did
// — every contract is exercised by SPAWNING the hook with controlled stdin and
// asserting on the stdout it writes. spawnCount = all; inProcess = 0.
//
// MECHANISM NOTE: the .sh shelled out via `echo '<json>' | bun "$HOOK"`. We
// spawn the same `bun <hook>` binary through node:child_process spawnSync,
// feeding the JSON as `input` (so stdin is a pipe, not a TTY — the hook's
// `process.stdin.isTTY ? "" : await Bun.stdin.text()` guard reads it). Output
// is read back from res.stdout, mirroring the .sh's `$(... 2>/dev/null)`
// capture. The env-var fall-through case (.sh Test 10) passes empty stdin plus
// CLAUDE_PROJECT_DIR in the child env, identical to the .sh.
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_state_file +
// cleanup_test_project per case): each case uses a FRESH temp project dir
// (createTestProject, toPortablePath-wrapped so the project path round-trips on
// native Windows when embedded in the stdin JSON). Seeded fixtures come from the
// shipped tests/fixtures/state-*.md via seedStateFile, exactly as the .sh did;
// the inline-`cat`-heredoc cases (.sh Tests 8, 9, 22-24, 42-49, 37, 38) are
// rebuilt by writing the same bytes to <proj>/aidlc-docs/aidlc-state.md. All
// temp dirs are cleaned in afterAll. Nothing is written under tests/fixtures/**.
//
// PARITY MAP — every .sh assert_* line has an expect() counterpart below; the
// .sh's 62-assertion plan maps 1:1 (a few cases bundle 2-3 asserts the .sh ran
// against one $OUTPUT, kept together since they observe the same render). The
// .sh's grep/assert_contains become expect(out).toContain(...); assert_eq
// becomes expect(out).toBe(...); assert_match (ERE) becomes a RegExp .toMatch;
// assert_not_contains becomes .not.toContain; the assert_lt timing check
// (Test 16) becomes an elapsed-ms expect(<500). STRONGER additions are tagged.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const HOOK = join(REPO_ROOT, "dist", "claude", ".claude", "hooks", "aidlc-statusline.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** Fresh empty temp project (create_test_project). */
function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

const statePath = (p: string): string => join(p, "aidlc-docs", "aidlc-state.md");

/** Write a state file body to <proj>/aidlc-docs/aidlc-state.md (the inline `cat` heredocs). */
function writeState(p: string, body: string): void {
  mkdirSync(join(p, "aidlc-docs"), { recursive: true });
  writeFileSync(statePath(p), body);
}

interface RunResult {
  status: number;
  out: string; // stdout (the rendered status line)
}

/**
 * Spawn the statusline hook, piping `stdin` as stdin and merging `env` into the
 * child env. Mirrors `echo '<stdin>' | [ENV=…] bun "$HOOK" 2>/dev/null`.
 * stderr is discarded (the .sh's 2>/dev/null). The hook is NOT given a TTY
 * stdin (spawnSync `input` is a pipe), so its isTTY guard reads the JSON.
 */
function runHook(stdin: string, env: Record<string, string> = {}): RunResult {
  const res = spawnSync(BUN, [HOOK], {
    input: stdin,
    encoding: "utf-8",
    // Strip any inherited CLAUDE_PROJECT_DIR so it can't leak into stdin-driven
    // cases; the .sh ran each invocation in a clean shell with only the vars it
    // set. Callers that need the env-var fall-through pass it explicitly.
    env: { ...process.env, CLAUDE_PROJECT_DIR: "", ...env },
  });
  return { status: res.status ?? -1, out: res.stdout ?? "" };
}

/** Build the stdin JSON the .sh constructed: {"workspace":{"project_dir":"<p>"}}. */
function stdinFor(p: string): string {
  return JSON.stringify({ workspace: { project_dir: p } });
}

// ESC literal — the .sh used `ESC=$'\033'`; the hook emits "\x1b[..m".
const ESC = "\x1b";

const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");
const STATE_CONSTRUCTION = join(FIXTURES_DIR, "state-construction.md");
const STATE_OPERATION = join(FIXTURES_DIR, "state-operation.md");
const STATE_COMPLETED = join(FIXTURES_DIR, "state-completed.md");
const STATE_JUMPED = join(FIXTURES_DIR, "state-jumped.md");

describe("t11 aidlc-statusline hook (migrated from t11-hook-statusline.sh, plan 62)", () => {
  // --- .sh Test 1: ready with no state file ---
  test("1: shows [AIDLC] ready when no state file", () => {
    const p = proj();
    // create_test_project makes aidlc-docs/ but no state file (the .sh rm -f's it).
    const r = runHook(stdinFor(p));
    // assert_eq "$OUTPUT" "[AIDLC] ready" — exact match on the trimmed line.
    expect(r.out.trim()).toBe("[AIDLC] ready");
  });

  // --- .sh Test 2: shows IDEATION phase ---
  test("2: shows IDEATION phase", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    expect(runHook(stdinFor(p)).out).toContain("IDEATION");
  });

  // --- .sh Test 3: shows display name (not slug) ---
  test("3: shows stage display name Feasibility", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    expect(runHook(stdinFor(p)).out).toContain("Feasibility");
  });

  // --- .sh Test 4: agent without -agent slug (two asserts on one render) ---
  test("4: shows agent display name and strips slug", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const out = runHook(stdinFor(p)).out;
    expect(out).toContain("Architect");
    expect(out).not.toContain("aidlc-architect-agent");
  });

  // --- .sh Test 6: phase progress 2/7 ---
  // IDEATION has 7 non-SKIP stages, 2 are [x] (intent-capture, market-research).
  test("6: computes phase progress 2/7", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    expect(runHook(stdinFor(p)).out).toContain("2/7");
  });

  // --- .sh Test 7: output starts with [AIDLC] prefix ---
  test("7: output starts with [AIDLC] prefix", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    expect(runHook(stdinFor(p)).out).toMatch(/^\[AIDLC\]/);
  });

  // --- .sh Test 8: ready when phase empty (trailing space after colon) ---
  test("8: shows [AIDLC] ready when Lifecycle Phase value is empty", () => {
    const p = proj();
    writeState(
      p,
      [
        "# AI-DLC State Tracking",
        "## Current Status",
        "- **Lifecycle Phase**: ",
        "- **Current Stage**: feasibility",
        "",
      ].join("\n"),
    );
    expect(runHook(stdinFor(p)).out.trim()).toBe("[AIDLC] ready");
  });

  // --- .sh Test 9: all-SKIP phase shows no progress fraction ---
  test("9: all-SKIP phase shows empty progress (no n/m fraction)", () => {
    const p = proj();
    writeState(
      p,
      `# AI-DLC State Tracking
## Stage Progress
### IDEATION PHASE
- [ ] intent-capture — SKIP: not needed
- [ ] market-research — SKIP: not needed
- [ ] feasibility — SKIP: not needed
- [ ] scope-definition — SKIP: not needed
- [ ] team-formation — SKIP: not needed
- [ ] rough-mockups — SKIP: not needed
- [ ] approval-handoff — SKIP: not needed
## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: feasibility
- **Active Agent**: aidlc-product-agent
`,
    );
    // .sh: grep -q "[0-9]/[0-9]" must NOT match.
    expect(runHook(stdinFor(p)).out).not.toMatch(/[0-9]\/[0-9]/);
  });

  // --- .sh Test 10: empty stdin falls through to CLAUDE_PROJECT_DIR env var ---
  test("10: empty stdin falls through to CLAUDE_PROJECT_DIR env var", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    // echo "" | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK"
    expect(runHook("", { CLAUDE_PROJECT_DIR: p }).out).toContain("IDEATION");
  });

  // --- .sh Test 11: CONSTRUCTION phase ---
  test("11: shows CONSTRUCTION phase", () => {
    const p = proj();
    seedStateFile(p, STATE_CONSTRUCTION);
    expect(runHook(stdinFor(p)).out).toContain("CONSTRUCTION");
  });

  // --- .sh Test 12: construction progress count [0-9]/9 ---
  // Construction fixture: 9 non-SKIP checkbox lines under CONSTRUCTION PHASE
  // (cart: 2; checkout: 7); 2 are [x] -> 2/9.
  test("12: construction shows progress fraction (regex /9)", () => {
    const p = proj();
    seedStateFile(p, STATE_CONSTRUCTION);
    const out = runHook(stdinFor(p)).out;
    expect(out).toMatch(/[0-9]\/9/);
    // STRONGER (S1): the .sh only regex-matched "/9"; pin the exact numerator.
    expect(out).toContain("2/9");
  });

  // --- .sh Test 13: OPERATION phase ---
  test("13: shows OPERATION phase", () => {
    const p = proj();
    seedStateFile(p, STATE_OPERATION);
    expect(runHook(stdinFor(p)).out).toContain("OPERATION");
  });

  // --- .sh Test 14: operation progress count [0-9]/7 ---
  test("14: operation shows progress fraction (regex /7)", () => {
    const p = proj();
    seedStateFile(p, STATE_OPERATION);
    // operation fixture: 7 stages, 0 [x] ([-] deployment-pipeline) -> 0/7.
    const out = runHook(stdinFor(p)).out;
    expect(out).toMatch(/[0-9]\/7/);
    // STRONGER (S2): pin the exact numerator the fixture produces.
    expect(out).toContain("0/7");
  });

  // --- .sh Test 15: completed fixture shows COMPLETE ---
  test("15: completed fixture shows COMPLETE", () => {
    const p = proj();
    seedStateFile(p, STATE_COMPLETED);
    expect(runHook(stdinFor(p)).out).toContain("COMPLETE");
  });

  // --- .sh Test 16: statusline completes within 500ms ---
  test("16: statusline completes within 500ms", () => {
    const p = proj();
    seedStateFile(p, STATE_CONSTRUCTION);
    const t0 = Date.now();
    runHook(stdinFor(p));
    const elapsed = Date.now() - t0;
    // assert_lt "$ELAPSED_MS" 500. spawnSync includes process startup, which is
    // the same wall-clock the .sh measured around `bun "$HOOK"`.
    expect(elapsed).toBeLessThan(500);
  }, 30000);

  // --- .sh Test 17: [S] stages excluded from construction progress total ---
  test("17: [S] stages excluded from construction total (0/3 + empty bar)", () => {
    const p = proj();
    seedStateFile(p, STATE_JUMPED);
    const out = runHook(stdinFor(p)).out;
    expect(out).toContain("0/3");
    expect(out).toContain("[░░░░░░░░░░]");
  });

  // --- .sh Test 18: [S] in completed ideation phase show correct count ---
  test("18: [S] stages excluded; ideation shows 2/2 + full bar", () => {
    const p = proj();
    seedStateFile(p, STATE_JUMPED);
    // Flip only the Lifecycle Phase pointer to IDEATION (not the heading).
    const body = require("node:fs")
      .readFileSync(statePath(p), "utf-8")
      .replace("**Lifecycle Phase**: CONSTRUCTION", "**Lifecycle Phase**: IDEATION");
    writeFileSync(statePath(p), body);
    const out = runHook(stdinFor(p)).out;
    expect(out).toContain("2/2");
    expect(out).toContain("[▓▓▓▓▓▓▓▓▓▓]");
  });

  // --- .sh Test 19: progress bar with filled and empty chars ---
  test("19: progress bar contains filled and empty chars", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const out = runHook(stdinFor(p)).out;
    expect(out).toContain("▓");
    expect(out).toContain("░");
  });

  // --- .sh Test 20: breadcrumb > separator present ---
  test("20: breadcrumb > separator present", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    expect(runHook(stdinFor(p)).out).toContain(" > ");
  });

  // --- .sh Test 21: agent -- separator present ---
  test("21: agent -- separator present", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    expect(runHook(stdinFor(p)).out).toContain(" -- ");
  });

  // --- .sh Tests 22-24: init-phase render (one heredoc, three asserts) ---
  test("22-24: init-phase shows INITIALIZATION + Workspace Detection + filled bar", () => {
    const p = proj();
    writeState(
      p,
      `# AI-DLC State Tracking
## Execution Plan Summary
- **Total Stages**: 3
- **Completed**: 1
## Stage Progress
### INITIALIZATION PHASE
- [x] workspace-scaffold — EXECUTE
- [-] workspace-detection — EXECUTE
- [ ] state-init — EXECUTE
## Current Status
- **Lifecycle Phase**: INITIALIZATION
- **Current Stage**: workspace-detection
- **Active Agent**: aidlc-developer-agent
- **Status**: Running
`,
    );
    const out = runHook(stdinFor(p)).out;
    expect(out).toContain("INITIALIZATION"); // Test 22
    expect(out).toContain("Workspace Detection"); // Test 23
    expect(out).toContain("▓"); // Test 24
  });

  // --- .sh Test 26: Bedrock model abbreviated ---
  test("26: Bedrock opus-4-6 model abbreviates to BR:opus-4-6", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const stdin = JSON.stringify({
      workspace: { project_dir: p },
      model: { id: "us.anthropic.claude-opus-4-6-v1" },
      context_window: { used_percentage: 45.2 },
    });
    expect(runHook(stdin).out).toContain("BR:opus-4-6");
  });

  // --- .sh Test 27: context percentage appears (rounded) ---
  test("27: context percentage appears as ctx:45%", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const stdin = JSON.stringify({
      workspace: { project_dir: p },
      model: { id: "us.anthropic.claude-opus-4-6-v1" },
      context_window: { used_percentage: 45.2 },
    });
    expect(runHook(stdin).out).toContain("ctx:45%");
  });

  // --- .sh Test 28: model + context appear after agent ---
  test("28: model and context appear after agent", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const stdin = JSON.stringify({
      workspace: { project_dir: p },
      model: { id: "us.anthropic.claude-opus-4-6-v1" },
      context_window: { used_percentage: 45.2 },
    });
    // assert_match "Agent.*BR:.*ctx:"
    expect(runHook(stdin).out).toMatch(/Agent.*BR:.*ctx:/);
  });

  // --- .sh Test 29: Bedrock prefix detection (sonnet) ---
  test("29: Bedrock sonnet abbreviates to BR:sonnet-4", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const stdin = JSON.stringify({
      workspace: { project_dir: p },
      model: { id: "us.anthropic.claude-sonnet-4-20250514" },
      context_window: { used_percentage: 30 },
    });
    expect(runHook(stdin).out).toContain("BR:sonnet-4");
  });

  // --- .sh Test 30: non-Bedrock model has no BR: prefix (two asserts) ---
  test("30: non-Bedrock model name appears without BR: prefix", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const stdin = JSON.stringify({
      workspace: { project_dir: p },
      model: { id: "claude-sonnet-4-20250514" },
      context_window: { used_percentage: 30 },
    });
    const out = runHook(stdin).out;
    expect(out).toContain("sonnet-4");
    expect(out).not.toContain("BR:");
  });

  // --- .sh Test 31: context green for low usage ---
  test("31: context green color (ESC[32m) for usage < 50%", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const stdin = JSON.stringify({
      workspace: { project_dir: p },
      model: { id: "claude-sonnet-4-20250514" },
      context_window: { used_percentage: 30 },
    });
    expect(runHook(stdin).out).toContain(`${ESC}[32m`);
  });

  // --- .sh Test 32: context red for high usage ---
  test("32: context red color (ESC[31m) for usage >= 75%", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const stdin = JSON.stringify({
      workspace: { project_dir: p },
      model: { id: "claude-sonnet-4-20250514" },
      context_window: { used_percentage: 85 },
    });
    expect(runHook(stdin).out).toContain(`${ESC}[31m`);
  });

  // --- .sh Test 33: no model/context in JSON -> no suffix (two asserts) ---
  test("33: no model/context in JSON means no BR: or ctx: suffix", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const stdin = JSON.stringify({ workspace: { project_dir: p } });
    const out = runHook(stdin).out;
    expect(out).not.toContain("BR:");
    expect(out).not.toContain("ctx:");
  });

  // --- .sh Test 34: shipped Bedrock Opus 4-7 ID abbreviates ---
  test("34: shipped Opus 4.7 Bedrock ID abbreviates to BR:opus-4-7", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const stdin = JSON.stringify({
      workspace: { project_dir: p },
      model: { id: "us.anthropic.claude-opus-4-7" },
      context_window: { used_percentage: 40 },
    });
    expect(runHook(stdin).out).toContain("BR:opus-4-7");
  });

  // --- .sh Test 42: 1-stage phase math (poc-style scope), two states ---
  test("42: 1-stage phase 0/1 empty bar then 1/1 full bar", () => {
    const p = proj();
    writeState(
      p,
      `# AI-DLC State Tracking
## Stage Progress
### INCEPTION PHASE
- [S] reverse-engineering — SKIP
- [S] requirements-analysis — SKIP
- [S] user-stories — SKIP
- [S] refined-mockups — SKIP
- [S] application-design — SKIP
- [S] units-generation — SKIP
- [S] delivery-planning — SKIP
### CONSTRUCTION PHASE
- [S] functional-design — SKIP
- [S] nfr-requirements — SKIP
- [S] nfr-design — SKIP
- [S] infrastructure-design — SKIP
- [-] code-generation — EXECUTE
- [S] build-and-test — SKIP
- [S] ci-pipeline — SKIP
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Active Agent**: aidlc-developer-agent
- **Status**: Running
`,
    );
    const outEmpty = runHook(stdinFor(p)).out;
    expect(outEmpty).toContain("0/1");
    expect(outEmpty).toContain("[░░░░░░░░░░]");

    // Bump code-generation [-] -> [x]; same file (the .sh's sed -i.bak edit).
    const body = require("node:fs")
      .readFileSync(statePath(p), "utf-8")
      .replace("- [-] code-generation", "- [x] code-generation");
    writeFileSync(statePath(p), body);
    const outFull = runHook(stdinFor(p)).out;
    expect(outFull).toContain("1/1");
    expect(outFull).toContain("[▓▓▓▓▓▓▓▓▓▓]");
  });

  // --- .sh Test 43: OPERATION phase mid-progression bar ---
  test("43: operation 3/7 renders 4 filled chars", () => {
    const p = proj();
    writeState(
      p,
      `# AI-DLC State Tracking
## Stage Progress
### OPERATION PHASE
- [x] deployment-pipeline — EXECUTE
- [x] environment-provisioning — EXECUTE
- [x] deployment-execution — EXECUTE
- [-] observability-setup — EXECUTE
- [ ] incident-response — EXECUTE
- [ ] performance-validation — EXECUTE
- [ ] feedback-optimization — EXECUTE
## Current Status
- **Lifecycle Phase**: OPERATION
- **Current Stage**: observability-setup
- **Active Agent**: aidlc-operations-agent
- **Status**: Running
`,
    );
    const out = runHook(stdinFor(p)).out;
    expect(out).toContain("3/7"); // floor(3*10/7)=4 filled
    expect(out).toContain("[▓▓▓▓░░░░░░]");
  });

  // --- .sh Test 44: CONSTRUCTION -> OPERATION phase-boundary reset ---
  test("44: construction full bar then operation empty bar on phase pointer flip", () => {
    const p = proj();
    writeState(
      p,
      `# AI-DLC State Tracking
## Stage Progress
### CONSTRUCTION PHASE
- [x] functional-design — EXECUTE
- [x] nfr-requirements — EXECUTE
- [x] nfr-design — EXECUTE
- [x] infrastructure-design — EXECUTE
- [x] code-generation — EXECUTE
- [x] build-and-test — EXECUTE
- [x] ci-pipeline — EXECUTE

### OPERATION PHASE
- [ ] deployment-pipeline — EXECUTE
- [ ] environment-provisioning — EXECUTE
- [ ] deployment-execution — EXECUTE
- [ ] observability-setup — EXECUTE
- [ ] incident-response — EXECUTE
- [ ] performance-validation — EXECUTE
- [ ] feedback-optimization — EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ci-pipeline
- **Active Agent**: aidlc-pipeline-deploy-agent
- **Status**: Running
`,
    );
    expect(runHook(stdinFor(p)).out).toContain("[▓▓▓▓▓▓▓▓▓▓]");

    const body = require("node:fs")
      .readFileSync(statePath(p), "utf-8")
      .replace("**Lifecycle Phase**: CONSTRUCTION", "**Lifecycle Phase**: OPERATION");
    writeFileSync(statePath(p), body);
    expect(runHook(stdinFor(p)).out).toContain("[░░░░░░░░░░]");
  });

  // --- .sh Test 45: IDEATION -> INCEPTION phase-boundary reset ---
  test("45: ideation full bar then inception empty bar on phase pointer flip", () => {
    const p = proj();
    writeState(
      p,
      `# AI-DLC State Tracking
## Stage Progress
### IDEATION PHASE
- [x] intent-capture — EXECUTE
- [x] market-research — EXECUTE
- [x] feasibility — EXECUTE
- [x] scope-definition — EXECUTE
- [x] team-formation — EXECUTE
- [x] rough-mockups — EXECUTE
- [x] approval-handoff — EXECUTE

### INCEPTION PHASE
- [ ] reverse-engineering — EXECUTE
- [ ] practices-discovery — EXECUTE
- [ ] requirements-analysis — EXECUTE
- [ ] user-stories — EXECUTE
- [ ] refined-mockups — EXECUTE
- [ ] application-design — EXECUTE
- [ ] units-generation — EXECUTE
- [ ] delivery-planning — EXECUTE
## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: approval-handoff
- **Active Agent**: aidlc-product-agent
- **Status**: Running
`,
    );
    expect(runHook(stdinFor(p)).out).toContain("[▓▓▓▓▓▓▓▓▓▓]");

    const body = require("node:fs")
      .readFileSync(statePath(p), "utf-8")
      .replace("**Lifecycle Phase**: IDEATION", "**Lifecycle Phase**: INCEPTION");
    writeFileSync(statePath(p), body);
    expect(runHook(stdinFor(p)).out).toContain("[░░░░░░░░░░]");
  });

  // --- .sh Test 46: realistic full-state-file regression (#37, inception 6/8) ---
  test("46: full state file renders inception 6/8 with 7 filled chars", () => {
    const p = proj();
    writeState(
      p,
      `# AI-DLC State Tracking

## Project Information
- **Project**: Regression case for #37
- **Project Type**: Greenfield
- **Scope**: feature
- **Start Date**: 2026-05-02T10:00:00Z
- **Active Agent**: aidlc-architect-agent

## Scope Configuration
- **Stages to Execute**: 0.1, 0.2, 0.3, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
- **Stages to Skip**: none
- **Depth**: Standard

## Execution Plan Summary
- **Total Stages**: 32
- **Completed**: 16
- **In Progress**: units-generation

## Stage Progress

### INITIALIZATION PHASE
- [x] workspace-scaffold — EXECUTE
- [x] workspace-detection — EXECUTE
- [x] state-init — EXECUTE

### IDEATION PHASE
- [x] intent-capture — EXECUTE
- [x] market-research — EXECUTE
- [x] feasibility — EXECUTE
- [x] scope-definition — EXECUTE
- [x] team-formation — EXECUTE
- [x] rough-mockups — EXECUTE
- [x] approval-handoff — EXECUTE

### INCEPTION PHASE
- [x] reverse-engineering — EXECUTE
- [x] practices-discovery — EXECUTE
- [x] requirements-analysis — EXECUTE
- [x] user-stories — EXECUTE
- [x] refined-mockups — EXECUTE
- [x] application-design — EXECUTE
- [-] units-generation — EXECUTE
- [ ] delivery-planning — EXECUTE

### CONSTRUCTION PHASE
- [ ] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE
- [ ] ci-pipeline — EXECUTE

### OPERATION PHASE
- [ ] deployment-pipeline — EXECUTE
- [ ] environment-provisioning — EXECUTE
- [ ] deployment-execution — EXECUTE
- [ ] observability-setup — EXECUTE
- [ ] incident-response — EXECUTE
- [ ] performance-validation — EXECUTE
- [ ] feedback-optimization — EXECUTE

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: units-generation
- **Next Stage**: delivery-planning
- **Status**: Running
- **Last Updated**: 2026-05-02T11:30:00Z

## Session Resume Point
- **Last Completed Stage**: application-design
- **Next Action**: Execute units-generation
`,
    );
    const out = runHook(stdinFor(p)).out;
    expect(out).toContain("6/8");
    expect(out).toContain("[▓▓▓▓▓▓▓░░░]");
  });

  // --- .sh Test 47: Lifecycle Phase with trailing text still matches heading (two asserts) ---
  test("47: Lifecycle Phase 'INCEPTION (finalizing)' still resolves ratio + bar", () => {
    const p = proj();
    writeState(
      p,
      `# AI-DLC State Tracking
## Stage Progress
### INCEPTION PHASE
- [x] reverse-engineering — EXECUTE
- [-] requirements-analysis — EXECUTE
- [ ] user-stories — EXECUTE
## Current Status
- **Lifecycle Phase**: INCEPTION (finalizing)
- **Current Stage**: requirements-analysis
- **Status**: Running
`,
    );
    const out = runHook(stdinFor(p)).out;
    expect(out).toContain("1/3");
    expect(out).toContain("▓");
  });

  // --- .sh Test 48: prose decoy containing "Lifecycle Phase:" doesn't hijack (three asserts) ---
  test("48: prose decoy does not hijack the phase field", () => {
    const p = proj();
    writeState(
      p,
      `# AI-DLC State Tracking

## Notes
> Discussion: The Lifecycle Phase: OPERATION refactor landed in v2.

## Stage Progress
### INCEPTION PHASE
- [x] reverse-engineering — EXECUTE
- [-] requirements-analysis — EXECUTE
- [ ] user-stories — EXECUTE

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: requirements-analysis
- **Active Agent**: aidlc-architect-agent
- **Status**: Running
`,
    );
    const out = runHook(stdinFor(p)).out;
    expect(out).toContain("INCEPTION");
    expect(out).not.toContain("OPERATION");
    expect(out).toContain("1/3");
  });

  // --- .sh Test 49: COMPLETE status with unresolved phase renders full bar (two asserts) ---
  test("49: COMPLETE status with unresolved phase renders full bar + COMPLETE label", () => {
    const p = proj();
    writeState(
      p,
      `# AI-DLC State Tracking
## Stage Progress
### OPERATION PHASE
- [x] deployment-pipeline — EXECUTE
## Current Status
- **Lifecycle Phase**: COMPLETE
- **Current Stage**: none
- **Status**: Completed
`,
    );
    const out = runHook(stdinFor(p)).out;
    expect(out).toContain("[▓▓▓▓▓▓▓▓▓▓]");
    expect(out).toContain("COMPLETE");
  });

  // --- .sh Test 37: bar advances when a stage completes (#37 regression, two projects) ---
  test("37: inception 4/7 (5 filled) advances to 5/7 (7 filled)", () => {
    const pa = proj();
    writeState(
      pa,
      `# AI-DLC State Tracking
## Execution Plan Summary
- **Total Stages**: 31
- **Completed**: 13
## Stage Progress
### INCEPTION PHASE
- [x] reverse-engineering — EXECUTE
- [x] requirements-analysis — EXECUTE
- [x] user-stories — EXECUTE
- [x] refined-mockups — EXECUTE
- [-] application-design — EXECUTE
- [ ] units-generation — EXECUTE
- [ ] delivery-planning — EXECUTE
## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: application-design
- **Active Agent**: aidlc-architect-agent
- **Status**: Running
`,
    );
    const outA = runHook(stdinFor(pa)).out;

    const pb = proj();
    writeState(
      pb,
      `# AI-DLC State Tracking
## Execution Plan Summary
- **Total Stages**: 31
- **Completed**: 14
## Stage Progress
### INCEPTION PHASE
- [x] reverse-engineering — EXECUTE
- [x] requirements-analysis — EXECUTE
- [x] user-stories — EXECUTE
- [x] refined-mockups — EXECUTE
- [x] application-design — EXECUTE
- [-] units-generation — EXECUTE
- [ ] delivery-planning — EXECUTE
## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: units-generation
- **Active Agent**: aidlc-architect-agent
- **Status**: Running
`,
    );
    const outB = runHook(stdinFor(pb)).out;

    // .sh extracted the bar via grep -oE '\[▓*░*\]'; assert the exact bars.
    const barA = outA.match(/\[▓*░*\]/)?.[0];
    const barB = outB.match(/\[▓*░*\]/)?.[0];
    expect(barA).toBe("[▓▓▓▓▓░░░░░]"); // floor(4*10/7)=5 filled
    expect(barB).toBe("[▓▓▓▓▓▓▓░░░]"); // floor(5*10/7)=7 filled
  });

  // --- .sh Test 38: phase-boundary reset (full -> empty on pointer flip, two asserts) ---
  test("38: end-of-inception full bar then start-of-construction empty bar", () => {
    const p = proj();
    writeState(
      p,
      `# AI-DLC State Tracking
## Execution Plan Summary
- **Total Stages**: 14
- **Completed**: 7
## Stage Progress
### INCEPTION PHASE
- [x] reverse-engineering — EXECUTE
- [x] requirements-analysis — EXECUTE
- [x] user-stories — EXECUTE
- [x] refined-mockups — EXECUTE
- [x] application-design — EXECUTE
- [x] units-generation — EXECUTE
- [x] delivery-planning — EXECUTE

### CONSTRUCTION PHASE
- [ ] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE
- [ ] ci-pipeline — EXECUTE
## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: delivery-planning
- **Active Agent**: aidlc-architect-agent
- **Status**: Running
`,
    );
    expect(runHook(stdinFor(p)).out).toContain("[▓▓▓▓▓▓▓▓▓▓]");

    const body = require("node:fs")
      .readFileSync(statePath(p), "utf-8")
      .replace("**Lifecycle Phase**: INCEPTION", "**Lifecycle Phase**: CONSTRUCTION");
    writeFileSync(statePath(p), body);
    expect(runHook(stdinFor(p)).out).toContain("[░░░░░░░░░░]");
  });

  // --- .sh Test 40: COMPLETE status renders full bar from phase-local checkbox state ---
  test("40: completed fixture renders full bar", () => {
    const p = proj();
    seedStateFile(p, STATE_COMPLETED);
    expect(runHook(stdinFor(p)).out).toContain("[▓▓▓▓▓▓▓▓▓▓]");
  });
});
