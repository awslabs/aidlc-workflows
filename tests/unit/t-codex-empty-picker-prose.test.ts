// covers: hook:aidlc-codex-adapter, hook:aidlc-record-human-turn, function:emptyPickerResult
//
// #2491: on Codex, a structured question (request_user_input) can close with an
// empty answer object — the box ran out, or the person dismissed or closed it.
// The adapter keeps the raw box result in `picker_reply` and sets `tool_response`
// to the selected label (empty here), so the core hook's emptiness test reads
// `picker_reply`. When it fires, the hook must:
//   - record QUESTION_UNANSWERED and write NO answer or gate decision;
//   - hand back the SAME question as numbered prose, its labels and order
//     unchanged, for the agent to re-present (the fallback is the engine's, not
//     the conductor's to reconstruct);
//   - end the turn (exit 0, no answer recorded).

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAuditShardEvents } from "../../dist/codex/.codex/tools/aidlc-lib.ts";
import { REPO_ROOT, seedAidlcMemory, seededStateFile, seedWorkspaceShell } from "../harness/fixtures.ts";
import { NATIVE_RUNTIME_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_RUNTIME_CASE_TIMEOUT_MS);

const CODEX_TREE = join(REPO_ROOT, "dist", "codex", ".codex");
const STATE = readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8");
const SESSION = "019ee000-2491-7000-8000-000000000001";

const projects: string[] = [];
afterEach(() => {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t-codex-empty-picker-")));
  projects.push(dir);
  cpSync(CODEX_TREE, join(dir, ".codex"), { recursive: true });
  seedAidlcMemory(dir);
  seedWorkspaceShell(dir);
  writeFileSync(seededStateFile(dir), STATE, "utf-8");
  return dir;
}

// Fire the Codex adapter's record-human-turn with the payload Codex delivers
// for a request_user_input PostToolUse: tool_input is the question spec,
// tool_response is the structured box result.
function adapter(dir: string, toolInput: unknown, toolResponse: unknown) {
  const r = spawnSync(
    "bun",
    [join(dir, ".codex", "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"],
    {
      cwd: dir,
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "request_user_input",
        session_id: SESSION,
        cwd: dir,
        tool_input: toolInput,
        tool_response: toolResponse,
      }),
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_PROJECT_DIR: dir,
        CLAUDE_PROJECT_DIR: undefined,
        CODEX_THREAD_ID: undefined,
        AIDLC_SESSION_OVERRIDE: undefined,
        AIDLC_SESSION_OVERRIDE_SOURCE: undefined,
      } as NodeJS.ProcessEnv,
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    },
  );
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function events(dir: string): string[] {
  return readAuditShardEvents(dir).map((row) => row.event);
}

// The additionalContext the adapter forwards to Codex (its stdout is the core
// hook's JSON envelope wrapped as PostToolUse context).
function context(out: string): string {
  const line = out.trim().split("\n").find((entry) => entry.startsWith("{"));
  if (line === undefined) return out;
  const parsed = JSON.parse(line) as { hookSpecificOutput?: { additionalContext?: string } };
  return parsed.hookSpecificOutput?.additionalContext ?? out;
}

const QUESTION = "[Requirements Analysis] complete. How would you like to proceed?";
const QUESTION_SPEC = {
  questions: [{
    id: "approval",
    header: "Approval",
    question: QUESTION,
    options: [
      { label: "Approve", description: "Continue to the next stage" },
      { label: "Request Changes", description: "Provide revision feedback" },
    ],
  }],
};

describe("Codex empty structured-question result falls back to numbered prose (#2491)", () => {
  // The box's own three ways to come back empty: a timeout and a dismissal and
  // a client-side close all return {"answers":{}} under the selected-label
  // channel the adapter sets to "" — one shape, so one assertion over all.
  test("an empty box records QUESTION_UNANSWERED, no answer, and re-renders the question as numbered prose", () => {
    const dir = project();
    const r = adapter(dir, QUESTION_SPEC, JSON.stringify({ answers: {} }));
    expect(r.code, r.err).toBe(0);

    // No answer or gate decision: only the unanswered row, which spends any
    // earlier turn so nothing is recorded until the person replies.
    const recorded = events(dir);
    expect(recorded).toContain("QUESTION_UNANSWERED");
    expect(recorded).not.toContain("QUESTION_ANSWERED");
    expect(recorded).not.toContain("QUESTION_REPLIED");
    expect(recorded).not.toContain("GATE_APPROVED");
    expect(recorded).not.toContain("GATE_REJECTED");

    // The same question and its labels, in order, as numbered prose, with the
    // Other escape the questions file keeps, and a reply line that does not
    // send the person back to the box.
    const prose = context(r.out);
    expect(prose).toContain(QUESTION);
    expect(prose).toContain("1. Approve");
    expect(prose).toContain("2. Request Changes");
    expect(prose).toContain("3. Other (please specify)");
    expect(prose.indexOf("1. Approve")).toBeLessThan(prose.indexOf("2. Request Changes"));
    // The instruction names the box only to say NOT to re-ask there.
    expect(prose).toContain("not in the question box");
    expect(prose).toContain("never pick an answer for the person");
  }, NATIVE_RUNTIME_CASE_TIMEOUT_MS);

  test("a real selection is NOT treated as unanswered: no QUESTION_UNANSWERED, and the pick is recorded", () => {
    const dir = project();
    const r = adapter(dir, QUESTION_SPEC, JSON.stringify({ answers: { approval: { answers: ["Approve"] } } }));
    expect(r.code, r.err).toBe(0);
    const recorded = events(dir);
    expect(recorded).not.toContain("QUESTION_UNANSWERED");
    expect(recorded).toContain("HUMAN_TURN");
    expect(recorded).toContain("QUESTION_REPLIED");
  }, NATIVE_RUNTIME_CASE_TIMEOUT_MS);

  test("a multi-select empty box asks for the numbers, not a single number", () => {
    const dir = project();
    const spec = {
      questions: [{
        id: "pick",
        header: "Pick",
        question: "Which stages should I skip?",
        multiSelect: true,
        options: [
          { label: "Domain Design", description: "" },
          { label: "Contract Design", description: "" },
        ],
      }],
    };
    const r = adapter(dir, spec, JSON.stringify({ answers: {} }));
    expect(r.code, r.err).toBe(0);
    expect(events(dir)).toContain("QUESTION_UNANSWERED");
    const prose = context(r.out);
    expect(prose).toContain("1. Domain Design");
    expect(prose).toContain("2. Contract Design");
    expect(prose).toContain("Reply with the numbers you want");
  }, NATIVE_RUNTIME_CASE_TIMEOUT_MS);
});
