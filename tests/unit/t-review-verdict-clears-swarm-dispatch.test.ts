// covers: function:handleReview, function:delegatedWorktreeIntent
//
// In a swarm the verdict runs with `--project-dir <worktree>` (stage-protocol-
// swarm.md, autonomous reviewer boundary) while the conductor wrote the
// reviewer dispatch record in the MAIN workspace's intent record, where the
// reviewer-scope hook reads it. The verdict removes that record too, when it is
// this review's own (same reviewer, stage and unit); another review's record
// stays. Before, only the worktree's (non-existent) record was removed and the
// main one lived on for its 6 h TTL, so on Cursor with a strict lock the next
// developer's tool calls were refused.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, boltSlugForUnit, findStageBySlug, reviewerDispatchPath, workspaceSourceFingerprint,
  workspaceSourceListing, worktreePath, writeActiveDirectiveMarker, writeBaselineSourceSnapshot, stateDigest,
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
const UNIT = "alpha";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function tool(pd: string, file: string, args: string[], input?: unknown) {
  const result = Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", file), ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: pd, env: { ...GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd }, stdout: "pipe", stderr: "pipe",
    ...(input === undefined ? {} : { stdin: Buffer.from(JSON.stringify(input)) }),
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function human(pd: string, session: string, prompt: string): void {
  succeeded(tool(pd, "aidlc.ts", ["engine", "hook", "record-human-turn"], {
    hook_event_name: "UserPromptSubmit", session_id: session, prompt,
  }));
}

function succeeded(result: ReturnType<typeof tool>): void {
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
}

function git(pd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: pd, env: GIT_ENV, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

/** A swarm at Code Generation with Guard Policy off, one Unit prepared into its worktree. */
function swarm(): { pd: string; child: string } {
  const pd = setupWorktreeFixture();
  projects.push(pd);
  seedAidlcMemory(pd);
  writeFileSync(seededStateFile(pd), `# State
## Project Information
- **Project**: Swarm verdict clears the main dispatch record
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
- [x] functional-design — EXECUTE
- [x] nfr-requirements — EXECUTE
- [x] nfr-design — EXECUTE
- [x] infrastructure-design — EXECUTE
- [-] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE
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
  seedBoltDagBatches(pd, [[UNIT], ["later"]]);
  mkdirSync(join(pd, "src"), { recursive: true });
  writeFileSync(join(pd, "src", `${UNIT}.ts`), `export const ${UNIT} = 1;\n`);
  const baseline = writeBaselineSourceSnapshot(pd, STAGE, workspaceSourceListing(pd)!);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE, "Source Baseline": baseline }, pd);
  // The verification command and the approved Code Generation plan `prepare`
  // requires before it forks a worktree (the same steps the swarm guard test takes).
  const command = "git diff --check";
  const commandIdentity = ["--stage", STAGE, "--checkpoint", "verification-command",
    "--command", command, "--session", "swarm-dispatch-command"];
  succeeded(tool(pd, "aidlc-log.ts", ["decision", ...commandIdentity,
    "--decision", "Use this command?", "--options", "Approve,Request Changes"]));
  human(pd, "swarm-dispatch-command", "Approve");
  succeeded(tool(pd, "aidlc-log.ts", ["answer", ...commandIdentity, "--details", "Approve"]));
  succeeded(tool(pd, "aidlc-state.ts", ["set-construction-verification-command", command]));
  writeActiveDirectiveMarker(pd, {
    kind: "invoke-swarm", stage: STAGE, units: [UNIT],
    state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
  });
  const contract = resolveTestingPosture(pd);
  const authority = resolveCodeGenerationAuthority(pd, { unit: UNIT });
  const dir = codeGenerationRecordDir(pd, UNIT);
  mkdirSync(dir, { recursive: true });
  for (const name of findStageBySlug(STAGE)!.produces ?? []) {
    writeFileSync(join(dir, artifactFilename(name)), `# ${UNIT} ${name}\n`);
  }
  const plan = `# Plan for ${UNIT}\n\n${renderTestingContract(contract)}\n## Steps\n- [ ] Implement ${UNIT}\n`;
  const instructions = `# Test instructions\n\nVerify ${UNIT} behavior.\n`;
  writeFileSync(join(dir, "code-generation-plan.md"), plan);
  writeFileSync(join(dir, "unit-test-instructions.md"), instructions);
  const questionsFile = join(dir, "code-generation-questions.md");
  writeFileSync(questionsFile, [
    "## Plan Approval",
    `[Approval Fingerprint]: ${approvalFingerprint(plan, instructions, contract.contract_sha256, authority)}`,
    `[Planned Source]: ${workspaceSourceFingerprint(pd)}`,
    "A. Approve Plan", "B. Request Changes", "[Answer]:", "",
  ].join("\n"));
  git(pd, ["add", "-A"]);
  git(pd, ["commit", "-qm", "swarm fixture"]);
  const session = "swarm-dispatch-plan";
  appendAuditEntry("SESSION_STARTED", { Session: session, Source: "swarm dispatch fixture" }, pd);
  const identity = ["--project-dir", pd, "--stage", STAGE, "--checkpoint", "plan-approval",
    "--unit", UNIT, "--questions-file", questionsFile, "--session", session];
  succeeded(tool(pd, "aidlc-log.ts", ["decision", ...identity,
    "--decision", "Approve this plan?", "--options", "Approve Plan,Request Changes"]));
  human(pd, session, "Approve Plan");
  writeFileSync(questionsFile, readFileSync(questionsFile, "utf-8").replace(/^\[Answer\]:.*$/m, "[Answer]: Approve Plan"));
  succeeded(tool(pd, "aidlc-log.ts", ["answer", ...identity, "--details", "Approve Plan"]));
  succeeded(tool(pd, "aidlc-swarm.ts", [
    "prepare", "--project-dir", pd, "--batch", "1", "--units", UNIT, "--base", "main",
  ]));
  const child = worktreePath(pd, fixtureIntentId8(pd), boltSlugForUnit(UNIT));
  expect(existsSync(join(child, ".aidlc", "worktree-meta.json"))).toBe(true);
  return { pd, child };
}

function dispatch(pd: string, unit: string): string {
  const path = reviewerDispatchPath(pd);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ reviewer: REVIEWER, stage: STAGE, unit, exempt: [] }));
  return path;
}

