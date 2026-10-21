// covers: file:scripts/trace-audit.ts, file:scripts/trace-audit-judge.ts
//
// The trace audit reads every live leg of a Full Suite run, the passing ones
// too, and a local session folder the same way. The extractor only counts and
// matches recorded events and fields, so each class of row is pinned here on a
// small artifact tree written the way the nightly writes it (an SDK drive
// trace, Codex exec turn logs, a driver report, a retained audit shard, a
// Copilot process log, the runner's per-attempt results) and on a Claude Code
// transcript as a local session. The judgement pass is checked without a
// model: what it is handed, that its model call can only read, and that the
// tool, not the model, counts how often a friction item was met.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { auditFolder, storyText, tableText, writeAudit } from "../../scripts/trace-audit.ts";
import { claudeArgs, frictionCounts, judgeGroups, judgeInput, judgeReadDirs, runJudge } from "../../scripts/trace-audit-judge.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "aidlc-trace-audit-"));
  roots.push(root);
  return root;
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 9, 20, 21, minute, second)).toISOString();
const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

const STAGE_DIR = "/home/x/proj/aidlc/spaces/default/intents/261020-greet/inception/requirements-analysis";

/** A nightly's artifacts: one SDK job, one Codex job, one Copilot job, as `gh run download` lays them out. */
function nightly(): string {
  const root = scratch();
  const sdk = join(root, "123456789-full-suite-live-claude-sdk-1-Linux", "2026-10-20T21-00-00Z-p1");
  put(join(sdk, "e2e-results.json"), JSON.stringify({
    files: [
      {
        file: "tests/integration/t-journey-a.sdk.test.ts", status: "PASS", passedOnRetry: true,
        attempts: [{ attempt: 1, status: "FAIL", seconds: 300, timedOut: false }, { attempt: 2, status: "PASS", seconds: 280, timedOut: false }],
      },
      { file: "tests/integration/t-journey-b.sdk.test.ts", status: "PASS", attempts: [{ attempt: 1, status: "PASS", seconds: 60, timedOut: false }] },
    ],
  }));
  const leg = join(sdk, "e2e-artifacts", "t-journey-a.sdk", "attempt-1");
  put(join(leg, "sdk-drive-41.ndjson"), jsonl([
    { ts: at(0), event: "start", prompt: "/aidlc fix the greeter", projectDir: "/home/x/proj" },
    { ts: at(0, 1), event: "tool_use", id: "t1", name: "Bash", input: { command: "bun .claude/tools/aidlc.ts engine orchestrate next" } },
    { ts: at(0, 2), event: "tool_result", toolUseId: "t1", toolName: "Bash", isError: false, preview: '{"kind":"run-stage","stage":"requirements-analysis"}' },
    {
      ts: at(0, 5), event: "ask_user_question",
      questions: [{ header: "Mode", question: "How would you like to answer the questions?", options: ["Guide me", "Chat"] }],
      answers: { "How would you like to answer the questions?": "Guide me" },
    },
    { ts: at(0, 6), event: "tool_use", id: "t2", name: "Bash", input: { command: "bun .claude/tools/aidlc.ts engine log answer --stage requirements-analysis --details 'Guide me'" } },
    { ts: at(0, 7), event: "tool_result", toolUseId: "t2", toolName: "Bash", isError: true, preview: 'Exit code 1\n{"error":"Cannot record the answer: no question is open."}' },
    { ts: at(21, 7), event: "tool_use", id: "t3", name: "Bash", input: { command: "bun .claude/tools/aidlc-orchestrate.ts report --stage requirements-analysis --result approved --user-input 'Approve'" } },
    { ts: at(21, 8), event: "tool_result", toolUseId: "t3", toolName: "Bash", isError: false, preview: '{"kind":"done"}' },
    // Reading an approved stage's file afterwards is no change to it.
    { ts: at(21, 8), event: "tool_use", id: "t3r", name: "Read", input: { file_path: `${STAGE_DIR}/requirements.md` } },
    { ts: at(21, 9), event: "tool_use", id: "t4", name: "Write", input: { file_path: `${STAGE_DIR}/requirements.md`, content: "# Requirements" } },
    { ts: at(21, 10), event: "tool_result", toolUseId: "t4", toolName: "Write", isError: false, preview: "File written" },
    { ts: at(21, 11), event: "tool_use", id: "t5", name: "Bash", input: { command: "bun .claude/tools/aidlc.ts engine orchestrate next" } },
    { ts: at(21, 12), event: "tool_result", toolUseId: "t5", toolName: "Bash", isError: true, preview: "Code Generation cannot start: the person has not answered the plan question yet." },
    { ts: at(21, 13), event: "tool_use", id: "t6", name: "Edit", input: { file_path: "/home/x/proj/src/app.js" } },
    { ts: at(21, 14), event: "tool_result", toolUseId: "t6", toolName: "Edit", isError: true, preview: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>" },
    { ts: at(21, 15), event: "stop_hook", turn: 1, blocked: false, outcome: "success" },
    { ts: at(21, 20), event: "next_message", turn: 2, message: "Approve Plan" },
    { ts: at(21, 30), event: "end", timedOut: false },
  ]));
  put(join(leg, "retained-fixtures", "proj", "aidlc", "spaces", "default", "intents", "261020-greet", "audit", "host-1.md"), [
    "## Sensor Failed\n**Timestamp**: 2026-10-20T21:05:00Z\n**Event**: SENSOR_FAILED\n**Sensor ID**: required-sections\n**Stage slug**: requirements-analysis\n**Findings count**: 2\n",
    "## Sensor Passed\n**Timestamp**: 2026-10-20T21:05:01Z\n**Event**: SENSOR_PASSED\n**Sensor ID**: linter\n**Stage slug**: code-generation\n**Note**: tool-unavailable\n",
    "## Sensor Passed\n**Timestamp**: 2026-10-20T21:05:02Z\n**Event**: SENSOR_PASSED\n**Sensor ID**: traceability\n**Stage slug**: code-generation\n",
    "## Blocked\n**Timestamp**: 2026-10-20T21:06:00Z\n**Event**: REVIEW_FREEZE_BLOCKED\n**Stage**: requirements-analysis\n**Reason**: a reviewer is reading\n",
    "## Error\n**Timestamp**: 2026-10-20T21:07:00Z\n**Event**: ERROR_LOGGED\n**Stage**: requirements-analysis\n**Tool**: aidlc-state\n**Command**: advance\n**Error**: lock timeout\n",
    "## Change Accepted\n**Timestamp**: 2026-10-20T21:08:00Z\n**Event**: CHANGE_ACCEPTED\n**Stage**: requirements-analysis\n**Details**: plan source drift\n",
  ].join("\n---\n"));
  put(join(sdk, "e2e-artifacts", "t-journey-a.sdk", "attempt-2", "sdk-drive-42.ndjson"), jsonl([
    { ts: at(30), event: "start", prompt: "/aidlc fix the greeter" },
    { ts: at(30, 1), event: "end", timedOut: false },
  ]));
  put(join(sdk, "e2e-artifacts", "t-journey-b.sdk", "attempt-1", "sdk-drive-43.ndjson"), jsonl([
    { ts: at(40), event: "start", prompt: "/aidlc status" },
    { ts: at(40, 1), event: "end", timedOut: false },
  ]));

  const codex = join(root, "123456789-full-suite-live-codex-1-Windows", "2026-10-20T21-00-00Z-p2");
  put(join(codex, "e2e-results.json"), JSON.stringify({
    files: [{ file: "tests/e2e/t-exec-codex-journey-golden-bugfix.serial.test.ts", status: "PASS", attempts: [{ attempt: 1, status: "PASS", seconds: 900 }] }],
  }));
  const cleg = join(codex, "e2e-artifacts", "t-exec-codex-journey-golden-bugfix.serial", "attempt-1");
  const turn = (prompt: string, items: unknown[]) =>
    `Command: ["codex","exec","--json",${JSON.stringify(prompt)}]\nCwd: C:\\x\\proj\nExit code: 0\n\n${jsonl(items)}`;
  put(join(cleg, "exec-codex-golden-bugfix-1.log"), turn("$aidlc fix the greeter", [
    { type: "thread.started", thread_id: "th1" },
    { type: "item.completed", item: { id: "i1", type: "command_execution", command: "bun .codex/tools/aidlc.ts engine orchestrate next", aggregated_output: '{"kind":"run-stage","stage":"reverse-engineering"}', exit_code: 0 } },
    { type: "item.completed", item: { id: "i2", type: "agent_message", text: "Reverse Engineering is ready for your approval." } },
  ]));
  put(join(cleg, "exec-codex-golden-bugfix-2.log"), turn("Approve", [
    { type: "item.completed", item: { id: "i3", type: "command_execution", command: "bun .codex/tools/aidlc-orchestrate.ts report --stage reverse-engineering --result approved", aggregated_output: "Blocked by hook: AI-DLC has not seen your reply yet", exit_code: 1 } },
    { type: "item.completed", item: { id: "i4", type: "file_change", changes: [{ path: "C:\\x\\proj\\aidlc\\spaces\\default\\intents\\261020-greet\\inception\\reverse-engineering\\notes.md", kind: "add" }] } },
  ]));
  put(join(cleg, "golden-journey-codex.json"), JSON.stringify({
    line: "codex golden journey: FAIL",
    problems: ['asked twice: "Q1" at requirements-analysis'],
    person: ['typed "Approve" for the reverse-engineering approval'],
    turns: [{ line: "$aidlc fix the greeter", seconds: 12 }, { line: "Approve", seconds: 1260 }],
  }));

  const copilot = join(root, "123456789-full-suite-live-copilot-1-Linux", "2026-10-20T21-00-00Z-p3");
  put(join(copilot, "e2e-results.json"), JSON.stringify({
    files: [{ file: "tests/e2e/t-exec-copilot-journey-golden-bugfix.serial.test.ts", status: "FAIL", attempts: [{ attempt: 1, status: "FAIL", seconds: 3600, timedOut: true }] }],
  }));
  put(join(copilot, "e2e-artifacts", "t-exec-copilot-journey-golden-bugfix.serial", "attempt-1", "retained-fixtures", "j", "copilot-home", "logs", "process-1.log"), [
    "2026-10-20T21:22:39.000Z [INFO] session start",
    "2026-10-20T22:08:43.000Z [ERROR] Model provider request failed {stage: inference}",
    "",
  ].join("\n"));
  return root;
}

function rowsOf(root: string) {
  return auditFolder(root).rows;
}

describe("the extractor reads a nightly's live legs, the passing ones too", () => {
  test("each live leg is found with its run, harness, OS, test and attempt", () => {
    const run = auditFolder(nightly());
    expect(run.run).toBe("123456789");
    const legs = run.legs.map((l) => `${l.harness} ${l.os} ${l.test}#${l.attempt} ${l.status}`).sort();
    expect(legs).toEqual([
      "claude-sdk Linux t-journey-a.sdk#1 FAIL",
      "claude-sdk Linux t-journey-a.sdk#2 PASS",
      "claude-sdk Linux t-journey-b.sdk#1 PASS",
      "codex Windows t-exec-codex-journey-golden-bugfix.serial#1 PASS",
      "copilot Linux t-exec-copilot-journey-golden-bugfix.serial#1 FAIL",
    ]);
  });

  test("sensor findings and noted passes come from the audit rows, by sensor and stage", () => {
    const sensor = rowsOf(nightly()).filter((r) => r.cls === "sensor").map((r) => `${r.event} ${r.stage} ${r.detail}`);
    // A pass with no note is no row: only what a person or a triage would want to know.
    expect(sensor).toEqual([
      "SENSOR_FAILED requirements-analysis required-sections: 2 findings",
      "SENSOR_PASSED code-generation linter: tool-unavailable",
    ]);
  });

  test("guard refusals: blocked rows and refused tool calls; engine errors: error rows and AI-DLC commands that exit non-zero", () => {
    const rows = rowsOf(nightly());
    expect(rows.filter((r) => r.cls === "refusal").map((r) => `${r.harness} ${r.stage} ${r.event}: ${r.detail}`)).toEqual([
      "claude-sdk requirements-analysis REVIEW_FREEZE_BLOCKED: a reviewer is reading",
      "claude-sdk requirements-analysis refused Bash: Code Generation cannot start: the person has not answered the plan question yet.",
      "codex reverse-engineering refused command: Blocked by hook: AI-DLC has not seen your reply yet",
    ]);
    expect(rows.filter((r) => r.cls === "engine-error").map((r) => `${r.stage} ${r.event}: ${r.detail}`)).toEqual([
      "requirements-analysis ERROR_LOGGED: aidlc-state advance: lock timeout",
      "requirements-analysis exit 1: engine log answer: Cannot record the answer: no question is open.",
    ]);
  });

  test("a guard that blocks a Write is a refusal; a file error on a Write is the agent's tool error", () => {
    const root = scratch();
    const leg = join(root, "4-full-suite-live-claude-sdk-1-Linux", "s", "e2e-artifacts", "t-write.sdk", "attempt-1");
    put(join(leg, "sdk-drive-1.ndjson"), jsonl([
      { ts: at(0), event: "tool_use", id: "w1", name: "Write", input: { file_path: "/p/src/app.js" } },
      { ts: at(0, 1), event: "tool_result", toolUseId: "w1", toolName: "Write", isError: true, preview: "Code Generation cannot start: the person has not approved the plan yet." },
      { ts: at(0, 2), event: "tool_use", id: "w2", name: "Write", input: { file_path: "/p/src/app.js" } },
      { ts: at(0, 3), event: "tool_result", toolUseId: "w2", toolName: "Write", isError: true, preview: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>" },
    ]));
    expect(auditFolder(root).rows.map((r) => `${r.cls} ${r.event}`)).toEqual(["refusal refused Write", "tool-error Write"]);
  });

  test("an engine reply of kind error is an engine error even when the command exits 0", () => {
    const root = scratch();
    const leg = join(root, "5-full-suite-live-claude-sdk-1-macOS", "s", "e2e-artifacts", "t-compose.sdk", "attempt-1");
    put(join(leg, "sdk-drive-1.ndjson"), jsonl([
      { ts: at(0), event: "tool_use", id: "c1", name: "Bash", input: { command: "bun .claude/tools/aidlc.ts engine orchestrate next --scope custom --skip ''" } },
      { ts: at(0, 1), event: "tool_result", toolUseId: "c1", toolName: "Bash", isError: false, preview: '{"message":"--skip requires <stage,...>.","kind":"error"}' },
      { ts: at(0, 2), event: "tool_use", id: "c2", name: "Bash", input: { command: "bun .claude/tools/aidlc.ts engine orchestrate next" } },
      { ts: at(0, 3), event: "tool_result", toolUseId: "c2", toolName: "Bash", isError: false, preview: '{"kind":"run-stage","stage":"intent-capture"}' },
    ]));
    expect(auditFolder(root).rows.map((r) => `${r.cls} ${r.event}: ${r.detail}`)).toEqual([
      "engine-error kind error: engine orchestrate next: --skip requires <stage,...>.",
    ]);
  });

  test("the same question handed to the person twice is read from the driver's own report", () => {
    const twice = rowsOf(nightly()).filter((r) => r.cls === "asked-twice");
    expect(twice.map((r) => `${r.harness} ${r.test} ${r.detail}`)).toEqual([
      'codex t-exec-codex-journey-golden-bugfix.serial asked twice: "Q1" at requirements-analysis',
    ]);
    expect(twice[0].evidence).toEndWith("golden-journey-codex.json#problems[0]");
  });

  test("the same question box shown again in one chat after the person answered it is a row too", () => {
    const root = scratch();
    const leg = join(root, "6-full-suite-live-claude-sdk-1-Linux", "s", "e2e-artifacts", "t-again.sdk", "attempt-1");
    const box = (minute: number, answer: string) => ({
      ts: at(minute), event: "ask_user_question",
      questions: [{ question: "Approve the code plan?", options: ["Approve Plan", "Request Changes"] }], answers: { "Approve the code plan?": answer },
    });
    put(join(leg, "sdk-drive-1.ndjson"), jsonl([{ ts: at(0), event: "start", prompt: "/aidlc go" }, box(1, "Approve Plan"), box(3, "Approve Plan")]));
    const rows = auditFolder(root).rows.filter((r) => r.cls === "asked-twice");
    expect(rows.map((r) => `${r.event}: ${r.detail}`)).toEqual(['same question asked again: "Approve the code plan?"']);
    expect(rows[0].evidence).toMatch(/sdk-drive-1\.ndjson:3$/);
  });

  test("a stage's files written after its approval, and accepted changes, are listed", () => {
    const changed = rowsOf(nightly()).filter((r) => r.cls === "changed-after-approval").map((r) => `${r.harness} ${r.stage} ${r.event} ${r.detail}`);
    expect(changed).toEqual([
      "claude-sdk requirements-analysis CHANGE_ACCEPTED plan source drift",
      "claude-sdk requirements-analysis write after approval requirements.md",
    ]);
  });

  test("Codex numbers its items again in every turn: a later turn's approval is never matched to an earlier write", () => {
    const root = scratch();
    const leg = join(root, "7-full-suite-live-codex-1-Linux", "s", "e2e-artifacts", "t-exec-codex-x.serial", "attempt-1");
    const plan = "/p/aidlc/spaces/default/intents/261020-x/construction/code-generation/code-generation-plan.md";
    const turn = (prompt: string, items: unknown[]) => `Command: ["codex","exec",${JSON.stringify(prompt)}]\n\n${jsonl(items)}`;
    put(join(leg, "exec-codex-x-1.log"), turn("Approve Plan", [
      { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "bun .codex/tools/aidlc.ts engine orchestrate next", aggregated_output: "{}", exit_code: 0 } },
      { type: "item.completed", item: { id: "item_1", type: "file_change", changes: [{ path: plan, kind: "update" }] } },
    ]));
    put(join(leg, "exec-codex-x-2.log"), turn("Approve", [
      { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "bun .codex/tools/aidlc-orchestrate.ts report --stage code-generation --result approved", aggregated_output: '{"kind":"done"}', exit_code: 0 } },
    ]));
    expect(auditFolder(root).rows.filter((r) => r.cls === "changed-after-approval")).toEqual([]);
  });

  test("an approval in one chat is never matched to a write in another chat of the same leg", () => {
    const root = scratch();
    const leg = join(root, "8-full-suite-live-claude-tui-1-Linux", "s", "e2e-artifacts", "t-tui-two-runs.serial", "attempt-1");
    const stageFile = (proj: string) => `/tmp/${proj}/aidlc/spaces/default/intents/261020-x/inception/requirements-analysis/requirements.md`;
    const approve = { type: "assistant", timestamp: at(1), message: { content: [{ type: "tool_use", id: "a1", name: "Bash", input: { command: "bun .claude/tools/aidlc-orchestrate.ts report --stage requirements-analysis --result approved" } }] } };
    const approved = { type: "user", timestamp: at(1, 5), message: { content: [{ type: "tool_result", tool_use_id: "a1", content: '{"kind":"done"}' }] } };
    put(join(leg, "tc-1", "projects", "p", "clean.jsonl"), jsonl([approve, approved]));
    put(join(leg, "tr-2", "projects", "p", "revised.jsonl"), jsonl([
      { type: "assistant", timestamp: at(2), message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: stageFile("revised") } }] } },
    ]));
    expect(auditFolder(root).rows.filter((r) => r.cls === "changed-after-approval")).toEqual([]);
  });

  test("silence: a gap in a trace's timestamps, a Copilot log gap, and a long typed turn", () => {
    const silent = rowsOf(nightly()).filter((r) => r.cls === "silence").map((r) => `${r.harness} ${r.event} ${r.detail}`);
    expect(silent).toEqual([
      "claude-sdk gap 21 min after Bash: bun .claude/tools/aidlc.ts engine log answer --stage requirements-analysis --details 'Guide me'",
      "codex long turn 21 min turn 2 (\"Approve\")",
      "copilot gap 46 min after [INFO] session start",
    ]);
  });

  test("a test that failed and passed on its retry, and one that failed, come from the per-attempt results", () => {
    const retry = rowsOf(nightly()).filter((r) => r.cls === "retry").map((r) => `${r.harness} ${r.test} ${r.event}`);
    expect(retry).toEqual([
      "claude-sdk t-journey-a.sdk passed on retry (FAIL, PASS)",
      "copilot t-exec-copilot-journey-golden-bugfix.serial failed (FAIL timed out)",
    ]);
  });

  test("an agent tool error is a row of its own; a picker reply in the person's own words is not an error", () => {
    const tool = rowsOf(nightly()).filter((r) => r.cls === "tool-error").map((r) => `${r.event}: ${r.detail}`);
    expect(tool).toEqual(["Edit: <tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>"]);
  });

  test("every row names its evidence by file and line inside the folder", () => {
    const root = nightly();
    for (const row of rowsOf(root)) {
      const [file] = row.evidence.split(/[:#](?=[^/\\]*$)/);
      expect(statSync(join(root, file)).isFile(), row.evidence).toBe(true);
    }
    const gap = rowsOf(root).find((r) => r.cls === "silence" && r.harness === "claude-sdk");
    expect(gap?.evidence).toMatch(/sdk-drive-41\.ndjson:7$/);
  });
});

