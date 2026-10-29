// covers: subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:adopt, function:transportedAuditViolation, function:transportableCandidateTree

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { readUnitScopeStamp, writeSessionPidEntry } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, seededAuditDir } from "../harness/fixtures.ts";
import {
  UNIT,
  appendMainHumanTurn,
  cleanupTempDirs,
  clone,
  git,
  runMergeTool,
  makeSeed,
  prepareCandidate,
} from "../harness/team-unit-merge.ts";

// A claimed team Unit's own clone writes its UNIT_*/GATE_*/REVIEW_* attempt
// receipts into the SAME per-clone audit shard that every other hook in that
// clone's session also writes into (session start/end, human-turn, subagent
// tracking, doctor, sensors, guards). publish ships whatever is in that shard;
// pin only accepts a narrow allowlist. This drives a claimed clone through
// those real hooks (not a hand-written fixture shard) so the organic rows a
// real session leaves behind are actually exercised end to end.

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

const SESSION_START_HOOK = join(AIDLC_SRC, "hooks", "aidlc-session-start.ts");
const LOG_SUBAGENT_HOOK = join(AIDLC_SRC, "hooks", "aidlc-log-subagent.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");

function fireHook(hookPath: string, checkout: string, stdinJson: unknown): void {
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: checkout,
    input: JSON.stringify(stdinJson),
    env: { ...process.env, CLAUDE_PROJECT_DIR: checkout },
    encoding: "utf-8",
  });
  expect(
    result.status,
    `${hookPath}: ${result.stdout ?? ""}${result.stderr ?? ""}`,
  ).toBe(0);
}

// record-human-turn additionally gates on this session having "joined" the
// claimed clone's own workflow (workflowParticipation), which the dispatcher
// route (the real settings.json wiring) resolves the same way the mint hook
// itself does; invoke it the same way rather than the bare hook script.
function fireHumanTurnHook(checkout: string, payload: unknown): void {
  const result = spawnSync(process.execPath, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: checkout,
    input: JSON.stringify(payload),
    env: { ...process.env, AIDLC_PROJECT_DIR: checkout },
    encoding: "utf-8",
  });
  expect(
    result.status,
    `record-human-turn: ${result.stdout ?? ""}${result.stderr ?? ""}`,
  ).toBe(0);
}

// An answered question box, as the host hands one back: the reply is keyed by
// the question's own text. This mints QUESTION_REPLIED, which no allowlist
// names - the case the 13-event version of this fix still blocked.
function firePickerReply(checkout: string, sessionId: string): void {
  const question = "Which approach should the Unit take?";
  fireHumanTurnHook(checkout, {
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    session_id: sessionId,
    tool_input: {
      questions: [{
        question,
        options: [{ label: "Keep the current shape" }, { label: "Split the module" }],
      }],
    },
    tool_response: { answers: { [question]: "Keep the current shape" } },
  });
}

