// covers: file:hooks/aidlc-plan-approval-guard.ts, function:codeGenerationStepOnRecord, subcommand:aidlc-orchestrate:next, subcommand:aidlc-unit:publish, function:settleCopilotCommand
//
// A team Unit claimed in its own checkout, its stages done and approved: the
// engine's `next` says the Unit is complete there and to commit it and publish.
// That notice was no step on record, so the plan-approval guard still read
// Code Generation as running with no build in hand (on Copilot, which keeps
// the notice, and on every harness where no build step was on record): the
// Unit's own commit and every file change were refused with `next` as the way
// on, and `next` printed the same notice. These cases drive the real engine,
// the real guard and the real Copilot adapter in a claimed checkout built on
// the t326 fixture:
//
//   - done, commit it: the notice names the Unit and is the step on record; the
//     commit (in a spelling the guard cannot read whole), a `git rm` and a
//     file edit pass, the Unit publishes, and what publish leaves is committed;
//   - no loop: once the chat is compacted the step on record is out of date, a
//     write is refused with the step `next`, and running that step lets it in;
//   - what the guard still stops there is stopped as before: an unasked system
//     install, and a write to the code while the Unit's Code Generation is not
//     done; the unscoped checkout's board notice names no Unit;
//   - Claude Code: the same commit, `git rm` and edit pass after its `next`.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, REPO_ROOT, seededAuditDir, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  ORCH,
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
const COMMIT = "git add -A && git commit -q -m $'Complete alpha\\n\\nThe greeting is fixed.'";
// The engine checks the t326 fixture's hand-written records leave out, as the
// fixture's own tool runs do (runMergeTool).
const ENGINE_ENV = {
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_DISABLE_SENSORS: "1",
};

type Harness = "copilot" | "claude";

// The claimed checkout with the Unit worked through every stage and published,
// Current Stage where the walk leaves it (the Unit's last stage, which the
// walk's own stage sync writes before that stage runs), and the harness
// install beside it, kept out of git as an install is.
function claimedCheckout(harness: Harness, edit: (checkout: string) => void = () => {}): { checkout: string; seed: string } {
  const { seed, remote } = makeSeed();
  const { checkout } = prepareCandidate(remote, "alpha", "team-a");
  const state = readFileSync(seededStateFile(checkout), "utf-8");
  writeFileSync(
    seededStateFile(checkout),
    state.replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation"),
  );
  edit(checkout);
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-m", "alpha at its last stage"]);
  const tree = harness === "copilot" ? ".aidlc" : ".claude";
  cpSync(harness === "copilot" ? COPILOT_TREE : AIDLC_SRC, join(checkout, tree), { recursive: true });
  appendFileSync(join(checkout, ".git", "info", "exclude"), `\n${tree}/\n`);
  return { checkout, seed };
}

// The Unit's Code Generation not done: its plan approval answer blank, and the
// approval and the stage's gate not on record.
function codeGenerationNotDone(checkout: string): void {
  const questions = join(seededRecordDir(checkout), "construction", "alpha", "code-generation", "code-generation-questions.md");
  writeFileSync(questions, readFileSync(questions, "utf-8").replace(/^\[Answer\]:.*$/m, "[Answer]:"));
  for (const name of readdirSync(seededAuditDir(checkout)).filter((entry) => entry.endsWith(".md"))) {
    const path = join(seededAuditDir(checkout), name);
    const blocks = readFileSync(path, "utf-8").split(/(?<=\n---\n)/);
    writeFileSync(path, blocks.filter((block) =>
      !(block.includes("**Stage**: code-generation") &&
        (block.includes("## PLAN_APPROVAL_RECORDED") || block.includes("## GATE_APPROVED")))
    ).join(""));
  }
}

function spawn(dir: string, argv: string[], input: string | undefined, env: NodeJS.ProcessEnv) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: dir,
    ...(input === undefined ? {} : { input }),
    encoding: "utf-8",
    env: { ...process.env, ...ENGINE_ENV, AIDLC_UNATTENDED: undefined, AIDLC_PROJECT_DIR: undefined, CLAUDE_PROJECT_DIR: undefined, ...env },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

function runAdapter(dir: string, target: string, payload: unknown) {
  return spawn(dir, [process.execPath, join(dir, ".aidlc", "hooks", "aidlc-copilot-adapter.ts"), target], JSON.stringify(payload), {});
}

