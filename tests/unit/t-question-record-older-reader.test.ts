// covers: audit:QUESTION_ASKED, audit:QUESTION_SHOWN, audit:HUMAN_TURN, audit:STAGE_AWAITING_APPROVAL
// covers: subcommand:aidlc-orchestrate:report, subcommand:aidlc-log:answer, subcommand:aidlc-log:answers
//
// The question record decides nothing yet, so the records it writes change no
// outcome: a teammate on the release before reads past them, and so does this
// release. Each case drives a window case through the engine, as a run records
// it, up to the decision, which runs twice in the same folder: once with
// everything the record adds taken out (the QUESTION_ASKED and QUESTION_SHOWN
// rows, the question fields, the turns' Open Questions and Questions Digest,
// the runtime index), once on the record as it was. The exit, the step it prints (its
// question_id aside) and the rows it writes are the same: the gate approved on
// the reply after it was shown and refused on the one before the document, a
// change request's own words, an answer's pairing with its question, an engine
// question's pick and the code plan question approved from a second chat. A
// swarm worker's audit merge takes the two new rows, as it takes any other
// that is not an authority row.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, cleanupTestProject, resetAidlcEnv } from "../harness/fixtures.ts";
import {
  A, B, codeGeneration, inception, reviewedStage, run, say, STAGE, staffing, step, tool,
} from "../harness/question-record.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

const ADDED_ROWS = new Set(["QUESTION_ASKED", "QUESTION_SHOWN"]);
const ADDED_FIELDS = /^\*\*(Question Id|Question Type|Question Chat|Question Shows|Question Text SHA-256|Open Questions|Questions Digest)\*\*:/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

// What the question record adds, taken out of the project: the record a
// release that never wrote it would leave.
function stripRecord(proj: string): void {
  for (const path of files(join(proj, "aidlc"))) {
    const name = relative(proj, path).replaceAll("\\", "/");
    if (/\/audit\/[^/]+\.md$/.test(name)) {
      const blocks = readFileSync(path, "utf-8").split(/\n---\n/);
      const kept = blocks
        .filter((block) => !ADDED_ROWS.has(/^\*\*Event\*\*: (.+)$/m.exec(block)?.[1] ?? ""))
        .map((block) => block.split("\n").filter((line) => !ADDED_FIELDS.test(line)).join("\n"));
      writeFileSync(path, kept.join("\n---\n"));
    } else if (/\/(open-questions|stage-questions)-[0-9a-f]+\.json$/.test(name)) {
      writeFileSync(path, "{}\n");
    } else if (/\/plan-approval\/ask-[0-9a-f]+\.json$/.test(name)) {
      const record = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      delete record.questionId;
      writeFileSync(path, `${JSON.stringify(record)}\n`);
    }
  }
}

const SKIPPED_FIELDS = new Set(["Timestamp", "Question Id", "Question Type", "Question Chat", "Question Shows",
  "Question Text SHA-256", "Open Questions", "Questions Digest", "Run floor", "Run floors"]);

// What a decision did: its exit, the step it printed, and the rows it wrote,
// with what the record adds (and the clock) left out.
function outcome(proj: string, decide: (proj: string) => { status: number | null; stdout: string }) {
  const before = readAuditShardEvents(proj).length;
  const result = decide(proj);
  const printed = result.stdout.trim().split("\n").at(-1) || "{}";
  let step: unknown = printed;
  try {
    const parsed = JSON.parse(printed) as Record<string, unknown>;
    delete parsed.question_id;
    step = parsed;
  } catch {
    // Not JSON: compared as printed.
  }
  const written = readAuditShardEvents(proj).slice(before).filter((row) => !ADDED_ROWS.has(row.event)).map((row) =>
    [row.event, ...row.block.split("\n").flatMap((line) => {
      const field = /^\*\*([^*]+)\*\*: ?(.*)$/.exec(line);
      return field === null || SKIPPED_FIELDS.has(field[1]) ? [] : [`${field[1]}=${field[2]}`];
    })].join(" | "));
  return { status: result.status, step, written };
}

// The decision on the record without what the question record adds, then on
// the record as it was, in the same folder: what a step prints names it.
function sameOutcome(proj: string, decide: (proj: string) => { status: number | null; stdout: string }) {
  const recorded = readAuditShardEvents(proj);
  expect(recorded.some((row) => ADDED_ROWS.has(row.event) || auditBlockField(row.block, "Question Id") !== null)).toBe(true);
  const saved = mkdtempSync(join(tmpdir(), "t-question-record-older-"));
  projects.push(saved);
  cpSync(proj, saved, { recursive: true });
  stripRecord(proj);
  const theirs = outcome(proj, decide);
  rmSync(proj, { recursive: true, force: true });
  cpSync(saved, proj, { recursive: true });
  const ours = outcome(proj, decide);
  expect(ours).toEqual(theirs);
  return ours;
}