describe("the story of a leg is what the person lived, clipped to a budget", () => {
  test("it shows the person's lines, the questions and picks, the agent's calls and the rows", () => {
    const run = auditFolder(nightly());
    const leg = run.legs.find((l) => l.test === "t-journey-a.sdk" && l.attempt === 1)!;
    const story = storyText(leg);
    expect(story).toContain("PERSON typed: /aidlc fix the greeter");
    expect(story).toContain('ASKED (question box): "How would you like to answer the questions?" [Guide me | Chat]');
    expect(story).toContain("PERSON picked: Guide me");
    expect(story).toContain("PERSON typed: Approve Plan");
    expect(story).toContain("AGENT ran: bun .claude/tools/aidlc.ts engine orchestrate next");
    expect(story).toContain("(silent 21 min)");
    expect(story).toContain("refusal: requirements-analysis refused Bash");
    const codex = storyText(run.legs.find((l) => l.harness === "codex")!);
    expect(codex).toContain("AGENT said: Reverse Engineering is ready for your approval.");
    expect(codex).toContain("PERSON typed: Approve");
  });

  test("a story over budget keeps the person's lines and cuts calls from the middle", () => {
    const root = scratch();
    const leg = join(root, "9-full-suite-live-claude-sdk-1-Linux", "s", "e2e-artifacts", "t-long.sdk", "attempt-1");
    const events: unknown[] = [{ ts: at(0), event: "start", prompt: "/aidlc first line" }];
    for (let i = 0; i < 400; i++) {
      events.push({ ts: at(1, i % 60), event: "tool_use", id: `u${i}`, name: "Bash", input: { command: `cat file-${i}.md ${"x".repeat(200)}` } });
    }
    events.push({ ts: at(5), event: "next_message", turn: 2, message: "last line" });
    put(join(leg, "sdk-drive-1.ndjson"), jsonl(events));
    const story = storyText(auditFolder(root).legs[0], 8000);
    expect(Buffer.byteLength(story)).toBeLessThanOrEqual(8000);
    expect(story).toContain("PERSON typed: /aidlc first line");
    expect(story).toContain("PERSON typed: last line");
    expect(story).toMatch(/\(\d+ events cut here; the full trace is .*sdk-drive-1\.ndjson\)/);
  });
});

