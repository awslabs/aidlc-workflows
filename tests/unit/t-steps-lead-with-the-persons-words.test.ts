// covers: function:withPersonsWordsFirst subcommand:aidlc-orchestrate:next subcommand:aidlc-orchestrate:report
//
// Codex, Kiro CLI and opencode print the first lines of every engine command's
// output in their tool panel (3, 5 and about 12 lines of it). The step used to
// open with the engine's fields ({"kind":"ask","ask_type":"scope-confirm",
// "response_route":"next",...) and close with the notes meant for the agent
// ("This question is for the person, not for you..."), so the person read the
// machinery and never their own question. The step now leads with the words
// written for the person (the question, the narration, the message, the change
// notices, the stage-validity warning) and ends with the notes for the agent:
// the same keys and values, one canonical JSON line.
// Mechanism: the shipped engine on a fixture project, read as the bytes it
// writes; the order rule itself in-process over the shipped function.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withPersonsWordsFirst } from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  followProposal,
  runOrchestrateNext,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const ENV = { ...process.env, AIDLC_SKIP_REVIEWER_GATE_GUARD: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" };

type Step = Record<string, unknown>;

function project(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  return proj;
}

/** The one line the engine writes for this `next`, with the step it parses to. */
function next(proj: string, args: string[] = []): { line: string; step: Step } {
  // The agent's proposal step follows the plan proposal print, as it does live.
  const result = followProposal(runOrchestrateNext(ORCH, proj, args, { env: ENV }), ORCH, proj, { env: ENV });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return { line: result.stdout.trim(), step: result.directive as Step };
}

/** The keys a step's line names, in the order its bytes carry them. */
const keysOf = (line: string): string[] => Object.keys(JSON.parse(line) as Step);

const PERSON_TEXT = ["question", "narration", "message", "change_notices", "stage_validity"];

/**
 * The line opens with the words written for the person: every key before
 * `kind` is person text, in the rule's order, and the bytes start with the
 * first of them. Returns those keys (a step with no words opens with `kind`).
 */
function opensWithThePersonsWords(line: string): string[] {
  const keys = keysOf(line);
  const lead = keys.slice(0, keys.indexOf("kind"));
  expect(lead, keys.join(",")).toEqual(PERSON_TEXT.filter((key) => keys.includes(key)));
  if (lead.length > 0) expect(line.startsWith(`{"${lead[0]}":`), line.slice(0, 120)).toBe(true);
  return lead;
}

/** Every key from the first note on is a note: the notes to the agent close the line. */
function notesClose(line: string): void {
  const keys = keysOf(line);
  const first = keys.findIndex((key) => key.endsWith("_note"));
  expect(first, keys.join(",")).toBeGreaterThan(0);
  expect(keys.slice(first).every((key) => key.endsWith("_note")), keys.join(",")).toBe(true);
}

describe("the step's first bytes are the person's words, the notes to the agent its last", () => {
  test("the order rule: person text, then kind and the rest as built, then every note; same keys, same values", () => {
    const built: Step = {
      kind: "ask",
      ask_type: "scope-confirm",
      stage_validity: {
        state: "drifted", directly_stale: ["a.md"], needs_revalidation: [], untracked: [], earliest_affected_stage: "design",
        warning: "Design read an input that changed since.",
      },
      stage_validity_note: "n1",
      question: "Q",
      change_notices: ["C"],
      choices: [{ label: "Go ahead", command: "x" }],
      question_note: "n2",
      numbered_prose_question: "N",
      narration: "L",
      message: "M",
      change_notices_note: "n3",
    };
    const ordered = withPersonsWordsFirst(built);
    expect(Object.keys(ordered)).toEqual([
      "question", "narration", "message", "change_notices", "stage_validity",
      "kind", "ask_type", "choices", "numbered_prose_question",
      "stage_validity_note", "question_note", "change_notices_note",
    ]);
    expect(Object.keys(ordered.stage_validity as Step)[0]).toBe("warning");
    expect(ordered).toEqual(built);
    expect(JSON.parse(JSON.stringify(ordered))).toEqual(built);
    // A step with no words for the person and no notes keeps the order it was built in.
    const rules: Step = { kind: "load-steering", stage: "intent-capture", part: 1, parts: 2, receipt: "r", rules_bundle: "b" };
    expect(Object.keys(withPersonsWordsFirst(rules))).toEqual(Object.keys(rules));
  });

  test("the question step opens with the question and closes with its notes", () => {
    const proj = project();
    const asked = next(proj, ["--", "fix the greeter so it says hello"]);
    expect(asked.step.kind).toBe("ask");
    expect(opensWithThePersonsWords(asked.line)[0]).toBe("question");
    expect(asked.line.startsWith(`{"question":${JSON.stringify(asked.step.question)}`), asked.line.slice(0, 160)).toBe(true);
    notesClose(asked.line);
  });

  test("the creation print opens with its message; the first stage step opens with the person's line and closes with its notes", () => {
    const proj = project();
    const asked = next(proj, ["--", "fix the greeter so it says hello"]);
    const id = /--request ([0-9a-f]{8})/.exec(String(asked.step.confirm_command))?.[1];
    expect(id, String(asked.step.confirm_command)).toBeDefined();
    const print = next(proj, ["--scope", "bugfix", "--request", id as string]);
    expect(print.step.kind).toBe("print");
    // In a chat the setup line waits for the step that speaks; without one it rides this print, first.
    expect(opensWithThePersonsWords(print.line)).toContain("message");
    expect(String(print.step.message).startsWith("Run `")).toBe(true);
    const made = spawnSync(
      process.execPath,
      [DISPATCHER, "engine", "intent", "create", "--scope", "bugfix", "--request", id as string, "--label", "greeter hello", "--project-dir", proj],
      { encoding: "utf-8", env: ENV, cwd: proj, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) },
    );
    expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
    const stage = next(proj);
    expect(stage.step.kind).toBe("run-stage");
    expect(opensWithThePersonsWords(stage.line)).toEqual(["narration"]);
    notesClose(stage.line);
    // A setting typed as a flag: the step is a print whose line is the person's first, then the agent's.
    const setting = next(proj, ["--depth", "standard"]);
    expect(setting.step.kind).toBe("print");
    expect(opensWithThePersonsWords(setting.line)).toContain("message");
    expect(String(setting.step.message)).toContain("config set depth standard");
  });

  test("a gate's print opens with the line for the person, then the agent's message", () => {
    const proj = project();
    writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8"), "utf-8");
    const dir = join(seededRecordDir(proj), "inception", "requirements-analysis");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "requirements.md"), "# Requirements\n\n## FR-1\nList notes.\n", "utf-8");
    const result = spawnSync(
      process.execPath,
      [ORCH, "report", "--stage", "requirements-analysis", "--result", "awaiting-approval", "--project-dir", proj],
      { encoding: "utf-8", env: ENV, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const line = (result.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "";
    expect(opensWithThePersonsWords(line)).toEqual(["narration", "message"]);
    expect(line.startsWith('{"narration":"Requirements Analysis is ready for your review.'), line.slice(0, 160)).toBe(true);
  });
});
