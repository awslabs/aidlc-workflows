// covers: subcommand:aidlc-log:answers, subcommand:aidlc-audit:history
// covers: function:readActiveAuditShardEvents, function:parseAuditShardNotes

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireAuditLock,
  parseAuditShardEvents,
  parseAuditShardNotes,
  readActiveAuditShardEvents,
  readAuditShardEvents,
  releaseAuditLock,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const STAGE = "requirements-analysis";
const T1 = "2026-09-27T01:00:00Z";
const T2 = "2026-09-27T01:01:00Z";
const T3 = "2026-09-27T01:02:00Z";
const projects: string[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

function project(): string {
  const pd = createTestProject();
  projects.push(pd);
  seedStateFile(pd, "state-mid-ideation.md");
  mkdirSync(seededAuditDir(pd), { recursive: true });
  return pd;
}

function row(event: string, timestamp: string, fields: Record<string, string> = {}): string {
  return `## Fixture\n**Timestamp**: ${timestamp}\n**Event**: ${event}\n` +
    Object.entries(fields).map(([key, value]) => `**${key}**: ${value}\n`).join("") + "\n---\n";
}

function question(text: string, timestamp = T1, scope: Record<string, string> = {}): string {
  return row("DECISION_RECORDED", timestamp, { Stage: STAGE, Decision: text, Options: "A, B", ...scope });
}

function answer(text: string, timestamp = T2, scope: Record<string, string> = {}): string {
  return row("QUESTION_ANSWERED", timestamp, { Stage: STAGE, Details: text, ...scope });
}

function note(heading: string, text: string, timestamp = T2): string {
  return `## ${heading}\n**Timestamp**: ${timestamp}\n${text}\n\n---\n`;
}

function shard(pd: string, name: string, content: string): void {
  writeFileSync(join(seededAuditDir(pd), `${name}.md`), content);
}

// Include directory names so a newly created lock or cache also fails the read contract.
function snapshot(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (path: string, prefix: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        entries[`${name}/`] = "";
        walk(join(path, entry.name), `${name}/`);
      } else {
        entries[name] = readFileSync(join(path, entry.name)).toString("base64");
      }
    }
  };
  walk(dir, "");
  return entries;
}

function run(pd: string, noun: "log" | "audit", args: string[], direct = false) {
  const before = snapshot(pd);
  const result = spawnSync(
    process.execPath,
    [
      join(AIDLC_SRC, "tools", direct ? `aidlc-${noun}.ts` : "aidlc.ts"),
      ...(direct ? [] : ["engine", noun]),
      ...args,
      "--project-dir", pd,
    ],
    {
      cwd: pd,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    },
  );
  expect(result.error).toBeUndefined();
  expect(snapshot(pd)).toEqual(before);
  return result;
}

function read(pd: string, noun: "log" | "audit", args: string[], direct = false) {
  const result = run(pd, noun, args, direct);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(result.stdout);
}

function answers(pd: string, args: string[] = []) {
  return read(pd, "log", ["answers", "--stage", STAGE, ...args]);
}

