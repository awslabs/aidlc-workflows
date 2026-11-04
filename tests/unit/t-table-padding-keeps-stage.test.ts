// covers: function:inspectStageValidity, subcommand:aidlc-orchestrate:next
//
// A person reviews a finished stage's document in an editor that lines up its
// Markdown tables (Obsidian's table editor, Prettier). Under Guard Policy
// strict every later step then said "... changed after Practices Discovery
// finished. Do you want me to redo ...?". Lining up a table is no change; a
// changed cell, a changed alignment, padding in a code block, spacing in pipe
// lines that are no table, or a non-breaking space at a cell's edge still is.
// A receipt a release before this one wrote over a padded table still matches,
// on a CRLF checkout too.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, runOrchestrateNext,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { artifactFilename, rawFingerprintForm } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { loadGraph } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { stageValidationAuditFields, VALIDATION_BASIS_FIELD } from "../../dist/claude/.claude/tools/aidlc-validity.ts";

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

// Pipe lines with no delimiter row: no table, so their spacing is kept.
const NOT_A_TABLE = ["Notes:", "", "| keep this |", "| as written |", ""].join("\n");

// The receipt an earlier release wrote over the same text: each document's
// digest as its bytes were read then, the form this process keeps beside the
// current one.
function recordedBefore(fields: Record<string, string>): Record<string, string> {
  const basis = JSON.parse(fields[VALIDATION_BASIS_FIELD]) as Record<"inputs" | "outputs", { contentHash: string }[]>;
  for (const item of [...basis.inputs, ...basis.outputs]) item.contentHash = rawFingerprintForm(item.contentHash) ?? item.contentHash;
  return { ...fields, [VALIDATION_BASIS_FIELD]: JSON.stringify(basis) };
}

// Classic work under strict, with Practices Discovery finished and its
// completion record taken over team-practices.md as `written` (compact by
// default).
function finishedPractices(
  written = COMPACT,
  recorded: (fields: Record<string, string>) => Record<string, string> = (fields) => fields,
): { proj: string; doc: string } {
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
  writeFileSync(doc, written);
  const statePath = join(record, "aidlc-state.md");
  const state = readFileSync(statePath, "utf-8")
    .replace(new RegExp(`^- \\[.\\] practices-discovery ${SEP}`, "m"), `- [x] practices-discovery ${SEP}`)
    .replace(new RegExp(`^- \\[.\\] requirements-analysis ${SEP}`, "m"), `- [-] requirements-analysis ${SEP}`)
    .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: requirements-analysis")
    .replace(/^- \*\*Guard Policy\*\*: .*$/m, "- **Guard Policy**: strict (set by you)");
  writeFileSync(statePath, state);
  appendAuditEntry("STAGE_COMPLETED", { Stage: "practices-discovery", ...recorded(stageValidationAuditFields(proj, stage, state)) }, proj);
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
    ["a non-breaking space at a cell's edge", PADDED.replace("| Review   |", "| Review\u00a0  |")],
  ]) {
    test(`${name} is still a change`, () => {
      const { proj, doc } = finishedPractices();
      writeFileSync(doc, edit);
      expect(directlyStale(proj)).toEqual(["practices-discovery"]);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("spacing in pipe lines that are no table is still a change", () => {
    const { proj, doc } = finishedPractices(NOT_A_TABLE);
    writeFileSync(doc, NOT_A_TABLE.replace("| keep this |", "|  keep this   |"));
    expect(directlyStale(proj)).toEqual(["practices-discovery"]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a CRLF checkout of a padded table an earlier release recorded is no change", () => {
    const { proj, doc } = finishedPractices(PADDED, recordedBefore);
    writeFileSync(doc, PADDED.replace(/\n/g, "\r\n"));
    expect(directlyStale(proj)).toBeUndefined();
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
