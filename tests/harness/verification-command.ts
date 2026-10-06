// The person's one approval of a Construction Verification Command, recorded
// the way the consent procedure does it: the decision, the person's turn, the
// answer, then the state field. Swarm check and finalize run only that command,
// with or without Construction checkpoints.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  readActiveDirectiveMarker,
  readAuditShardEvents,
  stateDigest,
  stateFilePath,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC } from "./fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";

// The command each project's person approved last: a new approval replaces it.
const current = new Map<string, string>();
let sessions = 0;

function run(projectDir: string, args: string[], input?: string): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, args, {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: projectDir,
    encoding: "utf-8",
    input,
    env: { ...process.env, AIDLC_PROJECT_DIR: projectDir, CLAUDE_PROJECT_DIR: projectDir },
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function approveVerificationCommand(projectDir: string, command: string, stage = "code-generation"): void {
  if (current.get(projectDir) === command) return;
  // The consent records belong to a started workflow; a fixture that wrote its
  // state by hand gets the start row it would have had.
  if (!readAuditShardEvents(projectDir).some((row) => row.event === "WORKFLOW_STARTED")) {
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, projectDir);
  }
  // Recording the command changes the state, so a directive the fixture issued
  // for the old state is issued again for the new one, as the engine would.
  const before = readFileSync(stateFilePath(projectDir), "utf-8");
  const marker = readActiveDirectiveMarker(projectDir, before);
  const tools = join(AIDLC_SRC, "tools");
  const session = `verification-command-${++sessions}`;
  const identity = ["--stage", stage, "--checkpoint", "verification-command", "--command", command, "--session", session];
  const steps: Array<[string[], string | undefined]> = [
    [[join(tools, "aidlc-log.ts"), "decision", ...identity,
      "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes",
      "--project-dir", projectDir], undefined],
    [[join(tools, "aidlc.ts"), "engine", "hook", "record-human-turn"],
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "Approve" })],
    [[join(tools, "aidlc-log.ts"), "answer", ...identity, "--details", "Approve", "--project-dir", projectDir], undefined],
    [[join(tools, "aidlc-state.ts"), "set-construction-verification-command", command, "--project-dir", projectDir], undefined],
  ];
  for (const [args, input] of steps) {
    const result = run(projectDir, args, input);
    if (result.status !== 0) throw new Error(`approving the verification command failed at ${args[1]}: ${result.out}`);
  }
  if (marker !== null) {
    writeActiveDirectiveMarker(projectDir, {
      ...marker,
      state_sha256: stateDigest(readFileSync(stateFilePath(projectDir), "utf-8")),
    } as Parameters<typeof writeActiveDirectiveMarker>[1]);
  }
  current.set(projectDir, command);
}

// The command a swarm call supplies, approved by the person first.
export function approveSuppliedCheckCommand(projectDir: string, args: readonly string[]): void {
  const index = args.indexOf("--check-cmd");
  if (index !== -1 && args[index + 1] !== undefined) approveVerificationCommand(projectDir, args[index + 1]);
}
