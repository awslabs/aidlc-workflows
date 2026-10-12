// covers: function:applyIntentSettings, subcommand:aidlc-utility:config-change, audit:CEREMONY_SET
//
// A setting the person asks for in their own words ("lead agent only from
// here") is carried out by the agent with the config setter. The work records
// it as the person's: the state line says "set by you", the CEREMONY_SET row
// names them as its source and carries their words, as the rows for a check
// they turn off already do. The same setter run with no word of theirs behind
// it still says "set by a command".

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject, seedAidlcMemory } from "../harness/fixtures.ts";
import { auditBlockField, getField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SESSION = "01995000-7a11-7000-8000-000000000041";
// The runner's fixture profile carries a presence bypass and may hold a kill
// switch; clear them so only the person's words count.
const CLEAR = {
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_SESSION_OVERRIDE: SESSION,
  AIDLC_UNATTENDED: "0",
  AIDLC_DISABLE_COLLABORATORS: "0",
  AIDLC_DISABLE_SENSORS: "0",
};

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function utility(proj: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(BUN, [UTILITY, ...args, "--project-dir", proj], {
    cwd: proj,
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Work in progress, on the classic plan (every ceremony on from the scope). */
function project(): { proj: string; state: string } {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  const made = utility(proj, ["intent-create", "--scope", "classic", "--arguments", "said by you fixture", "--label", "said-by-you"]);
  expect(made.status, made.stderr).toBe(0);
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  return { proj, state: join(intents, active, "aidlc-state.md") };
}

/** The person types this in their chat; the host's hook records the turn. */
function said(proj: string, prompt: string): void {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

function ceremonyRows(proj: string) {
  return readAuditShardEvents(proj).filter((row) => row.event === "CEREMONY_SET");
}

describe("a setting asked for in plain words is the person's", () => {
  test("lead agent only from here: the agent's setter records collaborators off as set by you, with their words", () => {
    const { proj, state } = project();
    said(proj, "lead agent only from here");
    const set = utility(proj, ["config-change", "--collaborators", "off"]);
    expect(set.status, set.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), "Collaborators")).toBe("off (set by you)");
    const rows = ceremonyRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Key")).toBe("collaborators");
    expect(auditBlockField(rows[0].block, "New")).toBe("off");
    expect(auditBlockField(rows[0].block, "Source")).toBe("you");
    expect(auditBlockField(rows[0].block, "Person Reply")).toBe("lead agent only from here");
    expect(utility(proj, ["status"]).stdout).toContain("Collaborators: off (set by you)\n");
  });

  test("the same setter with no word of the person's behind it still says set by a command", () => {
    const { proj, state } = project();
    const set = utility(proj, ["config-change", "--collaborators", "off"]);
    expect(set.status, set.stderr).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), "Collaborators")).toBe("off (set by a command)");
    const rows = ceremonyRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Source")).toBe("command");
    expect(auditBlockField(rows[0].block, "Person Reply")).toBeNull();
  });

  test("a setting turned back on at their word is theirs too, and an on carries no words", () => {
    const { proj, state } = project();
    said(proj, "no sensors on this one");
    expect(utility(proj, ["config-change", "--sensors", "off"]).status).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), "Sensors")).toBe("off (set by you)");
    said(proj, "bring the sensors back");
    expect(utility(proj, ["config-change", "--sensors", "on"]).status).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), "Sensors")).toBe("on (set by you)");
    const rows = ceremonyRows(proj);
    expect(rows).toHaveLength(2);
    expect(auditBlockField(rows[0].block, "Person Reply")).toBe("no sensors on this one");
    expect(auditBlockField(rows[1].block, "Source")).toBe("you");
    expect(auditBlockField(rows[1].block, "Person Reply")).toBeNull();
  });

  test("the way back the agent runs after an off they asked for is the command's, not theirs", () => {
    const { proj, state } = project();
    said(proj, "lead agent only from here");
    expect(utility(proj, ["config-change", "--collaborators", "off"]).status).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), "Collaborators")).toBe("off (set by you)");
    // No new word from the person: their turn stands behind the off, not behind this.
    expect(utility(proj, ["config-change", "--collaborators", "on"]).status).toBe(0);
    expect(getField(readFileSync(state, "utf-8"), "Collaborators")).toBe("on (set by a command)");
    const rows = ceremonyRows(proj);
    expect(rows).toHaveLength(2);
    expect(auditBlockField(rows[1].block, "Source")).toBe("command");
    expect(auditBlockField(rows[1].block, "Person Reply")).toBeNull();
  });
});
