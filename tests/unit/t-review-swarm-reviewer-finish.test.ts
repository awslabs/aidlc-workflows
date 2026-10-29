// covers: function:handleReview, function:noReviewerFinishedSinceReview, function:swarmUnitOpenReviews,
// hook:aidlc-log-subagent, audit:REVIEW_COMPLETED, audit:SUBAGENT_COMPLETED
//
// A side-by-side Unit's review on Claude Code. The conductor records the
// request and the verdict with `--project-dir <the Unit's worktree>` from the
// main folder (stage-protocol-swarm.md, autonomous reviewer boundary); the
// reviewer runs in the session's folder and writes its review file in the
// Unit's record; the SubagentStop hook runs in the main folder and records
// the reviewer's finish there. Before, the Unit's verdict read only the
// Unit's own ledger, found no reviewer finishing, and told the person "No
// reviewer finished the review" at every Unit's review (v2.11.1 did too).
// The line still comes when no reviewer finished, and every doubt in the main
// folder says nothing, as in t-review-no-reviewer-finished.
//
// Mechanism: the shipped log-subagent and deliver-stage-rules hooks and the
// log and swarm tools spawned over a real swarm fixture (DIST tree).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, boltSlugForUnit, findStageBySlug, readAllAuditShards, REVIEWER_FINISHED_FIELD,
  stateDigest, subagentInflightMarkerPath, workspaceSourceFingerprint, workspaceSourceListing, worktreePath,
  writeActiveDirectiveMarker, writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  approvalFingerprint, codeGenerationRecordDir, renderTestingContract, resolveCodeGenerationAuthority,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  AIDLC_SRC, cleanupWorktreeFixture, fixtureIntentId8, resetAidlcEnv, seedAidlcMemory, seedBoltDagBatches,
  seededStateFile, setupWorktreeFixture,
} from "../harness/fixtures.ts";
import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupWorktreeFixture(projects.pop()!);
});

const STAGE = "code-generation";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const line = (unit: string): string =>
  `No reviewer finished the review for Code Generation (${unit}); its verdict was recorded without a reviewer.`;
const CLAUDE_SHELL = { CLAUDE_CODE_SESSION_ID: "5b0c7f1e-9d2a-4c1b-8f3e-2a6d4e8b9c01" };
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

type Run = { code: number | null; out: string; err: string };

