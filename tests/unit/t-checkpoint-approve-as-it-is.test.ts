// covers: subcommand:aidlc-bolt:checkpoint, subcommand:aidlc-orchestrate:next, subcommand:aidlc-log:review
//
// The person drives. A Unit's review never finished (the chat was interrupted
// before its verdict, or it came back NOT-READY with a pass left) and the
// person says "approve it as it is". Under Guard Policy off, relaxed, and a
// strict set for this piece of work, the Unit goes on, as at a stage gate: its
// checkpoint is verified as usual with the agent naming the message they said
// it in (--message), their words are the approval (no second question),
// recorded with the review shown as not finished, and the person hears one
// line. The walk then carries on to the next Unit and the stage closes with no
// further question.
//
// What stays: the person's message must be named (the agent alone, or their
// turn with no message named, cannot let a Unit skip its review), a review
// never asked for is still required, and under a strict the team locks the
// review finishes first, with no question to the person. Every refusal names
// the step that works, and `next` names the retry of an interrupted review, so
// the agent is never left without one.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
import { aidlcToolInvocation } from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";

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
const NOTICE = "Approved. The Code Generation review for alpha did not finish.";
const DASH = "\u2014"; // the state file's stage-line separator, an em dash
type Policy = "off" | "relaxed" | "strict";

// A solo unit-major walk with Unit checkpoints on, where Code Generation is the
// only Construction step: alpha's checkpoint is that step's.
// "default": no Guard Policy line, so the scope's own default holds.
function fixture(policy: Policy | "default", review: "advisory" | "adversarial" = "advisory"): string {
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
${policy === "default" ? "" : `- **Guard Policy**: ${policy} (set by you)\n`}- **Review Override**: ${review}
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

function tool(p: string, name: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [
    join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", p,
  ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: { ...agentEnv(), ...env } });
  const last = (result.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "";
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(last); } catch { json = null; }
  return { status: result.status, json, out: `${result.stdout}${result.stderr}` };
}

// The refusal a tool printed, as its JSON line carries it.
function refusalOf(out: string): string | undefined {
  for (const line of out.trim().split(/\r?\n/).reverse()) {
    try {
      const parsed = JSON.parse(line) as { error?: unknown };
      if (typeof parsed.error === "string") return parsed.error;
    } catch {
      // Not a JSON line.
    }
  }
  return undefined;
}

