// covers: file:tests/harness/live-corpus.ts
//
// The answers corpus in the nightly: the Claude SDK family's Linux live job opens the live check (no switch of its
// own reaches a live file there), drives one item per question by a date rotation, and reports every miss without
// failing. The summary it writes beside its report is what the nightly report reads.
//
// Mechanism: function - the rotation, the nightly switch, an item's owed misses and the summary, read back from an
// evidence folder laid out as the live job uploads it; no agent runs.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAnswers } from "../../scripts/ci-preview-test-report.ts";
import { ANSWERS } from "../harness/aidlc-answers-corpus.ts";
import { inNightly, type LiveOutcome, type LiveReport, liveItem, liveSummary, nightOf, ROTATION_START, rotateByGroup } from "../harness/live-corpus.ts";

interface Item { id: string; meaning: string; group: string }
const item = (id: string, group: string): Item => ({ id, meaning: `meaning of ${id}`, group });
const outcome = (it: Item, failures: string[]): LiveOutcome<Item> =>
  ({ item: it, harness: "claude", prompt: it.id, failures, endSummary: "", transcript: { tools: [], text: "", asks: 0 } });
const report = (outcomes: LiveOutcome<Item>[]): LiveReport<Item> => ({
  dir: "", title: "Live answers corpus", outcomes, groupName: "question", group: (o) => o.item.group, recordMeans: "", label: () => "",
  sampleLine: "Sample: the nightly's one item per question, night 3.", reportOnly: true, homes: new Map(), drives: () => true,
});

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the answers corpus in the nightly", () => {
  test("a night is a UTC date, counted from the rotation's first", () => {
    expect(nightOf(new Date(`${ROTATION_START}T00:00:00Z`))).toBe(0);
    expect(nightOf(new Date(`${ROTATION_START}T23:59:59.999Z`))).toBe(0);
    expect(nightOf(new Date(Date.parse(`${ROTATION_START}T00:00:00Z`) + 86_400_000))).toBe(1);
    expect(nightOf(new Date(Date.parse(`${ROTATION_START}T00:00:00Z`) - 1))).toBe(-1);
  });

  test("one item per question a night, each question's items in turn, so every item comes round", () => {
    const pool = [item("a0", "a"), item("b0", "b"), item("a1", "a"), item("c0", "c"), item("a2", "a"), item("c1", "c")];
    const ids = (night: number) => rotateByGroup(pool, night, (i) => i.group).map((i) => i.id);
    expect(ids(0)).toEqual(["a0", "b0", "c0"]);
    expect(ids(1)).toEqual(["a1", "b0", "c1"]);
    expect(ids(2)).toEqual(["a2", "b0", "c0"]);
    expect(ids(3)).toEqual(["a0", "b0", "c1"]);
    expect(ids(6)).toEqual(ids(0));
    expect(ids(-1)).toEqual(["a2", "b0", "c1"]);
    // The corpus itself: one item per question, and every item within the largest question's count of nights.
    const question = (i: (typeof ANSWERS)[number]) => i.question;
    const questions = new Set(ANSWERS.map(question));
    const largest = Math.max(...[...questions].map((q) => ANSWERS.filter((i) => i.question === q).length));
    const seen = new Set<string>();
    for (let night = 0; night < largest; night++) {
      const tonight = rotateByGroup(ANSWERS, night, question);
      expect(tonight.map(question)).toEqual([...questions]);
      for (const i of tonight) seen.add(i.id);
    }
    expect(seen.size).toBe(ANSWERS.length);
  });

  test("the nightly is the Claude SDK family's live job on GitHub Actions, and nothing else", () => {
    expect(inNightly({ GITHUB_ACTIONS: "true", AIDLC_CLAUDE_SDK_LIVE: "1" })).toBe(true);
    expect(inNightly({ AIDLC_CLAUDE_SDK_LIVE: "1" })).toBe(false);
    expect(inNightly({ GITHUB_ACTIONS: "true" })).toBe(false);
    expect(inNightly({ GITHUB_ACTIONS: "true", AIDLC_CODEX_EXEC_LIVE: "1" })).toBe(false);
    expect(inNightly({ AIDLC_ANSWERS_LIVE: "1" })).toBe(false);
  });

  test("a miss is owed on demand and only reported in the nightly; a drive that throws fails either way", async () => {
    const outcomes: LiveOutcome<Item>[] = [];
    const miss = outcome(item("gate-1", "gate"), ["nothing recorded; expected Approve"]);
    expect((await liveItem(async () => miss, outcomes, true)).owed).toEqual([]);
    expect((await liveItem(async () => miss, outcomes, false)).owed).toEqual(["nothing recorded; expected Approve"]);
    expect(outcomes).toHaveLength(2);
    await expect(liveItem(async () => { throw new Error("the driver crashed"); }, outcomes, true)).rejects.toThrow("the driver crashed");
    expect(outcomes).toHaveLength(2);
  });

  test("the summary counts each miss by kind, the check's own apart, names its item, and the nightly report reads it back", () => {
    const outcomes = [
      outcome(item("gate-1", "gate"), []),
      outcome(item("gate-2", "gate"), ["nothing recorded; expected Approve", "the agent's words: it named a hook"]),
      outcome(item("plan-1", "code-plan"), ["2 question(s) to the person, 1 allowed (asked twice)"]),
      outcome(item("route-1", "routing"), ["the agent said nothing to the person before carrying on (no line about what it did)"]),
      // The check's own: the agent never showed the question, so the reply judged nothing.
      outcome(item("learn-1", "learnings"), ["setup: the agent did not show the learnings question (no choice \"Nothing to add\" offered); it said: \"\""]),
      outcome(item("pick-1", "intent-pick"), ["drive: the box offered [a / b] and the driver picked \"a\", not \"b\"", "the agent's words: it named a hook"]),
    ];
    const summary = liveSummary(report(outcomes), "claude", "abc1234", "2026-10-15T21-40-00-000Z");
    expect(summary).toEqual({
      title: "Live answers corpus", harness: "claude", sha: "abc1234", stamp: "2026-10-15T21-40-00-000Z",
      sample: "Sample: the nightly's one item per question, night 3.", reportOnly: true,
      items: 6, passed: 1, misses: { setup: 2, record: 1, question: 1, words: 3 },
      missed: [
        { id: "gate-2", group: "gate", kinds: ["record", "words"] },
        { id: "plan-1", group: "code-plan", kinds: ["question"] },
        { id: "route-1", group: "routing", kinds: ["words"] },
        { id: "learn-1", group: "learnings", kinds: ["setup"] },
        { id: "pick-1", group: "intent-pick", kinds: ["setup", "words"] },
      ],
    });
    // Where the live job leaves it: the run's log folder, per file and attempt, in the uploaded live artifact.
    const evidence = fs.mkdtempSync(join(tmpdir(), "t-live-answers-nightly-"));
    scratch.push(evidence);
    const folder = join(evidence, "full-suite-live-claude-sdk-1-Linux", "2026-10-15T21-15-00Z-p77", "e2e-artifacts",
      "e2e-t-live-aidlc-answers-corpus.serial", "attempt-1", "aidlc-answers-live");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(join(folder, `SUMMARY-claude-abc1234-${summary.stamp}.json`), `${JSON.stringify(summary)}\n`);
    const { title: _title, sha: _sha, ...read } = summary;
    expect(collectAnswers(evidence)).toEqual([read]);
  });
});
