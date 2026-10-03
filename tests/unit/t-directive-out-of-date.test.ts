// covers: function:activeDirectiveOutOfDateReason, function:invalidateActiveDirectiveContext, function:recordCopilotHumanSequence, function:copilotStopEvidence, function:writeStateFile, subcommand:aidlc-orchestrate:next, file:hooks/aidlc-validate-state.ts
//
// The person approves the code plan and the build starts. When the chat then
// compacts, the step the agent was building from goes out of date (the agent
// must read it again with `next`), and every build action is refused until it
// does. Nothing used to say why, so the approval looked lost.
//
// These cases drive the packaged Copilot tree end to end, the way VS Code
// does, and pin what the person and the agent are told now: the write that put
// the step out of date is recorded with when and why, `aidlc doctor` says so
// with the one command that ends it, and that `next` hands the approved build
// straight back and retires the record. A state write after the step was
// issued names the state lines that moved and the AI-DLC command that wrote
// them, and nothing when a write went unrecorded. A record that is not in the
// writers' shape is dropped and never shown.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeDirectiveOutOfDateReason,
  readActiveDirectiveMarker,
  recordCopilotHumanSequence,
  stateDigest,
  writeActiveDirectiveMarker,
  writeSessionPidEntry,
} from "../../dist/copilot/.aidlc/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const COPILOT_ROOT = join(REPO_ROOT, "dist", "copilot");
const FIXTURE_STATE = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8");
const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const env = () => ({
  ...process.env, AIDLC_UNATTENDED: undefined, AIDLC_PROJECT_DIR: undefined, CLAUDE_PROJECT_DIR: undefined,
} as NodeJS.ProcessEnv);

// A brownfield workflow at Code Generation on the packaged Copilot tree.
function project(): string {
  const proj = createTestProject();
  projects.push(proj);
  cpSync(join(COPILOT_ROOT, ".aidlc"), join(proj, ".aidlc"), { recursive: true });
  cpSync(join(COPILOT_ROOT, "aidlc"), join(proj, "aidlc"), { recursive: true });
  writeFileSync(
    seededStateFile(proj),
    FIXTURE_STATE
      .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation")
      .replace(/^- \[[ xSR?-]\] code-generation(\s+\u2014\s+)EXECUTE$/m, "- [-] code-generation$1EXECUTE"),
  );
  mkdirSync(seededAuditDir(proj), { recursive: true });
  return proj;
}

