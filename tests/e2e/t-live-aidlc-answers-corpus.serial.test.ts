// covers: file:skills/aidlc/SKILL.md, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, hook:aidlc-record-human-turn
//
// t-live-aidlc-answers-corpus: a sample of the answers corpus (tests/fixtures/aidlc-answers/corpus.json) driven through
// REAL agents on the shipped trees: Claude Code through the SDK, Codex through `codex exec`, Kiro CLI over ACP. The
// question is asked first by the real agent (a bare `/aidlc` at the fixture's state shows it; the routing question, the
// plan offer and the record pick come from the typed line that produces them), then the person replies: in chat (the box
// dismissed with "Chat about this", the reply as their next message), after `/aidlc`, or in the box. At re-entry and a
// jump the person's own line is the whole exchange.
// On demand, never in PR CI: AIDLC_ANSWERS_LIVE=1 opens it, and each harness keeps its own live gate
// (AIDLC_CODEX_EXEC_LIVE, AIDLC_KIRO_ACP_LIVE; Claude needs the `claude` binary). Scratch projects and scratch homes
// (the SDK's ephemeral CLAUDE_CONFIG_DIR, the Codex driver's CODEX_HOME, checked before the first prompt); the real
// homes are hashed before and after, and a change in ~/.claude or ~/.codex fails the file.
//
// Pass, per item: the right choice is on the record (`expected.end.recorded`) with the person's words beside it, the
// message record keeps their words, nothing is recorded from a non-answer, the person was asked only what the item
// allows (a question asked twice is a miss), and what the agent told them after their reply matches the meaning and
// the `says` rubric (a model judge, plain words, no engine terms). A report with a score per question and every miss
// with its transcript excerpt is written under AIDLC_ANSWERS_REPORT_DIR (default tests/logs/aidlc-answers-live).
//
// Sample: AIDLC_ANSWERS_SAMPLE = a comma list of item ids, or a number per question (default 2), seeded by
// AIDLC_ANSWERS_SEED (default 1), from the items with a fixture that wait for nothing.
// Harnesses: AIDLC_ANSWERS_HARNESSES (default claude,codex,kiro).
// The mechanics shared with the input corpus's live check live in tests/harness/live-corpus.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_COMMAND_TIMEOUT_MS, LIVE_SETUP_TIMEOUT_MS, liveCaseTimeoutMs, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { execCodex, execCodexResume } from "../harness/exec-drive.ts";
import { AcpSession, driveKiroAcp } from "../harness/kiro-acp-drive.ts";
import { type AnswerSpec, driveAidlc, type DriveTurnEnd } from "../harness/sdk-drive.ts";
import {
  HOMES, PERSON_READS_RULE, drivesHome, homeDigest, judgeText, liveGate, liveHarnesses, liveProject, sampleByGroup, writeLiveReport,
  type HomeDigest, type LiveHarness, type LiveOutcome, type Transcript,
} from "../harness/live-corpus.ts";
import { codexWords } from "../harness/aidlc-input-corpus.ts";
import { ANSWERS, NO_FIXTURE, buildQuestion, messageRecord, recorded, rows, typedPrompt, waitsFor, type AnswersItem } from "../harness/aidlc-answers-corpus.ts";
import { getField, listIntents, readAuditShardEvents, stateFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(LIVE_SETUP_TIMEOUT_MS);

const LIVE = process.env.AIDLC_ANSWERS_LIVE === "1";
const HARNESSES = liveHarnesses(process.env.AIDLC_ANSWERS_HARNESSES, "AIDLC_ANSWERS_HARNESSES");
const CASE_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_COMMAND_TIMEOUT_MS);
const REPORT_DIR = process.env.AIDLC_ANSWERS_REPORT_DIR ?? join(REPO_ROOT, "tests", "logs", "aidlc-answers-live");
const gate = (harness: LiveHarness): string | null => liveGate(harness, LIVE, "set AIDLC_ANSWERS_LIVE=1 to drive the answers corpus through real agents (spends tokens)");

// Items a real agent can be driven through: a fixture exists, nothing is waited for, and the reply is one a person can
// give in a live chat (a dismissed box is the unit check's). Codex and Kiro CLI have no question box, so picker items
// stay with Claude Code; a `$aidlc` line is Codex's.
function eligible(harness: LiveHarness): AnswersItem[] {
  return ANSWERS.filter((item) =>
    NO_FIXTURE[item.question] === undefined && waitsFor(item) === null &&
    !(item.via === "picker" && (item.picker?.answer === null || item.picker?.answer === "" || harness !== "claude")) &&
    !(item.via === "codex" && harness !== "codex"));
}
const sample = (harness: LiveHarness): AnswersItem[] =>
  sampleByGroup(eligible(harness), process.env.AIDLC_ANSWERS_SAMPLE ?? "2", process.env.AIDLC_ANSWERS_SEED, (item) => item.question);

