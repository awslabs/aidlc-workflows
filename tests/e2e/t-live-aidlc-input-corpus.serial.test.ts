// covers: file:skills/aidlc/SKILL.md, subcommand:aidlc-orchestrate:next, hook:aidlc-record-human-turn
//
// t-live-aidlc-input-corpus: a sample of the /aidlc input corpus (tests/fixtures/aidlc-input/corpus.json) driven
// through REAL agents on the shipped trees: Claude Code through the SDK, Codex through `codex exec`, Kiro CLI over
// ACP. On demand, never in PR CI: AIDLC_INPUT_LIVE=1 opens it, and each harness keeps its own live gate
// (AIDLC_CODEX_EXEC_LIVE, AIDLC_KIRO_ACP_LIVE; Claude needs the `claude` binary). Scratch projects and scratch homes
// (the SDK's ephemeral CLAUDE_CONFIG_DIR, the Codex driver's CODEX_HOME); the real homes are listed and hashed
// before and after, and a change in ~/.claude or ~/.codex fails the file.
//
// Pass, per item: the end state matches `expected.end` (the right work created or none, the right record active,
// the right setting set by the person, the gate or plan answered), the message record keeps their words, and a
// question reached the person only where the item is `ambiguous`. A report with a score per category and every
// miss with its transcript excerpt is written under AIDLC_INPUT_REPORT_DIR (default tests/logs/aidlc-input-live).
//
// Sample: AIDLC_INPUT_SAMPLE = a comma list of item ids, or a number per category (default 3), seeded by
// AIDLC_INPUT_SEED (default 1), from the items that carry `expected.end` and wait for nothing.
// Harnesses: AIDLC_INPUT_HARNESSES (default claude,codex,kiro).
// The mechanics shared with the answers corpus's live check live in tests/harness/live-corpus.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_COMMAND_TIMEOUT_MS, LIVE_SETUP_TIMEOUT_MS, liveCaseTimeoutMs, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { execCodex } from "../harness/exec-drive.ts";
import { driveKiroAcp } from "../harness/kiro-acp-drive.ts";
import { driveAidlc } from "../harness/sdk-drive.ts";
import {
  HOMES, drivesHome, homeDigest, judgeText, liveGate, liveHarnesses, liveProject, sampleByGroup, writeLiveReport,
  type HomeDigest, type LiveHarness, type LiveOutcome, type Transcript,
} from "../harness/live-corpus.ts";
import { CORPUS, buildState, codexWords, itemEnv, messageRecord, typedPrompt, waitsFor, type CorpusItem } from "../harness/aidlc-input-corpus.ts";
import { getField, listIntents, readAuditShardEvents, stateFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(LIVE_SETUP_TIMEOUT_MS);

const LIVE = process.env.AIDLC_INPUT_LIVE === "1";
const HARNESSES = liveHarnesses(process.env.AIDLC_INPUT_HARNESSES, "AIDLC_INPUT_HARNESSES");
const CASE_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_COMMAND_TIMEOUT_MS);
const REPORT_DIR = process.env.AIDLC_INPUT_REPORT_DIR ?? join(REPO_ROOT, "tests", "logs", "aidlc-input-live");
const gate = (harness: LiveHarness): string | null => liveGate(harness, LIVE, "set AIDLC_INPUT_LIVE=1 to drive the input corpus through real agents (spends tokens)");

function sample(): CorpusItem[] {
  // Hooks-off items need the host's hooks not to run; a real agent session runs them, so they stay with the unit check.
  const eligible = CORPUS.filter((item) => item.expected.end !== undefined && waitsFor(item) === null && item.state !== "hooks-off");
  return sampleByGroup(eligible, process.env.AIDLC_INPUT_SAMPLE ?? "3", process.env.AIDLC_INPUT_SEED, (item) => item.category);
}
const SAMPLE = sample();

const before = new Map<string, HomeDigest>();
type Outcome = LiveOutcome<CorpusItem>;
const outcomes: Outcome[] = [];

interface Snapshot { records: number; active: string | null; stateFile: string }
function snapshot(proj: string): Snapshot {
  const intents = listIntents(proj);
  const path = stateFilePath(proj);
  return {
    records: intents.length,
    active: intents.find((i) => i.active)?.slug ?? null,
    stateFile: existsSync(path) ? readFileSync(path, "utf-8") : "",
  };
}