describe("log answers", () => {
  test("routes a simple pair with options and timestamps, without writes", () => {
    const pd = project();
    shard(pd, "one", question("Authentication?") + answer("A"));
    const expected = {
      stage: STAGE,
      answered: [{
        question: "Authentication?", options: ["A", "B"], answer: "A", askedAt: T1, answeredAt: T2,
      }],
      open: [],
      ambiguous: [],
    };
    expect(answers(pd)).toEqual(expected);
    expect(read(pd, "log", ["answers", "--stage", STAGE], true)).toEqual(expected);
  });

  test("pairs only within the same unit, generation, and single-stage workflow", () => {
    const pd = project();
    const scopes = [
      {},
      { Unit: "u1" },
      { Unit: "u2" },
      { Unit: "u1", "Attempt Generation": "1" },
      { Unit: "u1", "Attempt Generation": "2" },
      { Workflow: `single-stage:${STAGE}` },
    ] as Record<string, string>[];
    shard(pd, "one", scopes.map((scope, i) => question(`Q${i}`, T1, scope)).join("") +
      scopes.map((scope, i) => answer(`A${i}`, T2, scope)).join(""));
    const result = answers(pd);
    expect(result.open).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.answered.map((pair: { question: string; answer: string }) => [pair.question, pair.answer]))
      .toEqual(scopes.map((_, i) => [`Q${i}`, `A${i}`]));
    expect(result.answered[3].attemptGeneration).toBe("1");
    expect(result.answered[5].workflow).toBe(`single-stage:${STAGE}`);
    const unit = answers(pd, ["--unit", "u1"]);
    expect(unit.answered.map((pair: { question: string }) => pair.question)).toEqual(["Q1", "Q3", "Q4"]);
    expect(unit.answered.every((pair: { unit: string }) => pair.unit === "u1")).toBe(true);
  });

  test("an approved plan checkpoint cannot leave a prompt open for a later ordinary answer", () => {
    const pd = project();
    const scope = { Stage: "code-generation", Checkpoint: "Code Generation Plan Approval" };
    shard(pd, "one", question("Approve Plan?", T1, scope) +
      row("PLAN_APPROVAL_RECORDED", T1, { ...scope, "User Input": "Approve Plan" }) +
      question("Normal question", T2, { Stage: scope.Stage }) +
      answer("A", T3, { Stage: scope.Stage }));
    expect(read(pd, "log", ["answers", "--stage", scope.Stage])).toEqual({
      stage: scope.Stage,
      answered: [{
        question: "Normal question", options: ["A", "B"], answer: "A", askedAt: T2, answeredAt: T3,
      }],
      open: [],
      ambiguous: [],
    });
  });

  test("every present checkpoint field excludes both prompts and ordinary answer rows", () => {
    for (const checkpoint of [
      "Code Generation Plan Approval", "Construction Policy", "Construction Verification Command",
      "Consolidated Summary Confirmation", "",
    ]) {
      const pd = project();
      shard(pd, "one", question("Protected question", T1, { Checkpoint: checkpoint }) +
        question("Normal question", T1) +
        answer("Protected answer", T2, { Checkpoint: checkpoint }) + answer("A", T3));
      expect(answers(pd)).toEqual({
        stage: STAGE,
        answered: [{
          question: "Normal question", options: ["A", "B"], answer: "A", askedAt: T1, answeredAt: T3,
        }],
        open: [],
        ambiguous: [],
      });
    }
  });

  test("a missing or different scope field cannot borrow an answer", () => {
    for (const [field, value] of [
      ["Stage", "code-generation"],
      ["Unit", "u1"],
      ["Attempt Generation", "2"],
      ["Workflow", `single-stage:${STAGE}`],
    ]) {
      const pd = project();
      shard(pd, "one", question("Q") + answer("A", T2, { [field]: value }));
      expect(answers(pd).answered, field).toEqual([]);
      expect(answers(pd).open.map((q: { question: string }) => q.question), field).toEqual(["Q"]);
    }
  });

  test("two open prompts make an answer ambiguous even when its text names one", () => {
    const pd = project();
    shard(pd, "one", question("Authentication?") + question("Storage?") + answer("Authentication?"));
    expect(answers(pd)).toEqual({
      stage: STAGE,
      answered: [],
      open: ["Authentication?", "Storage?"].map((q) => ({ question: q, options: ["A", "B"], askedAt: T1 })),
      ambiguous: [{ answer: "Authentication?", answeredAt: T2, candidates: ["Authentication?", "Storage?"] }],
    });
  });

  test("equal timestamps across shards remain ambiguous regardless of filename order", () => {
    for (const names of [["a", "z"], ["z", "a"]]) {
      const pd = project();
      shard(pd, names[0], question("Q", T1));
      shard(pd, names[1], answer("A", T1));
      const result = answers(pd);
      expect(result.answered).toEqual([]);
      expect(result.open).toHaveLength(1);
      expect(result.ambiguous).toEqual([{ answer: "A", answeredAt: T1, candidates: ["Q"] }]);
    }
  });

  test("a tied prompt is a candidate alongside an earlier prompt", () => {
    const pd = project();
    shard(pd, "one", question("Earlier", T1) + answer("A", T2));
    shard(pd, "two", question("Tied", T2));
    expect(answers(pd).ambiguous[0].candidates).toEqual(["Earlier", "Tied"]);
    expect(answers(pd).answered).toEqual([]);
  });

  test("same-shard append position orders equal timestamps and backward clock steps", () => {
    for (const times of [[T1, T1, T1, T1], [T3, T2, T2, T1]]) {
      const pd = project();
      shard(pd, "one", question("First", times[0]) + answer("A", times[1]) +
        question("Second", times[2]) + answer("B", times[3]));
      const result = answers(pd);
      expect(result.answered.map((pair: { question: string; answer: string }) => [pair.question, pair.answer]))
        .toEqual([["First", "A"], ["Second", "B"]]);
      expect(result.open).toEqual([]);
      expect(result.ambiguous).toEqual([]);
    }
  });

  test("different timestamps order a cross-shard pair", () => {
    const pd = project();
    shard(pd, "z", question("Q"));
    shard(pd, "a", answer("A"));
    expect(answers(pd).answered[0].question).toBe("Q");
    expect(answers(pd).ambiguous).toEqual([]);
  });

  test("competing unordered answers cannot consume the same prompt or settle it later", () => {
    const pd = project();
    shard(pd, "one", question("Q") + answer("A", T2) + answer("Later", T3));
    shard(pd, "two", answer("B", T2));
    const result = answers(pd);
    expect(result.answered).toEqual([]);
    expect(result.ambiguous.map((entry: { candidates: string[] }) => entry.candidates))
      .toEqual([["Q"], ["Q"], ["Q"]]);
    expect(result.open).toHaveLength(1);
  });

  test("non-answers consume their prompt for pairing but keep it open without the non-answer text", () => {
    for (const nonAnswer of ["Cancelled", "", "User dismissed", undefined]) {
      const pd = project();
      shard(pd, "one", question("Q0") +
        (nonAnswer === undefined
          ? row("QUESTION_ANSWERED", T2, { Stage: STAGE })
          : answer(nonAnswer, T2)) +
        question("Q1", T2) + answer("A", T3));
      expect(answers(pd)).toEqual({
        stage: STAGE,
        answered: [{ question: "Q1", options: ["A", "B"], answer: "A", askedAt: T2, answeredAt: T3 }],
        open: [{ question: "Q0", options: ["A", "B"], askedAt: T1 }],
        ambiguous: [],
      });
    }
  });

  test("an ambiguous non-answer does not choose a prompt or appear in ambiguous answers", () => {
    const pd = project();
    shard(pd, "one", question("Q0") + question("Q1") + answer("Cancelled"));
    expect(answers(pd)).toEqual({
      stage: STAGE,
      answered: [],
      open: ["Q0", "Q1"].map((q) => ({ question: q, options: ["A", "B"], askedAt: T1 })),
      ambiguous: [],
    });
  });

  test("reports an open question without options and an orphan answer without guessing", () => {
    const pd = project();
    shard(pd, "one", answer("Question text", T1) +
      row("DECISION_RECORDED", T2, { Stage: STAGE, Decision: "Question text" }));
    expect(answers(pd)).toEqual({
      stage: STAGE,
      answered: [],
      open: [{ question: "Question text", options: [], askedAt: T2 }],
      ambiguous: [{ answer: "Question text", answeredAt: T1, candidates: [] }],
    });
  });
});