describe("a local session folder is read the same way", () => {
  test("a Claude Code transcript gives the person's lines, the agent's words, a refused call and a gap", () => {
    const root = scratch();
    const t = (minute: number) => at(minute);
    put(join(root, "cfg", "projects", "p", "abc.jsonl"), jsonl([
      { type: "user", timestamp: t(0), message: { role: "user", content: "/aidlc add a greeting" } },
      { type: "assistant", timestamp: t(0), message: { role: "assistant", content: [{ type: "text", text: "Starting." }] } },
      { type: "assistant", timestamp: t(1), message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "bun .claude/tools/aidlc.ts engine orchestrate next" } }] } },
      { type: "user", timestamp: t(15), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: "Plan approval is on: approve the plan first." }] } },
      { type: "user", timestamp: t(16), message: { role: "user", content: "Approve" } },
    ]));
    const run = auditFolder(root, { label: "my-session" });
    expect(run.run).toBe("my-session");
    expect(run.legs.map((l) => l.harness)).toEqual(["claude"]);
    expect(run.rows.map((r) => `${r.cls} ${r.event} ${r.detail}`.trim())).toEqual([
      "refusal refused Bash Plan approval is on: approve the plan first.",
      "silence gap 14 min after Bash: bun .claude/tools/aidlc.ts engine orchestrate next",
    ]);
    const story = storyText(run.legs[0]);
    expect(story).toContain("AGENT said: Starting.");
    expect(story).toContain("PERSON typed: Approve");
  });
});

