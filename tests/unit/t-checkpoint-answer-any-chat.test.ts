// covers: function:protectedQuestionsElsewhere, function:moveProtectedQuestion, function:recordProtectedHumanResponse
// covers: hook:aidlc-record-human-turn, subcommand:aidlc-bolt:checkpoint, subcommand:aidlc-log:answer
//
// A Unit's checkpoint question "Approve this completed alpha?" is open in one
// chat and the person answers it in a new one. Their answer used to be
// refused in both chats ("no such question is open for this session", "none
// is on record yet"), so the agent asked again and the second answer landed.
// Now the person may answer it in any chat: their own turn in the new chat
// takes the checkpoint question the old chat asked, and one reply approves.
// Only the newest question asked, still open, is taken: never the agent's
// words, never a stale answer to an older question. Once the approval was
// asked, a new chat's checkpoint step skips the learnings question the old
// chat already asked, and the step for prose names the Unit to approve and
// the choices a typed number picks ("/aidlc 2"), the one choice of a batch
// asked with Request Changes alone too. The verification command question, and a
// Construction policy question a record carries, are answered in any chat
// the same way, and the step for prose names the flags their answer is
// recorded with and the setters an Approve runs: a yes to building the Units
// in parallel while they are built one at a time names the stage-by-stage
// setter first, each with the person's message, and the two apply. A bare
// `/aidlc` in a new chat shows again, as it was asked, the question the stage
// has open: one asked in chat, the verification command with the command it
// asks about, a Construction policy question, and the summary confirmation
// from its questions file, with one command for each of its choices, so a
// Request changes that says nothing about what is recorded before they are
// asked what should change; what they ask to change names the revised
// summary's question record, so their pick at it is recorded the first time.
// A Unit checkpoint's approval and a question the questions file still holds
// come back through their own step.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededAuditShard, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { quoteCommandArgument } from "../../dist/claude/.claude/tools/aidlc-runtime-paths.ts";
import { recordProtectedHumanResponse } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  artifactFilename, auditBlockField, findStageBySlug, getField, latestMainWorkflowStageRunFloorForProject,
  mintProtectedQuestion, protectedTargetDigest, readAuditShardEvents, readProtectedQuestion, readProtectedResponse,
  requireProtectedResponse, reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});
const stages = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const OLD = "t-any-chat-old";
const NEW = "t-any-chat-new";
// The state file's separator between a stage slug and its action.
const SEPARATOR = "\u2014";

// Two Units built one at a time, checkpoints on, at Functional Design.
function construction() {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Checkpoint answered in any chat
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: feature
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Unit Ownership**: solo
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: gated
- **Review Override**: none
- **Change Control**: strict
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${stages.map((stage) => `- [${stage === "functional-design" ? "-" : " "}] ${stage} ${SEPARATOR} EXECUTE`).join("\n")}
- [ ] build-and-test ${SEPARATOR} EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(p, ["alpha", "beta"]);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, p);
  return p;
}

// Alpha built, with no verification command yet.
function built() {
  const p = construction();
  for (const slug of stages) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(p), "construction", "alpha", slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) writeFileSync(join(output, artifactFilename(name)), `# alpha ${name}\n`);
    if (stage.workspace_requires) {
      writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
        stage: slug, unit: "alpha", version: 1, writes: [{ path: "src/alpha.ts" }],
      }));
    }
    const fingerprint = reviewArtifactFingerprint(p, stage, "alpha", { requireRequiredArtifacts: true });
    expect(fingerprint).not.toBeNull();
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: slug, Unit: "alpha", Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, "alpha"),
      "Artifact Fingerprint": fingerprint!,
    }, p);
  }
  return p;
}

// Alpha built and its verification command recorded.
function fixture() {
  const p = built();
  recordCommand(p);
  expect(checkpoint(p, ["--action", "verify"]).status).toBe(0);
  return p;
}

// The same work back in Inception, at `stage`, started.
function inception(stage: string) {
  const p = construction();
  writeFileSync(seededStateFile(p), readFileSync(seededStateFile(p), "utf-8")
    .replace(`- [-] functional-design ${SEPARATOR}`, `- [ ] functional-design ${SEPARATOR}`)
    .replace("### CONSTRUCTION PHASE", `### INCEPTION PHASE\n- [-] ${stage} ${SEPARATOR} EXECUTE\n### CONSTRUCTION PHASE`)
    .replace("- **Current Stage**: functional-design", `- **Current Stage**: ${stage}`)
    .replace("- **Lifecycle Phase**: CONSTRUCTION", "- **Lifecycle Phase**: INCEPTION"));
  appendAuditEntry("STAGE_STARTED", { Stage: stage }, p);
  return p;
}

// A tool run as the agent runs it: no presence bypass.
function tool(p: string, name: string, args: string[]) {
  const env = { ...process.env };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env,
  });
  return { status: result.status, stdout: result.stdout, out: `${result.stdout}${result.stderr}` };
}

