// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-jump:reopen, subcommand:aidlc-bolt:checkpoint, function:routeCodeGenerationPlanApproval, function:unitGateStatus
//
// A Unit's Code Generation plan was approved, built, reviewed READY and its
// checkpoint verified. The person then reopens that step with
// `/aidlc --stage code-generation --unit alpha` (optionally after a Request
// Changes at the Unit checkpoint). The reopen is a fresh attempt: the plan
// comes back for the person's approval. Nothing in the plan needs changing,
// so `next` must ask the Plan Approval question, not hand the agent a
// `revise` whose only "feedback" is the reopen notice; with an unchanged plan
// that `revise` never clears. A Redo of that step is a fresh attempt too, and
// its plan is asked about the same way.
//
// Everything below drives the real tools: `next` (plan-approval ask and the
// `--stage` reopen print), the human-turn hook, `aidlc-jump.ts reopen` exactly
// as `next` names it, `aidlc-log.ts review` and `aidlc-bolt.ts checkpoint`.
// Only the Unit's build output and its UNIT_COMPLETED receipt are seeded, as
// the neighbouring checkpoint tests do.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, auditBlockField, findStageBySlug, latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents, reviewArtifactFingerprint, unitGateStatus,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

// The stage's checks run before each review and gate (completionChecksStep,
// t-checks-before-review); this file's fixture documents are not written for
// them and its subject is not them, so they stay off here.
process.env.AIDLC_DISABLE_SENSORS = "1";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

const CG = "code-generation";
const UNIT = "alpha";
const REVIEWER = findStageBySlug(CG)!.reviewer!;
const SESSION = "01995000-7a11-7000-8000-00000000b402";
const DASH = "\u2014"; // the state file's stage-line separator, an em dash

type Directive = {
  kind: string;
  stage?: string;
  unit?: string;
  ask_type?: string;
  message?: string;
  plan_approval?: { status?: string; feedback?: string };
  construction_checkpoint?: { unit: string; ready: boolean; verified: boolean };
};

// A solo unit-major walk with Unit checkpoints on, where Code Generation is the
// only Construction step, under the Guard Policy the report was seen with.
function fixture(): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  const skipped = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"];
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Reopen a built Unit
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
- **Guard Policy**: strict (set by you)
- **Plan Approval**: on (set by you)
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
  seedBoltDag(p, [UNIT, "beta"]);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of [UNIT, "beta"]) writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "classic" }, p);
  recordCommand(p);
  return p;
}

