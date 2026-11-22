// covers: hook:aidlc-continue-workflow, subcommand:aidlc-orchestrate:next
//
// Kiro CLI, both engines (measure-kiro-loops F2, two in each run): the agent
// asked the person a question in its own words and ended its turn without
// logging it, so nothing on record said it was waiting for them. The Stop hook
// read that as a mid-stage quit and carried the turn on: Kiro CLI v3 showed
// "3. Other - describe what you want insteadAI-DLC is carrying on with Units
// Generation." as the agent speaking while it waited, and Claude Code drew
// "Stop hook feedback: AI-DLC is carrying on with ..." under the question.
//
// In an attended, gated run the turn now ends there: the question stays on
// screen and the person's next message carries the work on. The block stays
// where the work carries on by itself: autonomous Construction, and a run
// nobody attends (AIDLC_UNATTENDED=1).

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setGuardPolicyLine } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, intentsDirOf, seededStateFile, setupIntegrationProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SESSION = "attended-turn";
const ENV: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: "" };
for (const name of ["AIDLC_UNATTENDED", "AIDLC_STOP_HOOK_PROBE", "AIDLC_COPILOT_SESSION_ID", "AIDLC_HARNESS_NAME"]) delete ENV[name];

const projects: string[] = [];
afterAll(() => {
  for (const dir of projects) cleanupTestProject(dir);
});

function engine(proj: string, args: string[], input?: string, extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [join(proj, ".claude", "tools", "aidlc.ts"), ...args], {
    cwd: proj,
    input,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: { ...ENV, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, ...extra },
  });
  return { status: result.status, stdout: result.stdout ?? "", out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function step(proj: string, args: string[]): Record<string, unknown> {
  const result = engine(proj, ["engine", "orchestrate", ...args]);
  expect(result.status, result.out).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

async function personSays(proj: string, prompt: string): Promise<void> {
  const result = engine(proj, ["engine", "hook", "record-human-turn"], JSON.stringify({
    hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt,
  }));
  expect(result.status, result.out).toBe(0);
  await Bun.sleep(20);
}

// Requirements Analysis in progress, optionally under autonomous Construction
// or a Guard Policy set by the person.
function project(autonomous = false, policy?: "off" | "relaxed" | "strict"): string {
  const proj = setupIntegrationProject({ withState: "state-mid-inception.md", stripEnvScope: true });
  projects.push(proj);
  if (policy) {
    const path = seededStateFile(proj);
    writeFileSync(path, setGuardPolicyLine(readFileSync(path, "utf-8"), `${policy} (set by you)`));
  }
  if (autonomous) {
    const path = seededStateFile(proj);
    writeFileSync(path, readFileSync(path, "utf-8").replace(
      /^- \*\*Current Stage\*\*: .*$/m,
      (line) => `${line}\n- **Construction Autonomy Mode**: autonomous`,
    ));
  }
  return proj;
}

// The chat as Claude Code records it: the person's message, the agent's
// engine call and its result, then the question in the agent's own words.
function claudeTranscript(proj: string): string {
  const path = join(proj, "transcript.jsonl");
  const stamp = { version: "2.1.296" };
  const entries = [
    { ...stamp, type: "user", message: { role: "user", content: "Guide me through the questions" } },
    { ...stamp, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "n1", name: "Bash", input: { command: "bun .claude/tools/aidlc.ts engine orchestrate next" } }] } },
    { ...stamp, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "n1", content: "{}" }] } },
    { ...stamp, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Who reads the greeting? 1. A person 2. A script 3. Other - describe what you want instead" }] } },
  ];
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return path;
}

type Shape = "kiro" | "claude";

// The Stop hook as each tool runs it: Kiro CLI delivers no transcript (the
// turn markers stand in for it), Claude Code delivers its transcript.
function stop(proj: string, shape: Shape, extra: NodeJS.ProcessEnv = {}) {
  const payload = {
    hook_event_name: "Stop",
    stop_hook_active: false,
    session_id: SESSION,
    ...(shape === "claude" ? { transcript_path: claudeTranscript(proj) } : {}),
  };
  const result = engine(proj, ["engine", "hook", "continue-workflow"], JSON.stringify(payload), {
    AIDLC_HARNESS_NAME: shape, ...extra,
  });
  expect(result.status, result.out).toBe(0);
  return result.stdout.trim();
}

