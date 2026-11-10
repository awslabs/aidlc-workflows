// covers: subcommand:aidlc-unit:adopt, subcommand:aidlc-unit:publish, function:evaluateCodeGenerationApproval
//
// A team Unit's code plan approved in the lead's claim, published, and carried on by a teammate who adopts the
// Unit in their own clone. The approval's receipt stays in the lead's git-ignored runtime folder; the committed
// approval row and questions file travel with the claim. The teammate was asked to approve the plan again, and
// the engine blanked the lead's answer in the questions file. Now the committed approval for this plan, Unit and
// stage attempt holds on their clone, under Guard Policy strict, relaxed and off: nothing is asked, the answer
// stays, and the developer handoff passes the guard. A plan they change is asked about under strict.
//
// Drives the real claim, publish, adopt, `next`, human-turn hook, answer command and plan-approval guard over two
// real clones of one bare remote.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { AIDLC_SRC, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { cleanupTempDirs, clone, git, makeSeed, parallelDependencyBody } from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const TOOLS = join(AIDLC_SRC, "tools");
const LEAD = "01995000-7a11-7000-8000-0000000c3603";
const BOB = "01995000-7a11-7000-8000-0000000b0b01";

type Step = Record<string, unknown> & { kind?: string; ask_type?: string; unit?: string };

