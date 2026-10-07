// covers: function:approveTarget, function:replaceTestingContractSection, function:recordPlanApprovalAnswer
//
// A setting the person changed while the code plan question waited can leave the
// plan's Testing Contract block out of date. That block is engine output, so
// their next "approve the plan" counts: the engine renders the block again,
// records their approval for the plan with the fresh block, and says so in one
// line. They are never asked to approve "the edited plan" they never edited.
//
// A block the person actually broke is different: it fails its own hash, and
// that still goes to the repair path with the question that names it.
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
import {
  renderTestingContract,
  replaceTestingContractSection,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { keepPlanApprovalAskOverStateWrite } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-000000000051";

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

function project(policy: "strict" | "off" = "off"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace(
      "- **Change Control**: strict (from scope feature)",
      `- **Guard Policy**: ${policy} (from scope poc)\n- **Plan Approval**: on (from scope poc)`,
    )
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  return proj;
}

function stageDir(proj: string): string {
  return join(seededRecordDir(proj), "construction", "code-generation");
}

function planPath(proj: string): string {
  return join(stageDir(proj), "code-generation-plan.md");
}

function writePlan(proj: string, body = "- [ ] Step 1: write slugify\n"): void {
  mkdirSync(stageDir(proj), { recursive: true });
  writeFileSync(
    planPath(proj),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      `- Tests: 3 unit tests\n\n## Steps\n\n${body}\n` +
      renderTestingContract(resolveTestingPosture(proj)),
    "utf-8",
  );
  writeFileSync(
    join(stageDir(proj), "unit-test-instructions.md"),
    "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n",
    "utf-8",
  );
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

function planContractHash(proj: string): string {
  return /"contract_sha256":\s*"([^"]+)"/.exec(readFileSync(planPath(proj), "utf-8"))?.[1] ?? "(none)";
}

function askFor(proj: string): void {
  writePlan(proj);
  const directive = next(proj);
  expect(directive.kind, JSON.stringify(directive)).toBe("ask");
  expect(directive.ask_type).toBe("plan-approval");
}

/**
 * A setting the person changed while the plan question waited. The setting write
 * lands in the state file and the question stays open over it, which is the seam
 * the human-turn hook uses when they type a switch
 * (`keepPlanApprovalAskOverStateWrite`). Both of these settings are part of the
 * Testing Posture, so the plan's rendered block goes out of date under it, which
 * is the state block-sweep-2's probe reached through `/aidlc --scope classic`
 * (probes-nb.md row 17).
 */
function settingChanges(proj: string, how: "test-strategy" | "scope"): void {
  const posture = resolveTestingPosture(proj).contract_sha256;
  const path = seededStateFile(proj);
  const before = readFileSync(path, "utf-8");
  writeFileSync(
    path,
    how === "test-strategy"
      ? before.replace(/^- \*\*Test Strategy\*\*:.*$/m, "- **Test Strategy**: Comprehensive")
      : before.replace(/^- \*\*Scope\*\*:.*$/m, "- **Scope**: mvp"),
    "utf-8",
  );
  expect(keepPlanApprovalAskOverStateWrite(proj, before, readFileSync(path, "utf-8")), how).toBe(true);
  // The case is only meaningful if the posture really moved under the plan.
  expect(resolveTestingPosture(proj).contract_sha256, how).not.toBe(posture);
}

describe("a Testing Contract left stale by a setting the person changed", () => {
  for (const how of ["test-strategy", "scope"] as const) {
    test(`${how}: their approve counts, the block is rendered again, and the build starts`, () => {
      const proj = project();
      askFor(proj);
      const asked = planContractHash(proj);
      settingChanges(proj, how);
      // "approve the plan", in their own words; the agent records their choice.
      reply(proj, "approve the plan");
      const recorded = answer(proj, "Approve Plan");
      expect(recorded.code, recorded.message).toBe(0);
      expect(recorded.message).toContain('Recorded "Approve Plan"');
      expect(recorded.message).toContain("Testing Contract was rendered again");
      expect(recorded.message).toContain("the plan's steps are unchanged");
      // Nothing about an edit they never made.
      expect(recorded.message).not.toContain("edited plan");
      expect(recorded.message).not.toContain("Nothing was approved");
      expect(auditText(proj)).toContain("**Event**: PLAN_APPROVAL_RECORDED");
      // The plan now carries the current posture's block, and the build runs.
      expect(planContractHash(proj)).not.toBe(asked);
      expect(planContractHash(proj)).toBe(resolveTestingPosture(proj).contract_sha256);
      expect(readFileSync(planPath(proj), "utf-8")).toContain("- [ ] Step 1: write slugify");
      const build = next(proj);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval).toEqual({ status: "approved" });
      expect(JSON.stringify(build)).not.toContain("I repaired the Testing Contract");
    });
  }

  test("under strict too: the engine's own stale block is never put back to the person", () => {
    const proj = project("strict");
    askFor(proj);
    settingChanges(proj, "test-strategy");
    reply(proj, "approve the plan");
    expect(answer(proj, "Approve Plan").code).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  test("a block the person broke still goes to the repair path, with its own question", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "3");
    expect(next(proj).plan_approval?.status).toBeUndefined();
    writeFileSync(planPath(proj), readFileSync(planPath(proj), "utf-8").replace('"version": 1', '"version": 1,,'), "utf-8");
    reply(proj, "done");
    expect(answer(proj, "Approve Plan").message).toContain("broke the Testing Contract block");
    const repair = next(proj);
    expect(repair.kind).toBe("run-stage");
    expect(repair.plan_approval?.status).toBe("repair");
    writePlan(proj, "- [ ] Step 1: write slugify\n- [ ] Step 2: handle unicode\n");
    expect(next(proj).question).toBe("I repaired the Testing Contract block. Build your edited plan?");
  });

  test("a plan with no Testing Contract section is never approved as it stands", () => {
    const proj = project();
    askFor(proj);
    settingChanges(proj, "test-strategy");
    const plan = readFileSync(planPath(proj), "utf-8");
    writeFileSync(planPath(proj), plan.slice(0, plan.indexOf("## Testing Contract")), "utf-8");
    reply(proj, "approve the plan");
    const refused = answer(proj, "Approve Plan");
    expect(refused.message).toContain("Testing Contract");
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
  });
});

describe("replacing the Testing Contract section", () => {
  test("a heading quoted inside a fenced block is not mistaken for the section", () => {
    const proj = project();
    const posture = resolveTestingPosture(proj);
    const quoted = "# Code Generation Plan\n\n## Steps\n\n- [ ] Step 1: document the block\n\n" +
      "```markdown\n## Testing Contract\n\n(an example of what the engine writes)\n```\n\n" +
      `${renderTestingContract(posture)}`;
    const replaced = replaceTestingContractSection(quoted, posture);
    expect(replaced, "the real section is found").not.toBeNull();
    const text = replaced as string;
    expect(text).toContain("```markdown\n## Testing Contract\n\n(an example of what the engine writes)\n```");
    expect(text.match(/^## Testing Contract$/gm)?.length).toBe(2);
    expect(text).toContain(`"contract_sha256": "${posture.contract_sha256}"`);
    expect(text).toContain("- [ ] Step 1: document the block");
  });

  test("a plan with no section at all is reported as having none", () => {
    const proj = project();
    expect(replaceTestingContractSection("# Plan\n\n## Steps\n\n- [ ] Step 1\n", resolveTestingPosture(proj))).toBeNull();
  });
});