// The turn the person met: they asked to be guided, the agent took the stage's
// step from the engine and asked its first question in prose, logging nothing.
async function askedInProse(proj: string): Promise<void> {
  await personSays(proj, "Guide me through the questions");
  expect(step(proj, ["next"]).kind).toBe("run-stage");
}

describe("t-stop-attended-turn-ends", () => {
  for (const shape of ["kiro", "claude"] as const) {
    test(`${shape}: a question asked in prose with nothing logged ends the attended turn in silence`, async () => {
      const proj = project();
      await askedInProse(proj);
      expect(stop(proj, shape)).toBe("");
      // The person's next message carries the work on: the stage's step again,
      // no refusal and nothing recorded in their name.
      await personSays(proj, "A person, someone at a terminal");
      expect(step(proj, ["next"])).toMatchObject({ kind: "run-stage", stage: "requirements-analysis" });
    });

    test(`${shape}: autonomous Construction still carries the turn on`, async () => {
      const proj = project(true);
      await askedInProse(proj);
      expect(stop(proj, shape)).toContain("AI-DLC is carrying on with Requirements Analysis.");
    });

    // The hook reads no Guard Policy: every policy ends the attended turn the same way.
    test(`${shape}: under Guard Policy off, relaxed and strict the attended turn ends the same way`, async () => {
      for (const policy of ["off", "relaxed", "strict"] as const) {
        const proj = project(false, policy);
        await askedInProse(proj);
        expect(stop(proj, shape), policy).toBe("");
      }
    });

    test(`${shape}: a run nobody attends still carries the turn on`, async () => {
      const proj = project();
      await askedInProse(proj);
      expect(stop(proj, shape, { AIDLC_UNATTENDED: "1" })).toContain("AI-DLC is carrying on with Requirements Analysis.");
    });
  }
});

