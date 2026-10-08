// t-message-record: the human-turn hook keeps one record of each message the
// person sends, and the HUMAN_TURN row points at it.
//
// The record proves two things and reads no meaning: that a real person said
// this in this chat (the row the hook mints), and exactly what they said (the
// text as the host delivered it, the flags the engine's own parser finds in a
// typed `/aidlc` line, the switch lines the hook applied). Nothing reads the
// record yet; this file pins its shape on the four host hook paths.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  REPO_ROOT,
  seededStateFile,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  auditBlockField,
  readAuditShardEvents,
  writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c001";

type Harness = "claude" | "codex" | "kiro" | "kiro-ide";
const HARNESSES: Harness[] = ["claude", "codex", "kiro", "kiro-ide"];

interface StoredMessage {
  id: string;
  session: string | null;
  at: string;
  source: "prompt" | "picker" | "terminal";
  text: string;
  picker: Array<{ question: string; reply: string }> | null;
  words: string | null;
  settings: Array<{ key: string; value: string }>;
  route: { scope: string | null; newIntent: boolean; skip: string[]; add: string[]; projectType: string | null };
  applied: string[];
  cut?: true;
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

// A workflow at Requirements Analysis, as the shipped fixture has it.
function withWork(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8"), "utf-8");
  return proj;
}

// A project the framework has never run in: no state file anywhere.
function noWork(): string {
  const proj = createTestProject();
  created.push(proj);
  return proj;
}

// Production guards, as a person's run has them.
function env(proj: string): NodeJS.ProcessEnv {
  return {
    ...testGuardEnvironment(process.env, "production"),
    CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0",
  };
}

function run(proj: string, args: string[], input: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync(BUN, args, {
    cwd: proj,
    input,
    env: { ...env(proj), ...extraEnv },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return result.stdout;
}

function hostTree(proj: string, harness: Exclude<Harness, "claude">): string {
  const tree = harness === "codex" ? ".codex" : ".kiro";
  if (!existsSync(join(proj, tree))) cpSync(join(REPO_ROOT, "dist", harness, tree), join(proj, tree), { recursive: true });
  return tree;
}

const UNSET = { CLAUDE_PROJECT_DIR: undefined, AIDLC_UNATTENDED: undefined, USER_PROMPT: undefined };

// The person types `prompt`, through the host's own human-turn hook.
function say(proj: string, prompt: string, harness: Harness = "claude", extraEnv: NodeJS.ProcessEnv = {}): void {
  if (harness === "claude") {
    run(proj, [DISPATCHER, "engine", "hook", "record-human-turn"],
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: proj, prompt }), extraEnv);
    return;
  }
  const tree = hostTree(proj, harness);
  if (harness === "codex") {
    writeSessionPidEntry(proj, process.pid, SESSION);
    run(proj, [join(proj, tree, "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"],
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, turn_id: "t1", cwd: proj, prompt }),
      { ...UNSET, CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined, ...extraEnv });
    return;
  }
  run(proj, [join(proj, tree, "hooks", "aidlc-kiro-adapter.ts"), harness === "kiro" ? "verb-intercept" : "record-human-turn"],
    JSON.stringify({ hook_event_name: harness === "kiro" ? "userPromptSubmit" : "UserPromptSubmit", session_id: SESSION, cwd: proj, prompt }),
    { ...UNSET, ...extraEnv });
}

// The person picks `choice` in a question box that asked `question`.
function pick(proj: string, harness: "claude" | "codex", question: string, options: string[], choice: string): void {
  if (harness === "claude") {
    run(proj, [DISPATCHER, "engine", "hook", "record-human-turn"], JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", session_id: SESSION, cwd: proj,
      tool_input: { questions: [{ question, options: options.map((label) => ({ label })) }] },
      tool_response: { answers: { [question]: choice } },
    }));
    return;
  }
  const tree = hostTree(proj, "codex");
  writeSessionPidEntry(proj, process.pid, SESSION);
  run(proj, [join(proj, tree, "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"], JSON.stringify({
    hook_event_name: "PostToolUse", tool_name: "request_user_input", session_id: SESSION, turn_id: "t1", cwd: proj,
    tool_input: { questions: [{ id: "q1", question, options }] },
    tool_response: JSON.stringify({ answers: { q1: { answers: [choice] } } }),
  }), { ...UNSET, CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined });
}