const report = (args: string[], chat = A) => (proj: string) =>
  run(proj, chat, ["engine", "orchestrate", "report", "--stage", STAGE, ...args]);

describe("the window cases decide the same with the question record as without it", () => {
  test("a gate approved on the reply after it was shown, in the chat it was shown in again", () => {
    const proj = inception(projects);
    reviewedStage(proj);
    step(proj, A, ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
    say(proj, B, "/aidlc");
    step(proj, B, ["next"]);
    say(proj, B, "approve");
    const decided = sameOutcome(proj, report(["--result", "approved", "--user-input", "Approve"], B));
    expect(decided.status).toBe(0);
    expect(decided.written.some((row) => row.startsWith("GATE_APPROVED"))).toBe(true);
  });

  test("a reply before the document was written is refused for the gate, and a change request keeps its own words", () => {
    const proj = inception(projects);
    say(proj, A, "use SQLite please");
    Bun.sleepSync(1100);
    reviewedStage(proj);
    step(proj, A, ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
    const refused = sameOutcome(proj, report(["--result", "approved", "--user-input", "Approve"]));
    expect(refused.written.some((row) => row.startsWith("GATE_APPROVED"))).toBe(false);
    say(proj, A, "change the error message to say which flag was wrong");
    const changed = sameOutcome(proj, report(["--result", "rejected", "--user-input", "Request Changes"]));
    expect(changed.written.some((row) => row.startsWith("GATE_REJECTED"))).toBe(true);
  });

  test("an answer pairs with the question it answers, and a question box's reply stays as given", () => {
    const proj = inception(projects);
    tool(proj, A, "log", ["decision", "--stage", STAGE, "--decision", "Which database?", "--options", "Postgres,SQLite"]);
    run(proj, null, ["engine", "hook", "record-human-turn"], JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", session_id: A,
      tool_input: { questions: [{ question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] }] },
      tool_response: { answers: { "Which database?": "SQLite" } },
    }));
    sameOutcome(proj, (p) => run(p, A, ["engine", "log", "answer", "--stage", STAGE, "--details", "SQLite", "--project-dir", p]));
    sameOutcome(proj, (p) => run(p, A, ["engine", "log", "answers", "--stage", STAGE, "--project-dir", p]));
  });

  test("an engine question's pick records the same, asked in one chat and shown in another", () => {
    const proj = staffing(projects);
    const ask = step(proj, A, ["next"]) as { choices?: Array<{ label: string; command?: string }> };
    step(proj, B, ["next"]);
    say(proj, B, "just me");
    const command = String(ask.choices?.find((choice) => choice.label === "Just me")?.command);
    const args = /aidlc-state\.ts (.+)$/.exec(command)?.[1].split(" ") ?? [];
    expect(args.length, command).toBeGreaterThan(0);
    const picked = sameOutcome(proj, (p) =>
      run(p, B, ["engine", "state", ...args, "--project-dir", p]));
    expect(picked.status).toBe(0);
  });

  test("the code plan question approved from a second chat records the same approval", () => {
    const proj = codeGeneration(projects);
    step(proj, A, ["next"]);
    step(proj, B, ["next"]);
    say(proj, B, "approve the plan");
    const approved = sameOutcome(proj, (p) => run(p, B, ["engine", "log", "answer", "--stage", "code-generation",
      "--checkpoint", "plan-approval", "--details", "Approve Plan", "--project-dir", p]));
    expect(approved.written.some((row) => row.startsWith("PLAN_APPROVAL_RECORDED"))).toBe(true);
  });
});

describe("a swarm worker's audit merge", () => {
  // The merge refuses only unknown events and authority rows; the question
  // record's rows are neither, so a worker that asked a question still lands.
  test("takes QUESTION_ASKED and QUESTION_SHOWN as it takes any row that is not an authority row", () => {
    const source = readFileSync(join(AIDLC_SRC, "tools", "aidlc-audit.ts"), "utf-8");
    const set = (name: string) => {
      const start = source.indexOf(`const ${name} = new Set([`);
      expect(start, name).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf("]);", start));
    };
    for (const event of ADDED_ROWS) {
      expect(set("VALID_EVENT_TYPES")).toContain(`"${event}"`);
      expect(set("MERGE_PROTECTED_EVENT_TYPES")).not.toContain(`"${event}"`);
      expect(set("CLI_PROTECTED_EVENT_TYPES")).toContain(`"${event}"`);
    }
  });
});
