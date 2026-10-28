// covers: hook:aidlc-record-human-turn
//
// A setting the person asks for in their answer to the plan question, before
// the work exists, is recorded as theirs. Live on Claude Code (2026-10-27):
// the person answered the plan question's box with "1 but with guard policy
// strict please"; the setting was made, and the record and the setter's line
// said "strict (set by a command)". The hook kept their answer as a message
// but named its id to the agent only once work existed, so the agent had no
// message to name, and the setter, rightly, credited nothing to them. Now a
// reply while this chat's plan question for new work is open gets the id line
// too, before any work exists or outside it, and the setters stand on it; a
// prompt with no plan question open still gets none, and words the agent
// passes as its own are still nobody's.
//
// Mechanism: function - the shipped hook (Claude Code's own command, Codex and
// the Kiro CLI through their adapters), `next`, intent creation and the
// shipped setter; no agent runs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auditBlockField, getField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { type AnswersItem, env, exec, next, pick, say } from "../harness/aidlc-answers-corpus.ts";
import { DISPATCHER, type Harness, SECOND_SESSION, projectAt } from "../harness/aidlc-input-corpus.ts";
import { cleanupTestProject } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

const REQUEST = "the docs for my backup script are wrong, docs/usage.md says it deletes old backups but it never did";
const ANSWER = "1 but with guard policy strict please";

const namedId = (stdout: string) => /on record as ([^:\s]+):/.exec(stdout)?.[1];
const run = (proj: string, args: string[]) => exec([process.execPath, DISPATCHER, ...args], { cwd: proj, env: env(proj) });
const intents = (proj: string) => join(proj, "aidlc", "spaces", "default", "intents");
const activeState = (proj: string) =>
  readFileSync(join(intents(proj), readFileSync(join(intents(proj), "active-intent"), "utf-8").trim(), "aidlc-state.md"), "utf-8");
const lastRow = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event).at(-1);

/** A fresh project: the person asks for the work, and the plan question for it is on screen. */
async function planQuestionOpen(harness: Harness): Promise<{ proj: string; question: string; options: string[]; request: string }> {
  const proj = await projectAt("fresh");
  projects.push(proj);
  const first = await say(proj, `/aidlc ${REQUEST}`, harness);
  expect(first.status, first.stderr).toBe(0);
  // No AI-DLC question is open yet: the person's request gets no line.
  expect(namedId(first.stdout), first.stdout).toBeUndefined();
  const read = await next(proj, [REQUEST]);
  const request = /--propose <plan> --request ([0-9a-f]{8})/.exec(read.directive?.message ?? "")?.[1];
  expect(request, read.out).toBeDefined();
  const offer = await next(proj, ["--propose", "bugfix", "--request", request as string]);
  expect(offer.directive?.ask_type, offer.out).toBe("scope-confirm");
  const choices = offer.directive?.choices as Array<{ label: string }>;
  const confirm = String(offer.directive?.confirm_command);
  return {
    proj,
    question: String(offer.directive?.question),
    options: choices.map((choice) => choice.label),
    request: /--request ([0-9a-f]{8})/.exec(confirm)?.[1] as string,
  };
}

/** The person answers the plan question in its box, in their own words (the box's "Other" field). */
function planBox(question: string, options: string[], answer: string): AnswersItem {
  return { question: "plan", picker: { question, options, answer } } as unknown as AnswersItem;
}

/** The agent starts the work the person picked, as the engine's steps name it. */
async function startWork(proj: string, request: string): Promise<void> {
  const step = await next(proj, ["--scope", "bugfix", "--request", request]);
  expect(step.directive?.kind, step.out).toBe("print");
  const created = await run(proj, ["engine", "intent", "create", "--scope", "bugfix", "--request", request, "--label", "backup-docs-fix"]);
  expect(created.status, created.stdout + created.stderr).toBe(0);
}

function expectTheirs(proj: string): void {
  const row = lastRow(proj, "GUARD_POLICY_SET")!;
  expect(row, "no GUARD_POLICY_SET").toBeDefined();
  expect(auditBlockField(row.block, "New Value")).toBe("strict");
  expect(auditBlockField(row.block, "Source")).toBe("you");
}