const before = new Map<string, HomeDigest>();
const outcomes: LiveOutcome<AnswersItem>[] = [];

// What the project held before the person replied: the records, how long the audit was, and how many rows of each
// event the fixture itself carries (a gate fixture holds its own summary confirmation, say): only rows after that are
// the reply's.
interface Start { records: number; active: string | null; stage: string | null; events: number; rowsBefore: Record<string, number> }
const RECORD_EVENTS = ["PLAN_APPROVAL_RECORDED", "GATE_APPROVED", "GATE_REJECTED", "REQUEST_ROUTED", "ARTIFACT_REUSED", "QUESTION_ANSWERED", "SUMMARY_CONFIRMATION_RECORDED", "VERIFICATION_COMMAND_RECORDED", "CONSTRUCTION_POLICY_RECORDED"];
const ANSWER_EVENTS = ["QUESTION_ANSWERED", "SUMMARY_CONFIRMATION_RECORDED", "VERIFICATION_COMMAND_RECORDED", "CONSTRUCTION_POLICY_RECORDED"];
const startOf = (proj: string): Start => ({
  records: listIntents(proj).length,
  active: listIntents(proj).find((i) => i.active)?.slug ?? null,
  stage: existsSync(stateFilePath(proj)) ? getField(readFileSync(stateFilePath(proj), "utf-8"), "Current Stage") : null,
  events: readAuditShardEvents(proj).length,
  rowsBefore: Object.fromEntries(RECORD_EVENTS.map((event) => [event, rows(proj, event).length])),
});
const rowsAfter = (proj: string, start: Start, event: string) => rows(proj, event).slice(start.rowsBefore[event] ?? 0);

// The choice on record now, as the item's `end.recorded` names it: the harness's own readers first, then the audit rows
// the agent's answer commands write. A routing reply leaves no row of its own: separate new work is a new record, and
// "part of this work" is the open work carrying on (rows after the reply, no new record).
function recordedNow(item: AnswersItem, proj: string, start: Start): string {
  const choice = recorded(proj, item).choice;
  // "unknown" is the plan question no longer open: the agent answered it, and the record is the audit row.
  if (choice !== "none" && choice !== "unknown") return choice;
  const since = (event: string) => rowsAfter(proj, start, event).length > 0;
  const intents = listIntents(proj);
  const fresh = intents.length > start.records ? intents.at(-1) : undefined;
  switch (item.question) {
    case "routing":
      // Folding the words into the open work leaves no row of its own (see workCarriedOn); dropping them leaves none either.
      if (fresh) return "Separate new piece of work";
      if (since("REQUEST_ROUTED")) return "Reshape the active work";
      return "none";
    case "plan-offer":
    case "scope-confirm":
      // Going ahead creates the work on the offered plan; a different plan creates it on another.
      if (fresh) return fresh.scope === "bugfix" ? 'Go ahead with the "bugfix" plan' : `A different plan (${fresh.scope ?? "?"})`;
      return "none";
    case "intent-pick": {
      const active = intents.find((i) => i.active)?.slug ?? null;
      return active !== null && active !== start.active ? active : "none";
    }
    case "unit-paused":
      if (readAuditShardEvents(proj).slice(start.events).some((e) => e.event === "UNIT_RESUMED")) return "Resume";
      break;
    case "resume-reentry":
    case "jump-target": {
      if (fresh) return "fresh";
      const stage = existsSync(stateFilePath(proj)) ? getField(readFileSync(stateFilePath(proj), "utf-8"), "Current Stage") : null;
      if (stage !== null && stage !== start.stage) return `jump ${stage}`;
      break;
    }
    default:
      break;
  }
  // The project-type answer reclassifies the workspace: the row names the new type, with the person as its source.
  if (item.question === "project-type") {
    const row = readAuditShardEvents(proj).slice(start.events).findLast((e) => e.event === "WORKSPACE_RECLASSIFIED");
    if (row) return /New Project Type\*\*: Brownfield/.test(row.block) ? "Yes, it is existing code" : "No, it stays a new project";
  }
  if (since("PLAN_APPROVAL_RECORDED")) return "approved plan";
  if (since("GATE_APPROVED")) return "Approve";
  if (since("GATE_REJECTED")) return "Request Changes";
  if (since("REQUEST_ROUTED")) return "routed";
  if (since("ARTIFACT_REUSED")) return rowsAfter(proj, start, "ARTIFACT_REUSED").at(-1)?.Decision ?? "reused";
  // The agent's answer command lands on a row named for the question (a summary confirmation, a verification command, a
  // Construction policy) or on QUESTION_ANSWERED; the row carries the choice.
  const answered = ANSWER_EVENTS.flatMap((event) => rowsAfter(proj, start, event)).at(-1);
  if (answered) return answered.Choice ?? answered.Details ?? answered.Decision ?? "answered";
  return "none";
}
// True once the choice the item expects is on record: the drive stops at that point.
// The open work carried on after the reply: rows the stage wrote, no record created. A routing reply folded into the
// work ends there; so does a non-answer the agent read past, which the judge of the words catches.
const workCarriedOn = (proj: string, start: Start): boolean =>
  listIntents(proj).length === start.records && readAuditShardEvents(proj).slice(start.events).some((e) => e.event !== "HUMAN_TURN");
