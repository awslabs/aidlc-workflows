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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseStageFrontmatter } from "../../core/tools/aidlc-lib.ts";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, DEFAULT_RECORD_DIR, DEFAULT_SPACE, resetAidlcEnv,
  runOrchestrateNext, sedReplaceInFile, seededRecordDir, seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const ROOT = join(import.meta.dir, "../..");
const STAGE = join(ROOT, "core/aidlc-common/stages/inception/units-generation.md");
const SENSOR = join(ROOT, "core/tools/aidlc-sensor-upstream-coverage.ts");
const MOCKUPS = `aidlc/spaces/${DEFAULT_SPACE}/intents/${DEFAULT_RECORD_DIR}/inception/refined-mockups`;

resetAidlcEnv();

interface Consume {
  artifact: string;
  required: boolean;
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

function stageConsumes(): Consume[] {
  const frontmatter = parseStageFrontmatter(readFileSync(STAGE, "utf-8").replace(/\r\n/g, "\n"));
  return frontmatter.consumes as Consume[];
}

interface Step {
  consumes: string[];
  consumes_absent?: Array<{ path: string }>;
}

function unitsGenerationStep(withMockups: boolean): Step {
  const proj = createOrchestrationTestProject();
  tempDirs.push(proj);
  seedStateFile(proj, "state-construction.md");
  const state = seededStateFile(proj);
  sedReplaceInFile(state, /^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: units-generation");
  sedReplaceInFile(state, /^- \[.\] units-generation /m, "- [-] units-generation ");
  if (withMockups) {
    for (const name of ["mockups.md", "interaction-spec.md"]) {
      const path = join(seededRecordDir(proj), "inception", "refined-mockups", name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "# seeded\n");
    }
  }
  const { directive, out } = runOrchestrateNext(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), proj);
  expect(directive?.kind, out).toBe("run-stage");
  expect(directive?.stage).toBe("units-generation");
  return directive as unknown as Step;
}

describe("Units Generation reads the mockups", () => {
  test("1: the stage consumes mockups and interaction-spec, both optional", () => {
    const consumes = stageConsumes();
    expect(consumes).toContainEqual({ artifact: "mockups", required: false });
    expect(consumes).toContainEqual({ artifact: "interaction-spec", required: false });
  });

  test("2: the step lists both documents when Refined Mockups produced them, and neither when it did not", () => {
    const present = unitsGenerationStep(true);
    expect(present.consumes).toEqual(expect.arrayContaining([`${MOCKUPS}/mockups.md`, `${MOCKUPS}/interaction-spec.md`]));
    const absent = unitsGenerationStep(false);
    const named = [...absent.consumes, ...(absent.consumes_absent ?? []).map((entry) => entry.path)];
    expect(named.filter((path) => path.startsWith(`${MOCKUPS}/`))).toEqual([]);
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
});