describe("audit history", () => {
  test("merges oldest first, preserves tied append positions, and marks cross-shard ties", () => {
    const pd = project();
    shard(pd, "a", row("STAGE_STARTED", T2, { Stage: STAGE, Details: "middle-1" }) +
      row("QUESTION_ANSWERED", T2, { Stage: STAGE, Details: "middle-2" }));
    shard(pd, "z", row("WORKFLOW_STARTED", T1, { Scope: "feature" }) +
      row("STAGE_COMPLETED", T2, { Stage: "feasibility" }) +
      row("WORKFLOW_COMPLETED", T3));
    const expected = {
      events: [
        { timestamp: T1, event: "WORKFLOW_STARTED", fields: { Scope: "feature" } },
        { timestamp: T2, event: "STAGE_STARTED", fields: { Stage: STAGE, Details: "middle-1" }, unordered: true },
        { timestamp: T2, event: "QUESTION_ANSWERED", fields: { Stage: STAGE, Details: "middle-2" }, unordered: true },
        { timestamp: T2, event: "STAGE_COMPLETED", fields: { Stage: "feasibility" }, unordered: true },
        { timestamp: T3, event: "WORKFLOW_COMPLETED", fields: {} },
      ],
    };
    expect(read(pd, "audit", ["history"])).toEqual(expected);
    expect(read(pd, "audit", ["history"], true)).toEqual(expected);
  });

  test("filters stage and repeated event types before retaining the newest n", () => {
    const pd = project();
    shard(pd, "one", question("Q") + answer("A") + row("STAGE_COMPLETED", T3, { Stage: STAGE }));
    shard(pd, "two", row("STAGE_STARTED", T2, { Stage: "feasibility" }));
    const result = read(pd, "audit", [
      "history", "--stage", STAGE, "--event", "DECISION_RECORDED", "--event", "QUESTION_ANSWERED", "--limit", "1",
    ]);
    expect(result.events).toEqual([{
      timestamp: T2, event: "QUESTION_ANSWERED", fields: { Stage: STAGE, Details: "A" }, unordered: true,
    }]);
    expect(read(pd, "audit", ["history", "--stage", "absent"])).toEqual({ events: [] });
    expect(read(pd, "audit", ["history", "--event", "UNKNOWN"])).toEqual({ events: [] });
    expect(read(pd, "audit", ["history", "--limit", "99"]).events).toHaveLength(4);
    expect(read(pd, "audit", ["history", "--limit", "2"]).events.map((entry: { timestamp: string }) => entry.timestamp))
      .toEqual([T2, T3]);
  });

  test("returns named fields without raw blocks or shard paths; same-shard ties are ordered", () => {
    const pd = project();
    shard(pd, "private-shard-name", question("Q", T1, { Unit: "u1", "Attempt Generation": "3" }) + answer("A", T1));
    const result = read(pd, "audit", ["history"]);
    expect(result.events[0].fields).toEqual({
      Stage: STAGE, Decision: "Q", Options: "A, B", Unit: "u1", "Attempt Generation": "3",
    });
    expect(result.events.every((entry: { unordered?: boolean }) => entry.unordered === undefined)).toBe(true);
    for (const text of ["private-shard-name", pd, seededRecordDir(pd), "## Fixture", "**Event**", "shardIndex", "\"block\""]) {
      expect(JSON.stringify(result)).not.toContain(text);
    }
  });

  test("includes notes among events with their heading and body, preserving same-shard tie order", () => {
    const pd = project();
    shard(pd, "one", row("QUESTION_ANSWERED", T1, { Stage: STAGE, Details: "first\n**Details**: second" }) +
      note("Recovery: note", "\n**Outcome**: recovered\n\n## Details\nKept the existing artifacts.\n") +
      row("STAGE_COMPLETED", T2, { Stage: STAGE }));
    const result = read(pd, "audit", ["history"]);
    expect(result.events).toEqual([
      { timestamp: T1, event: "QUESTION_ANSWERED", fields: { Stage: STAGE, Details: "first" } },
      {
        timestamp: T2, event: "NOTE", heading: "Recovery: note",
        text: "**Outcome**: recovered\n\n## Details\nKept the existing artifacts.",
      },
      { timestamp: T2, event: "STAGE_COMPLETED", fields: { Stage: STAGE } },
    ]);
  });

  test("note and event ties across shards stay unordered through event, stage, and limit filters", () => {
    const pd = project();
    const noteText = `**Stage**: ${STAGE}\n**Outcome**: recovered`;
    shard(pd, "one", row("STAGE_STARTED", T1, { Stage: STAGE }) +
      row("STAGE_COMPLETED", T2, { Stage: STAGE }));
    shard(pd, "two", note("Recovery: note", noteText) + note("Change Request: follow-up", "Requested later", T3));
    const tiedNote = { timestamp: T2, event: "NOTE", heading: "Recovery: note", text: noteText, unordered: true };
    const laterNote = { timestamp: T3, event: "NOTE", heading: "Change Request: follow-up", text: "Requested later" };
    const stageEvents = [
      { timestamp: T1, event: "STAGE_STARTED", fields: { Stage: STAGE } },
      { timestamp: T2, event: "STAGE_COMPLETED", fields: { Stage: STAGE }, unordered: true },
    ];
    expect(read(pd, "audit", ["history"])).toEqual({ events: [...stageEvents, tiedNote, laterNote] });
    expect(read(pd, "audit", ["history", "--event", "NOTE"])).toEqual({ events: [tiedNote, laterNote] });
    expect(read(pd, "audit", ["history", "--stage", STAGE])).toEqual({ events: stageEvents });
    expect(read(pd, "audit", ["history", "--stage", STAGE, "--event", "NOTE"])).toEqual({ events: [] });
    expect(read(pd, "audit", ["history", "--event", "NOTE", "--limit", "1"])).toEqual({ events: [laterNote] });
    expect(read(pd, "audit", ["history", "--event", "NOTE", "--event", "STAGE_COMPLETED"]))
      .toEqual({ events: [stageEvents[1], tiedNote, laterNote] });
  });

  test("notes retain shard positions without changing any default event reader's results", () => {
    const pd = project();
    const content = (
      "# AI-DLC Audit Log\n" + note("Recovery: first", "Recovered", T1) +
      question("Q", T2) + note("Change Request: next", "Requested", T3) +
      "## Undated note\nNo timestamp\n\n---\n"
    ).replace(/\n/g, "\r\n");
    shard(pd, "one", content);
    const notes = parseAuditShardNotes(content, "one.md", 4);
    expect(notes.map(({ event, pos, shard, shardIndex, timestamp, heading, text }) => ({
      event, pos, shard, shardIndex, timestamp, heading, text,
    }))).toEqual([
      { event: "NOTE", pos: 0, shard: "one.md", shardIndex: 4, timestamp: T1, heading: "Recovery: first", text: "Recovered" },
      { event: "NOTE", pos: 2, shard: "one.md", shardIndex: 4, timestamp: T3, heading: "Change Request: next", text: "Requested" },
    ]);
    expect(parseAuditShardEvents(content, "one.md", 4).map(({ event, pos }) => ({ event, pos })))
      .toEqual([{ event: "DECISION_RECORDED", pos: 1 }]);
    const events = readAuditShardEvents(pd);
    expect(events).toHaveLength(1);
    expect(readActiveAuditShardEvents(pd)).toEqual(events);
    expect(readActiveAuditShardEvents(pd, { includeNotes: true })).toHaveLength(3);
    expect(answers(pd)).toEqual({
      stage: STAGE, answered: [], open: [{ question: "Q", options: ["A", "B"], askedAt: T2 }], ambiguous: [],
    });
    expect(parseAuditShardNotes(
      `${row("", T1)}${row("CUSTOM_EVENT", T1)}**Timestamp**: ${T1}\nBody without heading\n\n---\n`,
      "one.md", 0,
    )).toEqual([]);
  });
});

