// covers: subcommand:aidlc-audit:timeline, function:computeStageTimeline, function:renderStageTimeline
// The read-only stage timeline (#2211): per stage and per Unit, from the audit
// ledger alone, split into working, waiting for a reply, and long gaps, with
// human turns, gates and redo signals. It never writes to the record.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeStageTimeline,
  renderStageTimeline,
  type TimelineEntry,
  type TimelineRow,
} from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { UNTRUSTED_AUDIT_NOTICE } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, cleanupTestProject, createTestProject, seededAuditDir, seedStateFile } from "../harness/fixtures.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const projects: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

const RA = "requirements-analysis";
const FD = "functional-design";
const CG = "code-generation";
const day = (clock: string) => `2026-09-27T${clock}Z`;

function row(event: string, clock: string, fields: Record<string, string> = {}): string {
  return `## Fixture\n**Timestamp**: ${day(clock)}\n**Event**: ${event}\n` +
    Object.entries(fields).map(([key, value]) => `**${key}**: ${value}\n`).join("") + "\n---\n";
}

// One synthetic run: a stage with a question, a stalled review that is sent
// again and a gate answered after an hour; a unit-major stage with two Units
// (one with a question, one reopened); a backward jump; and a gate left open.
const LEDGER = [
  row("WORKFLOW_STARTED", "10:00:00"),
  row("STAGE_STARTED", "10:00:00", { Stage: RA, Agent: "aidlc-product-agent" }),
  row("DECISION_RECORDED", "10:05:00", { Stage: RA, Decision: "Auth?", Options: "A, B" }),
  row("HUMAN_TURN", "10:08:00"),
  row("QUESTION_ANSWERED", "10:08:10", { Stage: RA, Details: "A" }),
  row("REVIEW_REQUESTED", "10:12:00", { Stage: RA }),
  row("SUBAGENT_COMPLETED", "10:40:00"),
  row("REVIEW_REQUESTED", "10:41:00", { Stage: RA }),
  row("SUBAGENT_COMPLETED", "10:43:00"),
  row("REVIEW_COMPLETED", "10:43:30", { Stage: RA }),
  row("STAGE_AWAITING_APPROVAL", "10:45:00", { Stage: RA }),
  `## A free-form note\n**Timestamp**: ${day("11:00:00")}\nNotes are not ledger rows.\n\n---\n`,
  row("HUMAN_TURN", "11:45:00"),
  row("GATE_APPROVED", "11:45:05", { Stage: RA }),
  row("STAGE_COMPLETED", "11:45:05", { Stage: RA }),
  row("STAGE_STARTED", "11:45:05", { Stage: FD }),
  // A late row about a finished stage does not take the time that follows.
  row("MEMORY_EMPTY", "11:45:05", { Stage: RA }),
  row("UNIT_STARTED", "11:47:05", { Stage: FD, Unit: "u1" }),
  row("DECISION_RECORDED", "11:50:05", { Stage: FD, Unit: "u1", Decision: "Shape?", Options: "A, B" }),
  row("HUMAN_TURN", "11:54:05"),
  row("QUESTION_ANSWERED", "11:54:15", { Stage: FD, Unit: "u1", Details: "B" }),
  row("UNIT_COMPLETED", "11:58:15", { Stage: FD, Unit: "u1" }),
  row("UNIT_STARTED", "11:58:15", { Stage: FD, Unit: "u2" }),
  row("GATE_REJECTED", "12:01:15", { Stage: FD, Unit: "u2" }),
  row("UNIT_COMPLETED", "12:03:15", { Stage: FD, Unit: "u2" }),
  // Settled with no human turn (an autonomous gate): working, not waiting.
  row("STAGE_AWAITING_APPROVAL", "12:03:15", { Stage: FD }),
  row("GATE_APPROVED", "12:04:15", { Stage: FD }),
  row("STAGE_COMPLETED", "12:04:15", { Stage: FD }),
  row("STAGE_STARTED", "12:04:15", { Stage: CG }),
  row("STAGE_JUMPED", "12:10:15", { Direction: "BACKWARD", Source: CG, Target: RA }),
  row("STAGE_STARTED", "12:10:15", { Stage: RA }),
  row("STAGE_COMPLETED", "12:12:15", { Stage: RA }),
  row("STAGE_STARTED", "12:12:15", { Stage: CG }),
  row("STAGE_AWAITING_APPROVAL", "12:20:15", { Stage: CG }),
  row("HUMAN_TURN", "12:25:15"),
].join("");

