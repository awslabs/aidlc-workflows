// covers: function:inspectStageValidity, subcommand:aidlc-orchestrate:next
//
// A person reviews a finished stage's document in an editor that lines up its
// Markdown tables (Obsidian's table editor, Prettier). Under Guard Policy
// strict every later step then said "... changed after Practices Discovery
// finished. Do you want me to redo ...?". Lining up a table is no change; a
// changed cell, a changed alignment, or padding in a code block still is.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, runOrchestrateNext,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { artifactFilename } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { loadGraph } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { stageValidationAuditFields } from "../../dist/claude/.claude/tools/aidlc-validity.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SEP = "\u2014";
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

const COMPACT = [
  "| Practice | Target |",
  "|---|:---:|",
  "| Review | Every change |",
  "",
  "```text",
  "| kept | as is |",
  "```",
  "",
].join("\n");

const PADDED = [
  "| Practice |    Target    |",
  "| -------- | :----------: |",
  "| Review   | Every change |",
  "",
  "```text",
  "| kept | as is |",
  "```",
  "",
].join("\n");

// Classic work under strict, with Practices Discovery finished and its
// completion record taken over a compact team-practices.md.
function finishedPractices(): { proj: string; doc: string } {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  const made = spawnSync(process.execPath, [UTIL, "intent-create", "--scope", "classic", "--arguments", "show the asset description on hover", "--project-dir", proj], {
    encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const record = join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
  const dir = join(record, "inception", "practices-discovery");
  const stage = loadGraph().find((entry) => entry.slug === "practices-discovery")!;
  mkdirSync(dir, { recursive: true });
  for (const name of stage.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n`);
  const doc = join(dir, artifactFilename("team-practices"));
  writeFileSync(doc, COMPACT);
  const statePath = join(record, "aidlc-state.md");
  const state = readFileSync(statePath, "utf-8")
    .replace(new RegExp(`^- \\[.\\] practices-discovery ${SEP}`, "m"), `- [x] practices-discovery ${SEP}`)
    .replace(new RegExp(`^- \\[.\\] requirements-analysis ${SEP}`, "m"), `- [-] requirements-analysis ${SEP}`)
    .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: requirements-analysis")
    .replace(/^- \*\*Guard Policy\*\*: .*$/m, "- **Guard Policy**: strict (set by you)");
  writeFileSync(statePath, state);
  appendAuditEntry("STAGE_COMPLETED", { Stage: "practices-discovery", ...stageValidationAuditFields(proj, stage, state) }, proj);
  return { proj, doc };
}

function directlyStale(proj: string): unknown {
  const result = runOrchestrateNext(ORCH, proj);
  expect(result.directive, result.stderr).not.toBeNull();
  return ((result.directive as Record<string, unknown>).stage_validity as Record<string, unknown> | undefined)?.directly_stale;
}

describe("t-table-padding-keeps-stage: a finished stage's table lined up by an editor", () => {
  test("lining up the table is no change", () => {
    const { proj, doc } = finishedPractices();
    writeFileSync(doc, PADDED);
    expect(directlyStale(proj)).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  for (const [name, edit] of [
    ["a changed cell", PADDED.replace("Every change", "Every commit")],
    ["a changed alignment", PADDED.replace(":----------:", "------------")],
    ["padding in a code block", PADDED.replace("| kept | as is |", "| kept |  as is |")],
  ]) {
    test(`${name} is still a change`, () => {
      const { proj, doc } = finishedPractices();
      writeFileSync(doc, edit);
      expect(directlyStale(proj)).toEqual(["practices-discovery"]);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});
