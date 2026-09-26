// covers: subcommand:aidlc-state:gate-start, audit:SENSOR_FIRED, stage:inception/reverse-engineering
//
// t350 - reverse-engineering's declared sensors fire on its own output (#771).
//
// reverse-engineering publishes its nine artifacts to the space-level CodeKB
// (`aidlc/spaces/<space>/codekb/<repo>/`), outside the per-intent record tree.
// Its two declared gate sensors, required-sections and upstream-coverage, used
// to filter on `**/{aidlc-docs,intents}/**`, so gate-start found the nine
// deliverables and then skipped every one: zero SENSOR_* rows, and nothing
// reported it. This drives the shipped graph, manifests and sensor scripts end
// to end: gate-start on a seeded CodeKB store must fire both sensors on all
// nine files, and every one must pass. architecture.md and the timestamp file,
// the two artifacts re-artifacts.md gives templates for, are built from those
// templates, so a template that stops satisfying the required-sections floor
// reds here rather than on every brownfield run.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { codekbDir, codekbRepoName } from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAuditFile,
  seededAuditDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const RE_ARTIFACTS = join(AIDLC_SRC, "knowledge", "aidlc-developer-agent", "re-artifacts.md");
const CODEKB_FILES = [
  "business-overview.md",
  "architecture.md",
  "code-structure.md",
  "api-documentation.md",
  "component-inventory.md",
  "technology-stack.md",
  "dependencies.md",
  "code-quality-assessment.md",
  "reverse-engineering-timestamp.md",
];
const SENSORS = ["required-sections", "upstream-coverage"];
const projects: string[] = [];

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
});

/** Body of the first `<fence>markdown` block after `heading` in the doc. */
function templateAfter(doc: string, heading: string, fence: string): string {
  const at = doc.indexOf(heading);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = doc.indexOf(`${fence}markdown\n`, at);
  expect(open).toBeGreaterThan(at);
  const start = open + `${fence}markdown\n`.length;
  const close = doc.indexOf(`\n${fence}\n`, start);
  expect(close).toBeGreaterThan(start);
  return doc.slice(start, close + 1);
}

function artifactBody(name: string, doc: string): string {
  if (name === "architecture.md") {
    return templateAfter(doc, "### Architecture Synthesis Template", "```");
  }
  if (name === "reverse-engineering-timestamp.md") {
    return [
      templateAfter(doc, "### Run Record (reverse-engineering-timestamp.md)", "```"),
      templateAfter(doc, "### Scope of Analysis Block (reverse-engineering-timestamp.md)", "````"),
    ].join("\n");
  }
  return `# ${name}\n\n## Overview\n\nFixture prose.\n\n## Details\n\nFixture prose.\n`;
}

function codekbStoreProject(): string {
  const project = createTestProject();
  projects.push(project);
  writeFileSync(
    seededStateFile(project),
    [
      "# AI-DLC State Tracking",
      "",
      "- **Workflow**: bugfix",
      "- **State Version**: 8",
      "- **Scope**: bugfix",
      "- **Phase**: inception",
      "- **Current Stage**: reverse-engineering",
      "",
      // parseCheckboxes requires the U+2014 separator between slug and mode.
      "- [-] reverse-engineering \u2014 EXECUTE",
      "",
    ].join("\n"),
    "utf-8",
  );
  seedAuditFile(project);
  const store = codekbDir(project, codekbRepoName(project));
  mkdirSync(store, { recursive: true });
  const templates = readFileSync(RE_ARTIFACTS, "utf-8");
  for (const name of CODEKB_FILES) {
    writeFileSync(join(store, name), artifactBody(name, templates), "utf-8");
  }
  return project;
}

function auditBlocks(project: string, event: string): string[] {
  const dir = seededAuditDir(project);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .flatMap((name) => readFileSync(join(dir, name), "utf-8").split(/\n---\n/))
    .filter((block) => block.split("\n").includes(`**Event**: ${event}`));
}

function field(block: string, name: string): string {
  return block.match(new RegExp(`^\\*\\*${name}\\*\\*: (.*)$`, "m"))?.[1] ?? "";
}

describe("t350 reverse-engineering gate sensors reach the CodeKB", () => {
  test("gate-start fires both declared sensors on all nine CodeKB artifacts, and all pass", () => {
    const project = codekbStoreProject();
    const result = spawnSync(
      BUN,
      [STATE, "gate-start", "reverse-engineering", "--project-dir", project],
      {
        cwd: project,
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_DISABLE_SENSORS: "0",
          AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
          AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
          // reverse-engineering is a pipeline stage; its per-agent handoff
          // receipts are not what this test is about.
          AIDLC_DISABLE_ENSEMBLE_EVIDENCE: "1",
        },
      },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);

    const fired = auditBlocks(project, "SENSOR_FIRED").map((block) => ({
      stage: field(block, "Stage slug"),
      pair: `${field(block, "Sensor ID")}:${basename(field(block, "Output path"))}`,
    }));
    expect(new Set(fired.map(({ stage }) => stage))).toEqual(new Set(["reverse-engineering"]));
    expect(fired.map(({ pair }) => pair).sort()).toEqual(
      SENSORS.flatMap((sensor) => CODEKB_FILES.map((file) => `${sensor}:${file}`)).sort(),
    );
    // A script error or missing tool also lands as SENSOR_PASSED, carrying a
    // Note; only a Note-free pass means the sensor actually evaluated the file.
    const passed = auditBlocks(project, "SENSOR_PASSED");
    expect(passed).toHaveLength(fired.length);
    expect(passed.map((block) => field(block, "Note")).filter(Boolean)).toEqual([]);
    expect(auditBlocks(project, "SENSOR_FAILED")).toEqual([]);
  });
});
