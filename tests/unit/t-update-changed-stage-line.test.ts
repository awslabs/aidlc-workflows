// covers: function:inspectStageValidity, function:stageDefinitionChangedLine, subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:status
//
// An AI-DLC update changed a finished stage itself, not the person's work:
// 2.11.0 to the next release adds an optional `stories` input to Functional
// Design, and every project that finished it heard "Something Functional
// Design used changed after it finished ... Do you want me to redo it?", with
// every later finished stage listed as affected. Now an optional input or
// output that came or went asks and says nothing: the record keeps the
// stage's receipt for its new definition, and status names it. Only a stage
// that now needs an input it did not need when it ran is said, once, in one
// line that asks nothing. A change to the person's own work still asks.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, runOrchestrateNext,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { artifactFilename, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { loadGraph } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import {
  stageDefinitionChangedLine, stageValidationAuditFields,
} from "../../dist/claude/.claude/tools/aidlc-validity.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SEP = "\u2014";
const lineFor = (name: string, slug: string) =>
  `AI-DLC now does ${name} differently from when yours ran; your work stands, and ` +
  `\`/aidlc --stage ${slug}\` goes back to it (the stages after it reopen too).`;
const OPTIONAL_LINE = lineFor("Requirements Analysis", "requirements-analysis");
const REQUIRED_LINE = lineFor("User Stories", "user-stories");
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

function recordDir(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  return join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
}