function adapter(proj: string, target: string, payload: Record<string, unknown>) {
  if (target === "record-human-turn" && typeof payload.session_id === "string") {
    writeSessionPidEntry(proj, process.pid, payload.session_id);
  }
  const run = spawnSync(process.execPath, [join(proj, ".aidlc", "hooks", "aidlc-copilot-adapter.ts"), target], {
    cwd: proj, input: JSON.stringify({ cwd: proj, ...payload }), encoding: "utf-8", env: env(),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { stdout: run.stdout ?? "", stderr: run.stderr ?? "", code: run.status ?? -1 };
}

function shell(proj: string, command: string) {
  const run = spawnSync("/bin/sh", ["-c", command], {
    cwd: proj, encoding: "utf-8", env: env(), timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { stdout: run.stdout ?? "", stderr: run.stderr ?? "", code: run.status ?? -1 };
}

// One engine command the way VS Code runs it: the adapter claims it before
// the terminal runs it, and settles it from the terminal result after.
function engine(proj: string, session: string, args: string[], id: string): Record<string, unknown> {
  const command = `bun .aidlc/tools/aidlc-orchestrate.ts ${args.map((arg) => JSON.stringify(arg)).join(" ")}`;
  const pre = adapter(proj, "guard-tool-call", {
    hook_event_name: "PreToolUse", session_id: session, tool_use_id: id, tool_name: "Bash", tool_input: { command },
  });
  const rewritten = (JSON.parse(pre.stdout) as { modifiedArgs?: { command?: string } }).modifiedArgs?.command ?? "";
  expect(rewritten, pre.stdout).toContain(`--aidlc-attempt-id ${id}`);
  const run = shell(proj, rewritten);
  expect(run.code, run.stderr).toBe(0);
  adapter(proj, "post-tool", {
    hook_event_name: "PostToolUse", session_id: session, tool_use_id: id, tool_name: "Bash",
    tool_input: { command: rewritten },
    tool_result: { result_type: "success", text_result_for_llm: `${run.stdout.trim()}\n<shellId: t completed with exit code 0>` },
  });
  return JSON.parse(run.stdout.trim()) as Record<string, unknown>;
}

// `next`, then every rules part it asks for, as the conductor follows them.
function nextToBuild(proj: string, session: string, id: string): Record<string, unknown> {
  let directive = engine(proj, session, ["next"], `${id}-next`);
  for (let part = 0; directive.kind === "load-steering"; part++) {
    if (part > 20) throw new Error("steering did not converge");
    directive = engine(proj, session, ["continue", String(directive.receipt)], `${id}-continue-${part}`);
  }
  return directive;
}

function marker(proj: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json"), "utf-8"));
}

// The zero-Unit plan written, asked about by the engine, and approved by the
// person in chat; then the build handed over.
function approvedBuild(proj: string, session: string): string {
  const posture = (args: string[]) => spawnSync(
    process.execPath, [join(proj, ".aidlc", "tools", "aidlc-testing-posture.ts"), ...args, "--project-dir", proj],
    { cwd: proj, encoding: "utf-8", env: env(), timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) },
  );
  const contract = posture(["render"]);
  expect(contract.status, contract.stderr).toBe(0);
  const recordDir = join(seededRecordDir(proj), "construction", "code-generation");
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(
    join(recordDir, "code-generation-plan.md"),
    `# Code Generation Plan\n\n## Summary\n\n- Builds: saved searches\n\n## Steps\n\n- [ ] Step 1: store a search\n\n${contract.stdout}`,
  );
  writeFileSync(join(recordDir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test src/saved-search.test.ts`.\n");
  expect(engine(proj, session, ["next"], `${session}-ask`)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  const approved = adapter(proj, "record-human-turn", {
    hook_event_name: "UserPromptSubmit", session_id: session, prompt: "approve", timestamp: new Date().toISOString(),
  });
  expect(approved.code, approved.stderr).toBe(0);
  expect(nextToBuild(proj, session, `${session}-build`)).toMatchObject({
    kind: "run-stage", stage: "code-generation", plan_approval: { status: "approved" },
  });
  const brief = posture(["brief", "--stage-level"]);
  expect(brief.status, brief.stderr).toBe(0);
  return brief.stdout.match(/sha256:[0-9a-f]{64}/)?.[0] ?? "";
}

function dispatch(proj: string, session: string, contract: string) {
  return adapter(proj, "guard-tool-call", {
    hook_event_name: "PreToolUse", session_id: session, tool_name: "runSubagent",
    tool_input: {
      agentName: "aidlc-developer-agent", description: "Build the approved plan",
      prompt: `AIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: ${contract}\nBuild the approved plan.`,
    },
  });
}

function doctorLines(proj: string): string[] {
  const run = shell(proj, "bun .aidlc/tools/aidlc.ts doctor");
  return run.stdout.split(/\r?\n/);
}

const OUT_OF_DATE_AT = /went out of date at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/;

describe("a step that went out of date says which write did it", () => {
  test("a compaction mid-build: doctor names it and the fix, and next hands the approved build back", () => {
    const proj = project();
    const session = "out-of-date-compaction";
    const contract = approvedBuild(proj, session);
    expect(marker(proj)).toMatchObject({ kind: "run-stage" });
    expect(marker(proj).out_of_date).toBeUndefined();
    expect(doctorLines(proj).join("\n")).not.toContain("went out of date");

    const compacted = adapter(proj, "validate-state", { hook_event_name: "PreCompact", session_id: session });
    expect(compacted.code, compacted.stderr).toBe(0);
    expect(marker(proj)).toMatchObject({
      kind: "error",
      out_of_date: { by: "compaction", kind: "run-stage", stage: "code-generation" },
    });
    // The build waits until the agent has read the step again.
    expect(dispatch(proj, session, contract).stdout).toContain('"permissionDecision":"deny"');

    const lines = doctorLines(proj);
    const row = lines.findIndex((line) => line.includes("went out of date"));
    expect(row, lines.join("\n")).toBeGreaterThanOrEqual(0);
    expect(lines[row]).toMatch(/^\s*warn\s+The Code Generation step went out of date at /);
    expect(lines[row]).toMatch(OUT_OF_DATE_AT);
    expect(lines[row]).toContain("when the chat was compacted.");
    expect(lines[row + 1]).toContain("fix: run `bun .aidlc/tools/aidlc-orchestrate.ts next` as its own command");
    expect(lines[row + 1]).toContain("an approval that still matches is kept");

    // The one command: the approved build comes straight back, not the question.
    expect(nextToBuild(proj, session, "after-compaction")).toMatchObject({
      kind: "run-stage", stage: "code-generation", plan_approval: { status: "approved" },
    });
    expect(marker(proj).out_of_date).toBeUndefined();
    expect(doctorLines(proj).join("\n")).not.toContain("went out of date");
    const resumed = dispatch(proj, session, contract);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stdout).not.toContain('"permissionDecision":"deny"');
  });

  test("a setting changed mid-build: the turn-end check names the state line and the command that wrote it", () => {
    const proj = project();
    const session = "out-of-date-setting";
    approvedBuild(proj, session);
    const changed = shell(proj, "bun .aidlc/tools/aidlc-utility.ts config-change --depth minimal");
    expect(changed.code, changed.stderr).toBe(0);
    const stop = adapter(proj, "continue-workflow", {
      hook_event_name: "Stop", session_id: session, stop_reason: "end_turn", stop_hook_active: false,
    });
    expect(stop.code, stop.stderr).toBe(0);
    const recorded = marker(proj).out_of_date as Record<string, unknown>;
    expect(recorded).toMatchObject({ by: "copilot-turn-end", kind: "run-stage", stage: "code-generation" });
    expect(recorded.changed).toContain("Depth");
    expect(recorded.writers).toEqual(["aidlc-utility.ts config-change"]);
    const lines = doctorLines(proj).join("\n");
    expect(lines).toContain("at the end of a turn, because the workflow state had changed (changed: ");
    expect(lines).toContain("written by `aidlc-utility.ts config-change`).");
  });
});

describe("the record names only what it knows", () => {
  // A state write by one known command, as its own process: the record names
  // the script by its file name.
  function writeState(proj: string, content: string): void {
    const script = join(proj, "write-state.ts");
    writeFileSync(
      script,
      `import { writeStateFile } from ${JSON.stringify(join(proj, ".aidlc", "tools", "aidlc-lib.ts"))};\n` +
        `writeStateFile(${JSON.stringify(proj)}, ${JSON.stringify(content)});\n`,
    );
    const run = spawnSync(process.execPath, [script], { cwd: proj, encoding: "utf-8", env: env() });
    expect(run.status, run.stderr).toBe(0);
  }

  function issued(proj: string): string {
    const state = readFileSync(seededStateFile(proj), "utf-8");
    writeActiveDirectiveMarker(proj, { kind: "run-stage", stage: "code-generation", state_sha256: stateDigest(state) });
    return state;
  }

  test("a recorded write names the line and the command; the reason reads in the person's words", () => {
    const proj = project();
    const state = issued(proj);
    const moved = state.replace(/^- \*\*Depth\*\*:.*$/m, "- **Depth**: Minimal");
    writeState(proj, moved);
    expect(recordCopilotHumanSequence(proj, moved, "chat-a")).toBe(true);
    const read = readActiveDirectiveMarker(proj, moved);
    expect(read?.out_of_date).toMatchObject({
      by: "copilot-human-turn", kind: "run-stage", stage: "code-generation",
      changed: ["Depth"], writers: ["write-state.ts"],
    });
    expect(activeDirectiveOutOfDateReason(read)).toMatch(
      /^the Code Generation step went out of date at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC when the person's message arrived after the workflow state had changed \(changed: Depth; written by `write-state\.ts`\)$/,
    );
  });

  test("a write the record did not see leaves the change unnamed rather than guessed", () => {
    const proj = project();
    const state = issued(proj);
    const recorded = state.replace(/^- \*\*Depth\*\*:.*$/m, "- **Depth**: Minimal");
    writeState(proj, recorded);
    // A hand edit after the recorded write: the chain no longer reaches it.
    const edited = recorded.replace(/^- \*\*Test Strategy\*\*:.*$/m, "- **Test Strategy**: Minimal");
    writeFileSync(seededStateFile(proj), edited);
    expect(recordCopilotHumanSequence(proj, edited, "chat-b")).toBe(true);
    const read = readActiveDirectiveMarker(proj, edited);
    expect(read?.out_of_date).toMatchObject({ by: "copilot-human-turn", kind: "run-stage" });
    expect(read?.out_of_date?.changed).toBeUndefined();
    expect(read?.out_of_date?.writers).toBeUndefined();
    expect(activeDirectiveOutOfDateReason(read)).toMatch(/after the workflow state had changed$/);
  });

  test("a record not in the writers' shape is dropped, and the step still reads", () => {
    const proj = project();
    const state = readFileSync(seededStateFile(proj), "utf-8");
    writeActiveDirectiveMarker(proj, { kind: "run-stage", stage: "code-generation", state_sha256: stateDigest(state) });
    const path = join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json");
    const base = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const good = { by: "compaction", at: "2026-10-03T01:54:51Z", kind: "run-stage", stage: "code-generation" };
    for (const bad of [
      { ...good, by: "someone" },
      { ...good, changed: ["Status`; run rm -rf"] },
      { ...good, writers: ["x".repeat(200)] },
      { ...good, kind: "error" },
      { ...good, extra: "field" },
      "compaction",
    ]) {
      writeFileSync(path, `${JSON.stringify({ ...base, kind: "error", out_of_date: bad }, null, 2)}\n`);
      const read = readActiveDirectiveMarker(proj, state);
      expect(read, JSON.stringify(bad)).toMatchObject({ kind: "error", stage: "code-generation" });
      expect(read?.out_of_date).toBeUndefined();
      expect(activeDirectiveOutOfDateReason(read)).toBeNull();
    }
    writeFileSync(path, `${JSON.stringify({ ...base, kind: "error", out_of_date: good }, null, 2)}\n`);
    expect(activeDirectiveOutOfDateReason(readActiveDirectiveMarker(proj, state)))
      .toBe("the Code Generation step went out of date at 2026-10-03 01:54 UTC when the chat was compacted");
  });

  test("a step that is handed out again carries no record, whatever wrote it", () => {
    const proj = project();
    const state = readFileSync(seededStateFile(proj), "utf-8");
    writeActiveDirectiveMarker(proj, { kind: "run-stage", stage: "code-generation", state_sha256: stateDigest(state) });
    const path = join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json");
    const base = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({
      ...base, kind: "error",
      out_of_date: { by: "compaction", at: "2026-10-03T01:54:51Z", kind: "run-stage", stage: "code-generation" },
    }, null, 2)}\n`);
    writeActiveDirectiveMarker(proj, { kind: "error", stage: "code-generation", state_sha256: stateDigest(state), message: "engine said no" });
    expect(marker(proj).out_of_date).toBeUndefined();
  });
});