const SHELL = process.platform === "win32"
  ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
  : "/bin/bash";

function runShell(dir: string, command: string) {
  return spawn(dir, [SHELL, "-c", command], undefined, {});
}

function hookCall(dir: string, toolName: string, toolInput: Record<string, unknown>): Record<string, unknown> {
  return { hook_event_name: "PreToolUse", session_id: SESSION, cwd: dir, tool_name: toolName, tool_input: toolInput };
}

// The commands run in bash, so on Windows the call names that shell, as a
// call made in Git Bash does (the Copilot adapter reads it as PowerShell
// otherwise).
function bashCall(dir: string, command: string): Record<string, unknown> {
  return hookCall(dir, "Bash", { command, ...(process.platform === "win32" ? { shell: SHELL } : {}) });
}

// The guard's answer to one tool call: its refusal, or null when it passes.
function refusal(harness: Harness, dir: string, payload: Record<string, unknown>): string | null {
  if (harness === "claude") {
    const r = spawn(dir, [process.execPath, join(dir, ".claude", "hooks", "aidlc-plan-approval-guard.ts")], JSON.stringify(payload), {
      CLAUDE_PROJECT_DIR: dir,
    });
    return r.code === 0 ? null : r.stderr.trim();
  }
  const pre = runAdapter(dir, "guard-tool-call", payload);
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
function agentRuns(harness: Harness, dir: string, command: string): { refused: string | null; code?: number; stdout?: string } {
  const refused = refusal(harness, dir, bashCall(dir, command));
  if (refused !== null) return { refused };
  const ran = runShell(dir, command);
  expect(ran.code, ran.stderr).toBe(0);
  return { refused, code: ran.code, stdout: ran.stdout };
}

// `next` the way the agent runs it: on Copilot claimed by the adapter, run as
// rewritten and settled from its output; on Claude Code the engine as the
// fixture runs it (no session here has started the project's hooks).
function agentNext(harness: Harness, dir: string): Record<string, unknown> {
  if (harness === "claude") {
    const ran = runMergeTool(ORCH, ["next"], dir);
    expect(ran.status, ran.out).toBe(0);
    return JSON.parse(ran.stdout.trim()) as Record<string, unknown>;
  }
  const attempt = crypto.randomUUID();
  const pre = runAdapter(dir, "guard-tool-call", { ...bashCall(dir, NEXT), tool_use_id: attempt });
  expect(pre.code, pre.stderr).toBe(0);
  const rewritten = (JSON.parse(pre.stdout) as { modifiedArgs?: { command?: string } }).modifiedArgs?.command ?? "";
  expect(rewritten).toContain(`--aidlc-attempt-id ${attempt}`);
  const ran = runShell(dir, rewritten);
  expect(ran.code, ran.stderr).toBe(0);
  const post = runAdapter(dir, "post-tool", {
    ...bashCall(dir, rewritten),
    hook_event_name: "PostToolUse",
    tool_use_id: attempt,
    tool_result: { result_type: "success", text_result_for_llm: `${ran.stdout.trim()}\n<shellId: test completed with exit code 0>` },
  });
  expect(post.code, post.stderr).toBe(0);
  return JSON.parse(ran.stdout.trim()) as Record<string, unknown>;
}

function marker(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(seededRecordDir(dir), ".aidlc-engine", "active-directive.json"), "utf-8"));
}

function editCall(harness: Harness, dir: string, path: string): Record<string, unknown> {
  return harness === "copilot"
    ? hookCall(dir, "Edit", { path, old_str: "team", new_str: "team, fixed" })
    : hookCall(dir, "Edit", { file_path: path, old_string: "team", new_string: "team, fixed" });
}

// The person's "commit the Unit's work": an edit, a removal and the commit, each
// past the guard first.
function commitTheUnit(harness: Harness, dir: string): void {
  const source = join(dir, "src", "alpha.ts");
  expect(refusal(harness, dir, editCall(harness, dir, source))).toBeNull();
  writeFileSync(source, 'export const alpha = "team, fixed";\n');
  writeFileSync(join(dir, "src", "scratch.ts"), "export {};\n");
  git(dir, ["add", "src/scratch.ts"]);
  git(dir, ["commit", "-q", "-m", "scratch"]);
  expect(agentRuns(harness, dir, "git rm -q src/scratch.ts").refused).toBeNull();
  expect(agentRuns(harness, dir, COMMIT).refused).toBeNull();
  expect(git(dir, ["log", "-1", "--format=%s"]).trim()).toBe("Complete alpha");
  expect(git(dir, ["show", "HEAD:src/alpha.ts"])).toContain("team, fixed");
}

