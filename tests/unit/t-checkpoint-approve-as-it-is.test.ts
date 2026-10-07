// covers: subcommand:aidlc-bolt:checkpoint, subcommand:aidlc-orchestrate:next, subcommand:aidlc-log:review
//
// The person drives. A Unit's review never finished (the chat was interrupted
// before its verdict, or it came back NOT-READY with a pass left) and the
// person says "approve it as it is". Under Guard Policy off, relaxed, and a
// strict set for this piece of work, the Unit goes on, as at a stage gate: its checkpoint is verified as usual and asked once, the
// approval is recorded with the review shown as not finished, and the person
// hears one line. The walk then carries on to the next Unit and the stage
// closes with no further question.
//
// What stays: the person's words must be on record (the agent alone cannot let
// a Unit skip its review), a review never asked for is still required, and
// under a strict the team locks the review finishes first, with no question
// to the person. Every refusal names the step that works, and `next` names the retry
// of an interrupted review, so the agent is never left without one.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, auditBlockField, findStageBySlug, latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents, reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

const CG = "code-generation";
const REVIEWER = findStageBySlug(CG)!.reviewer!;
const SESSION = "01995000-7a11-7000-8000-00000000a515";
const AS_IT_IS = "approve alpha as it is, I don't need that review";
const QUESTION = "Approve alpha? Its Code Generation review did not finish.";
const NOTICE = "Approved. The Code Generation review for alpha did not finish.";
const DASH = "\u2014"; // the state file's stage-line separator, an em dash
type Policy = "off" | "relaxed" | "strict";

// A solo unit-major walk with Unit checkpoints on, where Code Generation is the
// only Construction step: alpha's checkpoint is that step's.
function fixture(policy: Policy, review: "advisory" | "adversarial" = "advisory"): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  const skipped = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"];
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Approve a Unit as it is
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: classic
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: gated
- **Guard Policy**: ${policy} (set by you)
- **Review Override**: ${review}
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${skipped.map((stage) => `- [S] ${stage} ${DASH} SKIP`).join("\n")}
- [-] code-generation ${DASH} EXECUTE
- [ ] build-and-test ${DASH} EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`);
  seedBoltDag(p, ["alpha", "beta"]);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "classic" }, p);
  recordCommand(p);
  return p;
}

// A team that locks Guard Policy strict for everyone on the repo.
function lockStrict(p: string): void {
  const dir = join(p, "aidlc", "spaces", "default", "memory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "project.md");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "# Project\n";
  writeFileSync(path, existing.includes("## Guard Policy\n")
    ? existing.replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n")
    : `${existing.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`);
}

// The tools as the agent runs them: no test switch stands in for the person.
function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_UNATTENDED: "0" };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  return env;
}

function tool(p: string, name: string, args: string[]) {
  const result = spawnSync(process.execPath, [
    join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", p,
  ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: agentEnv() });
  const last = (result.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "";
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(last); } catch { json = null; }
  return { status: result.status, json, out: `${result.stdout}${result.stderr}` };
}

// What the person types, through the real prompt hook every harness uses.
function says(p: string, prompt: string, session = SESSION): void {
  const env: NodeJS.ProcessEnv = { ...agentEnv(), AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: p, env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

function recordCommand(p: string): void {
  const script = join(seededRecordDir(p), "check.cjs");
  writeFileSync(script, "const fs=require('node:fs'); for(const unit of ['alpha','beta']) if(!fs.readFileSync('src/'+unit+'.ts','utf8').includes(unit))process.exit(1);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", CG, "--checkpoint", "verification-command", "--command", command, "--session", "approve-as-it-is-command"];
  expect(tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"]).status).toBe(0);
  says(p, "Approve", "approve-as-it-is-command");
  for (const args of [["log", "answer", ...identity, "--details", "Approve"], ["state", "set-construction-verification-command", command]]) {
    const recorded = tool(p, args[0], args.slice(1));
    expect(recorded.status, recorded.out).toBe(0);
  }
}

// The Unit's Code Generation written and completed.
function build(p: string, unit: string): void {
  const stage = findStageBySlug(CG)!;
  const output = join(seededRecordDir(p), "construction", unit, CG);
  mkdirSync(output, { recursive: true });
  for (const name of stage.produces ?? []) writeFileSync(join(output, artifactFilename(name)), `# ${unit} ${name}\n`);
  writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
    stage: CG, unit, version: 1, writes: [{ path: `src/${unit}.ts` }],
  }));
  appendAuditEntry("UNIT_COMPLETED", {
    Stage: CG, Unit: unit, Mode: "wave",
    "Run floor": latestMainWorkflowStageRunFloorForProject(p, CG, true, unit),
    "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, unit, { requireRequiredArtifacts: true })!,
  }, p);
}