function checkpoint(p: string, args: string[]) {
  return tool(p, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", ...args]);
}

function person(p: string, prompt: string, session: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: p, env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

function recordCommand(p: string) {
  const script = join(seededRecordDir(p), "check.cjs");
  writeFileSync(script, "process.exit(0);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", "t-any-chat-command"];
  const decision = tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"]);
  expect(decision.status, decision.out).toBe(0);
  person(p, "Approve", "t-any-chat-command");
  for (const [name, args] of [["log", ["answer", ...identity, "--details", "Approve"]], ["state", ["set-construction-verification-command", command]]] as const) {
    const result = tool(p, name, [...args]);
    expect(result.status, result.out).toBe(0);
  }
}

function next(p: string, args: string[] = []) {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, args);
  expect(result.directive, result.stderr).not.toBeNull();
  return result.directive as {
    kind: string; stage?: string; message?: string; protocol_modules?: string[];
    construction_checkpoint?: { unit: string; approved: boolean };
  };
}

function approvals(p: string) {
  return readAuditShardEvents(p).filter((row) => row.event === "GATE_APPROVED");
}

describe("t-checkpoint-answer-any-chat: a Unit checkpoint answered in a new chat", () => {
  for (const [said, kept] of [["approve", "approve"], ["yes", "yes"], ["/aidlc approve", "approve"]]) {
    test(`"${said}" typed in a new chat approves the Unit the old chat asked about, in one reply`, () => {
      const p = fixture();
      expect(checkpoint(p, ["--action", "ask", "--session", OLD]).status).toBe(0);
      person(p, said, NEW);
      const approved = checkpoint(p, ["--action", "approve", "--session", NEW, "--user-input", kept]);
      expect(approved.status, approved.out).toBe(0);
      expect(JSON.parse(approved.stdout).approved).toBe(true);
      const gate = approvals(p).at(-1)!;
      expect(auditBlockField(gate.block, "Session")).toBe(NEW);
      expect(auditBlockField(gate.block, "Person Reply")).toBe(kept);
      expect(readProtectedQuestion(p, OLD)).toBeNull();
      expect(readProtectedQuestion(p, NEW)).toBeNull();
    });
  }

  test("a reply the person typed in the old chat comes with the question", () => {
    const p = fixture();
    expect(checkpoint(p, ["--action", "ask", "--session", OLD]).status).toBe(0);
    person(p, "what does the check run?", OLD);
    person(p, "ok, approve it", NEW);
    expect(readProtectedResponse(p, NEW)?.words).toBe("what does the check run?\nok, approve it");
    const approved = checkpoint(p, ["--action", "approve", "--session", NEW, "--user-input", "ok, approve it"]);
    expect(approved.status, approved.out).toBe(0);
    const reply = auditBlockField(approvals(p).at(-1)!.block, "Person Reply") ?? "";
    expect(reply).toContain("what does the check run?");
    expect(reply).toContain("ok, approve it");
  });

  test("with no reply of the person's in the new chat, the agent cannot approve there", () => {
    const p = fixture();
    expect(checkpoint(p, ["--action", "ask", "--session", OLD]).status).toBe(0);
    const refused = checkpoint(p, ["--action", "approve", "--session", NEW, "--user-input", "Approve"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("no such question is open for this session");
    // A bare entry command is no reply: the question stays where it was asked.
    person(p, "/aidlc", NEW);
    expect(checkpoint(p, ["--action", "approve", "--session", NEW, "--user-input", "Approve"]).status).not.toBe(0);
    expect(readProtectedQuestion(p, OLD)?.kind).toBe("checkpoint-approval");
    expect(approvals(p)).toHaveLength(0);
  });

  test("a question asked after the checkpoint's is the one the reply answers", () => {
    const p = fixture();
    expect(checkpoint(p, ["--action", "ask", "--session", OLD]).status).toBe(0);
    const asked = tool(p, "log", ["decision", "--stage", "code-generation", "--session", NEW,
      "--decision", "Which name do you want for the module?", "--options", "core,main"]);
    expect(asked.status, asked.out).toBe(0);
    person(p, "core", NEW);
    expect(readProtectedQuestion(p, NEW)).toBeNull();
    expect(readProtectedQuestion(p, OLD)?.kind).toBe("checkpoint-approval");
    expect(checkpoint(p, ["--action", "approve", "--session", NEW, "--user-input", "core"]).status).not.toBe(0);
  });

  test("an older checkpoint question, never answered, is not taken by a later reply", () => {
    const p = fixture();
    expect(checkpoint(p, ["--action", "ask", "--session", OLD]).status).toBe(0);
    const middle = "t-any-chat-middle";
    expect(checkpoint(p, ["--action", "ask", "--session", middle]).status).toBe(0);
    person(p, "Approve", middle);
    expect(checkpoint(p, ["--action", "approve", "--session", middle, "--user-input", "Approve"]).status).toBe(0);
    person(p, "approve", NEW);
    expect(readProtectedQuestion(p, NEW)).toBeNull();
    expect(readProtectedQuestion(p, OLD)?.kind).toBe("checkpoint-approval");
    expect(approvals(p)).toHaveLength(1);
  });
});

describe("t-checkpoint-answer-any-chat: what a new chat is told to do", () => {
  test("once its approval was asked, the checkpoint step skips the learnings question", () => {
    const p = fixture();
    const before = next(p);
    expect(before.construction_checkpoint?.unit, JSON.stringify(before)).toBe("alpha");
    expect(before.protocol_modules).toEqual(["construction", "checkpoint", "learnings", "sensors"]);
    expect(checkpoint(p, ["--action", "ask", "--session", OLD]).status).toBe(0);
    const after = next(p);
    expect(after.construction_checkpoint?.unit, JSON.stringify(after)).toBe("alpha");
    expect(after.construction_checkpoint?.approved).toBe(false);
    expect(after.protocol_modules).toEqual(["construction", "checkpoint", "sensors"]);
  });

  test("words while the approval is open name the Unit's own approve and reject steps", () => {
    const p = fixture();
    expect(checkpoint(p, ["--action", "ask", "--session", OLD]).status).toBe(0);
    const print = next(p, ["approve it"]);
    expect(print.kind, JSON.stringify(print)).toBe("print");
    expect(print.message).toContain("checkpoint --action approve --unit alpha --kind unit`");
    expect(print.message).toContain("checkpoint --action reject --unit alpha --kind unit`");
    expect(print.message).not.toContain("session you asked with");
  });

  test("\"/aidlc 2\" in a new chat is kept as the reply, and the step names the numbered choices to read it against", () => {
    const p = fixture();
    expect(checkpoint(p, ["--action", "ask", "--session", OLD]).status).toBe(0);
    person(p, "/aidlc 2", NEW);
    expect(readProtectedResponse(p, NEW)?.choice).toBeUndefined();
    expect(readProtectedResponse(p, NEW)?.words).toBe("2");
    const print = next(p, ["2"]);
    expect(print.kind, JSON.stringify(print)).toBe("print");
    expect(print.message).toContain(
      "its choices are 1. Approve and 2. Request Changes; answer it through that checkpoint, never `log answer`",
    );
  });
});

describe("t-checkpoint-answer-any-chat: a batch checkpoint answered in a new chat", () => {
  test("the reply takes the batch question the old chat asked", () => {
    const p = fixture();
    const target = { kind: "batch", batch: 1, units: ["alpha", "beta"], fingerprint: "sha256:batch", commandSha256s: {} };
    appendAuditEntry("DECISION_RECORDED", {
      Checkpoint: "Swarm Batch Approval", Stage: "code-generation", "Batch number": "1", Units: "alpha, beta",
      Fingerprint: "sha256:batch", Session: OLD, Options: "Approve,Request Changes",
    }, p);
    mintProtectedQuestion(p, { kind: "checkpoint-approval", session: OLD, target });
    expect(recordProtectedHumanResponse(p, NEW, "looks good", null).recorded).toBe(true);
    expect(readProtectedQuestion(p, OLD)).toBeNull();
    expect(readProtectedResponse(p, NEW)?.words).toBe("looks good");
    expect(() => requireProtectedResponse(p, NEW, {
      kind: "checkpoint-approval", targetDigest: protectedTargetDigest(target), choice: "Approve",
    })).not.toThrow();
  });

  // Under a strict Guard Policy a batch whose files changed after its check is
  // asked with Request Changes alone, so its one choice is 1; a row from
  // before rows named their options offered both.
  for (const [offered, named] of [
    ["both choices", "its choices are 1. Approve and 2. Request Changes"],
    ["Request Changes alone", "its one choice is 1. Request Changes"],
    ["no Options field", "its choices are 1. Approve and 2. Request Changes"],
  ] as const) {
    test(`a number at a batch question with ${offered}: the step names ${named}`, () => {
      const p = construction();
      appendAuditEntry("STAGE_STARTED", { Stage: "functional-design" }, p);
      const options: Record<string, string> = offered === "both choices" ? { Options: "Approve,Request Changes" }
        : offered === "Request Changes alone" ? { Options: "Request Changes" } : {};
      appendAuditEntry("DECISION_RECORDED", {
        Checkpoint: "Swarm Batch Approval", Stage: "functional-design", "Batch number": "1", Units: "alpha, beta",
        Fingerprint: "sha256:batch", Session: OLD, ...options,
      }, p);
      const print = next(p, [offered === "Request Changes alone" ? "1" : "2"]);
      expect(print.kind, JSON.stringify(print)).toBe("print");
      expect(print.message).toContain("swarm-checkpoint --action reject --batch 1 --units 'alpha, beta'`");
      expect(print.message).toContain(`${named}; answer it through that checkpoint`);
      expect(print.message?.includes("1. Approve")).toBe(offered !== "Request Changes alone");
    });
  }

  // The step names the batch's own numbered choices, and the agent reads a
  // number against them: "/aidlc 1" in a new chat at that batch is kept as the
  // reply its Request Changes stands on.
  test("\"/aidlc 1\" in a new chat at a batch offering Request Changes alone is the reply the agent's Request Changes stands on", () => {
    const p = fixture();
    const target = { kind: "batch", batch: 1, units: ["alpha", "beta"], fingerprint: "sha256:batch", commandSha256s: {} };
    appendAuditEntry("DECISION_RECORDED", {
      Checkpoint: "Swarm Batch Approval", Stage: "code-generation", "Batch number": "1", Units: "alpha, beta",
      Fingerprint: "sha256:batch", Session: OLD, Options: "Request Changes",
    }, p);
    mintProtectedQuestion(p, { kind: "checkpoint-approval", session: OLD, target, choices: ["Request Changes"] });
    person(p, "/aidlc 1", NEW);
    expect(readProtectedQuestion(p, OLD)).toBeNull();
    expect(readProtectedResponse(p, NEW)?.choice).toBeUndefined();
    expect(readProtectedResponse(p, NEW)?.words).toBe("1");
    expect(() => requireProtectedResponse(p, NEW, {
      kind: "checkpoint-approval", targetDigest: protectedTargetDigest(target), choice: "Request Changes",
    })).not.toThrow();
  });
});

// The two other questions whose answer needs the person's own reply to them,
// asked in the old chat inside the current stage.
const PROTECTED = {
  "verification command": {
    asked: ["--checkpoint", "verification-command", "--command", "npm test", "--decision", "Use this command to verify each completed Unit?"],
    answer: ["--checkpoint", "verification-command", "--command", "npm test"],
    receipt: "VERIFICATION_COMMAND_RECORDED",
  },
  "Construction policy": {
    asked: ["--checkpoint", "construction-policy", "--field", "Construction Execution", "--value", "swarm", "--decision", "Build the Units in parallel?"],
    answer: ["--checkpoint", "construction-policy", "--field", "Construction Execution", "--value", "swarm"],
    receipt: "CONSTRUCTION_POLICY_RECORDED",
  },
} as const;

function askedInOldChat(which: keyof typeof PROTECTED) {
  const p = construction();
  appendAuditEntry("STAGE_STARTED", { Stage: "functional-design" }, p);
  const asked = tool(p, "log", ["decision", "--stage", "functional-design", ...PROTECTED[which].asked, "--session", OLD,
    "--options", "Approve,Request Changes"]);
  expect(asked.status, asked.out).toBe(0);
  return p;
}

function answer(p: string, which: keyof typeof PROTECTED, session: string, details = "Approve") {
  return tool(p, "log", ["answer", "--stage", "functional-design", ...PROTECTED[which].answer, "--session", session, "--details", details]);
}

for (const which of Object.keys(PROTECTED) as (keyof typeof PROTECTED)[]) {
  describe(`t-checkpoint-answer-any-chat: a ${which} question answered in a new chat`, () => {
    test("\"/aidlc approve\" typed in a new chat records the approval there, with their words", () => {
      const p = askedInOldChat(which);
      person(p, "/aidlc approve", NEW);
      const recorded = answer(p, which, NEW);
      expect(recorded.status, recorded.out).toBe(0);
      const receipt = readAuditShardEvents(p).filter((row) => row.event === PROTECTED[which].receipt).at(-1);
      expect(receipt, recorded.out).toBeDefined();
      expect(auditBlockField(receipt!.block, "Session")).toBe(NEW);
      expect(auditBlockField(receipt!.block, "Person Reply")).toBe("approve");
      expect(readProtectedQuestion(p, OLD)).toBeNull();
      expect(readProtectedQuestion(p, NEW)).toBeNull();
    });

    test("with no reply of the person's in the new chat, nothing is recorded there", () => {
      const p = askedInOldChat(which);
      expect(answer(p, which, NEW).status).not.toBe(0);
      // A bare entry command is no reply: the question stays where it was asked.
      person(p, "/aidlc", NEW);
      expect(answer(p, which, NEW).status).not.toBe(0);
      expect(readProtectedQuestion(p, OLD)?.kind).toBe(which === "verification command" ? "verification-command" : "construction-policy");
      expect(readAuditShardEvents(p).some((row) => row.event === PROTECTED[which].receipt)).toBe(false);
    });

    test("a question asked after it is the one the reply answers", () => {
      const p = askedInOldChat(which);
      const later = tool(p, "log", ["decision", "--stage", "functional-design", "--session", NEW,
        "--decision", "Which name do you want for the module?", "--options", "core,main"]);
      expect(later.status, later.out).toBe(0);
      person(p, "approve", NEW);
      expect(readProtectedQuestion(p, NEW)).toBeNull();
      expect(answer(p, which, NEW).status).not.toBe(0);
    });

    test("the choice the agent read is recorded as it hands it; no tool holds it to a reading of the words", () => {
      const p = askedInOldChat(which);
      person(p, "Request Changes", NEW);
      const recorded = answer(p, which, NEW, "Request Changes");
      expect(recorded.status, recorded.out).toBe(0);
      expect(recorded.out).not.toContain("The person picked");
    });
  });
}

describe("t-checkpoint-answer-any-chat: the step for prose at a verification command or Construction policy question", () => {
  test("names the verification command's own answer and setter, with the command file and never the command", () => {
    const p = askedInOldChat("verification command");
    const print = next(p, ["approve"]);
    expect(print.kind, JSON.stringify(print)).toBe("print");
    expect(print.message).toContain("its choices are 1. Approve and 2. Request Changes");
    expect(print.message).toContain("answer --stage functional-design --checkpoint verification-command --command-file verification-command.txt --details");
    expect(print.message).toContain("set-construction-verification-command --command-file verification-command.txt`");
    expect(print.message).not.toContain("npm test");
    expect(print.message).not.toContain("the checkpoint flags that question was logged with");
  });

  test("names the Construction policy question's own answer and setter", () => {
    const p = askedInOldChat("Construction policy");
    const print = next(p, ["approve"]);
    expect(print.kind, JSON.stringify(print)).toBe("print");
    expect(print.message).toContain("answer --stage functional-design --checkpoint construction-policy --field 'Construction Execution' --value swarm --details");
    // Built one Unit at a time here, and parallel needs stage by stage first:
    // an Approve runs both setters, in that order, each with their message.
    expect(namedSetters(print.message)).toEqual([
      "set-construction-iteration stage-major --message <id>", "set-construction-execution swarm --message <id>",
    ]);
  });

  test("names the one setter, with the person's message, when Construction already goes stage by stage", () => {
    const p = askedInOldChat("Construction policy");
    writeFileSync(seededStateFile(p), readFileSync(seededStateFile(p), "utf-8").replace(
      "- **Construction Iteration**: unit-major", "- **Construction Iteration**: stage-major"));
    const print = next(p, ["approve"]);
    expect(print.kind, JSON.stringify(print)).toBe("print");
    expect(namedSetters(print.message)).toEqual(["set-construction-execution swarm --message <id>"]);
  });
});

// The state setters a step names, in the order it names them.
function namedSetters(message: string | undefined): string[] {
  return [...(message ?? "").matchAll(/`[^`]*aidlc-state\.ts (set-[^`]*)`/g)].map((match) => match[1]);
}

// The person types a bare `/aidlc` in `session`, the host may write rows of
// its own after it (`after`), and the agent runs `next` there.
function bare(p: string, session: string, after: () => void = () => {}) {
  person(p, "/aidlc", session);
  after();
  const env: Record<string, string | undefined> = {
    ...process.env, AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p, AIDLC_SESSION_OVERRIDE: session, AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
  };
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, [], { env });
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as {
    kind: string; stage?: string; message?: string; narration?: string; change_notices?: string[];
    construction_checkpoint?: { unit: string };
  };
}

// The person picks `label` in the question box showing `question`, as Claude Code's hook passes it.
function picked(p: string, session: string, question: string, options: string[], label: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  const questions = [{ question, header: "Choice", multiSelect: false, options: options.map((o) => ({ label: o, description: o })) }];
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: p, env,
    input: JSON.stringify({
      hook_event_name: "PostToolUse", session_id: session, tool_name: "AskUserQuestion",
      tool_input: { questions }, tool_response: { questions, answers: { [question]: label } },
    }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

describe("t-checkpoint-answer-any-chat: a bare /aidlc in a new chat", () => {
  test("shows the stage's open chat question again, as it was asked, with its choices and its answer, and ends the turn", () => {
    const p = construction();
    appendAuditEntry("STAGE_STARTED", { Stage: "functional-design" }, p);
    const asked = tool(p, "log", ["decision", "--stage", "functional-design", "--session", OLD,
      "--decision", "Which name do you want for the module?", "--options", "core,main"]);
    expect(asked.status, asked.out).toBe(0);
    const shown = bare(p, NEW);
    expect(shown.kind, JSON.stringify(shown)).toBe("print");
    expect(shown.message).toContain('"Which name do you want for the module?"');
    expect(shown.message).toContain('"core", "main"');
    expect(shown.message).toContain("end your turn");
    expect(shown.message).toContain("answer --stage functional-design --details");
    expect(String(shown.change_notices)).toContain("Picking up where we left off");
  });

  // Under "Continue automatically" the person who is there still answers the
  // questions the stage asks them, so a new chat shows it again as well.
  test("under autonomous Construction, shows the stage's open chat question again too", () => {
    const p = construction();
    writeFileSync(seededStateFile(p), readFileSync(seededStateFile(p), "utf-8").replace(
      "- **Construction Autonomy Mode**: gated", "- **Construction Autonomy Mode**: autonomous"));
    appendAuditEntry("STAGE_STARTED", { Stage: "functional-design" }, p);
    const asked = tool(p, "log", ["decision", "--stage", "functional-design", "--session", OLD,
      "--decision", "Which name do you want for the module?", "--options", "core,main"]);
    expect(asked.status, asked.out).toBe(0);
    const shown = bare(p, NEW);
    expect(shown.kind, JSON.stringify(shown)).toBe("print");
    expect(shown.message).toContain('"Which name do you want for the module?"');
    expect(shown.message).toContain("end your turn");
  });

  test("a Construction policy question comes back in its own words, so the pick in its question box answers it", () => {
    const p = askedInOldChat("Construction policy");
    const shown = bare(p, NEW);
    expect(shown.kind, JSON.stringify(shown)).toBe("print");
    // Verbatim: the box that shows it again pairs with the question by its text or its two exact choices.
    expect(shown.message).toContain('"Build the Units in parallel?"');
    expect(shown.message).toContain("--checkpoint construction-policy --field 'Construction Execution' --value swarm");
    picked(p, NEW, "Build the Units in parallel?", ["Approve", "Request Changes"], "Approve");
    expect(readProtectedResponse(p, NEW)?.choice).toBe("Approve");
    const recorded = answer(p, "Construction policy", NEW);
    expect(recorded.status, recorded.out).toBe(0);
  });

  // Copilot CLI runs its session-start hook beside the prompt hook in no fixed
  // order, so the chat's own session rows can land after the person's line.
  const HOST_ROWS: Array<[string, Array<[string, Record<string, string>]>]> = [
    ["a new chat's SESSION_ENDED for the last chat and its SESSION_STARTED", [
      ["SESSION_ENDED", { Session: OLD }], ["SESSION_STARTED", { Source: "startup", Session: NEW }],
    ]],
    ["SESSION_RESUMED and SESSION_COMPACTED", [
      ["SESSION_RESUMED", { Source: "resume", Session: NEW }], ["SESSION_COMPACTED", { Session: NEW }],
    ]],
  ];
  for (const [what, rows] of HOST_ROWS) {
    test(`the open question still comes back when the host writes ${what} after the line`, () => {
      const p = askedInOldChat("Construction policy");
      const shown = bare(p, NEW, () => {
        for (const [event, fields] of rows) appendAuditEntry(event, fields, p);
      });
      expect(shown.kind, JSON.stringify(shown)).toBe("print");
      expect(shown.message).toContain('"Build the Units in parallel?"');
    });
  }

  test("a row the agent wrote after the line still means the line was acted on", () => {
    const p = askedInOldChat("Construction policy");
    const resumed = bare(p, NEW, () => appendAuditEntry("ARTIFACT_UPDATED", {
      Tool: "Write", File: `${p}/notes.md`, Context: "notes.md",
    }, p));
    expect(resumed.kind, JSON.stringify(resumed)).toBe("run-stage");
  });

  // Each chat reads only its own line (takePersonsOwnLine reads the invoking
  // chat's latest message, and turnIsLatestRow matches that message's turn).
  test("another chat opened after the line never reads that line as its own", () => {
    const p = askedInOldChat("Construction policy");
    const other = "t-any-chat-other";
    person(p, "/aidlc", NEW);
    appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: other }, p);
    const nextIn = (session: string) => runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, [], {
      env: { ...process.env, AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p, AIDLC_SESSION_OVERRIDE: session, AIDLC_SESSION_OVERRIDE_SOURCE: undefined },
    }).directive as { kind: string };
    const there = nextIn(other);
    expect(there.kind, JSON.stringify(there)).toBe("run-stage");
    // The chat that typed it still reads it, past the other chat's session row.
    const here = nextIn(NEW);
    expect(here.kind, JSON.stringify(here)).toBe("print");
  });

  test("a yes to building the Units in parallel, shown again while they are built one at a time, applies both setters it names", () => {
    const p = askedInOldChat("Construction policy");
    const shown = bare(p, NEW);
    expect(shown.kind, JSON.stringify(shown)).toBe("print");
    const setters = namedSetters(shown.message);
    expect(setters).toEqual([
      "set-construction-iteration stage-major --message <id>", "set-construction-execution swarm --message <id>",
    ]);
    person(p, "that's right", NEW);
    const id = auditBlockField(readAuditShardEvents(p).filter((row) => row.event === "HUMAN_TURN").at(-1)!.block, "Message Id");
    expect(id).not.toBeNull();
    const recorded = answer(p, "Construction policy", NEW);
    expect(recorded.status, recorded.out).toBe(0);
    for (const setter of setters) {
      const ran = tool(p, "state", setter.replace("<id>", id!).split(" "));
      expect(ran.status, ran.out).toBe(0);
    }
    const state = readFileSync(seededStateFile(p), "utf-8");
    expect(getField(state, "Construction Iteration")).toBe("stage-major");
    expect(getField(state, "Construction Execution")).toBe("swarm");
    const set = readAuditShardEvents(p).filter((row) => row.event === "CONSTRUCTION_POLICY_SET");
    expect(set.map((row) => auditBlockField(row.block, "Field"))).toEqual(["Construction Iteration", "Construction Execution"]);
    expect(auditBlockField(set[0].block, "Message Id")).toBe(id);
  });

  // A question that takes the person's own reply is held for it under
  // aidlc/.aidlc-sessions/, which is not committed: a teammate's fresh clone
  // holds none, so the question shown again is registered there first.
  for (const which of Object.keys(PROTECTED) as (keyof typeof PROTECTED)[]) {
    test(`in a fresh clone the ${which} question shown again is registered first, so one pick records it`, () => {
      const p = askedInOldChat(which);
      writeFileSync(join(seededRecordDir(p), "verification-command.txt"), "npm test", "utf-8");
      renameSync(join(p, "aidlc", ".aidlc-sessions"), join(p, "aidlc", ".aidlc-sessions-of-the-first-clone"));
      const shown = bare(p, NEW);
      expect(shown.kind, JSON.stringify(shown)).toBe("print");
      const flags = which === "verification command"
        ? "--checkpoint verification-command --command-file verification-command.txt"
        : "--checkpoint construction-policy --field 'Construction Execution' --value swarm";
      expect(shown.message).toContain(`decision --stage functional-design ${flags} --decision`);
      const asked = PROTECTED[which].asked;
      const registered = tool(p, "log", ["decision", "--stage", "functional-design",
        ...(which === "verification command"
          ? ["--checkpoint", "verification-command", "--command-file", "verification-command.txt"]
          : ["--checkpoint", "construction-policy", "--field", "Construction Execution", "--value", "swarm"]),
        "--decision", asked[asked.indexOf("--decision") + 1], "--options", "Approve,Request Changes", "--session", NEW]);
      expect(registered.status, registered.out).toBe(0);
      person(p, "approve", NEW);
      const recorded = answer(p, which, NEW);
      expect(recorded.status, recorded.out).toBe(0);
    });
  }

  test("on the machine that asked it, the question shown again is not registered again", () => {
    const shown = bare(askedInOldChat("verification command"), NEW);
    expect(shown.message).not.toContain(" decision --stage ");
  });

  test("a question its stage's questions file still holds is asked again by the stage's own step, from the file", () => {
    // A guided batch: logged as its question numbers and every option shown, its questions in the file.
    const p = construction();
    appendAuditEntry("STAGE_STARTED", { Stage: "functional-design" }, p);
    const dir = join(seededRecordDir(p), "construction", "alpha", "functional-design");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "functional-design-questions.md"),
      "# Questions\n\n## Q1\n\nWhich store?\n\nA. Files\nB. A database\n\n[Answer]: \n\n## Q2\n\nWho signs in?\n\nC. Anyone\nD. Members\n\n[Answer]: \n");
    const asked = tool(p, "log", ["decision", "--stage", "functional-design", "--session", OLD,
      "--decision", "Q1,Q2", "--options", "A,B,C,D"]);
    expect(asked.status, asked.out).toBe(0);
    // They replied in the old chat, which ended before the answers were written down.
    person(p, "Q1: B, Q2: D", OLD);
    const resumed = bare(p, NEW) as { kind: string; kept_replies?: { replies: unknown[] } };
    expect(resumed.kind, JSON.stringify(resumed)).toBe("run-stage");
    expect(JSON.stringify(resumed.kept_replies?.replies ?? [])).toContain("Q1: B, Q2: D");
  });

  // The stage's own step never names it: at Functional Design the step is
  // the design itself, so a new chat went on past the question.
  test("a verification command question comes back with the command it asks about, answered by its own flags", () => {
    const p = askedInOldChat("verification command");
    const shown = bare(p, NEW);
    expect(shown.kind, JSON.stringify(shown)).toBe("print");
    expect(shown.message).toContain('"Use this command to verify each completed Unit?"');
    expect(shown.message).toContain('followed by the command it asks about, "npm test", in a code span');
    expect(shown.message).toContain("end your turn");
    expect(shown.message).toContain("answer --stage functional-design --checkpoint verification-command --command-file verification-command.txt --details");
    expect(shown.message).toContain("set-construction-verification-command --command-file verification-command.txt`");
    picked(p, NEW, "Use this command to verify each completed Unit? `npm test`", ["Approve", "Request Changes"], "Approve");
    expect(readProtectedResponse(p, NEW)?.choice).toBe("Approve");
    const recorded = answer(p, "verification command", NEW);
    expect(recorded.status, recorded.out).toBe(0);
  });

  test("a verification command question Delivery Planning asked comes back the same way", () => {
    const p = inception("delivery-planning");
    const asked = tool(p, "log", ["decision", "--stage", "delivery-planning", ...PROTECTED["verification command"].asked,
      "--session", OLD, "--options", "Approve,Request Changes"]);
    expect(asked.status, asked.out).toBe(0);
    const shown = bare(p, NEW);
    expect(shown.kind, JSON.stringify(shown)).toBe("print");
    expect(shown.message).toContain('"Use this command to verify each completed Unit?"');
    expect(shown.message).toContain("answer --stage delivery-planning --checkpoint verification-command");
  });

  // Its checkpoint step asks for a command and never names the one asked, so
  // the question comes back from its row here too; once it is approved the
  // checkpoint step runs the check.
  test("a verification command question a Unit checkpoint asked comes back, and once approved the checkpoint can verify", () => {
    const p = built();
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "npm test"];
    const asked = tool(p, "log", ["decision", ...identity, "--session", OLD,
      "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"]);
    expect(asked.status, asked.out).toBe(0);
    const shown = bare(p, NEW);
    expect(shown.kind, JSON.stringify(shown)).toBe("print");
    expect(shown.message).toContain('followed by the command it asks about, "npm test", in a code span');
    expect(shown.message).toContain("answer --stage code-generation --checkpoint verification-command");
    picked(p, NEW, "Use this command to verify each completed Unit? `npm test`", ["Approve", "Request Changes"], "Approve");
    const recorded = tool(p, "log", ["answer", ...identity, "--session", NEW, "--details", "Approve"]);
    expect(recorded.status, recorded.out).toBe(0);
    const set = tool(p, "state", ["set-construction-verification-command", "npm test"]);
    expect(set.status, set.out).toBe(0);
    const step = next(p) as { construction_checkpoint?: { unit: string; command_authorized: boolean } };
    expect(step.construction_checkpoint?.unit, JSON.stringify(step)).toBe("alpha");
    expect(step.construction_checkpoint?.command_authorized).toBe(true);
  });

  // The question is not in the questions file, so a blank answer there is
  // not it: the stage's own step would not ask it.
  test("a Construction policy question comes back while the stage's questions file still has a blank answer", () => {
    const p = askedInOldChat("Construction policy");
    const dir = join(seededRecordDir(p), "construction", "alpha", "functional-design");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "functional-design-questions.md"), "# Questions\n\n## Q1\n\nWhich store?\n\nA. Files\nB. A database\n\n[Answer]: \n");
    const shown = bare(p, NEW);
    expect(shown.kind, JSON.stringify(shown)).toBe("print");
    expect(shown.message).toContain('"Build the Units in parallel?"');
  });

  // The person answered the stage's questions and was shown the summary of
  // them. A new chat's stage step only named the file, and an agent wrote new
  // questions over it; the summary now comes back as it was asked.
  // The summary asked in the old chat, with the question's answers in the file.
  function openSummary(unit: string | null) {
    const p = unit ? construction() : inception("requirements-analysis");
    if (unit) appendAuditEntry("STAGE_STARTED", { Stage: "functional-design" }, p);
    const stage = unit ? "functional-design" : "requirements-analysis";
    const dir = unit ? join(seededRecordDir(p), "construction", unit, stage) : join(seededRecordDir(p), "inception", stage);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${stage}-questions.md`);
    writeFileSync(file, [
      "# Questions", "", "## Q1", "Which bug?", "", "A) Done items come back", "X) Other (please specify)", "",
      "[Answer]: A", "", "## Consolidated Summary Confirmation", "", "- Done items come back after a reload.", "",
      "- Looks correct", "- Request changes", "", "[Answer]:", "",
    ].join("\n"));
    const relative = file.slice(p.length + 1).replaceAll("\\", "/");
    const identity = ["--checkpoint", "summary-confirmation", "--stage", stage, ...(unit ? ["--unit", unit] : []), "--questions-file", relative];
    const asked = tool(p, "log", ["decision", ...identity, "--session", OLD,
      "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes"]);
    expect(asked.status, asked.out).toBe(0);
    // The agent writes the choice on the summary's tag, as the shown step says, before recording it.
    const tag = (choice: string) => writeFileSync(file, readFileSync(file, "utf-8").replace(/\[Answer\]:\n$/, `[Answer]: ${choice}\n`));
    // The command the shown step names for `choice`, in full: the span closes after it.
    const command = (choice: string) =>
      `answer --checkpoint summary-confirmation --stage ${stage}${unit ? ` --unit ${unit}` : ""} --questions-file ` +
      `${relative} --details ${quoteCommandArgument(choice)}\``;
    // The record of the revised summary's question, in full, as a receipt names it.
    const revisedRecord = `decision --checkpoint summary-confirmation --stage ${stage}${unit ? ` --unit ${unit}` : ""} ` +
      `--questions-file ${relative} --decision ${quoteCommandArgument("Does this all look correct?")} --options ` +
      `${quoteCommandArgument("Looks correct,Request changes")}\``;
    // The agent revises the summary, sets its tag back to blank, records the
    // question as the receipt said and shows it; the person picks "1".
    const confirmRevised = (session = NEW) => {
      writeFileSync(file, readFileSync(file, "utf-8").replace("- Done items come back after a reload.",
        "- Only deleted done items come back after a reload.").replace(/\[Answer\]: Request changes\n$/, "[Answer]:\n"));
      const asked = tool(p, "log", ["decision", ...identity, "--session", session,
        "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes"]);
      expect(asked.status, asked.out).toBe(0);
      person(p, "1", session);
      tag("Looks correct");
      // Recorded the first time: no refusal, so nobody asks them again.
      const confirmed = tool(p, "log", ["answer", ...identity, "--session", session, "--details", "Looks correct"]);
      expect(confirmed.status, confirmed.out).toBe(0);
      const receipts = readAuditShardEvents(p).filter((row) => row.event === "SUMMARY_CONFIRMATION_RECORDED");
      // Shards are read file by file, so the two receipts may come in either order.
      expect(receipts.map((row) => auditBlockField(row.block, "Details")).sort()).toEqual(["Looks correct", "Request changes"]);
    };
    return { p, stage, relative, identity, tag, command, revisedRecord, confirmRevised };
  }

  for (const unit of [null, "alpha"] as const) {
    test(`a summary confirmation open ${unit ? "for a Unit " : "at a stage "}comes back from its questions file, answered by its own flags`, () => {
      const { p, relative, identity, tag, command } = openSummary(unit);
      const shown = bare(p, NEW);
      expect(shown.kind, JSON.stringify(shown)).toBe("print");
      expect(shown.message).toContain('"Does this all look correct?"');
      expect(shown.message).toContain('"Looks correct", "Request changes"');
      expect(shown.message).toContain(relative);
      expect(shown.message).toContain("end your turn");
      expect(shown.message).toContain(command("Looks correct"));
      person(p, "yes", NEW);
      tag("Looks correct");
      const recorded = tool(p, "log", ["answer", ...identity, "--session", NEW, "--details", "Looks correct"]);
      expect(recorded.status, recorded.out).toBe(0);
      expect(readAuditShardEvents(p).some((row) => row.event === "SUMMARY_CONFIRMATION_RECORDED")).toBe(true);
    });
  }

  // What they asked to change rides with the choice, so they are not asked
  // "What should change?" for words they already said.
  test("a Request changes reply to the summary shown again is recorded with what they asked to change", () => {
    const { p, identity, tag, revisedRecord, confirmRevised } = openSummary(null);
    const shown = bare(p, NEW);
    expect(shown.message).toContain("'Request changes: <what>'");
    const said = "Request changes: blank titles include whitespace-only ones";
    person(p, said, NEW);
    tag("Request changes");
    const recorded = tool(p, "log", ["answer", ...identity, "--session", NEW, "--details", said]);
    expect(recorded.status, recorded.out).toBe(0);
    expect(recorded.stdout).not.toContain("What should change?");
    const receipt = readAuditShardEvents(p).filter((row) => row.event === "SUMMARY_CONFIRMATION_RECORDED").at(-1);
    expect(auditBlockField(receipt!.block, "Feedback")).toBe("blank titles include whitespace-only ones");
    // The agent revises at once, and the revised summary's question goes on record before it is shown.
    expect(recorded.stdout).toContain(revisedRecord);
    confirmRevised();
  });

  // Live (opencode): the revised summary was shown with no record of its
  // question, so their "1" at it was refused and the same question asked again.
  for (const unit of [null, "alpha"] as const) {
    test(`after a Request changes at the summary shown again ${unit ? "for a Unit" : "at a stage"}, what they say to change names the revised summary's record, and their pick at it is recorded the first time`, () => {
      const { p, stage, identity, tag, revisedRecord, confirmRevised } = openSummary(unit);
      bare(p, NEW);
      person(p, "2", NEW);
      tag("Request changes");
      const changes = tool(p, "log", ["answer", ...identity, "--session", NEW, "--details", "Request changes"]);
      expect(changes.status, changes.out).toBe(0);
      expect(changes.stdout).not.toContain(revisedRecord);
      const said = "only done items that were deleted come back";
      person(p, said, NEW);
      const words = tool(p, "log", ["answer", "--stage", stage, ...(unit ? ["--unit", unit] : []), "--session", NEW,
        "--details", said]);
      expect(words.status, words.out).toBe(0);
      expect(words.stdout).toContain(revisedRecord);
      confirmRevised();
      expect(readAuditShardEvents(p).filter((row) => row.event === "ERROR_LOGGED")).toHaveLength(0);
    });
  }

  // A chat that picks the work up again at "What should change?" answers with
  // the step it is given, which names no Unit, and a teammate's fresh clone
  // holds the change request on the first clone's shard; the note still names
  // the revised summary's record, with the Unit it was asked for.
  for (const where of ["a third chat", "a teammate's fresh clone"] as const) {
    test(`after a Request changes for a Unit, what they say to change in ${where} names the revised summary's record`, () => {
      const { p, stage, identity, tag, revisedRecord, confirmRevised } = openSummary("alpha");
      bare(p, NEW);
      person(p, "2", NEW);
      tag("Request changes");
      expect(tool(p, "log", ["answer", ...identity, "--session", NEW, "--details", "Request changes"]).status).toBe(0);
      if (where === "a teammate's fresh clone") {
        const mine = seededAuditShard(p);
        renameSync(mine, join(dirname(mine), `zz-teammate-${basename(mine)}`));
        renameSync(join(p, "aidlc", ".aidlc-sessions"), join(p, "aidlc", ".aidlc-sessions-of-the-first-clone"));
        // The record's times are whole seconds: two shards order by them alone.
        Bun.sleepSync(1100);
      }
      const THIRD = "t-any-chat-third";
      const shown = bare(p, THIRD);
      expect(shown.message).toContain('"What should change?"');
      expect(shown.message).toContain(`answer --stage ${stage} --details`);
      const said = "only done items that were deleted come back";
      person(p, said, THIRD);
      const words = tool(p, "log", ["answer", "--stage", stage, "--session", THIRD, "--details", said]);
      expect(words.status, words.out).toBe(0);
      expect(words.stdout).toContain(revisedRecord);
      confirmRevised(THIRD);
    });
  }

  // The person switched the summary confirmation off after asking for changes:
  // nothing tells the agent to show the summary again.
  test("after a Request changes, with the summary confirmation then switched off, what they say to change names no summary record", () => {
    const { p, stage, identity, tag, revisedRecord } = openSummary(null);
    bare(p, NEW);
    person(p, "2", NEW);
    tag("Request changes");
    expect(tool(p, "log", ["answer", ...identity, "--session", NEW, "--details", "Request changes"]).status).toBe(0);
    writeFileSync(seededStateFile(p), readFileSync(seededStateFile(p), "utf-8")
      .replace("- **Change Control**: strict", "- **Change Control**: strict\n- **Summary Confirmation**: off (set by you)"));
    const said = "only done items that were deleted come back";
    person(p, said, NEW);
    const words = tool(p, "log", ["answer", "--stage", stage, "--session", NEW, "--details", said]);
    expect(words.status, words.out).toBe(0);
    expect(words.stdout).not.toContain(revisedRecord);
    expect(words.stdout).not.toContain("agent_note");
  });

  // The note is for the revised summary only: once its question is on record,
  // or the summary is confirmed, an ordinary answer says nothing of it.
  test("an answer once the revised summary is on record, or after Looks correct, names no summary record", () => {
    const { p, stage, identity, tag, revisedRecord } = openSummary(null);
    bare(p, NEW);
    person(p, "Request changes: only deleted done items", NEW);
    tag("Request changes");
    expect(tool(p, "log", ["answer", ...identity, "--session", NEW, "--details",
      "Request changes: only deleted done items"]).status).toBe(0);
    const file = join(p, ...String(identity.at(-1)).split("/"));
    writeFileSync(file, readFileSync(file, "utf-8").replace(/\[Answer\]: Request changes\n$/, "[Answer]:\n"));
    expect(tool(p, "log", ["decision", ...identity, "--session", NEW,
      "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes"]).status).toBe(0);
    const ordinary = (words: string) => {
      expect(tool(p, "log", ["decision", "--stage", stage, "--session", NEW, "--decision", "Which list?"]).status).toBe(0);
      person(p, words, NEW);
      const answered = tool(p, "log", ["answer", "--stage", stage, "--session", NEW, "--details", words]);
      expect(answered.status, answered.out).toBe(0);
      expect(answered.stdout).not.toContain(revisedRecord);
      expect(answered.stdout).not.toContain("agent_note");
    };
    ordinary("the done list");
    person(p, "Looks correct", NEW);
    tag("Looks correct");
    expect(tool(p, "log", ["answer", ...identity, "--session", NEW, "--details", "Looks correct"]).status).toBe(0);
    ordinary("the archive");
  });

  // Live, a command whose --details named what they asked to change left a
  // bare Request changes unrecorded while the agent asked what should change.
  test("a Request changes reply that says nothing about what, to the summary shown again, is recorded before they are asked what should change", () => {
    const { p, identity, tag, command } = openSummary(null);
    const shown = bare(p, NEW);
    // Tied to the follow-up it comes before: a pick in a question box went
    // straight to that question with the command only beside it.
    expect(shown.message).toContain(`${command("Request changes")} before you ask them what should change`);
    person(p, "Request changes", NEW);
    tag("Request changes");
    const recorded = tool(p, "log", ["answer", ...identity, "--session", NEW, "--details", "Request changes"]);
    expect(recorded.status, recorded.out).toBe(0);
    expect(recorded.stdout).toContain("What should change?");
    const receipt = readAuditShardEvents(p).filter((row) => row.event === "SUMMARY_CONFIRMATION_RECORDED").at(-1);
    expect(auditBlockField(receipt!.block, "Details")).toBe("Request changes");
    expect(auditBlockField(receipt!.block, "Feedback")).toBeNull();
    // A chat that ends here leaves them at what should change, not the summary.
    const next = bare(p, "t-any-chat-third");
    expect(next.kind, JSON.stringify(next)).toBe("print");
    expect(next.message).toContain('"What should change?"');
    expect(next.message).not.toContain('"Does this all look correct?"');
  });

  test("a Unit checkpoint question is asked again by its checkpoint step", () => {
    const p = fixture();
    expect(checkpoint(p, ["--action", "ask", "--session", OLD]).status).toBe(0);
    const resumed = bare(p, NEW);
    expect(resumed.construction_checkpoint?.unit, JSON.stringify(resumed)).toBe("alpha");
  });
});
