// covers: subcommand:aidlc-log:answer, subcommand:aidlc-unit:claim, function:recordPlanApprovalAnswer, function:personRepliedAfter, file:hooks/aidlc-plan-approval-guard.ts
//
// The lead's code plan approval after their own checkout claims the Unit
// (#3603). The lead's own checkout (its shard on main) walks Unit alpha to
// its Code Generation plan question, the Unit is claimed for the lead's team
// there, and from then on the checkout writes the work's rows, the person's
// turns included, to the Unit's own record. These cases drive the real
// engine, the real human-turn hook, the real claim and the real plan-approval
// guard, and check what the person meets:
//
//   - under Guard Policy strict, relaxed and off: the turn the person sent
//     before the question, which the claim moved into the Unit's record, is
//     no reply to it, and a command to AIDLC after the claim is none either;
//     their reply after it is recorded once, the build starts, the developer
//     handoff passes the guard, and the question is not asked again;
//   - a question shown on the last preview or the last stable release, whose
//     marks kept no time, is answered after the claim even when the claim put
//     its shard back short of the question's mark;
//   - team work with no claim records the reply as it always did.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AuditMark, personRepliedAfter, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { readPlanApprovalAsk } from "../../dist/claude/.claude/tools/aidlc-plan-approval-ask.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { AIDLC_SRC, DEFAULT_INTENT_UUID, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { cleanupTempDirs, makeSeed, parallelDependencyBody } from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const TOOLS = join(AIDLC_SRC, "tools");
const CHAT = "01995000-7a11-7000-8000-0000000c3603";

type Step = Record<string, unknown> & { kind?: string; ask_type?: string; stage?: string; unit?: string };

