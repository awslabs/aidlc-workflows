// covers: function:planWaitAdmits, function:everyHelperMayRun
//
// New work the person asks for while a code plan waits runs: only the waiting
// plan's build waits (NB-5, live on Kiro IDE). The cases drive the real `next`,
// the real human-turn hook, and the real plan-approval guard over one poc
// workflow whose code plan question is open, under Guard Policy strict and
// off:
//
//   - the person types `/aidlc --new-intent ...` and picks the tailored plan;
//     the engine names the composer, and the composer's own AI-DLC commands
//     (the workspace scan, the scoring, the grid check, a setting read) go
//     through in every spelling, as does the conductor's creation step;
//   - the same while the step the engine issued last is out of date, the state
//     the Kiro IDE run was in (the composer's refusal there named `next`);
//   - the waiting plan's build still waits: its files, a shell write to them,
//     and the developer;
//   - a helper's refusal names no routing step it cannot run, and the composer
//     hands any refusal that names one back to the main session.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { composerProposalPath, writeActiveDirectiveMarker } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(240_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const SESSION = "01995000-7a11-7000-8000-0000000005b5";
const COMPOSER = "aidlc-composer-agent";
const NEW_WORK = "add a --json output option to the quote tool";

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

// A poc workflow at Code Generation with plan approval turned on by the
// person, and the installed tools in the project, so the guard reads
// `bun .claude/tools/...` as the engine.
function project(policy: "strict" | "off"): string {
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
  return proj;
}

function stageDir(proj: string): string {
  return join(seededRecordDir(proj), "construction", "code-generation");
}

