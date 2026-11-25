// covers: function:parseBoltDag, function:unitLikelyRepos, function:unknownLikelyReposLine, file:core/tools/aidlc-unit-teams.ts
//
// Likely repos per Unit (#2410, item 2). The units block gains an optional
// `repos:` list, proposed at Units Generation as a guide: a repo name or a
// folder inside one. Blocks without it parse as before; a bare `- item` under
// `repos:` is a repo, never a dependency; a name the work does not record is
// said once and kept as written.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBoltDag } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { unknownLikelyReposLine, unitLikelyRepos } from "../../dist/claude/.claude/tools/aidlc-unit-teams.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STAGE_FILE = join(import.meta.dir, "..", "..", "core", "aidlc-common", "stages", "inception", "units-generation.md");
const D = String.fromCharCode(0x2014);
const projects: string[] = [];
afterAll(() => {
  for (const proj of projects) cleanupTestProject(proj);
});

const block = (body: string): string => `# Dependencies\n\n\`\`\`yaml\nunits:\n${body}\`\`\`\n`;

describe("the units block reads likely repos", () => {
  test("a block without repos parses as before", () => {
    const parsed = parseBoltDag(block("  - name: refunds\n    depends_on: []\n  - name: reporting\n    depends_on: [refunds]\n"));
    expect(parsed).toEqual({
      ok: true,
      units: [{ name: "refunds", depends_on: [] }, { name: "reporting", depends_on: ["refunds"] }],
      batches: [["refunds"], ["reporting"]],
    });
  });

  test("an inline list, a block list, and folders inside one repo", () => {
    const parsed = parseBoltDag(block(
      "  - name: refunds\n    kind: service\n    repos: [checkout-api, billing]\n    depends_on: []\n" +
        "  - name: reporting\n    repos:\n      - billing\n    depends_on:\n      - refunds\n" +
        "  - name: monorepo-unit\n    repos: [platform/services/checkout-api, platform/services/billing]\n    depends_on: []\n",
    ));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.units).toEqual([
      { name: "refunds", kind: "service", repos: ["checkout-api", "billing"], depends_on: [] },
      { name: "reporting", repos: ["billing"], depends_on: ["refunds"] },
      { name: "monorepo-unit", repos: ["platform/services/checkout-api", "platform/services/billing"], depends_on: [] },
    ]);
    expect(parsed.batches).toEqual([["monorepo-unit", "refunds"], ["reporting"]]);
  });
});

function stateAfterUnits(): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: likely repos test
- **Project Type**: Brownfield
- **Scope**: feature
- **State Version**: 8

## Scope Configuration
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
- [x] units-generation ${D} EXECUTE
- [ ] delivery-planning ${D} EXECUTE

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: units-generation
- **Status**: Running
`;
}

function project(repos: string[], body: string): string {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), stateAfterUnits());
  // repos.json is here, so the offer to write it stays out of the way.
  writeFileSync(join(proj, "repos.json"), JSON.stringify({ repos: repos.map((name) => ({ name })) }));
  const registryPath = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<Record<string, unknown>>;
  registry[0].repos = repos;
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const units = join(seededRecordDir(proj), "inception", "units-generation");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "unit-of-work-dependency.md"), block(body));
  return proj;
}

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SESSION_OVERRIDE: "01995000-7a11-7000-8000-000000002410",
  AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
};

describe("a likely repo the work does not record", () => {
  test("is said once, after Units Generation, and kept as written", () => {
    const proj = project(
      ["billing", "checkout-api"],
      "  - name: refunds\n    repos: [checkout-api, billings]\n    depends_on: []\n  - name: reporting\n    repos: [billing]\n    depends_on: []\n",
    );
    expect(unitLikelyRepos(proj).get("refunds")).toEqual(["checkout-api", "billings"]);
    const line = "The Unit plan names billings for refunds, which is not one of this work's repos (billing, checkout-api). " +
      "It stays as written, as a guide.";
    expect(unknownLikelyReposLine(proj)).toBe(line);
    const first = runOrchestrateNext(ORCH, proj, [], { env: ENV }).directive as Record<string, unknown>;
    expect((first.change_notices ?? []) as string[], JSON.stringify(first)).toContain(line);
    const again = runOrchestrateNext(ORCH, proj, [], { env: ENV }).directive as Record<string, unknown>;
    expect((again.change_notices ?? []) as string[]).not.toContain(line);
  });

  test("work that records no repos names folders in its one repo, and nothing is said", () => {
    const proj = project([], "  - name: refunds\n    repos: [services/billing]\n    depends_on: []\n");
    expect(unknownLikelyReposLine(proj)).toBeNull();
  });
});

describe("Units Generation proposes them", () => {
  test("the stage asks for likely repos when the work records repos, in the plan and the block", () => {
    const text = readFileSync(STAGE_FILE, "utf-8");
    expect(text).toContain("Likely repos per unit, when this work records repos");
    expect(text).toContain("repos: [<repo>, <repo>/<folder>]");
  });
});
