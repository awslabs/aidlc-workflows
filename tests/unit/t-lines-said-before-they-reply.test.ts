// t-lines-said-before-they-reply: a line the person must hear rides the step the agent speaks from in
// `change_notices`, with the one order in the step: said once, as written, in the last message the agent writes
// before the person replies.
//
// Measured on main a6486a805 (say-once-lands' PLAN): the same lines rode `narration` on the first of many steps in
// the agent's turn, with no order in the step. Copilot CLI headless writes one message in most turns, so a line
// handed mid-turn never reached it (a key to change after a gate reply 0 of 3); `claude -p` prints only the turn's
// last message, so the line saying where the work picks up, and that a folder with no code drops Reverse
// Engineering, was never printed (0 of 5 each). A line true only before the work it describes (plan approval off,
// inputs missing) keeps its own order in the step.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, REPO_ROOT, runOrchestrateNext } from "../harness/fixtures.ts";
import { addPendingPersonLines } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { inputsNote, planNote } from "../../dist/claude/.claude/tools/aidlc-directive.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const AIDLC = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c0de";
const chat = { ...process.env, AIDLC_SESSION_OVERRIDE: SESSION, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" };
const WHEN = "in the last message you write before they reply (when you end your turn with a question, the text you " +
  "write just before it)";
const NO_CODE = "The folder has no code yet, so I'm starting this as a new project without Reverse Engineering. " +
  "If the work is on existing code, tell me.";
const TREES = [
  ["claude", ".claude"], ["codex", ".codex"], ["copilot", ".aidlc"], ["cursor", ".cursor"], ["kiro", ".kiro"],
  ["kiro-ide", ".kiro"], ["opencode", ".aidlc"],
] as const;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop());
});

function project(): string {
  const p = createOrchestrationTestProject();
  tempDirs.push(p);
  return p;
}

function nextIn(proj: string, args: string[] = []): Record<string, unknown> {
  const result = runOrchestrateNext(ORCH, proj, args, { env: chat });
  expect(result.directive, result.out).not.toBeNull();
  return result.directive ?? {};
}

function notices(step: Record<string, unknown>): string[] {
  return Array.isArray(step.change_notices) ? step.change_notices.map(String) : [];
}

// "/aidlc --scope <scope> <words>": the print that creates the work, then the creation itself, in this chat.
function created(proj: string, scope: string, words: string): void {
  const creation = nextIn(proj, ["--scope", scope, words]);
  expect(creation.kind).toBe("print");
  const request = /--request ([0-9a-f]{8})/.exec(String(creation.message))?.[1];
  expect(request, String(creation.message)).toBeDefined();
  const made = spawnSync(BUN, [
    AIDLC, "engine", "intent", "create", "--scope", scope, "--request", request ?? "", "--label", "the-work",
    "--project-dir", proj,
  ], { encoding: "utf-8", env: chat, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
}

describe("t-lines-said-before-they-reply: the lines the person must hear ride change_notices, said before they reply", () => {
  test("creation's lines ride the first step the agent speaks from, with the order, and not its narration", () => {
    const proj = project();
    created(proj, "poc", "build a lunch poll");
    const first = nextIn(proj);
    expect(first.kind).toBe("run-stage");
    const said = notices(first);
    expect(said.join(" ")).toStartWith("Setting up the poc workflow for this");
    expect(said.join(" ")).toContain(NO_CODE);
    expect(String(first.change_notices_note)).toContain(WHEN);
    // The stage's own line stays the step's narration, and nothing is carried twice.
    expect(String(first.narration ?? "")).not.toContain("Setting up the poc workflow");
    expect(String(first.narration ?? "")).not.toContain("no code yet");
    // Said once: the same step asked for again does not carry it.
    expect(notices(nextIn(proj)).join(" ")).not.toContain("Setting up the poc workflow");
  });

  test("picking the work back up: where it picks up rides change_notices, the stage's own line stays narration", () => {
    const proj = project();
    expect(spawnSync(BUN, [UTIL, "intent-create", "--scope", "classic", "--arguments", "show the asset description on hover",
      "--project-dir", proj], { encoding: "utf-8", env: chat, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) }).status)
      .toBe(0);
    const first = nextIn(proj, ["--resume"]);
    const pickUp = notices(first).find((line) => line.startsWith("Picking up where we left off, at "));
    expect(pickUp, JSON.stringify(first)).toMatch(
      /^Picking up where we left off, at [A-Z][^.]*\. If you'd rather redo it, go back to another stage, or start fresh, just say so\.$/,
    );
    expect(String(first.change_notices_note)).toContain(WHEN);
    expect(String(first.narration ?? "")).not.toContain("Picking up where we left off");
    const again = nextIn(proj, ["--resume"]);
    expect([...notices(again), String(again.narration ?? "")].join(" ")).not.toContain("Picking up where we left off");
  });

  test("a line kept for the next step (a key typed in a gate reply, a jump's kept line) rides that step's change_notices", () => {
    const proj = project();
    created(proj, "poc", "build a lunch poll");
    const line = "Your message looked like it held a key or password. AI-DLC keeps it out of its committed record.";
    expect(addPendingPersonLines(proj, SESSION, [line])).toBe(true);
    const step = nextIn(proj);
    expect(notices(step)).toContain(line);
    expect(String(step.narration ?? "")).not.toContain(line);
    expect(String(step.change_notices_note)).toContain(WHEN);
  });

  test("the one order is the same in every harness's tree: once, as written, before they reply", async () => {
    for (const [harness, dir] of TREES) {
      const tree = await import(join(REPO_ROOT, "dist", harness, dir, "tools", "aidlc-directive.ts"));
      expect(tree.CHANGE_NOTICES_NOTE, harness).toBe(
        `Say each change_notices line to the person ${tree.SAY_ONCE_BEFORE_THEY_REPLY}, and add nothing about why.`,
      );
      expect(tree.SAY_ONCE_BEFORE_THEY_REPLY, harness).toBe(
        "once, as written (only a verb's tense may change to fit when you say it), as your own sentence with " +
          `nothing in front of it, ${WHEN}`,
      );
    }
  });

  // These two lines say what is about to happen, so they are said before the work, as their step's own order says.
  test("a line true only before the work keeps its own order: plan approval off, inputs missing", () => {
    expect(planNote({ status: "approved", skipped: true, notice: "Plan approval is off." }, "bun x"))
      .toStartWith("Say to the person first: Plan approval is off.");
    expect(inputsNote(["a.md"])).toStartWith('Say to the person once: "Some inputs this stage usually reads are not here');
  });
});