describe("t-plan-box-setting-words: a setting asked in the answer to the plan question is recorded as theirs", () => {
  for (const harness of ["claude", "codex"] as const) {
    test(`${harness}: the plan question's box answer gets its id, and Guard Policy set on it after the work starts is theirs`, async () => {
      const { proj, question, options, request } = await planQuestionOpen(harness);
      const box = await pick(proj, planBox(question, options, ANSWER), harness);
      expect(box.status, box.stderr).toBe(0);
      const id = namedId(box.stdout);
      expect(id, box.stdout).toBeDefined();
      const context = JSON.parse(box.stdout.trim()).hookSpecificOutput;
      expect(context.hookEventName).toBe("PostToolUse");
      expect(String(context.additionalContext).split("on record as").length - 1, box.stdout).toBe(1);
      expect(box.stdout).not.toContain(ANSWER);
      await startWork(proj, request);
      const set = await run(proj, ["engine", "config", "set", "guard-policy", "strict", "--message", id as string]);
      expect(set.status, set.stdout + set.stderr).toBe(0);
      expect(set.stdout).toContain("(set by you)");
      expectTheirs(proj);
    });
  }

  test("kiro: a reply typed at the plan question gets its id, and Guard Policy set on it is theirs", async () => {
    const { proj, request } = await planQuestionOpen("kiro");
    const typed = await say(proj, ANSWER, "kiro");
    expect(typed.status, typed.stderr).toBe(0);
    const id = namedId(typed.stdout);
    expect(id, typed.stdout).toBeDefined();
    expect(typed.stdout).not.toContain(ANSWER);
    await startWork(proj, request);
    const set = await run(proj, ["engine", "config", "set", "guard-policy", "strict", "--message", id as string]);
    expect(set.status, set.stdout + set.stderr).toBe(0);
    expectTheirs(proj);
  });

  test("claude: set before the work exists, the setting is kept on their answer and the new work takes it as theirs", async () => {
    const { proj, question, options, request } = await planQuestionOpen("claude");
    const asked = "1, and skip the summary check please";
    const box = await pick(proj, planBox(question, options, asked), "claude");
    const id = namedId(box.stdout) as string;
    expect(id, box.stdout).toBeDefined();
    const kept = await run(proj, ["engine", "config", "set", "summary-confirmation", "off", "--message", id]);
    expect(kept.status, kept.stdout + kept.stderr).toBe(0);
    await startWork(proj, request);
    const state = activeState(proj);
    expect(getField(state, "Summary Confirmation"), state).toBe("off (set by you)");
  });

  test("claude: the agent's own words for the setting, with no message of theirs named, are still never credited to them", async () => {
    const { proj, question, options, request } = await planQuestionOpen("claude");
    await pick(proj, planBox(question, options, ANSWER), "claude");
    await startWork(proj, request);
    const set = await run(proj, ["engine", "config", "set", "guard-policy", "strict", "--person-words", "they want it strict"]);
    expect(set.status, set.stdout + set.stderr).toBe(0);
    expect(set.stdout).toContain("(set by a command)");
    const row = lastRow(proj, "GUARD_POLICY_SET")!;
    expect(auditBlockField(row.block, "Source")).toBe("command");
    expect(auditBlockField(row.block, "Person Reply")).toBeNull();
  });

  test("claude: with no AI-DLC question open and no work, a prompt gets no line", async () => {
    const proj = await projectAt("fresh");
    projects.push(proj);
    const typed = await say(proj, "what does this repo do?", "claude");
    expect(typed.status, typed.stderr).toBe(0);
    expect(namedId(typed.stdout), typed.stdout).toBeUndefined();
  });

  test("claude: with the plan question open, an unattended run and another chat get no line", async () => {
    const { proj } = await planQuestionOpen("claude");
    const unattended = await say(proj, ANSWER, "claude", { env: { AIDLC_UNATTENDED: "1" } });
    expect(unattended.status, unattended.stderr).toBe(0);
    expect(namedId(unattended.stdout), unattended.stdout).toBeUndefined();
    const other = await say(proj, ANSWER, "claude", { session: SECOND_SESSION });
    expect(other.status, other.stderr).toBe(0);
    expect(namedId(other.stdout), other.stdout).toBeUndefined();
  });
});
