// covers: function:applyTypedGuardSwitchPrompt, function:ceremoniesCreationGranted
//
// A setting the person types with their request ("/aidlc --learnings on build
// the export") is theirs: the work it creates says "set by you", not "set by
// a command". The same flag passed by a command with no words of the person's
// behind it still says "set by a command".

import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject, removeWorkspaceRecord, runOrchestrateNext } from "../harness/fixtures.ts";
import { getField, hooksHealthDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SESSION = "01995000-7a11-7000-8000-000000000013";
// The runner's fixture profile carries a presence bypass; clear it so only the
// person's words count.
const CLEAR = {
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_SESSION_OVERRIDE: SESSION,
  AIDLC_UNATTENDED: "0",
};

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

/** No work yet; the person's chat runs AI-DLC's hooks. */
function emptyProject(): string {
  const proj = createTestProject();
  created.push(proj);
  removeWorkspaceRecord(proj);
  const health = hooksHealthDir(proj);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
  return proj;
}

function reply(proj: string, prompt: string): void {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

function utility(proj: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(BUN, [UTILITY, ...args, "--project-dir", proj], {
    cwd: proj,
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj },
    encoding: "utf-8",
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function next(proj: string, args: string[]): { directive: Record<string, unknown> | null; out: string } {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: { ...process.env, ...CLEAR } });
  return { directive: result.directive as Record<string, unknown> | null, out: result.out };
}

function requestIn(message: unknown, out: string): string {
  const id = /--request ([0-9a-f]{8})/.exec(String(message))?.[1];
  if (id === undefined) throw new Error(`no request in ${out}`);
  return id;
}

function intents(proj: string): string {
  return join(proj, "aidlc", "spaces", "default", "intents");
}

function createdField(proj: string, field: string): string | null {
  const record = readFileSync(join(intents(proj), "active-intent"), "utf-8").trim();
  return getField(readFileSync(join(intents(proj), record, "aidlc-state.md"), "utf-8"), field);
}

describe("a setting typed with the request is the person's", () => {
  test.each([
    ["/aidlc --learnings on build the export", "Learnings", "on"],
    ["/aidlc --sensors off build the export", "Sensors", "off"],
  ])("%s: the new work says set by you", (typed, field, value) => {
    const proj = emptyProject();
    reply(proj, typed);
    const flag = `--${field.toLowerCase()}`;
    const asked = next(proj, ["--scope", "feature", flag, value, "--", "build the export"]);
    const id = requestIn(asked.directive?.message, asked.out);
    const made = utility(proj, ["intent-create", "--request", id, flag, value]);
    expect(made.status, made.stderr).toBe(0);
    expect(createdField(proj, field)).toBe(`${value} (set by you)`);
  });

  test("typed before the work is described, it is the person's for the next work", () => {
    const proj = emptyProject();
    reply(proj, "/aidlc --learnings on");
    const asked = next(proj, ["--scope", "feature", "--learnings", "on", "--", "build the export"]);
    const made = utility(proj, ["intent-create", "--request", requestIn(asked.directive?.message, asked.out), "--learnings", "on"]);
    expect(made.status, made.stderr).toBe(0);
    expect(createdField(proj, "Learnings")).toBe("on (set by you)");
  });

  test("beside open work, the new work the person picks says set by you", () => {
    const proj = emptyProject();
    expect(utility(proj, ["intent-create", "--scope", "poc"]).status).toBe(0);
    const health = hooksHealthDir(proj);
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "write-audit-log.last"), new Date().toISOString());
    reply(proj, "/aidlc --learnings on fix the parser");
    const routing = next(proj, ["--learnings", "on", "--", "fix the parser"]);
    const ask = routing.directive as { ask_type?: string; new_intent_command?: string } | null;
    expect(ask?.ask_type, routing.out).toBe("new-work-routing");
    const command = String(ask?.new_intent_command);
    const routed = next(proj, command.slice(command.indexOf(" next ") + 6).split(" "));
    const made = utility(proj, ["intent-create", "--request", requestIn(routed.directive?.message, routed.out), "--learnings", "on"]);
    expect(made.status, made.stderr).toBe(0);
    expect(createdField(proj, "Learnings")).toBe("on (set by you)");
  });
});

describe("a command with no words of the person's behind it", () => {
  test("the same flag at creation says set by a command", () => {
    const proj = emptyProject();
    reply(proj, "build the export");
    const asked = next(proj, ["--scope", "feature", "--learnings", "on", "--", "build the export"]);
    const made = utility(proj, ["intent-create", "--request", requestIn(asked.directive?.message, asked.out), "--learnings", "on"]);
    expect(made.status, made.stderr).toBe(0);
    expect(createdField(proj, "Learnings")).toBe("on (set by a command)");
  });

  test("a different value from the one typed says set by a command", () => {
    const proj = emptyProject();
    reply(proj, "/aidlc --learnings on build the export");
    const asked = next(proj, ["--scope", "feature", "--learnings", "off", "--", "build the export"]);
    const made = utility(proj, ["intent-create", "--request", requestIn(asked.directive?.message, asked.out), "--learnings", "off"]);
    expect(made.status, made.stderr).toBe(0);
    expect(createdField(proj, "Learnings")).toBe("off (set by a command)");
  });

  test("a creation that names no request never takes the typed words", () => {
    const proj = emptyProject();
    reply(proj, "/aidlc --learnings on build the export");
    const made = utility(proj, ["intent-create", "--scope", "feature", "--learnings", "on"]);
    expect(made.status, made.stderr).toBe(0);
    expect(createdField(proj, "Learnings")).toBe("on (set by a command)");
  });
});
