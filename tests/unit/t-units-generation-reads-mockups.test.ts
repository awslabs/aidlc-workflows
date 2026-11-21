// covers: stage:inception/units-generation
//
// Units Generation split the work and mapped stories to Units without reading
// the mockups, and its architecture review was handed only what the stage
// consumes, so a screen nobody builds read as a complete plan. The stage now
// consumes `mockups` and `interaction-spec` (optional: the refined-mockups
// stage runs only when the work has a UI), and the reviewer's checklist asks,
// per story, who builds the logic, the screen and the connection between them.
//
// Optional consumes are unchecked by upstream-coverage: the dispatcher threads
// only required consumes (and `cited` ones) to the sensor, so an output that
// never mentions the mockups still passes.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStageFrontmatter } from "../../core/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ROOT = join(import.meta.dir, "../..");
const STAGE = join(ROOT, "core/aidlc-common/stages/inception/units-generation.md");
const REVIEWING = join(ROOT, "core/knowledge/aidlc-architecture-reviewer-agent/reviewing.md");
const SENSOR = join(ROOT, "core/tools/aidlc-sensor-upstream-coverage.ts");

interface Consume {
  artifact: string;
  required: boolean;
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function stageConsumes(): Consume[] {
  const frontmatter = parseStageFrontmatter(readFileSync(STAGE, "utf-8").replace(/\r\n/g, "\n"));
  return frontmatter.consumes as Consume[];
}

function unitsGenerationReview(): string {
  const text = readFileSync(REVIEWING, "utf-8").replace(/\r\n/g, "\n");
  const start = text.indexOf("### Units Generation");
  expect(start).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n###? /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("Units Generation reads the mockups", () => {
  test("1: the stage consumes mockups and interaction-spec, both optional", () => {
    const consumes = stageConsumes();
    expect(consumes).toContainEqual({ artifact: "mockups", required: false });
    expect(consumes).toContainEqual({ artifact: "interaction-spec", required: false });
    const body = readFileSync(STAGE, "utf-8");
    expect(body).toContain("refined-mockups/mockups.md");
    expect(body).toContain("belongs to a Unit whose responsibilities");
  });

  test("2: the reviewer asks who builds the logic, the screen and the connection, and about the mockups", () => {
    const section = unitsGenerationReview();
    expect(section).toMatch(/which Unit builds the logic/);
    expect(section).toMatch(/which Unit builds the screen/);
    expect(section).toMatch(/which Unit connects the two/);
    expect(section).toMatch(/mockups\.md.*interaction-spec\.md/s);
    expect(section).toMatch(/every screen, control and command/);
    expect(section).toMatch(/Major/);
    expect(section).toMatch(/Do not accept the plan's own statement/);
  });

  test("3: upstream-coverage still passes an output that never mentions the mockups", () => {
    // What the dispatcher threads: required consumes only (no `cited` here).
    const threaded = stageConsumes()
      .filter((consume) => consume.required)
      .map((consume) => consume.artifact);
    expect(threaded).not.toContain("mockups");
    expect(threaded).not.toContain("interaction-spec");
    const consumes = threaded.map((slug) => (slug === "components" ? "components:domain-design" : slug)).join(",");

    const dir = mkdtempSync(join(tmpdir(), "aidlc-ug-mockups-"));
    tempDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "unit-of-work.md"),
      ["# Units", "", "Built from the components, the requirements and the stories.", "", "| U1 | u1-ledger | Ledger |", ""].join("\n"),
    );
    const res = spawnSync(
      process.execPath,
      [SENSOR, "--stage", "units-generation", "--output-path", join(dir, "unit-of-work.md"), "--consumes", consumes, "--deliverables", "unit-of-work"],
      { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" },
    );
    expect(res.status).toBe(0);
    const result = JSON.parse(res.stdout) as { pass: boolean; unreferenced: string[]; findings_count: number };
    expect(result.pass).toBe(true);
    expect(result.unreferenced).toEqual([]);
    expect(result.findings_count).toBe(0);
  });

  // 4 (the run-stage directive's resolved consumes) is not covered here: building
  // a directive needs a seeded intent record and a full orchestrate run, which is
  // not cheap; the reviewer's pass-list is "the resolved paths in directive.consumes".
});