describe("a claimed Unit's own commit once the engine says it is done", () => {
  test("Copilot: the commit, a git rm and an edit pass, the Unit publishes, and what publish leaves commits", () => {
    const { checkout: dir } = claimedCheckout("copilot");
    const notice = agentNext("copilot", dir);
    expect(notice).toMatchObject({ kind: "notice" });
    expect(String(notice.message)).toContain(DONE);

    commitTheUnit("copilot", dir);
    expect(notice.unit).toBe("alpha");
    expect(marker(dir)).toMatchObject({ kind: "notice", stage: "code-generation", unit: "alpha" });

    const published = agentRuns("copilot", dir, "bun .aidlc/tools/aidlc.ts unit publish alpha");
    expect(published.refused).toBeNull();
    expect(JSON.parse(String(published.stdout).trim())).toMatchObject({ published: true, unit: "alpha" });
    // Whatever publish and the hooks left in the checkout commits too.
    expect(marker(dir)).toMatchObject({ kind: "notice", unit: "alpha" });
    expect(agentRuns("copilot", dir, "git add -A && git commit -q --allow-empty -m $'After publish\\n'").refused).toBeNull();
    expect(git(dir, ["log", "-1", "--format=%s"]).trim()).toBe("After publish");
  });

  test("Copilot: after the chat compacts, the refusal's own step lets the write in", () => {
    const { checkout: dir } = claimedCheckout("copilot");
    expect(agentNext("copilot", dir)).toMatchObject({ kind: "notice" });
    const compacted = runAdapter(dir, "validate-state", { hook_event_name: "PreCompact", session_id: SESSION, cwd: dir });
    expect(compacted.code, compacted.stderr).toBe(0);
    expect(marker(dir)).toMatchObject({ kind: "error" });

    const source = join(dir, "src", "alpha.ts");
    const refused = refusal("copilot", dir, editCall("copilot", dir, source));
    expect(refused).toContain(NEXT);
    expect(agentNext("copilot", dir)).toMatchObject({ kind: "notice" });
    expect(refusal("copilot", dir, editCall("copilot", dir, source))).toBeNull();
    expect(agentRuns("copilot", dir, COMMIT).refused).toBeNull();
  });

  test("what the guard stops in a claimed checkout is still stopped", () => {
    const { checkout: done, seed } = claimedCheckout("copilot");
    expect(agentNext("copilot", done)).toMatchObject({ kind: "notice" });
    const install = refusal("copilot", done, bashCall(done, "sudo apt-get install -y jq"));
    expect(install).not.toBeNull();
    expect(install).toContain("jq");

    // While the Unit's Code Generation is not done, `next` does not say it is
    // done, and a write to the Unit's code waits.
    const { checkout: waiting } = claimedCheckout("copilot", codeGenerationNotDone);
    const step = agentNext("copilot", waiting);
    expect(JSON.stringify(step)).not.toContain(DONE);
    expect(refusal("copilot", waiting, editCall("copilot", waiting, join(waiting, "src", "alpha.ts")))).not.toBeNull();

    // The unscoped checkout's board notice names no Unit.
    git(seed, ["fetch", "-q", "origin", "+refs/heads/claim/*:refs/remotes/origin/claim/*"]);
    const board = runMergeTool(ORCH, ["next"], seed);
    expect(board.status, board.out).toBe(0);
    const directive = JSON.parse(board.stdout.trim()) as Record<string, unknown>;
    expect(directive.kind).toBe("notice");
    expect(directive).not.toHaveProperty("unit");
  });

  test("Claude Code: the commit, a git rm and an edit pass after its next", () => {
    const { checkout: dir } = claimedCheckout("claude");
    expect(agentNext("claude", dir)).toMatchObject({ kind: "notice" });
    commitTheUnit("claude", dir);
    expect(marker(dir)).toMatchObject({ kind: "notice", stage: "code-generation", unit: "alpha" });
  });
});
