// covers: function:handleReview, function:noReviewerFinishedSinceReview, hook:aidlc-log-subagent,
// hook:aidlc-state-transition-guard, function:violatesRuntimeIntegrity, audit:REVIEW_COMPLETED,
// audit:SUBAGENT_COMPLETED
//
// #943 follow-up to #2427. On Claude Code a verdict recorded when no reviewer
// finished since its request is marked `Reviewer Finished Before Verdict: no`
// and said to the person. The main agent could clear that mark with ordinary
// allowed steps; each route is closed here, the mark-not-refuse design kept:
//
// - Another agent finishing is not the reviewer finishing. Only a
//   SUBAGENT_COMPLETED row that names the reviewer the request named and
//   carries the Review File Digest for that request's review file counts.
// - The hooks' heartbeats and drop logs (`.aidlc-engine/hooks-health/`) are the
//   hooks' own: a tool call may not write them, as with the kept gate words.
// - Claude Code's chat name (CLAUDE_CODE_SESSION_ID) may not be removed from a
//   command (`unset`, `env -u`, `env -i` before an AI-DLC command) or set.
//
// Mechanism: the shipped log-subagent hook, the log and state tools, and the
// PreToolUse guard hook spawned over a real ledger (DIST tree), plus the
// runtime-integrity predicate in-process.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { violatesRuntimeIntegrity } from "../../dist/claude/.claude/hooks/runtime-integrity.ts";
import {
  hooksHealthDir,
  readAllAuditShards,
  resolveWorkflowSelection,
  REVIEWER_FINISHED_FIELD,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seedAidlcMemory,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DIST_CLAUDE = join(REPO_ROOT, "dist", "claude", ".claude");
const LOG_TOOL = join(DIST_CLAUDE, "tools", "aidlc-log.ts");
const STATE_TOOL = join(DIST_CLAUDE, "tools", "aidlc-state.ts");
const SUBAGENT_HOOK = join(DIST_CLAUDE, "hooks", "aidlc-log-subagent.ts");
const GUARD_HOOK = join(DIST_CLAUDE, "hooks", "aidlc-state-transition-guard.ts");
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const LINE = "No reviewer finished the review for Requirements Analysis; its verdict was recorded without a reviewer.";
const REFUSAL = "AIDLC runtime records and hooks belong to the harness";
const CLAUDE_SHELL = { CLAUDE_CODE_SESSION_ID: "5b0c7f1e-9d2a-4c1b-8f3e-2a6d4e8b9c01" };
const VERDICT_COMMAND = `bun .claude/tools/aidlc-log.ts review --stage ${STAGE} --reviewer ${REVIEWER} --iteration 1 --verdict READY`;

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function project(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAidlcMemory(p);
  seedStateFile(p, join(FIXTURES_DIR, "state-mid-inception.md"));
  const dir = join(seededRecordDir(p), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "requirements.md"), "# Requirements\n");
  writeFileSync(join(dir, "requirements-analysis-questions.md"), "# Requirements Questions\n");
  return p;
}

