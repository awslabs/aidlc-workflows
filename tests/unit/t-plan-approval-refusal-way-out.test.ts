// covers: function:codeGenerationIssuance, function:codeGenerationRulesArrivingReason
//
// Every refusal from the plan-approval guard names the step that ends it, in
// the spelling this install runs, under every Guard Policy. The journeys run
// the real `next`, the real human-turn hook, and the real guard over one
// workflow at Code Generation:
//
//   - the person approved the plan and the chat compacted mid-build, so the
//     build step the agent held went stale: under strict and relaxed every
//     write and every developer handoff is refused, and the refusal says the
//     plan is already approved and names the one command that gets the build
//     back, run on its own. That exact command passes the guard, a `cd` in
//     front of it does not, and running it hands over the approved build;
//   - under Guard Policy off the same set-aside build step goes on: the write,
//     the brief and the handoff pass with one recorded row and nothing said, and
//     the build reports complete without a `next`. A question set aside, a
//     missing step and a step a jump replaced still name `next`;
//   - the plan's Testing Contract went stale after approval: under off the
//     build goes on and one CHANGE_ACCEPTED row records it, even when the
//     ledger cannot take the row;
//   - the person approved and the agent writes before running `next`: the
//     refusal says they approved, not to show them the question again; a
//     malformed handoff then is not called unapproved; after Request Changes
//     it says they answered and `next` carries out their choice; while they
//     edit the files themselves, it leaves the files to them;
//   - plan approval off (the plan edited after it was built or not): the
//     refusal says no approval is needed, never that the person approved;
//   - a malformed handoff before the plan may be built names the plan steps
//     first, then the brief (the brief alone would refuse too);
//   - while the recovery question is open, `next` with a `cd` in front is
//     refused and named on its own;
//   - the plan was edited after approval: with Guard Policy relaxed the refusal
//     says an earlier version was approved and the build may go on; under
//     strict it claims no approval and `next` asks again;
//   - a developer handoff that names two targets: the refusal names both and
//     the exact `brief` command for the current step, which passes the guard,
//     runs as printed, and whose output is a handoff the guard lets through;
//   - no plan yet with Guard Policy off: the refusal names the plan files and
//     the command, as it does with the fence on;
//   - a native release names `aidlc engine orchestrate next`.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  runOrchestrateNext,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  AS_ITS_OWN_COMMAND,
  codeGenerationRulesArrivingReason,
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  auditBlockField,
  auditFilePath,
  hooksHealthDir,
  invalidateActiveDirectiveContext,
  readAuditShardEvents,
  refreshActiveDirectiveMarker,
  setField,
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const RELEASE_GUARD = join(REPO_ROOT, "dist-release", "claude", ".claude", "hooks", "aidlc-plan-approval-guard.ts");
const SESSION = "01995000-7a11-7000-8000-0000000000a1";
const SOURCE_NEXT = "bun .claude/tools/aidlc-orchestrate.ts next";
const ON_ITS_OWN = "exactly as written, as a command of its own (no `cd` before it, no pipe or second command after it)";
const ALREADY_APPROVED = "is already approved: do not ask the person to approve it again yourself";
const SOURCE_BRIEF = "bun .claude/tools/aidlc-testing-posture.ts brief --stage-level";

interface Emitted {
  kind: string;
  ask_type?: string;
  plan_approval?: { status?: string };
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

// A poc workflow at Code Generation with plan approval on, and the project's
// own copy of the harness, so a command a refusal names can be run as printed.
function project(
  policy: "strict" | "relaxed" | "off",
  planApproval: "on" | "off" | "scope" = "on",
  scope = "poc",
): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", `- **Scope**: ${scope}`)
    .replace(
      "- **Change Control**: strict (from scope feature)",
      `- **Guard Policy**: ${policy} (from scope ${scope})` +
        (planApproval === "scope" ? "" : `\n- **Plan Approval**: ${planApproval} (set by you)`),
    )
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  return withSource(proj);
}