// True once what the item expects on disk is there: the drive stops at that point.
function endReached(item: CorpusItem, proj: string, start: Snapshot): boolean {
  const end = item.expected.end ?? {};
  try {
    const events = readAuditShardEvents(proj).map((e) => e.event);
    if (end.gate === "approved") return events.includes("GATE_APPROVED");
    if (end.gate === "rejected") return events.includes("GATE_REJECTED");
    if (end.plan === "approved") return events.includes("PLAN_APPROVAL_RECORDED");
    const after = snapshot(proj);
    if (end.set?.length) return end.set.every(([field, value]) => (getField(after.stateFile, field) ?? "").includes(value));
    if (end.active) return after.active === end.active;
    if (typeof end.work === "object") return after.records > start.records;
  } catch {
    /* an unreadable record is not the end */
  }
  return false;
}

// How many questions back to the person the item allows: its own `end.asks`, else one where the line is ambiguous, none where the meaning is clear.
function asksAllowedFor(item: CorpusItem): number {
  return item.expected.end?.asks ?? (item.ambiguous ? 1 : item.expected.engine.no_ask ? 0 : 1);
}

// The end state, judged against `expected.end` and the record against `expected.engine`.
function judge(item: CorpusItem, proj: string, prompt: string, start: Snapshot, transcript: Transcript): { failures: string[]; endSummary: string } {
  const failures: string[] = [];
  const end = item.expected.end ?? {};
  const engine = item.expected.engine;
  const after = snapshot(proj);
  const intents = listIntents(proj);
  const summary = `records ${start.records} -> ${after.records}, active ${start.active ?? "-"} -> ${after.active ?? "-"}`;

  const record = messageRecord(proj, prompt);
  if (record === null) failures.push("no message record for the typed line");
  else {
    if (record.text.trim() !== prompt.trim()) failures.push(`record text ${JSON.stringify(record.text)} is not the typed line`);
    if (engine.words !== undefined && record.words !== engine.words) failures.push(`record words ${JSON.stringify(record.words)}, expected ${JSON.stringify(engine.words)}`);
  }
  // A question the item allows pauses the work there: the person has not answered yet, so the end state is not owed.
  const asksAllowed = asksAllowedFor(item);
  const paused = (transcript.asks ?? 0) > 0 && (transcript.asks ?? 0) <= asksAllowed;
  if (end.work === "none" && after.records !== start.records) failures.push(`a record was created (${summary})`);
  if (end.work === "same") {
    if (after.records !== start.records) failures.push(`a record was created (${summary})`);
    if (!end.active && after.active !== start.active) failures.push(`the active record changed (${summary})`);
  }
  if (typeof end.work === "object" && !paused) {
    const created = intents.filter((i) => i.active || true).slice(start.records);
    if (after.records <= start.records) failures.push(`no new record (${summary})`);
    else {
      const fresh = created[created.length - 1];
      if (end.work.scope && fresh?.scope !== end.work.scope) failures.push(`new record scope ${fresh?.scope ?? "-"}, expected ${end.work.scope}`);
      if (end.work.words) {
        const dir = fresh?.dirName ? join(proj, "aidlc", "spaces", "default", "intents", fresh.dirName) : null;
        const text = dir && existsSync(join(dir, "aidlc-state.md")) ? readFileSync(join(dir, "aidlc-state.md"), "utf-8") : "";
        if (!text.toLowerCase().includes(end.work.words.toLowerCase())) failures.push(`the new record does not carry the words ${JSON.stringify(end.work.words)}`);
      }
    }
  }
  if (end.active && !paused && after.active !== end.active) failures.push(`active record ${after.active ?? "-"}, expected ${end.active}`);
  for (const [field, value] of paused ? [] : end.set ?? []) {
    const got = getField(after.stateFile, field) ?? "";
    if (!got.includes(value)) failures.push(`${field}: ${JSON.stringify(got)}, expected to contain ${JSON.stringify(value)}`);
  }
  const events = readAuditShardEvents(proj).map((e) => e.event);
  if (end.gate === "approved" && !paused && !events.includes("GATE_APPROVED")) failures.push("the gate was not approved");
  if (end.gate === "rejected" && !paused && !events.includes("GATE_REJECTED")) failures.push("the gate was not sent back for changes");
  if (end.gate === "open" && (events.includes("GATE_APPROVED") || events.includes("GATE_REJECTED"))) failures.push("the gate was decided");
  if (end.plan === "approved" && !paused && !events.includes("PLAN_APPROVAL_RECORDED")) failures.push("the plan was not approved");
  if (end.plan === "open" && events.includes("PLAN_APPROVAL_RECORDED")) failures.push("the plan question was answered");
  if (transcript.asks !== null && transcript.asks > asksAllowed) failures.push(`${transcript.asks} question(s) to the person, ${asksAllowed} allowed`);
  return { failures, endSummary: summary };
}