describe("t326 pinned team Unit merge: organic audit noise", () => {
  test("a claimed clone's own session hooks do not poison its published candidate", () => {
    const { seed, remote } = makeSeed();
    const candidate = prepareCandidate(remote, "alpha", "alpha-organic");
    const { checkout } = candidate;

    // Real hooks, not hand-written fixture rows: a session start, a human
    // turn, a subagent completion, and a doctor run all land in the clone's
    // own shard alongside its UNIT_COMPLETED/GATE_APPROVED/... receipts.
    const sessionId = "01995000-0326-7000-8000-00000000a17a";
    fireHook(SESSION_START_HOOK, checkout, { source: "startup" });
    // Joins the claimed clone's own workflow as its session, the same way the
    // real dispatcher's own session does: without it, record-human-turn
    // mints nothing (a conversation outside the selected workflow is not a
    // human at its gates).
    writeSessionPidEntry(checkout, process.pid, sessionId);
    fireHumanTurnHook(checkout, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
    });
    firePickerReply(checkout, sessionId);
    fireHook(LOG_SUBAGENT_HOOK, checkout, {
      hook_event_name: "SubagentStop",
      agent_type: "aidlc-developer-agent",
      agent_id: "r1",
    });
    // This fixture checkout is a synthetic test project, not a full installed
    // harness tree, so doctor reports real problems (missing settings.json,
    // etc.) and exits non-zero; it still appends GUARDRAIL_LOADED/
    // HEALTH_CHECKED to the shard either way, which is all this case needs.
    runMergeTool(UTILITY, ["doctor"], checkout);

    const shardPath = join(seededAuditDir(checkout), candidate.auditShard);
    const shardAfterHooks = readFileSync(shardPath, "utf-8");
    for (
      const event of [
        "SESSION_STARTED",
        "HUMAN_TURN",
        // On neither pin's allowlist nor any hand-written noise list: the
        // proof that publish has to defer to one predicate, not a second list.
        "QUESTION_REPLIED",
        "SUBAGENT_COMPLETED",
        "GUARDRAIL_LOADED",
        "HEALTH_CHECKED",
      ]
    ) {
      expect(shardAfterHooks, `missing ${event} after firing real hooks`)
        .toContain(`**Event**: ${event}`);
    }

    git(checkout, ["add", relative(checkout, seededAuditDir(checkout))]);
    git(checkout, ["commit", "-m", "organic session activity"]);
    const republished = runMergeTool(UNIT, ["publish", "alpha"], checkout);
    expect(republished.status, republished.out).toBe(0);
    // Publish says what it kept back rather than editing the record quietly.
    expect(JSON.parse(republished.stdout).local_rows_withheld)
      .toBeGreaterThanOrEqual(6);
    // The clone's own shard still holds everything it ever wrote.
    expect(readFileSync(shardPath, "utf-8")).toBe(shardAfterHooks);

    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
  });

  test("a noise event minted before any Unit work still lets the candidate publish and pin", () => {
    // A fresh checkout's very first shard write is typically a real
    // session-start, before any Unit work exists yet: the one-line shard
    // header has no `---` separator before the first block, so it is fused
    // to that first block's own text. Pin this ordering specifically, since
    // every other case here (and the hand-written t326 fixtures generally)
    // happens to append noise AFTER the real receipts, never before.
    const { seed, remote } = makeSeed();
    const candidate = prepareCandidate(remote, "alpha", "alpha-noise-first", {
      afterClaim: (checkout) => {
        fireHook(SESSION_START_HOOK, checkout, { source: "startup" });
      },
    });

    const shardPath = join(seededAuditDir(candidate.checkout), candidate.auditShard);
    const shardBeforePublish = readFileSync(shardPath, "utf-8");
    expect(shardBeforePublish.startsWith("# AI-DLC Audit Log\n\n## Session Start\n"))
      .toBe(true);

    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
  });
});

// The owner's agent asks a Functional Design question and logs the person's
// answer, each after a typed turn, as a stage does: four rows publish withholds.
function answerStorageQuestion(checkout: string): void {
  // `aidlc log` touches the engine's turn marker, which the shipped .gitignore
  // ignores and the seed's does not.
  appendFileSync(join(checkout, ".git", "info", "exclude"), "**/.aidlc-engine/engine-touch\n");
  appendMainHumanTurn(checkout);
  const asked = runMergeTool(LOG, [
    "decision", "--stage", "functional-design", "--unit", "alpha",
    "--decision", "Which storage should alpha use?", "--options", "A. Postgres,B. DynamoDB",
  ], checkout);
  expect(asked.status, asked.out).toBe(0);
  appendMainHumanTurn(checkout);
  const answered = runMergeTool(LOG, [
    "answer", "--stage", "functional-design", "--unit", "alpha", "--details", "B. DynamoDB",
  ], checkout);
  expect(answered.status, answered.out).toBe(0);
}

function storageAnswers(checkout: string): string[] {
  const listed = runMergeTool(LOG, ["answers", "--stage", "functional-design", "--unit", "alpha"], checkout);
  expect(listed.status, listed.out).toBe(0);
  return (JSON.parse(listed.stdout).answered as Array<{ answer: string }>).map((entry) => entry.answer);
}

