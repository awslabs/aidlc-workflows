// covers: subcommand:aidlc-state:set-construction-verification-command, function:keepActiveDirectiveOverSettingWrite,
// subcommand:aidlc-swarm:prepare, subcommand:aidlc-orchestrate:next
//
// With no Delivery Planning the side-by-side build asks for the verification
// command after `prepare`. The person's answer sets how each Unit is checked;
// it is no new plan, so the build they approved goes on: `next` does not ask
// the code plan question again, and each worktree may still build.

import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  CHECK, cleanupCheckpointFixtures, fixture, nextDirective, prepare, recordCommand, runCheckpointTool, wt,
} from "../harness/swarm-checkpoint.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

const UNITS = ["alpha", "beta"];

test("the verification command approved after prepare keeps the approved build and its worktrees", () => {
  const pd = fixture(UNITS, null);
  expect(nextDirective(pd)).toMatchObject({ kind: "invoke-swarm", plan_approval: { status: "approved" } });
  const prepared = prepare(pd, UNITS);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);

  recordCommand(pd, CHECK);

  expect(nextDirective(pd)).toMatchObject({ kind: "invoke-swarm", plan_approval: { status: "approved" } });
  for (const unit of UNITS) {
    const questions = readFileSync(join(codeGenerationRecordDir(pd, unit), "code-generation-questions.md"), "utf-8");
    expect(questions).toContain("[Answer]: Approve Plan");
    const worker = wt(pd, unit);
    const verified = runCheckpointTool(worker, "tools/aidlc-testing-posture.ts", ["verify", "--unit", unit, "--project-dir", worker]);
    expect(verified.code, verified.out).toBe(0);
    expect(JSON.parse(verified.out)).toMatchObject({ ok: true, execution_allowed: true });
  }
});
