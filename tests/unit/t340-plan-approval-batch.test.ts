// covers: subcommand:aidlc-log:decision, subcommand:aidlc-log:answer,
// function:recordPlanApprovalReceipt, function:evaluateCodeGenerationApproval,
// function:beginCodeGeneration, hook:aidlc-record-human-turn

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  readPlanApprovalChallenge,
  readPlanApprovalReceipt,
  readPlanApprovalResponse,
  sessionsDir,
  stateDigest,
  workspaceSourceFingerprint,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  approvalFingerprint,
  beginCodeGeneration,
  codeGenerationRecordDir,
  evaluateCodeGenerationApproval,
  recordPlanApprovalBatchReceipts,
  renderTestingContract,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  resetAidlcEnv,
  seedBoltDagBatches,
  seededRecordDir,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

resetAidlcEnv();
const projects: string[] = [];
const SESSION = "batch-review";
const UNITS = ["auth", "api"];
type Fixture = { project: string; file: string; units: Array<{ unit: string; questionsFile: string }> };
afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
}, 30_000);

function run(project: string, tool: string, args: string[], payload?: unknown) {
  const result = Bun.spawnSync([process.execPath, join(AIDLC_SRC, tool), ...args], {
    cwd: project,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    ...(payload === undefined ? {} : { stdin: Buffer.from(JSON.stringify(payload)) }),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function publish(project: string, units: string[] | null = UNITS): void {
  writeActiveDirectiveMarker(project, {
    kind: units === null ? "run-stage" : "invoke-swarm",
    stage: "code-generation",
    ...(units === null ? {} : { units }),
    state_sha256: stateDigest(readFileSync(seededStateFile(project), "utf-8")),
  });
}

function plan(project: string, unit: string | null): string {
  const authority = resolveCodeGenerationAuthority(project, { unit });
  const contract = resolveTestingPosture(project);
  const dir = codeGenerationRecordDir(project, unit);
  mkdirSync(dir, { recursive: true });
  const body = `# ${unit ?? "Stage"} Plan\n\n${renderTestingContract(contract)}\n## Steps\n\n- [ ] Implement\n`;
  const instructions = "# Unit Test Instructions\n\nRun the unit tests.\n";
  writeFileSync(join(dir, "code-generation-plan.md"), body);
  writeFileSync(join(dir, "unit-test-instructions.md"), instructions);
  const questionsFile = join(dir, "code-generation-questions.md");
  writeFileSync(questionsFile, [
    "## Plan Approval",
    `[Approval Fingerprint]: ${approvalFingerprint(body, instructions, contract.contract_sha256, authority)}`,
    `[Planned Source]: ${workspaceSourceFingerprint(project)}`,
    "A. Approve Plan", "B. Request Changes", "[Answer]:", "",
  ].join("\n"));
  return relative(project, questionsFile);
}

function fixture(stageLevel = false): Fixture {
  const project = setupIntegrationProject({ withState: "state-brownfield-feature.md" });
  projects.push(project);
  const state = readFileSync(seededStateFile(project), "utf-8")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation")
    .replace(/^- \[[ xSR?-]\] code-generation(\s+—\s+)EXECUTE$/m, "- [-] code-generation$1EXECUTE");
  writeFileSync(seededStateFile(project), state);
  if (!stageLevel) seedBoltDagBatches(project, [UNITS, ["later"]]);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "base.ts"), "export const base = 1;\n");
  for (const args of [
    ["init", "-q"], ["config", "user.email", "tests@example.com"],
    ["config", "user.name", "AI-DLC Tests"], ["add", "-A"], ["commit", "-qm", "baseline"],
  ]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: project, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
  publish(project, stageLevel ? null : UNITS);
  appendAuditEntry("SESSION_STARTED", { Source: "startup", Session: SESSION }, project);
  const units = stageLevel ? [] : UNITS.map((unit) => ({ unit, questionsFile: plan(project, unit) }));
  const file = join(seededRecordDir(project), "batch-review.json");
  writeFileSync(file, JSON.stringify({ batch: "services", units }));
  return { project, file, units };
}

function log(f: Fixture, action: "decision" | "answer", extra: string[] = []) {
  return run(f.project, "tools/aidlc-log.ts", [
    action, "--stage", "code-generation", "--checkpoint", "plan-approval",
    "--batch-file", f.file, "--session", SESSION,
    ...(action === "decision"
      ? ["--decision", "Approve all reviewed service plans?", "--options", "Approve Plans,Request Changes"]
      : ["--details", "Approve Plans"]),
    ...extra,
  ]);
}

function human(project: string, choice = "Approve Plans", session = SESSION): void {
  const result = run(project, "hooks/aidlc-record-human-turn.ts", [], {
    hook_event_name: "UserPromptSubmit", session_id: session, prompt: choice,
  });
  expect(result.code, result.stderr).toBe(0);
}

function answers(f: Fixture, choice = "Approve Plan"): void {
  for (const entry of f.units) {
    const path = join(f.project, entry.questionsFile);
    writeFileSync(path, readFileSync(path, "utf-8").replace(/^\[Answer\]:.*$/m, `[Answer]:${choice ? ` ${choice}` : ""}`));
  }
}

function receiptFiles(project: string): string[] {
  const dir = join(sessionsDir(project), "plan-approval");
  return existsSync(dir) ? readdirSync(dir).filter((file) => /^receipt-.*\.json$/.test(file)) : [];
}

function approve(f: Fixture): void {
  const decision = log(f, "decision");
  expect(decision.code, decision.stderr).toBe(0);
  human(f.project);
  answers(f);
  const answer = log(f, "answer");
  expect(answer.code, answer.stderr).toBe(0);
}

describe("t340 exact reviewed Code Generation batch approval", () => {
  test("one hook response certifies every exact member, and generation consumes ordinary receipts", () => {
    const f = fixture();
    const decision = log(f, "decision");
    expect(decision.code, decision.stderr).toBe(0);
    const challenge = readPlanApprovalChallenge(f.project, SESSION)!;
    expect(challenge.batch!.members.map((member) => member.unit)).toEqual(["api", "auth"]);
    human(f.project, "Approve Plans (Recommended)");
    answers(f);
    const answer = log(f, "answer");
    expect(answer.code, answer.stderr).toBe(0);
    expect(receiptFiles(f.project)).toHaveLength(2);
    for (const member of challenge.batch!.members) {
      const receipt = readPlanApprovalReceipt(f.project, member)!;
      expect(receipt.challengeId).toBe(challenge.challengeId);
      expect(receipt.batch!.bindingSha256).toBe(challenge.batch!.bindingSha256);
      expect(receipt.certifiedSourceSha256).toBe(workspaceSourceFingerprint(f.project)!);
      expect(evaluateCodeGenerationApproval(f.project, { unit: member.unit }).ok).toBe(true);
      expect(() => beginCodeGeneration(f.project, { unit: member.unit })).not.toThrow();
    }
    expect(readPlanApprovalChallenge(f.project, SESSION)).toBeNull();
    expect(readPlanApprovalResponse(f.project, SESSION)).toBeNull();
  }, 30_000);

  test("no receipt without the actual offered response in this session", () => {
    const f = fixture();
    expect(log(f, "decision").code).toBe(0);
    human(f.project, "Approve Plan"); // A single-plan choice is not the offered group choice.
    human(f.project, "Approve Plans", "another-session");
    answers(f);
    const answer = log(f, "answer");
    expect(answer.code).not.toBe(0);
    expect(answer.stderr).toContain("actual offered choice");
    expect(receiptFiles(f.project)).toHaveLength(0);
  }, 30_000);

  test("same reviewed batch, reordered manifest and reissued directive keep the response", () => {
    const f = fixture();
    expect(log(f, "decision").code).toBe(0);
    const before = readPlanApprovalChallenge(f.project, SESSION)!;
    human(f.project);
    writeFileSync(f.file, JSON.stringify({ batch: "services", units: [...f.units].reverse() }));
    publish(f.project);
    expect(log(f, "decision").code).toBe(0);
    expect(readPlanApprovalChallenge(f.project, SESSION)!.challengeId).toBe(before.challengeId);
    expect(readPlanApprovalResponse(f.project, SESSION)!.challengeId).toBe(before.challengeId);
    answers(f);
    const answer = log(f, "answer");
    expect(answer.code, answer.stderr).toBe(0);
  }, 30_000);

  test.each(["duplicate", "foreign", "subset", "noncanonical"] as const)("%s selection creates no partial challenge", (kind) => {
    const f = fixture();
    const units = kind === "duplicate" ? [f.units[0], f.units[0]]
      : kind === "foreign" ? [f.units[0], { ...f.units[1], unit: "later" }]
      : kind === "subset" ? [f.units[0]]
      : [f.units[0], { ...f.units[1], questionsFile: f.units[0].questionsFile }];
    writeFileSync(f.file, JSON.stringify({ batch: "services", units }));
    expect(log(f, "decision").code).not.toBe(0);
    expect(readPlanApprovalChallenge(f.project, SESSION)).toBeNull();
    expect(receiptFiles(f.project)).toHaveLength(0);
  }, 30_000);

  test.each(["name", "plan", "instructions", "attempt", "set", "source"] as const)("%s change after review refuses all receipts", (kind) => {
    const f = fixture();
    expect(log(f, "decision").code).toBe(0);
    human(f.project);
    answers(f);
    if (kind === "name") writeFileSync(f.file, JSON.stringify({ batch: "different-review", units: f.units }));
    if (kind === "plan" || kind === "instructions") {
      const path = join(codeGenerationRecordDir(f.project, "auth"),
        kind === "plan" ? "code-generation-plan.md" : "unit-test-instructions.md");
      writeFileSync(path, `${readFileSync(path, "utf-8")}\nChanged reviewed content\n`);
    }
    if (kind === "attempt") appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", Unit: "auth" }, f.project);
    if (kind === "set") publish(f.project, ["auth"]);
    if (kind === "source") writeFileSync(join(f.project, "src", "base.ts"), "export const base = 2;\n");
    expect(log(f, "answer").code).not.toBe(0);
    expect(receiptFiles(f.project)).toHaveLength(0);
  }, 30_000);

  test("one plan mutation after approval invalidates every member, including checkbox-only edits", () => {
    const f = fixture();
    approve(f);
    const path = join(codeGenerationRecordDir(f.project, "auth"), "code-generation-plan.md");
    writeFileSync(path, readFileSync(path, "utf-8").replace("- [ ] Implement", "- [x] Implement"));
    for (const unit of UNITS) {
      expect(evaluateCodeGenerationApproval(f.project, { unit }).ok).toBe(false);
      expect(() => beginCodeGeneration(f.project, { unit })).toThrow();
    }
  }, 30_000);

  test("re-fingerprinting changed content rotates the group challenge and needs a new human response", () => {
    const f = fixture();
    expect(log(f, "decision").code).toBe(0);
    human(f.project);
    const before = readPlanApprovalChallenge(f.project, SESSION)!;
    const dir = codeGenerationRecordDir(f.project, "auth");
    const planPath = join(dir, "code-generation-plan.md");
    const changed = `${readFileSync(planPath, "utf-8")}\nAdd another reviewed step.\n`;
    writeFileSync(planPath, changed);
    const fingerprint = approvalFingerprint(
      changed, readFileSync(join(dir, "unit-test-instructions.md"), "utf-8"),
      resolveTestingPosture(f.project).contract_sha256,
      resolveCodeGenerationAuthority(f.project, { unit: "auth" }),
    );
    const questions = join(dir, "code-generation-questions.md");
    writeFileSync(questions, readFileSync(questions, "utf-8").replace(
      /^\[Approval Fingerprint\]:.*$/m, `[Approval Fingerprint]: ${fingerprint}`,
    ));
    expect(log(f, "decision").code).toBe(0);
    expect(readPlanApprovalChallenge(f.project, SESSION)!.challengeId).not.toBe(before.challengeId);
    expect(readPlanApprovalResponse(f.project, SESSION)).toBeNull();
    answers(f);
    expect(log(f, "answer").code).not.toBe(0);
    expect(receiptFiles(f.project)).toHaveLength(0);
  }, 30_000);

  test("changing the live unit set after approval also retires the remaining unit's group receipt", () => {
    const f = fixture();
    approve(f);
    publish(f.project, ["auth"]);
    expect(evaluateCodeGenerationApproval(f.project, { unit: "auth" }).ok).toBe(false);
  }, 30_000);

  test("incomplete receipt set cannot authorize even the member whose receipt exists", () => {
    const f = fixture();
    approve(f);
    rmSync(join(sessionsDir(f.project), "plan-approval", receiptFiles(f.project)[0]));
    for (const unit of UNITS) expect(evaluateCodeGenerationApproval(f.project, { unit }).ok).toBe(false);
  }, 30_000);

  test("Request Changes withdraws the whole reviewed group and spends the response", () => {
    const f = fixture();
    approve(f);
    answers(f, "");
    expect(log(f, "decision").code).toBe(0);
    human(f.project, "Request Changes");
    answers(f, "Request Changes");
    const answer = log(f, "answer", ["--details", "Request Changes"]);
    expect(answer.code, answer.stderr).toBe(0);
    expect(receiptFiles(f.project)).toHaveLength(0);
    expect(readPlanApprovalChallenge(f.project, SESSION)).toBeNull();
    expect(readPlanApprovalResponse(f.project, SESSION)).toBeNull();
    answers(f);
    expect(log(f, "answer").code).not.toBe(0);
  }, 30_000);

  test("filesystem failure after receipt writes rolls back all authority and preserves the response", () => {
    const f = fixture();
    expect(log(f, "decision").code).toBe(0);
    human(f.project);
    answers(f);
    const challenge = readPlanApprovalChallenge(f.project, SESSION)!;
    const response = readPlanApprovalResponse(f.project, SESSION)!;
    const blocked = join(seededRecordDir(f.project), "blocked-audit");
    mkdirSync(blocked);
    expect(() => recordPlanApprovalBatchReceipts(f.project, f.file, SESSION, "Approve Plan", () => {
      expect(receiptFiles(f.project)).toHaveLength(2);
      for (const unit of UNITS) expect(evaluateCodeGenerationApproval(f.project, { unit }).ok).toBe(false);
      writeFileSync(blocked, "cannot write an audit row over a directory");
    })).toThrow();
    expect(receiptFiles(f.project)).toHaveLength(0);
    expect(readPlanApprovalChallenge(f.project, SESSION)).toEqual(challenge);
    expect(readPlanApprovalResponse(f.project, SESSION)).toEqual(response);
    const retry = log(f, "answer");
    expect(retry.code, retry.stderr).toBe(0);
  }, 30_000);

  test("loss of the shared commit marker leaves every receipt non-authorizing", () => {
    const f = fixture();
    approve(f);
    const dir = join(sessionsDir(f.project), "plan-approval");
    const commits = readdirSync(dir).filter((file) => file.startsWith("batch-commit-"));
    expect(commits).toHaveLength(1);
    rmSync(join(dir, commits[0]));
    expect(receiptFiles(f.project)).toHaveLength(2);
    for (const unit of UNITS) expect(evaluateCodeGenerationApproval(f.project, { unit }).ok).toBe(false);
  }, 30_000);

  test("an obstructed member destination refuses without changing any runtime authority", () => {
    const f = fixture();
    expect(log(f, "decision").code).toBe(0);
    human(f.project);
    answers(f);
    const challenge = readPlanApprovalChallenge(f.project, SESSION)!;
    const member = challenge.batch!.members[1];
    const key = createHash("sha256").update(`${member.targetId}\n${member.runFloor}\n${member.fingerprint}`).digest("hex");
    const blocked = join(sessionsDir(f.project), "plan-approval", `receipt-${key}.json`);
    mkdirSync(blocked);
    expect(log(f, "answer").code).not.toBe(0);
    expect(receiptFiles(f.project)).toEqual([`receipt-${key}.json`]); // Directory only.
    expect(readPlanApprovalResponse(f.project, SESSION)).not.toBeNull();
    rmSync(blocked, { recursive: true });
    expect(log(f, "answer").code).toBe(0);
  }, 30_000);

  test("failed rejection restores previous receipts and keeps the human response for retry", () => {
    const f = fixture();
    approve(f);
    const previous = receiptFiles(f.project).map((file) =>
      readFileSync(join(sessionsDir(f.project), "plan-approval", file), "utf-8"),
    );
    answers(f, "");
    expect(log(f, "decision").code).toBe(0);
    human(f.project, "Request Changes");
    answers(f, "Request Changes");
    const blocked = join(seededRecordDir(f.project), "blocked-rejection-audit");
    mkdirSync(blocked);
    expect(() => recordPlanApprovalBatchReceipts(f.project, f.file, SESSION, "Request Changes", () => {
      expect(receiptFiles(f.project)).toHaveLength(0);
      writeFileSync(blocked, "cannot write an audit row over a directory");
    })).toThrow();
    expect(receiptFiles(f.project).map((file) =>
      readFileSync(join(sessionsDir(f.project), "plan-approval", file), "utf-8"),
    )).toEqual(previous);
    expect(readPlanApprovalResponse(f.project, SESSION)!.choice).toBe("Request Changes");
    const retry = log(f, "answer", ["--details", "Request Changes"]);
    expect(retry.code, retry.stderr).toBe(0);
    expect(receiptFiles(f.project)).toHaveLength(0);
  }, 30_000);

  test("legacy batch flags refuse with a single-unit fallback and no challenge", () => {
    const f = fixture();
    const decision = log(f, "decision", ["--legacy-directive-options", "true"]);
    expect(decision.code).not.toBe(0);
    expect(decision.stderr).toContain("--unit <unit> --questions-file <path>");
    expect(readPlanApprovalChallenge(f.project, SESSION)).toBeNull();
  }, 30_000);

  test.each([false, true])("single route remains compatible, stage-level=%s, including protected choices", (stageLevel) => {
    const f = fixture(stageLevel);
    const questions = stageLevel ? plan(f.project, null) : f.units[0].questionsFile;
    const target = stageLevel ? ["--stage-level"] : ["--unit", f.units[0].unit];
    const identity = [
      "--stage", "code-generation", "--checkpoint", "plan-approval", "--session", SESSION,
      "--questions-file", questions, ...target,
    ];
    const decision = run(f.project, "tools/aidlc-log.ts", [
      "decision", ...identity, "--decision", "Approve this plan?",
      "--options", "Approve exact plan 927,Request exact changes 927",
      "--hash-option-labels", "true", "--exact-option-labels", "true",
    ]);
    expect(decision.code, decision.stderr).toBe(0);
    human(f.project, "Approve exact plan 927");
    const path = join(f.project, questions);
    writeFileSync(path, readFileSync(path, "utf-8").replace(/^\[Answer\]:.*$/m, "[Answer]: Approve Plan"));
    const answer = run(f.project, "tools/aidlc-log.ts", ["answer", ...identity, "--details", "Approve Plan"]);
    expect(answer.code, answer.stderr).toBe(0);
    expect(evaluateCodeGenerationApproval(f.project, { unit: stageLevel ? null : f.units[0].unit }).ok).toBe(true);
  }, 30_000);

  test("a grouped response cannot be spent through the single-unit answer route", () => {
    const f = fixture();
    expect(log(f, "decision").code).toBe(0);
    human(f.project);
    answers(f);
    const first = readPlanApprovalChallenge(f.project, SESSION)!.batch!.members[0];
    const answer = run(f.project, "tools/aidlc-log.ts", [
      "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--session", SESSION,
      "--unit", first.unit, "--questions-file", first.questionsFile, "--details", "Approve Plan",
    ]);
    expect(answer.code).not.toBe(0);
    expect(receiptFiles(f.project)).toHaveLength(0);
    expect(log(f, "answer").code).toBe(0);
  }, 30_000);
});