let judgeDir = "";
async function drive(harness: LiveHarness, item: CorpusItem): Promise<Outcome> {
  const prompt = harness === "codex" && item.entry === undefined ? typedPrompt(item).replace(/^\/aidlc/, "$aidlc") : typedPrompt(item);
  const { proj, home, cleanup } = liveProject(harness);
  // The item's own environment (unattended runs) reaches the agent's process the way a person's shell would.
  const extraEnv = itemEnv(item);
  const previous = Object.fromEntries(Object.keys(extraEnv).map((k) => [k, process.env[k]]));
  try {
    await buildState(proj, item.state);
    const start = snapshot(proj);
    Object.assign(process.env, extraEnv);
    let transcript: Transcript;
    if (harness === "claude") {
      // The drive ends one tool call after what the item expects is on disk (the gate approved, the setting set, the
      // record switched, the work created): the agent says its line to the person between that step and its next
      // tool call, and would then carry on into the next stage, whose own work and questions are not what this item
      // judges.
      let reachedAt: number | null = null;
      const r = await driveAidlc(prompt, {
        projectDir: proj,
        permissionMode: "bypassPermissions",
        stopAfterAskUserQuestion: true,
        stopWhen: (results) => {
          if (reachedAt === null && endReached(item, proj, start)) reachedAt = results.length;
          return reachedAt !== null && results.length > reachedAt + 1;
        },
        timeoutMs: remainingOperationTimeoutMs(CASE_TIMEOUT_MS),
        env: extraEnv,
      });
      transcript = {
        tools: r.toolResults.map((t) => `${t.toolName} ${JSON.stringify(t.input).slice(0, 200)} -> ${t.resultText.slice(0, 200)}`),
        // The person reads the agent's words up to its question, then the question itself (the picker is the agent's
        // words too). What the agent says after the drive's scripted answer was never said to a person.
        text: [r.assistantTextBeforeFirstAsk ?? r.assistantText, ...r.askedQuestions.flatMap((q) => q.questions.map((x) => `Question to the person: ${x.question} [${x.options.map((o) => o.label).join(" / ")}]`))].join("\n"),
        asks: r.askedQuestions.length,
      };
    } else if (harness === "codex") {
      const r = execCodex(proj, home as string, prompt);
      transcript = { tools: [], text: codexWords(r.out), asks: null, raw: r.out };
    } else {
      const r = await driveKiroAcp({ projectDir: proj, prompt, timeoutMs: remainingOperationTimeoutMs(CASE_TIMEOUT_MS) });
      transcript = {
        tools: r.toolCalls.map((t) => `${t.title ?? ""} ${JSON.stringify(t).slice(0, 300)}`),
        text: r.assistantText,
        asks: null,
      };
    }
    const { failures, endSummary } = judge(item, proj, prompt, start, transcript);
    const words = await judgeText({ typed: typedPrompt(item), meaning: item.meaning, asksAllowed: asksAllowedFor(item) }, transcript.text, judgeDir);
    if (words.failure !== null) failures.push(words.failure);
    return { item, harness, prompt, failures, endSummary, transcript };
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanup();
  }
}

beforeAll(() => {
  for (const home of HOMES) before.set(home, homeDigest(home));
  judgeDir = mkdtempSync(join(tmpdir(), "aidlc-input-judge-"));
  mkdirSync(join(judgeDir, "config"), { recursive: true });
});

afterAll(() => {
  writeLiveReport({
    dir: REPORT_DIR, title: "Live input corpus", outcomes, groupName: "category", group: (o) => o.item.category,
    recordMeans: "wrong or missing record: work, active record, setting, gate, plan, the typed line", label: (o) => o.item.state,
    sampleLine: `Sample: ${process.env.AIDLC_INPUT_SAMPLE ?? "3"} per category, seed ${process.env.AIDLC_INPUT_SEED ?? "1"}.`,
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
  describe(`${harness}: the input corpus through a real agent`, () => {
    if (reason !== null) {
      test.skip(`skipped: ${reason}`, () => {});
      return;
    }
    for (const item of SAMPLE) {
      test(`${item.id} ${typedPrompt(item)} [${item.state}]: ${item.meaning}`, async () => {
        const outcome = await drive(harness, item);
        outcomes.push(outcome);
        expect(outcome.failures, `${item.id} on ${harness}: ${outcome.endSummary}\n${outcome.transcript.text.slice(-400)}`).toEqual([]);
      }, CASE_TIMEOUT_MS);
    }
  });
}
