// covers: hook:aidlc-statusline
//
// aidlc-statusline.ts is a HOOK, not a CLI tool — Claude Code registers it via
// the `statusLine` setting and pipes a JSON blob on stdin, expecting a single
// rendered status line on stdout. There is no subcommand surface and no
// process.exit contract to assert (the hook always exits 0 and writes via
// process.stdout.write). The hook reads project state off disk and renders the
// phase / progress-bar / breadcrumb / model+ctx suffix. It is mechanism=none
// (no LLM, no tokens). Every contract is exercised by SPAWNING the hook with
// controlled stdin and asserting on the stdout it writes. spawnCount = all;
// inProcess = 0.
//
// MECHANISM NOTE: the hook is never imported in this file. We
// spawn the same `bun <hook>` binary through node:child_process spawnSync,
// feeding the JSON as `input` (so stdin is a pipe, not a TTY — the hook's
// isTTY guard reads it). Output is read back from res.stdout. The env-var
// fall-through case passes empty stdin plus CLAUDE_PROJECT_DIR in the child env.
//
// FIXTURE DISCIPLINE: each case uses a FRESH temp project dir
// (createTestProject, toPortablePath-wrapped so the project path round-trips on
// native Windows when embedded in the stdin JSON). Seeded fixtures come from the
// shipped tests/fixtures/state-*.md via seedStateFile; inline cases write their
// bytes to the default intent's aidlc-state.md (writeState). All temp dirs are
// cleaned in afterAll. Nothing is written under tests/fixtures/**.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  createIntent,
  setActiveIntentCursor,
  writeSessionBinding,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const HOOK = join(REPO_ROOT, "dist", "claude", ".claude", "hooks", "aidlc-statusline.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

// Per-intent record. The statusline hook reads state from the active intent's
// record dir (its local stateFilePathForSelection); seeding aidlc-state.md there
// makes the active-intent cursor resolve.
const statePath = (p: string): string => join(seededRecordDir(p), "aidlc-state.md");

function writeState(p: string, body: string): void {
  mkdirSync(seededRecordDir(p), { recursive: true });
  writeFileSync(statePath(p), body);
}

interface RunResult {
  status: number;
  out: string; // stdout (the rendered status line)
}

/**
 * Spawn the statusline hook, piping `stdin` as stdin and merging `env` into the
 * child env. stderr is discarded. The hook is NOT given a TTY stdin (spawnSync
 * `input` is a pipe), so its isTTY guard reads the JSON.
 */
function runHook(stdin: string, env: Record<string, string> = {}): RunResult {
  const res = spawnSync(BUN, [HOOK], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: stdin,
    encoding: "utf-8",
    // Strip any inherited CLAUDE_PROJECT_DIR so it can't leak into stdin-driven
    // cases. Callers that need the env-var fall-through pass it explicitly.
    env: { ...process.env, CLAUDE_PROJECT_DIR: "", ...env },
  });
  return { status: res.status ?? -1, out: res.stdout ?? "" };
}

function stdinFor(p: string): string {
  return JSON.stringify({ workspace: { project_dir: p } });
}

// ESC literal - the hook emits "\x1b[..m".
const ESC = "\x1b";

const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");
const STATE_CONSTRUCTION = join(FIXTURES_DIR, "state-construction.md");
const STATE_OPERATION = join(FIXTURES_DIR, "state-operation.md");
const STATE_COMPLETED = join(FIXTURES_DIR, "state-completed.md");
const STATE_JUMPED = join(FIXTURES_DIR, "state-jumped.md");

