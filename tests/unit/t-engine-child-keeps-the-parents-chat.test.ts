// covers: function:readEngineUnitDirective, function:hookChildEnv, function:resolveInvokingSessionId
//
// An engine tool that spawns another engine tool (state's unit route check runs
// `orchestrate next`; orchestrate runs `state` for a report) must hand the child
// the chat it already resolved, as a hook hands its own children the payload
// session. Today the child gets a bare AIDLC_SESSION_OVERRIDE with no provenance
// marker, so it re-resolves: a set override suppresses the host's own variable,
// the marker is missing, and when process ancestry names another chat (a second
// chat started later in the same host process) the child refuses with "Session
// override ... conflicts with the owning conversation". On Codex that is issue
// #2266: `state unit start` for a routed, approved unit refuses while the same
// command from a plain terminal succeeds.
//
// The fixture gives the parent a chat the host names (CODEX_THREAD_ID, the one
// shell variable the resolver reads today) and a PID-map entry on this test
// process naming another chat, which is what the child's ancestry walk finds.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeSessionPidEntry } from "../../dist/codex/.codex/tools/aidlc-lib.ts";
import {
  REPO_ROOT,
  cleanupTestProject,
  createOrchestrationTestProject,
  runOrchestrateNext,
  seedBoltDag,
  seededStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const CODEX_TOOLS = join(REPO_ROOT, "dist", "codex", ".codex", "tools");
const STATE = join(CODEX_TOOLS, "aidlc-state.ts");
const ORCHESTRATE = join(CODEX_TOOLS, "aidlc-orchestrate.ts");
const THIS_CHAT = "01a12051-e539-79b1-b035-e277202dc7e9";
const OTHER_CHAT = "01a12051-f83f-7e91-8a6c-9025a2eb68e2";
const SLUG = "functional-design";

// The t260 Construction fixture: functional-design in flight per unit, the
// skeleton stance on, so `next` routes unit-a and `unit start` has a unit to start.
const CONSTRUCTION_STATE = `# AI-DLC State Tracking

## Project Information
- **Project**: engine child keeps the parent's chat
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on
- **Construction Iteration**: unit-major

## Runtime State
- **Revision Count**: 0

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design — EXECUTE
- [S] nfr-requirements — EXECUTE
- [S] nfr-design — EXECUTE
- [S] infrastructure-design — EXECUTE
- [S] code-generation — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-07-30T00:00:00Z
`;

let proj = "";
afterEach(() => {
  if (proj) cleanupTestProject(proj);
  proj = "";
});

// The agent's shell as Codex gives it: the host names the chat, nothing else does.
function shellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_THREAD_ID: THIS_CHAT };
  delete env.AIDLC_SESSION_OVERRIDE;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}

describe("an engine child keeps the chat its parent resolved", () => {
  test("state unit start routes through orchestrate under a host-named chat while ancestry names another", () => {
    proj = createOrchestrationTestProject();
    writeFileSync(seededStateFile(proj), CONSTRUCTION_STATE, "utf-8");
    seedBoltDag(proj, ["unit-a", "unit-b"]);
    // A second chat started later in the same host process: its SessionStart
    // mapped this process (the tools' ancestor) to its own session.
    writeSessionPidEntry(proj, process.pid, OTHER_CHAT);

    const routed = runOrchestrateNext(ORCHESTRATE, proj, [], { env: shellEnv() });
    expect(routed.out).toContain('"unit":"unit-a"');

    const started = spawnSync(
      process.execPath,
      [STATE, "unit", "start", "--stage", SLUG, "--unit", "unit-a", "--project-dir", proj],
      { encoding: "utf-8", env: shellEnv(), timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) },
    );
    const out = `${started.stdout ?? ""}${started.stderr ?? ""}`;
    expect(out).not.toContain("conflicts with the owning conversation");
    expect(started.status, out).toBe(0);
    expect(out).toContain('"emitted":"UNIT_STARTED"');
  });
});
