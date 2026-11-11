// covers: hook:aidlc-cursor-adapter, hook:aidlc-record-human-turn, function:askQuestionReply
//
// #2361: Cursor agents have a structured-question tool, AskQuestion. Its input
// is {title?, questions:[{id, prompt, options:[{id,label}], allow_multiple?}]};
// the reply, as reported from Cursor IDE, is plain text keyed by question id
// and option id(s), one line per question ("Question <id>: Selected option(s)
// <ids>"), a multi-select's ids comma-separated, text typed into "Other"
// verbatim in the same slot, and "User cancelled questionnaire" for a
// dismissed box. Cursor documents postToolUse's tool_output as the result
// JSON-stringified, so a wrapped reply is read too.
//
// The adapter hands the reply to record-human-turn as AskUserQuestion's is
// handed on Claude Code, so a pick is the person's turn:
//   - a pick records HUMAN_TURN (Source: picker) with the option's LABEL, and
//     QUESTION_REPLIED with the question as shown;
//   - a dismissed box records QUESTION_UNANSWERED and hands the agent the same
//     question as numbered prose (Cursor's additional_context);
//   - a reply the adapter cannot read records nothing and tells the agent to
//     ask again as numbered prose; it never guesses a pick;
//   - a background agent's box records nothing.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { askQuestionReply } from "../../dist/cursor/.cursor/hooks/aidlc-cursor-adapter.ts";
import { auditBlockField, readAuditShardEvents, writeSessionPidEntry } from "../../dist/cursor/.cursor/tools/aidlc-lib.ts";
import { createTestProject, REPO_ROOT, seedAuditFile, seedStateFile } from "../harness/fixtures.ts";
import { NATIVE_RUNTIME_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_RUNTIME_CASE_TIMEOUT_MS);

const CURSOR_DIST = join(REPO_ROOT, "dist", "cursor", ".cursor");
const SESSION = "5d190fd9-2361-404e-bbae-000000002361";

