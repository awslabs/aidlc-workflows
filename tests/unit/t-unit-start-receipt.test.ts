// covers: subcommand:aidlc-log:review, subcommand:aidlc-state:unit, subcommand:aidlc-orchestrate:next, function:evaluateGuardRefusal, function:guardRecoveryAskForRefusal, function:unitLifecycleRecorded, function:guardRecoveryAskOpenFor, audit:UNIT_STARTED
//
// CLI-contract test: a per-Unit stage's receipts hang off the Unit's start.
// mechanism = cli.
//
// What the person sees: a Unit's design written and sent for review without
// the Unit ever being started for the stage. Before, the review was recorded
// and the gate later refused the Unit with "no completion recorded"; after
// Request Changes there, the only way on was a stage restart, which a
// Unit-scoped checkout refuses. After, the review request names the missing
// start at once; and if the receipt is still missing while the stage is being
// revised, recording it is offered, as it is before Request Changes.
//
// Pinned here:
//   1. a review request for a Unit never started is refused and names the
//      start; after the start it is recorded;
//   2. while the engine's recovery ask about that Unit is open, the request
//      goes through (the ask's own remedies must stay runnable).
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/): aidlc-log.ts review,
// aidlc-state.ts unit start, aidlc-orchestrate.ts next, aidlc-lib.ts
// evaluateGuardRefusal / unitLifecycleRecorded / guardRecoveryAskOpenFor.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { artifactFilename } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { guardRecoveryAskOpenFor, unitLifecycleRecorded } from "../../dist/claude/.claude/tools/aidlc-log.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const SLUG = "functional-design";
const UNITS = ["alpha", "beta"];
const PRODUCES = ["entities", "rules", "functional-spec", "frontend-components", "traceability"];
const REVIEWER = "aidlc-architecture-reviewer-agent";
const SEP = "—";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

function teamState(): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: unit start receipt test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major
- **Construction Checkpoints**: disabled
- **Unit Ownership**: team

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design ${SEP} EXECUTE
- [ ] nfr-requirements ${SEP} EXECUTE
- [ ] nfr-design ${SEP} EXECUTE
- [ ] infrastructure-design ${SEP} EXECUTE
- [ ] code-generation ${SEP} EXECUTE
- [ ] build-and-test ${SEP} EXECUTE

### INCEPTION PHASE
- [-] domain-design ${SEP} EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${SLUG}
- **Status**: Running
`;
}

const runOpts = () => ({
  timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  encoding: "utf-8" as const,
});

function engineEnv(): NodeJS.ProcessEnv {
  // The stage's summary confirmation is not under test here, so its check is off.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_SKIP_SOURCE_FRESHNESS: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  return env;
}

function seedTeamProject(options: { artifacts: boolean }): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), teamState());
  seedBoltDag(proj, UNITS);
  if (options.artifacts) {
    for (const unit of UNITS) {
      const dir = join(seededRecordDir(proj), "construction", unit, SLUG);
      mkdirSync(dir, { recursive: true });
      for (const name of PRODUCES) writeFileSync(join(dir, artifactFilename(name)), `# ${name} for ${unit}\n`);
    }
  }
  return proj;
}

function requestReview(proj: string, unit: string) {
  const request = () => spawnSync(
    BUN,
    [LOG, "review", "--stage", SLUG, "--reviewer", REVIEWER, "--unit", unit, "--iteration", "1", "--project-dir", proj],
    { ...runOpts(), env: engineEnv() },
  );
  // The stage's checks run before its first review request and say what they
  // found; the same request again records it.
  const first = request();
  return first.status === 0 && first.stdout.includes("this stage's checks ran") ? request() : first;
}

describe("a per-Unit stage's receipts hang off the Unit's start", () => {
  test("1: a review request for a Unit never started is refused and names the start; after the start it is recorded", () => {
    const proj = seedTeamProject({ artifacts: false });
    expect(unitLifecycleRecorded(proj, SLUG, "alpha")).toBe(false);

    const refused = requestReview(proj, "alpha");
    expect(refused.status, `${refused.stdout}${refused.stderr}`).not.toBe(0);
    const text = `${refused.stdout}${refused.stderr}`;
    expect(text).toContain("the Unit has not been started for this stage");
    expect(text).toContain(`unit start --stage ${SLUG} --unit alpha`);

    // The engine routes the Unit's step, so its start is recorded.
    const routed = runOrchestrateNext(ORCH, proj, [], { env: engineEnv() });
    expect(routed.status, routed.stderr).toBe(0);
    expect(routed.directive).toMatchObject({ kind: "run-stage", stage: SLUG, unit: "alpha" });
    const started = spawnSync(
      BUN,
      [STATE, "unit", "start", "--stage", SLUG, "--unit", "alpha", "--project-dir", proj],
      { ...runOpts(), env: engineEnv() },
    );
    expect(started.status, `${started.stdout}${started.stderr}`).toBe(0);
    expect(unitLifecycleRecorded(proj, SLUG, "alpha")).toBe(true);
    expect(unitLifecycleRecorded(proj, SLUG, "beta")).toBe(false);

    const dir = join(seededRecordDir(proj), "construction", "alpha", SLUG);
    mkdirSync(dir, { recursive: true });
    for (const name of PRODUCES) writeFileSync(join(dir, artifactFilename(name)), `# ${name} for alpha\n`);
    const recorded = requestReview(proj, "alpha");
    expect(recorded.status, `${recorded.stdout}${recorded.stderr}`).toBe(0);
    expect(recorded.stdout).toContain("REVIEW_REQUESTED");
  });

  test("2: while the recovery ask about the Unit is open, the request goes through", () => {
    const proj = seedTeamProject({ artifacts: true });
    const asked = runOrchestrateNext(ORCH, proj, [], { env: engineEnv() });
    expect(asked.status, asked.stderr).toBe(0);
    expect(asked.directive).toMatchObject({
      kind: "ask",
      ask_type: "guard-recovery",
      stage: SLUG,
      unit: "alpha",
      reason_codes: ["UNIT_COMPLETION_MISSING"],
    });
    const state = readFileSync(seededStateFile(proj), "utf-8");
    expect(guardRecoveryAskOpenFor(proj, state, SLUG, "alpha")).toBe(true);
    expect(guardRecoveryAskOpenFor(proj, state, SLUG, "beta")).toBe(false);

    const recorded = requestReview(proj, "alpha");
    expect(recorded.status, `${recorded.stdout}${recorded.stderr}`).toBe(0);
    expect(recorded.stdout).toContain("REVIEW_REQUESTED");
    // The other Unit has no open ask: its request still names the start.
    const refused = requestReview(proj, "beta");
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain("has not been started for this stage");
  });
});
