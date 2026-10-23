// covers: function:evaluateCodeGenerationApproval, subcommand:aidlc-log:answer
//
// Whether a code plan is approved is the engine's own receipt's to say: a line the person writes on the questions
// file's `[Answer]:` line ("Approve Plan", as the file invites) is their reply for the agent to read and record,
// never approval by itself. With plan approval off the plan still builds without asking, under every Guard Policy.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  readActiveDirectiveMarker,
  setGuardPolicyLine,
  stateDigest,
  writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  evaluateCodeGenerationApproval,
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { env, exec, projectAt, say, templateProjects } from "../harness/aidlc-answers-corpus.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const POLICIES = ["off", "relaxed", "strict"] as const;
type Policy = (typeof POLICIES)[number];

const projects: string[] = [];
afterAll(() => {
  for (const proj of [...projects, ...templateProjects()]) cleanupTestProject(proj);
});

const questionsFile = (proj: string): string =>
  join(seededRecordDir(proj), "construction", "code-generation", "code-generation-questions.md");

// The code plan question open, under the policy; its marker bound again to the state with the policy line set.
async function planQuestionAt(policy: Policy): Promise<string> {
  const proj = await projectAt("code-plan");
  projects.push(proj);
  const file = seededStateFile(proj);
  const before = readFileSync(file, "utf-8");
  const marker = readActiveDirectiveMarker(proj, before);
  const after = setGuardPolicyLine(before, `${policy} (set by you)`);
  writeFileSync(file, after);
  if (marker !== null) {
    writeActiveDirectiveMarker(proj, { ...marker, state_sha256: stateDigest(after) } as Parameters<typeof writeActiveDirectiveMarker>[1]);
  }
  return proj;
}

// A ready plan on poc, where plan approval ships off, under the policy.
function planApprovalOffAt(policy: Policy): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace("- **Change Control**: strict (from scope feature)",
      `- **Guard Policy**: ${policy} (set by you)\n- **Plan Approval**: off (from scope poc)`)
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  const dir = join(seededRecordDir(proj), "construction", "code-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      "- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n" + renderTestingContract(resolveTestingPosture(proj)),
    "utf-8");
  writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test`.\n", "utf-8");
  return proj;
}

describe("t-plan-approval-receipt-decides: the engine's receipt, not the file's answer line, approves a code plan", () => {
  for (const policy of POLICIES) {
    test(`${policy}: "Approve Plan" written on the answer line approves nothing until the agent records it`, async () => {
      const proj = await planQuestionAt(policy);
      const file = questionsFile(proj);
      writeFileSync(file, readFileSync(file, "utf-8").replace(/^\[Answer\]:[ \t]*$/m, "[Answer]: Approve Plan"));
      expect(evaluateCodeGenerationApproval(proj, { unit: null }).approved).toBe(false);
      expect((await say(proj, "I wrote my answer in the file", "claude")).status).toBe(0);
      const recorded = await exec(
        [process.execPath, LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
          "--details", "Approve Plan", "--project-dir", proj],
        { cwd: proj, env: env(proj) },
      );
      expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
      const approval = evaluateCodeGenerationApproval(proj, { unit: null });
      expect(approval.approved).toBe(true);
      expect(approval.ok, approval.reason).toBe(true);
    });

    test(`${policy}: with plan approval off, a ready plan builds without asking`, () => {
      const proj = planApprovalOffAt(policy);
      const build = runOrchestrateNext(ORCHESTRATE, proj, [], {
        env: { ...process.env, AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0", AIDLC_UNATTENDED: "0" },
      });
      expect(build.status, build.out).toBe(0);
      const directive = build.directive as unknown as { kind: string; plan_approval?: { status?: string; skipped?: boolean } };
      expect(directive.kind, build.out).toBe("run-stage");
      expect(directive.plan_approval?.status).toBe("approved");
      expect(directive.plan_approval?.skipped).toBe(true);
      const approval = evaluateCodeGenerationApproval(proj, { unit: null });
      expect(approval.ok, approval.reason).toBe(true);
      expect(approval.approved).toBe(true);
    });
  }
});
