// covers: function:gateNoticesInBox, function:gateNoticeBoxInput, function:gateNoticeBoxShown, subcommand:aidlc-orchestrate:report
//
// t-gate-notice-in-box: on Claude Code's interactive CLI a stage gate's own lines for the person (the no-git line, a
// review that did not finish) were handed to the agent to say as written, and the agent retold them in its own words
// beside the question box. Where the box can carry them, the gate step no longer hands them to the agent: the box
// shows them under the agent's question, word for word, and the answer takes them off the list, so each is said
// once. Everywhere else (the SDK, an unattended run, another harness) the step carries them as before.
//
// Mechanism: cli over the answers corpus Requirements Analysis gate in a project with no git (the real report and
// next), the shipped Claude guard row before the box and the human-turn hook after it.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STAGE } from "../harness/aidlc-answers-corpus.ts";
import { DISPATCHER, env, exec, next, ORCHESTRATE, reviewedStage, say, SESSION } from "../harness/aidlc-input-corpus.ts";
import { cleanupTestProject, createOrchestrationTestProject, seededRecordDir } from "../harness/fixtures.ts";
import { addPendingPersonLines, auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const NO_GIT = "This project has no git, so AI-DLC can't undo the changes it makes to your files; " +
  "to get an undo, run `git init` and commit them.";
const SAID = join("aidlc", ".aidlc-sessions", "no-git-said");
const KEPT = join("aidlc", ".aidlc-sessions", `${SESSION}.person-lines`);
const NOTE = "Say each notice listed beside this note to the person once";
const CLI = { CLAUDE_CODE_ENTRYPOINT: "cli" };
const QUESTION = "Requirements Analysis complete. How would you like to proceed?";

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

interface Step { kind?: string; gate_only?: boolean; message?: string; narration?: string; change_notices?: string[]; change_notices_note?: string }
interface Box { question: string; header: string; multiSelect: boolean; options: Array<{ label: string; description: string }> }

function gateBox(question = QUESTION): Box {
  return {
    question, header: "Approval", multiSelect: false,
    options: [{ label: "Approve", description: "Continue to Code Generation" }, { label: "Request Changes", description: "Provide revision feedback" }],
  };
}

// A project with no git at its Requirements Analysis gate, its review READY with one finding left open (so the gate
// also says what Approve accepts), as a run leaves it before the gate's report.
const FINDING = "| Minor | requirements.md > FR-1 | The wording is loose. | Tighten it. |";
async function atGate(findings: string[] = [FINDING]): Promise<string> {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  rmSync(join(proj, SAID), { force: true });
  await reviewedStage(proj, findings);
  return proj;
}
// Enough open findings that what Approve accepts is one line longer than the box holds beside the agent's question.
const MANY = Array.from({ length: 40 }, (_, i) => `| Minor | requirements.md > FR-${i + 1} | Finding number ${i + 1} reads loosely here. | Tighten it. |`);

async function report(proj: string, result: string, extra: Record<string, string> = {}, args: string[] = []): Promise<Step> {
  const res = await exec([process.execPath, ORCHESTRATE, "report", "--stage", STAGE, "--result", result, ...args, "--project-dir", proj], {
    cwd: proj, env: env(proj, { env: extra }),
  });
  expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
  return JSON.parse(res.stdout.trim().split("\n").at(-1) ?? "{}") as Step;
}

// The guard-tool-call row before Claude Code opens the box: the box it hands Claude Code, or null when it prints nothing.
function beforeBox(proj: string, box: Box, extra: Record<string, string> = CLI): Box | null {
  const result = spawnSync(process.execPath, [DISPATCHER, "engine", "hook", "guard-tool-call"], {
    cwd: proj, env: env(proj, { env: extra }), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: proj, tool_name: "AskUserQuestion", tool_input: { questions: [box] } }),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  if (result.stdout.trim() === "") return null;
  const output = JSON.parse(result.stdout) as { hookSpecificOutput: { updatedInput: { questions: Box[] }; permissionDecision?: string } };
  expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
  return output.hookSpecificOutput.updatedInput.questions[0];
}

// Claude Code's PostToolUse for the box as it was shown.
function answered(proj: string, shown: Box, answer: string, extra: Record<string, string> = CLI): void {
  const result = spawnSync(process.execPath, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj, env: env(proj, { env: extra }), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: JSON.stringify({
      hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "AskUserQuestion",
      tool_input: { questions: [shown] }, tool_response: { questions: [shown], answers: { [shown.question]: answer } },
    }),
  });
  expect(result.status, result.stderr).toBe(0);
}