function endReached(item: AnswersItem, proj: string, start: Start): boolean {
  const end = item.expected.end;
  if (end.recorded === "none") return false;
  if (item.question === "routing" && end.recorded === "Part of the active work") return workCarriedOn(proj, start);
  const now = recordedNow(item, proj, start);
  if (now === "none") return false;
  if (end.recorded === "first stage" || end.recorded === "jump") return now.startsWith("jump");
  return now.toLowerCase().includes(end.recorded.toLowerCase().split(" ")[0]) || end.recorded.toLowerCase().includes(now.toLowerCase());
}
// How many questions the item allows after the reply. A non-answer (the host's cancellation text, an empty line: the
// corpus keeps no words for it) leaves the question standing, so showing it again is not asking twice.
const asksAllowed = (item: AnswersItem): number => item.expected.engine.words === null ? Math.max(item.expected.end.asks, 1) : item.expected.end.asks;
const SETTING_FIELDS: Record<string, string> = { "plan-approval": "Plan Approval", review: "Review", "guard-policy": "Guard Policy" };

// The end state against `expected.end`, and the record against the typed line.
function judge(item: AnswersItem, proj: string, typed: string, transcript: Transcript, start: Start): { failures: string[]; endSummary: string } {
  const failures: string[] = [];
  const end = item.expected.end;
  const now = recordedNow(item, proj, start);
  const asked = transcript.asks ?? 0;
  // A question the item allows pauses the work there: the end state is owed only when the agent did not stop to ask.
  const paused = asked > 0 && asked <= asksAllowed(item);
  const record = messageRecord(proj, typed);
  if (record === null) failures.push("no message record for the typed line");
  else if (record.text.trim() !== typed.trim()) failures.push(`record text ${JSON.stringify(record.text)} is not the typed line`);
  if (end.recorded === "none") {
    if (now !== "none") failures.push(`a choice was recorded (${now}) where the item records none`);
  } else if (!paused) {
    if (!endReached(item, proj, start)) failures.push(now === "none" ? `nothing recorded; expected ${end.recorded}` : `recorded ${JSON.stringify(now)}, expected ${JSON.stringify(end.recorded)}`);
    if (end.words && item.via !== "picker") {
      const words = typed.replace(/^[/$]aidlc\s*/, "");
      const row = RECORD_EVENTS.map((e) => rowsAfter(proj, start, e).at(-1)).find((r) => r !== undefined);
      const kept = recorded(proj, item).words ?? "";
      const onRow = [row?.["Person Reply"], row?.["User Input"], row?.Feedback, row?.Reply].some((v) => (v ?? "").includes(words));
      if (!onRow && !kept.includes(words)) failures.push(`the person's words ${JSON.stringify(words)} are not on the record beside the choice`);
    }
  }
  const state = existsSync(stateFilePath(proj)) ? readFileSync(stateFilePath(proj), "utf-8") : "";
  for (const [field, value] of paused ? [] : end.set ?? []) {
    const name = SETTING_FIELDS[field] ?? field;
    const got = getField(state, name) ?? "";
    if (!got.toLowerCase().includes(value.toLowerCase())) failures.push(`${name}: ${JSON.stringify(got)}, expected to contain ${JSON.stringify(value)}`);
  }
  if (end.parked && !paused && (getField(state, "Status") ?? "").toLowerCase() !== "parked") failures.push(`the work was not parked (Status ${JSON.stringify(getField(state, "Status") ?? "")})`);
  if (transcript.asks !== null && transcript.asks > asksAllowed(item)) failures.push(`${transcript.asks} question(s) to the person, ${asksAllowed(item)} allowed (asked twice)`);
  return { failures, endSummary: `recorded ${now}; asks ${transcript.asks ?? "?"}` };
}