const reviewArgs = (unit: string, iteration: number) =>
  ["review", "--stage", CG, "--reviewer", REVIEWER, "--unit", unit, "--iteration", String(iteration)];

// The agent asks for the Unit's review; the reviewer's answer is optional.
function review(p: string, unit: string, iteration: number, verdict?: "READY" | "NOT-READY", extra: string[] = []): void {
  const requested = tool(p, "log", [...reviewArgs(unit, iteration), ...extra]);
  expect(requested.status, requested.out).toBe(0);
  if (verdict === undefined) return;
  const file = String(requested.json?.reviewFile);
  mkdirSync(dirname(join(p, file)), { recursive: true });
  writeFileSync(join(p, file), `**Verdict:** ${verdict}\n**Reviewer:** ${REVIEWER}\n**Iteration:** ${iteration}\n\n### Findings\n\n` +
    (verdict === "READY" ? "No blocking findings.\n" :
      "| ID | Severity | Location | Finding | Required action | Status |\n|---|---|---|---|---|---|\n" +
      `| R-01 | Major | src/${unit}.ts | It is not covered. | Cover it. | New |\n`));
  const recorded = tool(p, "log", [...reviewArgs(unit, iteration), "--verdict", verdict]);
  expect(recorded.status, recorded.out).toBe(0);
}

type Directive = {
  kind: string; stage?: string; unit?: string; reviewer?: string; protocol_modules?: string[];
  construction_checkpoint?: {
    unit: string; ready: boolean; verified: boolean; errors: string[];
    rereview?: { stage: string; reviewer: string; iteration: number; command: string; unfinished?: string };
    review_not_finished?: { stages: string[]; question: string };
  };
  construction_policy?: { completion_only?: boolean };
};

// The step `next` routes, seen as a route check (it records nothing).
function routed(p: string): Directive {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, [], {
    env: { ...agentEnv(), AIDLC_ROUTE_CHECK: "1" },
  });
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as Directive;
}

function next(p: string): Directive {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, [], { env: agentEnv() });
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as Directive;
}

function checkpoint(p: string, unit: string, action: string, extra: string[] = []) {
  return tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", "unit", "--action", action, "--session", SESSION, ...extra]);
}

const events = (p: string, name: string) => readAuditShardEvents(p).filter((row) => row.event === name);
const unitApprovals = (p: string, unit: string) => events(p, "GATE_APPROVED")
  .filter((row) => auditBlockField(row.block, "Checkpoint") === "construction-unit" && auditBlockField(row.block, "Unit") === unit);
const questionsAsked = (p: string, unit: string) => events(p, "DECISION_RECORDED")
  .filter((row) => auditBlockField(row.block, "Checkpoint") === "Construction Unit Approval" && auditBlockField(row.block, "Unit") === unit);

// The person's "approve it as it is", then the one checkpoint question and
// their answer to it: alpha is approved, recorded over the unfinished review.
function approveAsItIs(p: string): void {
  says(p, AS_IT_IS);
  const verified = checkpoint(p, "alpha", "verify", ["--over-unfinished-review"]);
  expect(verified.status, verified.out).toBe(0);
  expect(verified.json?.verified).toBe(true);
  expect(verified.json?.review_not_finished).toEqual({ stages: [CG], question: QUESTION });
  const shown = routed(p);
  expect(shown.construction_checkpoint).toMatchObject({ unit: "alpha", ready: true, verified: true });
  expect(shown.construction_checkpoint?.review_not_finished?.question).toBe(QUESTION);
  expect(shown.construction_checkpoint?.rereview).toBeUndefined();
  // The approval is the one question: no learnings question comes before it.
  expect(shown.protocol_modules).toEqual(["construction"]);
  const asked = checkpoint(p, "alpha", "ask");
  expect(asked.status, asked.out).toBe(0);
  says(p, "yes");
  const approved = checkpoint(p, "alpha", "approve", ["--user-input", "yes"]);
  expect(approved.status, approved.out).toBe(0);
  expect(approved.json?.approved).toBe(true);
  expect(approved.json?.change_notices).toEqual([NOTICE]);

  expect(questionsAsked(p, "alpha")).toHaveLength(1);
  const approvals = unitApprovals(p, "alpha");
  expect(approvals).toHaveLength(1);
  expect(auditBlockField(approvals[0].block, "Review")).toBe("not finished");
  expect(events(p, "GATE_REJECTED")).toHaveLength(0);
}

