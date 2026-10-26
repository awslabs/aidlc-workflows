// covers: function:noReviewerFinishedSinceReview, function:recordSubagentDispatch,
// function:subagentDispatchesShowNoReviewer, hook:aidlc-deliver-stage-rules, hook:aidlc-log-subagent,
// audit:SUBAGENT_DISPATCHED, audit:SUBAGENT_COMPLETED, audit:REVIEW_COMPLETED, subcommand:aidlc-state:gate-start
//
// A review requested from the product lead and written by the architecture
// reviewer was recorded as the product lead's clean review on every harness
// but Claude Code (a live opencode run, 2 of 3 rounds): only Claude Code's
// completion row is known to land before the result, so elsewhere a missing
// reviewer row was no evidence. Now every helper sent is recorded when it is
// sent (SUBAGENT_DISPATCHED, by the dispatch hook every adapter already runs,
// or a SubagentStart the adapter forwards) and closed by its completion. Off
// Claude Code a verdict is marked "no reviewer finished" only when the record
// shows a helper sent since the request, every one sent since then back, and
// none of them the reviewer. A helper still out (a failed or cancelled task, a
// row still to land), the reviewer sent at all, a helper with no name or
// several names, or nothing sent: no mark. Claude Code keeps today's evidence
// as it is, #943 included.
//
// Mechanism: each tree's own log tool, dispatch hook and log-subagent hook
// spawned over a real ledger, with the payloads the adapters forward.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readAllAuditShards, REVIEWER_FINISHED_FIELD } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
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
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const OTHER = "aidlc-architecture-reviewer-agent";
const SESSION = "01995000-7a11-7000-8000-00000000d1a7";
const LINE = "No reviewer finished the review for Requirements Analysis; its verdict was recorded without a reviewer.";

interface Tree {
  name: string;
  tools: string;
  hooks: string;
  env: Record<string, string | undefined>;
}

// The runner's shell can be Claude Code's own; a tree other than Claude Code's
// runs with none of its variables.
const plainShell: Record<string, string | undefined> = { ...process.env };
for (const key of Object.keys(plainShell)) if (/^CLAUDE/.test(key)) delete plainShell[key];
const OPENCODE: Tree = {
  name: "opencode",
  tools: join(REPO_ROOT, "dist", "opencode", ".aidlc", "tools"),
  hooks: join(REPO_ROOT, "dist", "opencode", ".aidlc", "hooks"),
  env: { ...plainShell, OPENCODE: "1" },
};
const CLAUDE: Tree = {
  name: "claude",
  tools: join(REPO_ROOT, "dist", "claude", ".claude", "tools"),
  hooks: join(REPO_ROOT, "dist", "claude", ".claude", "hooks"),
  env: { ...plainShell, CLAUDE_CODE_SESSION_ID: "5b0c7f1e-9d2a-4c1b-8f3e-2a6d4e8b9c01" },
};

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