describe("a hook's words are never the person's", () => {
  test("Claude Code's Stop hook feedback and other host notes in a user entry are not a typed line", () => {
    const root = scratch();
    put(join(root, "cfg", "projects", "p", "abc.jsonl"), jsonl([
      { type: "user", timestamp: at(0), message: { role: "user", content: "<command-name>/aidlc</command-name>\n<command-args>fix it</command-args>" } },
      { type: "user", timestamp: at(0, 1), isMeta: true, message: { role: "user", content: "Caveat: The messages below were generated by the user while running local commands." } },
      { type: "assistant", timestamp: at(0, 2), message: { role: "assistant", content: [{ type: "text", text: "Done for now." }] } },
      { type: "user", timestamp: at(0, 3), isMeta: true, message: { role: "user", content: "Stop hook feedback:\nAI-DLC is carrying on with Reverse Engineering." } },
      { type: "user", timestamp: at(1), message: { role: "user", content: "Approve" } },
    ]));
    const leg = auditFolder(root, { label: "s" }).legs[0];
    const story = storyText(leg);
    expect(story).toContain("PERSON typed: /aidlc fix it");
    expect(story).toContain("PERSON typed: Approve");
    expect(story).toContain("STOP hook: blocked: Stop hook feedback: / AI-DLC is carrying on with Reverse Engineering.");
    expect(story).not.toMatch(/PERSON typed: (Stop hook|Caveat)/);
    expect(leg.events.filter((e) => e.kind === "person").map((e) => e.turn)).toEqual([1, 2]);
  });

  test("a Codex Stop hook's prompt in a user message is the hook's, not the person's", () => {
    const root = scratch();
    const msg = (text: string) => ({ type: "response_item", timestamp: at(0), payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    put(join(root, "home", "sessions", "2026", "10", "20", "rollout-2026-10-20T21-00-00-x.jsonl"), jsonl([
      msg("$aidlc fix it"),
      msg('<hook_prompt hook_run_id="stop:1:/p/.codex/hooks.json">The last AI-DLC step stopped on a problem: lock timeout</hook_prompt>'),
      msg("Approve"),
    ]));
    const leg = auditFolder(root, { label: "s" }).legs[0];
    const story = storyText(leg);
    expect(story).toContain("PERSON typed: $aidlc fix it");
    expect(story).toContain("STOP hook: blocked: The last AI-DLC step stopped on a problem: lock timeout");
    expect(story).not.toContain("PERSON typed: <hook_prompt");
    expect(leg.events.filter((e) => e.kind === "person").map((e) => e.turn)).toEqual([1, 2]);
  });
});

describe("the extractor never changes what it reads", () => {
  test("the input folder is byte-for-byte the same after an audit is written elsewhere", () => {
    const root = nightly();
    const snapshot = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile()).map((d) => { const p = join(d.parentPath, d.name); return `${relative(dir, p)} ${readFileSync(p).toString("base64")}`; }).sort();
    const before = snapshot(root);
    const out = scratch();
    const run = auditFolder(root);
    writeAudit([run], out);
    expect(snapshot(root)).toEqual(before);
    const table = readFileSync(join(out, "table.txt"), "utf8");
    expect(table).toBe(tableText([run]));
    expect(table).toContain("123456789");
    const json = JSON.parse(readFileSync(join(out, "table.json"), "utf8"));
    expect(json.runs[0].counts.refusal).toBe(3);
    const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
    expect(index.legs).toHaveLength(5);
    for (const leg of index.legs) expect(statSync(join(out, leg.story)).isFile()).toBe(true);
  });
});

describe("the judgement pass", () => {
  function written(): { out: string; root: string } {
    const root = nightly();
    const out = scratch();
    writeAudit([auditFolder(root)], out);
    return { out, root };
  }

  test("legs are grouped by test across runs, and each group's input keeps within its budget", () => {
    const { out } = written();
    const groups = judgeGroups(out, "test");
    expect(groups.map((g) => `${g.key} ${g.legs.length}`)).toEqual([
      "claude-sdk t-journey-a.sdk 2",
      "claude-sdk t-journey-b.sdk 1",
      "codex t-exec-codex-journey-golden-bugfix.serial 1",
      "copilot t-exec-copilot-journey-golden-bugfix.serial 1",
    ]);
    const input = judgeInput(out, groups[0], { budgetBytes: 6000, known: "- t-journey-a.sdk known flake" });
    expect(Buffer.byteLength(input)).toBeLessThanOrEqual(6000);
    expect(input).toContain("t-journey-a.sdk known flake");
    expect(input).toContain("PERSON typed: /aidlc fix the greeter");
    expect(input).toContain("refusal");
  });

  test("the model call can only read: no shell, no edits, no web, and no settings or memory of the person's", () => {
    const args = claudeArgs({ promptFile: "/p/judge.md", schema: "{}", addDirs: ["/a"], model: "m", maxUsd: 2, bare: false });
    expect(args).toContain("-p");
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", "Read,Grep,Glob"]);
    expect(args).toContain("--no-session-persistence");
    expect(args.slice(args.indexOf("--add-dir"), args.indexOf("--add-dir") + 2)).toEqual(["--add-dir", "/a"]);
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args.join(" ")).not.toMatch(/Bash|Edit|Write|WebFetch/);
  });

  test("the model may read only the judged legs' own folders, never the home a session folder sits in", () => {
    const root = scratch();
    put(join(root, ".credentials.json"), '{"token":"secret"}');
    put(join(root, "auth.json"), '{"key":"secret"}');
    put(join(root, "projects", "p", "abc.jsonl"), jsonl([{ type: "user", timestamp: at(0), message: { role: "user", content: "/aidlc go" } }]));
    put(join(root, "sessions", "2026", "10", "20", "rollout-2026-10-20T21-00-00-x.jsonl"),
      jsonl([{ type: "response_item", timestamp: at(0), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "$aidlc go" }] } }]));
    const out = scratch();
    writeAudit([auditFolder(root, { label: "home" })], out);
    const dirs = judgeGroups(out, "test").flatMap((g) => judgeReadDirs(g));
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      expect(relative(dir, join(root, ".credentials.json")).startsWith("..")).toBe(true);
      expect(relative(dir, join(root, "auth.json")).startsWith("..")).toBe(true);
    }
  });

  test("the tool counts how often each friction item was met from the legs the model cites", () => {
    const counts = frictionCounts([
      { title: "a", evidence: [{ leg: "L1", where: "x:1" }, { leg: "L1", where: "x:9" }, { leg: "L2", where: "y:3" }] },
      { title: "b", evidence: [{ leg: "L3", where: "z:2" }] },
    ], 4);
    expect(counts).toEqual([{ title: "a", legs: 2, of: 4 }, { title: "b", legs: 1, of: 4 }]);
  });

  test("a run with a stand-in model writes one result per group and a report, and touches nothing else", async () => {
    const { out, root } = written();
    const fake = join(scratch(), "fake-judge.ts");
    put(fake, [
      "const input = await Bun.stdin.text();",
      "const leg = /^LEG (\\S+)/m.exec(input)?.[1] ?? 'none';",
      "console.log(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.01, structured_output: { friction: [",
      "  { title: 'the agent ran a refused command', person_met: 'a refusal they did not need to see', harness: 'claude-sdk',",
      "    stage: 'requirements-analysis', severity: 'low', known: 'new', cost: 'one extra turn',",
      "    evidence: [{ leg, where: 'sdk-drive-41.ndjson:12' }] } ] } }));",
    ].join("\n"));
    const before = readdirSync(root, { recursive: true }).length;
    const result = await runJudge(out, { group: "test", command: [process.execPath, fake], only: /t-journey-a/ });
    expect(result.groups).toBe(1);
    expect(readdirSync(root, { recursive: true }).length).toBe(before);
    const report = readFileSync(join(out, "JUDGE.md"), "utf8");
    expect(report).toContain("the agent ran a refused command");
    expect(report).toContain("met in 1 of 2 legs");
    expect(JSON.parse(readFileSync(join(out, "judge", "claude-sdk__t-journey-a.sdk.json"), "utf8")).friction).toHaveLength(1);
  });
});