// The person types `prompt`; the shipped human-turn hook keeps it. Returns the
// id of the message it kept, which the agent names with --message.
function says(p: string, prompt: string, session = SESSION): string {
  const env: NodeJS.ProcessEnv = { ...agentEnv(), AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: p, env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  const turn = events(p, "HUMAN_TURN").at(-1);
  const id = turn === undefined ? null : auditBlockField(turn.block, "Message Id");
  expect(id).not.toBeNull();
  return id as string;
}

// The person's check. With `floor` it is also their coverage floor: while the
// record holds a coverage-floor file, every test passes and the check exits 1.
function recordCommand(p: string, name = "check.cjs", session = "approve-as-it-is-command", floor = true): void {
  const script = join(seededRecordDir(p), name);
  writeFileSync(script, "const fs=require('node:fs'); " +
    (floor ? "if(fs.existsSync(require('node:path').join(__dirname,'coverage-floor'))){console.log('1 pass 0 fail');console.log('All files | 50.00');process.exit(1)} " : "") +
    "for(const unit of ['alpha','beta']) if(!fs.readFileSync('src/'+unit+'.ts','utf8').includes(unit))process.exit(1);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", CG, "--checkpoint", "verification-command", "--command", command, "--session", session];
  expect(tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"]).status).toBe(0);
  says(p, "Approve", session);
  for (const args of [["log", "answer", ...identity, "--details", "Approve"], ["state", "set-construction-verification-command", command]]) {
    const recorded = tool(p, args[0], args.slice(1));
    expect(recorded.status, recorded.out).toBe(0);
  }
}

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

// Its documents are not written for the stage's checks, which run before the
// review (completionChecksStep, t-checks-before-review), and they are not its subject.
const CHECKS_OFF = { AIDLC_DISABLE_SENSORS: "1" };

const reviewArgs = (unit: string, iteration: number) =>
  ["review", "--stage", CG, "--reviewer", REVIEWER, "--unit", unit, "--iteration", String(iteration)];

// The agent asks for the Unit's review; the reviewer's answer is optional.
function review(p: string, unit: string, iteration: number, verdict?: "READY" | "NOT-READY", extra: string[] = []): void {
  const requested = tool(p, "log", [...reviewArgs(unit, iteration), ...extra], CHECKS_OFF);
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
    review_not_finished?: { stages: string[]; question?: string; approved_in_words?: true };
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

// Run from the person's chat, so the message the agent names is proved against it.
function checkpoint(p: string, unit: string, action: string, extra: string[] = []) {
  return tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", "unit", "--action", action, "--session", SESSION, ...extra], {
    AIDLC_SESSION_OVERRIDE: SESSION,
  });
}

const events = (p: string, name: string) => readAuditShardEvents(p).filter((row) => row.event === name);
const unitApprovals = (p: string, unit: string) => events(p, "GATE_APPROVED")
  .filter((row) => auditBlockField(row.block, "Checkpoint") === "construction-unit" && auditBlockField(row.block, "Unit") === unit);
const questionsAsked = (p: string, unit: string) => events(p, "DECISION_RECORDED")
  .filter((row) => auditBlockField(row.block, "Checkpoint") === "Construction Unit Approval" && auditBlockField(row.block, "Unit") === unit);

// The person's "approve it as it is" is the approval: verify naming their
// message, then approve with no question asked. Alpha is approved over the
// unfinished review, with their words on the record.
function approvedInWords(p: string, message: string): void {
  const verified = checkpoint(p, "alpha", "verify", ["--over-unfinished-review", "--message", message]);
  expect(verified.status, verified.out).toBe(0);
  expect(verified.json?.verified).toBe(true);
  expect(verified.json?.review_not_finished).toEqual({ stages: [CG], approved_in_words: true });
  const shown = routed(p);
  expect(shown.construction_checkpoint).toMatchObject({ unit: "alpha", ready: true, verified: true });
  expect(shown.construction_checkpoint?.review_not_finished).toEqual({ stages: [CG], approved_in_words: true });
  expect(shown.construction_checkpoint?.rereview).toBeUndefined();
  // No learnings question comes before the approval either.
  expect(shown.protocol_modules).toEqual(["construction", "checkpoint", "sensors"]);
  const approved = checkpoint(p, "alpha", "approve");
  expect(approved.status, approved.out).toBe(0);
  expect(approved.json?.approved).toBe(true);
  expect(approved.json?.change_notices).toEqual([NOTICE]);

  expect(questionsAsked(p, "alpha")).toHaveLength(0);
  const approvals = unitApprovals(p, "alpha");
  expect(approvals).toHaveLength(1);
  expect(auditBlockField(approvals[0].block, "Review")).toBe("not finished");
  expect(auditBlockField(approvals[0].block, "Person Reply")).toBe(AS_IT_IS);
  expect(events(p, "GATE_REJECTED")).toHaveLength(0);
}

function approveAsItIs(p: string): void {
  approvedInWords(p, says(p, AS_IT_IS));
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
  expect(questionsAsked(p, "alpha")).toHaveLength(0);
  expect(events(p, "GATE_REJECTED")).toHaveLength(0);
}

describe("approving a Unit as it is over a review that did not finish", () => {
  test("the verify step names the command this install runs, not a file a native install lacks", () => {
    // Both refusals named `aidlc-bolt.ts checkpoint` outright. A native install
    // has no such file: its commands are `aidlc engine bolt ...`. Every other
    // step the engine names already renders through aidlcToolInvocation.
    const p = fixture("relaxed");
    build(p, "alpha");
    review(p, "alpha", 1, "READY");
    const bolt = `${aidlcToolInvocation("bolt")} checkpoint`;
    const asked = checkpoint(p, "alpha", "ask");
    expect(asked.status, asked.out).not.toBe(0);
    expect(asked.out).toContain(`Run ${bolt} --unit`);
    const approved = checkpoint(p, "alpha", "approve", ["--user-input", "Approve"]);
    expect(approved.status, approved.out).not.toBe(0);
    expect(approved.out).toContain(`Run ${bolt} --unit`);
    for (const out of [asked.out, approved.out]) expect(out).not.toMatch(/Run aidlc-bolt\.ts checkpoint/);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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

    review(p, "alpha", 1, "READY", ["--retry-pending"]);
    const ready = checkpoint(p, "alpha", "verify");
    expect(ready.json?.verified, ready.out).toBe(true);
    expect(ready.json?.review_not_finished).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  for (const policy of ["off", "relaxed"] as const) {
    test(`Guard Policy ${policy}: an interrupted review, approved as it is with no second question, and the walk carries on`, () => {
      const p = fixture(policy);
      build(p, "alpha");
      review(p, "alpha", 1);
      approveAsItIs(p);
      walkCarriesOn(p);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  // Their approval is the message the verification took it from, whatever they said after it.
  test("a later message does not become the words of an approval given as it is", () => {
    const p = fixture("off");
    build(p, "alpha");
    review(p, "alpha", 1);
    const asItIs = says(p, AS_IT_IS);
    const verified = checkpoint(p, "alpha", "verify", ["--over-unfinished-review", "--message", asItIs]);
    expect(verified.json?.verified, verified.out).toBe(true);
    says(p, "thanks, and carry on with beta after");
    const approved = checkpoint(p, "alpha", "approve");
    expect(approved.status, approved.out).toBe(0);
    const approval = unitApprovals(p, "alpha").at(-1)!;
    expect(auditBlockField(approval.block, "Person Reply")).toBe(AS_IT_IS);
    expect(auditBlockField(approval.block, "Message Id")).toBe(asItIs);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
  test("strict in the state: an interrupted review, approved as it is with no second question", () => {
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
      const asItIs = says(p, AS_IT_IS);
      const refused = checkpoint(p, "alpha", "verify", ["--over-unfinished-review", "--message", asItIs]);
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
    const asItIs = says(p, AS_IT_IS);
    const refused = checkpoint(p, "alpha", "verify", ["--over-unfinished-review", "--message", asItIs]);
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
      const asItIs = says(p, AS_IT_IS);
      const refused = checkpoint(p, "alpha", "verify", ["--over-unfinished-review", "--message", asItIs]);
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain(first);
      expect(refused.out).not.toContain("verify with --over-unfinished-review");
      expect(unitApprovals(p, "alpha")).toHaveLength(0);
      review(p, "alpha", 1, "READY");
      const ready = checkpoint(p, "alpha", "verify");
      expect(ready.json?.verified, ready.out).toBe(true);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  // A jump back or a reopen starts the Unit's work again. Rebuilt with no
  // review asked for in this run, its review from before is not this run's:
  // the step is this run's first request, which the review log accepts.
  for (const policy of ["off", "strict"] as const) {
    test(`Guard Policy ${policy}: after a reopen, a Unit rebuilt with no review is named its first request, and following it verifies the Unit`, () => {
      const p = fixture(policy);
      build(p, "alpha");
      review(p, "alpha", 1, "READY");
      expect(checkpoint(p, "alpha", "verify").json?.verified).toBe(true);
      const reopened = tool(p, "jump", ["reopen", "--target", CG, "--units", "alpha"]);
      expect(reopened.status, reopened.out).toBe(0);
      build(p, "alpha");
      const first = reviewArgs("alpha", 1).join(" ");
      const step = routed(p);
      expect(step.construction_checkpoint, JSON.stringify(step).slice(0, 800)).toMatchObject({ unit: "alpha", ready: false });
      expect(step.construction_checkpoint?.rereview?.command).toContain(first);
      expect(step.construction_checkpoint?.rereview?.command).not.toContain("--retry-pending");
      expect(step.reviewer).toBe(REVIEWER);
      const refused = checkpoint(p, "alpha", "verify");
      expect(refused.status).not.toBe(0);
      expect(refused.out).toContain(first);
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

  test("Guard Policy off: a recovery review that was interrupted, approved as it is with no second question, and the walk carries on", () => {
    const p = fixture("off");
    recoveryInterrupted(p);
    approveAsItIs(p);
    walkCarriesOn(p);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Guard Policy strict in the state: a recovery review that was interrupted, approved as it is with no second question", () => {
    const p = fixture("strict");
    recoveryInterrupted(p);
    approveAsItIs(p);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a team-locked strict: a recovery review that was interrupted still finishes first, and the refusal names its retry", () => {
    const p = fixture("strict");
    lockStrict(p);
    recoveryInterrupted(p);
    const asItIs = says(p, AS_IT_IS);
    const refused = checkpoint(p, "alpha", "verify", ["--over-unfinished-review", "--message", asItIs]);
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
    // Their turn on record is not enough: the step names the message to name.
    says(p, AS_IT_IS);
    const unnamed = checkpoint(p, "alpha", "verify", ["--over-unfinished-review"]);
    expect(unnamed.status).not.toBe(0);
    expect(unnamed.out).toContain("verify with --over-unfinished-review --message <id>");
    expect(unitApprovals(p, "alpha")).toHaveLength(0);
    expect(questionsAsked(p, "alpha")).toHaveLength(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

// The person drives, over a check too. The Unit's check ran on its files as they
// are and did not pass (every test green, a coverage floor not met), and the
// person says "approve it as it is". Under Guard Policy off, relaxed, a strict
// set for this piece of work, and the scope's own default, their words approve
// the Unit in one step: the verification records the check as not passed with
// the message they said it in, its result hands the agent the approve step, and
// they hear one line. Verified stays false: it is the fact.
//
// What stays: without their message the check still does not approve the Unit,
// and the refusal names each way on; a strict the team locks keeps the check
// required and says so in one line, with the file; each flag lifts only what
// it names; a later check that passes replaces the lift.
describe("approving a Unit as it is over a check that did not pass", () => {
  const AS_IT_IS_CHECK = "the coverage gap is only how alpha is measured, approve alpha as it is";
  const floor = (p: string) => join(seededRecordDir(p), "coverage-floor");
  const notPassed = (command: string) => `Approved. alpha's check, \`${command}\`, did not pass.`;
  const joined = (command: string) =>
    `Approved. The Code Generation review for alpha did not finish, and alpha's check, \`${command}\`, did not pass.`;
  const refusal = (command: string) =>
    `alpha's check, \`${command}\`, did not pass, so alpha is not approved yet: fix what it found and run the check ` +
    "again; or, if the person chose another check, set it and run that; or, if the person said to approve alpha as " +
    "it is, verify with --over-failed-check --message <id>.";
  const locked = (path: string, command: string) =>
    `Your team set Guard Policy to strict in ${path}, so alpha's check, \`${command}\`, has to pass before alpha is ` +
    "approved. Say if you want me to fix what it found and run it again, or choose another check. Changing that " +
    "line there changes it.";
  const verifications = (p: string) => events(p, "CHECKPOINT_VERIFICATION_RECORDED")
    .filter((row) => auditBlockField(row.block, "Unit") === "alpha");

  // Alpha built and reviewed READY; its check runs every test green and exits 1 on the floor alone.
  function failedCheck(policy: Policy | "default"): { p: string; command: string } {
    const p = fixture(policy);
    writeFileSync(floor(p), "90\n");
    build(p, "alpha");
    review(p, "alpha", 1, "READY");
    const verified = checkpoint(p, "alpha", "verify");
    expect(verified.status, verified.out).toBe(1);
    expect(verified.json?.verified).toBe(false);
    expect(verified.json?.check_not_passed).toBeUndefined();
    return { p, command: String(verified.json?.verification_command) };
  }

  for (const policy of ["off", "relaxed", "strict", "default"] as const) {
    test(`Guard Policy ${policy}: their words approve the Unit over the check in one step, and the walk goes on to the next Unit`, () => {
      const { p, command } = failedCheck(policy);
      const message = says(p, AS_IT_IS_CHECK);
      // The agent reads their words as an approval: the refusal names the way that takes them.
      const refused = checkpoint(p, "alpha", "approve", ["--user-input", AS_IT_IS_CHECK]);
      expect(refused.status).not.toBe(0);
      expect(refusalOf(refused.out)).toBe(refusal(command));
      const lifted = checkpoint(p, "alpha", "verify", ["--over-failed-check", "--message", message]);
      expect(lifted.status, lifted.out).toBe(0);
      expect(lifted.json).toMatchObject({ verified: false, approved: false, check_not_passed: { approved_in_words: true } });
      // The verify's own result hands the approve step: nothing is asked again.
      const step = String(lifted.json?.next_step);
      expect(step).toBe("The check did not pass, and the person's words are the approval of alpha as it is, so run " +
        `\`${aidlcToolInvocation("bolt")} checkpoint --unit "alpha" --kind unit --action approve\` at once without asking ` +
        "anything, and say the one line it returns, as written.");
      const approved = checkpoint(p, "alpha", "approve");
      expect(approved.status, approved.out).toBe(0);
      expect(approved.json).toMatchObject({ approved: true, verified: false, check_not_passed: { approved_in_words: true } });
      expect(approved.json?.next_step).toBeUndefined();
      expect(approved.json?.change_notices).toEqual([notPassed(command)]);

      const verification = verifications(p).at(-1)!;
      expect(auditBlockField(verification.block, "Exit Code")).toBe("1");
      expect(auditBlockField(verification.block, "Verified")).toBe("false");
      expect(auditBlockField(verification.block, "Check Not Passed")).toBe("approved in words");
      expect(auditBlockField(verification.block, "Message Id")).toBe(message);
      expect(auditBlockField(verification.block, "Review Not Finished")).toBeNull();
      const approval = unitApprovals(p, "alpha");
      expect(approval).toHaveLength(1);
      expect(auditBlockField(approval[0].block, "Check")).toBe("not passed");
      expect(auditBlockField(approval[0].block, "Person Reply")).toBe(AS_IT_IS_CHECK);
      expect(auditBlockField(approval[0].block, "Message Id")).toBe(message);
      expect(auditBlockField(approval[0].block, "User Input")).toBe("Approve");
      expect(auditBlockField(approval[0].block, "Review")).toBeNull();
      expect(questionsAsked(p, "alpha")).toHaveLength(0);
      unlinkSync(floor(p));
      // As for a review: under strict this fixture has no record of where the stage started, so its close is not walked.
      if (policy === "off" || policy === "relaxed") walkCarriesOn(p);
      else expect(routed(p)).toMatchObject({ stage: CG, unit: "beta" });
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("a review that did not finish and a check that did not pass: each flag lifts only its own, both approve with one line", () => {
    const p = fixture("off");
    writeFileSync(floor(p), "90\n");
    build(p, "alpha");
    review(p, "alpha", 1);
    const message = says(p, AS_IT_IS_CHECK);
    const checkOnly = checkpoint(p, "alpha", "verify", ["--over-failed-check", "--message", message]);
    expect(checkOnly.status).not.toBe(0);
    expect(checkOnly.out).toContain("verify with --over-unfinished-review --message <id>");
    const reviewOnly = checkpoint(p, "alpha", "verify", ["--over-unfinished-review", "--message", message]);
    expect(reviewOnly.status, reviewOnly.out).toBe(1);
    expect(reviewOnly.json?.verified).toBe(false);
    expect(reviewOnly.json?.check_not_passed).toBeUndefined();
    const command = String(reviewOnly.json?.verification_command);
    expect(refusalOf(checkpoint(p, "alpha", "approve").out)).toBe(refusal(command));
    const both = checkpoint(p, "alpha", "verify", ["--over-unfinished-review", "--over-failed-check", "--message", message]);
    expect(both.status, both.out).toBe(0);
    expect(both.json).toMatchObject({
      check_not_passed: { approved_in_words: true }, review_not_finished: { stages: [CG], approved_in_words: true },
    });
    const approved = checkpoint(p, "alpha", "approve");
    expect(approved.json?.approved, approved.out).toBe(true);
    expect(approved.json?.change_notices).toEqual([joined(command)]);
    const approval = unitApprovals(p, "alpha").at(-1)!;
    expect(auditBlockField(approval.block, "Review")).toBe("not finished");
    expect(auditBlockField(approval.block, "Check")).toBe("not passed");
    expect(questionsAsked(p, "alpha")).toHaveLength(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  for (const state of ["off", "strict"] as const) {
    test(`a team-locked strict (state ${state}) keeps the check required, in one line naming the file`, () => {
      const { p, command } = failedCheck(state);
      lockStrict(p);
      const path = join(p, "aidlc", "spaces", "default", "memory", "project.md");
      // No word of the person is there yet: the agent hears its own ways on, and nothing is put to them.
      for (const action of ["ask", "approve"]) expect(refusalOf(checkpoint(p, "alpha", action).out)).toBe(refusal(command));
      // Their words arrive: the one line for them says why, where, and the ways on.
      const message = says(p, AS_IT_IS_CHECK);
      const verify = checkpoint(p, "alpha", "verify", ["--over-failed-check", "--message", message]);
      expect(verify.status).not.toBe(0);
      expect(refusalOf(verify.out)).toBe(locked(path, command));
      expect(verifications(p).some((row) => auditBlockField(row.block, "Check Not Passed") !== null)).toBe(false);
      expect(unitApprovals(p, "alpha")).toHaveLength(0);
      expect(questionsAsked(p, "alpha")).toHaveLength(0);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("with no words of the person the check stays required, and each way the refusal names works", () => {
    const { p, command } = failedCheck("off");
    for (const action of ["ask", "approve"]) expect(refusalOf(checkpoint(p, "alpha", action).out)).toBe(refusal(command));
    // Fix what it found and run the check again.
    unlinkSync(floor(p));
    const fixed = checkpoint(p, "alpha", "verify");
    expect(fixed.json?.verified, fixed.out).toBe(true);
    expect(fixed.json?.check_not_passed).toBeUndefined();
    expect(fixed.json?.next_step).toBeUndefined();
    expect(checkpoint(p, "alpha", "ask").status).toBe(0);
    says(p, "Approve");
    expect(checkpoint(p, "alpha", "approve", ["--user-input", "Approve"]).json?.approved).toBe(true);
    expect(auditBlockField(unitApprovals(p, "alpha").at(-1)!.block, "Check")).toBeNull();

    // The person chose another check: set it, and run that.
    const other = failedCheck("off");
    recordCommand(other.p, "other-check.cjs", "approve-as-it-is-other-command", false);
    const passed = checkpoint(other.p, "alpha", "verify");
    expect(passed.json?.verified, passed.out).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("after the lift, a later check that passes replaces it, and the record keeps both", () => {
    const { p } = failedCheck("off");
    const message = says(p, AS_IT_IS_CHECK);
    expect(checkpoint(p, "alpha", "verify", ["--over-failed-check", "--message", message]).status).toBe(0);
    unlinkSync(floor(p));
    const passed = checkpoint(p, "alpha", "verify");
    expect(passed.json?.verified, passed.out).toBe(true);
    expect(passed.json?.check_not_passed).toBeUndefined();
    const rows = verifications(p);
    expect(rows.map((row) => [auditBlockField(row.block, "Verified"), auditBlockField(row.block, "Check Not Passed")]))
      .toEqual([["false", null], ["false", "approved in words"], ["true", null]]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("after the lift, next and a plain verify keep it and hand the same approve step: no loop", () => {
    const { p, command } = failedCheck("off");
    const message = says(p, AS_IT_IS_CHECK);
    const lifted = checkpoint(p, "alpha", "verify", ["--over-failed-check", "--message", message]);
    expect(lifted.status, lifted.out).toBe(0);
    expect(routed(p).construction_checkpoint).toMatchObject({ unit: "alpha", ready: true, verified: false });
    const again = checkpoint(p, "alpha", "verify");
    expect(again.status, again.out).toBe(0);
    expect(again.json?.check_not_passed).toEqual({ approved_in_words: true });
    expect(again.json?.next_step).toBe(lifted.json?.next_step);
    expect(refusalOf(checkpoint(p, "alpha", "ask").out)).toBe(String(lifted.json?.next_step));
    const approved = checkpoint(p, "alpha", "approve");
    expect(approved.json?.change_notices, approved.out).toEqual([notPassed(command)]);
    expect(auditBlockField(unitApprovals(p, "alpha").at(-1)!.block, "Message Id")).toBe(message);
    expect(questionsAsked(p, "alpha")).toHaveLength(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("approved over its check, the Unit stays approved when the person picks another check after", () => {
    const { p } = failedCheck("off");
    const message = says(p, AS_IT_IS_CHECK);
    expect(checkpoint(p, "alpha", "verify", ["--over-failed-check", "--message", message]).status).toBe(0);
    expect(checkpoint(p, "alpha", "approve").json?.approved).toBe(true);
    recordCommand(p, "other-check.cjs", "approve-as-it-is-other-command");
    const status = checkpoint(p, "alpha", "status");
    expect(status.json, status.out).toMatchObject({ approved: true, verified: false, check_not_passed: { approved_in_words: true } });
    expect(routed(p).construction_checkpoint?.unit).not.toBe("alpha");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("their words over one check never carry to another check the person picks", () => {
    const { p } = failedCheck("off");
    const message = says(p, AS_IT_IS_CHECK);
    expect(checkpoint(p, "alpha", "verify", ["--over-failed-check", "--message", message]).status).toBe(0);
    recordCommand(p, "other-check.cjs", "approve-as-it-is-other-command");
    const other = checkpoint(p, "alpha", "verify");
    expect(other.status, other.out).toBe(1);
    expect(other.json?.check_not_passed).toBeUndefined();
    expect(auditBlockField(verifications(p).at(-1)!.block, "Check Not Passed")).toBeNull();
    expect(refusalOf(checkpoint(p, "alpha", "approve").out)).toBe(refusal(String(other.json?.verification_command)));
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // A change to the Unit's files after the lift is read by the Guard Policy's
  // one rule for a change after the review, as for a passing check: under
  // relaxed and off it is accepted with its one line and the lift stands;
  // under strict the change is re-checked first, and the lift is gone after it.
  for (const policy of ["off", "relaxed"] as const) {
    test(`Guard Policy ${policy}: a change to the Unit's files after their words is accepted with its one line, and the lift stands`, () => {
      const { p, command } = failedCheck(policy);
      const message = says(p, AS_IT_IS_CHECK);
      expect(checkpoint(p, "alpha", "verify", ["--over-failed-check", "--message", message]).status).toBe(0);
      writeFileSync(join(p, "src", "alpha.ts"), "export const alpha = 2;\n");
      expect(checkpoint(p, "alpha", "status").json).toMatchObject({ ready: true, check_not_passed: { approved_in_words: true } });
      const plain = checkpoint(p, "alpha", "verify");
      expect(plain.status, plain.out).toBe(0);
      expect(plain.json?.change_notices).toEqual(["src/alpha.ts changed after the alpha Unit was reviewed; carrying on."]);
      expect(auditBlockField(verifications(p).at(-1)!.block, "Check Not Passed")).toBe("approved in words");
      const approved = checkpoint(p, "alpha", "approve");
      expect(approved.json?.approved, approved.out).toBe(true);
      expect(approved.json?.change_notices).toEqual([notPassed(command)]);
      expect(unitApprovals(p, "alpha")).toHaveLength(1);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("Guard Policy strict: a change to the Unit's files after their words is re-checked first, and the lift is gone after it", () => {
    const { p, command } = failedCheck("strict");
    const message = says(p, AS_IT_IS_CHECK);
    expect(checkpoint(p, "alpha", "verify", ["--over-failed-check", "--message", message]).status).toBe(0);
    const rows = verifications(p).length;
    writeFileSync(join(p, "src", "alpha.ts"), "export const alpha = 2;\n");
    const status = checkpoint(p, "alpha", "status");
    expect(status.json).toMatchObject({ ready: false, verified: false, approved: false });
    expect(status.json?.check_not_passed).toBeUndefined();
    expect(status.json?.next_step).toBeUndefined();
    const recheck = reviewArgs("alpha", 2).join(" ");
    expect(String((status.json?.rereview as { command?: string } | null)?.command)).toContain(recheck);
    for (const action of ["verify", "approve"]) {
      const refused = checkpoint(p, "alpha", action);
      expect(refused.status).not.toBe(0);
      expect(refusalOf(refused.out)).toContain(`What ${CG} reviewed changed since its review: request the re-check with`);
    }
    expect(verifications(p)).toHaveLength(rows);
    expect(unitApprovals(p, "alpha")).toHaveLength(0);
    review(p, "alpha", 2, "READY");
    expect(checkpoint(p, "alpha", "status").json?.check_not_passed).toBeUndefined();
    const plain = checkpoint(p, "alpha", "verify");
    expect(plain.status, plain.out).toBe(1);
    expect(plain.json?.check_not_passed).toBeUndefined();
    expect(auditBlockField(verifications(p).at(-1)!.block, "Check Not Passed")).toBeNull();
    expect(refusalOf(checkpoint(p, "alpha", "approve").out)).toBe(refusal(command));
    expect(unitApprovals(p, "alpha")).toHaveLength(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("the agent cannot lift the check on its own: no message named, or one that is not the person's", () => {
    const { p } = failedCheck("off");
    const unnamed = checkpoint(p, "alpha", "verify", ["--over-failed-check"]);
    expect(unnamed.status).toBe(1);
    expect(unnamed.json?.check_not_passed).toBeUndefined();
    const invented = checkpoint(p, "alpha", "verify", ["--over-failed-check", "--message", "01995000-7a11-7000-8000-0000000000ff"]);
    expect(invented.status).not.toBe(0);
    expect(invented.json?.check_not_passed).toBeUndefined();
    expect(verifications(p).some((row) => auditBlockField(row.block, "Check Not Passed") !== null)).toBe(false);
    expect(unitApprovals(p, "alpha")).toHaveLength(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // The engine proves the message is the person's (kept by the human-turn hook,
  // sent on this work, carrying their own words, not spent by a decision since)
  // and never reads what it says: which message is "approve it as it is" is the
  // agent's reading, as for a review. The record keeps their words beside it.
  test("a message of theirs that says something else proves it is theirs, never what it says, and the record shows its words", () => {
    const { p, command } = failedCheck("off");
    const other = says(p, "thanks, and carry on with beta after");
    const lifted = checkpoint(p, "alpha", "verify", ["--over-failed-check", "--message", other]);
    expect(lifted.status, lifted.out).toBe(0);
    const approved = checkpoint(p, "alpha", "approve");
    expect(approved.json?.change_notices, approved.out).toEqual([notPassed(command)]);
    const approval = unitApprovals(p, "alpha").at(-1)!;
    expect(auditBlockField(approval.block, "Person Reply")).toBe("thanks, and carry on with beta after");
    expect(auditBlockField(approval.block, "Message Id")).toBe(other);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("on a clone with no proof file, a Unit approved over its check stays approved, and still not verified", () => {
    const { p } = failedCheck("off");
    const message = says(p, AS_IT_IS_CHECK);
    expect(checkpoint(p, "alpha", "verify", ["--over-failed-check", "--message", message]).status).toBe(0);
    expect(checkpoint(p, "alpha", "approve").json?.approved).toBe(true);
    const proof = String(checkpoint(p, "alpha", "status").json?.proof_path);
    unlinkSync(proof);
    const status = checkpoint(p, "alpha", "status");
    expect(status.json, status.out).toMatchObject({ approved: true, verified: false, check_not_passed: { approved_in_words: true } });
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
