// covers: function:inspectStageValidity, subcommand:aidlc-orchestrate:next
//
// A finished stage's document changed afterwards. Under Guard Policy relaxed
// and off the guard accepts that change and says it once, so the per-turn
// stage-validity line never raises it: no "finished before something it used
// changed" on any later step. A document that is gone is still raised, and
// strict keeps the line.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, runOrchestrateNext,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { artifactFilename } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { loadGraph } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { stageValidationAuditFields } from "../../dist/claude/.claude/tools/aidlc-validity.ts";
import { spawnSync } from "node:child_process";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SEP = "\u2014";
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

function recordDir(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  return join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
}

function statePath(proj: string): string {
  return join(recordDir(proj), "aidlc-state.md");
}

function practicesDir(proj: string): string {
  return join(recordDir(proj), "inception", "practices-discovery");
}

// Classic work with Practices Discovery finished and its completion record
// taken over its documents, under the given Guard Policy.
function finishedPractices(policy: string): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  const made = spawnSync(process.execPath, [UTIL, "intent-create", "--scope", "classic", "--arguments", "show the asset description on hover", "--project-dir", proj], {
    encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
  const stage = loadGraph().find((entry) => entry.slug === "practices-discovery")!;
  mkdirSync(practicesDir(proj), { recursive: true });
  for (const name of stage.produces ?? []) {
    writeFileSync(join(practicesDir(proj), artifactFilename(name)), `# ${name}\n`);
  }
  const state = readFileSync(statePath(proj), "utf-8")
    .replace(new RegExp(`^- \\[.\\] practices-discovery ${SEP}`, "m"), `- [x] practices-discovery ${SEP}`)
    .replace(new RegExp(`^- \\[.\\] requirements-analysis ${SEP}`, "m"), `- [-] requirements-analysis ${SEP}`)
    .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: requirements-analysis")
    .replace(/^- \*\*Guard Policy\*\*: .*$/m, `- **Guard Policy**: ${policy}`);
  writeFileSync(statePath(proj), state);
  expect(readFileSync(statePath(proj), "utf-8")).toContain(`- **Guard Policy**: ${policy}`);
  appendAuditEntry("STAGE_COMPLETED", {
    Stage: "practices-discovery", ...stageValidationAuditFields(proj, stage, state),
  }, proj);
  return proj;
}

function advisory(proj: string): Record<string, unknown> | undefined {
  const result = runOrchestrateNext(ORCH, proj);
  expect(result.directive, result.stderr).not.toBeNull();
  return (result.directive as Record<string, unknown>).stage_validity as Record<string, unknown> | undefined;
}

function editTeamPractices(proj: string): void {
  const path = join(practicesDir(proj), artifactFilename("team-practices"));
  writeFileSync(path, `${readFileSync(path, "utf-8")}\nOne word changed.\n`);
}

describe("t-stale-accepted-change: a finished stage's document edited afterwards", () => {
  test("control: with nothing changed there is no stage-validity line", () => {
    expect(advisory(finishedPractices("off (set by you)"))).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  for (const policy of ["off (set by you)", "relaxed (set by you)"]) {
    test(`Guard Policy ${policy.split(" ")[0]}: no step raises the edit`, () => {
      const proj = finishedPractices(policy);
      editTeamPractices(proj);
      for (let step = 0; step < 3; step++) expect(advisory(proj)).toBeUndefined();
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test(`Guard Policy ${policy.split(" ")[0]}: a document that is gone is still raised`, () => {
      const proj = finishedPractices(policy);
      unlinkSync(join(practicesDir(proj), artifactFilename("team-practices")));
      expect(advisory(proj)?.directly_stale).toEqual(["practices-discovery"]);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("Guard Policy strict: the edit is raised, as before", () => {
    const proj = finishedPractices("strict (set by you)");
    editTeamPractices(proj);
    expect(advisory(proj)?.directly_stale).toEqual(["practices-discovery"]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
