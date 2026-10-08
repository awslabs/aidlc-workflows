// covers: function:applyIntentSettings, subcommand:aidlc-utility:intent-create
//
// What a setting's label says about who set it. A check the person asked in
// the chat to turn off is theirs, whoever ran the setter; a setter run with no
// word of theirs behind it says a command set it.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, createTestProject, removeWorkspaceRecord,
} from "../harness/fixtures.ts";
import { getField, hooksHealthDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SESSION = "01995000-7a11-7000-8000-0000000000aa";
const CLEAR = {
  AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_SESSION_OVERRIDE: SESSION,
  AIDLC_UNATTENDED: "0",
};
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

function run(proj: string, tool: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, ...env },
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function reply(proj: string, prompt: string): void {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
  });
  expect(result.status, result.stderr).toBe(0);
}

function stateField(proj: string, name: string): string | null {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const record = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  return getField(readFileSync(join(intents, record, "aidlc-state.md"), "utf-8"), name);
}

function openWork(): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  const made = run(proj, UTILITY, ["intent-create", "--scope", "enterprise", "--arguments", "show the asset description on hover"]);
  expect(made.status, made.out).toBe(0);
  return proj;
}

function emptyProject(): string {
  const proj = createTestProject();
  projects.push(proj);
  removeWorkspaceRecord(proj);
  const health = hooksHealthDir(proj);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
  return proj;
}

describe("t-setting-source-labels: who a setting's label says set it", () => {
  test("a check the person asked in the chat to turn off is theirs", () => {
    const proj = openWork();
    reply(proj, "skip the summary confirmation for this work");
    const off = run(proj, DISPATCHER, ["engine", "config", "set", "summary-confirmation", "off"]);
    expect(off.status, off.out).toBe(0);
    expect(stateField(proj, "Summary Confirmation")).toBe("off (set by you)");
  });

  test("a setter with no word of the person's behind it says a command set it", () => {
    const proj = openWork();
    const on = run(proj, DISPATCHER, ["engine", "config", "set", "learnings", "on"]);
    expect(on.status, on.out).toBe(0);
    expect(stateField(proj, "Learnings")).toBe("on (set by a command)");
  });

  test("the same setting passed by a command alone is a command's", () => {
    const proj = emptyProject();
    const made = run(proj, UTILITY, ["intent-create", "--scope", "enterprise", "--arguments", "build the export", "--learnings", "on"]);
    expect(made.status, made.out).toBe(0);
    expect(stateField(proj, "Learnings")).toBe("on (set by a command)");
  });
});