function verdict(child: string): ReturnType<typeof tool> {
  // The Unit's engine-required source manifest, as the worker leaves it.
  writeFileSync(
    join(codeGenerationRecordDir(child, UNIT), "source-manifest.json"),
    `${JSON.stringify({ stage: STAGE, unit: UNIT, version: 1, writes: [] }, null, 2)}\n`,
  );
  const review = ["review", "--stage", STAGE, "--unit", UNIT, "--reviewer", REVIEWER, "--iteration", "1", "--project-dir", child];
  const request = tool(child, "aidlc-log.ts", review);
  expect(request.out, `${request.out}\n${request.err}`).toContain('"emitted":"REVIEW_REQUESTED"');
  appendFileSync(
    join(codeGenerationRecordDir(child, UNIT), "code-generation-plan.md"),
    `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`,
  );
  return tool(child, "aidlc-log.ts", [...review, "--verdict", "READY"]);
}

describe("a swarm verdict clears the main workspace's reviewer dispatch record", () => {
  test("the verdict run in the Unit's worktree removes this review's record in the main workspace", () => {
    const { pd, child } = swarm();
    const record = dispatch(pd, UNIT);
    const result = verdict(child);
    expect(result.out, `${result.out}\n${result.err}`).toContain('"emitted":"REVIEW_COMPLETED"');
    expect(existsSync(record)).toBe(false);
  });

  test("another review's record in the main workspace stays", () => {
    const { pd, child } = swarm();
    const record = dispatch(pd, "beta");
    const result = verdict(child);
    expect(result.out, `${result.out}\n${result.err}`).toContain('"emitted":"REVIEW_COMPLETED"');
    expect(existsSync(record)).toBe(true);
  });
});
