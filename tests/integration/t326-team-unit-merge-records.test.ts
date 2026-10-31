// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-unit:publish, subcommand:aidlc-unit:adopt, subcommand:aidlc-unit:land, function:transportedAuditViolation

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  auditBlockField,
  auditShardBlocks,
  readAllAuditShards,
  readUnitScopeStamp,
  writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  createTestProject,
  seedAidlcMemory,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  clone,
  gateAndLand,
  git,
  makeSeed,
  prepareCandidate,
  runMergeTool,
  stateBody,
  tempDirs,
} from "../harness/team-unit-merge.ts";

// A claimed team Unit's checkout keeps its whole audit log in a local record
// under the record's .aidlc-engine/ folder, out of every commit, and gives the
// claim's tracked shard only the rows pin takes. So a published candidate is
// the commit as it is, a teammate who adopts gets the owner's rows through the
// claim's handover parent, and after the Unit lands, the claimant's plain pull
// fast-forwards with every row kept. Real tools and hooks write the rows.

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

const AUDIT = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION_START_HOOK = join(AIDLC_SRC, "hooks", "aidlc-session-start.ts");
const LOG_SUBAGENT_HOOK = join(AIDLC_SRC, "hooks", "aidlc-log-subagent.ts");
const WRITE_AUDIT_HOOK = join(AIDLC_SRC, "hooks", "aidlc-write-audit-log.ts");
const ALLOW_DIRECT = { AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" };

function localRecord(checkout: string, shard: string): string {
  return join(seededRecordDir(checkout), ".aidlc-engine", "audit", shard);
}

function trackedShard(checkout: string, shard: string): string {
  return join(seededAuditDir(checkout), shard);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

function events(text: string): string[] {
  return auditShardBlocks(text)
    .map((block) => auditBlockField(block, "Event"))
    .filter((event): event is string => event !== null);
}

function fireHook(hookPath: string, checkout: string, stdinJson: unknown): void {
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: checkout,
    input: JSON.stringify(stdinJson),
    env: { ...process.env, CLAUDE_PROJECT_DIR: checkout },
    encoding: "utf-8",
  });
  expect(result.status, `${hookPath}: ${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
}

// The person's typed turn, as the host's prompt hook records it.
function typedTurn(checkout: string, sessionId: string): void {
  writeSessionPidEntry(checkout, process.pid, sessionId);
  const result = spawnSync(process.execPath, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: checkout,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId }),
    env: { ...process.env, AIDLC_PROJECT_DIR: checkout },
    encoding: "utf-8",
  });
  expect(result.status, `record-human-turn: ${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
}

// One Unit receipt pin takes: the hook's row for an artifact the agent wrote
// in the Unit's folder.
function artifactWrite(checkout: string, unit: string, details: string): void {
  const path = join(seededRecordDir(checkout), "construction", unit, "functional-design", "business-logic-model.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `# Business Logic Model\n\n${details}\n`);
  fireHook(WRITE_AUDIT_HOOK, checkout, {
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: path },
  });
}

// The session files the hooks write stay out of commits, as AI-DLC's shipped
// .gitignore keeps them; the engine folder's review records stay tracked, as
// this fixture's pin reads them from the candidate.
function ignoreAsShipped(checkout: string): void {
  appendFileSync(
    join(checkout, ".git", "info", "exclude"),
    "aidlc/.aidlc-sessions/\n**/.aidlc-engine/*\n!**/.aidlc-engine/reviews/\n",
  );
}

// The Unit's own stage approval, a receipt pin takes that also closes the
// person's last word for presence.
function unitGate(checkout: string, unit: string, generation: number, input: string): void {
  const appended = runMergeTool(AUDIT, [
    "append", "GATE_APPROVED",
    "--field", "Stage=functional-design",
    "--field", `Unit=${unit}`,
    "--field", `Attempt Generation=${generation}`,
    "--field", "Gate Scope=per-stage",
    "--field", "Gate Stages=functional-design",
    "--field", `User Input=${input}`,
  ], checkout, false, ALLOW_DIRECT);
  expect(appended.status, appended.out).toBe(0);
}

// A row only this checkout keeps, through the same writer.
function localRow(checkout: string, details: string): void {
  const appended = runMergeTool(AUDIT, ["append", "HEALTH_CHECKED", "--field", `Details=${details}`], checkout);
  expect(appended.status, appended.out).toBe(0);
}

// The stage asks a question and logs the person's answer, each after a typed
// turn, as a stage does.
function answerStorageQuestion(checkout: string, sessionId: string): void {
  typedTurn(checkout, sessionId);
  const asked = runMergeTool(LOG, [
    "decision", "--stage", "functional-design", "--unit", "alpha",
    "--decision", "Which storage should alpha use?", "--options", "A. Postgres,B. DynamoDB",
  ], checkout);
  expect(asked.status, asked.out).toBe(0);
  typedTurn(checkout, sessionId);
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

function claim(checkout: string, label: string): { shard: string; generation: number } {
  ignoreAsShipped(checkout);
  const claimed = runMergeTool(UNIT, ["claim", "alpha", "--team", label], checkout);
  expect(claimed.status, claimed.out).toBe(0);
  const payload = JSON.parse(claimed.stdout);
  return { shard: payload.audit_shard as string, generation: payload.generation as number };
}

function adoptInTeammateClone(remote: string, owner: string, label: string): string {
  const ref = readUnitScopeStamp(owner)!.claim_ref;
  const mate = clone(remote, label);
  ignoreAsShipped(mate);
  git(mate, ["fetch", "origin", `${ref}:${ref}`]);
  git(mate, ["switch", ref.replace(/^refs\/heads\//, "")]);
  const adopted = runMergeTool(UNIT, ["adopt", "alpha"], mate);
  expect(adopted.status, adopted.out).toBe(0);
  return mate;
}

describe("t326 team Unit records: the claimed checkout's local record", () => {
  test("a row pin would refuse stays in the local record, and the tracked shard takes only the Unit's evidence", () => {
    const { remote } = makeSeed();
    const owner = clone(remote, "alpha-owner");
    // Written before the claim, into the clone's own shard, which the claim binds.
    localRow(owner, "before the claim");
    const { shard } = claim(owner, "alpha-owner");
    expect(read(localRecord(owner, shard))).toContain("before the claim");
    expect(events(read(trackedShard(owner, shard)))).toEqual([]);

    const sessionId = "01995000-0326-7000-8000-00000000f001";
    fireHook(SESSION_START_HOOK, owner, { source: "startup" });
    answerStorageQuestion(owner, sessionId);
    artifactWrite(owner, "alpha", "alpha business logic");
    fireHook(LOG_SUBAGENT_HOOK, owner, {
      hook_event_name: "SubagentStop",
      agent_type: "aidlc-developer-agent",
      agent_id: "r1",
    });
    // Doctor exits non-zero on this synthetic tree; it still records its rows.
    runMergeTool(UTILITY, ["doctor"], owner);

    const local = read(localRecord(owner, shard));
    const tracked = read(trackedShard(owner, shard));
    for (const event of ["SESSION_STARTED", "HUMAN_TURN", "DECISION_RECORDED", "QUESTION_ANSWERED",
      "SUBAGENT_COMPLETED", "HEALTH_CHECKED", "ARTIFACT_CREATED"]) {
      expect(events(local), `local record lacks ${event}`).toContain(event);
    }
    expect(events(tracked)).toEqual(["ARTIFACT_CREATED"]);
    // The local record keeps the order rows were written in.
    expect(local.indexOf("before the claim")).toBeLessThan(local.indexOf("**Event**: SESSION_STARTED"));
    expect(local.indexOf("**Event**: QUESTION_ANSWERED")).toBeLessThan(local.indexOf("**Event**: ARTIFACT_CREATED"));
    // Kept out of commits: AI-DLC's .gitignore keeps the record's engine folder out.
    git(owner, ["add", "-A"]);
    expect(git(owner, ["diff", "--cached", "--name-only"])).not.toContain(".aidlc-engine/audit/");
  });

  test("log answers, presence and the full record read the local record and the tracked shard as one log", () => {
    const { remote } = makeSeed();
    const owner = clone(remote, "alpha-owner");
    const { shard, generation } = claim(owner, "alpha-owner");
    const sessionId = "01995000-0326-7000-8000-00000000f002";
    answerStorageQuestion(owner, sessionId);
    expect(storageAnswers(owner)).toEqual(["B. DynamoDB"]);

    // The stage's approval and then the person's turn, as near the same second
    // as a test gets: the approval is a receipt the tracked shard copies and the
    // turn is the checkout's own, and the turn still reads as after it, so a
    // decision that needs the person's word since the last one takes it.
    unitGate(owner, "alpha", generation, "approval before the turn");
    typedTurn(owner, sessionId);
    const decided = runMergeTool(LOG, [
      "decision", "--stage", "functional-design", "--unit", "alpha",
      "--decision", "Which queue should alpha use?", "--options", "A. SQS,B. Kafka",
    ], owner, true);
    expect(decided.status, decided.out).toBe(0);

    // Every row read once: the approval the tracked shard copies is not read twice.
    const all = readAllAuditShards(owner);
    expect(all.match(/approval before the turn/g) ?? []).toHaveLength(1);
    expect(events(read(trackedShard(owner, shard)))).toEqual(["GATE_APPROVED"]);
  });

  test("publish carries the commit as it is, and the claim's handover parent carries the local record", () => {
    const { remote } = makeSeed();
    const owner = clone(remote, "alpha-owner");
    const { shard } = claim(owner, "alpha-owner");
    answerStorageQuestion(owner, "01995000-0326-7000-8000-00000000f003");
    artifactWrite(owner, "alpha", "alpha business logic");
    git(owner, ["add", "-A"]);
    git(owner, ["commit", "-m", "alpha functional design in progress"]);
    const head = git(owner, ["rev-parse", "HEAD"]);
    const published = runMergeTool(UNIT, ["publish", "alpha"], owner);
    expect(published.status, published.out).toBe(0);
    const output = JSON.parse(published.stdout);
    expect(output).not.toHaveProperty("local_rows_withheld");
    expect(output.candidate_head_oid).toBe(head);

    const claimOid = output.candidate_oid as string;
    const trackedPath = relative(owner, trackedShard(owner, shard)).replaceAll("\\", "/");
    const localPath = relative(owner, localRecord(owner, shard)).replaceAll("\\", "/");
    expect(git(owner, ["rev-parse", `${claimOid}:${trackedPath}`]))
      .toBe(git(owner, ["rev-parse", `HEAD:${trackedPath}`]));
    expect(spawnSync("git", ["cat-file", "-e", `${claimOid}:${localPath}`], { cwd: owner }).status).not.toBe(0);
    expect(git(owner, ["show", `${claimOid}^2:${localPath}`]))
      .toBe(read(localRecord(owner, shard)).trimEnd());
    expect(git(owner, ["rev-parse", `${claimOid}^2^`])).toBe(head);
  });

  test("a teammate who adopts gets the owner's rows through the handover parent, and a hand-back keeps both sides'", () => {
    const { remote } = makeSeed();
    const owner = clone(remote, "alpha-owner");
    const { shard } = claim(owner, "alpha-owner");
    answerStorageQuestion(owner, "01995000-0326-7000-8000-00000000f004");
    artifactWrite(owner, "alpha", "alpha business logic");
    git(owner, ["add", "-A"]);
    git(owner, ["commit", "-m", "alpha functional design in progress"]);
    const published = runMergeTool(UNIT, ["publish", "alpha"], owner);
    expect(published.status, published.out).toBe(0);
    const ownerLocal = read(localRecord(owner, shard));

    const mate = adoptInTeammateClone(remote, owner, "alpha-teammate");
    expect(storageAnswers(mate)).toEqual(["B. DynamoDB"]);
    expect(read(localRecord(mate, shard))).toBe(ownerLocal);

    // A second adopt after the teammate's own row keeps it.
    localRow(mate, "the teammate's own row");
    const mateLocal = read(localRecord(mate, shard));
    const again = runMergeTool(UNIT, ["adopt", "alpha"], mate);
    expect(again.status, again.out).toBe(0);
    expect(read(localRecord(mate, shard))).toBe(mateLocal);

    // Handed back after the owner wrote a row of its own since its publish.
    writeFileSync(join(mate, "src", "alpha.ts"), 'export const alpha = "teammate";\n');
    git(mate, ["add", "-A"]);
    git(mate, ["commit", "-m", "alpha by the teammate"]);
    const republished = runMergeTool(UNIT, ["publish", "alpha"], mate);
    expect(republished.status, republished.out).toBe(0);
    localRow(owner, "the owner's row after its publish");
    const ref = readUnitScopeStamp(owner)!.claim_ref;
    git(owner, ["fetch", "origin", `+${ref}:${ref}`]);
    git(owner, ["switch", ref.replace(/^refs\/heads\//, "")]);
    const handedBack = runMergeTool(UNIT, ["adopt", "alpha"], owner);
    expect(handedBack.status, handedBack.out).toBe(0);
    const backLocal = read(localRecord(owner, shard));
    expect(backLocal).toContain("the teammate's own row");
    expect(backLocal).toContain("the owner's row after its publish");
    expect(backLocal.match(/Details\*\*: B\. DynamoDB/g) ?? []).toHaveLength(1);
    expect(storageAnswers(owner)).toEqual(["B. DynamoDB"]);
  });

  test("a teammate who adopts and republishes a finished Unit pins, and the owner who takes it back keeps the answer", () => {
    const { seed, remote } = makeSeed();
    const candidate = prepareCandidate(remote, "alpha", "alpha-owner", {
      afterClaim: (checkout) => {
        ignoreAsShipped(checkout);
        answerStorageQuestion(checkout, "01995000-0326-7000-8000-00000000f005");
      },
    });
    const mate = adoptInTeammateClone(remote, candidate.checkout, "alpha-teammate");
    expect(storageAnswers(mate)).toEqual(["B. DynamoDB"]);
    writeFileSync(join(mate, "src", "alpha.ts"), 'export const alpha = "teammate";\n');
    git(mate, ["add", "-A"]);
    git(mate, ["commit", "-m", "alpha finished by the teammate"]);
    const mateTracked = read(trackedShard(mate, candidate.auditShard));
    const republished = runMergeTool(UNIT, ["publish", "alpha"], mate);
    expect(republished.status, republished.out).toBe(0);
    expect(read(trackedShard(mate, candidate.auditShard))).toBe(mateTracked);

    const owner = candidate.checkout;
    const ref = readUnitScopeStamp(owner)!.claim_ref;
    git(owner, ["fetch", "origin", `+${ref}:${ref}`]);
    git(owner, ["switch", ref.replace(/^refs\/heads\//, "")]);
    const handedBack = runMergeTool(UNIT, ["adopt", "alpha"], owner);
    expect(handedBack.status, handedBack.out).toBe(0);
    expect(storageAnswers(owner)).toEqual(["B. DynamoDB"]);

    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
  });

  test("a Unit released and claimed again in the same clone pins with only the new attempt's receipts", () => {
    const { seed, remote } = makeSeed();
    const owner = clone(remote, "alpha-owner");
    const first = claim(owner, "alpha-owner");
    unitGate(owner, "alpha", first.generation, "the first attempt's approval");
    git(owner, ["add", "-A"]);
    git(owner, ["commit", "-m", "alpha, first attempt"]);
    const released = runMergeTool(UNIT, ["release", "alpha"], seed);
    expect(released.status, released.out).toBe(0);

    const candidate = prepareCandidate(remote, "alpha", "alpha-owner", { checkout: owner });
    expect(candidate.generation).toBeGreaterThan(first.generation);
    expect(candidate.auditShard).toBe(first.shard);
    expect(read(trackedShard(owner, first.shard))).not.toContain("the first attempt's approval");
    expect(read(localRecord(owner, first.shard))).toContain("the first attempt's approval");
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
  });

  test("after the Unit lands, the claimant's plain pull fast-forwards and every row is still read", () => {
    const { seed, remote } = makeSeed();
    const candidate = prepareCandidate(remote, "alpha", "alpha-owner", {
      afterClaim: (checkout) => {
        ignoreAsShipped(checkout);
        fireHook(SESSION_START_HOOK, checkout, { source: "startup" });
        localRow(checkout, "a row of the claim's own turns");
      },
    });
    const owner = candidate.checkout;
    gateAndLand(seed, "alpha");
    git(seed, ["push", "origin", "main"]);

    // The pull turn's own row, written before the pull runs.
    localRow(owner, "the pull turn");
    const pulled = spawnSync("git", ["pull", "--ff-only", "origin", "main"], { cwd: owner, encoding: "utf-8" });
    expect(pulled.status, `${pulled.stdout}${pulled.stderr}`).toBe(0);
    expect(git(owner, ["rev-parse", "HEAD"])).toBe(git(seed, ["rev-parse", "HEAD"]));
    expect(git(owner, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
    // The next turn writes again and main moves on: the next plain pull goes
    // through the same way.
    localRow(owner, "the next turn");
    writeFileSync(join(seed, "src", "after-alpha.ts"), 'export const later = "main";\n');
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "main moves on"]);
    git(seed, ["push", "origin", "main"]);
    // Landed, the checkout is no longer held to the Unit, and its next rows go
    // to its own shard as in any checkout; the pull takes main past them.
    const pulledAgain = spawnSync("git", ["pull", "--ff-only", "origin", "main"], { cwd: owner, encoding: "utf-8" });
    expect(pulledAgain.status, `${pulledAgain.stdout}${pulledAgain.stderr}`).toBe(0);
    expect(git(owner, ["rev-parse", "HEAD"])).toBe(git(seed, ["rev-parse", "HEAD"]));
    const all = readAllAuditShards(owner);
    for (const row of ["a row of the claim's own turns", "the pull turn", "the next turn", "**Event**: SESSION_STARTED"]) {
      expect(all, row).toContain(row);
    }
  });

  test("after the Unit lands, a pull with nothing uncommitted keeps every row the claim's turns wrote", () => {
    const { seed, remote } = makeSeed();
    const candidate = prepareCandidate(remote, "alpha", "alpha-owner", {
      afterClaim: (checkout) => {
        ignoreAsShipped(checkout);
        fireHook(SESSION_START_HOOK, checkout, { source: "startup" });
        localRow(checkout, "a row of the claim's own turns");
      },
    });
    const owner = candidate.checkout;
    gateAndLand(seed, "alpha");
    git(seed, ["push", "origin", "main"]);
    const pulled = spawnSync("git", ["pull", "--ff-only", "origin", "main"], { cwd: owner, encoding: "utf-8" });
    expect(pulled.status, `${pulled.stdout}${pulled.stderr}`).toBe(0);
    const all = readAllAuditShards(owner);
    expect(all).toContain("a row of the claim's own turns");
    expect(all).toContain("**Event**: SESSION_STARTED");
  });
});

describe("t326 team Unit records: checkouts with no claim write as before", () => {
  test("a solo project writes its shard where and as it always did, with no local record", () => {
    const project = createTestProject();
    tempDirs.push(project);
    seedAidlcMemory(project);
    writeFileSync(seededStateFile(project), stateBody().replace("- **Unit Ownership**: team\n", ""));
    const appended = runMergeTool(AUDIT, ["append", "HEALTH_CHECKED", "--field", "Details=solo row"], project);
    expect(appended.status, appended.out).toBe(0);
    expect(existsSync(join(seededRecordDir(project), ".aidlc-engine", "audit"))).toBe(false);
    expect(readAllAuditShards(project)).toContain("solo row");
  });

  test("the unscoped main checkout of a team project writes its tracked shard as before", () => {
    const { seed } = makeSeed();
    localRow(seed, "main's own row");
    expect(existsSync(join(seededRecordDir(seed), ".aidlc-engine", "audit"))).toBe(false);
    const shards = git(seed, ["status", "--porcelain", "--untracked-files=all"]);
    expect(shards).toContain("/audit/");
  });
});
