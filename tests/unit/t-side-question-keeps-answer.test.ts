// covers: function:withdrawProtectedQuestions, subcommand:aidlc-log:decision, subcommand:aidlc-bolt:checkpoint
//
// The person's answer to a Unit checkpoint stands through a question the agent
// asks of its own before recording it. Seen live on Claude Code: at "Approve
// this completed u1-plain-greeting?" the person typed a Request Changes; the
// agent asked a side question first (log decision and a question box), the
// person answered it, and the checkpoint's Request Changes was refused "no
// such question is open for this session. Re-ask ...": the agent's own
// question had withdrawn the checkpoint question and the reply kept for it, so
// the person was asked to pick Request Changes again.
//
// Now a plain question of the agent's, in the chat it names, leaves a protected
// question there in place when the person already replied to it, so the choice
// they made is recorded without asking again. A protected question nobody
// replied to is withdrawn as before, a protected or plan question still
// replaces it, and a question whose chat nobody can name still retires every
// chat's (t341 pins that rule).
//
// Mechanism: cli, the real human-turn hook (a typed reply and a question box's
// PostToolUse), the real `log decision`, `log answer` and `bolt checkpoint`
// over two Units built one at a time with checkpoints on.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv, seedAidlcMemory, seedBoltDag, seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, findStageBySlug, latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents, readProtectedQuestion, reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});
const stages = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const CHAT = "01995000-7a11-7000-8000-00000000a154";
const SEPARATOR = "\u2014";
const CHANGE = "Request changes: when no name is given, print Usage: node src/app.js <name> [--shout] and exit with code 1";
const SIDE = "With no name, the usage line is already printed (to stderr) with exit code 1. Keep that, or print it on stdout instead?";
const SIDE_OPTIONS = ["Keep as is (stderr)", "Print on stdout instead"];

// Two Units built one at a time, checkpoints on, alpha built and verified.
function fixture(): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Side question at a checkpoint
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
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: slug, Unit: "alpha", Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, "alpha"),
      "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, "alpha", { requireRequiredArtifacts: true })!,
    }, p);
  }
  recordCommand(p);
  expect(checkpoint(p, ["--action", "verify"]).status).toBe(0);
  return p;
}

// A tool as the agent runs it: no presence bypass.
function tool(p: string, name: string, args: string[]) {
  const env = { ...process.env };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env,
  });
  return { status: result.status, stdout: result.stdout, out: `${result.stdout}${result.stderr}` };
}