// A teammate's fresh clone, on the claim branch as the docs say, adopted.
function adoptInTeammateClone(remote: string, owner: string): string {
  const ref = readUnitScopeStamp(owner)!.claim_ref;
  const mate = clone(remote, "alpha-teammate");
  git(mate, ["fetch", "origin", `${ref}:${ref}`]);
  git(mate, ["switch", ref.replace(/^refs\/heads\//, "")]);
  const adopted = runMergeTool(UNIT, ["adopt", "alpha"], mate);
  expect(adopted.status, adopted.out).toBe(0);
  return mate;
}

describe("t326 team Unit adopt: the rows publish withheld", () => {
  test("a teammate who adopts a published unfinished Unit keeps the owner's answered question", () => {
    const { remote } = makeSeed();
    const owner = clone(remote, "alpha-owner");
    const claimed = runMergeTool(UNIT, ["claim", "alpha", "--team", "alpha-owner"], owner);
    expect(claimed.status, claimed.out).toBe(0);
    const auditShard = JSON.parse(claimed.stdout).audit_shard as string;
    answerStorageQuestion(owner);
    expect(storageAnswers(owner)).toEqual(["B. DynamoDB"]);
    git(owner, ["add", "-A"]);
    git(owner, ["commit", "-m", "alpha functional design in progress"]);
    const published = runMergeTool(UNIT, ["publish", "alpha"], owner);
    expect(published.status, published.out).toBe(0);
    expect(JSON.parse(published.stdout).local_rows_withheld).toBeGreaterThanOrEqual(4);

    const mate = adoptInTeammateClone(remote, owner);
    expect(storageAnswers(mate)).toEqual(["B. DynamoDB"]);
    const mateShardPath = join(seededAuditDir(mate), auditShard);
    expect(readFileSync(mateShardPath, "utf-8"))
      .toBe(readFileSync(join(seededAuditDir(owner), auditShard), "utf-8"));

    // A second adopt after the teammate's own work keeps that work.
    appendMainHumanTurn(mate);
    const mateShard = readFileSync(mateShardPath, "utf-8");
    const again = runMergeTool(UNIT, ["adopt", "alpha"], mate);
    expect(again.status, again.out).toBe(0);
    expect(readFileSync(mateShardPath, "utf-8")).toBe(mateShard);
  });

  test("a teammate who adopts and republishes a finished Unit still pins with the shard trimmed", () => {
    const { seed, remote } = makeSeed();
    const candidate = prepareCandidate(remote, "alpha", "alpha-owner", {
      afterClaim: answerStorageQuestion,
    });
    const mate = adoptInTeammateClone(remote, candidate.checkout);
    expect(storageAnswers(mate)).toEqual(["B. DynamoDB"]);

    writeFileSync(join(mate, "src", "alpha.ts"), 'export const alpha = "teammate";\n');
    git(mate, ["add", "-A"]);
    git(mate, ["commit", "-m", "alpha finished by the teammate"]);
    const mateShardPath = join(seededAuditDir(mate), candidate.auditShard);
    const mateShard = readFileSync(mateShardPath, "utf-8");
    const republished = runMergeTool(UNIT, ["publish", "alpha"], mate);
    expect(republished.status, republished.out).toBe(0);
    expect(JSON.parse(republished.stdout).local_rows_withheld).toBeGreaterThanOrEqual(4);
    expect(readFileSync(mateShardPath, "utf-8")).toBe(mateShard);

    // Handed back: the owner adopts the teammate's publication.
    const owner = candidate.checkout;
    const ref = readUnitScopeStamp(owner)!.claim_ref;
    git(owner, ["fetch", "origin", `${ref}:${ref}`]);
    git(owner, ["switch", ref.replace(/^refs\/heads\//, "")]);
    const handedBack = runMergeTool(UNIT, ["adopt", "alpha"], owner);
    expect(handedBack.status, handedBack.out).toBe(0);
    expect(storageAnswers(owner)).toEqual(["B. DynamoDB"]);
    expect(readFileSync(join(seededAuditDir(owner), candidate.auditShard), "utf-8")).toBe(mateShard);

    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
  });
});
