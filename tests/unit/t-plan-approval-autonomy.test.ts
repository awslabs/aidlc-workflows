// covers: cli:aidlc-bolt(set-autonomy), function:personSpokeSinceGate, function:keepActiveDirectiveOverAutonomyWrite
//
// "Approve the plan, and run Construction on its own from here": one message
// asks for both, so both are carried out in whichever order the agent runs
// them, under every Guard Policy, and the plan is never asked again. The plan
// stays the person's to approve: running on its own approves no plan.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const SESSION = "01995000-7a11-7000-8000-000000000001";

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

// The person's checks as a shipped run has them: no presence bypass.
function attended(proj: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  return env;
}

// Code Generation with the code plan written, plan approval on, and the
// installed tools in the project, as a conductor runs them.
function project(policy: "strict" | "relaxed" | "off"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace(
      "- **Change Control**: strict (from scope feature)",
      `- **Guard Policy**: ${policy} (from scope poc)\n- **Plan Approval**: on (set by you)`,
    )
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  cpSync(join(AIDLC_SRC, "tools"), join(proj, ".claude", "tools"), { recursive: true });
  const dir = join(seededRecordDir(proj), "construction", "code-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      "- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n" +
      renderTestingContract(resolveTestingPosture(proj)),
    "utf-8",
  );
  writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n", "utf-8");
  return proj;
}

// `next`, then every rule part, to the directive after them.
function next(proj: string): Record<string, unknown> {
  const result = runOrchestrateNext(ORCHESTRATE, proj, [], { env: attended(proj) });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as Record<string, unknown>;
}

function reply(proj: string, prompt: string): void {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: attended(proj),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

// The plan-approval hook's verdict on a shell command, then the command as the
// conductor runs it from the project.
function guardedRun(proj: string, command: string, argv: string[]): { code: number; out: string } {
  const hook = spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: SESSION, cwd: proj, tool_name: "Bash", tool_input: { command },
    }),
    env: attended(proj),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(hook.status, `${command}\n${hook.stderr}`).toBe(0);
  const result = spawnSync(BUN, argv, {
    cwd: proj,
    env: attended(proj),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function auditText(proj: string): string {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf-8")).join("\n");
}

const APPROVE = [".claude/tools/aidlc.ts", "engine", "log", "answer", "--stage", "code-generation",
  "--checkpoint", "plan-approval", "--details", "Approve Plan"];
const SWITCH = [".claude/tools/aidlc.ts", "engine", "bolt", "set-autonomy", "--mode", "autonomous"];
const spelled = (argv: string[]): string =>
  `bun ${argv.map((arg) => (arg.includes(" ") ? `'${arg}'` : arg)).join(" ")}`;

describe("approve the plan and run Construction on its own, in one message", () => {
  test.each([
    ["off", "approve first"],
    ["off", "switch first"],
    ["relaxed", "approve first"],
    ["relaxed", "switch first"],
    ["strict", "approve first"],
    ["strict", "switch first"],
    // The approval's own line says "Run next.", so the agent may build first.
    ["off", "approve, next, then switch"],
    ["strict", "approve, next, then switch"],
  ] as const)("Guard Policy %s, %s: both are done and the plan is built as approved", (policy, order) => {
    const proj = project(policy);
    const asked = next(proj);
    expect(asked, JSON.stringify(asked)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    reply(proj, "Approve the plan, and run Construction on its own from here.");
    const steps = order === "approve first" ? ["approve", "switch"]
      : order === "switch first" ? ["switch", "approve"] : ["approve", "next", "switch"];
    for (const step of steps) {
      if (step === "next") {
        expect(next(proj).kind).not.toBe("ask");
        continue;
      }
      const argv = step === "approve" ? APPROVE : SWITCH;
      const ran = guardedRun(proj, spelled(argv), argv);
      expect(ran.code, ran.out).toBe(0);
      if (step === "approve") expect(ran.out).toContain('"recorded":"approve"');
    }
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain("- **Construction Autonomy Mode**: autonomous");
    let build = next(proj);
    for (let part = 0; build.kind === "load-steering" && part < 10; part++) build = next(proj);
    expect(build.kind, JSON.stringify(build)).toBe("run-stage");
    expect(build.stage).toBe("code-generation");
    expect(auditText(proj).match(/\*\*Event\*\*: PLAN_APPROVAL_RECORDED/g)).toHaveLength(1);
  });

  // The plan is the person's: a grant on its own never approves it.
  test("running on its own approves no plan: the plan question is still the open step", () => {
    const proj = project("off");
    next(proj);
    reply(proj, "Run Construction on its own from here.");
    const ran = guardedRun(proj, spelled(SWITCH), SWITCH);
    expect(ran.code, ran.out).toBe(0);
    const still = next(proj);
    expect(still, JSON.stringify(still)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    expect(auditText(proj)).not.toContain("**Event**: PLAN_APPROVAL_RECORDED");
  });
});