function spawn(args: string[], env: Record<string, string>, input?: string): { status: number; out: string } {
  const r = spawnSync(BUN, args, {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...process.env, AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1", ...env },
    ...(input === undefined ? {} : { input }),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function logReview(p: string, extra: string[]): { status: number; out: string } {
  return spawn([LOG_TOOL, "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1", ...extra, "--project-dir", p], CLAUDE_SHELL);
}

/** The request; returns the review file's absolute path. */
function request(p: string): string {
  const r = logReview(p, []);
  expect(r.out, r.out).toContain('"emitted":"REVIEW_REQUESTED"');
  const { reviewFile } = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { reviewFile: string };
  return join(p, reviewFile);
}

/** The main agent writes the review file itself. */
function writes(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nWritten by the main agent.\n\n` +
      "**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
      "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n",
    "utf-8",
  );
}

/** An agent finishes: the shipped SubagentStop hook records SUBAGENT_COMPLETED. */
function finishes(p: string, agent: string): void {
  const r = spawn(
    [SUBAGENT_HOOK],
    { CLAUDE_PROJECT_DIR: p },
    JSON.stringify({ hook_event_name: "SubagentStop", agent_type: agent, agent_id: `${agent}-1` }),
  );
  expect(r.status, r.out).toBe(0);
}

function verdict(p: string): { notices: string[]; completion: string } {
  const r = logReview(p, ["--verdict", "READY"]);
  expect(r.status, r.out).toBe(0);
  const output = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { change_notices?: string[] };
  const completions = readAllAuditShards(p).split("\n---\n").filter((b) => b.includes("**Event**: REVIEW_COMPLETED"));
  expect(completions).toHaveLength(1);
  return { notices: output.change_notices ?? [], completion: completions[0] };
}

function gateStart(p: string): string {
  const r = spawn([STATE_TOOL, "gate-start", STAGE, "--project-dir", p], {
    ...CLAUDE_SHELL,
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  });
  expect(r.status, r.out).toBe(0);
  return r.out;
}

/** The PreToolUse guard the harness runs before a tool call, as Claude Code runs it. */
function guard(p: string, tool_name: string, tool_input: Record<string, unknown>): { status: number; out: string } {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: p, ...CLAUDE_SHELL } as Record<string, string>;
  delete env.AIDLC_STATE_TRANSITION_OWNER;
  delete env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS;
  const r = spawnSync(BUN, [GUARD_HOOK], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: p, tool_name, tool_input }),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("another agent finishing is not the reviewer finishing", () => {
  test("an unrelated agent finished after the request: the verdict is still marked and said, once at the gate", () => {
    const p = project();
    writes(request(p));
    finishes(p, "general-purpose");
    const { notices, completion } = verdict(p);
    expect(notices).toEqual([LINE]);
    expect(completion).toContain(`**${REVIEWER_FINISHED_FIELD}**: no`);
    expect(gateStart(p).split(LINE)).toHaveLength(2);
  });

  test("several unrelated agents, and their heartbeats, leave the mark in place", () => {
    const p = project();
    writes(request(p));
    for (const agent of ["general-purpose", "Explore", "aidlc-developer-agent"]) finishes(p, agent);
    const { notices, completion } = verdict(p);
    expect(notices).toEqual([LINE]);
    expect(completion).toContain(`**${REVIEWER_FINISHED_FIELD}**: no`);
  });

  test("the reviewer finishing after an unrelated agent still clears it", () => {
    const p = project();
    const file = request(p);
    finishes(p, "general-purpose");
    writes(file);
    finishes(p, REVIEWER);
    const { notices, completion } = verdict(p);
    expect(notices).toEqual([]);
    expect(completion).not.toContain(REVIEWER_FINISHED_FIELD);
  });

  test("a completion row that names no agent is still a doubt: no mark", () => {
    const p = project();
    writes(request(p));
    finishes(p, "");
    const { notices, completion } = verdict(p);
    expect(notices).toEqual([]);
    expect(completion).not.toContain(REVIEWER_FINISHED_FIELD);
  });
});

describe("the hooks' heartbeats and drop logs are the hooks' own", () => {
  test("a tool call may not write, touch, or remove a heartbeat or drop log, in either folder name", () => {
    const p = project();
    const health = relative(p, hooksHealthDir(p, resolveWorkflowSelection(p).intent ?? undefined, resolveWorkflowSelection(p).space));
    expect(health).toMatch(/\.aidlc-engine\/hooks-health$/);
    const beat = `${health}/log-subagent.last`;
    const legacy = beat.replace(".aidlc-engine/hooks-health", ".aidlc-hooks-health");
    for (const [tool_name, tool_input] of [
      ["Write", { file_path: beat, content: new Date().toISOString() }],
      ["Write", { file_path: join(p, beat), content: new Date().toISOString() }],
      ["Write", { file_path: `${health}/log-subagent.drops`, content: "" }],
      ["Edit", { file_path: beat, old_string: "a", new_string: "b" }],
      ["Write", { file_path: legacy, content: new Date().toISOString() }],
      ["Write", { file_path: beat.replace(".aidlc-engine/hooks-health", ".AIDLC-Engine/Hooks-Health"), content: "x" }],
      ["Bash", { command: `touch ${beat}` }],
      ["Bash", { command: `date -u +%Y-%m-%dT%H:%M:%SZ > ${beat}` }],
      ["Bash", { command: `printf x | tee ${beat}` }],
      ["Bash", { command: `rm -f ${health}/log-subagent.drops` }],
      ["Bash", { command: `mkdir -p ${health}` }],
      ["Bash", { command: `cp /dev/null ${beat}` }],
      ["Bash", { command: `node -e "require('node:fs').writeFileSync('${beat}', new Date().toISOString())"` }],
      ["Bash", { command: `touch ${legacy}` }],
    ] as const) {
      const r = guard(p, tool_name, tool_input);
      expect(r.status, `${tool_name} ${JSON.stringify(tool_input)}: ${r.out}`).toBe(2);
      expect(r.out, tool_name).toContain(REFUSAL);
    }
  });

  test("reading them, and writing the rest of the engine directory, stay allowed", () => {
    const p = project();
    const health = relative(p, hooksHealthDir(p, resolveWorkflowSelection(p).intent ?? undefined, resolveWorkflowSelection(p).space));
    for (const [tool_name, tool_input] of [
      ["Bash", { command: `cat ${health}/log-subagent.last` }],
      ["Bash", { command: `ls ${health}` }],
      ["Write", { file_path: `${dirname(health)}/reviewer-dispatch.json`, content: "{}" }],
      ["Bash", { command: `echo x > ${dirname(health)}/hooks-healthy.json` }],
    ] as const) {
      const r = guard(p, tool_name, tool_input);
      expect(r.status, `${tool_name} ${JSON.stringify(tool_input)}: ${r.out}`).toBe(0);
    }
  });

  test("the hook's own heartbeat is still written when an agent finishes", () => {
    const p = project();
    const selection = resolveWorkflowSelection(p);
    finishes(p, "general-purpose");
    const beat = readFileSync(join(hooksHealthDir(p, selection.intent ?? undefined, selection.space), "log-subagent.last"), "utf-8");
    expect(Number.isFinite(Date.parse(beat.trim()))).toBe(true);
  });
});

describe("Claude Code's chat name stays in the command", () => {
  const refused = (command: string) => violatesRuntimeIntegrity({ cwd: "/tmp/p", tool_name: "Bash", tool_input: { command } });

  test("removing or setting CLAUDE_CODE_SESSION_ID before a command is refused", () => {
    for (const command of [
      `env -u CLAUDE_CODE_SESSION_ID ${VERDICT_COMMAND}`,
      `env -uCLAUDE_CODE_SESSION_ID ${VERDICT_COMMAND}`,
      `env --unset=CLAUDE_CODE_SESSION_ID ${VERDICT_COMMAND}`,
      `env --unset CLAUDE_CODE_SESSION_ID ${VERDICT_COMMAND}`,
      `unset CLAUDE_CODE_SESSION_ID; ${VERDICT_COMMAND}`,
      `(unset CLAUDE_CODE_SESSION_ID && ${VERDICT_COMMAND})`,
      `bash -c 'unset CLAUDE_CODE_SESSION_ID; ${VERDICT_COMMAND}'`,
      `CLAUDE_CODE_SESSION_ID= ${VERDICT_COMMAND}`,
      `export CLAUDE_CODE_SESSION_ID=other; ${VERDICT_COMMAND}`,
      `env -i PATH="$PATH" HOME="$HOME" ${VERDICT_COMMAND}`,
      `env - PATH="$PATH" ${VERDICT_COMMAND}`,
      `env --ignore-environment PATH="$PATH" bun .claude/tools/aidlc.ts engine log review --verdict READY`,
      `env -i PATH="$PATH" aidlc engine log review --verdict READY`,
      `unset CODEX_THREAD_ID; bun .codex/tools/aidlc.ts next`,
    ]) {
      expect(refused(command), command).toBe(true);
    }
  });

  test("reading it, and env -i or env -u for anything else, stay allowed", () => {
    for (const command of [
      VERDICT_COMMAND,
      `echo "$CLAUDE_CODE_SESSION_ID"`,
      `printenv CLAUDE_CODE_SESSION_ID`,
      `env -u NODE_OPTIONS ${VERDICT_COMMAND}`,
      `env -i PATH=/usr/bin ls`,
      `env -i GIT_DIR=/tmp/aidlc-project/.git git status`,
      `unset NODE_OPTIONS; bun test`,
    ]) {
      expect(refused(command), command).toBe(false);
    }
  });

  test("the shipped guard refuses the env-stripped verdict as Claude Code runs it", () => {
    const p = project();
    const stripped = guard(p, "Bash", { command: `env -u CLAUDE_CODE_SESSION_ID ${VERDICT_COMMAND}` });
    expect(stripped.status, stripped.out).toBe(2);
    expect(stripped.out).toContain(REFUSAL);
    const plain = guard(p, "Bash", { command: VERDICT_COMMAND });
    expect(plain.status, plain.out).toBe(0);
  });
});
