// covers: subcommand:aidlc-orchestrate:next
//
// In a checkout scoped to a team Unit, the guard's recovery question offers
// "Start the stage over" for one of the Unit's steps. Picked, `next --stage`
// carries it out with the Unit's own reopen (`jump reopen --target <stage>
// --stages <the stage and every later per-Unit stage> --units <this Unit>`), the
// one jump a scoped checkout makes. The plan-approval guard admitted the picked
// restart only in the `jump execute` spelling, so it refused that reopen, and the
// person's own "reopen it" too while the recovery question stood: the Unit could
// not be restarted from its checkout at all.
// The picked restart now passes in the scoped spelling, for exactly that stage,
// its later per-Unit stages, and this checkout's Unit.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, seededStateFile } from "../harness/fixtures.ts";
import {
  ORCH,
  cleanupTempDirs,
  makeSeed,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";
import {
  GUARD_RECOVERY_ASK_TYPE,
  readActiveDirectiveMarker,
  readStateFile,
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const BUN = process.execPath;
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const LATER = "functional-design,nfr-requirements,nfr-design,infrastructure-design,code-generation";

function guard(checkout: string, command: string): { code: number; stderr: string } {
  const run = spawnSync(BUN, [GUARD], {
    cwd: checkout,
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: checkout, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
  });
  return { code: run.status ?? -1, stderr: run.stderr ?? "" };
}

function personSays(checkout: string, prompt: string): void {
  const run = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: checkout,
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "01995000-0265-7000-8000-000000000016",
      prompt,
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: checkout, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
  });
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
}

// The person picks the restart, and the agent records the pick it read, as at
// any engine question (a typed reply alone picks no remedy).
function personPicksRestart(checkout: string): void {
  personSays(checkout, "Start the stage over");
  const run = spawnSync(BUN, [
    join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "functional-design", "--unit", "alpha",
    "--checkpoint", "guard-recovery", "--details", "Start the stage over",
  ], {
    cwd: checkout,
    env: {
      ...process.env, CLAUDE_PROJECT_DIR: checkout, AIDLC_UNATTENDED: "0",
      AIDLC_SESSION_OVERRIDE: "01995000-0265-7000-8000-000000000016",
    },
    encoding: "utf-8",
  });
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
}

// The recovery question the guard puts after a refused gate for the Unit's
// Functional Design, its one runnable answer the stage restart.
function askRestart(checkout: string, unit: string): void {
  writeActiveDirectiveMarker(checkout, {
    kind: "ask",
    ask_type: GUARD_RECOVERY_ASK_TYPE,
    stage: "functional-design",
    unit,
    state_sha256: stateDigest(readStateFile(checkout)),
    remedies: [{
      op: "redo-jump",
      label: "Start the stage over",
      action: "Restart the stage from the top with /aidlc --stage functional-design.",
      interaction: "command",
      operation: { kind: "restart-stage", stage: "functional-design" },
    }],
  });
}

// A Unit whose every step is done, its walk on Code Generation, the one stage the
// plan-approval guard watches.
function claimedCheckout(): string {
  const { remote } = makeSeed();
  const { checkout } = prepareCandidate(remote, "alpha", "alpha-team");
  const statePath = seededStateFile(checkout);
  let state = readFileSync(statePath, "utf-8").replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: code-generation");
  for (const stage of LATER.split(",")) {
    state = state.replace(new RegExp(`^- \\[.\\] ${stage} — EXECUTE$`, "m"), `- [-] ${stage} — EXECUTE`);
  }
  writeFileSync(statePath, state);
  return checkout;
}

// What `next --stage functional-design --unit alpha` tells the conductor to run.
function printedReopen(checkout: string): string {
  const next = runMergeTool(ORCH, ["next", "--stage", "functional-design", "--unit", "alpha"], checkout);
  expect(next.status, next.out).toBe(0);
  const message = String(JSON.parse(next.stdout).message ?? "");
  const command = /`([^`]* reopen --target functional-design [^`]*)`/.exec(message)?.[1];
  expect(command, message).toBeDefined();
  // As an installed engine runs it (the fixture prints the source tool's spelling).
  return command!.replace(/^bun \S*aidlc-jump\.ts /, "aidlc engine jump ");
}

describe("t-team-unit-guard-restart: a Unit's picked restart runs from its checkout", () => {
  test("the restart picked at the recovery question passes as the Unit's reopen", () => {
    const checkout = claimedCheckout();
    askRestart(checkout, "alpha");
    personPicksRestart(checkout);
    const marker = readActiveDirectiveMarker(checkout, readStateFile(checkout));
    expect(marker?.guard_recovery_response).toMatchObject({ selected_op: "redo-jump", status: "ready" });
    const command = printedReopen(checkout);
    expect(command).toContain(`--stages ${LATER} --units alpha`);
    const admitted = guard(checkout, command);
    expect(admitted.code, admitted.stderr).toBe(0);
  });

  test("it admits no other Unit, stage list, target or extra flag", () => {
    const checkout = claimedCheckout();
    askRestart(checkout, "alpha");
    personPicksRestart(checkout);
    const command = printedReopen(checkout);
    for (const changed of [
      command.replace("--units alpha", "--units beta"),
      command.replace("--units alpha", "--units alpha,beta"),
      command.replace(`--stages ${LATER}`, "--stages functional-design"),
      command.replace(`--stages ${LATER}`, `--stages ${LATER.replace("functional-design,", "")}`),
      command.replace("--target functional-design", "--target nfr-design"),
      `${command} --via change`,
      `${command}; true`,
    ]) {
      expect(guard(checkout, changed).code, changed).toBe(2);
    }
  });

  test("before the person picks, the reopen still waits", () => {
    const checkout = claimedCheckout();
    askRestart(checkout, "alpha");
    const command = printedReopen(checkout);
    expect(guard(checkout, command).code).toBe(2);
  });
});