// The kept lines' times moved back past the 15 minutes a line for the next step waits.
function ageKeptLines(proj: string): void {
  const path = join(proj, KEPT);
  const kept = JSON.parse(readFileSync(path, "utf-8")) as { lines: Array<{ at: number }> };
  for (const line of kept.lines) line.at -= 16 * 60 * 1000;
  writeFileSync(path, `${JSON.stringify(kept)}\n`);
}

function auditText(proj: string): string {
  const dir = join(seededRecordDir(proj), "audit");
  return readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => readFileSync(join(dir, name), "utf-8")).join("\n");
}

// Each line, said once between a step and the box the agent shows after it.
function saidOnce(proj: string, step: Step, lines: string[]): void {
  const box = beforeBox(proj, gateBox());
  const said = [...(step.change_notices ?? []), ...(box?.question.split("\n\n").slice(1) ?? [])];
  for (const line of lines) expect(said.filter((one) => one === line), JSON.stringify(said)).toHaveLength(1);
  if ((step.change_notices ?? []).length > 0) expect(step.change_notices_note).toStartWith(NOTE);
}

const heard = (step: Step | null): string => [...(step?.change_notices ?? []), step?.narration ?? "", step?.message ?? ""].join("\n");

// The gate's own lines as main's path hands them to the agent: the same gate under the SDK.
let ownLines: string[] | null = null;
async function gateLines(): Promise<string[]> {
  if (ownLines !== null) return ownLines;
  const proj = await atGate();
  const step = await report(proj, "awaiting-approval", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
  ownLines = step.change_notices ?? [];
  expect(ownLines).toContain(NO_GIT);
  expect(ownLines.length).toBeGreaterThan(1);
  expect(step.change_notices_note).toStartWith(NOTE);
  return ownLines;
}

describe("t-gate-notice-in-box: the gate's own lines are said in Claude Code's question box, word for word, once", () => {
  test("the gate step hands the agent none of them; the box shows them under its question, header and choices unchanged", async () => {
    const lines = await gateLines();
    const proj = await atGate();
    const step = await report(proj, "awaiting-approval", CLI);
    expect(step.kind).toBe("print");
    expect(step.change_notices, JSON.stringify(step)).toBeUndefined();
    expect(step.change_notices_note).toBeUndefined();
    expect(heard(step)).not.toContain("no git");
    const shown = beforeBox(proj, gateBox());
    expect(shown).toEqual({ ...gateBox(), question: [QUESTION, ...lines].join("\n\n") });
  });

  // The gate shown again says what Approve accepts on each showing, as on main; the no-git line is said once per
  // project.
  test("said once: the answer takes them off, a second box gets none, the gate shown again never says the no-git line", async () => {
    const lines = await gateLines();
    const proj = await atGate();
    await report(proj, "awaiting-approval", CLI);
    // Kept is not said: the record waits for the box's answer.
    expect(existsSync(join(proj, SAID))).toBe(false);
    const shown = beforeBox(proj, gateBox())!;
    answered(proj, shown, "Request Changes");
    expect(existsSync(join(proj, SAID))).toBe(true);
    expect(beforeBox(proj, gateBox())).toBeNull();
    const again = await next(proj, [], { env: CLI });
    expect((again.directive as Step | null)?.gate_only, again.out).toBe(true);
    expect(heard(again.directive as Step)).not.toContain("no git");
    const reshown = beforeBox(proj, gateBox());
    expect(reshown?.question).toBe([QUESTION, ...lines.filter((line) => line !== NO_GIT)].join("\n\n"));
  });

  test("Esc (no answer comes back): the box shown again carries them while they wait, and none once they aged out", async () => {
    const lines = await gateLines();
    const proj = await atGate();
    await report(proj, "awaiting-approval", CLI);
    const question = [QUESTION, ...lines].join("\n\n");
    expect(beforeBox(proj, gateBox())?.question).toBe(question);
    expect(beforeBox(proj, gateBox())?.question).toBe(question);
    ageKeptLines(proj);
    expect(beforeBox(proj, gateBox())).toBeNull();
  });

  // The rare side of the room (no recorded interactive gate question came near it): the lines wait for the next step.
  test("an agent question past the room: the box goes out as written, and the next step or its box says each line once", async () => {
    const lines = await gateLines();
    const proj = await atGate();
    await report(proj, "awaiting-approval", CLI);
    const long = `${QUESTION} ${"x".repeat(2000 - QUESTION.length - 1)}`;
    expect(beforeBox(proj, gateBox(long))).toBeNull();
    const again = await next(proj, [], { env: CLI });
    const step = again.directive as Step;
    expect(step.gate_only, again.out).toBe(true);
    saidOnce(proj, step, lines);
  });

  test("no box (a gate asked in prose): the next step or its box says each line once", async () => {
    const lines = await gateLines();
    const proj = await atGate();
    await report(proj, "awaiting-approval", CLI);
    // The gate shown again, the third time the same step unchanged (issued again as it was).
    for (let shown = 0; shown < 3; shown++) saidOnce(proj, (await next(proj, [], { env: CLI })).directive as Step, lines);
    expect(existsSync(join(proj, SAID))).toBe(false);
  });

  test("past the room kept for the agent's question: the lines that fit go in the box, the rest stay on the step, none after the answer", async () => {
    const proj = await atGate(MANY);
    const sdk = (await report(await atGate(MANY), "awaiting-approval", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" })).change_notices ?? [];
    const approve = sdk.find((line) => line.startsWith("Approve accepts"))!;
    expect(sdk).toEqual([NO_GIT, approve]);
    expect(approve.length + NO_GIT.length).toBeGreaterThan(1500);
    const step = await report(proj, "awaiting-approval", CLI);
    expect(step.change_notices).toEqual([approve]);
    expect(step.change_notices_note).toStartWith(NOTE);
    const shown = beforeBox(proj, gateBox())!;
    expect(shown.question).toBe([QUESTION, NO_GIT].join("\n\n"));
    answered(proj, shown, "Approve");
    await say(proj, "Approve", "claude", { env: CLI });
    const approved = await report(proj, "approved", CLI, ["--user-input", "Approve"]);
    const after = (await next(proj, [], { env: CLI })).directive as Step;
    for (const later of [approved, after]) {
      expect(heard(later)).not.toContain("no git");
      expect(heard(later)).not.toContain("Approve accepts");
    }
  });

  test("the no-git line counts as said only once a box's answer or a written step carried it", async () => {
    // Kept and never shown (no box, the reply after the lines aged out): the gate shown again says it.
    const aged = await atGate();
    await report(aged, "awaiting-approval", CLI);
    ageKeptLines(aged);
    expect(existsSync(join(aged, SAID))).toBe(false);
    await next(aged, [], { env: CLI });
    expect(beforeBox(aged, gateBox())?.question).toContain(NO_GIT);
    // Kept, then carried by a later step (the agent asked in its own text, and the person approved in words).
    const carried = await atGate();
    await report(carried, "awaiting-approval", CLI);
    await say(carried, "Approve", "claude", { env: CLI });
    await report(carried, "approved", CLI, ["--user-input", "Approve"]);
    const step = (await next(carried, [], { env: CLI })).directive as Step;
    expect(step.change_notices ?? []).toContain(NO_GIT);
    expect(existsSync(join(carried, SAID))).toBe(true);
    // Shown in the box and answered after the kept lines aged out (a gate's usual pace): what the box showed counts.
    const late = await atGate();
    await report(late, "awaiting-approval", CLI);
    const lateBox = beforeBox(late, gateBox())!;
    expect(lateBox.question).toContain(NO_GIT);
    ageKeptLines(late);
    answered(late, lateBox, "Request Changes");
    expect(existsSync(join(late, SAID))).toBe(true);
    expect(heard((await next(late, [], { env: CLI })).directive as Step)).not.toContain("no git");
    expect(beforeBox(late, gateBox())?.question ?? "").not.toContain(NO_GIT);
    // The box's answer could not record it: shown once more at the gate shown again, never lost.
    if (process.platform !== "win32") {
      const failed = await atGate();
      await report(failed, "awaiting-approval", CLI);
      const shown = beforeBox(failed, gateBox())!;
      const sessions = join(failed, "aidlc", ".aidlc-sessions");
      chmodSync(sessions, 0o555);
      try {
        answered(failed, shown, "Request Changes");
      } finally {
        chmodSync(sessions, 0o755);
      }
      expect(existsSync(join(failed, SAID))).toBe(false);
      await next(failed, [], { env: CLI });
      expect(beforeBox(failed, gateBox())?.question.split(NO_GIT)).toHaveLength(2);
    }
  });

  for (const [name, extra] of [
    ["under the SDK", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }],
    ["with no entrypoint named", {}],
    ["in an unattended run", { ...CLI, AIDLC_UNATTENDED: "1" }],
    ["on Codex", { ...CLI, AIDLC_HARNESS_NAME: "codex" }],
    ["on Kiro CLI", { ...CLI, AIDLC_HARNESS_NAME: "kiro" }],
  ] as Array<[string, Record<string, string>]>) {
    test(`${name} the step carries them with the note as before, and nothing is kept for a box`, async () => {
      const lines = await gateLines();
      const proj = await atGate();
      const step = await report(proj, "awaiting-approval", extra);
      expect(step.change_notices).toEqual(lines);
      expect(step.change_notices_note).toStartWith(NOTE);
      expect(existsSync(join(proj, KEPT))).toBe(false);
    });
  }

  test("a line kept from elsewhere stays on the step with the note; only the gate's own lines go in the box", async () => {
    const lines = await gateLines();
    const proj = await atGate();
    const other = "Your earlier switch is off for this piece of work.";
    expect(addPendingPersonLines(proj, SESSION, [other])).toBe(true);
    const step = await report(proj, "awaiting-approval", CLI);
    expect(step.change_notices).toEqual([other]);
    expect(step.change_notices_note).toStartWith(NOTE);
    expect(beforeBox(proj, gateBox())?.question).toBe([QUESTION, ...lines].join("\n\n"));
  });

  test("a box that is another question open in this chat is left as the agent wrote it", async () => {
    const proj = await atGate();
    await report(proj, "awaiting-approval", CLI);
    const asked = await exec([process.execPath, join(dirname(ORCHESTRATE), "aidlc-log.ts"), "decision", "--stage", STAGE,
      "--decision", "Which name should the command use?", "--options", "greet,hello", "--project-dir", proj], { cwd: proj, env: env(proj, { env: CLI }) });
    expect(asked.status, `${asked.stdout}${asked.stderr}`).toBe(0);
    const box = { ...gateBox("Which name should the command use?"), options: [{ label: "greet", description: "" }, { label: "hello", description: "" }] };
    expect(beforeBox(proj, box)).toBeNull();
  });

  test("the answer is recorded with the box as shown, approves the gate with no second ask, and the same after the lines aged out", async () => {
    const lines = await gateLines();
    for (const aged of [false, true]) {
      const proj = await atGate();
      await report(proj, "awaiting-approval", CLI);
      const shown = beforeBox(proj, gateBox())!;
      if (aged) ageKeptLines(proj);
      answered(proj, shown, "Approve");
      const rows = readAuditShardEvents(proj);
      const replied = rows.filter((row) => row.event === "QUESTION_REPLIED");
      // The audit keeps a field on one line, its line breaks written as \n.
      expect(replied.map((row) => auditBlockField(row.block, "Question"))).toEqual([[QUESTION, ...lines].join("\\n\\n")]);
      expect(rows.some((row) => row.event === "HUMAN_TURN" && auditBlockField(row.block, "Source") === "picker")).toBe(true);
      const approved = await report(proj, "approved", CLI, ["--user-input", "Approve"]);
      expect(approved.kind, JSON.stringify(approved)).not.toBe("error");
      expect(auditText(proj)).toContain("GATE_APPROVED");
      expect(heard(approved)).not.toContain("no git");
    }
  });
});
