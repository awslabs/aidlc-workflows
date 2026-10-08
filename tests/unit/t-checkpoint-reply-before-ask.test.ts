// covers: subcommand:aidlc-bolt:checkpoint, hook:aidlc-record-human-turn, function:gateWordsSinceUnitReview
//
// The person drives. While a Unit's review runs, they type their answer to the
// checkpoint question that has not been asked yet: "approve it as it is", or
// what to change. Once the review lands, the agent verifies and asks; that
// answer was refused ("no such question is open", then "none is on record
// yet"), and the person was asked the same question again. Now `ask` takes the
// words they typed in this chat since the Unit's review was asked for (and
// since any question asked or answered after it) as the question's reply, and
// returns them as `earlier_reply`: the agent reads them and records the choice
// they made, with no second question. Words that answer nothing leave the
// question to be shown, and the reply that follows counts with them, as
// before. Words from before the review, a reply to another question, a bare
// command, or another chat's words are not taken.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
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
const SESSION = "01995000-7a11-7000-8000-00000000b127";
const OTHER = "01995000-7a11-7000-8000-00000000c127";
const DASH = "\u2014"; // the state file's stage-line separator, an em dash
type Policy = "off" | "strict";

// A solo unit-major walk with Unit checkpoints on, where Code Generation is the
// only Construction step: alpha's checkpoint is that step's.
function fixture(policy: Policy): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  const skipped = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"];
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: A reply typed before the checkpoint question
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
- **Review Override**: advisory
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
  build(p);
  return p;
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
  writeFileSync(script, "process.exit(0);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", CG, "--checkpoint", "verification-command", "--command", command, "--session", "reply-before-ask-command"];
  expect(tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"]).status).toBe(0);
  says(p, "Approve", "reply-before-ask-command");
  for (const args of [["log", "answer", ...identity, "--details", "Approve"], ["state", "set-construction-verification-command", command]]) {
    const recorded = tool(p, args[0], args.slice(1));
    expect(recorded.status, recorded.out).toBe(0);
  }
}

// Alpha's Code Generation written and completed.
function build(p: string): void {
  const stage = findStageBySlug(CG)!;
  const output = join(seededRecordDir(p), "construction", "alpha", CG);
  mkdirSync(output, { recursive: true });
  for (const name of stage.produces ?? []) writeFileSync(join(output, artifactFilename(name)), `# alpha ${name}\n`);
  writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
    stage: CG, unit: "alpha", version: 1, writes: [{ path: "src/alpha.ts" }],
  }));
  appendAuditEntry("UNIT_COMPLETED", {
    Stage: CG, Unit: "alpha", Mode: "wave",
    "Run floor": latestMainWorkflowStageRunFloorForProject(p, CG, true, "alpha"),
    "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, "alpha", { requireRequiredArtifacts: true })!,
  }, p);
}

const REVIEW = ["review", "--stage", CG, "--reviewer", REVIEWER, "--unit", "alpha", "--iteration", "1"];

// The agent asks for alpha's review; the person may write while it runs.
function requestReview(p: string): string {
  const requested = tool(p, "log", REVIEW);
  expect(requested.status, requested.out).toBe(0);
  return String(requested.json?.reviewFile);
}

// The reviewer's READY lands.
function reviewLands(p: string, file: string): void {
  mkdirSync(dirname(join(p, file)), { recursive: true });
  writeFileSync(join(p, file), `**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`);
  const recorded = tool(p, "log", [...REVIEW, "--verdict", "READY"]);
  expect(recorded.status, recorded.out).toBe(0);
}

