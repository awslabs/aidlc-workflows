// covers: subcommand:aidlc-log:link, function:effectiveSupportAgentsForProject, function:singleStageAttemptScope, function:pipelineLinkEvidence
//
// The collaborators switch as the person meets it through the engine: a switch
// typed with the request reaches the work it creates, and an isolated
// Reverse Engineering run finishes on the plan its own instructions named.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_SPACE,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  runOrchestrateNext,
  seedAidlcMemory,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");
const RE_STAGE = "reverse-engineering";
const LEAD = "aidlc-developer-agent";
const FINAL = "aidlc-architect-agent";
const CODEKB = [
  "business-overview",
  "architecture",
  "code-structure",
  "api-documentation",
  "component-inventory",
  "technology-stack",
  "dependencies",
  "code-quality-assessment",
  "reverse-engineering-timestamp",
];

const projects: string[] = [];
afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop());
});

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  delete env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE;
  delete env.AIDLC_DISABLE_COLLABORATORS;
  return env;
}

function directiveOf(out: string): Record<string, unknown> {
  const line = out.split("\n").find((entry) => entry.trim().startsWith("{"));
  expect(line, out).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

function runNext(proj: string, args: string[]): Record<string, unknown> {
  return directiveOf(runOrchestrateNext(ORCH, proj, args, { cwd: proj, env: childEnv() }).out);
}

// An answer command the engine printed, run the way the agent runs it.
function runEmitted(proj: string, command: string): Record<string, unknown> {
  return runNext(proj, command.slice(command.indexOf(" next ") + 6).split(" "));
}

describe("t-collaborators-cli a switch typed with the request reaches the work", () => {
  test("new work beside active work: every answer carries --collaborators on", () => {
    const proj = createTestProject();
    projects.push(proj);
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    const ask = runNext(proj, ["--collaborators", "on", "Fix the login crash when the session expires"]);
    expect(ask.ask_type).toBe("new-work-routing");
    for (const command of [ask.new_intent_command, ask.continue_command, ask.compose_command]) {
      expect(String(command)).toContain("--collaborators on");
    }
    const created = runEmitted(proj, String(ask.new_intent_command));
    expect(created.kind).toBe("print");
    expect(String(created.message)).toContain("intent create --scope bugfix");
    expect(String(created.message)).toContain("--collaborators on");
  });

  test("an empty workspace: the plan offer's go-ahead carries the switch the preview showed", () => {
    const proj = createTestProject();
    projects.push(proj);
    removeWorkspaceRecord(proj);
    const ask = runNext(proj, ["--collaborators", "on", "Fix the login crash when the session expires"]);
    expect(ask.ask_type).toBe("scope-confirm");
    // The preview counts collaborators as on for this work.
    expect(String(ask.question)).not.toContain("lead agent only");
    expect(String(ask.confirm_command)).toContain("--collaborators on");
    const created = runEmitted(proj, String(ask.confirm_command));
    expect(created.kind).toBe("print");
    expect(String(created.message)).toContain("--collaborators on");
  });
});

// An isolated run never borrows the main work's ceremony settings: its
// instructions name the chain from the scope it runs on, and recording the
// links and finishing the run read that same scope.
function isolatedProject(scope: string, collaboratorsLine: string): string {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-brownfield-init-done.md");
  const statePath = seededStateFile(proj);
  const seeded = readFileSync(statePath, "utf-8").replace(/^- \*\*Scope\*\*: .*/m, `- **Scope**: ${scope}`);
  writeFileSync(statePath, `${seeded}${collaboratorsLine}\n`);
  return proj;
}

function recordLink(proj: string, link: string): { rc: number; out: string } {
  const args = [LOG, "link", "--stage", RE_STAGE, "--link", link, "--single"];
  if (link === LEAD) {
    const handoff = join(dirname(seededStateFile(proj)), "inception", RE_STAGE, "developer-scan.md");
    mkdirSync(dirname(handoff), { recursive: true });
    writeFileSync(
      handoff,
      "## Developer Code Scan Results\n\n### Scan Coverage\n\n- src/\n\n## Handoff Summary\n\nCurrent attempt.\n",
      "utf-8",
    );
    args.push("--artifact", relative(proj, handoff));
  }
  args.push("--project-dir", proj);
  const result = spawnSync(BUN, args, {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: childEnv(),
  });
  return { rc: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function writeCodekb(proj: string): void {
  const dir = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "codekb", basename(proj));
  mkdirSync(dir, { recursive: true });
  for (const name of CODEKB) writeFileSync(join(dir, `${name}.md`), `# ${name}\n`);
}

function finishIsolated(proj: string): Record<string, unknown> {
  const result = spawnSync(
    BUN,
    [ORCH, "report", "--single", "--stage", RE_STAGE, "--result", "completed", "--project-dir", proj],
    { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: childEnv() },
  );
  return directiveOf(`${result.stdout ?? ""}${result.stderr ?? ""}`);
}

describe("t-collaborators-cli an isolated Reverse Engineering run finishes on its own plan", () => {
  test("collaborators on for the work, lead-only scope: the developer alone finishes the run", () => {
    const proj = isolatedProject("bugfix", "- **Collaborators**: on (set by you)");
    const run = runNext(proj, ["--stage", RE_STAGE, "--single"]);
    expect(run.kind, JSON.stringify(run)).toBe("run-stage");
    expect(run.pipeline).toEqual({ links: [LEAD], completed: [] });
    const lead = recordLink(proj, LEAD);
    expect(lead.rc, lead.out).toBe(0);
    writeCodekb(proj);
    const done = finishIsolated(proj);
    expect(done.kind, JSON.stringify(done)).toBe("done");
  });

  test("collaborators off for the work, full-ensemble scope: the architect's link is recorded and the run finishes", () => {
    const proj = isolatedProject("enterprise", "- **Collaborators**: off (set by you)");
    const run = runNext(proj, ["--stage", RE_STAGE, "--single"]);
    expect(run.kind, JSON.stringify(run)).toBe("run-stage");
    expect(run.pipeline).toEqual({ links: [LEAD, FINAL], completed: [] });
    const lead = recordLink(proj, LEAD);
    expect(lead.rc, lead.out).toBe(0);
    const architect = recordLink(proj, FINAL);
    expect(architect.rc, architect.out).toBe(0);
    writeCodekb(proj);
    const done = finishIsolated(proj);
    expect(done.kind, JSON.stringify(done)).toBe("done");
  });
});
