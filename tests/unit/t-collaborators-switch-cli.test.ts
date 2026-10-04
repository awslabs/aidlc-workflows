// covers: subcommand:aidlc-orchestrate:next
//
// The collaborators switch as the person meets it through the engine: a switch
// typed with the request reaches the work it creates.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  runOrchestrateNext,
  seedAidlcMemory,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");

const projects: string[] = [];
afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop());
});

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  delete env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE;
  delete env.AIDLC_DISABLE_COLLABORATORS;
  return env;
}

function directiveOf(out: string): Record<string, unknown> {
  const line = out.split("\n").find((entry) => entry.trim().startsWith("{"));
  expect(line, out).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

function runNext(proj: string, args: string[]): Record<string, unknown> {
  return directiveOf(runOrchestrateNext(ORCH, proj, args, { cwd: proj, env: childEnv() }).out);
}

// An answer command the engine printed, run the way the agent runs it.
function runEmitted(proj: string, command: string): Record<string, unknown> {
  return runNext(proj, command.slice(command.indexOf(" next ") + 6).split(" "));
}

describe("t-collaborators-cli a switch typed with the request reaches the work", () => {
  test("new work beside active work: every answer carries --collaborators on", () => {
    const proj = createTestProject();
    projects.push(proj);
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const ask = runNext(proj, ["--collaborators", "on", "Fix the login crash when the session expires"]);
    expect(ask.ask_type).toBe("new-work-routing");
    for (const command of [ask.new_intent_command, ask.continue_command, ask.compose_command]) {
      expect(String(command)).toContain("--collaborators on");
    }
    const created = runEmitted(proj, String(ask.new_intent_command));
    expect(created.kind).toBe("print");
    expect(String(created.message)).toContain("intent create --scope bugfix");
    expect(String(created.message)).toContain("--collaborators on");
  });

  test("an empty workspace: the plan offer's go-ahead carries the switch the preview showed", () => {
    const proj = createTestProject();
    projects.push(proj);
    removeWorkspaceRecord(proj);
    const ask = runNext(proj, ["--collaborators", "on", "Fix the login crash when the session expires"]);
    expect(ask.ask_type).toBe("scope-confirm");
    // The preview counts collaborators as on for this work.
    expect(String(ask.question)).not.toContain("collaborators");
    expect(String(ask.confirm_command)).toContain("--collaborators on");
    const created = runEmitted(proj, String(ask.confirm_command));
    expect(created.kind).toBe("print");
    expect(String(created.message)).toContain("--collaborators on");
  });
});
