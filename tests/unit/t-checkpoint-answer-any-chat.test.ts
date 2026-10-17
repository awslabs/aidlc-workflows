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
// recorded with. A bare `/aidlc` in a
// new chat shows again, as it was asked, a question with no step of its own
// that asks it again; the others come back through their own step.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { recordProtectedHumanResponse } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  artifactFilename, auditBlockField, findStageBySlug, latestMainWorkflowStageRunFloorForProject,
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

// Alpha built and its verification command recorded.
function fixture() {
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
  recordCommand(p);
  expect(checkpoint(p, ["--action", "verify"]).status).toBe(0);
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

  test("\"/aidlc 2\" in a new chat is Request Changes, and the step names the choices a number picks", () => {
    const p = fixture();
    expect(checkpoint(p, ["--action", "ask", "--session", OLD]).status).toBe(0);
    person(p, "/aidlc 2", NEW);
    expect(readProtectedResponse(p, NEW)?.choice).toBe("Request Changes");
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

  // What the step names and what the hook takes a number for are the same
  // choices: "/aidlc 1" in a new chat at that batch is Request Changes.
  test("\"/aidlc 1\" in a new chat at a batch offering Request Changes alone is Request Changes", () => {
    const p = fixture();
    const target = { kind: "batch", batch: 1, units: ["alpha", "beta"], fingerprint: "sha256:batch", commandSha256s: {} };
    appendAuditEntry("DECISION_RECORDED", {
      Checkpoint: "Swarm Batch Approval", Stage: "code-generation", "Batch number": "1", Units: "alpha, beta",
      Fingerprint: "sha256:batch", Session: OLD, Options: "Request Changes",
    }, p);
    mintProtectedQuestion(p, { kind: "checkpoint-approval", session: OLD, target, choices: ["Request Changes"] });
    person(p, "/aidlc 1", NEW);
    expect(readProtectedQuestion(p, OLD)).toBeNull();
    expect(readProtectedResponse(p, NEW)?.choice).toBe("Request Changes");
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

    test("the other choice than the one they picked is not recorded", () => {
      const p = askedInOldChat(which);
      person(p, "Request Changes", NEW);
      const refused = answer(p, which, NEW);
      expect(refused.status).not.toBe(0);
      expect(JSON.parse(refused.out.trim()).error).toContain('The person picked "Request Changes"');
      expect(answer(p, which, NEW, "Request Changes").status).toBe(0);
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
    expect(print.message).toContain("set-construction-execution swarm`");
  });
});

// The person types a bare `/aidlc` in `session`, and the agent runs `next` there.
function bare(p: string, session: string) {
  person(p, "/aidlc", session);
  const env: Record<string, string | undefined> = {
    ...process.env, AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p, AIDLC_SESSION_OVERRIDE: session, AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
  };
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, [], { env });
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as {
    kind: string; stage?: string; message?: string; narration?: string; construction_checkpoint?: { unit: string };
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
    expect(shown.narration).toContain("Picking up where we left off");
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

  test("a verification command question is asked again by its own step, not shown from its row", () => {
    const p = askedInOldChat("verification command");
    const resumed = bare(p, NEW);
    expect(resumed.kind, JSON.stringify(resumed)).toBe("run-stage");
  });

  test("a Unit checkpoint question is asked again by its checkpoint step", () => {
    const p = fixture();
    expect(checkpoint(p, ["--action", "ask", "--session", OLD]).status).toBe(0);
    const resumed = bare(p, NEW);
    expect(resumed.construction_checkpoint?.unit, JSON.stringify(resumed)).toBe("alpha");
  });
});