function checkpoint(p: string, action: string, extra: string[] = [], session = SESSION) {
  return tool(p, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", action, "--session", session, ...extra]);
}

// The review lands, the agent verifies alpha and asks about it in this chat.
function verifyAndAsk(p: string, file: string) {
  reviewLands(p, file);
  const verified = checkpoint(p, "verify");
  expect(verified.json?.verified, verified.out).toBe(true);
  const asked = checkpoint(p, "ask");
  expect(asked.status, asked.out).toBe(0);
  return asked.json ?? {};
}

const events = (p: string, name: string) => readAuditShardEvents(p).filter((row) => row.event === name);
const unitGates = (p: string, name: string) => events(p, name)
  .filter((row) => auditBlockField(row.block, "Checkpoint") === "construction-unit" && auditBlockField(row.block, "Unit") === "alpha");
const questionsAsked = (p: string) => events(p, "DECISION_RECORDED")
  .filter((row) => auditBlockField(row.block, "Checkpoint") === "Construction Unit Approval" && auditBlockField(row.block, "Unit") === "alpha");

describe("t-checkpoint-reply-before-ask: the person answers before the Unit's question is asked", () => {
  for (const policy of ["off", "strict"] as const) {
    test(`Guard Policy ${policy}: "approve it as it is" typed while the review runs approves alpha, asked once`, () => {
      const p = fixture(policy);
      const file = requestReview(p);
      says(p, "approve it as it is");
      const asked = verifyAndAsk(p, file);
      expect(asked.earlier_reply).toBe("approve it as it is");
      const approved = checkpoint(p, "approve", ["--user-input", "approve it as it is"]);
      expect(approved.status, approved.out).toBe(0);
      expect(approved.json?.approved).toBe(true);
      const gates = unitGates(p, "GATE_APPROVED");
      expect(gates).toHaveLength(1);
      expect(auditBlockField(gates[0].block, "Person Reply")).toBe("approve it as it is");
      // The one question on record is the one the agent asked; the person was not asked again.
      expect(questionsAsked(p)).toHaveLength(1);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test(`Guard Policy ${policy}: a change typed while the review runs requests it, with no question`, () => {
      const p = fixture(policy);
      const file = requestReview(p);
      says(p, "change the greeting to hello before I approve it");
      const asked = verifyAndAsk(p, file);
      expect(asked.earlier_reply).toBe("change the greeting to hello before I approve it");
      const rejected = checkpoint(p, "reject", ["--user-input", "Request Changes", "--reason", "Change the greeting to hello."]);
      expect(rejected.status, rejected.out).toBe(0);
      const gates = unitGates(p, "GATE_REJECTED");
      expect(gates).toHaveLength(1);
      expect(auditBlockField(gates[0].block, "Person Reply")).toBe("change the greeting to hello before I approve it");
      expect(unitGates(p, "GATE_APPROVED")).toHaveLength(0);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    // The agent reads that these answer nothing, shows the question, and the
    // reply that follows is the answer, kept with the earlier words.
    test(`Guard Policy ${policy}: words that answer nothing leave the question to be shown, and the next reply counts`, () => {
      const p = fixture(policy);
      const file = requestReview(p);
      says(p, "what is the reviewer checking?");
      const asked = verifyAndAsk(p, file);
      expect(asked.earlier_reply).toBe("what is the reviewer checking?");
      says(p, "approve");
      const approved = checkpoint(p, "approve", ["--user-input", "approve"]);
      expect(approved.status, approved.out).toBe(0);
      const reply = auditBlockField(unitGates(p, "GATE_APPROVED")[0].block, "Person Reply") ?? "";
      expect(reply).toContain("what is the reviewer checking?");
      expect(reply).toContain("approve");
      expect(questionsAsked(p)).toHaveLength(1);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  // "approve it as it is" over a review that has not finished: the verify
  // takes their words, and an approve run again records nothing more.
  test("an approve run again after \"approve it as it is\" writes no second approval", () => {
    const p = fixture("off");
    requestReview(p);
    says(p, "approve it as it is");
    const verified = checkpoint(p, "verify", ["--over-unfinished-review"]);
    expect(verified.json?.verified, verified.out).toBe(true);
    for (let run = 0; run < 2; run++) {
      const approved = checkpoint(p, "approve");
      expect(approved.status, approved.out).toBe(0);
      expect(approved.json?.approved).toBe(true);
    }
    expect(unitGates(p, "GATE_APPROVED")).toHaveLength(1);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("words typed before the review was asked for are not taken", () => {
    const p = fixture("off");
    says(p, "make the title bold");
    const file = requestReview(p);
    const asked = verifyAndAsk(p, file);
    expect(asked.earlier_reply).toBeUndefined();
    const refused = checkpoint(p, "approve", ["--user-input", "Approve"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("none is on record yet");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a reply to a question asked after the review was asked for is that question's", () => {
    const p = fixture("off");
    const file = requestReview(p);
    expect(tool(p, "log", ["decision", "--stage", CG, "--session", SESSION,
      "--decision", "Which name do you want for the module?", "--options", "core,main"]).status).toBe(0);
    says(p, "core");
    expect(tool(p, "log", ["answer", "--stage", CG, "--session", SESSION, "--details", "core"]).status).toBe(0);
    const asked = verifyAndAsk(p, file);
    expect(asked.earlier_reply).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a bare command, or words in another chat, are not taken", () => {
    const p = fixture("off");
    const file = requestReview(p);
    says(p, "/aidlc");
    says(p, "approve it as it is", OTHER);
    const asked = verifyAndAsk(p, file);
    expect(asked.earlier_reply).toBeUndefined();
    expect(checkpoint(p, "approve", ["--user-input", "Approve"]).status).not.toBe(0);
    expect(unitGates(p, "GATE_APPROVED")).toHaveLength(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