// A picker reply as the person gives it: the option when the answer is one of the options shown (its "(Recommended)"
// tag aside), else their own words typed into the box's free-text field.
const DECORATED = /\s*\((Recommended|Default)\)\s*$/i;
function pickerSpec(item: AnswersItem): { spec: AnswerSpec; label: string | null } {
  const answer = item.picker?.answer ?? item.input;
  const label = answer.replace(DECORATED, "");
  const offered = (item.picker?.options ?? []).some((o) => o.replace(DECORATED, "") === label);
  return offered ? { spec: { labelContains: label }, label } : { spec: { text: answer }, label: null };
}

// The agent's first turn must show the item's question: when what it showed offers no such choice (re-entry showed another
// question, or none), the reply answers nothing this item judges, and the line says what was shown instead.
// The choice the corpus names most often for a question: its first option, the most stable wording the agent shows.
const USUAL_CHOICE = new Map<string, string>();
for (const question of [...new Set(ANSWERS.map((i) => i.question))]) {
  const counts = new Map<string, number>();
  for (const item of ANSWERS) if (item.question === question && item.expected.end.recorded !== "none") counts.set(item.expected.end.recorded, (counts.get(item.expected.end.recorded) ?? 0) + 1);
  const usual = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (usual !== undefined) USUAL_CHOICE.set(question, usual);
}
function showsQuestion(item: AnswersItem, firstText: string): string | null {
  const want = item.expected.end.recorded;
  if (want === "none") return null;
  const shown = firstText.toLowerCase();
  const offered = (label: string): boolean => {
    const words = label.replace(DECORATED, "").toLowerCase().split(/[^a-z0-9'-]+/).filter(Boolean);
    return words.length === 0 || words.filter((w) => shown.includes(w)).length >= Math.ceil(words.length * 2 / 3);
  };
  if (offered(want) || offered(USUAL_CHOICE.get(item.question) ?? want)) return null;
  return `setup: the agent did not show the ${item.question} question (no choice ${JSON.stringify(want)} offered); it said: ${JSON.stringify(firstText.trim().slice(-300))}`;
}

/** What the person says first so the agent shows the question: a bare /aidlc re-enters the open work and shows the
 * question open there; the routing question, the plan offer and the record pick are the engine's reply to a typed line,
 * so that line (the fixture's own) is said first; null where the item's own line is the whole exchange. */
const FIRST_PROMPT: Partial<Record<AnswersItem["question"], string | null>> = {
  routing: "/aidlc fix the login",
  "plan-offer": "/aidlc fix the login: it rejects a correct password",
  "scope-confirm": "/aidlc fix the login timeout",
  "resume-reentry": null,
  "jump-target": null,
};
function firstPrompt(item: AnswersItem, harness: LiveHarness): string | null {
  const line = item.question in FIRST_PROMPT ? FIRST_PROMPT[item.question] ?? null : "/aidlc";
  return line === null ? null : harness === "codex" ? line.replace(/^\/aidlc/, "$aidlc") : line;
}

// Each driver's person-turn ledger refuses a drive whose decisions no turn of the person backs (a reply or a box
// submission backs one decision per question it answered: one reply that approves every plan of a group writes one row
// per plan). That is the drive's accounting, reported as such; the item is not judged.
const ledgerRefusal = (e: unknown): e is Error => e instanceof Error && /recorded \d+ decision\(s\) as the person's/.test(e.message);

const REAL_CODEX_HOME = join(homedir(), ".codex");
// Answering one question takes the agent a handful of tool calls; a drive still running past this many after the reply
// has left the question behind (a runaway into later stages), and what it did there is not what the item judges.
const REPLY_TOOL_BUDGET = 30;
let judgeDir = "";
async function drive(harness: LiveHarness, item: AnswersItem): Promise<LiveOutcome<AnswersItem>> {
  // Codex has no /aidlc skill: the same line is typed as `$aidlc` there, as the input corpus's live check does.
  const typed = harness === "codex" ? typedPrompt(item).replace(/^\/aidlc/, "$aidlc") : typedPrompt(item);
  const first = firstPrompt(item, harness);
  const { proj, home, cleanup } = liveProject(harness);
  const driveFailures: string[] = [];
  // What the person said as the record keeps it: the typed line, or for a picker reply the label the box offered.
  let said = typed;
  // What the agent showed before the person replied.
  let firstText = "";
  try {
    await buildQuestion(proj, item.question);
    const start = startOf(proj);
    let transcript: Transcript;
    if (harness === "claude") {
      // Turn 1: the agent shows the open question. The person does not use the box when they reply in chat or after
      // /aidlc ("Chat about this"), and their line is turn 2; a picker reply answers the box in turn 1. Every box after
      // the person's own answer is a question put to them after it: it stays open (the drive never answers for them,
      // which would approve or pick on their behalf), and the turn ends there. The drive also ends one tool call after
      // the choice is on record (the agent says its line to the person between that step and its next tool call, and
      // would then carry on into work this item does not judge), or after REPLY_TOOL_BUDGET tool calls past the reply.
      let firstTurn: DriveTurnEnd | undefined;
      let reachedAt: number | null = null;
      let boxes = 0;
      const picker = pickerSpec(item);
      const r = await driveAidlc(first ?? typed, {
        projectDir: proj,
        permissionMode: "bypassPermissions",
        chatAboutQuestionWhen: () => {
          boxes += 1;
          return item.via !== "picker" || boxes > 1;
        },
        answerScript: { kind: "sequence", specs: [picker.spec] },
        nextMessage: (turn) => {
          if (first === null || firstTurn !== undefined || item.via === "picker") return undefined;
          firstTurn = turn;
          return typed;
        },
        stopWhen: (results) => {
          if (reachedAt === null && endReached(item, proj, start)) reachedAt = results.length;
          const replied = item.via === "picker" ? boxes > 0 : firstTurn !== undefined;
          const since = results.length - (item.via === "picker" ? 0 : (firstTurn?.toolResults ?? 0));
          return (reachedAt !== null && results.length > reachedAt + 1) || (replied && since > REPLY_TOOL_BUDGET);
        },
        timeoutMs: remainingOperationTimeoutMs(CASE_TIMEOUT_MS),
      });
      // What the person read after their reply: the prose after turn 1 (chat), or after the box they answered (picker);
      // every box after the question itself is a question put to the person after their reply.
      const boxesBefore = item.via === "picker" ? Math.min(1, r.askedQuestions.length) : (firstTurn?.askedQuestions ?? 0);
      const shown = item.via === "picker" ? (r.askedQuestions.length > 0 ? (r.assistantTextBeforeFirstAsk ?? "").length : 0) : (firstTurn?.assistantText.length ?? 0);
      firstText = [r.assistantText.slice(0, shown), ...r.askedQuestions.slice(0, boxesBefore).flatMap((q) => q.questions.flatMap((x) => [x.question, ...x.options.map((o) => o.label)]))].join("\n");
      transcript = {
        tools: r.toolResults.map((t) => `${t.toolName} ${JSON.stringify(t.input).slice(0, 200)} -> ${t.resultText.slice(0, 200)}`),
        text: [r.assistantText.slice(shown), ...r.askedQuestions.slice(boxesBefore).flatMap((q) => q.questions.map((x) => `Question to the person: ${x.question} [${x.options.map((o) => o.label).join(" / ")}]`))].join("\n"),
        asks: r.askedQuestions.length - boxesBefore,
      };
      // The driver falls back to the first option when the box offers no such label: that is the drive's doing, named as such.
      const box = r.askedQuestions[0];
      if (item.via === "picker" && box !== undefined) {
        const picked = Object.values(box.answers).flat().join(" / ");
        if (picked !== "") said = picked;
        if (picker.label !== null && !picked.includes(picker.label)) driveFailures.push(`drive: the box offered [${box.questions.flatMap((q) => q.options.map((o) => o.label)).join(" / ")}] and the driver picked ${JSON.stringify(picked)}, not ${JSON.stringify(picker.label)}`);
      }
    } else if (harness === "codex") {
      // Scratch home only: the drive's CODEX_HOME must not be the person's.
      if (home === undefined || home === REAL_CODEX_HOME) throw new Error(`the Codex drive has no scratch home (${home ?? "none"})`);
      if (first !== null) firstText = codexWords(execCodex(proj, home, first).out);
      const r = first === null ? execCodex(proj, home, typed) : execCodexResume(proj, home, typed);
      transcript = { tools: [], text: codexWords(r.out), asks: null, raw: r.out };
    } else {
      // One live ACP session for both turns: the agent shows the question, then reads the person's reply in the same chat.
      const session = new AcpSession(proj, "aidlc", true);
      try {
        if (first !== null) firstText = (await driveKiroAcp({ projectDir: proj, prompt: first, session, keepAlive: true, timeoutMs: remainingOperationTimeoutMs(CASE_TIMEOUT_MS) })).assistantText;
        const r = await driveKiroAcp({ projectDir: proj, prompt: typed, session, keepAlive: true, timeoutMs: remainingOperationTimeoutMs(CASE_TIMEOUT_MS) });
        transcript = { tools: r.toolCalls.map((t) => `${t.title ?? ""} ${JSON.stringify(t).slice(0, 300)}`), text: r.assistantText, asks: null };
      } finally {
        session.close();
      }
    }
    // The questions put to the person: the boxes the driver saw, and the questions the judge reads in the prose (the
    // only kind on Codex and Kiro CLI, and what Claude's agent asks when it does not open a box).
    const words = await judgeText({ typed: said, meaning: item.meaning, asksAllowed: asksAllowed(item), says: item.expected.end.says, engineWords: PERSON_READS_RULE }, transcript.text, judgeDir);
    if (words.asked !== null) transcript.asks = Math.max(transcript.asks ?? 0, words.asked);
    const { failures, endSummary } = judge(item, proj, said, transcript, start);
    if (words.failure !== null) failures.push(words.failure);
    const setup = first === null ? null : showsQuestion(item, firstText);
    // A reply to a question the agent never showed judges nothing about the reply: the setup line stands alone.
    return { item, harness, prompt: said, failures: setup !== null ? [setup, ...driveFailures] : [...driveFailures, ...failures], endSummary, transcript: { ...transcript, text: `[shown first]\n${firstText}\n[after the reply]\n${transcript.text}` } };
  } catch (e) {
    if (ledgerRefusal(e)) {
      return { item, harness, prompt: said, failures: [`drive: ${e.message.replace(/\s+/g, " ").trim()}`], endSummary: "drive aborted by its ledger", transcript: { tools: [], text: firstText, asks: null } };
    }
    throw e;
  } finally {
    cleanup();
  }
}

beforeAll(() => {
  for (const home of HOMES) before.set(home, homeDigest(home));
  judgeDir = mkdtempSync(join(tmpdir(), "aidlc-answers-judge-"));
  mkdirSync(join(judgeDir, "config"), { recursive: true });
});
afterAll(() => {
  writeLiveReport({
    dir: REPORT_DIR, title: "Live answers corpus", outcomes, groupName: "question", group: (o) => o.item.question,
    recordMeans: "wrong or missing record: the choice recorded, the person's words beside it, a setting, the typed line", label: (o) => `${o.item.question} ${o.item.via}`,
    sampleLine: `Sample: ${process.env.AIDLC_ANSWERS_SAMPLE ?? "2"} per question, seed ${process.env.AIDLC_ANSWERS_SEED ?? "1"}.`,
    homes: before, drives: (home) => drivesHome(home, HARNESSES),
  });
  if (judgeDir) rmSync(judgeDir, { recursive: true, force: true });
  if (!LIVE) return;
  // The judge's own claude -p runs under its own config dir, so ~/.claude is owed unchanged on every run; a driven
  // Codex home too. Kiro CLI writes its own session data under ~/.kiro while it runs, so that home is reported, not asserted.
  for (const home of HOMES.filter((h) => !h.endsWith(".kiro") && drivesHome(h, HARNESSES))) {
    const was = before.get(home);
    if (was) expect(homeDigest(home).digest, `${home} changed during the live run`).toBe(was.digest);
  }
});

for (const harness of HARNESSES) {
  const reason = gate(harness);
  describe(`${harness}: the answers corpus through a real agent`, () => {
    if (reason !== null) {
      test.skip(`skipped: ${reason}`, () => {});
      return;
    }
    for (const item of sample(harness)) {
      test(`${item.id} ${item.question} ${item.via} ${JSON.stringify(item.input)}`, async () => {
        const outcome = await drive(harness, item);
        outcomes.push(outcome);
        expect(outcome.failures, `${item.meaning}\n${outcome.transcript.text.slice(-800)}`).toEqual([]);
      }, CASE_TIMEOUT_MS);
    }
  });
}
