// covers: hook:aidlc-plan-approval-guard, hook:system-install, function:systemInstalls, function:unaskedSystemInstall,
// audit:SYSTEM_INSTALL_BLOCKED, audit:SYSTEM_INSTALL_ALLOWED, audit:SYSTEM_INSTALL_REQUESTED
//
// An agent at Build and Test (or a developer at Code Generation) finds the
// project's test library missing and runs `sudo apt-get install` on its own: a
// system package installed for the whole machine, outside the project, that
// nobody asked for. The guard holds that one command and its only step is to
// tell the person the command; the person's go-ahead lets it through and the
// row it leaves names their message. What the person asks for themselves, and
// an install a plan they approved names (read as approved: not as edited since,
// not from a reviewer's appendix, not pieced together from two plans), run at
// once. It is not a fence: Guard Policy off and plan approval off hold it too,
// and a plan nobody approved names nothing. An isolated run with no work is held
// the same way, and so is finished work, completed or archived: the person's
// message kept since it finished is their go-ahead there. An install asked for
// in the message that approved runs once the agent names that message (`log
// install`), without asking the person again.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { namedByOnePlan, systemInstalls } from "../../dist/claude/.claude/hooks/system-install.ts";
import { saveMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import {
  auditBlockField,
  getField,
  memoryGuardPolicyDeclarations,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  answer,
  createCodeGenerationProject,
  finishedAtCodeGeneration,
  next,
  openCodeGenerationGate,
  reply,
  runNamed,
  SESSION,
  stageDir,
  UNJOINED_SESSION,
  writePlan,
} from "../harness/code-generation-states.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  DEFAULT_RECORD_DIR,
  removeWorkspaceRecord,
  seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(120_000);

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const PYTEST = "sudo -n apt-get install -y python3-pytest";
const HYPOTHESIS = "sudo apt-get install -y python3-hypothesis";
// A chat the person opens later on the same work, and one more beside it.
const LATER = "01995000-7a11-7000-8000-00000000d00d";
const BESIDE = "01995000-7a11-7000-8000-00000000d0de";

function guardBash(
  proj: string,
  command: string,
  extra: { session?: string; shell?: "powershell" } = {},
): { code: number; stderr: string } {
  const result = spawnSync(process.execPath, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: extra.session ?? SESSION, cwd: proj, tool_name: "Bash",
      tool_input: { command }, ...(extra.shell ? { aidlc_shell: extra.shell } : {}),
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

// Read from the work's record by name: archiving it drops the cursor that selects it.
const rows = (proj: string, event: string) =>
  readAuditShardEvents(proj, DEFAULT_RECORD_DIR).filter((row) => row.event === event);

// Code Generation with the plan approved ("1" at the plan question) and the build under way.
function building(planExtra = "", policy: "strict" | "relaxed" | "off" = "relaxed"): string {
  const proj = createCodeGenerationProject(policy);
  created.push(proj);
  writePlan(proj, planExtra);
  expect(next(proj).ask_type).toBe("plan-approval");
  expect(reply(proj, "1").status).toBe(0);
  const recorded = answer(proj, "Approve Plan");
  expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
  expect(next(proj).kind).toBe("run-stage");
  return proj;
}

// Build and Test after the person approved Code Generation's gate with "1".
function buildAndTest(): string {
  const proj = building();
  expect(reply(proj, "1").status).toBe(0);
  appendAuditEntry("GATE_APPROVED", { Stage: "code-generation", "User Input": "1" }, proj);
  const state = seededStateFile(proj);
  writeFileSync(
    state,
    readFileSync(state, "utf-8").replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: build-and-test"),
    "utf-8",
  );
  return proj;
}

describe("a system package install nobody asked for", () => {
  test("at Build and Test it is held with the command for the person, and their go-ahead runs it on the record", () => {
    const proj = buildAndTest();
    const held = guardBash(proj, PYTEST);
    expect(held.code, held.stderr).toBe(2);
    expect(held.stderr).toContain(`\`${PYTEST}\``);
    expect(held.stderr).toContain("Tell the person");
    expect(held.stderr.trim().split("\n")).toHaveLength(1);
    expect(rows(proj, "SYSTEM_INSTALL_BLOCKED")).toHaveLength(1);
    // A command that only looks, and the test run itself, are not installs.
    expect(guardBash(proj, "apt-cache policy python3-pytest").code).toBe(0);
    expect(guardBash(proj, "python3 -m pytest -q").code).toBe(0);

    expect(reply(proj, "yes, go ahead and install it").status).toBe(0);
    const ran = guardBash(proj, PYTEST);
    expect(ran.code, ran.stderr).toBe(0);
    const allowed = rows(proj, "SYSTEM_INSTALL_ALLOWED");
    expect(allowed).toHaveLength(1);
    expect(auditBlockField(allowed[0].block, "Command")).toBe(PYTEST);
    const turn = rows(proj, "HUMAN_TURN").at(-1);
    expect(auditBlockField(allowed[0].block, "Message Id")).toBe(auditBlockField(turn?.block ?? "", "Message Id"));
    expect(auditBlockField(allowed[0].block, "Person Reply")).toBe("yes, go ahead and install it");
  });

  // The go-ahead the agent asks for is a question on the record with its own id
  // (the question record): the person's reply carries it, their go-ahead closes it.
  test("the go-ahead it asks for is on the record with its id, and the go-ahead closes it", () => {
    const proj = buildAndTest();
    expect(guardBash(proj, PYTEST).code).toBe(2);
    const [asked] = rows(proj, "QUESTION_ASKED").filter((row) => auditBlockField(row.block, "Question Type") === "system-install");
    const id = auditBlockField(asked?.block ?? "", "Question Id");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(auditBlockField(asked.block, "Question Chat")).toBe(SESSION);
    expect(auditBlockField(asked.block, "Stage")).toBe("build-and-test");
    const open = () => (auditBlockField(rows(proj, "HUMAN_TURN").at(-1)?.block ?? "", "Open Questions") ?? "").split(", ");
    expect(reply(proj, "yes, go ahead and install it").status).toBe(0);
    expect(open()).toContain(id ?? "none");
    expect(guardBash(proj, PYTEST).code).toBe(0);
    expect(reply(proj, "thanks").status).toBe(0);
    expect(open()).not.toContain(id ?? "none");
  });

  test("at Code Generation the developer's install is held after the plan's approval", () => {
    const proj = building();
    const held = guardBash(proj, HYPOTHESIS);
    expect(held.code, held.stderr).toBe(2);
    expect(held.stderr).toContain(`\`${HYPOTHESIS}\``);
  });

  test("an install the person asks for runs at once", () => {
    const proj = buildAndTest();
    expect(reply(proj, "pytest is missing, install it with apt").status).toBe(0);
    const ran = guardBash(proj, PYTEST);
    expect(ran.code, ran.stderr).toBe(0);
    expect(rows(proj, "SYSTEM_INSTALL_BLOCKED")).toHaveLength(0);
    expect(rows(proj, "SYSTEM_INSTALL_ALLOWED")).toHaveLength(1);
  });

  test("an install the approved plan names runs at once, its steps ticked or not", () => {
    const proj = building(`- [ ] Step 2: install the test library with \`${HYPOTHESIS}\`\n`);
    const ran = guardBash(proj, HYPOTHESIS);
    expect(ran.code, ran.stderr).toBe(0);
    const plan = join(stageDir(proj), "code-generation-plan.md");
    writeFileSync(plan, readFileSync(plan, "utf-8").replaceAll("- [ ] Step", "- [x] Step"), "utf-8");
    expect(guardBash(proj, HYPOTHESIS).code).toBe(0);
    expect(rows(proj, "SYSTEM_INSTALL_BLOCKED")).toHaveLength(0);
  });

  test("a plan line added after the approval names nothing", () => {
    const proj = building();
    const plan = join(stageDir(proj), "code-generation-plan.md");
    writeFileSync(
      plan,
      readFileSync(plan, "utf-8").replace("- [ ] Step 1: write slugify\n", `- [ ] Step 1: write slugify\n- [ ] Step 2: \`${HYPOTHESIS}\`\n`),
      "utf-8",
    );
    const held = guardBash(proj, HYPOTHESIS);
    expect(held.code, held.stderr).toBe(2);
    expect(held.stderr).toContain("Tell the person");
  });

  // poc and express ship with plan approval off: the plan the agent wrote is
  // built without anyone seeing it, so its install line is the agent's own.
  test("Guard Policy off and plan approval off hold it too, and a plan nobody approved names nothing", () => {
    const proj = createCodeGenerationProject("off", "off");
    created.push(proj);
    writePlan(proj, `- [ ] Step 2: install the test library with \`${HYPOTHESIS}\`\n`);
    expect(next(proj).kind).toBe("run-stage");
    expect(rows(proj, "PLAN_APPROVAL_SKIPPED")).toHaveLength(1);
    const held = guardBash(proj, HYPOTHESIS);
    expect(held.code, held.stderr).toBe(2);
    expect(guardBash(proj, PYTEST).code).toBe(2);
    expect(reply(proj, "ok, install both").status).toBe(0);
    expect(guardBash(proj, HYPOTHESIS).code).toBe(0);
    expect(guardBash(proj, PYTEST).code).toBe(0);
  });

  test("a review appendix added to the approved plan names nothing", () => {
    const proj = building();
    const plan = join(stageDir(proj), "code-generation-plan.md");
    writeFileSync(plan, `${readFileSync(plan, "utf-8").trimEnd()}\n\n## Review\n\nRun \`${HYPOTHESIS}\` before the tests.\n`, "utf-8");
    const held = guardBash(proj, HYPOTHESIS);
    expect(held.code, held.stderr).toBe(2);
  });

  test("an isolated run with no work is held the same way, and the go-ahead lets it through", () => {
    const proj = createOrchestrationTestProject();
    created.push(proj);
    removeWorkspaceRecord(proj);
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
    const single = ["--stage", "code-generation", "--single", "--scope", "enterprise"];
    expect(reply(proj, "/aidlc --stage code-generation --single").status).toBe(0);
    expect(next(proj, single).plan_approval?.status).toBe("plan");
    const dir = join(proj, "aidlc", "spaces", "default", "intents", "construction", "code-generation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "code-generation-plan.md"),
      "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
        "- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n" + renderTestingContract(resolveTestingPosture(proj)),
      "utf-8",
    );
    writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n", "utf-8");
    expect(next(proj, single).ask_type).toBe("plan-approval");
    expect(reply(proj, "approve").status).toBe(0);
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    const held = guardBash(proj, HYPOTHESIS);
    expect(held.code, held.stderr).toBe(2);
    expect(reply(proj, "yes, install it").status).toBe(0);
    expect(guardBash(proj, HYPOTHESIS).code).toBe(0);
  });

  test("the go-ahead counts in the chat the person gives it in, a later one included", () => {
    const proj = buildAndTest();
    expect(guardBash(proj, PYTEST).code).toBe(2);
    expect(reply(proj, "yes, install it", LATER).status).toBe(0);
    const ran = guardBash(proj, PYTEST, { session: LATER });
    expect(ran.code, ran.stderr).toBe(0);
    expect(auditBlockField(rows(proj, "SYSTEM_INSTALL_ALLOWED")[0]?.block ?? "", "Session")).toBe(LATER);
  });

  test("a command run in PowerShell is read the same, and a long one is quoted on one line", () => {
    const proj = buildAndTest();
    const winget = guardBash(proj, "winget install --id Python.Python.3.12 -e", { shell: "powershell" });
    expect(winget.code, winget.stderr).toBe(2);
    expect(winget.stderr).toContain("`winget install --id Python.Python.3.12 -e`");
    const many = Array.from({ length: 30 }, (_, index) => `python3-extra-${index}`).join(" ");
    const long = guardBash(proj, `sudo apt-get install -y \\\n  ${many}`);
    expect(long.code, long.stderr).toBe(2);
    expect(long.stderr.trim().split("\n")).toHaveLength(1);
    expect(long.stderr).toContain("...`");
  });
});

// On finished work the agent's own install waits as at every stage. The
// human-turn hook keeps the person's messages beside a finished record and
// writes no turn on it; their message kept since the finish is their go-ahead
// (standingPersonTurn), in the chat they gave it in. "locked": a team that
// holds Guard Policy strict in memory, over relaxed work.
type Policy = "strict" | "relaxed" | "off" | "locked";

function lockStrict(proj: string): void {
  const dir = join(proj, "aidlc", "spaces", "default", "memory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "project.md");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "# Project\n";
  writeFileSync(
    path,
    existing.includes("## Guard Policy\n")
      ? existing.replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n")
      : `${existing.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`,
    "utf-8",
  );
  expect(memoryGuardPolicyDeclarations(proj).map((declaration) => declaration.value)).toContain("strict");
}

function finished(policy: Policy, planExtra = ""): string {
  const proj = finishedAtCodeGeneration(policy === "locked" ? "relaxed" : policy, "on", planExtra);
  created.push(proj);
  if (policy === "locked") lockStrict(proj);
  return proj;
}

function midway(policy: Policy): string {
  const proj = building("", policy === "locked" ? "relaxed" : policy);
  if (policy === "locked") lockStrict(proj);
  return proj;
}

// A chat the person opens on the work joins it with its first `next`.
function joinChat(proj: string, chat: string): void {
  const first = runNamed(proj, "bun .claude/tools/aidlc-orchestrate.ts next", { AIDLC_SESSION_OVERRIDE: chat });
  expect(first.status, first.stdout + first.stderr).toBe(0);
}

// Archived from the first chat; a chat still on the work stays on it.
function archive(proj: string): void {
  const archived = runNamed(proj, `bun .claude/tools/aidlc.ts engine intent archive ${DEFAULT_RECORD_DIR}`, {
    AIDLC_SESSION_OVERRIDE: SESSION,
  });
  expect(archived.status, archived.stdout + archived.stderr).toBe(0);
  expect(getField(readFileSync(seededStateFile(proj), "utf-8"), "Status")).toBe("Archived");
}

function heldForThePerson(proj: string, session = SESSION): { stderr: string } {
  const held = guardBash(proj, PYTEST, { session });
  expect(held.code, held.stderr).toBe(2);
  expect(held.stderr).toContain(`\`${PYTEST}\``);
  expect(held.stderr).toContain("Tell the person");
  expect(held.stderr.trim().split("\n")).toHaveLength(1);
  return held;
}

describe.each(["strict", "relaxed", "off", "locked"] as const)("Guard Policy %s, finished work", (policy) => {
  test("the agent's own install waits; the person's go-ahead runs it on the record, and the hold does not come back", () => {
    const proj = finished(policy);
    heldForThePerson(proj);
    expect(rows(proj, "SYSTEM_INSTALL_BLOCKED")).toHaveLength(1);
    const said = reply(proj, "yes, go ahead and install it");
    expect(said.status).toBe(0);
    const id = /on record as ([0-9a-f]{8})/.exec(said.stdout)?.[1];
    expect(id, said.stdout).toBeDefined();
    for (let again = 0; again < 2; again++) {
      const ran = guardBash(proj, PYTEST);
      expect(ran.code, ran.stderr).toBe(0);
    }
    const [allowed] = rows(proj, "SYSTEM_INSTALL_ALLOWED");
    expect(auditBlockField(allowed?.block ?? "", "Message Id")).toBe(id ?? "none");
    expect(auditBlockField(allowed?.block ?? "", "Person Reply")).toBe("yes, go ahead and install it");
    expect(rows(proj, "SYSTEM_INSTALL_BLOCKED")).toHaveLength(1);
    expect(next(proj).kind).toBe("done");
  });

  test("in a later chat the person's own ask runs it at once; it counts in that chat only", () => {
    const proj = finished(policy);
    joinChat(proj, LATER);
    joinChat(proj, BESIDE);
    expect(reply(proj, "pytest is missing, install it with apt", LATER).status).toBe(0);
    const ran = guardBash(proj, PYTEST, { session: LATER });
    expect(ran.code, ran.stderr).toBe(0);
    expect(rows(proj, "SYSTEM_INSTALL_BLOCKED")).toHaveLength(0);
    expect(auditBlockField(rows(proj, "SYSTEM_INSTALL_ALLOWED")[0]?.block ?? "", "Session")).toBe(LATER);
    heldForThePerson(proj, BESIDE);
  });

  // Work archived before it finished has no completion: its archive is where
  // the person's kept messages start to count (keptSinceFinished).
  test("archived, after it finished or before, the install waits in a chat still on it and the go-ahead runs it", () => {
    const done = finished(policy);
    const unfinished = midway(policy);
    for (const proj of [done, unfinished]) {
      joinChat(proj, LATER);
      archive(proj);
      heldForThePerson(proj, LATER);
      expect(reply(proj, "yes, install it", LATER).status).toBe(0);
      const ran = guardBash(proj, PYTEST, { session: LATER });
      expect(ran.code, ran.stderr).toBe(0);
      expect(auditBlockField(rows(proj, "SYSTEM_INSTALL_ALLOWED")[0]?.block ?? "", "Person Reply")).toBe("yes, install it");
    }
  });

  // An archive of work that was running, a redo included, is its finish: the
  // redo they asked for before it asks for no install. An archive of finished
  // work spends nothing: their ask between the completion and the archive still
  // runs the install (keptSinceFinished).
  test("archived during a redo, the redo's ask runs no install; archived after a finish, an ask before it still does", () => {
    const redone = finished(policy);
    joinChat(redone, LATER);
    expect(reply(redone, "Can you redo Code Generation? I'd like the code built again.", LATER).status).toBe(0);
    const step = String(next(redone, ["--stage", "code-generation"]).message ?? "");
    const jump = /`(bun \.claude\/tools\/aidlc-jump\.ts execute [^`]+)`/.exec(step)?.[1];
    expect(jump, step).toBeDefined();
    const ran = runNamed(redone, jump as string, { AIDLC_SESSION_OVERRIDE: LATER });
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    expect(getField(readFileSync(seededStateFile(redone), "utf-8"), "Status")).toBe("Running");
    // The record keeps whole seconds, and a redo runs a while before anyone archives it.
    Bun.sleepSync(1001 - (Date.now() % 1000));
    archive(redone);
    heldForThePerson(redone, LATER);
    expect(reply(redone, "yes, install it", LATER).status).toBe(0);
    expect(guardBash(redone, PYTEST, { session: LATER }).code).toBe(0);
    expect(auditBlockField(rows(redone, "SYSTEM_INSTALL_ALLOWED")[0]?.block ?? "", "Person Reply")).toBe("yes, install it");

    const done = finished(policy);
    joinChat(done, LATER);
    expect(reply(done, "pytest is missing, install it with apt", LATER).status).toBe(0);
    archive(done);
    const asked = guardBash(done, PYTEST, { session: LATER });
    expect(asked.code, asked.stderr).toBe(0);
    expect(rows(done, "SYSTEM_INSTALL_BLOCKED")).toHaveLength(0);
  });
});

test("on finished work an install the approved plan names runs at once, and one it does not name waits", () => {
  const proj = finished("strict", `- [ ] Step 2: install the test library with \`${HYPOTHESIS}\`\n`);
  const ran = guardBash(proj, HYPOTHESIS);
  expect(ran.code, ran.stderr).toBe(0);
  expect(rows(proj, "SYSTEM_INSTALL_BLOCKED")).toHaveLength(0);
  heldForThePerson(proj);
});

// One message both approves and asks for the install ("Approve. Then install
// ..."): the approval uses it up, so the install is held once, and its line names
// the person's messages and the step. The agent names the one that asked for the
// packages (`log install`); the engine proves it is theirs on this work and
// reads none of its words, and the install runs with their words on its row,
// without asking them again, until their next decision. A bare "Approve" asked
// for nothing: nobody names it, and the agent's own install stays held.
const APPROVE_AND_INSTALL = "Approve. Then install python3-pytest with apt and run the tests.";

// The Code Generation gate approved in the person's words; `last`: the work's
// last stage, so the approval finishes it.
function approvedWith(policy: Policy, words: string, last: boolean): { proj: string; id: string } {
  const proj = openCodeGenerationGate(policy === "locked" ? "relaxed" : policy, "on", last);
  created.push(proj);
  if (policy === "locked") lockStrict(proj);
  const said = reply(proj, words);
  const id = /on record as ([0-9a-f]{8})/.exec(said.stdout)?.[1];
  expect(id, said.stdout).toBeDefined();
  // The agent records the approval a moment after the message, as a run does:
  // a decision in the message's own second is not one after it (messageReach).
  Bun.sleepSync(1100);
  const approved = runNamed(
    proj,
    'bun .claude/tools/aidlc.ts engine orchestrate report --stage code-generation --result approved --user-input "Approve"',
    { AIDLC_SESSION_OVERRIDE: SESSION },
  );
  expect(approved.status, approved.stdout + approved.stderr).toBe(0);
  expect(getField(readFileSync(seededStateFile(proj), "utf-8"), "Status")).toBe(last ? "Completed" : "Running");
  return { proj, id: id as string };
}

const logInstall = (proj: string, args: string) =>
  runNamed(proj, `bun .claude/tools/aidlc.ts engine log install ${args}`, { AIDLC_SESSION_OVERRIDE: SESSION });

function heldNaming(proj: string, id: string): void {
  const held = heldForThePerson(proj);
  expect(held.stderr).toContain(`If their message ${id} (sent `);
  expect(held.stderr).toContain(
    "engine log install python3-pytest` with --message <id>, then run the install again. Otherwise: Tell the person",
  );
}

describe.each(["strict", "relaxed", "off", "locked"] as const)("Guard Policy %s, an install asked for in the approval", (policy) => {
  test("at a gate and at the approval that finishes the work, it runs on the message the agent names, asked once", () => {
    for (const last of [false, true]) {
      const { proj, id } = approvedWith(policy, APPROVE_AND_INSTALL, last);
      heldNaming(proj, id);
      const named = logInstall(proj, `python3-pytest --message ${id}`);
      expect(named.status, named.stdout + named.stderr).toBe(0);
      for (let again = 0; again < 2; again++) {
        const ran = guardBash(proj, PYTEST);
        expect(ran.code, ran.stderr).toBe(0);
      }
      const [requested] = rows(proj, "SYSTEM_INSTALL_REQUESTED");
      expect(auditBlockField(requested?.block ?? "", "Packages")).toBe('["python3-pytest"]');
      expect(auditBlockField(requested?.block ?? "", "Message Id")).toBe(id);
      const allowed = rows(proj, "SYSTEM_INSTALL_ALLOWED");
      expect(allowed.map((row) => auditBlockField(row.block, "Message Id"))).toEqual([id, id]);
      expect(auditBlockField(allowed[0].block, "Person Reply")).toBe(APPROVE_AND_INSTALL);
      expect(rows(proj, "SYSTEM_INSTALL_BLOCKED")).toHaveLength(1);
      // It names the packages it was named for, no other.
      const other = guardBash(proj, HYPOTHESIS);
      expect(other.code, other.stderr).toBe(2);
    }
  });

  test("a bare Approve names nothing: the agent's own install stays held, its line naming the message and the step", () => {
    for (const last of [false, true]) {
      const { proj, id } = approvedWith(policy, "Approve", last);
      heldNaming(proj, id);
      heldNaming(proj, id);
      expect(rows(proj, "SYSTEM_INSTALL_REQUESTED")).toHaveLength(0);
      expect(rows(proj, "SYSTEM_INSTALL_ALLOWED")).toHaveLength(0);
    }
  });
});

test("log install records nothing for a message that is not the person's on this work, or with no message or package", () => {
  const { proj, id } = approvedWith("strict", APPROVE_AND_INSTALL, false);
  const madeUp = logInstall(proj, "python3-pytest --message 0badf00d");
  expect(madeUp.status).not.toBe(0);
  expect(madeUp.stdout + madeUp.stderr).toContain("no message record 0badf00d exists in this project");
  // Kept from a chat that was never on this work, as the prompt hook keeps one there.
  const elsewhere = saveMessage(proj, {
    session: UNJOINED_SESSION, at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), source: "prompt",
    text: "install python3-pytest", picker: null, words: "install python3-pytest", settings: [],
    route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
  }).id;
  const offWork = logInstall(proj, `python3-pytest --message ${elsewhere}`);
  expect(offWork.status).not.toBe(0);
  expect(offWork.stdout + offWork.stderr).toContain(`message ${elsewhere} was not sent on this piece of work`);
  for (const args of [`--message ${id}`, "python3-pytest"]) {
    const usage = logInstall(proj, args);
    expect(usage.status).not.toBe(0);
    expect(usage.stdout + usage.stderr).toContain("log install <package>... --message <id>");
  }
  expect(rows(proj, "SYSTEM_INSTALL_REQUESTED")).toHaveLength(0);
  heldForThePerson(proj);
});

test("the next decision of theirs ends it: after a later approval the same install waits again", () => {
  const { proj, id } = approvedWith("strict", APPROVE_AND_INSTALL, false);
  expect(logInstall(proj, `python3-pytest --message ${id}`).status).toBe(0);
  expect(guardBash(proj, PYTEST).code).toBe(0);
  expect(reply(proj, "Approve").status).toBe(0);
  appendAuditEntry("GATE_APPROVED", { Stage: "build-and-test", "User Input": "Approve" }, proj);
  heldForThePerson(proj);
});

describe("which plan names an install", () => {
  const [install] = systemInstalls(HYPOTHESIS);
  test("one plan naming the package manager and every package names it; two plans pieced together do not", () => {
    expect(namedByOnePlan([new Set(["apt-get", "python3-hypothesis"])], install)).toBe(true);
    expect(namedByOnePlan([new Set(["apt"]), new Set(["python3-hypothesis"])], install)).toBe(false);
    expect(namedByOnePlan([new Set(["python3-hypothesis"])], install)).toBe(false);
  });
});

describe("which shell lines install a system package", () => {
  test.each([
    ["sudo -n apt-get install -y python3-pytest", ["python3-pytest"]],
    ["apt-get -y install python3-pytest", ["python3-pytest"]],
    ["apt -qq install python3-pytest", ["python3-pytest"]],
    ["sudo apt-get -t stable install python3-pytest", ["python3-pytest"]],
    ["DEBIAN_FRONTEND=noninteractive sudo -E apt-get install -y libpq-dev", ["libpq-dev"]],
    ["sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y libpq-dev", ["libpq-dev"]],
    ["sudo apt-get update && sudo apt-get install -y python3-pytest", ["python3-pytest"]],
    ["sudo apt-get install -y python3-pytest 2>&1 | tail -5", ["python3-pytest"]],
    ["sudo dnf -y install python3-pytest", ["python3-pytest"]],
    ["sudo rpm -ivh ./tool.rpm", ["./tool.rpm"]],
    ["sudo pacman -Syu --noconfirm python-pytest", ["python-pytest"]],
    ["apk add --no-cache git", ["git"]],
    ["brew install jq", ["jq"]],
    ["choco install python -y", ["python"]],
    ["scoop install git", ["git"]],
    ["sudo dpkg -i ./tool.deb", ["./tool.deb"]],
  ])("%s installs %p", (command, packages) => {
    expect(systemInstalls(command).map((install) => install.packages)).toEqual([packages]);
  });

  test.each([
    "apt-cache policy python3-pytest",
    "apt list --installed",
    "sudo apt-get update",
    "sudo apt-get install -f",
    "pacman -Ss pytest",
    "sudo pacman -Syu",
    "rpm -qi bash",
    "dpkg -l python3-pytest",
    "pip install pytest",
    "python3 -m pytest -q",
    "npm install",
  ])("%s installs nothing", (command) => {
    expect(systemInstalls(command)).toEqual([]);
  });
});
