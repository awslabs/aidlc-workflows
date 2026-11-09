// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-swarm:prepare
//
// A side-by-side batch says whether its verification command is authorized, so
// Kiro's conductor asks for it before the workers start: asked after them, the
// answer starts a new chat turn between the workers and their reviewers, and
// Kiro CLI asks again for subagent requests the person had approved for all.
// Asked first, each worker's brief names the approved test command.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  CHECK, cleanupCheckpointFixtures, fixture, nextDirective, prepare, recordCommand, runCheckpointTool,
} from "../harness/swarm-checkpoint.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

const UNITS = ["alpha", "beta"];
const TREES = ["dist", "dist-release"];

function swarmProtocol(tree: string, harness: string, dir: string): string {
  return readFileSync(join(REPO_ROOT, tree, harness, dir, "aidlc-common", "protocols", "stage-protocol-swarm.md"), "utf-8");
}

describe("a side-by-side batch says whether its verification command is authorized", () => {
  test("no command: false; once the person approves one: true, and each worker's brief names it", () => {
    const pd = fixture(UNITS, null);
    expect(nextDirective(pd)).toMatchObject({
      kind: "invoke-swarm", plan_approval: { status: "approved" }, verification_command_authorized: false,
    });

    recordCommand(pd, CHECK);
    expect(nextDirective(pd)).toMatchObject({
      kind: "invoke-swarm", plan_approval: { status: "approved" }, verification_command_authorized: true,
    });

    const prepared = prepare(pd, UNITS);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    for (const unit of UNITS) {
      const brief = runCheckpointTool(pd, "tools/aidlc-testing-posture.ts", ["brief", "--unit", unit]);
      expect(brief.code, `${brief.out}\n${brief.err}`).toBe(0);
      expect(brief.out).toContain(`To run the tests the person approved (\`${CHECK}\`)`);
    }
  });

  test("an authorized command from Delivery Planning: true from the first batch step", () => {
    const pd = fixture(UNITS, CHECK);
    expect(nextDirective(pd)).toMatchObject({ kind: "invoke-swarm", verification_command_authorized: true });
  });

  test("an intent with one recorded repository carries it too", () => {
    const pd = fixture(UNITS, null, false, "repo-a");
    expect(nextDirective(pd)).toMatchObject({ kind: "invoke-swarm", repo: "repo-a", verification_command_authorized: false });
  });
});

describe("Kiro's conductor asks for the command before the workers start", () => {
  test("Kiro's swarm binding asks before prepare; no other harness's binding names the field", () => {
    for (const tree of TREES) {
      const kiro = swarmProtocol(tree, "kiro-ide", ".kiro");
      const ask = kiro.indexOf("When `directive.verification_command_authorized` is `false`");
      expect(ask, tree).toBeGreaterThan(-1);
      expect(ask, tree).toBeLessThan(kiro.indexOf("(1) **`prepare`**"));
      const step = kiro.slice(ask, kiro.indexOf("(1) **`prepare`**"));
      for (const words of [
        "`directive.plan_approval.status` is `approved`", "verification-command procedure", "`next` still returns `false`",
        "person approved a command", "initial `prepare`", "run the setter without asking again",
      ]) {
        expect(step, tree).toContain(words);
      }
      for (const [harness, dir] of [
        ["claude", ".claude"], ["kiro", ".kiro"], ["codex", ".codex"], ["cursor", ".cursor"], ["opencode", ".aidlc"],
        ["copilot", ".aidlc"],
      ]) {
        expect(swarmProtocol(tree, harness, dir), `${tree} ${harness}`).not.toContain("verification_command_authorized");
      }
    }
  });
});
