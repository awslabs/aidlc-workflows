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
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { SCOPE_SETTING_KEYS } from "../../core/tools/aidlc-graph.ts";
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
  setupIntegrationProject,
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

function recordLink(proj: string, link: string, single = true): { rc: number; out: string } {
  const args = [LOG, "link", "--stage", RE_STAGE, "--link", link, ...(single ? ["--single"] : [])];
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

// The agent learns the switch from two places: the compose dispatch the engine
// prints, and the orchestrator skill each tool ships.
function composeMessage(proj: string, args: string[]): string {
  const directive = runNext(proj, ["compose", ...args]);
  expect(directive.kind).toBe("print");
  return String(directive.message);
}

describe("t-collaborators-cli the agent is told how to switch collaborators", () => {
  test("the compose gate shows collaborators on its settings row and builds its flag", () => {
    const proj = createTestProject();
    projects.push(proj);
    seedAidlcMemory(proj);
    const front = composeMessage(proj, ["fix the token bug"]);
    expect(front).toContain("plan approval <plan_approval>, collaborators <collaborators>, reviews <review_cap>");
    expect(front).toContain("plan_approval to --plan-approval, collaborators to --collaborators, review to --review");
    seedStateFile(proj, MID_IDEATION);
    const inFlight = composeMessage(proj, ["bring the specialists in"]);
    expect(inFlight).toContain("A request to turn sensors, learnings, summary confirmation, collaborators, plan approval, or reviews on or off");
    expect(inFlight).toContain("collaborators to --collaborators");
  });

  test.each(["claude", "codex", "copilot", "cursor", "kiro-ide", "kiro", "opencode"])(
    "%s: asking in plain chat to bring collaborators in or go lead-only is carried out for the person",
    (harness) => {
      const skill = readFileSync(join(import.meta.dir, "..", "..", "harness", harness, "skills", "aidlc", "SKILL.md"), "utf-8");
      const rule = skill.split("\n").find((line) => line.startsWith("**Collaborators in plain chat.**"));
      expect(rule, harness).toBeDefined();
      expect(rule).toContain("engine config set collaborators on");
      expect(rule).toContain("never hand them a command to type");
      expect(skill).toContain("plan approval on, collaborators off, reviews advisory");
    },
  );
});

// A lead-only inline stage loads only its lead's persona and knowledge: the
// switch is about not paying for collaborators the stage never brings in.
describe("t-collaborators-cli a lead-only inline stage loads only the lead's context", () => {
  function feasibilityPaths(collaboratorsLine: string | null): string[] {
    const proj = createTestProject();
    projects.push(proj);
    seedAidlcMemory(proj);
    seedStateFile(proj, MID_IDEATION);
    if (collaboratorsLine !== null) {
      const statePath = seededStateFile(proj);
      writeFileSync(statePath, `${readFileSync(statePath, "utf-8")}${collaboratorsLine}\n`);
    }
    const run = runNext(proj, []);
    expect(run.kind, JSON.stringify(run)).toBe("run-stage");
    expect(run.stage).toBe("feasibility");
    return run.inline_context_paths as string[];
  }

  test("collaborators off: no support agent persona or knowledge path", () => {
    const paths = feasibilityPaths(null);
    expect(paths.some((path) => path.includes("aidlc-architect-agent"))).toBe(true);
    expect(paths.filter((path) => /aidlc-(aws-platform|compliance)-agent/.test(path))).toEqual([]);
  });

  test("collaborators on: the support agents' persona files come back", () => {
    const paths = feasibilityPaths("- **Collaborators**: on (set by you)");
    expect(paths.some((path) => path.endsWith("agents/aidlc-aws-platform-agent.md"))).toBe(true);
    expect(paths.some((path) => path.endsWith("agents/aidlc-compliance-agent.md"))).toBe(true);
  });
});

// A switch made while Reverse Engineering is running: the final link must have
// been recorded as the final link, so a scan-only receipt never stands in for
// the lead doing both halves, and the lead can record its full run.
describe("t-collaborators-cli a mid-stage switch never reuses a receipt that no longer fits", () => {
  function mainRun(line: string): string {
    const proj = isolatedProject("bugfix", line);
    appendAuditEntry("STAGE_STARTED", { Stage: RE_STAGE, Agent: LEAD }, proj);
    return proj;
  }
  function setCollaborators(proj: string, value: "on" | "off"): void {
    const statePath = seededStateFile(proj);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace(/^- \*\*Collaborators\*\*: .*$/m, `- **Collaborators**: ${value} (set by you)`),
    );
  }

  test("on to off after the developer's scan: the developer runs again as the only link", () => {
    const proj = mainRun("- **Collaborators**: on (set by you)");
    const scan = recordLink(proj, LEAD, false);
    expect(scan.rc, scan.out).toBe(0);
    setCollaborators(proj, "off");
    const resumed = runNext(proj, []);
    expect(resumed.pipeline).toEqual({ links: [LEAD], completed: [] });
    const full = recordLink(proj, LEAD, false);
    expect(full.rc, full.out).toBe(0);
    expect(runNext(proj, []).pipeline).toEqual({ links: [LEAD], completed: [LEAD] });
  });

  test("off to on after the developer's full run: only the architect is left", () => {
    const proj = mainRun("- **Collaborators**: off (set by you)");
    const full = recordLink(proj, LEAD, false);
    expect(full.rc, full.out).toBe(0);
    setCollaborators(proj, "on");
    expect(runNext(proj, []).pipeline).toEqual({ links: [LEAD, FINAL], completed: [LEAD] });
    const architect = recordLink(proj, FINAL, false);
    expect(architect.rc, architect.out).toBe(0);
  });
});