const projects: string[] = [];
afterEach(() => {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GATE = {
  title: "Approval",
  questions: [{
    id: "q1",
    prompt: "Requirements Analysis complete. How would you like to proceed?",
    options: [
      { id: "opt1", label: "Approve" },
      { id: "opt2", label: "Request Changes" },
    ],
  }],
};

const reply = (lines: string[]): string => ["User questions responses:", ...lines].join("\n");

describe("askQuestionReply reads AskQuestion's reply", () => {
  test("a pick maps the option id to its label, and the question is handed on as `question`", () => {
    const r = askQuestionReply(GATE, reply(["Question q1: Selected option(s) opt1"]));
    expect(r.kind).toBe("answered");
    if (r.kind !== "answered") return;
    expect(r.answers).toEqual({ q1: ["Approve"] });
    expect(r.toolInput.questions[0]).toEqual({
      id: "q1",
      question: GATE.questions[0].prompt,
      multiSelect: false,
      options: [{ label: "Approve" }, { label: "Request Changes" }],
    });
  });

  test("several questions in one call, and a multi-select's comma-separated ids", () => {
    const input = {
      questions: [
        GATE.questions[0],
        {
          id: "q2",
          prompt: "Which stages should I skip?",
          allow_multiple: true,
          options: [{ id: "opt1", label: "Domain Design" }, { id: "opt2", label: "Contract Design" }],
        },
      ],
    };
    const r = askQuestionReply(input, reply([
      "Question q1: Selected option(s) opt2",
      "Question q2: Selected option(s) opt1, opt2",
    ]));
    expect(r.kind).toBe("answered");
    if (r.kind !== "answered") return;
    expect(r.answers).toEqual({ q1: ["Request Changes"], q2: ["Domain Design", "Contract Design"] });
    expect(r.toolInput.questions[1].multiSelect).toBe(true);
  });

  test("text typed into Other is the person's own words, kept whole, over several lines too", () => {
    const one = askQuestionReply(GATE, reply(["Question q1: approve it, but rename the module"]));
    expect(one.kind === "answered" && one.answers.q1).toEqual(["approve it, but rename the module"]);
    const many = askQuestionReply(GATE, reply(["Question q1: first line", "second line"]));
    expect(many.kind === "answered" && many.answers.q1).toEqual(["first line\nsecond line"]);
    // Commas in their words never split them into picks.
    const commas = askQuestionReply(GATE, reply(["Question q1: opt1, but later"]));
    expect(commas.kind === "answered" && commas.answers.q1).toEqual(["opt1, but later"]);
  });

  test("a dismissed box, or a reply with no answer, is unanswered", () => {
    expect(askQuestionReply(GATE, "User cancelled questionnaire").kind).toBe("cancelled");
    expect(askQuestionReply(GATE, reply([])).kind).toBe("cancelled");
    expect(askQuestionReply(GATE, reply(["Question q1: "])).kind).toBe("cancelled");
  });

  test("the reply is read when Cursor wraps it in a JSON string or object", () => {
    const text = reply(["Question q1: Selected option(s) opt1"]);
    for (const wrapped of [JSON.stringify(text), JSON.stringify({ result: text }), { content: [{ text }] }]) {
      const r = askQuestionReply(GATE, wrapped);
      expect(r.kind === "answered" && r.answers).toEqual({ q1: ["Approve"] });
    }
    expect(askQuestionReply(GATE, JSON.stringify("User cancelled questionnaire")).kind).toBe("cancelled");
  });

  test("the longest offered id wins, so an id that prefixes another is never misread", () => {
    const input = {
      questions: [
        { id: "q", prompt: "First?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
        { id: "q 2", prompt: "Second?", options: [{ id: "a", label: "Yes" }, { id: "b", label: "No" }] },
      ],
    };
    const r = askQuestionReply(input, reply(["Question q 2: Selected option(s) b", "Question q: Selected option(s) a"]));
    expect(r.kind === "answered" && r.answers).toEqual({ q: ["A"], "q 2": ["No"] });
  });

  test("anything it cannot read is unreadable: no guessed pick", () => {
    // No reply text at all, another tool's output, a line for a question the box did not ask.
    for (const output of [undefined, "", "done", { ok: true }, reply(["Question q9: opt1"])]) {
      expect(askQuestionReply(GATE, output).kind).toBe("unreadable");
    }
    // A box whose questions or options the adapter cannot read.
    for (const input of [undefined, {}, { questions: [] }, { questions: [{ id: "q1", prompt: "?", options: [{ label: "A" }] }] }]) {
      expect(askQuestionReply(input, reply(["Question q1: opt1"])).kind).toBe("unreadable");
    }
  });
});

function project(): string {
  const proj = createTestProject();
  projects.push(proj);
  cpSync(CURSOR_DIST, join(proj, ".cursor"), { recursive: true });
  seedStateFile(proj, "state-construction.md");
  seedAuditFile(proj);
  return proj;
}

// postToolUse for one AskQuestion call, through the shipped adapter target
// hooks.json registers for every tool.
function asked(proj: string, toolInput: unknown, toolOutput: unknown, extra: Record<string, unknown> = {}) {
  writeSessionPidEntry(proj, process.pid, SESSION);
  const env: Record<string, string | undefined> = {
    ...process.env,
    AIDLC_PROJECT_DIR: proj,
    AIDLC_HARNESS_DIR: ".cursor",
    GIT_CONFIG_GLOBAL: join(proj, ".absent-global-gitconfig"),
    GIT_CONFIG_SYSTEM: join(proj, ".absent-system-gitconfig"),
    AIDLC_UNATTENDED: undefined,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const r = spawnSync("bun", [join(proj, ".cursor", "hooks", "aidlc-cursor-adapter.ts"), "audit-and-sensors"], {
    cwd: proj,
    encoding: "utf-8",
    env: env as NodeJS.ProcessEnv,
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: JSON.stringify({
      hook_event_name: "postToolUse",
      session_id: SESSION,
      conversation_id: SESSION,
      generation_id: "gen-2361",
      tool_name: "AskQuestion",
      tool_input: toolInput,
      tool_output: toolOutput,
      tool_use_id: "toolu_2361",
      duration: 1,
      ...extra,
    }),
  });
  expect(r.status, r.stderr).toBe(0);
  const line = (r.stdout ?? "").trim().split("\n").find((entry) => entry.startsWith("{"));
  const context = line ? (JSON.parse(line) as { additional_context?: string }).additional_context ?? "" : "";
  return { context };
}

const events = (proj: string, name: string) => readAuditShardEvents(proj).filter((row) => row.event === name);

describe("an AskQuestion reply on Cursor is the person's turn", () => {
  test("a pick records HUMAN_TURN from the picker with the label, and the reply as given", () => {
    const proj = project();
    const before = events(proj, "HUMAN_TURN").length;
    asked(proj, GATE, JSON.stringify(reply(["Question q1: Selected option(s) opt1"])));
    const turns = events(proj, "HUMAN_TURN");
    expect(turns).toHaveLength(before + 1);
    const turn = turns.at(-1)!;
    expect(auditBlockField(turn.block, "Source")).toBe("picker");
    expect(auditBlockField(turn.block, "Picked")).toBe(JSON.stringify(["Approve"]));
    const replied = events(proj, "QUESTION_REPLIED").at(-1)!;
    expect(auditBlockField(replied.block, "Question")).toBe(GATE.questions[0].prompt);
    expect(auditBlockField(replied.block, "Reply")).toBe("Approve");
    expect(events(proj, "QUESTION_UNANSWERED")).toHaveLength(0);
  });

  test("a dismissed box records QUESTION_UNANSWERED and hands back the question as numbered prose", () => {
    const proj = project();
    const before = events(proj, "HUMAN_TURN").length;
    const { context } = asked(proj, GATE, "User cancelled questionnaire");
    expect(events(proj, "QUESTION_UNANSWERED")).toHaveLength(1);
    expect(events(proj, "HUMAN_TURN")).toHaveLength(before);
    expect(events(proj, "QUESTION_REPLIED")).toHaveLength(0);
    expect(context).toContain(GATE.questions[0].prompt);
    expect(context).toContain("1. Approve");
    expect(context).toContain("2. Request Changes");
    expect(context).toContain("never pick an answer for the person");
  });

  test("a reply it cannot read records nothing and says to ask again as numbered prose", () => {
    const proj = project();
    const before = readAuditShardEvents(proj).length;
    const { context } = asked(proj, GATE, JSON.stringify({ status: "ok" }));
    expect(readAuditShardEvents(proj)).toHaveLength(before);
    expect(context).toContain("could not read the reply");
    expect(context).toContain("numbered options");
  });

  test("a background agent's box records nothing", () => {
    const proj = project();
    const before = readAuditShardEvents(proj).length;
    const { context } = asked(proj, GATE, reply(["Question q1: Selected option(s) opt1"]), { is_background_agent: true });
    expect(readAuditShardEvents(proj)).toHaveLength(before);
    expect(context).toBe("");
  });
});
