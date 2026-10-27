// covers: subcommand:aidlc-log:answer, subcommand:aidlc-log:decision, audit:SUMMARY_CONFIRMATION_RECORDED, function:answeredBeforeShownStep
// covers: hook:aidlc-record-human-turn
//
// The agent showed the revised summary before it recorded the summary's
// question, and the person replied "1" (a live Kiro CLI run on Windows Server,
// Requirements Analysis on a bugfix). The agent wrote "Looks correct" into the
// summary's `[Answer]:` line, was told the question was not on record, cleared
// the line, recorded the question naming their message, wrote the line back and
// recorded the answer; that answer was refused because the summary's file was
// last written after "1", and the person was asked the same summary again. Their
// reply came after the summary was shown, and nothing but the agent writing down
// their pick happened between it and the question's record, so it confirms the
// summary, as a reply after the record does: through Kiro CLI's and Claude
// Code's human-turn hooks, with the summary confirmation on or off for the work,
// with or without the answer naming their message, in a single-stage run too.
// Still as before: the order that records the question first, and #2931's case,
// a reply sent before the summary was written (it never confirms it), and a reply
// with another question recorded after it (the agent names the message). The
// rule reads the record's order, not the file's content: a write of the answers
// alone before a reply reads as the summary shown, as a write after the record
// reads as their pick written down.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, seedAidlcMemory, seededRecordDir, seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";
import { env, exec, LOG, SESSION, say, type Harness } from "../harness/aidlc-input-corpus.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const STAGE = "requirements-analysis";
const SUMMARY = "Does this all look correct before I generate the requirements artifact?";
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop()!);
});

function project(summary: "on" | "off"): { proj: string; questions: string } {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-mid-inception.md");
  const state = seededStateFile(proj);
  writeFileSync(state, readFileSync(state, "utf-8")
    .replace("- **Summary Confirmation**: on (from scope bugfix)", `- **Summary Confirmation**: ${summary} (set by you)`));
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  const questions = join(dir, `${STAGE}-questions.md`);
  writeFileSync(questions, [
    "# Requirements Questions", "", "## Q1", "What should 90 minutes show?", "", "A) 1h30m", "B) 90m",
    "X) Other (please specify)", "", "[Answer]: A", "", "## Consolidated Summary Confirmation", "",
    "90 minutes shows as 1h30m.", "", "- Looks correct", "- Request changes", "", "[Answer]:", "",
  ].join("\n"));
  return { proj, questions };
}

async function log(proj: string, args: string[]) {
  const result = await exec([process.execPath, LOG, ...args, "--project-dir", proj], { cwd: proj, env: env(proj) });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

async function says(proj: string, words: string, harness: Harness): Promise<string> {
  const result = await say(proj, words, harness);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return auditBlockField(rows(proj, "HUMAN_TURN").at(-1)!.block, "Message Id")!;
}

// The agent's own write of the questions file, as the write hook records it.
async function agentWrites(proj: string, questions: string, edit: (text: string) => string): Promise<void> {
  writeFileSync(questions, edit(readFileSync(questions, "utf-8")));
  const result = await exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "write-audit-log"], {
    cwd: proj, env: env(proj),
    input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "Write", tool_input: { file_path: questions } }),
  });
  expect(result.status, result.stderr).toBe(0);
}
const setAnswer = (choice: string) => (text: string) => text.replace(/\[Answer\]:[^\n]*\n$/, `[Answer]:${choice ? ` ${choice}` : ""}\n`);

const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
const receipts = (proj: string) => rows(proj, "SUMMARY_CONFIRMATION_RECORDED");

// The record's times are whole seconds: what comes next lands in a later one.
function nextSecond(): void {
  const now = new Date().toISOString().slice(0, 19);
  while (new Date().toISOString().slice(0, 19) === now) Bun.sleepSync(10);
}

// `run` is the summary's own run: the work's (none) or a single-stage run's (`--single`).
const askSummary = (proj: string, questions: string, message?: string, run: string[] = []) =>
  log(proj, ["decision", "--stage", STAGE, "--checkpoint", "summary-confirmation", "--questions-file", questions,
    "--decision", SUMMARY, "--options", "Looks correct,Request changes", ...(message ? ["--message", message] : []), ...run]);
const answerSummary = (proj: string, questions: string, choice: string, message?: string, run: string[] = []) =>
  log(proj, ["answer", "--checkpoint", "summary-confirmation", "--stage", STAGE, "--questions-file", questions,
    "--details", choice, ...(message ? ["--message", message] : []), ...run]);

const refusal = (out: string): string => {
  const line = out.split("\n").find((entry) => entry.trim().startsWith("{") && entry.includes('"error"'));
  return line ? String((JSON.parse(line) as { error?: unknown }).error) : out;
};

// The summary shown and confirmed, a Request changes on it with what to change,
// and the agent's revision of the summary: x26-win-b-31 up to the revised summary.
// Whether the change words' receipt named the revised summary's record (#3187's
// note, given only while the summary confirmation is on).
async function revisedSummaryWritten(proj: string, questions: string, harness: Harness, run: string[] = []): Promise<boolean> {
  await agentWrites(proj, questions, (text) => text);
  const first = await askSummary(proj, questions, undefined, run);
  expect(first.status, first.out).toBe(0);
  nextSecond();
  await says(proj, "2", harness);
  await agentWrites(proj, questions, setAnswer("Request changes"));
  const changed = await answerSummary(proj, questions, "Request changes", undefined, run);
  expect(changed.status, changed.out).toBe(0);
  nextSecond();
  await says(proj, "also 0 should print 0m, add that", harness);
  const words = await log(proj, ["answer", "--stage", STAGE, "--details", "also 0 should print 0m, add that", ...run]);
  expect(words.status, words.out).toBe(0);
  nextSecond();
  await agentWrites(proj, questions, (text) => setAnswer("")(text.replace("1h30m.", "1h30m, and 0 prints 0m.")));
  nextSecond();
  return words.out.includes('"agent_note"');
}