// After alpha: beta is built, reviewed and approved as usual, and one bare
// `next` closes Code Generation with no further question about alpha.
function walkCarriesOn(p: string): void {
  const following = routed(p);
  expect(following.construction_checkpoint?.unit, JSON.stringify(following).slice(0, 600)).not.toBe("alpha");
  expect(following).toMatchObject({ stage: CG, unit: "beta" });
  build(p, "beta");
  review(p, "beta", 1, "READY");
  const verified = checkpoint(p, "beta", "verify");
  expect(verified.json?.verified, verified.out).toBe(true);
  expect(checkpoint(p, "beta", "ask").status).toBe(0);
  says(p, "Approve");
  expect(checkpoint(p, "beta", "approve", ["--user-input", "Approve"]).json?.approved).toBe(true);
  const settled = next(p);
  expect(settled.kind, JSON.stringify(settled).slice(0, 800)).not.toBe("error");
  expect(readFileSync(seededStateFile(p), "utf-8")).toMatch(/^- \[x\] code-generation /m);
  expect(questionsAsked(p, "alpha")).toHaveLength(1);
  expect(events(p, "GATE_REJECTED")).toHaveLength(0);
}

describe("approving a Unit as it is over a review that did not finish", () => {
  test("next names the retry of an interrupted review, and the refusal names it and the person's way on", () => {
    const p = fixture("off");
    build(p, "alpha");
    review(p, "alpha", 1);
    const step = routed(p);
    expect(step.construction_checkpoint).toMatchObject({ unit: "alpha", ready: false });
    expect(step.construction_checkpoint?.rereview?.command).toContain([...reviewArgs("alpha", 1)].join(" "));
    expect(step.construction_checkpoint?.rereview?.command).toContain("--retry-pending");
    expect(step.construction_checkpoint?.rereview?.unfinished).toBe("no-verdict");
    expect(step.reviewer).toBe(REVIEWER);
    const refused = checkpoint(p, "alpha", "verify");
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("--retry-pending");
    expect(refused.out).toContain("--over-unfinished-review");

    // Following the named retry finishes the review, and the Unit verifies.
    review(p, "alpha", 1, "READY", ["--retry-pending"]);
    const ready = checkpoint(p, "alpha", "verify");
    expect(ready.json?.verified, ready.out).toBe(true);
    expect(ready.json?.review_not_finished).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  for (const policy of ["off", "relaxed"] as const) {
    test(`Guard Policy ${policy}: an interrupted review, approved as it is with one question, and the walk carries on`, () => {
      const p = fixture(policy);
      build(p, "alpha");
      review(p, "alpha", 1);
      approveAsItIs(p);
      walkCarriesOn(p);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("Guard Policy off, adversarial review NOT-READY with a pass left: approved as it is, and the walk carries on", () => {
    const p = fixture("off", "adversarial");
    build(p, "alpha");
    review(p, "alpha", 1, "NOT-READY");
    const step = routed(p);
    expect(step.construction_checkpoint).toMatchObject({ unit: "alpha", ready: false });
    expect(step.construction_checkpoint?.rereview?.command).toContain(reviewArgs("alpha", 2).join(" "));
    expect(step.construction_checkpoint?.rereview?.unfinished).toBe("not-ready");
    const refused = checkpoint(p, "alpha", "verify");
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain(reviewArgs("alpha", 2).join(" "));
    expect(refused.out).toContain("--over-unfinished-review");
    approveAsItIs(p);
    walkCarriesOn(p);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // A strict set for this piece of work is the person's own setting: their
  // "approve it as it is" goes over the review, as at a stage gate.
  test("strict in the state: an interrupted review, approved as it is with one question", () => {
    const p = fixture("strict");
    build(p, "alpha");
    review(p, "alpha", 1);
    approveAsItIs(p);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  for (const state of ["off", "strict"] as const) {
    test(`a team-locked strict (state ${state}) keeps the review required, and the refusal names the retry`, () => {
      const p = fixture(state);
      lockStrict(p);
      build(p, "alpha");
      review(p, "alpha", 1);
      says(p, AS_IT_IS);
      const refused = checkpoint(p, "alpha", "verify", ["--over-unfinished-review"]);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain(`Finish it first, without asking the person: request it again with \``);
      expect(refused.out).toContain([...reviewArgs("alpha", 1), "--retry-pending"].join(" "));
      expect(refused.out).not.toContain("verify with --over-unfinished-review");
      expect(routed(p).construction_checkpoint?.rereview?.command).toContain("--retry-pending");
      expect(unitApprovals(p, "alpha")).toHaveLength(0);
      expect(questionsAsked(p, "alpha")).toHaveLength(0);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("a review never asked for stays required", () => {
    const p = fixture("off");
    build(p, "alpha");
    says(p, AS_IT_IS);
    const refused = checkpoint(p, "alpha", "verify", ["--over-unfinished-review"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("terminal review evidence is required");
    expect(refused.json?.verified ?? false).toBe(false);
    expect(unitApprovals(p, "alpha")).toHaveLength(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // The review stays required, and the step that asks for it is named, so the
  // agent is never left with a refusal that names nothing.
  for (const policy of ["off", "strict"] as const) {
    test(`Guard Policy ${policy}: a review never asked for is named as its first request, and following it verifies the Unit`, () => {
      const p = fixture(policy);
      build(p, "alpha");
      const first = reviewArgs("alpha", 1).join(" ");
      const step = routed(p);
      expect(step.construction_checkpoint, JSON.stringify(step).slice(0, 800)).toMatchObject({ unit: "alpha", ready: false });
      expect(step.construction_checkpoint?.rereview?.command).toContain(first);
      expect(step.construction_checkpoint?.rereview?.command).not.toContain("--retry-pending");
      expect(step.reviewer).toBe(REVIEWER);
      says(p, AS_IT_IS);
      const refused = checkpoint(p, "alpha", "verify", ["--over-unfinished-review"]);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain(first);
      expect(refused.out).not.toContain("verify with --over-unfinished-review");
      expect(unitApprovals(p, "alpha")).toHaveLength(0);
      review(p, "alpha", 1, "READY");
      const ready = checkpoint(p, "alpha", "verify");
      expect(ready.json?.verified, ready.out).toBe(true);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  // The person asked for alpha's review again after its code changed, and that
  // review was interrupted: "approve it as it is" goes over it the same way, as
  // a stage gate's approval goes over a recovery review that never finished.
  function recoveryInterrupted(p: string): void {
    build(p, "alpha");
    review(p, "alpha", 1, "READY");
    const output = join(seededRecordDir(p), "construction", "alpha", CG);
    const doc = join(output, artifactFilename(findStageBySlug(CG)!.produces![0]));
    writeFileSync(doc, `${readFileSync(doc, "utf-8")}\n- Titles cannot be blank.\n`);
    says(p, "review alpha's code again before I approve");
    review(p, "alpha", 2);
    const request = events(p, "REVIEW_REQUESTED").at(-1);
    expect(auditBlockField(request?.block ?? "", "Recovery"), request?.block).toBe("stale-receipt");
  }

  test("Guard Policy off: a recovery review that was interrupted, approved as it is with one question, and the walk carries on", () => {
    const p = fixture("off");
    recoveryInterrupted(p);
    says(p, AS_IT_IS);
    const verified = checkpoint(p, "alpha", "verify", ["--over-unfinished-review"]);
    expect(verified.status, verified.out).toBe(0);
    expect(verified.json?.review_not_finished).toEqual({ stages: [CG], question: QUESTION });
    expect(checkpoint(p, "alpha", "ask").status).toBe(0);
    says(p, "yes");
    const approved = checkpoint(p, "alpha", "approve", ["--user-input", "yes"]);
    expect(approved.status, approved.out).toBe(0);
    expect(approved.json?.change_notices).toContain(NOTICE);
    const approvals = unitApprovals(p, "alpha");
    expect(approvals).toHaveLength(1);
    expect(auditBlockField(approvals[0].block, "Review")).toBe("not finished");
    walkCarriesOn(p);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Guard Policy strict in the state: a recovery review that was interrupted, approved as it is with one question", () => {
    const p = fixture("strict");
    recoveryInterrupted(p);
    says(p, AS_IT_IS);
    const verified = checkpoint(p, "alpha", "verify", ["--over-unfinished-review"]);
    expect(verified.status, verified.out).toBe(0);
    expect(verified.json?.review_not_finished).toEqual({ stages: [CG], question: QUESTION });
    expect(checkpoint(p, "alpha", "ask").status).toBe(0);
    says(p, "yes");
    const approved = checkpoint(p, "alpha", "approve", ["--user-input", "yes"]);
    expect(approved.status, approved.out).toBe(0);
    expect(approved.json?.change_notices).toContain(NOTICE);
    const approvals = unitApprovals(p, "alpha");
    expect(approvals).toHaveLength(1);
    expect(auditBlockField(approvals[0].block, "Review")).toBe("not finished");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a team-locked strict: a recovery review that was interrupted still finishes first, and the refusal names its retry", () => {
    const p = fixture("strict");
    lockStrict(p);
    recoveryInterrupted(p);
    says(p, AS_IT_IS);
    const refused = checkpoint(p, "alpha", "verify", ["--over-unfinished-review"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("Finish it first, without asking the person:");
    expect(refused.out).toContain(reviewArgs("alpha", 2).join(" "));
    expect(refused.out).not.toContain("verify with --over-unfinished-review");
    expect(unitApprovals(p, "alpha")).toHaveLength(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("the agent cannot let a Unit go on without its review on its own", () => {
    const p = fixture("off");
    build(p, "alpha");
    review(p, "alpha", 1);
    const refused = checkpoint(p, "alpha", "verify", ["--over-unfinished-review"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("--retry-pending");
    expect(unitApprovals(p, "alpha")).toHaveLength(0);
    expect(questionsAsked(p, "alpha")).toHaveLength(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