// AI-DLC's first command no longer carries the person's words, so a person who asks only for a command of AI-DLC's
// own over work in hand (a list, a new space, a setting, the configuration, a refused or retired flag) reaches it
// through `next --entry`. Where the work carries on by itself (autonomous Construction, a run nobody attends) that
// command ends the turn as the agent passing it after next did: the engine marks the turn end for a `next` whose
// arguments its own terminal classifier calls terminal, whatever the command's text, and a `next` that hands out
// stage work after it clears the mark.
describe("a command of AI-DLC's own asked over work in hand ends the turn where the work carries on by itself", () => {
  const INVOKE = "bun .claude/tools/aidlc.ts";
  const chat = (unattended: boolean): NodeJS.ProcessEnv =>
    ({ AIDLC_SESSION_OVERRIDE: SESSION, ...(unattended ? { AIDLC_UNATTENDED: "1" } : {}) });

  // The command a print names for the agent to run, its first span that runs AI-DLC's dispatcher, with a placeholder
  // filled as the agent fills it; none when the print says the engine already ran it, or when the span is one the
  // agent would have to fill some other way (`<verb>`).
  function named(output: string): string[] | null {
    let message = "";
    try {
      message = String((JSON.parse(output) as { message?: unknown }).message ?? "");
    } catch {
      return null;
    }
    if (message.includes("` completed.")) return null;
    const span = [...message.matchAll(/`([^`]+)`/g)].map((match) => match[1]).find((text) => text.startsWith(`${INVOKE} `));
    const filled = span?.slice(INVOKE.length + 1).replace("<section>", "runtime");
    return filled === undefined || filled.includes("<") ? null : filled.split(" ");
  }

  // The turn as the agent runs it, with the engine's own results: the first command, then (with no record of their
  // line, unattended) the command the request-file step leaves on the command line, then the command its print
  // names, then anything after it.
  function turn(proj: string, typed: string, unattended: boolean, after: string[][] = []): string {
    const said = engine(proj, ["engine", "hook", "record-human-turn"], JSON.stringify({
      hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt: `/aidlc ${typed}`,
    }), chat(unattended));
    expect(said.status, said.out).toBe(0);
    const calls: Array<{ command: string; output: string }> = [];
    const call = (args: string[]) => {
      const result = engine(proj, args, undefined, chat(unattended));
      calls.push({ command: `${INVOKE} ${args.join(" ")}`, output: result.stdout.trim() || result.out.trim() });
      return result.stdout.trim();
    };
    let out = call(["engine", "orchestrate", "next", "--entry"]);
    if (unattended) out = call(["engine", "orchestrate", "next", ...typed.split(" ")]);
    const then = named(out);
    if (then !== null) call(then);
    for (const args of after) call(args);
    const stamp = { version: "2.1.330" };
    const entries: unknown[] = [{ ...stamp, type: "user", message: { role: "user", content: `/aidlc ${typed}` } }];
    calls.forEach(({ command, output }, i) => {
      entries.push({ ...stamp, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "Bash", input: { command } }] } });
      entries.push({ ...stamp, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: output }] } });
    });
    entries.push({ ...stamp, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Here it is." }] } });
    const path = join(proj, "own-command-transcript.jsonl");
    writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return path;
  }
  function stop(proj: string, transcript: string, unattended: boolean) {
    const result = engine(proj, ["engine", "hook", "continue-workflow"], JSON.stringify({
      hook_event_name: "Stop", stop_hook_active: false, session_id: SESSION, transcript_path: transcript,
    }), { AIDLC_HARNESS_NAME: "claude", ...chat(unattended) });
    expect(result.status, result.out).toBe(0);
    return result.stdout.trim();
  }
  const PLACES = [["attended under autonomous Construction", true, false], ["in a run nobody attends", false, true]] as const;

  const LINES = [
    "intent list", "space list", "space create probe-space", "--statusline", "--init", "--depth bogus", "--config",
    "config set plan-approval off", "intent no-such-intent",
  ];
  for (const line of LINES) {
    for (const [place, autonomous, unattended] of PLACES) {
      test(`/aidlc ${line}, ${place}: the turn ends after it`, () => {
        const proj = project(autonomous);
        expect(stop(proj, turn(proj, line, unattended), unattended)).toBe("");
      });
    }
  }

  // A switch keeps its own stop rule: a switch that only selects (the person asked for it, nothing after) still ends
  // the turn, through `next --entry` as through the switch passed after next.
  for (const [place, autonomous, unattended] of PLACES) {
    test(`/aidlc intent other, ${place}: a switch that only selects ends the turn`, () => {
      const proj = project(autonomous);
      const other = { uuid: "00000000-0000-7000-8000-000000000002", slug: "other", status: "in-flight" };
      const registry = join(intentsDirOf(proj), "intents.json");
      writeFileSync(registry, `${JSON.stringify([...JSON.parse(readFileSync(registry, "utf-8")), other], null, 2)}\n`);
      const record = join(intentsDirOf(proj), `${other.slug}-${other.uuid.replace(/-/g, "").slice(-16)}`);
      mkdirSync(join(record, "audit"), { recursive: true });
      writeFileSync(join(record, "aidlc-state.md"), readFileSync(seededStateFile(proj), "utf-8"));
      expect(stop(proj, turn(proj, "intent other", unattended), unattended)).toBe("");
    });
  }

  // A switch with words after the name hands the agent work for the intent it selects: back to the work in hand, once
  // the next after the switch hands out its stage work, an agent that stops there is carried on.
  for (const [place, autonomous, unattended] of PLACES) {
    test(`/aidlc intent fixture-8000000000000001 with words after it, ${place}: an agent that stops after the stage work is handed out is carried on`, () => {
      const proj = project(autonomous);
      const transcript = turn(proj, "intent fixture-8000000000000001 carry on with the requirements", unattended, [["engine", "orchestrate", "next"]]);
      expect(stop(proj, transcript, unattended)).toContain("AI-DLC is carrying on with");
    });
  }

  for (const [place, autonomous, unattended] of PLACES) {
    test(`/aidlc --status, ${place}, then a next that hands out stage work: an agent that stops there is carried on`, () => {
      const proj = project(autonomous);
      const transcript = turn(proj, "--status", unattended, [["engine", "orchestrate", "next"]]);
      expect(stop(proj, transcript, unattended)).toContain("AI-DLC is carrying on with");
    });
  }
});