function messagesDir(proj: string): string {
  return join(proj, "aidlc", ".aidlc-sessions", "messages");
}

// Read without the store module, so a red run fails on what is asserted, not on an import.
function records(proj: string): StoredMessage[] {
  const dir = messagesDir(proj);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf-8")) as StoredMessage)
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

function humanTurns(proj: string) {
  return readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN");
}

const NO_ROUTE = { scope: null, newIntent: false, skip: [], add: [], projectType: null };

describe("the human-turn hook keeps one record of each message", () => {
  for (const harness of HARNESSES) {
    test(`${harness}: a typed prompt writes one record, and the HUMAN_TURN row points at it`, () => {
      const proj = withWork();
      say(proj, "add a test for an empty title", harness);
      const all = records(proj);
      expect(all).toHaveLength(1);
      const [record] = all;
      expect(record.source).toBe("prompt");
      expect(record.text).toBe("add a test for an empty title");
      expect(record.words).toBe("add a test for an empty title");
      expect(record.settings).toEqual([]);
      expect(record.route).toEqual(NO_ROUTE);
      expect(record.applied).toEqual([]);
      expect(record.picker).toBeNull();
      expect(record.cut).toBeUndefined();
      expect(record.id).toMatch(/^[0-9a-f]{8}$/);
      if (harness !== "kiro-ide") expect(record.session).toBe(SESSION);
      else expect(record.session).not.toBeNull();
      const turns = humanTurns(proj);
      expect(turns).toHaveLength(1);
      expect(auditBlockField(turns[0].block, "Message Id")).toBe(record.id);
    });

    test(`${harness}: flags are the engine's own parse, and a flag-shaped word stays a word`, () => {
      const proj = withWork();
      say(proj, "/aidlc --guard.review-freeze off add a --help flag to the reverser", harness);
      const [record] = records(proj);
      expect(record.settings).toEqual([{ key: "guard.review-freeze", value: "off" }]);
      expect(record.words).toBe("add a --help flag to the reverser");
      expect(record.route.scope).toBeNull();
      // The switch is for the work the words describe, so the open work keeps
      // its check; what the hook applied or kept is on the record either way.
      expect(record.applied.length).toBeGreaterThan(0);
    });

    test(`${harness}: a command with no words records no words`, () => {
      const proj = withWork();
      say(proj, "/aidlc --status", harness);
      const [record] = records(proj);
      expect(record.words).toBeNull();
      expect(record.text).toBe("/aidlc --status");
      expect(record.settings).toEqual([]);
      const [turn] = humanTurns(proj);
      expect(auditBlockField(turn.block, "Message Id")).toBe(record.id);
      expect(auditBlockField(turn.block, "Reply")).toBe("command");
    });

    test(`${harness}: a scope and a setting typed with the request are on the record`, () => {
      const proj = withWork();
      say(proj, "/aidlc bugfix --depth minimal fix the parser", harness);
      const [record] = records(proj);
      expect(record.route.scope).toBe("bugfix");
      expect(record.settings).toEqual([{ key: "depth", value: "minimal" }]);
      expect(record.words).toBe("fix the parser");
    });
  }

  for (const harness of ["claude", "codex"] as const) {
    test(`${harness}: a question box reply is a picker record, one per payload`, () => {
      const proj = withWork();
      pick(proj, harness, "Where should the check live?", ["In the API handler", "In the model"], "In the API handler");
      const all = records(proj);
      expect(all).toHaveLength(1);
      const [record] = all;
      expect(record.source).toBe("picker");
      expect(record.picker).toEqual([{ question: "Where should the check live?", reply: "In the API handler" }]);
      expect(record.words).toBe("In the API handler");
      expect(record.settings).toEqual([]);
      const [turn] = humanTurns(proj);
      expect(auditBlockField(turn.block, "Message Id")).toBe(record.id);
      // Claude Code hands the box's answers over whole, so the row keeps the
      // picks; the Codex adapter hands the pick over as answer text and the
      // box's own reply rides the QUESTION_REPLIED rows instead (as today).
      if (harness === "claude") expect(auditBlockField(turn.block, "Picked")).toContain("In the API handler");
    });
  }

  test("before any workflow exists, the record is written and no HUMAN_TURN row is", () => {
    const proj = noWork();
    say(proj, "/aidlc --guard.review-freeze off");
    const all = records(proj);
    expect(all).toHaveLength(1);
    expect(all[0].settings).toEqual([{ key: "guard.review-freeze", value: "off" }]);
    expect(all[0].words).toBeNull();
    expect(readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN")).toEqual([]);
  });

  test("an unattended driver writes no record", () => {
    const proj = withWork();
    say(proj, "approve", "claude", { AIDLC_UNATTENDED: "1" });
    expect(existsSync(messagesDir(proj))).toBe(false);
  });

  test("kiro-ide: a prompt the host left empty is a prompt whose words are unknown, not a picker reply", () => {
    const proj = withWork();
    say(proj, "", "kiro-ide");
    const all = records(proj);
    expect(all).toHaveLength(1);
    expect(all[0].source).toBe("prompt");
    expect(all[0].text).toBe("");
    expect(all[0].words).toBeNull();
    expect(all[0].settings).toEqual([]);
    expect(all[0].picker).toBeNull();
  });

  test("the store keeps 200 records and a day: older ones go on the next write", () => {
    const proj = withWork();
    const dir = messagesDir(proj);
    mkdirSync(dir, { recursive: true });
    const seed = (id: string, at: string): void => {
      writeFileSync(join(dir, `${id}.json`), `${JSON.stringify({
        id, session: SESSION, at, source: "prompt", text: `seed ${id}`, picker: null, words: `seed ${id}`,
        settings: [], route: NO_ROUTE, applied: [],
      })}\n`, "utf-8");
    };
    const recent = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < 200; i++) seed(`a${i.toString(16).padStart(7, "0")}`, new Date(recent + i * 1000).toISOString());
    seed("0000000d", new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    say(proj, "one more");
    const all = records(proj);
    expect(all).toHaveLength(200);
    expect(all.some((record) => record.id === "0000000d")).toBe(false);
    expect(all.some((record) => record.id === "a0000000")).toBe(false);
    expect(all[all.length - 1].text).toBe("one more");
  });

  test("a messages folder that is a link writes nothing through it, and the turn still counts", () => {
    const proj = withWork();
    const outside = join(tmpdir(), `aidlc-message-link-${process.pid}-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(proj, "aidlc", ".aidlc-sessions"), { recursive: true });
    symlinkSync(outside, messagesDir(proj));
    say(proj, "approve");
    expect(readdirSync(outside)).toEqual([]);
    const turns = humanTurns(proj);
    expect(turns).toHaveLength(1);
    expect(auditBlockField(turns[0].block, "Message Id")).toBeNull();
  });

  test("a long prompt is kept to 8000 characters and says it was cut; the words are not shortened", () => {
    const proj = withWork();
    const spec = `/aidlc ${"spec line. ".repeat(900)}`.trim();
    expect(spec.length).toBeGreaterThan(8000);
    say(proj, spec);
    const [record] = records(proj);
    expect(record.text).toHaveLength(8000);
    expect(record.cut).toBe(true);
    expect(record.words).toBe(spec.slice("/aidlc ".length).trim());
  });
});