describe("t-summary-question-recorded-late: the summary's question recorded after the person replied to it", () => {
  for (const harness of ["kiro", "claude"] as const) {
    const orders = [
      { summary: "off", named: false, single: false },
      { summary: "on", named: false, single: false },
      { summary: "off", named: true, single: false },
      { summary: "off", named: false, single: true },
    ] as const;
    for (const { summary, named, single } of orders) {
      const how = `${named ? ", the answer naming their message" : ""}${single ? ", in a single-stage run" : ""}`;
      test(`${harness}, summary confirmation ${summary}${how}: "1" at the revised summary shown before its question was recorded is taken`, async () => {
        const { proj, questions } = project(summary);
        const run = single ? ["--single"] : [];
        expect(await revisedSummaryWritten(proj, questions, harness, run)).toBe(summary === "on");
        const one = await says(proj, "1", harness);
        await agentWrites(proj, questions, setAnswer("Looks correct"));
        const early = await answerSummary(proj, questions, "Looks correct", undefined, run);
        expect(refusal(early.out)).toContain("no matching unanswered summary question");
        await agentWrites(proj, questions, setAnswer(""));
        const asked = await askSummary(proj, questions, one, run);
        expect(asked.status, asked.out).toBe(0);
        await agentWrites(proj, questions, setAnswer("Looks correct"));
        const recorded = await answerSummary(proj, questions, "Looks correct", named ? one : undefined, run);
        expect(recorded.status, refusal(recorded.out)).toBe(0);
        const confirmed = receipts(proj).filter((row) => auditBlockField(row.block, "Details") === "Looks correct");
        expect(confirmed).toHaveLength(1);
        expect(auditBlockField(confirmed[0].block, "Message Id")).toBe(one);
        expect(auditBlockField(confirmed[0].block, "Person Reply")).toBe("1");
      });
    }

    test(`${harness}: the agent records the question right after "1", with no message named, and their "1" is taken`, async () => {
      const { proj, questions } = project("off");
      await revisedSummaryWritten(proj, questions, harness);
      const one = await says(proj, "1", harness);
      expect((await askSummary(proj, questions)).status).toBe(0);
      await agentWrites(proj, questions, setAnswer("Looks correct"));
      const recorded = await answerSummary(proj, questions, "Looks correct");
      expect(recorded.status, refusal(recorded.out)).toBe(0);
      expect(auditBlockField(receipts(proj).at(-1)!.block, "Message Id")).toBe(one);
    });

    test(`${harness}: the question recorded before the revised summary is shown takes "1" as before`, async () => {
      const { proj, questions } = project("on");
      await revisedSummaryWritten(proj, questions, harness);
      expect((await askSummary(proj, questions)).status).toBe(0);
      nextSecond();
      const one = await says(proj, "1", harness);
      await agentWrites(proj, questions, setAnswer("Looks correct"));
      const recorded = await answerSummary(proj, questions, "Looks correct");
      expect(recorded.status, refusal(recorded.out)).toBe(0);
      expect(auditBlockField(receipts(proj).at(-1)!.block, "Message Id")).toBe(one);
    });

    test(`${harness}: a reply sent before the revised summary was written still does not confirm it`, async () => {
      const { proj, questions } = project("off");
      await agentWrites(proj, questions, (text) => text);
      expect((await askSummary(proj, questions)).status).toBe(0);
      nextSecond();
      await says(proj, "2", harness);
      await agentWrites(proj, questions, setAnswer("Request changes"));
      expect((await answerSummary(proj, questions, "Request changes")).status).toBe(0);
      nextSecond();
      await says(proj, "also 0 should print 0m, add that", harness);
      expect((await log(proj, ["answer", "--stage", STAGE, "--details", "also 0 should print 0m, add that"])).status).toBe(0);
      nextSecond();
      const early = await says(proj, "and then it looks right", harness);
      nextSecond();
      await agentWrites(proj, questions, (text) => setAnswer("")(text.replace("1h30m.", "1h30m, and 0 prints 0m.")));
      expect((await askSummary(proj, questions)).status).toBe(0);
      await agentWrites(proj, questions, setAnswer("Looks correct"));
      const bare = await answerSummary(proj, questions, "Looks correct");
      expect(bare.status).not.toBe(0);
      expect(refusal(bare.out)).toContain("Show the summary and end your turn");
      const named = await answerSummary(proj, questions, "Looks correct", early);
      expect(named.status).not.toBe(0);
      expect(refusal(named.out)).toContain(`their message ${early} came before the summary was last written`);
      expect(receipts(proj).filter((row) => auditBlockField(row.block, "Details") === "Looks correct")).toHaveLength(0);
    });

    test(`${harness}: a reply with another question recorded after it is left for the agent to name`, async () => {
      const { proj, questions } = project("off");
      await revisedSummaryWritten(proj, questions, harness);
      const one = await says(proj, "1", harness);
      expect((await log(proj, ["decision", "--stage", STAGE, "--decision", "Should 0 print 0m or 0h0m?",
        "--options", "0m,0h0m"])).status).toBe(0);
      expect((await askSummary(proj, questions)).status).toBe(0);
      await agentWrites(proj, questions, setAnswer("Looks correct"));
      const bare = await answerSummary(proj, questions, "Looks correct");
      expect(bare.status).not.toBe(0);
      expect(refusal(bare.out)).toStartWith(`If their message ${one} (sent `);
      expect(receipts(proj).filter((row) => auditBlockField(row.block, "Details") === "Looks correct")).toHaveLength(0);
    });
  }
});