function run(dir: string, tool: string, args: string[], chat = false) {
  const result = spawnSync(process.execPath, [join(TOOLS, tool), ...args, "--project-dir", dir], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_UNATTENDED: "0",
      AIDLC_DISABLE_SENSORS: "1",
      AIDLC_SKIP_ARTIFACT_GUARD: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      // The agent's own commands run in the person's chat.
      ...(chat ? { CLAUDE_PROJECT_DIR: dir, AIDLC_PROJECT_DIR: dir, AIDLC_SESSION_OVERRIDE: CHAT } : {}),
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function next(dir: string): Step {
  let result = run(dir, "aidlc-orchestrate.ts", ["next"]);
  for (;;) {
    expect(result.status, result.out).toBe(0);
    const step = JSON.parse(result.stdout.trim().split("\n").filter((line) => line.startsWith("{")).at(-1)!) as Step;
    if (step.kind !== "load-steering" || typeof step.receipt !== "string") return step;
    result = run(dir, "aidlc-orchestrate.ts", ["continue", step.receipt]);
  }
}

// The person's own message, as Claude Code's prompt hook hands it over.
function says(dir: string, prompt: string): void {
  const result = spawnSync(process.execPath, [join(TOOLS, "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: dir,
    encoding: "utf-8",
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: CHAT, prompt }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, AIDLC_PROJECT_DIR: dir, AIDLC_UNATTENDED: "0" },
  });
  expect(result.status, result.stderr).toBe(0);
}

// The agent records the choice it read from their reply.
function approve(dir: string) {
  const result = run(dir, "aidlc-log.ts", [
    "answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan",
  ], true);
  const line = result.out.split("\n").find((entry) => entry.startsWith("{")) ?? "{}";
  const parsed = JSON.parse(line) as { recorded?: string; message?: string; error?: string };
  return { status: result.status, recorded: parsed.recorded, message: parsed.message ?? parsed.error ?? result.out };
}

const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// Records keep whole seconds: the next turn lands in a later one.
function nextSecond(): void {
  const now = isoNow();
  while (isoNow() <= now) Bun.sleepSync(50);
}

// The lead's own checkout with alpha's design stages skipped, walked to
// alpha's code plan question the way the person's "carry on" does.
function leadAtPlanQuestion(policy: "strict" | "relaxed" | "off"): string {
  const { seed: lead } = makeSeed(parallelDependencyBody());
  cpSync(AIDLC_SRC, join(lead, ".claude"), { recursive: true });
  appendFileSync(join(lead, ".git", "info", "exclude"), "\n.claude/\n");
  // The state format's own separator is U+2014, written as an escape.
  const state = readFileSync(seededStateFile(lead), "utf-8")
    .replace("- [-] functional-design \u2014 EXECUTE", "- [x] functional-design \u2014 SKIP")
    .replace("- [ ] nfr-requirements \u2014 EXECUTE", "- [x] nfr-requirements \u2014 SKIP")
    .replace("- [ ] nfr-design \u2014 EXECUTE", "- [x] nfr-design \u2014 SKIP")
    .replace("- [ ] infrastructure-design \u2014 EXECUTE", "- [x] infrastructure-design \u2014 SKIP")
    .replace("- **Current Stage**: functional-design", "- **Current Stage**: code-generation")
    .replace("- **Review Override**: adversarial", `- **Review Override**: adversarial\n- **Guard Policy**: ${policy} (set by you)\n- **Plan Approval**: on (set by you)`);
  writeFileSync(seededStateFile(lead), state);
  says(lead, "carry on");
  let step = next(lead);
  // "Build them here for now": the lead's session builds alpha.
  expect(step).toMatchObject({ kind: "ask", ask_type: "team-handover" });
  step = next(lead);
  expect(step).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha" });
  const dir = join(seededRecordDir(lead), "construction", "alpha", "code-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: the greeting\n- Touches: src/alpha.ts\n- Tests: 1 unit test\n\n" +
      `## Steps\n\n- [ ] Step 1: write the greeting\n\n${renderTestingContract(resolveTestingPosture(lead))}`,
  );
  writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test src/alpha.test.ts`.\n");
  expect(next(lead)).toMatchObject({ kind: "ask", ask_type: "plan-approval", stage: "code-generation", unit: "alpha" });
  nextSecond();
  return lead;
}

function unitRecords(lead: string): string[] {
  const dir = join(seededRecordDir(lead), ".aidlc-engine", "audit");
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
}

function approvalsRecorded(lead: string): number {
  return readAuditShardEvents(lead).filter((row) => row.event === "PLAN_APPROVAL_RECORDED").length;
}

// The developer handoff for alpha, as the build step names it.
function handoffPasses(lead: string): { code: number; stderr: string } {
  const brief = run(lead, "aidlc-testing-posture.ts", ["brief", "--unit", "alpha"]);
  expect(brief.status, brief.out).toBe(0);
  const result = spawnSync(process.execPath, [join(lead, ".claude", "hooks", "aidlc-plan-approval-guard.ts")], {
    cwd: lead,
    encoding: "utf-8",
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: CHAT,
      cwd: lead,
      tool_name: "Agent",
      tool_input: { subagent_type: "aidlc-developer-agent", prompt: brief.stdout },
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: lead, AIDLC_PROJECT_DIR: lead },
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

describe("the lead's plan approval after their checkout claims the Unit", () => {
  for (const policy of ["strict", "relaxed", "off"] as const) {
    test(`is recorded once and builds, and only a reply after the question counts (Guard Policy ${policy})`, () => {
      const lead = leadAtPlanQuestion(policy);
      const claimed = run(lead, "aidlc-unit.ts", ["claim", "alpha", "--team", "lead team"]);
      expect(claimed.status, claimed.out).toBe(0);
      // The claim's own record now takes the work's rows, the person's turn
      // from before the question with them.
      const [record] = unitRecords(lead);
      expect(record).toBeDefined();
      const moved = readFileSync(record, "utf-8");
      expect(moved.indexOf("**Event**: HUMAN_TURN")).toBeGreaterThan(-1);
      expect(moved.indexOf("**Event**: HUMAN_TURN")).toBeLessThan(moved.indexOf("**Question Type**: plan-approval"));
      nextSecond();

      // The turn from before the question, in the Unit's record now, is no
      // reply to it, and a command to AIDLC is none either.
      const mark = readPlanApprovalAsk(lead, DEFAULT_INTENT_UUID)?.repliesFrom as AuditMark;
      expect(mark.shard).toMatch(/\/audit\/[^/]+\.md$/);
      expect(mark.shard).not.toContain(".aidlc-engine");
      expect(personRepliedAfter(lead, mark)).toBe(false);
      says(lead, "/aidlc -- does the plan cover the greeting only?");
      expect(personRepliedAfter(lead, mark)).toBe(false);
      const command = approve(lead);
      expect(command.status, command.message).toBe(1);
      expect(command.message).toContain("has not replied to the plan question since it was shown");
      expect(approvalsRecorded(lead)).toBe(0);

      says(lead, "Fine, our plan looks good, go ahead with it.");
      expect(personRepliedAfter(lead, mark)).toBe(true);
      const recorded = approve(lead);
      expect(recorded.message).toBe('Recorded "Approve Plan" for alpha. Run next.');
      expect(recorded).toMatchObject({ status: 0, recorded: "approve" });
      expect(approvalsRecorded(lead)).toBe(1);
      // In the Unit's own record, where the checkout writes now.
      expect(readFileSync(record, "utf-8")).toContain("PLAN_APPROVAL_RECORDED");

      expect(next(lead)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha" });
      const handed = handoffPasses(lead);
      expect(handed.code, handed.stderr).toBe(0);
      // Never asked again.
      expect(next(lead)).not.toMatchObject({ ask_type: "plan-approval" });
      expect(approvalsRecorded(lead)).toBe(1);
    });
  }

  for (const release of ["the last preview", "the last stable release"] as const) {
    test(`a question shown on ${release} is answered once the claim has reset its shard`, () => {
      const lead = leadAtPlanQuestion("relaxed");
      // Both kept no time on the question's marks; the stable release kept no shownFrom either.
      const dir = join(lead, "aidlc", ".aidlc-sessions", "plan-approval");
      const [ask] = readdirSync(dir).filter((name) => name.startsWith("ask-")).map((name) => join(dir, name));
      const record = JSON.parse(readFileSync(ask, "utf-8")) as { repliesFrom: AuditMark; shownFrom?: AuditMark };
      delete record.repliesFrom.at;
      if (release === "the last stable release") delete record.shownFrom;
      else delete record.shownFrom?.at;
      writeFileSync(ask, `${JSON.stringify(record, null, 2)}\n`);
      const claimed = run(lead, "aidlc-unit.ts", ["claim", "alpha", "--team", "lead team"]);
      expect(claimed.status, claimed.out).toBe(0);
      // The claim put the shard back to what main has, short of the question's mark.
      const tracked = join(lead, ...record.repliesFrom.shard.split("/"));
      expect(readFileSync(tracked).length).toBeLessThan(record.repliesFrom.offset);
      // The turn from before the question, moved into the Unit's record, is still no reply.
      expect(personRepliedAfter(lead, record.repliesFrom, readPlanApprovalAsk(lead, DEFAULT_INTENT_UUID)?.issuedAt)).toBe(false);
      expect(approve(lead)).toMatchObject({ status: 1 });
      nextSecond();
      says(lead, "Fine, our plan looks good, go ahead with it.");
      const recorded = approve(lead);
      expect(recorded.message).toBe('Recorded "Approve Plan" for alpha. Run next.');
      expect(approvalsRecorded(lead)).toBe(1);
      expect(next(lead)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha" });
    });
  }

  test("team work with no claim records the reply as before", () => {
    const lead = leadAtPlanQuestion("relaxed");
    says(lead, "Fine, our plan looks good, go ahead with it.");
    const recorded = approve(lead);
    expect(recorded).toMatchObject({ status: 0, recorded: "approve" });
    expect(unitRecords(lead)).toEqual([]);
    expect(next(lead)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha" });
    expect(approvalsRecorded(lead)).toBe(1);
  });
});
