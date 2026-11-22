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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setGuardPolicyLine } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, seededStateFile, setupIntegrationProject } from "../harness/fixtures.ts";

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