describe("audit read command failures and lock-free behavior", () => {
  const commands = [
    { noun: "log" as const, args: ["answers", "--stage", STAGE] },
    { noun: "audit" as const, args: ["history"] },
  ];

  test("a selected empty record returns empty JSON collections", () => {
    const pd = project();
    rmSync(seededAuditDir(pd), { recursive: true });
    expect(answers(pd)).toEqual({ stage: STAGE, answered: [], open: [], ambiguous: [] });
    expect(read(pd, "audit", ["history"])).toEqual({ events: [] });
  });

  test("reads only the active intent, excluding the space-level audit", () => {
    const pd = project();
    const spaceAudit = join(seededRecordDir(pd), "..", "audit");
    mkdirSync(spaceAudit);
    writeFileSync(join(spaceAudit, "space.md"), question("Space question") + answer("Space answer"));
    shard(pd, "one", question("Intent question") + answer("Intent answer"));
    expect(answers(pd).answered.map((pair: { answer: string }) => pair.answer)).toEqual(["Intent answer"]);
    expect(read(pd, "audit", ["history"]).events).toHaveLength(2);
  });

  test("reads while the audit lock is held, without creating files or appending rows", () => {
    const pd = project();
    shard(pd, "one", question("Q") + answer("A"));
    expect(acquireAuditLock(pd)).toBe(true);
    try {
      for (const command of commands) read(pd, command.noun, command.args);
    } finally {
      releaseAuditLock(pd);
    }
  });

  test("missing or unreadable records fail on stderr without writes or partial stdout", () => {
    for (const failure of ["missing-state", "unreadable-state", "unreadable-shard", "unreadable-directory"]) {
      const pd = project();
      shard(pd, "readable", question("Q") + answer("A"));
      if (failure === "missing-state" || failure === "unreadable-state") {
        rmSync(seededStateFile(pd));
        if (failure === "unreadable-state") mkdirSync(seededStateFile(pd));
      } else if (failure === "unreadable-shard") {
        mkdirSync(join(seededAuditDir(pd), "unreadable.md"));
      } else {
        rmSync(seededAuditDir(pd), { recursive: true });
        writeFileSync(seededAuditDir(pd), "not a directory");
      }
      for (const command of commands) {
        const result = run(pd, command.noun, command.args);
        expect(result.status, failure).toBe(1);
        expect(result.stdout, failure).toBe("");
        expect(JSON.parse(result.stderr).error, failure).toBeString();
      }
    }
  });

  test("invalid flags fail without recording an ERROR_LOGGED event", () => {
    const pd = project();
    shard(pd, "one", question("Q"));
    for (const [noun, args] of [
      ["log", ["answers"]],
      ["log", ["answers", "--stage"]],
      ["log", ["answers", "--stage", "--unit", "u1"]],
      ["log", ["answers", "--stage", STAGE, "--unknown", "value"]],
      ["log", ["answers", "--stage", STAGE, "unexpected"]],
      ["audit", ["history", "--event"]],
      ["audit", ["history", "--stage", "--event", "STAGE_STARTED"]],
      ["audit", ["history", "--unknown", "value"]],
      ...["0", "-1", "1.5", "NaN", "9007199254740992"].map((limit) => ["audit", ["history", "--limit", limit]]),
    ] as Array<["log" | "audit", string[]]>) {
      const result = run(pd, noun, args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toBeString();
    }
  });
});