function writePlan(proj: string): void {
  mkdirSync(stageDir(proj), { recursive: true });
  writeFileSync(
    join(stageDir(proj), "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      "- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n" +
      renderTestingContract(resolveTestingPosture(proj)),
    "utf-8",
  );
  writeFileSync(
    join(stageDir(proj), "unit-test-instructions.md"),
    "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n",
    "utf-8",
  );
}

interface Emitted {
  kind: string;
  ask_type?: string;
  message?: string;
  compose_command?: string;
}

function next(proj: string, args: string[] = []): Emitted {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, {
    env: { ...process.env, AIDLC_UNATTENDED: "0" },
  });
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

// The guard as a harness runs it. `extra` adds what a harness puts beside the
// tool call: the helper that made it (`agent_type`, as Claude Code and Codex
// name one), or the PowerShell reading Kiro IDE asks for on Windows.
function guard(
  proj: string,
  tool: string,
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  // The hook command the Claude Code settings register: the dispatcher runs
  // the guard in its own process.
  viaDispatcher = false,
): { code: number; stderr: string } {
  const result = spawnSync(BUN, viaDispatcher ? [DISPATCHER, "engine", "hook", "plan-approval-guard"] : [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: proj,
      tool_name: tool,
      tool_input: input,
      ...extra,
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

const shell = (proj: string, command: string, extra: Record<string, unknown> = {}) =>
  guard(proj, "Bash", { command }, extra);
const write = (proj: string, path: string, extra: Record<string, unknown> = {}) =>
  guard(proj, "Write", { file_path: path, content: "x\n" }, extra);

// The step the engine issued last, for a failure message.
function issuedStep(proj: string): string {
  const path = join(seededRecordDir(proj), ".aidlc-engine", "active-directive.json");
  return existsSync(path) ? readFileSync(path, "utf-8") : "(no issued step)";
}

// The person asks for new work while the plan question is open and picks the
// tailored plan; the engine names the composer. Returns the request id.
function composeNewWork(proj: string): string {
  writePlan(proj);
  const ask = next(proj);
  expect(ask, JSON.stringify(ask)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  reply(proj, `/aidlc --new-intent ${NEW_WORK}`);
  const offer = next(proj, ["--new-intent", NEW_WORK]);
  const request = /--request (\S+)/.exec(offer.compose_command ?? "")?.[1];
  expect(request, JSON.stringify(offer)).toBeDefined();
  // The conductor runs the compose step it was given.
  const compose = shell(proj, offer.compose_command as string);
  expect(compose.code, compose.stderr).toBe(0);
  reply(proj, "compose");
  const dispatch = next(proj, ["compose", "--request", request as string]);
  expect(dispatch.kind, JSON.stringify(dispatch)).toBe("print");
  expect(dispatch.message).toContain("Dispatch the composer agent");
  return request as string;
}

// The composer's own AI-DLC commands (core/agents/aidlc-composer-agent.md),
// in the spellings an install runs them: the copy channel's dispatcher, a tool
// script of its own, and the native command.
const COMPOSER_COMMANDS = [
  "bun .claude/tools/aidlc.ts engine workspace detect --json",
  "bun .claude/tools/aidlc.ts engine graph ars --iae 0.2 --csu 0.3 --ve 0.2 --r 0.1 --ua 0.1 --project-type brownfield",
  "bun .claude/tools/aidlc.ts engine graph validate-grid --project-type brownfield",
  "bun .claude/tools/aidlc.ts engine config get sensors",
  "bun .claude/tools/aidlc-utility.ts detect --json",
  "bun .claude/tools/aidlc-graph.ts validate-grid --project-type brownfield",
  "aidlc engine workspace detect --json",
  "aidlc engine graph validate-grid --project-type brownfield",
];

function composerRuns(proj: string): void {
  for (const helper of [{}, { agent_type: COMPOSER }]) {
    for (const command of COMPOSER_COMMANDS) {
      const verdict = shell(proj, command, helper);
      expect(verdict.code, `${command} ${JSON.stringify(helper)}\n${verdict.stderr}\n${issuedStep(proj)}`).toBe(0);
    }
    // Kiro IDE on Windows runs the scan in PowerShell.
    const scan = shell(proj, "bun .claude/tools/aidlc.ts engine workspace detect --json", {
      ...helper,
      aidlc_shell: "powershell",
    });
    expect(scan.code, `${scan.stderr}\n${issuedStep(proj)}`).toBe(0);
    // The one file it writes, which validate-grid reads.
    expect(write(proj, composerProposalPath(proj), helper).code).toBe(0);
  }
  const hooked = guard(proj, "Bash", { command: COMPOSER_COMMANDS[0] }, {}, true);
  expect(hooked.code, hooked.stderr).toBe(0);
  expect(guard(proj, "Write", { file_path: join(proj, "src", "slugify.ts"), content: "x\n" }, {}, true).code).toBe(2);
}

// The waiting plan's build: the file it names, a shell write to it, and the developer.
function buildWaits(proj: string): void {
  expect(write(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
  expect(shell(proj, "echo 'export const s = 1;' > src/slugify.ts").code).toBe(2);
  const developer = guard(proj, "Task", {
    subagent_type: "aidlc-developer-agent",
    prompt: `AIDLC-STAGE: code-generation\nAIDLC-TESTING-CONTRACT: ${resolveTestingPosture(proj).contract_sha256}\nBuild it.`,
  });
  expect(developer.code).toBe(2);
  // A helper that writes it is refused too. Whatever step the refusal names
  // is the main session's: the composer hands it back (its Boundaries, pinned
  // below), since a helper cannot run `next`.
  const helperWrite = write(proj, join(proj, "src", "slugify.ts"), { agent_type: COMPOSER });
  expect(helperWrite.code).toBe(2);
}

describe("while a code plan waits, new work the person asks for is composed", () => {
  for (const policy of ["strict", "off"] as const) {
    test(`the composer's commands and the new work's creation run; the old plan's build waits (Guard Policy ${policy})`, () => {
      const proj = project(policy);
      const request = composeNewWork(proj);
      composerRuns(proj);
      buildWaits(proj);
      // The person approves the composed plan: the conductor creates the new
      // work with the commands the engine names for it.
      reply(proj, "yes, use that plan for the json work");
      const creation = next(proj, ["--scope", "poc", "--request", request]);
      const commands = [...(creation.message ?? "").matchAll(/`((?:bun|aidlc) [^`]*)`/g)]
        .map((match) => match[1].replace(/"<[^"]*>"/g, "json-output"))
        .filter((command) => !/ next$/.test(command));
      expect(commands.length, JSON.stringify(creation)).toBeGreaterThan(0);
      for (const command of commands) {
        const verdict = shell(proj, command);
        expect(verdict.code, `${command}\n${verdict.stderr}\n${issuedStep(proj)}`).toBe(0);
      }
    });

    test(`the composer's commands run while the step the engine issued is out of date (Guard Policy ${policy})`, () => {
      const proj = project(policy);
      composeNewWork(proj);
      // The issued step names a state that has changed since: the guard
      // holds no current step, as in the Kiro IDE run.
      writeActiveDirectiveMarker(proj, {
        kind: "ask",
        stage: "code-generation",
        ask_type: "plan-approval",
        state_sha256: "0".repeat(64),
      });
      expect(shell(proj, "printf x > src/other.ts").stderr).toContain("no matching v2 code-generation active directive");
      composerRuns(proj);
      expect(write(proj, join(proj, "src", "slugify.ts")).code).toBe(2);
      expect(shell(proj, "echo 'export const s = 1;' > src/slugify.ts").code).toBe(2);
    });
  }

  // Where the harness cannot say which helper made a call (Kiro IDE), the
  // composer reads a refusal that names a routing step as the main session's.
  test("the composer hands a refusal that names a routing step back to the main session", () => {
    const agent = readFileSync(join(AIDLC_SRC, "agents", `${COMPOSER}.md`), "utf-8");
    const boundaries = agent.slice(agent.indexOf("## Boundaries")).replace(/\s+/g, " ");
    expect(boundaries).toContain("that step is the main session's");
    expect(boundaries).toMatch(/return the refusal as your blocker/i);
  });
});