function spawn(tree: Tree, args: string[], extra: Record<string, string> = {}, input?: string) {
  const r = spawnSync(BUN, args, {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...tree.env, AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1", ...extra } as Record<string, string>,
    ...(input === undefined ? {} : { input }),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function json(out: string): Record<string, unknown> {
  return JSON.parse(out.slice(out.indexOf("{"))) as Record<string, unknown>;
}

function logReview(tree: Tree, p: string, extra: string[]) {
  return spawn(tree, [
    join(tree.tools, "aidlc-log.ts"), "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1",
    ...extra, "--project-dir", p,
  ]);
}

function request(tree: Tree, p: string): string {
  const r = logReview(tree, p, []);
  expect(r.out, r.out).toContain('"emitted":"REVIEW_REQUESTED"');
  return join(p, json(r.out).reviewFile as string);
}

function review(signer: string): string {
  return (
    `**Verdict:** READY\n**Reviewer:** ${signer}\n**Iteration:** 1\n**Verdict Dictated:** no\n\n### Findings\n\n` +
    "**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
    "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n"
  );
}

function writes(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf-8");
}

const HOOK_ENV = (p: string) => ({ AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p });

/** The helper is sent: the dispatch hook every adapter but Cursor's and Kiro IDE's runs at PreToolUse. */
function sends(tree: Tree, p: string, toolInput: Record<string, unknown>, toolName = "task"): void {
  const r = spawn(
    tree,
    [join(tree.hooks, "aidlc-deliver-stage-rules.ts")],
    HOOK_ENV(p),
    JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, tool_name: toolName, tool_input: toolInput, cwd: p }),
  );
  expect(r.status, r.out).toBe(0);
}

/** The helper is sent, as Cursor's and Kiro IDE's adapters forward it. */
function starts(tree: Tree, p: string, agent: string): void {
  const r = spawn(
    tree,
    [join(tree.hooks, "aidlc-log-subagent.ts")],
    HOOK_ENV(p),
    JSON.stringify({ hook_event_name: "SubagentStart", session_id: SESSION, agent_type: agent }),
  );
  expect(r.status, r.out).toBe(0);
}

/** The helper comes back: the tree's own SubagentStop hook. */
function finishes(tree: Tree, p: string, agent: string): void {
  const r = spawn(
    tree,
    [join(tree.hooks, "aidlc-log-subagent.ts")],
    HOOK_ENV(p),
    JSON.stringify({ hook_event_name: "SubagentStop", session_id: SESSION, agent_type: agent, agent_id: `${agent}-1` }),
  );
  expect(r.status, r.out).toBe(0);
}

function blocks(p: string, event: string): string[] {
  return readAllAuditShards(p).split("\n---\n").filter((b) => b.includes(`**Event**: ${event}`));
}

function verdict(tree: Tree, p: string): { notices: string[]; completion: string } {
  const r = logReview(tree, p, ["--verdict", "READY"]);
  expect(r.status, r.out).toBe(0);
  const out = json(r.out) as { change_notices?: string[] };
  const completion = blocks(p, "REVIEW_COMPLETED");
  expect(completion).toHaveLength(1);
  return { notices: out.change_notices ?? [], completion: completion[0] };
}

function gateStart(tree: Tree, p: string): string {
  const r = spawn(tree, [join(tree.tools, "aidlc-state.ts"), "gate-start", STAGE, "--project-dir", p], {
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  });
  expect(r.status, r.out).toBe(0);
  return r.out;
}

function marked(tree: Tree, p: string): void {
  const { notices, completion } = verdict(tree, p);
  expect(completion).toContain(`**${REVIEWER_FINISHED_FIELD}**: no`);
  expect(notices).toEqual([LINE]);
  expect(gateStart(tree, p).split(LINE)).toHaveLength(2);
}

function unmarked(tree: Tree, p: string): void {
  const { notices, completion } = verdict(tree, p);
  expect(completion).not.toContain(REVIEWER_FINISHED_FIELD);
  expect(notices).not.toContain(LINE);
  expect(gateStart(tree, p)).not.toContain(LINE);
}

describe("each helper sent is on record, and its return closes it", () => {
  test("the dispatch hook writes one row per helper it lets go; SubagentStart writes the same row; a completion is still a completion", () => {
    const p = project();
    sends(OPENCODE, p, { subagent_type: OTHER, prompt: "Review the requirements." });
    starts(OPENCODE, p, REVIEWER);
    expect(blocks(p, "SUBAGENT_DISPATCHED").map((b) => /\*\*Agent Type\*\*: (\S+)/.exec(b)?.[1])).toEqual([OTHER, REVIEWER]);
    expect(blocks(p, "SUBAGENT_COMPLETED")).toHaveLength(0);
    finishes(OPENCODE, p, OTHER);
    expect(blocks(p, "SUBAGENT_COMPLETED")).toHaveLength(1);
    expect(blocks(p, "SUBAGENT_DISPATCHED")).toHaveLength(2);
  });

  test("a crew dispatch is one row naming its roles as read", () => {
    const p = project();
    sends(OPENCODE, p, { stages: [{ role: OTHER, prompt_template: "a" }, { role: REVIEWER, prompt_template: "b" }] }, "subagent");
    expect(blocks(p, "SUBAGENT_DISPATCHED").map((b) => /\*\*Agent Type\*\*: (\S+)/.exec(b)?.[1])).toEqual([`${OTHER},${REVIEWER}`]);
  });
});

describe("off Claude Code: another agent's review is marked when the record proves the reviewer never ran", () => {
  test("round 2: the architecture reviewer was sent and came back, the review is signed as the product lead", () => {
    const p = project();
    const file = request(OPENCODE, p);
    sends(OPENCODE, p, { subagent_type: OTHER, prompt: "Review the requirements." });
    writes(file, review(REVIEWER));
    finishes(OPENCODE, p, OTHER);
    marked(OPENCODE, p);
  });

  test("round 3: signed as itself, refused first; the Reviewer line rewritten by hand is marked", () => {
    const p = project();
    const file = request(OPENCODE, p);
    sends(OPENCODE, p, { subagent_type: OTHER, prompt: "Review the requirements." });
    writes(file, review(OTHER));
    finishes(OPENCODE, p, OTHER);
    expect(logReview(OPENCODE, p, ["--verdict", "READY"]).status).toBe(1);
    writes(file, review(REVIEWER));
    marked(OPENCODE, p);
  });

  test("a helper's name in another case closes its own dispatch (Copilot lowercases the dispatch name)", () => {
    const p = project();
    const file = request(OPENCODE, p);
    sends(OPENCODE, p, { subagent_type: OTHER, prompt: "Review the requirements." });
    writes(file, review(REVIEWER));
    finishes(OPENCODE, p, OTHER.toUpperCase());
    marked(OPENCODE, p);
  });
});

describe("off Claude Code: anything that could be the reviewer's work, or anything still out, marks nothing", () => {
  test("the reviewer was sent, wrote its review, and its task failed or was cancelled (no completion)", () => {
    const p = project();
    const file = request(OPENCODE, p);
    sends(OPENCODE, p, { subagent_type: REVIEWER, prompt: "Review the requirements." });
    writes(file, review(REVIEWER));
    unmarked(OPENCODE, p);
  });

  test("the reviewer wrote its review and its row is still to land; another helper came back after", () => {
    const p = project();
    const file = request(OPENCODE, p);
    sends(OPENCODE, p, { subagent_type: REVIEWER, prompt: "Review the requirements." });
    sends(OPENCODE, p, { subagent_type: "aidlc-developer-agent", prompt: "Scan the code." });
    writes(file, review(REVIEWER));
    finishes(OPENCODE, p, "aidlc-developer-agent");
    unmarked(OPENCODE, p);
  });

  test("another helper is still out", () => {
    const p = project();
    const file = request(OPENCODE, p);
    sends(OPENCODE, p, { subagent_type: OTHER, prompt: "Review the requirements." });
    sends(OPENCODE, p, { subagent_type: "aidlc-developer-agent", prompt: "Scan the code." });
    writes(file, review(REVIEWER));
    finishes(OPENCODE, p, OTHER);
    unmarked(OPENCODE, p);
  });

  test("a helper sent with no name, or a crew of several, came back", () => {
    for (const toolInput of [
      { prompt: "Review the requirements." },
      { stages: [{ role: OTHER, prompt_template: "a" }, { role: "aidlc-developer-agent", prompt_template: "b" }] },
    ]) {
      const p = project();
      const file = request(OPENCODE, p);
      sends(OPENCODE, p, toolInput, "stages" in toolInput ? "subagent" : "task");
      writes(file, review(REVIEWER));
      finishes(OPENCODE, p, "stages" in toolInput ? `${OTHER},aidlc-developer-agent` : "unknown");
      unmarked(OPENCODE, p);
    }
  });

  test("nothing was sent since the request (the conductor wrote it): no proof, no mark", () => {
    const p = project();
    sends(OPENCODE, p, { subagent_type: "aidlc-developer-agent", prompt: "Scan the code." });
    finishes(OPENCODE, p, "aidlc-developer-agent");
    const file = request(OPENCODE, p);
    writes(file, review(REVIEWER));
    unmarked(OPENCODE, p);
  });

  test("the reviewer was sent and came back: its own review, clean", () => {
    const p = project();
    const file = request(OPENCODE, p);
    sends(OPENCODE, p, { subagent_type: REVIEWER, prompt: "Review the requirements." });
    writes(file, review(REVIEWER));
    finishes(OPENCODE, p, REVIEWER);
    unmarked(OPENCODE, p);
  });

  test("a helper sent before the request and back after it proves nothing about this review", () => {
    const p = project();
    sends(OPENCODE, p, { subagent_type: OTHER, prompt: "Review the requirements." });
    const file = request(OPENCODE, p);
    writes(file, review(REVIEWER));
    finishes(OPENCODE, p, OTHER);
    unmarked(OPENCODE, p);
  });
});

describe("Claude Code keeps today's evidence", () => {
  test("#943: the reviewer's dispatch failed (no SubagentStop) and the conductor wrote the review: marked, as today", () => {
    const p = project();
    const file = request(CLAUDE, p);
    sends(CLAUDE, p, { subagent_type: REVIEWER, prompt: "Review the requirements." }, "Task");
    writes(file, review(REVIEWER));
    marked(CLAUDE, p);
  });

  test("another agent sent and back, the review signed as the reviewer: marked, as today", () => {
    const p = project();
    const file = request(CLAUDE, p);
    sends(CLAUDE, p, { subagent_type: OTHER, prompt: "Review the requirements." }, "Task");
    writes(file, review(REVIEWER));
    finishes(CLAUDE, p, OTHER);
    marked(CLAUDE, p);
  });
});