// A feature workflow at Code Generation where the plan and build are per Unit.
function unitProject(unit: string, policy: "relaxed" | "off" = "off"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: Per-Unit build
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: off
- **Guard Policy**: ${policy} (set by you)

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Minimal

## Stage Progress

### CONSTRUCTION PHASE
- [x] functional-design \u2014 EXECUTE
- [x] nfr-requirements \u2014 EXECUTE
- [x] nfr-design \u2014 EXECUTE
- [x] infrastructure-design \u2014 EXECUTE
- [-] code-generation \u2014 EXECUTE
- [ ] build-and-test \u2014 EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`, "utf-8");
  seedBoltDag(proj, [unit]);
  return withSource(proj);
}

function withSource(proj: string): string {
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
  return proj;
}

function stageDir(proj: string, unit: string | null): string {
  return join(seededRecordDir(proj), "construction", ...(unit ? [unit] : []), "code-generation");
}

function writePlan(proj: string, unit: string | null = null): void {
  mkdirSync(stageDir(proj, unit), { recursive: true });
  writeFileSync(
    join(stageDir(proj, unit), "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      "- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n" +
      renderTestingContract(resolveTestingPosture(proj)),
    "utf-8",
  );
  writeFileSync(
    join(stageDir(proj, unit), "unit-test-instructions.md"),
    "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n",
    "utf-8",
  );
}

// `next` as the project's own tools run it (the spelling refusals name).
function next(proj: string): Emitted {
  const result = runOrchestrateNext(join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), proj, [], {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
  });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as unknown as Emitted;
}

function say(proj: string, prompt: string): string {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout ?? "";
}

function answer(proj: string, details: string): string {
  const recorded = spawnSync(BUN, [
    LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", details,
    "--project-dir", proj,
  ], {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(recorded.status, `${recorded.stdout}${recorded.stderr}`).toBe(0);
  return recorded.stdout ?? "";
}

// The person approves in their own words; the agent records the choice it read.
function reply(proj: string, prompt: string): void {
  say(proj, prompt);
  expect(answer(proj, "Approve Plan")).toContain('Recorded \\"Approve Plan\\"');
}

function guard(
  proj: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  hook = GUARD,
): { code: number; stderr: string } {
  const result = spawnSync(BUN, [hook], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: proj, tool_name: toolName, tool_input: toolInput }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

// The guard's stdout too: a stand-aside speaks there.
function guardOut(
  proj: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: proj, tool_name: toolName, tool_input: toolInput }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

const writeSource = (proj: string, hook = GUARD) =>
  guard(proj, "Write", { file_path: join(proj, "src", "slugify.ts"), content: "x\n" }, hook);
const shell = (proj: string, command: string) => guard(proj, "Bash", { command });
const handoff = (proj: string) =>
  guard(proj, "Task", {
    subagent_type: "aidlc-developer-agent",
    prompt: `AIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: ${resolveTestingPosture(proj).contract_sha256}\nBuild it.`,
  });

// The refusal's own words, whichever channel it used: prose with the fence on,
// the JSON error where a lowered fence still refuses.
function said(refusal: { code: number; stderr: string }): string {
  expect(refusal.code, refusal.stderr).toBe(2);
  const text = refusal.stderr.trim();
  return text.startsWith("{") ? (JSON.parse(text) as { error: string }).error : text;
}

function namedCommand(words: string): string {
  const command = /[Rr]un `([^`]+)` exactly as written, as a command of its own/.exec(words)?.[1];
  expect(command, words).toBeDefined();
  return command as string;
}

function namedBrief(words: string): string {
  const command = /output of `([^`]+ brief [^`]+)` first/.exec(words)?.[1];
  expect(command, words).toBeDefined();
  return command as string;
}

// Runs a command a refusal named, the way the conductor would, from the
// project's own copy of the tools.
function runInstalled(proj: string, command: string): string {
  expect(command).toMatch(/^bun \.claude\/tools\/[\w.-]+\.ts( [\w-]+)+$/);
  const [, ...args] = command.split(" ");
  const result = spawnSync(BUN, args, {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, `${command}\n${result.stderr}`).toBe(0);
  return result.stdout ?? "";
}

const twoTargetHandoff = (proj: string) =>
  guard(proj, "Task", {
    subagent_type: "aidlc-developer-agent",
    prompt: "AIDLC-UNIT: backend-lookup\nAIDLC-STAGE: code-generation\n" +
      `AIDLC-TESTING-CONTRACT: ${resolveTestingPosture(proj).contract_sha256}\nBuild it.`,
  });

// After approval the build step was delivered, then the chat compacted: the
// step the agent held is set aside until it runs `next` again. `meanwhile`
// runs after the build step arrives, before the compaction.
function approveBuildAndCompact(proj: string, unit: string | null, meanwhile: () => void = () => {}): void {
  writePlan(proj, unit);
  const ask = next(proj);
  expect(ask, JSON.stringify(ask)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  reply(proj, "approve");
  const build = next(proj);
  expect(build.kind, JSON.stringify(build)).toBe("run-stage");
  meanwhile();
  const markerPath = join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as { owner_session: string };
  expect(invalidateActiveDirectiveContext(proj, readFileSync(seededStateFile(proj), "utf-8"), marker.owner_session)).toBe(true);
  expect((JSON.parse(readFileSync(markerPath, "utf-8")) as { kind: string }).kind).toBe("error");
}

describe("a stale build step after approval: the refusal names the way back", () => {
  test.each(["strict", "relaxed"] as const)("the chat compacts mid-build, Guard Policy %s", (policy) => {
    const proj = project(policy);
    approveBuildAndCompact(proj, null);

    const write = said(writeSource(proj));
    const why = /directive kind "error": the Code Generation step went out of date at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC when the chat was compacted\. /;
    expect(write).toMatch(why);
    expect(write).toContain(`The plan for the zero-Unit stage-level implementation ${ALREADY_APPROVED}`);
    expect(write).toContain(`Run \`${SOURCE_NEXT}\` ${ON_ITS_OWN}, and follow the step it prints.`);
    if (policy === "strict") expect(write).toContain("Code generation cannot start because workspace mutation cannot select one approval target");
    else expect(write).toContain("The plan-approval setting is unchanged.");

    // The developer handoff gets the same way back, not "not approved yet".
    const dispatched = said(handoff(proj));
    expect(dispatched).toMatch(why);
    expect(dispatched).toContain(ALREADY_APPROVED);
    expect(namedCommand(dispatched)).toBe(SOURCE_NEXT);
    expect(dispatched).not.toContain("not approved yet");

    // A `cd` in front, as agents write it, is refused and named the same way.
    const prefixed = said(shell(proj, `cd ..; ${SOURCE_NEXT}`));
    expect(namedCommand(prefixed)).toBe(SOURCE_NEXT);

    const command = namedCommand(write);
    const admitted = shell(proj, command);
    expect(admitted.code, admitted.stderr).toBe(0);
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
    const resumed = writeSource(proj);
    expect(resumed.code, resumed.stderr).toBe(0);
  });

  test("a per-Unit build names its Unit, Guard Policy relaxed", () => {
    const proj = unitProject("unit-2", "relaxed");
    approveBuildAndCompact(proj, "unit-2");
    const write = said(writeSource(proj));
    expect(write).toContain(`The plan for unit unit-2 ${ALREADY_APPROVED}`);
    expect(namedCommand(write)).toBe(SOURCE_NEXT);
  });

  // A build step published after a swarm step can still carry the swarm's Unit
  // list; the step's own Unit is its target, as the engine reads it.
  test("a Unit list left from an earlier swarm step does not change the target", () => {
    const proj = unitProject("unit-2", "relaxed");
    const markerPath = join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json");
    const inherit = () => {
      const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as Record<string, unknown>;
      writeFileSync(markerPath, `${JSON.stringify({ ...marker, units: ["unit-1", "unit-2"] }, null, 2)}\n`, "utf-8");
    };
    approveBuildAndCompact(proj, "unit-2", inherit);
    const write = said(writeSource(proj));
    expect(write).toContain(`The plan for unit unit-2 ${ALREADY_APPROVED}`);
    expect(write).not.toContain("Units unit-1");
    expect(next(proj).kind).toBe("run-stage");
    inherit();
    const refused = said(twoTargetHandoff(proj));
    expect(namedBrief(refused)).toBe("bun .claude/tools/aidlc-testing-posture.ts brief --unit unit-2");
  });

  test.each([false, true])("plan approval off (plan edited after it was built: %p): no approval is needed, nobody approved", (edited) => {
    const proj = project("relaxed", "off");
    writePlan(proj);
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    if (edited) appendFileSync(join(stageDir(proj, null), "code-generation-plan.md"), "- [ ] Step 2: also trim\n");
    const markerPath = join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as { owner_session: string };
    expect(invalidateActiveDirectiveContext(proj, readFileSync(seededStateFile(proj), "utf-8"), marker.owner_session)).toBe(true);
    const write = said(writeSource(proj));
    expect(write).toContain(
      "Plan approval is off for the plan for the zero-Unit stage-level implementation, so it needs no approval: " +
        "do not ask the person to approve it.",
    );
    expect(write).not.toContain(ALREADY_APPROVED);
    expect(write).not.toContain("approved an earlier version");
    expect(namedCommand(write)).toBe(SOURCE_NEXT);
  });

  test("a native release names the native command", () => {
    const proj = project("relaxed");
    approveBuildAndCompact(proj, null);
    const write = said(writeSource(proj, RELEASE_GUARD));
    expect(namedCommand(write)).toBe("aidlc engine orchestrate next");
    expect(write).not.toContain("aidlc-orchestrate.ts");
  });
});

describe("the person already answered: the refusal does not send the agent back to them", () => {
  test.each(["strict", "off"] as const)("approved, then a write before `next`, Guard Policy %s", (policy) => {
    const proj = project(policy);
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    reply(proj, "approve");
    const write = said(writeSource(proj));
    expect(write).toContain("The person has approved the plan for the zero-Unit stage-level implementation.");
    expect(write).not.toContain("Show them the question");
    expect(namedCommand(write)).toBe(SOURCE_NEXT);
    expect(next(proj).kind).toBe("run-stage");
  });

  test("not yet answered: show the question and wait", () => {
    const proj = project("off");
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    const write = said(writeSource(proj));
    expect(write.trim()).toBe("Nothing is built or changed while the plan waits for your approval.");
  });

  test("approved while the question is open, then a handoff naming two targets: no claim it is unapproved", () => {
    const proj = project("strict");
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    reply(proj, "approve");
    const refused = said(twoTargetHandoff(proj));
    expect(refused).toContain("the developer handoff names several targets (backend-lookup, stage:code-generation)");
    expect(refused).not.toContain("not approved");
    expect(namedBrief(refused)).toBe(SOURCE_BRIEF);
  });
});

describe("the person answered the plan question another way, and the agent writes before `next`", () => {
  test("Request Changes: the refusal says they answered and `next` carries out their choice", () => {
    const proj = project("strict");
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    say(proj, "rename slugify to toSlug");
    expect(answer(proj, "Request Changes")).toContain('Recorded \\"Request Changes\\"');
    const write = said(writeSource(proj));
    expect(write).toContain("The person has answered the plan question.");
    expect(write).toContain("Do not show them the question again.");
    expect(write).not.toContain("Show them the question from the last");
    expect(namedCommand(write)).toBe(SOURCE_NEXT);
    const revise = next(proj);
    expect(revise.kind, JSON.stringify(revise)).toBe("run-stage");
    expect(revise.plan_approval?.status).toBe("revise");
  });

  test("editing the files themselves: the refusal leaves the files to them", () => {
    const proj = project("off");
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    // "I'll edit the files" is the question's own choice: the hook records it as typed.
    say(proj, "I'll edit the files");
    const write = said(guard(proj, "Write", { file_path: join(stageDir(proj, null), "code-generation-plan.md"), content: "x\n" }));
    expect(write).toContain("The person is editing the plan files themselves: leave those files to them.");
    expect(write).not.toContain("Show them the question from the last");
    expect(namedCommand(write)).toBe(SOURCE_NEXT);
  });
});

describe("a malformed handoff before the plan may be built", () => {
  test.each(["strict", "off"] as const)("Guard Policy %s: the plan steps come first, then the brief", (policy) => {
    const proj = project(policy);
    expect(next(proj).kind).toBe("run-stage");
    const refused = said(twoTargetHandoff(proj));
    expect(refused).toContain("not approved yet");
    expect(refused).not.toContain("the developer handoff names several targets");
    expect(namedCommand(refused)).toBe(SOURCE_NEXT);
    expect(refused).toContain(`Then hand the developer the output of \`${SOURCE_BRIEF}\` first`);
  });
});

describe("the recovery question is open", () => {
  test("`next` with a `cd` in front is refused and named on its own", () => {
    const proj = project("off");
    approveBuildAndCompact(proj, null);
    const state = readFileSync(seededStateFile(proj), "utf-8");
    writeActiveDirectiveMarker(proj, {
      kind: "ask", ask_type: "guard-recovery", stage: "code-generation", remedies: [], state_sha256: stateDigest(state),
    });
    const prefixed = said(shell(proj, `cd ..; ${SOURCE_NEXT}`));
    expect(prefixed).toContain("recovery question is open");
    expect(namedCommand(prefixed)).toBe(SOURCE_NEXT);
    const admitted = shell(proj, SOURCE_NEXT);
    expect(admitted.code, admitted.stderr).toBe(0);
  });
});

describe("the plan was edited after approval", () => {
  test("Guard Policy relaxed: the refusal says an earlier version was approved and the build may go on", () => {
    const proj = project("relaxed");
    approveBuildAndCompact(proj, null, () => appendFileSync(join(stageDir(proj, null), "code-generation-plan.md"), "- [ ] Step 2: also trim\n"));
    const write = said(writeSource(proj));
    expect(write).toContain(
      "The person approved an earlier version of the plan for the zero-Unit stage-level implementation, " +
        "and the Guard Policy lets the build go on with the changes: do not ask them to approve it again yourself.",
    );
    expect(write).not.toContain(ALREADY_APPROVED);
    expect(namedCommand(write)).toBe(SOURCE_NEXT);
  });

  test("strict: no approval is claimed, and `next` asks the person again", () => {
    const proj = project("strict");
    approveBuildAndCompact(proj, null, () => appendFileSync(join(stageDir(proj, null), "code-generation-plan.md"), "- [ ] Step 2: also trim\n"));
    const write = said(writeSource(proj));
    expect(write).not.toContain("approved an earlier version");
    expect(write).not.toContain(ALREADY_APPROVED);
    expect(namedCommand(write)).toBe(SOURCE_NEXT);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });
});

describe("a handoff that names two targets", () => {
  test.each(["strict", "off"] as const)("Guard Policy %s: the refusal names both and the brief that names one, which works as printed", (policy) => {
    const proj = project(policy);
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    reply(proj, "approve");
    expect(next(proj).kind).toBe("run-stage");
    const refused = said(twoTargetHandoff(proj));
    expect(refused).toContain("the developer handoff names several targets (backend-lookup, stage:code-generation)");
    expect(refused).not.toContain("not approved");
    if (policy === "off") expect(refused).toContain("The plan-approval setting is unchanged.");
    const brief = namedBrief(refused);
    expect(brief).toBe(SOURCE_BRIEF);
    const admitted = shell(proj, brief);
    expect(admitted.code, admitted.stderr).toBe(0);
    const output = runInstalled(proj, brief);
    expect(output.split("\n")[0]).toBe("AIDLC-STAGE: code-generation");
    const handedOver = guard(proj, "Task", { subagent_type: "aidlc-developer-agent", prompt: `${output}\nBuild it.` });
    expect(handedOver.code, handedOver.stderr).toBe(0);
  });
});

describe("no plan yet, Guard Policy off: the same refusal as with the fence on", () => {
  test("a source write names the plan files and the command", () => {
    const proj = project("off");
    const planned = next(proj);
    expect(planned.kind, JSON.stringify(planned)).toBe("run-stage");
    const write = said(writeSource(proj));
    expect(write).toContain("Reason: code-generation-plan.md is missing or empty.");
    expect(write).toContain("Writes inside the selected code-generation record directory remain available for planning.");
    expect(namedCommand(write)).toBe(SOURCE_NEXT);
    expect(write).toContain("The plan-approval setting is unchanged.");
    expect(write.match(/Code Generation cannot start/gi) ?? []).toHaveLength(0);
  });
});

describe("while the rules arrive in parts", () => {
  test("the commands it names are to be run on their own", () => {
    const reason = codeGenerationRulesArrivingReason({
      version: 2, stage: "code-generation", kind: "load-steering", part: 1, parts: 3,
      continue_token: "abcdEFGH", state_sha256: "0".repeat(64),
    } as Parameters<typeof codeGenerationRulesArrivingReason>[0]);
    expect(reason).toContain(`Run each command named here ${AS_ITS_OWN_COMMAND}.`);
    expect(reason).toContain("`bun .claude/tools/aidlc-orchestrate.ts continue abcdEFGH`");
  });
});

// The stand-aside row is the lowered fence's account of what it let through,
// not approval evidence: a ledger that cannot take it never refuses the build.
describe("a lowered fence never refuses because its audit row could not be written", () => {
  // Approved, built, then edited: with the fence lowered the edited plan builds.
  function editedAfterApproval(mode: "off" | "relaxed" = "off"): string {
    const proj = project(mode);
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    reply(proj, "approve");
    expect(next(proj).kind).toBe("run-stage");
    appendFileSync(join(stageDir(proj, null), "code-generation-plan.md"), "- [ ] Step 2: also trim\n");
    return proj;
  }
  const stoodAside = (proj: string) =>
    readAuditShardEvents(proj).filter((row) => row.event === "GUARD_STOOD_ASIDE").length;

  test("the ledger takes it: the build goes on and the row is written", () => {
    const proj = editedAfterApproval();
    const before = stoodAside(proj);
    const write = writeSource(proj);
    expect(write.code, write.stderr).toBe(0);
    expect(stoodAside(proj)).toBe(before + 1);
  });

  test.each(["relaxed", "off"] as const)("the ledger cannot take it under %s: the build still goes on, and the doctor says so", (mode) => {
    const proj = editedAfterApproval(mode);
    const shard = auditFilePath(proj);
    expect(existsSync(shard)).toBe(true);
    renameSync(shard, `${shard}.away`);
    const write = guardOut(proj, "Write", { file_path: join(proj, "src", "slugify.ts"), content: "x\n" });
    expect(write.code, write.stderr).toBe(0);
    if (mode === "relaxed") {
      expect(write.stdout).toContain(
        "Not recorded in the audit trail, which was busy or could not be written; " +
          "`bun .claude/tools/aidlc.ts doctor` lists it",
      );
    } else {
      // Off says nothing; the doctor still lists the row it could not write.
      expect(write.stdout).not.toContain("Continuing past");
    }
    expect(readFileSync(join(hooksHealthDir(proj), "plan-approval-guard.drops"), "utf-8"))
      .toContain("GUARD_STOOD_ASIDE row not recorded");
    const brief = spawnSync(BUN, [".claude/tools/aidlc-testing-posture.ts", "brief", "--stage-level"], {
      cwd: proj,
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(brief.status, brief.stderr).toBe(0);
    expect(brief.stdout.split("\n")[0]).toBe("AIDLC-STAGE: code-generation");
  });
});

describe("no refusal names a step the install cannot run", () => {
  // The spellings refusals used to print: a source tool name no installed user
  // has, `next` with no spelling, and "the intent command".
  const STALE = [
    "`aidlc-orchestrate.ts next`",
    "`aidlc-testing-posture.ts brief`",
    "Run a fresh next",
    "no stage-level fallback",
    "the intent command",
    "intent <name>",
  ];
  const shipped = [
    join(REPO_ROOT, "core", "hooks", "aidlc-plan-approval-guard.ts"),
    ...Array.from(
      new Bun.Glob("*/.*/hooks/aidlc-plan-approval-guard.ts").scanSync({ cwd: join(REPO_ROOT, "dist-release"), dot: true }),
      (path) => join(REPO_ROOT, "dist-release", path),
    ),
  ];

  test("every shipped plan-approval guard is free of the old spellings", () => {
    expect(shipped.length).toBeGreaterThanOrEqual(8);
    for (const path of shipped) {
      const source = readFileSync(path, "utf-8");
      for (const stale of STALE) expect({ path, stale, found: source.includes(stale) }).toEqual({ path, stale, found: false });
      expect({ path, bareNext: /\b[Rr]un `next`/.test(source) }).toEqual({ path, bareNext: false });
    }
  });
});

// --- Guard Policy off: a build step set aside goes on --------------------------

const markerFile = (proj: string) => join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json");
const markerOf = (proj: string) => JSON.parse(readFileSync(markerFile(proj), "utf-8")) as Record<string, unknown>;
const asideRows = (proj: string) => readAuditShardEvents(proj).filter((row) => row.event === "GUARD_STOOD_ASIDE");

function underHeading(proj: string, file: string, heading: string, line: string): void {
  const path = join(proj, "aidlc", "spaces", "default", "memory", file);
  const text = readFileSync(path, "utf-8");
  expect(text).toContain(`${heading}\n`);
  writeFileSync(path, text.replace(`${heading}\n`, `${heading}\n\n${line}\n`), "utf-8");
}

// The work's line says strict from its scope and project.md says off: off.
function offFromMemory(proj: string): string {
  underHeading(proj, "project.md", "## Guard Policy", "- Mode: off");
  return proj;
}

function compact(proj: string): void {
  const marker = markerOf(proj) as { owner_session: string };
  expect(invalidateActiveDirectiveContext(proj, readFileSync(seededStateFile(proj), "utf-8"), marker.owner_session)).toBe(true);
  expect(markerOf(proj).kind).toBe("error");
}

// The plan approved (or built with plan approval off), the build begun or not,
// then the chat compacts and the build step the agent held is set aside.
function buildSetAside(proj: string, options: { asked?: boolean; begun?: boolean } = {}): void {
  writePlan(proj);
  const first = next(proj);
  if (options.asked ?? true) {
    expect(first, JSON.stringify(first)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    reply(proj, "approve");
    expect(next(proj).kind).toBe("run-stage");
  } else {
    expect(first.kind, JSON.stringify(first)).toBe("run-stage");
  }
  if (options.begun) expect(writeSource(proj).code).toBe(0);
  compact(proj);
}

function reportCompleted(proj: string): { status: number; out: string } {
  const result = spawnSync(BUN, [join(proj, ".claude", "tools", "aidlc-orchestrate.ts"), "report", "--stage", "code-generation",
    "--result", "completed", "--project-dir", proj], {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("Guard Policy off: the build step the chat compaction set aside goes on", () => {
  const cases: Array<[string, () => string, { asked: boolean }]> = [
    ["off from the poc scope", () => project("off"), { asked: true }],
    ["off from project.md", () => offFromMemory(project("strict")), { asked: true }],
    ["express, plan approval off from its scope", () => project("off", "scope", "express"), { asked: false }],
  ];
  for (const [name, make, { asked }] of cases) {
    test.each([false, true])(`${name}, the build begun before the compaction: %p`, (begun) => {
      const proj = make();
      buildSetAside(proj, { asked, begun });
      const rows = asideRows(proj).length;
      const write = guardOut(proj, "Write", { file_path: join(proj, "src", "slugify.ts"), content: "x\n" });
      expect(write.code, write.stderr).toBe(0);
      expect(write.stdout).toBe("");
      expect(write.stderr).toBe("");
      const added = asideRows(proj).slice(rows);
      expect(added).toHaveLength(1);
      expect(auditBlockField(added[0].block, "Details") ?? "").toContain("went out of date");
      const shell = guard(proj, "Bash", { command: "echo built > src/slugify.ts" });
      expect(shell.code, shell.stderr).toBe(0);
      // The walk to the end: the build reports complete with no `next` first.
      const done = reportCompleted(proj);
      expect(done.status, done.out).toBe(0);
      expect(done.out).not.toMatch(/out of date|ambiguous or stale|cannot start|not approved yet|approve the plan/i);
      expect(done.out).not.toContain("plan-approval");
    });
  }

  test("`next` after the carried-on write picks the build up where its ticks are", () => {
    const proj = project("off");
    buildSetAside(proj, { begun: true });
    expect(writeSource(proj).code).toBe(0);
    const plan = join(stageDir(proj, null), "code-generation-plan.md");
    writeFileSync(plan, readFileSync(plan, "utf-8").replace("- [ ] Step 1: write slugify", "- [x] Step 1: write slugify"));
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
    // A pick-up, not a build from step 1: the brief says where the ticks stand.
    const brief = runInstalled(proj, SOURCE_BRIEF);
    expect(brief).toContain("## Progress before the interruption");
    expect(brief).toContain("All 1 steps are ticked in the plan file");
  });

  test("the brief and the developer handoff go on too", () => {
    const proj = project("off");
    buildSetAside(proj, { begun: true });
    const admitted = shell(proj, SOURCE_BRIEF);
    expect(admitted.code, admitted.stderr).toBe(0);
    const output = runInstalled(proj, SOURCE_BRIEF);
    expect(output.split("\n")[0]).toBe("AIDLC-STAGE: code-generation");
    const rows = asideRows(proj).length;
    const handedOver = guard(proj, "Task", { subagent_type: "aidlc-developer-agent", prompt: `${output}\nBuild it.` });
    expect(handedOver.code, handedOver.stderr).toBe(0);
    expect(asideRows(proj).length).toBe(rows + 1);
  });

  test("a task-list sync that set the step aside after a setting write: the build goes on", () => {
    const proj = project("off");
    buildSetAside(proj, { begun: true });
    expect(next(proj).kind).toBe("run-stage");
    const before = readFileSync(seededStateFile(proj), "utf-8");
    const after = setField(before, "Depth", "Comprehensive");
    writeFileSync(seededStateFile(proj), after);
    expect(refreshActiveDirectiveMarker(proj, "code-generation", before, after)).toBe(true);
    expect(markerOf(proj)).toMatchObject({ kind: "error", out_of_date: { by: "status-sync", kind: "run-stage" } });
    expect(writeSource(proj).code).toBe(0);
  });

  // The shape the Copilot adapter's four writers leave (crossActiveDirectiveBoundary).
  test("a step set aside the way Copilot sets it aside: the build goes on", () => {
    const proj = project("off");
    buildSetAside(proj, { begun: true });
    expect(next(proj).kind).toBe("run-stage");
    const marker = markerOf(proj);
    writeFileSync(markerFile(proj), `${JSON.stringify({
      ...marker, kind: "error",
      out_of_date: { by: "copilot-human-turn", at: new Date().toISOString(), kind: "run-stage", stage: "code-generation" },
    }, null, 2)}\n`);
    expect(writeSource(proj).code).toBe(0);
  });

  test("a jump that redid Code Generation: the set-aside step names `next`, which asks for the new attempt's plan", () => {
    const proj = project("off");
    buildSetAside(proj, { begun: true });
    expect(next(proj).kind).toBe("run-stage");
    const before = readFileSync(seededStateFile(proj), "utf-8");
    const jumped = spawnSync(BUN, [join(proj, ".claude", "tools", "aidlc-jump.ts"), "execute", "--target", "code-generation",
      "--direction", "redo", "--project-dir", proj], {
      cwd: proj, env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj }, encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(jumped.status, `${jumped.stdout}${jumped.stderr}`).toBe(0);
    refreshActiveDirectiveMarker(proj, "code-generation", before, readFileSync(seededStateFile(proj), "utf-8"));
    const write = said(writeSource(proj));
    expect(namedCommand(write)).toBe(SOURCE_NEXT);
    const step = next(proj);
    expect(["run-stage", "ask"]).toContain(step.kind);
    expect(step.plan_approval?.status).not.toBe("approved");
  });

  test("the plan question set aside by a compaction still waits for the person", () => {
    const proj = project("off");
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    const marker = markerOf(proj) as { owner_session: string };
    expect(invalidateActiveDirectiveContext(proj, readFileSync(seededStateFile(proj), "utf-8"), marker.owner_session)).toBe(true);
    expect(said(writeSource(proj))).toBe("Nothing is built or changed while the plan waits for your approval.");
  });

  test("a gate set aside by a compaction is not a build step: the write names `next`", () => {
    const proj = project("off");
    buildSetAside(proj, { begun: true });
    const marker = markerOf(proj);
    writeFileSync(markerFile(proj), `${JSON.stringify({
      ...marker,
      out_of_date: { by: "compaction", at: new Date().toISOString(), kind: "present-gate", stage: "code-generation" },
    }, null, 2)}\n`);
    expect(namedCommand(said(writeSource(proj)))).toBe(SOURCE_NEXT);
  });

  test("no step at all: the write names `next`", () => {
    const proj = project("off");
    buildSetAside(proj, { begun: true });
    writeFileSync(markerFile(proj), "", "utf-8");
    expect(namedCommand(said(writeSource(proj)))).toBe(SOURCE_NEXT);
  });
});

describe("the plan's Testing Contract changed after the person approved it", () => {
  const contractRows = (proj: string) => readAuditShardEvents(proj)
    .filter((row) => row.event === "CHANGE_ACCEPTED" && auditBlockField(row.block, "Checkpoint") === "plan-approval");
  function approvedBuildThenPostureEdit(policy: "strict" | "relaxed" | "off"): { proj: string; recorded: string } {
    const proj = project(policy);
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    reply(proj, "approve");
    expect(next(proj).kind).toBe("run-stage");
    expect(writeSource(proj).code).toBe(0);
    const recorded = resolveTestingPosture(proj).contract_sha256;
    underHeading(proj, "project.md", "## Testing Posture", "- Methodology: tdd");
    expect(resolveTestingPosture(proj).contract_sha256).not.toBe(recorded);
    return { proj, recorded };
  }
  const writeWith = (proj: string, env: Record<string, string>) => spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: proj, tool_name: "Write",
      tool_input: { file_path: join(proj, "src", "slugify.ts"), content: "x\n" } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, ...env },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });

  test("Guard Policy off: the build goes on, and one row records the change, once, with nothing said", () => {
    const { proj, recorded } = approvedBuildThenPostureEdit("off");
    const write = guardOut(proj, "Write", { file_path: join(proj, "src", "slugify.ts"), content: "x\n" });
    expect(write.code, write.stderr).toBe(0);
    expect(write.stdout).toBe("");
    const rows = contractRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Recorded")).toBe(recorded);
    expect(auditBlockField(rows[0].block, "Current")).toBe(resolveTestingPosture(proj).contract_sha256);
    expect(writeSource(proj).code).toBe(0);
    expect(runInstalled(proj, SOURCE_BRIEF).split("\n")[0]).toBe("AIDLC-STAGE: code-generation");
    expect(contractRows(proj)).toHaveLength(1);
  });

  test("Guard Policy off: a ledger that cannot take the row never stops the build", () => {
    const { proj } = approvedBuildThenPostureEdit("off");
    const write = writeWith(proj, { AIDLC_TEST_CHANGE_CONTROL_LEDGER_FAULT: "way-out" });
    expect(write.status, write.stderr).toBe(0);
    expect(contractRows(proj)).toHaveLength(0);
    expect(readFileSync(join(hooksHealthDir(proj), "testing-posture.drops"), "utf-8")).toContain("CHANGE_ACCEPTED row not recorded");
  });

  test("relaxed keeps its own line and records no row; strict still waits for the plan again", () => {
    const relaxed = approvedBuildThenPostureEdit("relaxed").proj;
    const write = guardOut(relaxed, "Write", { file_path: join(relaxed, "src", "slugify.ts"), content: "x\n" });
    expect(write.code, write.stderr).toBe(0);
    expect(write.stdout).toContain("Continuing past the plan-approval check");
    expect(contractRows(relaxed)).toHaveLength(0);
    const strict = approvedBuildThenPostureEdit("strict").proj;
    expect(said(writeSource(strict))).toContain("the approved Testing Contract is stale");
    expect(contractRows(strict)).toHaveLength(0);
    expect(next(strict).plan_approval?.status).toBe("plan");
  });
});

describe("the two Guard Policy lines disagree while the plan question is open", () => {
  test("next settles them, the question stays the person's, and their approval builds", () => {
    const proj = project("off");
    writePlan(proj);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    // The question was asked while a teammate's retired line sat beside the new one.
    const path = seededStateFile(proj);
    const conflicted = readFileSync(path, "utf-8").replace(
      "- **Guard Policy**: off (from scope poc)",
      "- **Guard Policy**: off (from scope poc)\n- **Change Control**: relaxed (set by you)",
    );
    writeFileSync(path, conflicted);
    writeFileSync(markerFile(proj), `${JSON.stringify({ ...markerOf(proj), state_sha256: stateDigest(conflicted) }, null, 2)}\n`);
    expect(next(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    expect(markerOf(proj)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    const settled = readFileSync(path, "utf-8");
    expect(settled).toContain("- **Guard Policy**: relaxed (set by you)");
    expect(settled).not.toContain("Change Control");
    reply(proj, "approve");
    const build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.plan_approval).toEqual({ status: "approved" });
  });
});