const checkpoint = (p: string, args: string[]) =>
  tool(p, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", ...args]);

function hook(p: string, payload: Record<string, unknown>): void {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: p, env,
    input: JSON.stringify({ session_id: CHAT, ...payload }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

const types = (p: string, prompt: string) => hook(p, { hook_event_name: "UserPromptSubmit", prompt });

// Claude Code's question box, answered: the PostToolUse the hook reads.
const picksInBox = (p: string, answer: string) => hook(p, {
  hook_event_name: "PostToolUse", tool_name: "AskUserQuestion",
  tool_input: { questions: [{ question: SIDE, options: SIDE_OPTIONS.map((label) => ({ label })) }] },
  tool_response: { answers: { [SIDE]: answer } },
});

// The agent's own question; with no chat named, as when the shell's chat cannot be found.
const asksItsOwn = (p: string, named: boolean) =>
  tool(p, "log", ["decision", "--stage", "code-generation", ...(named ? ["--session", CHAT] : []),
    "--decision", SIDE, "--options", SIDE_OPTIONS.join(",")]);

// A verification command that passes, quoted for this platform's shell.
function checkCommand(p: string, name: string): string {
  const script = join(seededRecordDir(p), name);
  writeFileSync(script, "process.exit(0);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(process.execPath)} ${quote(script)}`;
}

function recordCommand(p: string): void {
  const command = checkCommand(p, "check.cjs");
  const session = "t-side-question-command";
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", session];
  expect(tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"]).status).toBe(0);
  hook(p, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "Approve" });
  for (const [name, args] of [["log", ["answer", ...identity, "--details", "Approve"]], ["state", ["set-construction-verification-command", command]]] as const) {
    const result = tool(p, name, [...args]);
    expect(result.status, result.out).toBe(0);
  }
}

const reject = (p: string) => checkpoint(p, ["--action", "reject", "--session", CHAT, "--user-input", "Request Changes",
  "--reason", "Trim spaces around the name"]);
const rejections = (p: string) => readAuditShardEvents(p).filter((row) => row.event === "GATE_REJECTED");

describe("the person's checkpoint answer stands through the agent's own question", () => {
  {
    test("a question box asked before the record: their Request Changes is recorded", () => {
      const p = fixture();
      expect(checkpoint(p, ["--action", "ask", "--session", CHAT]).status).toBe(0);
      types(p, CHANGE);
      const asked = asksItsOwn(p, true);
      expect(asked.status, asked.out).toBe(0);
      expect(readProtectedQuestion(p, CHAT)?.kind).toBe("checkpoint-approval");
      picksInBox(p, "Keep the usage line as is. Request changes instead: trim spaces around the name");
      const answered = tool(p, "log", ["answer", "--stage", "code-generation", "--details", SIDE_OPTIONS[0]]);
      expect(answered.status, answered.out).toBe(0);
      const rejected = reject(p);
      expect(rejected.status, rejected.out).toBe(0);
      expect(rejections(p)).toHaveLength(1);
      expect(rejections(p)[0].block).toContain("when no name is given, print Usage");
    });
  }

  test("a side question answered in chat: both of their lines are on the record", () => {
    const p = fixture();
    expect(checkpoint(p, ["--action", "ask", "--session", CHAT]).status).toBe(0);
    types(p, CHANGE);
    expect(asksItsOwn(p, true).status).toBe(0);
    types(p, "Keep the usage line. Trim spaces around the name instead.");
    expect(tool(p, "log", ["answer", "--stage", "code-generation", "--details", SIDE_OPTIONS[0]]).status).toBe(0);
    const rejected = reject(p);
    expect(rejected.status, rejected.out).toBe(0);
    const block = rejections(p)[0]?.block ?? "";
    expect(block).toContain("when no name is given, print Usage");
    expect(block).toContain("Trim spaces around the name instead.");
  });
});

describe("what still withdraws the checkpoint question", () => {
  test("the agent's question with no chat resolved: every chat's question is retired, as before", () => {
    const p = fixture();
    expect(checkpoint(p, ["--action", "ask", "--session", CHAT]).status).toBe(0);
    types(p, CHANGE);
    expect(asksItsOwn(p, false).status).toBe(0);
    expect(readProtectedQuestion(p, CHAT)).toBeNull();
    expect(reject(p).status).not.toBe(0);
  });

  test("the agent's question before any reply of theirs: the checkpoint is asked again, as before", () => {
    const p = fixture();
    expect(checkpoint(p, ["--action", "ask", "--session", CHAT]).status).toBe(0);
    expect(asksItsOwn(p, true).status).toBe(0);
    expect(readProtectedQuestion(p, CHAT)).toBeNull();
    types(p, CHANGE);
    const refused = reject(p);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("no such question is open for this session");
    expect(rejections(p)).toHaveLength(0);
  });

  test("a protected question asked after their reply replaces the checkpoint's", () => {
    const p = fixture();
    expect(checkpoint(p, ["--action", "ask", "--session", CHAT]).status).toBe(0);
    types(p, CHANGE);
    const command = checkCommand(p, "check2.cjs");
    const asked = tool(p, "log", ["decision", "--stage", "code-generation", "--checkpoint", "verification-command",
      "--command", command, "--session", CHAT, "--decision", "Use this command to verify each completed Unit?",
      "--options", "Approve,Request Changes"]);
    expect(asked.status, asked.out).toBe(0);
    expect(readProtectedQuestion(p, CHAT)?.kind).toBe("verification-command");
  });
});