function project(ledger = LEDGER): string {
  const pd = createTestProject();
  projects.push(pd);
  seedStateFile(pd, "state-mid-ideation.md");
  mkdirSync(seededAuditDir(pd), { recursive: true });
  writeFileSync(join(seededAuditDir(pd), "one.md"), ledger);
  return pd;
}

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

// Every run asserts the project is byte-identical afterwards.
function run(pd: string, args: string[]) {
  const before = snapshot(pd);
  const result = spawnSync(
    process.execPath,
    [join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "audit", "timeline", ...args, "--project-dir", pd],
    { cwd: pd, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) },
  );
  expect(result.error).toBeUndefined();
  expect(snapshot(pd)).toEqual(before);
  return result;
}

function timeline(pd: string, args: string[] = []) {
  const result = run(pd, ["--json", ...args]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const parsed = JSON.parse(result.stdout);
  expect(Object.keys(parsed)[0]).toBe("data_notice");
  expect(parsed.data_notice).toBe(UNTRUSTED_AUDIT_NOTICE);
  return parsed;
}

const pick = (r: { [K in keyof TimelineRow]?: unknown }) => ({
  started: r.started, completed: r.completed, wall_s: r.wall_s, working_s: r.working_s, waiting_s: r.waiting_s,
  gap_s: r.gap_s, human_turns: r.human_turns, questions: r.questions, gates: r.gates, rejected: r.rejected,
  reopened: r.reopened, redispatched: r.redispatched, long_gaps: r.long_gaps,
});

describe("audit timeline", () => {
  test("splits each stage into working, waiting and long gaps, without writing", () => {
    const t = timeline(project());
    expect(t.gap_minutes).toBe(15);
    expect(t.first_event).toEqual({ timestamp: day("10:00:00"), event: "WORKFLOW_STARTED" });
    expect(t.last_event).toEqual({ timestamp: day("12:25:15"), event: "HUMAN_TURN" });
    expect(t.stages.map((s: { stage: string }) => s.stage)).toEqual([RA, FD, CG]);
    const [ra, fd, cg] = t.stages;
    // Two visits: the first run of the stage and the backward jump into it.
    expect(pick(ra)).toEqual({
      started: day("10:00:00"), completed: day("12:12:15"), wall_s: 6425, working_s: 965, waiting_s: 180,
      gap_s: 5280, human_turns: 2, questions: 1, gates: 1, rejected: 0, reopened: 1, redispatched: 1, long_gaps: 2,
    });
    expect(ra.units).toEqual([]);
    expect(pick(cg)).toEqual({
      started: day("12:04:15"), completed: null, wall_s: 1140, working_s: 840, waiting_s: 300,
      gap_s: 0, human_turns: 1, questions: 0, gates: 0, rejected: 0, reopened: 0, redispatched: 0, long_gaps: 0,
    });
    // The rows add up to the run: first row to last row.
    expect(t.totals).toEqual({
      wall_s: 8715, working_s: 2715, waiting_s: 720, gap_s: 5280, human_turns: 4, questions: 2, gates: 3,
      rejected: 1, reopened: 1, redispatched: 1, long_gaps: 2,
    });
    expect(fd.wall_s).toBe(1150);
  });

  test("gives each Unit its own row inside the stage, and the stage row includes them", () => {
    const fd = timeline(project()).stages[1];
    expect(pick(fd)).toEqual({
      started: day("11:45:05"), completed: day("12:04:15"), wall_s: 1150, working_s: 910, waiting_s: 240,
      gap_s: 0, human_turns: 1, questions: 1, gates: 2, rejected: 1, reopened: 0, redispatched: 0, long_gaps: 0,
    });
    expect(fd.units.map((u: { unit: string }) => u.unit)).toEqual(["u1", "u2"]);
    expect(pick(fd.units[0])).toEqual({
      started: day("11:47:05"), completed: day("11:58:15"), wall_s: 670, working_s: 430, waiting_s: 240,
      gap_s: 0, human_turns: 1, questions: 1, gates: 0, rejected: 0, reopened: 0, redispatched: 0, long_gaps: 0,
    });
    expect(pick(fd.units[1])).toEqual({
      started: day("11:58:15"), completed: day("12:03:15"), wall_s: 300, working_s: 300, waiting_s: 0,
      gap_s: 0, human_turns: 0, questions: 0, gates: 1, rejected: 1, reopened: 0, redispatched: 0, long_gaps: 0,
    });
  });

  test("lists long gaps with what was open, and the threshold moves them", () => {
    const pd = project();
    expect(timeline(pd).gaps).toEqual([
      { from: day("10:12:00"), to: day("10:40:00"), seconds: 1680, stage: RA, unit: null, during: "review-in-flight" },
      { from: day("10:45:00"), to: day("11:45:00"), seconds: 3600, stage: RA, unit: null, during: "awaiting-reply" },
    ]);
    // At 30 minutes the stalled review is ordinary working time.
    const wider = timeline(pd, ["--gap-minutes", "30"]);
    expect(wider.gap_minutes).toBe(30);
    expect(wider.gaps.map((g: { seconds: number }) => g.seconds)).toEqual([3600]);
    expect(wider.stages[0].working_s).toBe(965 + 1680);
    expect(wider.totals.wall_s).toBe(8715);
  });

  test("a question still open at the last row counts as waiting; a session end labels a gap", () => {
    const entry = (event: string, clock: string, stage: string | null = RA): TimelineEntry =>
      ({ timestamp: day(clock), event, stage, unit: null });
    const t = computeStageTimeline([
      entry("STAGE_STARTED", "09:00:00"),
      entry("STAGE_AWAITING_APPROVAL", "09:10:00"),
      entry("HUMAN_TURN", "09:12:00", null),
      entry("SESSION_ENDED", "09:13:00", null),
      entry("SESSION_STARTED", "10:13:00", null),
      entry("DECISION_RECORDED", "10:14:00"),
      entry("ARTIFACT_UPDATED", "10:20:00"),
      { timestamp: "not a time", event: "HUMAN_TURN", stage: null, unit: null },
    ]);
    expect(t.unparsed_rows).toBe(1);
    expect(pick(t.stages[0])).toMatchObject({ working_s: 600 + 60 + 60, waiting_s: 120 + 360, gap_s: 3600 });
    expect(t.gaps.map((g) => g.during)).toEqual(["session-ended"]);
  });

  test("prints a table and the gap list by default", () => {
    const result = run(project(), []);
    expect(result.status, result.stderr).toBe(0);
    const out = result.stdout;
    expect(out).toContain("Stage timeline (from the audit ledger; read-only)");
    expect(out).toMatch(/^requirements-analysis\s+09-27 10:00\s+09-27 12:12\s+1h 47m\s+16m\s+3m\s+1h 28m\s+2\s+1\s+1\s+0\/1\/1$/m);
    expect(out).toMatch(/^ {2}u2\s+09-27 11:58\s+09-27 12:03\s+5m\s+5m\s+0\s+0\s+0\s+0\s+1\s+1\/0\/0$/m);
    expect(out).toMatch(/^Total\s+2h 25m\s+45m\s+12m\s+1h 28m\s+4\s+2\s+3\s+1\/1\/1$/m);
    expect(out).toContain(`${day("10:45:00")} to ${day("11:45:00")}  1h 00m  ${RA}  awaiting-reply`);
  });

  test("renders ledger names as one plain bounded line", () => {
    const t = computeStageTimeline([
      { timestamp: day("09:00:00"), event: "STAGE_STARTED", stage: `evil\u001b[2J${"x".repeat(60)}`, unit: null },
      { timestamp: day("09:01:00"), event: "HUMAN_TURN", stage: null, unit: null },
    ]);
    const text = renderStageTimeline(t, Date.parse(day("09:02:00")));
    expect(text).not.toContain("\u001b");
    expect(text).toContain("evil?[2J");
    expect(text).toContain("last row HUMAN_TURN, 1m ago");
    expect(renderStageTimeline(computeStageTimeline([]))).toContain("No ledger rows yet.");
  });

  test("bad flags fail on stderr without writing anything", () => {
    const pd = project();
    for (const args of [["--gap-minutes", "0"], ["--gap-minutes", "abc"], ["--gap-minutes"], ["--stage", RA]]) {
      const result = run(pd, args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("error");
    }
  });
});
