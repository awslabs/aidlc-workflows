// covers: function:proveMessage, subcommand:aidlc-log:answer, subcommand:aidlc-jump:reopen
//
// The change a person asks for with a Unit's redo answers the code plan
// question that redo brings up. Seen live on Claude Code twice in one run
// (Units built one at a time, checkpoints off): with u1-greeting built, the
// person typed "redo Code Generation for u1-greeting, please. Trim spaces
// around the name ..."; the agent reopened the Unit's step as `next --stage
// code-generation --unit u1-greeting` prints, `next` asked the code plan
// question, and the agent's Request Changes with their words was refused "The
// person has not replied to the plan question since it was shown", so it
// asked them to pick Request Changes for what they had just said.
//
// #2611 already takes the message that brought the question up as its Request
// Changes; on a Unit's reopen the reopen's own GATE_REJECTED row (Reopen: jump
// or redo) came after that message and spent it. Now a message whose only
// decision since is the reopen it asked for still answers that question with
// Request Changes. An approval still needs a reply after the question, and a
// message any other decision followed is still spent.
//
// Mechanism: cli, the real human-turn hook, `next` (the plan question and the
// `--stage` reopen print), `aidlc-jump.ts reopen` exactly as printed, and
// `log answer`, over a built, reviewed Unit (t402's fixture); plus
// proveMessage over a redo's reopen row.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
import { proveMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

// The stage's checks run once before its review or gate, and again at the gate
// (completionChecksStep, t-checks-before-review); this file's fixture documents
// are not written for them and its subject is not them, so they stay off here.
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
const CHAT = "01995000-7a11-7000-8000-00000000b155";
const DASH = "\u2014"; // the state file's stage-line separator
const REDO = "Redo Code Generation for alpha, please. Trim spaces around the name, so the greeting for '  Ada  ' is Hello, Ada!";

type Directive = {
  kind?: string;
  ask_type?: string;
  message?: string;
  plan_approval?: { status?: string; feedback?: string };
};

// A solo walk one Unit at a time, Code Generation the only Construction step.
function fixture(checkpoints: "enabled" | "disabled", policy: "strict" | "off"): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  const skipped = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"];
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Redo a built Unit with a change
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: classic
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Checkpoints**: ${checkpoints}
- **Construction Execution**: serial
- **Construction Autonomy Mode**: gated
- **Guard Policy**: ${policy} (set by you)
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

function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_UNATTENDED: "0", AIDLC_SESSION_OVERRIDE: CHAT };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  return env;
}

function tool(p: string, name: string, args: string[]) {
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8",
    env: { ...agentEnv(), AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p },
  });
  const last = (result.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "";
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(last); } catch { json = null; }
  return { status: result.status, json, out: `${result.stdout}${result.stderr}` };
}

function says(p: string, prompt: string, session = CHAT): void {
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: p,
    env: { ...agentEnv(), AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p },
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
  const session = "unit-redo-command";
  const identity = ["--stage", CG, "--checkpoint", "verification-command", "--command", command, "--session", session];
  expect(tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"]).status).toBe(0);
  says(p, "Approve", session);
  for (const args of [["log", "answer", ...identity, "--details", "Approve"], ["state", "set-construction-verification-command", command]]) {
    const recorded = tool(p, args[0], args.slice(1));
    expect(recorded.status, recorded.out).toBe(0);
  }
}

function next(p: string, args: string[] = []): Directive {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, args, { env: agentEnv() });
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as Directive;
}

const stageDir = (p: string): string => join(seededRecordDir(p), "construction", UNIT, CG);