function writeOutputs(proj: string, slug: string): void {
  const stage = loadGraph().find((entry) => entry.slug === slug)!;
  const dir = join(recordDir(proj), "inception", slug);
  mkdirSync(dir, { recursive: true });
  for (const name of stage.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n`);
}

// What each stage did not read yet on the release before: Requirements
// Analysis the team's practices (optional, the shape of #2486), User Stories
// the requirements (required).
const DROPPED = { optional: ["requirements-analysis", "team-practices"], required: ["user-stories", "requirements"] } as const;

// Classic work that finished Practices Discovery, Requirements Analysis and
// User Stories on the release before, so one stage's receipt was taken over
// its older definition.
function finishedBeforeTheUpdate(change: keyof typeof DROPPED): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  const made = spawnSync(process.execPath, [UTIL, "intent-create", "--scope", "classic", "--arguments", "show the asset description on hover", "--project-dir", proj], {
    encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
  const finished = ["practices-discovery", "requirements-analysis", "user-stories"];
  for (const slug of finished) writeOutputs(proj, slug);
  const statePath = join(recordDir(proj), "aidlc-state.md");
  let state = readFileSync(statePath, "utf-8");
  for (const slug of finished) {
    state = state.replace(new RegExp(`^- \\[.\\] ${slug} ${SEP}`, "m"), `- [x] ${slug} ${SEP}`);
  }
  state = state
    .replace(new RegExp(`^- \\[.\\] refined-mockups ${SEP}`, "m"), `- [-] refined-mockups ${SEP}`)
    .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: refined-mockups")
    .replace(/^- \*\*Guard Policy\*\*: .*$/m, "- **Guard Policy**: strict (set by you)");
  writeFileSync(statePath, state);
  expect(readFileSync(statePath, "utf-8")).toContain("- **Current Stage**: refined-mockups");
  const [slug, artifact] = DROPPED[change];
  const live = loadGraph();
  const now = live.find((entry) => entry.slug === slug)!;
  expect(now.consumes?.find((consume) => consume.artifact === artifact)?.required ?? false).toBe(change === "required");
  const before = { ...now, consumes: now.consumes?.filter((consume) => consume.artifact !== artifact) };
  const graphBefore = live.map((entry) => (entry.slug === slug ? before : entry));
  for (const stage of graphBefore.filter((entry) => finished.includes(entry.slug))) {
    appendAuditEntry("STAGE_COMPLETED", {
      Stage: stage.slug, ...stageValidationAuditFields(proj, stage, state, graphBefore),
    }, proj);
  }
  return proj;
}

function step(proj: string, env: Record<string, string> = {}): Record<string, unknown> {
  const result = runOrchestrateNext(ORCH, proj, [], { env: { ...process.env, ...env } });
  expect(result.directive, result.stderr).not.toBeNull();
  return result.directive as Record<string, unknown>;
}

function status(proj: string): string {
  const result = spawnSync(process.execPath, [UTIL, "status", "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8",
  });
  return `${result.stdout}${result.stderr}`;
}

const notices = (directive: Record<string, unknown>) => (directive.change_notices as string[] | undefined) ?? [];
const saysAnyChange = (directive: Record<string, unknown>) =>
  notices(directive).some((line) => line.startsWith("AI-DLC now does"));
const validity = (directive: Record<string, unknown>) =>
  directive.stage_validity as { directly_stale?: string[]; warning?: string } | undefined;
const renewals = (proj: string) =>
  readAuditShardEvents(proj).filter((row) => row.event === "STAGE_DEFINITION_CHANGED");

describe("t-update-changed-stage-line: a finished stage AI-DLC itself changed", () => {
  test("an optional input it now reads asks and says nothing; the record and status keep it", () => {
    const proj = finishedBeforeTheUpdate("optional");
    expect(status(proj)).toContain(OPTIONAL_LINE);
    const first = step(proj);
    expect(saysAnyChange(first), JSON.stringify(first.change_notices)).toBe(false);
    expect(validity(first), JSON.stringify(first.stage_validity)).toBeUndefined();
    expect(renewals(proj)).toHaveLength(1);
    const again = step(proj);
    expect(saysAnyChange(again)).toBe(false);
    expect(validity(again)).toBeUndefined();
    expect(renewals(proj)).toHaveLength(1);
    expect(status(proj)).toContain(OPTIONAL_LINE);
    expect(status(proj)).not.toContain("used changed after it finished");
  });

  test("a required input it now reads is said once, asking nothing, and no later step says it again", () => {
    const proj = finishedBeforeTheUpdate("required");
    const first = step(proj);
    expect(notices(first)).toContain(REQUIRED_LINE);
    expect(validity(first), JSON.stringify(first.stage_validity)).toBeUndefined();
    expect(renewals(proj)).toHaveLength(1);
    const again = step(proj);
    expect(saysAnyChange(again)).toBe(false);
    expect(validity(again)).toBeUndefined();
    expect(renewals(proj)).toHaveLength(1);
  });

  test("a read-only probe hears the line but records nothing", () => {
    const proj = finishedBeforeTheUpdate("required");
    expect(notices(step(proj, { AIDLC_STOP_HOOK_PROBE: "1" }))).toContain(REQUIRED_LINE);
    expect(renewals(proj)).toHaveLength(0);
    expect(notices(step(proj))).toContain(REQUIRED_LINE);
    expect(renewals(proj)).toHaveLength(1);
  });

  test("a change to the person's own work in the same window keeps today's question", () => {
    const proj = finishedBeforeTheUpdate("optional");
    const requirements = join(recordDir(proj), "inception", "requirements-analysis", artifactFilename("requirements"));
    appendFileSync(requirements, "\n- FR-2: a title is at most 200 characters.\n");
    const first = step(proj);
    expect(validity(first)?.directly_stale).toContain("requirements-analysis");
    expect(saysAnyChange(first)).toBe(false);
    expect(renewals(proj)).toHaveLength(0);
  });

  test("after it is recorded, an edit to what the stage now reads still asks", () => {
    const proj = finishedBeforeTheUpdate("optional");
    step(proj);
    expect(renewals(proj)).toHaveLength(1);
    appendFileSync(join(recordDir(proj), "inception", "practices-discovery", artifactFilename("team-practices")),
      "\nOne practice added.\n");
    expect(validity(step(proj))?.directly_stale).toContain("requirements-analysis");
  });

  test("several stages are named in one line, with the way back to the first", () => {
    expect(stageDefinitionChangedLine(["Functional Design", "NFR Design", "Code Generation"], "functional-design")).toBe(
      "AI-DLC now does Functional Design, NFR Design and Code Generation differently from when yours ran; your work " +
        "stands, and `/aidlc --stage functional-design` goes back to the first (the stages after it reopen too).",
    );
  });
});