function spawn(cwd: string, script: string[], env: Record<string, string>, args: string[] = [], input?: unknown): Run {
  const result = Bun.spawnSync([process.execPath, join(AIDLC_SRC, ...script), ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd, env: { ...GIT_ENV, ...env }, stdout: "pipe", stderr: "pipe",
    ...(input === undefined ? {} : { stdin: Buffer.from(JSON.stringify(input)) }),
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function tool(pd: string, file: string, args: string[], input?: unknown): Run {
  return spawn(pd, ["tools", file], { AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd }, args, input);
}

function succeeded(result: Run): void {
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
}

function git(pd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: pd, env: GIT_ENV, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

/** A swarm at Code Generation with Guard Policy off, each Unit's plan approved and prepared into its worktree. */
function swarm(units: string[]): { pd: string; child: Record<string, string> } {
  const pd = setupWorktreeFixture();
  projects.push(pd);
  seedAidlcMemory(pd);
  writeFileSync(seededStateFile(pd), `# State
## Project Information
- **Project**: A side-by-side Unit's reviewer finishing
- **Scope**: feature
- **Project Type**: Greenfield
- **State Version**: 8
## Runtime State
- **Construction Checkpoints**: enabled
- **Construction Iteration**: stage-major
- **Construction Execution**: swarm
- **Construction Autonomy Mode**: gated
- **Skeleton Stance**: off
- **Unit Ownership**: solo
- **Review Override**: adversarial
- **Guard Policy**: off (set by you)
- **Bolt Refs**: [empty list]
- **Worktree Path**: -
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
- [x] functional-design \u2014 EXECUTE
- [x] nfr-requirements \u2014 EXECUTE
- [x] nfr-design \u2014 EXECUTE
- [x] infrastructure-design \u2014 EXECUTE
- [-] code-generation \u2014 EXECUTE
- [ ] build-and-test \u2014 EXECUTE
## Current Status
- **Current Stage**: code-generation
- **Lifecycle Phase**: CONSTRUCTION
- **Status**: Running
`);
  writeFileSync(join(pd, ".gitignore"), [
    ".aidlc/", "aidlc/.aidlc-*", "aidlc/active-space",
    "aidlc/spaces/*/intents/active-intent", "aidlc/spaces/*/intents/*/audit/",
    "aidlc/spaces/*/intents/*/runtime-graph.json", "aidlc/spaces/*/intents/*/.aidlc-*", "",
  ].join("\n"));
  seedBoltDagBatches(pd, [units, ["later"]]);
  mkdirSync(join(pd, "src"), { recursive: true });
  for (const unit of units) writeFileSync(join(pd, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  const baseline = writeBaselineSourceSnapshot(pd, STAGE, workspaceSourceListing(pd)!);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE, "Source Baseline": baseline }, pd);
  // The verification command and the approved Code Generation plans `prepare`
  // requires before it forks a worktree (the steps the swarm guard test takes).
  const command = "git diff --check";
  const commandIdentity = ["--stage", STAGE, "--checkpoint", "verification-command",
    "--command", command, "--session", "swarm-finish-command"];
  succeeded(tool(pd, "aidlc-log.ts", ["decision", ...commandIdentity,
    "--decision", "Use this command?", "--options", "Approve,Request Changes"]));
  succeeded(tool(pd, "aidlc.ts", ["engine", "hook", "record-human-turn"], {
    hook_event_name: "UserPromptSubmit", session_id: "swarm-finish-command", prompt: "Approve",
  }));
  succeeded(tool(pd, "aidlc-log.ts", ["answer", ...commandIdentity, "--details", "Approve"]));
  succeeded(tool(pd, "aidlc-state.ts", ["set-construction-verification-command", command]));
  writeActiveDirectiveMarker(pd, {
    kind: "invoke-swarm", stage: STAGE, units,
    state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
  });
  const questions: Record<string, string> = {};
  for (const unit of units) {
    const contract = resolveTestingPosture(pd);
    const authority = resolveCodeGenerationAuthority(pd, { unit });
    const dir = codeGenerationRecordDir(pd, unit);
    mkdirSync(dir, { recursive: true });
    for (const name of findStageBySlug(STAGE)!.produces ?? []) {
      writeFileSync(join(dir, artifactFilename(name)), `# ${unit} ${name}\n`);
    }
    const plan = `# Plan for ${unit}\n\n${renderTestingContract(contract)}\n## Steps\n- [ ] Implement ${unit}\n`;
    const instructions = `# Test instructions\n\nVerify ${unit} behavior.\n`;
    writeFileSync(join(dir, "code-generation-plan.md"), plan);
    writeFileSync(join(dir, "unit-test-instructions.md"), instructions);
    questions[unit] = join(dir, "code-generation-questions.md");
    writeFileSync(questions[unit], [
      "## Plan Approval",
      `[Approval Fingerprint]: ${approvalFingerprint(plan, instructions, contract.contract_sha256, authority)}`,
      `[Planned Source]: ${workspaceSourceFingerprint(pd)}`,
      "A. Approve Plan", "B. Request Changes", "[Answer]:", "",
    ].join("\n"));
  }
  git(pd, ["add", "-A"]);
  git(pd, ["commit", "-qm", "swarm fixture"]);
  for (const unit of units) {
    const session = `swarm-finish-plan-${unit}`;
    appendAuditEntry("SESSION_STARTED", { Session: session, Source: "swarm reviewer finish fixture" }, pd);
    const identity = ["--project-dir", pd, "--stage", STAGE, "--checkpoint", "plan-approval",
      "--unit", unit, "--questions-file", questions[unit], "--session", session];
    succeeded(tool(pd, "aidlc-log.ts", ["decision", ...identity,
      "--decision", "Approve this plan?", "--options", "Approve Plan,Request Changes"]));
    succeeded(tool(pd, "aidlc.ts", ["engine", "hook", "record-human-turn"], {
      hook_event_name: "UserPromptSubmit", session_id: session, prompt: "Approve Plan",
    }));
    writeFileSync(questions[unit], readFileSync(questions[unit], "utf-8").replace(/^\[Answer\]:.*$/m, "[Answer]: Approve Plan"));
    succeeded(tool(pd, "aidlc-log.ts", ["answer", ...identity, "--details", "Approve Plan"]));
  }
  succeeded(tool(pd, "aidlc-swarm.ts", [
    "prepare", "--project-dir", pd, "--batch", "1", "--units", units.join(","), "--base", "main",
  ]));
  const child: Record<string, string> = {};
  for (const unit of units) {
    child[unit] = worktreePath(pd, fixtureIntentId8(pd), boltSlugForUnit(unit));
    expect(existsSync(join(child[unit], ".aidlc", "worktree-meta.json"))).toBe(true);
    // The Unit's engine-required source manifest, as the worker leaves it.
    writeFileSync(
      join(codeGenerationRecordDir(child[unit], unit), "source-manifest.json"),
      `${JSON.stringify({ stage: STAGE, unit, version: 1, writes: [] }, null, 2)}\n`,
    );
  }
  return { pd, child };
}

/** `log review` from the conductor's own shell on Claude Code: the main folder, the chat's session. */
function logReview(pd: string, child: string, unit: string, extra: string[] = []): Run {
  return spawn(pd, ["tools", "aidlc-log.ts"], { CLAUDE_PROJECT_DIR: pd, ...CLAUDE_SHELL }, [
    "review", "--stage", STAGE, "--unit", unit, "--reviewer", REVIEWER, "--iteration", "1",
    ...extra, "--project-dir", child,
  ]);
}

/** The request, recorded in the Unit's worktree; returns the file its reviewer writes. */
function request(pd: string, child: string, unit: string): string {
  const r = logReview(pd, child, unit);
  expect(r.out, `${r.out}\n${r.err}`).toContain('"emitted":"REVIEW_REQUESTED"');
  const { reviewFile } = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { reviewFile: string };
  return isAbsolute(reviewFile) ? reviewFile : join(child, reviewFile);
}

/** The reviewer writes its review where the request told it to. */
function writes(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n\n` +
      "**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
      "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n",
    "utf-8",
  );
}

/** An agent finishes: Claude Code runs the shipped SubagentStop hook in the main folder. */
function finishes(pd: string, agent: string): void {
  succeeded(spawn(pd, ["hooks", "aidlc-log-subagent.ts"], { CLAUDE_PROJECT_DIR: pd }, [],
    { hook_event_name: "SubagentStop", agent_type: agent, agent_id: `${agent}-1` }));
}

function verdict(pd: string, child: string, unit: string): { notices: string[]; completion: string } {
  const r = logReview(pd, child, unit, ["--verdict", "READY"]);
  expect(r.code, `${r.out}\n${r.err}`).toBe(0);
  const output = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { change_notices?: string[] };
  const completions = readAllAuditShards(child).split("\n---\n").filter((b) => b.includes("**Event**: REVIEW_COMPLETED"));
  expect(completions).toHaveLength(1);
  return { notices: output.change_notices ?? [], completion: completions[0] };
}

/** The main folder's SUBAGENT_COMPLETED rows naming `agent`. */
function mainRows(pd: string, agent: string): string[] {
  return readAllAuditShards(pd).split("\n---\n")
    .filter((b) => b.includes("**Event**: SUBAGENT_COMPLETED") && b.includes(`**Agent Type**: ${agent}\n`));
}

describe("a side-by-side Unit's reviewer that finished is the reviewer finishing", () => {
  test("the reviewer wrote in the Unit's folder and finished from the main folder: no line, no mark", () => {
    const { pd, child } = swarm(["alpha"]);
    writes(request(pd, child.alpha, "alpha"));
    finishes(pd, REVIEWER);
    const rows = mainRows(pd, REVIEWER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(
      /\*\*Review File Digest\*\*: \.aidlc-engine\/reviews\/code-generation\/units\/alpha\/[^=;]+\.review\.md=[0-9a-f]{64}/,
    );
    const { notices, completion } = verdict(pd, child.alpha, "alpha");
    expect(notices).toEqual([]);
    expect(completion).not.toContain(REVIEWER_FINISHED_FIELD);
  });
});

describe("the line stays where it is true", () => {
  test("no agent finished since the request: the line, once, and the mark", () => {
    const { pd, child } = swarm(["alpha"]);
    writes(request(pd, child.alpha, "alpha"));
    const { notices, completion } = verdict(pd, child.alpha, "alpha");
    expect(notices).toEqual([line("alpha")]);
    expect(completion).toContain(`**${REVIEWER_FINISHED_FIELD}**: no`);
  });

  test("another agent finished in the main folder, the reviewer did not: the line and the mark", () => {
    const { pd, child } = swarm(["alpha"]);
    writes(request(pd, child.alpha, "alpha"));
    finishes(pd, "general-purpose");
    const { notices, completion } = verdict(pd, child.alpha, "alpha");
    expect(notices).toEqual([line("alpha")]);
    expect(completion).toContain(`**${REVIEWER_FINISHED_FIELD}**: no`);
  });
});

describe("every doubt in the main folder says nothing", () => {
  test("a completion row there since the request that names no agent: no line", () => {
    const { pd, child } = swarm(["alpha"]);
    writes(request(pd, child.alpha, "alpha"));
    finishes(pd, "");
    const { notices, completion } = verdict(pd, child.alpha, "alpha");
    expect(notices).toEqual([]);
    expect(completion).not.toContain(REVIEWER_FINISHED_FIELD);
  });

  test("a background agent sent there since the request: no line while it may still be writing", () => {
    const { pd, child } = swarm(["alpha"]);
    const file = request(pd, child.alpha, "alpha");
    succeeded(spawn(pd, ["hooks", "aidlc-deliver-stage-rules.ts"], { CLAUDE_PROJECT_DIR: pd }, [], {
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: REVIEWER, description: "review", prompt: `Review and write ${file}`, run_in_background: true },
    }));
    expect(existsSync(subagentInflightMarkerPath(pd))).toBe(true);
    writes(file);
    const { notices, completion } = verdict(pd, child.alpha, "alpha");
    expect(notices).toEqual([]);
    expect(completion).not.toContain(REVIEWER_FINISHED_FIELD);
  });
});

describe("two Units reviewed side by side by one reviewer type", () => {
  // The row names the agent type, not the review: the hook digests every open
  // Unit review of the type that finished, so one Unit's reviewer finishing
  // reads as the other's too, and that Unit's line stays unsaid. Silence,
  // never a false line.
  test("beta's reviewer finished after alpha's request, alpha's never ran: alpha's verdict says nothing", () => {
    const { pd, child } = swarm(["alpha", "beta"]);
    const alphaFile = request(pd, child.alpha, "alpha");
    writes(request(pd, child.beta, "beta"));
    finishes(pd, REVIEWER);
    writes(alphaFile);
    const { notices, completion } = verdict(pd, child.alpha, "alpha");
    expect(notices).toEqual([]);
    expect(completion).not.toContain(REVIEWER_FINISHED_FIELD);
  });

  test("beta's reviewer finished before alpha's request: alpha's line stays", () => {
    const { pd, child } = swarm(["alpha", "beta"]);
    writes(request(pd, child.beta, "beta"));
    finishes(pd, REVIEWER);
    // Across the two ledgers only the second each row carries orders them.
    Bun.sleepSync(1100);
    writes(request(pd, child.alpha, "alpha"));
    const { notices, completion } = verdict(pd, child.alpha, "alpha");
    expect(notices).toEqual([line("alpha")]);
    expect(completion).toContain(`**${REVIEWER_FINISHED_FIELD}**: no`);
  });
});
