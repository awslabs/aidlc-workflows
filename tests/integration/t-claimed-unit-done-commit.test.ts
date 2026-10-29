// covers: file:hooks/aidlc-plan-approval-guard.ts, subcommand:aidlc-orchestrate:next, subcommand:aidlc-unit:publish, function:settleCopilotCommand
//
// A team Unit claimed in its own checkout, its stages done and approved: the
// engine's `next` says the Unit is complete there and to commit it and publish.
// On Copilot that notice is the step on record (the Stop hook ends the turn on
// it), and the plan-approval guard read it as Code Generation still running
// with no build in hand: the Unit's own commit and every file change were
// refused, with `next` as the way on, and `next` printed the same notice.
// These cases drive the real Copilot adapter and the real engine in a claimed
// checkout built on the t326 fixture:
//
//   - done, commit it: the notice names the Unit, and the commit (in a
//     spelling the guard cannot read whole), a `git rm` and a file edit all
//     pass; the commit lands and `unit publish` publishes it;
//   - no loop: once the chat is compacted the notice is out of date, a write is
//     refused with the step `next`, and running that step lets the write
//     through;
//   - what the guard still stops there is stopped as before: an unasked system
//     install, and the build itself while the Unit is not done;
//   - on Claude Code, whose step on record stays the Unit's approved build, the
//     same commit goes through as it always did.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invalidateActiveDirectiveContext } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, REPO_ROOT, seededAuditDir, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  STATE,
  UNIT,
  cleanupTempDirs,
  git,
  makeSeed,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

const COPILOT_TREE = join(REPO_ROOT, "dist", "copilot", ".aidlc");
const SESSION = "c1a1c0de-0000-4000-8000-000000003286";
const NEXT = "bun .aidlc/tools/aidlc-orchestrate.ts next";
const DONE = 'Unit "alpha" is complete and approved in this checkout.';
// The engine checks the t326 fixture's hand-written records leave out, as the
// fixture's own tool runs do (runMergeTool).
const ENGINE_ENV = {
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_DISABLE_SENSORS: "1",
};

// The claimed checkout with the Unit worked through every stage and published,
// Current Stage where the walk leaves it (the Unit's last stage, which the
// walk's own stage sync writes before that stage runs), and the Copilot
// install beside it, kept out of git as an install is.
function doneCheckout(): string {
  const { remote } = makeSeed();
  const { checkout } = prepareCandidate(remote, "alpha", "team-a");
  const state = readFileSync(seededStateFile(checkout), "utf-8");
  writeFileSync(
    seededStateFile(checkout),
    state.replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"),
  );
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-m", "alpha at its last stage"]);
  cpSync(COPILOT_TREE, join(checkout, ".aidlc"), { recursive: true });
  appendFileSync(join(checkout, ".git", "info", "exclude"), "\n.aidlc/\n");
  return checkout;
}

function runAdapter(dir: string, target: string, payload: unknown): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(process.execPath, [join(dir, ".aidlc", "hooks", "aidlc-copilot-adapter.ts"), target], {
    cwd: dir,
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: { ...process.env, ...ENGINE_ENV, AIDLC_UNATTENDED: undefined, AIDLC_PROJECT_DIR: undefined, CLAUDE_PROJECT_DIR: undefined },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

function runShell(dir: string, command: string): { status: number; stdout: string; stderr: string } {
  const shell = process.platform === "win32"
    ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
    : "/bin/bash";
  const r = spawnSync(shell, ["-c", command], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, ...ENGINE_ENV },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function bashCall(dir: string, command: string, post = false, output?: string): Record<string, unknown> {
  return {
    hook_event_name: post ? "PostToolUse" : "PreToolUse",
    session_id: SESSION,
    cwd: dir,
    tool_name: "Bash",
    tool_input: { command },
    ...(post && output !== undefined
      ? { tool_result: { result_type: "success", text_result_for_llm: `${output.trim()}\n<shellId: test completed with exit code 0>` } }
      : {}),
  };
}

// The guard's answer to one tool call: its refusal, or null when it passes.
function refusal(pre: { stdout: string; code: number; stderr: string }): string | null {
  expect(pre.code, pre.stderr).toBe(0);
  if (pre.stdout.trim() === "") return null;
  const output = JSON.parse(pre.stdout) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  return output.hookSpecificOutput?.permissionDecision === "deny"
    ? output.hookSpecificOutput.permissionDecisionReason ?? ""
    : null;
}

// A shell call the agent makes: the guard first, then the command itself.
function agentRuns(dir: string, command: string): { refused: string | null; status?: number; stdout?: string } {
  const refused = refusal(runAdapter(dir, "guard-tool-call", bashCall(dir, command)));
  if (refused !== null) return { refused };
  const ran = runShell(dir, command);
  return { refused, status: ran.status, stdout: ran.stdout };
}

// `next` the way the agent runs it on Copilot: claimed by the adapter, run as
// rewritten, and settled from its output.
function copilotNext(dir: string, command = NEXT): Record<string, unknown> {
  const attempt = crypto.randomUUID();
  const pre = runAdapter(dir, "guard-tool-call", { ...bashCall(dir, command), tool_use_id: attempt });
  expect(refusal(pre)).toBeNull();
  const rewritten = (JSON.parse(pre.stdout) as { modifiedArgs?: { command?: string } }).modifiedArgs?.command ?? "";
  expect(rewritten).toContain(`--aidlc-attempt-id ${attempt}`);
  const ran = runShell(dir, rewritten);
  expect(ran.status, ran.stderr).toBe(0);
  const post = runAdapter(dir, "post-tool", { ...bashCall(dir, rewritten, true, ran.stdout), tool_use_id: attempt });
  expect(post.code, post.stderr).toBe(0);
  return JSON.parse(ran.stdout.trim()) as Record<string, unknown>;
}

function marker(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(seededRecordDir(dir), ".aidlc-engine", "active-directive.json"), "utf-8"));
}

function editCall(dir: string, path: string): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd: dir,
    tool_name: "Edit",
    tool_input: { path, old_str: "team", new_str: "team, fixed" },
  };
}

describe("a claimed Unit's own commit once the engine says it is done", () => {
  test("on Copilot the commit, a git rm and an edit pass, and the Unit publishes", () => {
    const dir = doneCheckout();
    const notice = copilotNext(dir);
    expect(notice).toMatchObject({ kind: "notice" });
    expect(String(notice.message)).toContain(DONE);

    const source = join(dir, "src", "alpha.ts");
    expect(refusal(runAdapter(dir, "guard-tool-call", editCall(dir, source)))).toBeNull();
    writeFileSync(source, 'export const alpha = "team, fixed";\n');
    writeFileSync(join(dir, "src", "scratch.ts"), "export {};\n");
    git(dir, ["add", "src/scratch.ts"]);
    git(dir, ["commit", "-m", "scratch"]);
    const removed = agentRuns(dir, "git rm -q src/scratch.ts");
    expect(removed.refused).toBeNull();
    expect(removed.status).toBe(0);

    const committed = agentRuns(dir, "git add -A && git commit -q -m $'Complete alpha\\n\\nThe greeting is fixed.'");
    expect(committed.refused).toBeNull();
    expect(committed.status).toBe(0);
    expect(git(dir, ["log", "-1", "--format=%s"]).trim()).toBe("Complete alpha");
    expect(git(dir, ["show", "HEAD:src/alpha.ts"])).toContain("team, fixed");

    expect(marker(dir)).toMatchObject({ kind: "notice", stage: "code-generation", unit: "alpha" });
    expect(notice.unit).toBe("alpha");
  });
});
