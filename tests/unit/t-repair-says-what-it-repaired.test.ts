// covers: function:approveTarget, function:planQuestion, function:routeCodeGenerationPlanApproval
//
// "I repaired the Testing Contract block. Build your edited plan?" is the truth
// when the person chose "I'll edit the files" and their edit broke the block.
// It was also said to a person who edited nothing: an empty test-instructions
// file, an empty plan, or a contract the agent itself wrote badly all took the
// same repair wording, and all of them claimed an edit of theirs.
//
// These cases drive the real `next`, the real human-turn hook and the real
// `log answer` over one poc workflow at Code Generation:
//
//   - the agent's own missing work (an empty plan or test instructions) is not a
//     repair of their edit: it routes as planning, and the question that follows
//     is the plain one;
//   - a contract the agent broke after their reply is repaired, and the question
//     that follows says nothing about an edit of theirs;
//   - the person's own broken edit keeps today's wording exactly.
//
// Not covered here: a Testing Contract whose hash is valid but whose executable
// fields are unusable. Forging one needs the engine's own body hash, which is
// not exported, so that branch shares its wording with the agent-broken case
// above rather than getting a case of its own.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-000000000091";

interface Emitted {
  kind: string;
  ask_type?: string;
  question?: string;
  plan_approval?: { status?: string; note?: string };
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function project(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(
    seededStateFile(proj),
    readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
      .replace("- **Scope**: feature", "- **Scope**: poc")
      .replace(
        "- **Change Control**: strict (from scope feature)",
        "- **Guard Policy**: off (from scope poc)\n- **Plan Approval**: on (from scope poc)",
      )
      .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation"),
    "utf-8",
  );
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  return proj;
}

function stageDir(proj: string): string {
  return join(seededRecordDir(proj), "construction", "code-generation");
}

const planPath = (proj: string) => join(stageDir(proj), "code-generation-plan.md");
const instructionsPath = (proj: string) => join(stageDir(proj), "unit-test-instructions.md");

function writePlan(proj: string, extra = ""): void {
  mkdirSync(stageDir(proj), { recursive: true });
  writeFileSync(
    planPath(proj),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      `- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n${extra}\n` +
      renderTestingContract(resolveTestingPosture(proj)),
    "utf-8",
  );
  writeFileSync(instructionsPath(proj), "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n", "utf-8");
}

function next(proj: string, args: string[] = []): Emitted {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: { ...process.env, AIDLC_UNATTENDED: "0" } });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as unknown as Emitted;
}

function reply(proj: string, prompt: string): void {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

function answer(proj: string, details: string): { code: number; message: string } {
  const result = spawnSync(BUN, [
    join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
    "--details", details, "--project-dir", proj,
  ], {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  const line = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").find((entry) => entry.startsWith("{"));
  const parsed = line ? JSON.parse(line) as { message?: string; error?: string } : {};
  return { code: result.status ?? -1, message: parsed.message ?? parsed.error ?? `${result.stdout}${result.stderr}` };
}

function auditText(proj: string): string {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf-8")).join("\n");
}

function askFor(proj: string): void {
  writePlan(proj);
  const directive = next(proj);
  expect(directive.kind, JSON.stringify(directive)).toBe("ask");
  expect(directive.ask_type).toBe("plan-approval");
}

/** Nothing the person reads may claim they edited the files. */
function claimsNoEditOfTheirs(text: string, label: string): void {
  expect(text, label).not.toContain("your edited plan");
  expect(text, label).not.toContain("the edit broke");
  expect(text, label).not.toContain("I repaired the Testing Contract block");
}

describe("a repair the person did not cause never claims their edit", () => {
  for (const missing of ["test instructions", "plan"] as const) {
    test(`an empty ${missing} file is the agent's own work: planning, then the plain question`, () => {
      const proj = project();
      askFor(proj);
      // The agent's own file is empty by the time their approval is recorded.
      writeFileSync(missing === "plan" ? planPath(proj) : instructionsPath(proj), "", "utf-8");
      reply(proj, "approve the plan");
      const refused = answer(proj, "Approve Plan");
      expect(refused.message).toContain(missing === "plan" ? "code-generation-plan.md" : "unit-test-instructions.md");
      claimsNoEditOfTheirs(refused.message, "the refusal");
      expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
      // It is planning work, not a repair of an edit of theirs.
      const routed = next(proj);
      expect(routed.kind, JSON.stringify(routed)).toBe("run-stage");
      expect(routed.plan_approval?.status, JSON.stringify(routed)).toBe("plan");
      claimsNoEditOfTheirs(JSON.stringify(routed), "the planning directive");
      // The agent writes the file; the question that follows is the plain one.
      writePlan(proj);
      const asked = next(proj);
      expect(asked.ask_type).toBe("plan-approval");
      expect(asked.question).toBe("Approve the code plan?");
      claimsNoEditOfTheirs(JSON.stringify(asked), "the question");
    });
  }

  test("a contract the agent broke after their reply is repaired, and the question says nothing of their edit", () => {
    const proj = project();
    askFor(proj);
    // Their words open the plan files to the agent, which then breaks the block.
    reply(proj, "approve it, but add a test for empty titles");
    writeFileSync(planPath(proj), readFileSync(planPath(proj), "utf-8").replace('"version": 1', '"version": 1,,'), "utf-8");
    const refused = answer(proj, "Approve Plan");
    expect(refused.message).toContain("Testing Contract");
    claimsNoEditOfTheirs(refused.message, "the refusal");
    const repair = next(proj);
    expect(repair.kind).toBe("run-stage");
    expect(repair.plan_approval?.status).toBe("repair");
    claimsNoEditOfTheirs(JSON.stringify(repair), "the repair directive");
    // The agent re-renders the block; the person is asked the plain question.
    writePlan(proj, "- [ ] Step 2: a test for empty titles\n");
    const asked = next(proj);
    expect(asked.ask_type).toBe("plan-approval");
    expect(asked.question).toBe("Approve the code plan?");
    claimsNoEditOfTheirs(JSON.stringify(asked), "the question");
  });

  // The one case the wording was written for: they chose to edit the files, and
  // their edit broke the block. This must not change.
  test("their own broken edit keeps the wording that names it", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "3");
    expect(next(proj).plan_approval).toMatchObject({ editing: true });
    writeFileSync(planPath(proj), readFileSync(planPath(proj), "utf-8").replace('"version": 1', '"version": 1,,'), "utf-8");
    reply(proj, "done");
    expect(answer(proj, "Approve Plan").message).toContain("broke the Testing Contract block");
    const repair = next(proj);
    expect(repair.plan_approval?.status).toBe("repair");
    writePlan(proj, "- [ ] Step 2: handle unicode\n");
    expect(next(proj).question).toBe("I repaired the Testing Contract block. Build your edited plan?");
  });
});