function writePlan(p: string, extra = ""): void {
  mkdirSync(stageDir(p), { recursive: true });
  writeFileSync(join(stageDir(p), "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: alpha\n- Touches: src/alpha.ts\n" +
      `- Tests: 1 unit test\n\n## Steps\n\n- [ ] Step 1: write alpha\n${extra}\n` + renderTestingContract(resolveTestingPosture(p)),
    "utf-8");
  writeFileSync(join(stageDir(p), "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test src/alpha.test.ts`.\n", "utf-8");
}

const answer = (p: string, choice: string, extra: string[] = []) =>
  tool(p, "log", ["answer", "--stage", CG, "--checkpoint", "plan-approval", "--details", choice, ...extra]);

// The plan approved, the Unit built and reviewed READY.
function built(p: string): void {
  writePlan(p);
  const ask = next(p);
  expect(ask.ask_type, JSON.stringify(ask).slice(0, 600)).toBe("plan-approval");
  says(p, "1");
  expect(answer(p, "Approve Plan").status).toBe(0);
  expect(next(p).plan_approval).toEqual({ status: "approved" });
  const stage = findStageBySlug(CG)!;
  for (const name of stage.produces ?? []) {
    const file = artifactFilename(name);
    if (file === "code-generation-plan.md" || file === "unit-test-instructions.md") continue;
    writeFileSync(join(stageDir(p), file), `# ${UNIT} ${name}\n`);
  }
  writeFileSync(join(stageDir(p), "source-manifest.json"), JSON.stringify({
    stage: CG, unit: UNIT, version: 1, writes: [{ path: `src/${UNIT}.ts` }],
  }));
  appendAuditEntry("UNIT_COMPLETED", {
    Stage: CG, Unit: UNIT, Mode: "wave",
    "Run floor": latestMainWorkflowStageRunFloorForProject(p, CG, true, UNIT),
    "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, UNIT, { requireRequiredArtifacts: true })!,
  }, p);
  const args = ["review", "--stage", CG, "--reviewer", REVIEWER, "--unit", UNIT, "--iteration", "1"];
  const requested = tool(p, "log", args);
  expect(requested.status, requested.out).toBe(0);
  const file = String(requested.json?.reviewFile);
  mkdirSync(dirname(join(p, file)), { recursive: true });
  writeFileSync(join(p, file), `**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`);
  expect(tool(p, "log", [...args, "--verdict", "READY"]).status).toBe(0);
}

// The person's redo with its change, carried out as `next --stage` prints it,
// up to the plan question it brings up.
function redoneToPlanQuestion(p: string): void {
  says(p, REDO);
  // Records keep whole seconds, and a decision in the message's own second leaves it unspent: the reopen comes later.
  Bun.sleepSync(1100);
  const printed = next(p, ["--stage", CG, "--unit", UNIT]);
  const command = /reopen --target \S+ --stages \S+ --units \S+ --scope \S+/.exec(printed.message ?? "")?.[0];
  expect(command, printed.message).toBeDefined();
  const reopened = tool(p, "jump", command!.split(" "));
  expect(reopened.status, reopened.out).toBe(0);
  const asked = next(p);
  expect(asked.ask_type, JSON.stringify(asked).slice(0, 600)).toBe("plan-approval");
}

describe("the change asked for with a Unit's redo answers its code plan question", () => {
  for (const [checkpoints, policy] of [["disabled", "strict"], ["disabled", "off"], ["enabled", "strict"]] as const) {
    test(`checkpoints ${checkpoints}, Guard Policy ${policy}: Request Changes is recorded and the plan goes back with it`, () => {
      const p = fixture(checkpoints, policy);
      built(p);
      redoneToPlanQuestion(p);
      const recorded = answer(p, "Request Changes", ["--reason", "Trim spaces around the name"]);
      expect(recorded.status, recorded.out).toBe(0);
      expect(recorded.json?.recorded, recorded.out).toBe("request-changes");
      const revise = next(p);
      expect(revise.plan_approval?.status, JSON.stringify(revise).slice(0, 600)).toBe("revise");
      expect(revise.plan_approval?.feedback ?? "").toContain("Trim spaces around the name");
      const row = readAuditShardEvents(p).filter((entry) => entry.event === "QUESTION_ANSWERED" &&
        auditBlockField(entry.block, "Checkpoint") === "plan-approval").at(-1);
      expect(row?.block ?? "").toContain("Trim spaces around the name, so the greeting for");
    });
  }

  test("an approval still needs a reply after the question", () => {
    const p = fixture("disabled", "strict");
    built(p);
    redoneToPlanQuestion(p);
    const refused = answer(p, "Approve Plan");
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("has not replied to the plan question since it was shown");
  });

  // A change asked for at a late question reopens the Unit for exactly that
  // change (Reopen: change), already the person's Request Changes on record:
  // the revised plan's question needs a reply of its own.
  test("after a change reopen the revised plan's question needs its own reply", () => {
    const p = fixture("disabled", "strict");
    built(p);
    says(p, "Request changes: in alpha's code generation, trim spaces around the name");
    // As in redoneToPlanQuestion: the reopen comes in a later second than the message.
    Bun.sleepSync(1100);
    const reopened = tool(p, "jump", ["reopen", "--target", CG, "--stages", CG, "--units", UNIT, "--scope", "classic", "--via", "change"]);
    expect(reopened.status, reopened.out).toBe(0);
    const revise = next(p);
    expect(revise.plan_approval?.status, JSON.stringify(revise).slice(0, 600)).toBe("revise");
    writePlan(p, "- [ ] Step 2: trim spaces around the name\n");
    const asked = next(p);
    expect(asked.ask_type, JSON.stringify(asked).slice(0, 600)).toBe("plan-approval");
    const refused = answer(p, "Request Changes", ["--reason", "Trim spaces around the name"]);
    expect(refused.status, refused.out).not.toBe(0);
    expect(refused.out).toContain("has not replied to the plan question since it was shown");
  });

  test("a message another decision followed is still spent", () => {
    const p = fixture("disabled", "strict");
    built(p);
    redoneToPlanQuestion(p);
    appendAuditEntry("GATE_APPROVED", { Stage: "build-and-test", "User Input": "Approve" }, p);
    const refused = answer(p, "Request Changes", ["--reason", "Trim spaces around the name"]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("has not replied to the plan question since it was shown");
  });
});

describe("proveMessage: a message whose only decision since is its own reopen", () => {
  test("Reopen: change spends the message, as a gate's Request Changes does", () => {
    const p = fixture("disabled", "strict");
    says(p, REDO);
    const id = auditBlockField(readAuditShardEvents(p).filter((row) => row.event === "HUMAN_TURN").at(-1)!.block, "Message Id")!;
    Bun.sleepSync(1100);
    appendAuditEntry("GATE_REJECTED", {
      Stage: CG, "Gate Stages": CG, "Gate Scope": "unit-end", Unit: UNIT, Reopen: "change",
      "User Input": "Request Changes", Feedback: REDO,
    }, p);
    expect("refusal" in proveMessage(p, id, "answer", { reopened: true })).toBe(true);
  });

  for (const via of ["jump", "redo"] as const) {
    test(`Reopen: ${via} leaves the message standing for the reopened form only`, () => {
      const p = fixture("disabled", "strict");
      says(p, REDO);
      const id = auditBlockField(readAuditShardEvents(p).filter((row) => row.event === "HUMAN_TURN").at(-1)!.block, "Message Id")!;
      expect(id).toMatch(/^[0-9a-f]{8}$/);
      // Records keep whole seconds, and a decision in the message's own second leaves it unspent: the reopen comes later.
      Bun.sleepSync(1100);
      appendAuditEntry("GATE_REJECTED", {
        Stage: CG, "Gate Stages": CG, "Gate Scope": "unit-end", Unit: UNIT, Reopen: via,
        Feedback: `Reopened Code Generation for unit ${UNIT}.`,
      }, p);
      expect("refusal" in proveMessage(p, id, "answer")).toBe(true);
      expect("message" in proveMessage(p, id, "answer", { reopened: true })).toBe(true);
      appendAuditEntry("GATE_APPROVED", { Stage: "build-and-test", "User Input": "Approve" }, p);
      expect("refusal" in proveMessage(p, id, "answer", { reopened: true })).toBe(true);
    });
  }
});
