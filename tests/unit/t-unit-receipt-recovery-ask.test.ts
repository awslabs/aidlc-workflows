// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-state:unit, function:evaluateGuardRefusal, function:guardRecoveryAskForRefusal, function:validateDirective, audit:UNIT_COMPLETED
//
// CLI-contract test: a Unit whose work is on disk but whose completion was
// never recorded is offered "record its completion" in a question the engine
// can send. mechanism = cli.
//
// What the person sees: Units owned by the team, a Unit's design written
// without its start and completion receipts. Before, every `next` stopped with
// "refusing to emit a malformed directive" and nothing else; recording the
// completion by hand was refused too, so the work could not go on. After, the
// agent asks which way on, recording the Unit's completion from the work on
// disk first, and once the person picks it the completion is recorded.
//
// Pinned here:
//   1. team-owned Units: `next` sends the question, recording the completion
//      first, and the person's pick records it;
//   2. every remedy that runs a command waits for the person's pick, so each
//      Unit-receipt question the engine builds passes the directive check
//      (the team gate's, and finishing a Unit's step with the review it has).
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/): aidlc-orchestrate.ts next,
// aidlc-state.ts unit complete, aidlc-lib.ts evaluateGuardRefusal, through the
// spawned engine; aidlc-directive.ts validateDirective.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
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
import {
  artifactFilename,
  consumeSharedDirectiveAsk,
  evaluateGuardRefusal,
  guardRecoveryAskForRefusal,
  unitCompletedReceipts,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { validateDirective } from "../../dist/claude/.claude/tools/aidlc-directive.ts";
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

// The state file's checkbox separator (an em dash), spelled as an escape here.
const SEP = "\u2014";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

function teamState(): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: unit receipt recovery test
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

// Each Unit's design written and reviewed READY, with no `unit start` or
// `unit complete` for it: the work is on disk, the receipts are not.
function seedTeamProject(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), teamState());
  seedBoltDag(proj, UNITS);
  for (const unit of UNITS) {
    const dir = join(seededRecordDir(proj), "construction", unit, SLUG);
    mkdirSync(dir, { recursive: true });
    for (const name of PRODUCES) writeFileSync(join(dir, artifactFilename(name)), `# ${name} for ${unit}\n`);
    const args = [
      LOG, "review", "--stage", SLUG, "--reviewer", REVIEWER, "--unit", unit,
      "--iteration", "1", "--project-dir", proj,
    ];
    const request = spawnSync(BUN, args, runOpts());
    expect(request.status, `${request.stdout}${request.stderr}`).toBe(0);
    appendFileSync(
      join(dir, artifactFilename("functional-spec")),
      `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`,
    );
    const verdict = spawnSync(BUN, [...args, "--verdict", "READY"], runOpts());
    expect(verdict.status, `${verdict.stdout}${verdict.stderr}`).toBe(0);
  }
  return proj;
}

function engineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_SOURCE_FRESHNESS: "1" };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  return env;
}

describe("a Unit done without its receipts is offered recording them", () => {
  test("1: team-owned Units: next asks, and the person's pick records the completion", () => {
    const proj = seedTeamProject();
    const r = runOrchestrateNext(ORCH, proj, [], { env: engineEnv() });
    expect(r.stderr).not.toContain("malformed directive");
    expect(r.status, r.stderr).toBe(0);
    expect(r.directive).toMatchObject({
      kind: "ask",
      ask_type: "guard-recovery",
      stage: SLUG,
      unit: "alpha",
      reason_codes: ["UNIT_COMPLETION_MISSING"],
    });
    const remedies = (r.directive?.remedies ?? []) as Record<string, unknown>[];
    expect(remedies[0]).toMatchObject({
      op: "record-unit-completion",
      interaction: "command",
      requiresHuman: true,
      operation: { kind: "record-unit-completion", stage: SLUG, unit: "alpha" },
    });

    // The person picks it, as the human-turn hook records their reply.
    expect(consumeSharedDirectiveAsk(proj, "1")).toBe(true);
    const env = engineEnv();
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    const done = spawnSync(
      BUN,
      [STATE, "unit", "complete", "--stage", SLUG, "--unit", "alpha", "--project-dir", proj],
      { ...runOpts(), env },
    );
    expect(done.status, `${done.stdout}${done.stderr}`).toBe(0);
    expect(unitCompletedReceipts(proj, SLUG).has("alpha")).toBe(true);
  });

  test("2: each Unit-receipt question the engine builds passes the directive check", () => {
    const teamGate = evaluateGuardRefusal({
      code: "UNIT_COMPLETION_MISSING",
      blockedAction: "present-approval-gate",
      stage: "code-generation",
      unit: "billing",
      stateContent: `# State\n- [-] code-generation ${SEP} EXECUTE\n`,
      invariant: "The Unit lifecycle is complete in the current attempt.",
      userMessage: "no current UNIT_COMPLETED receipt is recorded.",
      attempt: {
        recovery: "available",
        summaryCoverage: "current",
        reviewCoverage: "current",
        sourceCoverage: "current",
      },
      humanAuthority: { freshTurn: true, unattended: false },
    });
    // A solo walk, one Unit at a time, part way through a Unit's step with no
    // review pass left: finish the step with the review it has, or redo it.
    const midStep = evaluateGuardRefusal({
      code: "REVIEW_BUDGET_EXHAUSTED",
      blockedAction: "request-review",
      stage: "code-generation",
      unit: "extra",
      projectDir: "/tmp/t-unit-receipt-recovery-ask",
      stateContent: [
        "# AI-DLC State",
        "- **Scope**: feature",
        "- **Current Stage**: code-generation",
        "- **Construction Iteration**: unit-major",
        "- **Active Unit**: extra",
        "- **Unit Stage**: code-generation",
        "- **Unit State**: in-progress",
        `- [S] functional-design ${SEP} SKIP`,
        `- [S] nfr-requirements ${SEP} SKIP`,
        `- [S] nfr-design ${SEP} SKIP`,
        `- [S] infrastructure-design ${SEP} SKIP`,
        `- [-] code-generation ${SEP} EXECUTE`,
        "",
      ].join("\n"),
      invariant: "probe",
      userMessage: "probe",
      attempt: {
        recovery: "available",
        summaryCoverage: "current",
        reviewCoverage: "current",
        sourceCoverage: "current",
        reviewBudget: { used: 1, limit: 1 },
      },
      humanAuthority: { freshTurn: false, unattended: false },
    });
    for (const [label, refusal] of [["team gate", teamGate], ["mid-step", midStep]] as const) {
      expect(refusal.remedies[0]?.op, label).toBe("record-unit-completion");
      const ask = guardRecoveryAskForRefusal(refusal);
      expect(ask, label).not.toBeNull();
      const checked = validateDirective(ask);
      expect(checked.valid ? [] : checked.errors, label).toEqual([]);
      for (const remedy of refusal.remedies) {
        if (remedy.operation) expect(remedy.requiresHuman, `${label} ${remedy.op}`).toBe(true);
      }
    }
  });
});