function run(dir: string, tool: string, args: string[], chat?: string) {
  const result = spawnSync(process.execPath, [join(TOOLS, tool), ...args, "--project-dir", dir], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_UNATTENDED: "0",
      AIDLC_DISABLE_SENSORS: "1",
      AIDLC_SKIP_ARTIFACT_GUARD: "1",
      AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
      ...(chat ? { CLAUDE_PROJECT_DIR: dir, AIDLC_PROJECT_DIR: dir, AIDLC_SESSION_OVERRIDE: chat } : {}),
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

function says(dir: string, prompt: string, chat: string): void {
  const result = spawnSync(process.execPath, [join(TOOLS, "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: dir,
    encoding: "utf-8",
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: chat, prompt }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, AIDLC_PROJECT_DIR: dir, AIDLC_UNATTENDED: "0" },
  });
  expect(result.status, result.stderr).toBe(0);
}

const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
// Records keep whole seconds: the next turn lands in a later one.
function nextSecond(): void {
  const now = isoNow();
  while (isoNow() <= now) Bun.sleepSync(50);
}

const planDir = (dir: string) => join(seededRecordDir(dir), "construction", "alpha", "code-generation");
const answerLine = (dir: string) =>
  /^\[Answer\]:.*$/m.exec(readFileSync(join(planDir(dir), "code-generation-questions.md"), "utf-8"))?.[0];

function writePlan(dir: string, extra = ""): void {
  mkdirSync(planDir(dir), { recursive: true });
  writeFileSync(join(planDir(dir), "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: the greeting\n- Touches: src/alpha.ts\n- Tests: 1 unit test\n\n" +
      `## Steps\n\n- [ ] Step 1: write the greeting\n${extra}\n${renderTestingContract(resolveTestingPosture(dir))}`);
  writeFileSync(join(planDir(dir), "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test src/alpha.test.ts`.\n");
}

/** The engine's own tools in a checkout, kept out of git as an install keeps them. */
function installed(dir: string): void {
  cpSync(AIDLC_SRC, join(dir, ".claude"), { recursive: true });
  appendFileSync(join(dir, ".git", "info", "exclude"), "\n.claude/\n");
}

/** The lead claims alpha, is asked about its plan, approves it, and publishes the claim. */
function approvedAndPublished(policy: "strict" | "relaxed" | "off"): { remote: string; ref: string } {
  const { seed: lead, remote } = makeSeed(parallelDependencyBody());
  installed(lead);
  // The state format's own separator is U+2014, written as an escape.
  const state = readFileSync(seededStateFile(lead), "utf-8")
    .replace("- [-] functional-design \u2014 EXECUTE", "- [x] functional-design \u2014 SKIP")
    .replace("- [ ] nfr-requirements \u2014 EXECUTE", "- [x] nfr-requirements \u2014 SKIP")
    .replace("- [ ] nfr-design \u2014 EXECUTE", "- [x] nfr-design \u2014 SKIP")
    .replace("- [ ] infrastructure-design \u2014 EXECUTE", "- [x] infrastructure-design \u2014 SKIP")
    .replace("- **Current Stage**: functional-design", "- **Current Stage**: code-generation")
    .replace("- **Review Override**: adversarial",
      `- **Review Override**: adversarial\n- **Guard Policy**: ${policy} (set by you)\n- **Plan Approval**: on (set by you)`);
  writeFileSync(seededStateFile(lead), state);
  says(lead, "carry on", LEAD);
  expect(next(lead)).toMatchObject({ kind: "ask", ask_type: "team-handover" });
  expect(next(lead)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha" });
  const claimed = run(lead, "aidlc-unit.ts", ["claim", "alpha", "--team", "lead team"]);
  expect(claimed.status, claimed.out).toBe(0);
  const ref = (JSON.parse(claimed.stdout) as { claim_ref: string }).claim_ref;
  writePlan(lead);
  expect(next(lead)).toMatchObject({ kind: "ask", ask_type: "plan-approval", unit: "alpha" });
  nextSecond();
  says(lead, "Fine, our plan looks good, go ahead with it.", LEAD);
  const approved = run(lead, "aidlc-log.ts",
    ["answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan"], LEAD);
  expect(approved.status, approved.out).toBe(0);
  expect(answerLine(lead)).toBe("[Answer]: A. Approve Plan");
  git(lead, ["add", "-A"]);
  git(lead, ["commit", "-m", "alpha's plan, approved"]);
  const published = run(lead, "aidlc-unit.ts", ["publish", "alpha"]);
  expect(published.status, published.out).toBe(0);
  return { remote, ref };
}

/** Bob's own clone, on the claim branch, with alpha adopted. */
function bobAdopts(remote: string, ref: string): string {
  const bob = clone(remote, "bob");
  installed(bob);
  git(bob, ["fetch", "origin", `${ref}:${ref}`]);
  git(bob, ["switch", ref.replace("refs/heads/", "")]);
  const adopted = run(bob, "aidlc-unit.ts", ["adopt", "alpha"]);
  expect(adopted.status, adopted.out).toBe(0);
  nextSecond();
  says(bob, "carry on with alpha", BOB);
  return bob;
}

// The developer handoff for alpha, as the build step names it, from Bob's chat.
function handoffPasses(dir: string): { code: number; stderr: string } {
  const brief = run(dir, "aidlc-testing-posture.ts", ["brief", "--unit", "alpha"]);
  expect(brief.status, brief.out).toBe(0);
  const result = spawnSync(process.execPath, [join(dir, ".claude", "hooks", "aidlc-plan-approval-guard.ts")], {
    cwd: dir,
    encoding: "utf-8",
    input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: BOB, cwd: dir, tool_name: "Agent",
      tool_input: { subagent_type: "aidlc-developer-agent", prompt: brief.stdout },
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, AIDLC_PROJECT_DIR: dir },
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

describe("a team Unit's approved code plan holds on the teammate's clone", () => {
  for (const policy of ["strict", "relaxed", "off"] as const) {
    test(`Guard Policy ${policy}: Bob is not asked again, the answer stays, and the build starts`, () => {
      const { remote, ref } = approvedAndPublished(policy);
      const bob = bobAdopts(remote, ref);
      expect(next(bob)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha" });
      expect(answerLine(bob)).toBe("[Answer]: A. Approve Plan");
      const handed = handoffPasses(bob);
      expect(handed.code, handed.stderr).toBe(0);
      expect(next(bob)).not.toMatchObject({ ask_type: "plan-approval" });
      expect(answerLine(bob)).toBe("[Answer]: A. Approve Plan");
    });
  }

  test("Guard Policy strict: a plan Bob changes is asked about", () => {
    const { remote, ref } = approvedAndPublished("strict");
    const bob = bobAdopts(remote, ref);
    writePlan(bob, "- [ ] Step 2: greet in French too\n");
    expect(next(bob)).toMatchObject({ kind: "ask", ask_type: "plan-approval", unit: "alpha" });
  });
});