describe("t11 aidlc-statusline hook (migrated from t11-hook-statusline.sh, plan 62)", () => {
  test("1: shows [AIDLC] ready when no state file", () => {
    const p = proj();
    // createTestProject makes the default intent record but no state file.
    const r = runHook(stdinFor(p));
    expect(r.out.trim()).toBe("[AIDLC] ready");
  });

  test("2: shows IDEATION phase", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    expect(runHook(stdinFor(p)).out).toContain("IDEATION");
  });

  test("3: shows stage display name Feasibility", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    expect(runHook(stdinFor(p)).out).toContain("Feasibility");
  });

  test("4: shows agent display name and strips slug", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const out = runHook(stdinFor(p)).out;
    expect(out).toContain("Architect");
    expect(out).not.toContain("aidlc-architect-agent");
  });

  // IDEATION has 7 non-SKIP stages, 2 are [x] (intent-capture, market-research).
  test("6: computes phase progress 2/7", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    expect(runHook(stdinFor(p)).out).toContain("2/7");
  });

  test("7: output starts with [AIDLC] prefix", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    expect(runHook(stdinFor(p)).out).toMatch(/^\[AIDLC\]/);
  });

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
    expect(runHook(stdinFor(p)).out).not.toMatch(/[0-9]\/[0-9]/);
  });

  test("10: empty stdin falls through to CLAUDE_PROJECT_DIR env var", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    expect(runHook("", { CLAUDE_PROJECT_DIR: p }).out).toContain("IDEATION");
  });

  test("11: shows CONSTRUCTION phase", () => {
    const p = proj();
    seedStateFile(p, STATE_CONSTRUCTION);
    expect(runHook(stdinFor(p)).out).toContain("CONSTRUCTION");
  });

  // Construction fixture: 9 non-SKIP checkbox lines under CONSTRUCTION PHASE
  // (cart: 2; checkout: 7); 2 are [x] -> 2/9.
  test("12: construction shows progress fraction (regex /9)", () => {
    const p = proj();
    seedStateFile(p, STATE_CONSTRUCTION);
    const out = runHook(stdinFor(p)).out;
    expect(out).toMatch(/[0-9]\/9/);
    expect(out).toContain("2/9");
  });

  test("13: shows OPERATION phase", () => {
    const p = proj();
    seedStateFile(p, STATE_OPERATION);
    expect(runHook(stdinFor(p)).out).toContain("OPERATION");
  });

  test("14: operation shows progress fraction (regex /7)", () => {
    const p = proj();
    seedStateFile(p, STATE_OPERATION);
    // operation fixture: 7 stages, 0 [x] ([-] deployment-pipeline) -> 0/7.
    const out = runHook(stdinFor(p)).out;
    expect(out).toMatch(/[0-9]\/7/);
    expect(out).toContain("0/7");
  });

  test("15: completed fixture shows COMPLETE", () => {
    const p = proj();
    seedStateFile(p, STATE_COMPLETED);
    expect(runHook(stdinFor(p)).out).toContain("COMPLETE");
  });

  test("16: statusline completes within 500ms", () => {
    const p = proj();
    seedStateFile(p, STATE_CONSTRUCTION);
    // The test name says 500ms; this test proves completion by output, not timing.
    const result = runHook(stdinFor(p));
    expect(result.status).toBe(0);
    expect(result.out).toContain("2/9");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("17: [S] stages excluded from construction total (0/3 + empty bar)", () => {
    const p = proj();
    seedStateFile(p, STATE_JUMPED);
    const out = runHook(stdinFor(p)).out;
    expect(out).toContain("0/3");
    expect(out).toContain("[░░░░░░░░░░]");
  });

  test("18: [S] stages excluded; ideation shows 2/2 + full bar", () => {
    const p = proj();
    seedStateFile(p, STATE_JUMPED);
    const body = require("node:fs")
      .readFileSync(statePath(p), "utf-8")
      .replace("**Lifecycle Phase**: CONSTRUCTION", "**Lifecycle Phase**: IDEATION");
    writeFileSync(statePath(p), body);
    const out = runHook(stdinFor(p)).out;
    expect(out).toContain("2/2");
    expect(out).toContain("[▓▓▓▓▓▓▓▓▓▓]");
  });

  test("19: progress bar contains filled and empty chars", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const out = runHook(stdinFor(p)).out;
    expect(out).toContain("▓");
    expect(out).toContain("░");
  });

  test("20: breadcrumb > separator present", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    expect(runHook(stdinFor(p)).out).toContain(" > ");
  });

  test("21: agent -- separator present", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    expect(runHook(stdinFor(p)).out).toContain(" -- ");
  });

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
    expect(out).toContain("INITIALIZATION");
    expect(out).toContain("Workspace Detection");
    expect(out).toContain("▓");
  });

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

  test("28: model and context appear after agent", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const stdin = JSON.stringify({
      workspace: { project_dir: p },
      model: { id: "us.anthropic.claude-opus-4-6-v1" },
      context_window: { used_percentage: 45.2 },
    });
    expect(runHook(stdin).out).toMatch(/Agent.*BR:.*ctx:/);
  });

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

  test("33: no model/context in JSON means no BR: or ctx: suffix", () => {
    const p = proj();
    seedStateFile(p, MID_IDEATION);
    const stdin = JSON.stringify({ workspace: { project_dir: p } });
    const out = runHook(stdin).out;
    expect(out).not.toContain("BR:");
    expect(out).not.toContain("ctx:");
  });

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

    const body = require("node:fs")
      .readFileSync(statePath(p), "utf-8")
      .replace("- [-] code-generation", "- [x] code-generation");
    writeFileSync(statePath(p), body);
    const outFull = runHook(stdinFor(p)).out;
    expect(outFull).toContain("1/1");
    expect(outFull).toContain("[▓▓▓▓▓▓▓▓▓▓]");
  });

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

  // Realistic full-state-file regression (#37, inception 6/8).
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

  // Bar advances when a stage completes (#37 regression, two projects).
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

    const barA = outA.match(/\[▓*░*\]/)?.[0];
    const barB = outB.match(/\[▓*░*\]/)?.[0];
    expect(barA).toBe("[▓▓▓▓▓░░░░░]"); // floor(4*10/7)=5 filled
    expect(barB).toBe("[▓▓▓▓▓▓▓░░░]"); // floor(5*10/7)=7 filled
  });

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

  test("50: a session bound to a record outside the slug shape keeps showing it after the cursor moves", () => {
    const p = proj();
    const bound = createIntent(p, "bound-work", "default", "feature");
    const other = createIntent(p, "other-work", "default", "feature");
    const intents = join(p, "aidlc", "spaces", "default", "intents");
    const named = "customer work";
    renameSync(join(intents, bound.dirName), join(intents, named));
    const registry = join(intents, "intents.json");
    writeFileSync(registry, readFileSync(registry, "utf-8").replaceAll(`"${bound.dirName}"`, JSON.stringify(named)));
    copyFileSync(STATE_CONSTRUCTION, join(intents, named, "aidlc-state.md"));
    copyFileSync(MID_IDEATION, join(intents, other.dirName, "aidlc-state.md"));
    writeSessionBinding(p, "S-STATUS", "default", named, "switch");
    setActiveIntentCursor(p, other.dirName, "default");
    const out = runHook(JSON.stringify({ workspace: { project_dir: p }, session_id: "S-STATUS" })).out;
    expect(out).toContain("CONSTRUCTION");
    expect(out).not.toContain("IDEATION");
  });

  test("51: a session bound to an archived record shows no workflow, not the cursor's", () => {
    const p = proj();
    const archived = createIntent(p, "archived-work", "default", "feature");
    const other = createIntent(p, "other-work", "default", "feature");
    const intents = join(p, "aidlc", "spaces", "default", "intents");
    const archivedState = readFileSync(STATE_CONSTRUCTION, "utf-8").replace(/^- \*\*Status\*\*:.*$/m, "- **Status**: Archived");
    expect(archivedState).toContain("- **Status**: Archived");
    writeFileSync(join(intents, archived.dirName, "aidlc-state.md"), archivedState);
    copyFileSync(MID_IDEATION, join(intents, other.dirName, "aidlc-state.md"));
    writeSessionBinding(p, "S-ARCHIVED", "default", archived.dirName, "switch");
    setActiveIntentCursor(p, other.dirName, "default");
    const out = runHook(JSON.stringify({ workspace: { project_dir: p }, session_id: "S-ARCHIVED" })).out;
    expect(out).not.toContain("IDEATION");
    expect(out).not.toContain("CONSTRUCTION");
  });

  test("40: completed fixture renders full bar", () => {
    const p = proj();
    seedStateFile(p, STATE_COMPLETED);
    expect(runHook(stdinFor(p)).out).toContain("[▓▓▓▓▓▓▓▓▓▓]");
  });
});