// The Unit verification command, approved by the person as the neighbouring
// checkpoint tests record it.
function recordCommand(p: string): void {
  const script = join(seededRecordDir(p), "check.cjs");
  writeFileSync(script, "const fs=require('node:fs'); if(!fs.readFileSync('src/alpha.ts','utf8').includes('alpha'))process.exit(1);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const session = "stage-reopen-command";
  const identity = ["--stage", CG, "--checkpoint", "verification-command", "--command", command, "--session", session];
  expect(tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"]).status).toBe(0);
  says(p, "Approve", session);
  for (const args of [["log", "answer", ...identity, "--details", "Approve"], ["state", "set-construction-verification-command", command]]) {
    const recorded = tool(p, args[0], args.slice(1));
    expect(recorded.status, recorded.out).toBe(0);
  }
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

function says(p: string, prompt: string, session = SESSION): void {
  const env: NodeJS.ProcessEnv = { ...agentEnv(), AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: p, env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

// The person answers "1" at the plan question; the agent records the choice it read.
function approves(p: string): void {
  says(p, "1");
  const recorded = tool(p, "log", ["answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan"]);
  expect(recorded.status, recorded.out).toBe(0);
}

function next(p: string, args: string[] = []): Directive {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, args, { env: agentEnv() });
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as Directive;
}

const stageDir = (p: string): string => join(seededRecordDir(p), "construction", UNIT, CG);

// The plan and test instructions, the same bytes every time it is written.
function writePlan(p: string, extra = ""): void {
  mkdirSync(stageDir(p), { recursive: true });
  writeFileSync(
    join(stageDir(p), "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: alpha\n- Touches: src/alpha.ts\n" +
      `- Tests: 1 unit test\n\n## Steps\n\n- [ ] Step 1: write alpha\n${extra}\n` +
      renderTestingContract(resolveTestingPosture(p)),
    "utf-8",
  );
  writeFileSync(join(stageDir(p), "unit-test-instructions.md"),
    "# Unit Test Instructions\n\nRun `bun test src/alpha.test.ts`.\n", "utf-8");
}

// The engine's own Plan Approval question, answered by the person.
function approvePlan(p: string): void {
  const ask = next(p);
  expect(ask.kind, JSON.stringify(ask).slice(0, 800)).toBe("ask");
  expect(ask.ask_type).toBe("plan-approval");
  approves(p);
  expect(next(p).plan_approval, "plan approved").toEqual({ status: "approved" });
}

function build(p: string): void {
  const stage = findStageBySlug(CG)!;
  const output = stageDir(p);
  mkdirSync(output, { recursive: true });
  // The plan and its test instructions stay as approved; the build writes the rest.
  for (const name of stage.produces ?? []) {
    const file = artifactFilename(name);
    if (file === "code-generation-plan.md" || file === "unit-test-instructions.md") continue;
    writeFileSync(join(output, file), `# ${UNIT} ${name}\n`);
  }
  writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
    stage: CG, unit: UNIT, version: 1, writes: [{ path: `src/${UNIT}.ts` }],
  }));
  appendAuditEntry("UNIT_COMPLETED", {
    Stage: CG, Unit: UNIT, Mode: "wave",
    "Run floor": latestMainWorkflowStageRunFloorForProject(p, CG, true, UNIT),
    "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, UNIT, { requireRequiredArtifacts: true })!,
  }, p);
}

function reviewReady(p: string, iteration: number): void {
  const args = ["review", "--stage", CG, "--reviewer", REVIEWER, "--unit", UNIT, "--iteration", String(iteration)];
  const requested = tool(p, "log", args);
  expect(requested.status, requested.out).toBe(0);
  const file = String(requested.json?.reviewFile);
  mkdirSync(dirname(join(p, file)), { recursive: true });
  writeFileSync(join(p, file), `**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** ${iteration}\n\n` +
    "### Findings\n\nNo blocking findings.\n");
  const recorded = tool(p, "log", [...args, "--verdict", "READY"]);
  expect(recorded.status, recorded.out).toBe(0);
}

function checkpoint(p: string, action: string, extra: string[] = []) {
  return tool(p, "bolt", ["checkpoint", "--unit", UNIT, "--kind", "unit", "--action", action, "--session", SESSION, ...extra]);
}

// The person turns Plan Approval off after approving the plan: the field the
// switch writes.
function planApprovalOff(p: string): void {
  writeFileSync(seededStateFile(p), readFileSync(seededStateFile(p), "utf-8")
    .replace("- **Plan Approval**: on (set by you)", "- **Plan Approval**: off (set by you)"));
}

// The person asks to redo the step: the agent reports their Redo and runs the
// reopen it prints, exactly as printed.
function redo(p: string): void {
  says(p, "redo code generation for alpha");
  const reported = tool(p, "orchestrate", ["report", "--result", "resumed", "--choice", "redo"]);
  expect(reported.status, reported.out).toBe(0);
  const message = String(reported.json?.message ?? reported.out);
  const command = /reopen --target \S+ --stages \S+ --units \S+ --via redo --scope \S+/.exec(message)?.[0];
  expect(command, message).toBeDefined();
  const reopened = tool(p, "jump", command!.split(" "));
  expect(reopened.status, reopened.out).toBe(0);
  const row = readAuditShardEvents(p).filter((event) => event.event === "GATE_REJECTED").at(-1);
  expect(auditBlockField(row?.block ?? "", "Reopen")).toBe("redo");
}

// `/aidlc --stage code-generation --unit alpha`: `next` prints the reopen it
// wants run; run exactly that command's arguments. After a checkpoint Request
// Changes the Unit's step is already open again, so `next` routes it instead
// of printing a reopen; that routed step is returned.
function reopenFromStage(p: string): Directive | null {
  const printed = next(p, ["--stage", CG, "--unit", UNIT]);
  if (printed.kind !== "print") return printed;
  const command = /reopen --target \S+ --stages \S+ --units \S+ --scope \S+/.exec(printed.message ?? "")?.[0];
  expect(command, printed.message).toBeDefined();
  const reopened = tool(p, "jump", command!.split(" "));
  expect(reopened.status, reopened.out).toBe(0);
  return null;
}

const eventTrail = (p: string): string[] => readAuditShardEvents(p).map((row) => {
  const unit = auditBlockField(row.block, "Unit");
  const reopen = auditBlockField(row.block, "Reopen");
  return `${row.event}${unit ? ` unit=${unit}` : ""}${reopen ? ` Reopen=${reopen}` : ""}`;
});

function builtAndVerified(p: string): void {
  writePlan(p);
  approvePlan(p);
  build(p);
  reviewReady(p, 1);
  const verified = checkpoint(p, "verify");
  expect(verified.json?.verified, verified.out).toBe(true);
}

// The person approves the plan the engine asks about; the Unit is built,
// reviewed and approved at its checkpoint, which closes its gate.
function approveAndFinish(p: string): void {
  approves(p);
  expect(next(p).plan_approval).toEqual({ status: "approved" });
  build(p);
  reviewReady(p, 1);
  expect(checkpoint(p, "verify").json?.verified).toBe(true);
  expect(checkpoint(p, "ask").status).toBe(0);
  says(p, "Approve");
  const approved = checkpoint(p, "approve", ["--user-input", "Approve"]);
  expect(approved.status, approved.out).toBe(0);
  expect(unitGateStatus(p, CG, UNIT, "unit-end")).toBe("approved");
}

const summary = (d: Directive): string =>
  JSON.stringify({ kind: d.kind, stage: d.stage, unit: d.unit, ask_type: d.ask_type, plan_approval: d.plan_approval });

describe("a --stage reopen of a Unit's approved Code Generation", () => {
  // The bug: nothing in the plan needs changing, so the reopened attempt's
  // plan comes back as a Plan Approval question.
  test("next asks the Plan Approval question, not a revise with the reopen notice", () => {
    const p = fixture();
    builtAndVerified(p);
    expect(reopenFromStage(p), "the --stage handler prints a reopen").toBeNull();
    const reopenRow = readAuditShardEvents(p).filter((row) => row.event === "GATE_REJECTED").at(-1);
    expect(auditBlockField(reopenRow?.block ?? "", "Reopen")).toBe("jump");
    expect(auditBlockField(reopenRow?.block ?? "", "Gate Scope")).toBe("unit-end");
    // The plan on disk is still the approved one, byte for byte.
    const after = next(p);
    console.log(`[t402] reopen: audit trail\n  ${eventTrail(p).join("\n  ")}`);
    console.log(`[t402] reopen: directive ${summary(after)}`);
    expect(after.plan_approval?.status, JSON.stringify(after.plan_approval)).not.toBe("revise");
    expect(after.kind, JSON.stringify(after).slice(0, 800)).toBe("ask");
    expect(after.ask_type).toBe("plan-approval");
    approveAndFinish(p);
  });

  // The loop itself: an agent that does as `revise` says, with nothing to
  // change, writes the same plan again, and `next` says `revise` again.
  test("an unchanged plan stays available for approval across repeated next calls", () => {
    const p = fixture();
    builtAndVerified(p);
    expect(reopenFromStage(p)).toBeNull();
    const seen: (string | undefined)[] = [];
    for (let round = 0; round < 3; round++) {
      writePlan(p);
      seen.push(next(p).plan_approval?.status);
    }
    console.log(`[t402] loop: plan_approval.status per round ${JSON.stringify(seen)}`);
    expect(seen, "an unchanged plan after a reopen is asked about, never sent back for revision").not.toContain("revise");
  });

  // Control: the person's own Request Changes at the Unit checkpoint. The
  // `--stage` that follows writes no reopen (the step is already open), the
  // plan is sent back with their words, and once it carries their change the
  // question comes back and the Unit finishes. This passes today.
  test("control: after a checkpoint Request Changes, their change in the plan brings the question back", () => {
    const p = fixture();
    builtAndVerified(p);
    expect(checkpoint(p, "ask").status).toBe(0);
    says(p, "Request Changes");
    const rejected = checkpoint(p, "reject", ["--user-input", "Request Changes", "--reason", "Add a null check to alpha."]);
    expect(rejected.status, rejected.out).toBe(0);
    const routed = reopenFromStage(p);
    expect(routed, "after a checkpoint reject the --stage routes the open step").not.toBeNull();
    console.log(`[t402] control: --stage routed ${summary(routed!)}`);
    expect(readAuditShardEvents(p).some((row) => auditBlockField(row.block, "Reopen") !== null)).toBe(false);
    expect(routed!.plan_approval).toEqual({ status: "revise", feedback: "Add a null check to alpha." });
    writePlan(p, "- [ ] Step 2: add a null check to alpha\n");
    const asked = next(p);
    console.log(`[t402] control: audit trail\n  ${eventTrail(p).join("\n  ")}`);
    expect(asked.kind, JSON.stringify(asked).slice(0, 800)).toBe("ask");
    expect(asked.ask_type).toBe("plan-approval");
    approveAndFinish(p);
  });
});

describe("a Redo of a Unit's built Code Generation", () => {
  // The person asked to do the step again, not for a change: the plan comes
  // back for approval as it stands, as after a jump back, never as a `revise`
  // whose only "feedback" is the redo notice.
  test("next asks the Plan Approval question, and their approval builds it again", () => {
    const p = fixture();
    builtAndVerified(p);
    redo(p);
    const after = next(p);
    console.log(`[t402] redo: directive ${summary(after)}`);
    expect(after.plan_approval?.status, JSON.stringify(after.plan_approval)).not.toBe("revise");
    expect(after.kind, JSON.stringify(after).slice(0, 800)).toBe("ask");
    expect(after.ask_type).toBe("plan-approval");
    approveAndFinish(p);
  });

  test("an unchanged plan written again is never sent back for revision", () => {
    const p = fixture();
    builtAndVerified(p);
    redo(p);
    const seen: (string | undefined)[] = [];
    for (let round = 0; round < 3; round++) {
      writePlan(p);
      seen.push(next(p).plan_approval?.status);
    }
    console.log(`[t402] redo loop: plan_approval.status per round ${JSON.stringify(seen)}`);
    expect(seen, "an unchanged plan after a Redo is asked about, never sent back for revision").not.toContain("revise");
  });

  test("with Plan Approval off the approved plan builds again, with no question", () => {
    const p = fixture();
    builtAndVerified(p);
    planApprovalOff(p);
    redo(p);
    const after = next(p);
    console.log(`[t402] redo, plan approval off: directive ${summary(after)}`);
    expect(after.kind, JSON.stringify(after).slice(0, 800)).toBe("run-stage");
    expect(after.plan_approval?.status, JSON.stringify(after.plan_approval)).toBe("approved");
  });
});
