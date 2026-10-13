// covers: tool:aidlc-sensor, function:withHookWorkflowMutation
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, REPO_ROOT,
  seedAuditFile, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) cleanupTestProject(root);
});

function snapshot(root: string): Record<string, { content: string; mtimeMs: number }> {
  const files: Record<string, { content: string; mtimeMs: number }> = {};
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(root, path)] = { content: readFileSync(path).toString("base64"), mtimeMs: statSync(path).mtimeMs };
    }
  }
  walk(root);
  return files;
}

test.each([
  ["Completed", true], ["Completed", false], ["Archived", true], ["Archived", false],
] as const)("a late %s sensor result (pass=%s) leaves its sealed target unchanged", (status, pass) => {
  const project = createTestProject();
  roots.push(project);
  seedAuditFile(project);
  const record = seededRecordDir(project);
  writeFileSync(seededStateFile(project), "- **Status**: Running\n- **Scope**: bugfix\n");
  const output = join(record, "inception", "requirements-analysis", "requirements.md");
  mkdirSync(join(output, ".."), { recursive: true });
  writeFileSync(output, "# Requirements\n\n## One\nText.\n");
  const detailDir = join(record, ".aidlc-engine", "sensors", "requirements-analysis");
  mkdirSync(detailDir, { recursive: true });
  writeFileSync(join(detailDir, "required-sections-12345678.md"),
    `**Output path**: ${output}\n\nPrevious finding.\n`);

  // The worker is the synchronization barrier: after FIRED, before publication.
  // It seals A and switches the cursor to B under the actual workspace lock,
  // then captures A after those intended writes. No sleeps or timing guesses.
  const scripts = join(project, "sensor-scripts");
  mkdirSync(scripts);
  const beforeFile = join(project, "sealed-snapshot.json");
  const second = join(record, "..", "second");
  mkdirSync(second);
  writeFileSync(join(second, "aidlc-state.md"), "- **Status**: Running\n");
  writeFileSync(join(scripts, "aidlc-sensor-required-sections.ts"), `
import { withAuditLock } from ${JSON.stringify(join(REPO_ROOT, "core", "tools", "aidlc-lib.ts"))};
import { writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
withAuditLock(${JSON.stringify(project)}, () => {
  writeFileSync(${JSON.stringify(seededStateFile(project))}, ${JSON.stringify(`- **Status**: ${status}\n`)});
  writeFileSync(${JSON.stringify(join(record, "..", "active-intent"))}, "second");
});
const root = ${JSON.stringify(record)};
const files = {};
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else files[relative(root, path)] = { content: readFileSync(path).toString("base64"), mtimeMs: statSync(path).mtimeMs };
  }
}
walk(root);
writeFileSync(${JSON.stringify(beforeFile)}, JSON.stringify(files));
console.log(JSON.stringify({pass: ${pass}, findings_count: ${pass ? 0 : 1}}));
`);
  const result = spawnSync(process.execPath, [
    join(REPO_ROOT, "core", "tools", "aidlc-sensor.ts"),
    "fire", "required-sections", "--stage", "requirements-analysis", "--output-path", output,
    "--hook-space", "default", "--hook-intent", record.split(/[\\/]/).at(-1)!,
  ], {
    cwd: project, encoding: "utf8", timeout: 30_000,
    env: {
      ...process.env, AIDLC_PROJECT_DIR: project, CLAUDE_PROJECT_DIR: project,
      AIDLC_STAGE_GRAPH: join(AIDLC_SRC, "tools", "data", "stage-graph.json"),
      AIDLC_SENSOR_SCRIPT_DIR: scripts,
    },
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(result.stdout).toBe("");
  expect(snapshot(record)).toEqual(JSON.parse(readFileSync(beforeFile, "utf8")));
  const events = Object.values(snapshot(record)).map((file) => Buffer.from(file.content, "base64").toString()).join("\n");
  expect(events).toContain("SENSOR_FIRED");
  expect(events).not.toContain("SENSOR_PASSED");
  expect(events).not.toContain("SENSOR_FAILED");
  expect(readdirSync(second)).toEqual(["aidlc-state.md"]);
});