// The composer is told the same settings the validator requires.
describe("t-collaborators-cli the composer's proposal shape names every scope setting", () => {
  test("the composer persona's scopeSettings example and the compose task name all of them", () => {
    const persona = readFileSync(join(import.meta.dir, "..", "..", "core", "agents", "aidlc-composer-agent.md"), "utf-8");
    const example = persona.split("\n").find((line) => line.trim().startsWith('"scopeSettings":'));
    expect(example).toBeDefined();
    const keys = Object.keys(JSON.parse(`{${example!.trim().replace(/,$/, "")}}`).scopeSettings);
    expect(keys.sort()).toEqual([...SCOPE_SETTING_KEYS].sort());
    const proj = createTestProject();
    projects.push(proj);
    seedAidlcMemory(proj);
    const task = composeMessage(proj, ["fix the token bug"]);
    expect(task).toContain("the six scopeSettings (sensors, learnings, summary_confirmation, plan_approval, and collaborators on|off");
  });
});

// Approving a composer change that also turns collaborators on lands both in
// one recompose, like the other settings.
describe("t-collaborators-cli an approved compose change can switch collaborators", () => {
  test("recompose takes --collaborators with the stage changes", () => {
    const proj = setupIntegrationProject({ noAidlcDocs: true, stripEnvScope: true });
    projects.push(proj);
    const util = (args: string[]) => {
      const env: NodeJS.ProcessEnv = { ...childEnv() };
      delete env.AIDLC_SCOPE_MAPPING;
      const res = spawnSync(BUN, [join(proj, ".claude", "tools", "aidlc-utility.ts"), ...args, "--project-dir", proj], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        encoding: "utf-8",
        env,
        cwd: proj,
      });
      return { rc: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
    };
    const created = util(["intent-create", "--scope", "feature"]);
    expect(created.rc, created.out).toBe(0);
    const reshaped = util(["recompose", "--skip", "team-formation", "--collaborators", "on"]);
    expect(reshaped.rc, reshaped.out).toBe(0);
    const space = readFileSync(join(proj, "aidlc", "active-space"), "utf-8").trim() || "default";
    const intents = join(proj, "aidlc", "spaces", space, "intents");
    const record = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    expect(readFileSync(join(intents, record, "aidlc-state.md"), "utf-8")).toMatch(/^- \*\*Collaborators\*\*: on \(set by /m);
  });
});
