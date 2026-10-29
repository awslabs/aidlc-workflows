// covers: function:prepareRecordFolders, subcommand:aidlc-orchestrate:next
//
// The Copilot CLI's file tool makes no folders ("Parent directory does not
// exist"), so on Windows every stage whose record folder was new cost a refused
// write and a retry (1, 13 and 10 times in three golden bugfix runs), and under
// the SDK's stock permissions an agent's own `mkdir -p` was denied. The engine
// makes the record folder of each file a step names when it hands the step out,
// as it already did for the code plan. These cases drive the real `next`:
//
//   - a bugfix stage with the learnings ritual off: its folder is there, empty;
//   - a per-Unit stage: that Unit's folder only;
//   - Reverse Engineering: its own stage folder for the developer's scan, and
//     each repo's code knowledge base folder and staging folder;
//   - a route check makes nothing; a file where the folder goes, or a link out
//     of the record, leaves the step as it was and makes nothing outside.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, FIXTURES_DIR, runOrchestrateNext, seedBoltDag,
  seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { hooksHealthDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");

interface Step {
  kind: string;
  stage?: string;
  unit?: string;
  produces?: string[];
  wave?: { entries: Array<{ unit: string; produces: string[] }> };
}

function next(proj: string, env: Record<string, string> = {}): Step {
  const result = runOrchestrateNext(ORCH, proj, [], { env: { ...process.env, AIDLC_UNATTENDED: "0", ...env } });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as unknown as Step;
}

// A bugfix at Requirements Analysis, with the learnings ritual off as the
// bugfix plan ships it, so nothing else makes the stage's folder.
function bugfixProject(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(
    seededStateFile(proj),
    readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8")
      .replace("- **Learnings**: on (from scope bugfix)", "- **Learnings**: off (from scope bugfix)"),
    "utf-8",
  );
  return proj;
}

function stageFolder(proj: string): string {
  return join(seededRecordDir(proj), "inception", "requirements-analysis");
}

// A feature workflow at Functional Design, a stage done once per Unit.
function unitProject(...units: string[]): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: Per-Unit design
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: off
- **Guard Policy**: relaxed (set by you)
- **Unit Ownership**: solo

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Minimal

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design - EXECUTE
- [ ] nfr-requirements - EXECUTE
- [ ] nfr-design - EXECUTE
- [ ] infrastructure-design - EXECUTE
- [ ] code-generation - EXECUTE
- [ ] build-and-test - EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`, "utf-8");
  seedBoltDag(proj, units);
  return proj;
}

const emptyFolder = (dir: string): void => {
  expect(existsSync(dir), dir).toBe(true);
  expect(readdirSync(dir)).toEqual([]);
};

describe("each record folder a step names is there before the agent writes into it", () => {
  test("a bugfix stage with the learnings ritual off: its folder is there, empty, when the step is handed out", () => {
    const proj = bugfixProject();
    expect(existsSync(stageFolder(proj))).toBe(false);
    const step = next(proj);
    expect(step).toMatchObject({ kind: "run-stage", stage: "requirements-analysis" });
    emptyFolder(stageFolder(proj));
    expect(step.produces?.length).toBeGreaterThan(0);
    for (const file of step.produces ?? []) expect(existsSync(dirname(join(proj, file))), file).toBe(true);
  });

  test("a per-Unit stage's step makes the folder of the Unit it names, and no other Unit's", () => {
    const proj = unitProject("unit-a", "unit-b");
    const step = next(proj);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.stage).toBe("functional-design");
    const named = step.wave?.entries.map((entry) => entry.unit) ?? [step.unit];
    expect(named.length).toBeGreaterThan(0);
    for (const unit of ["unit-a", "unit-b"]) {
      const folder = join(seededRecordDir(proj), "construction", unit, "functional-design");
      if (named.includes(unit)) emptyFolder(folder);
      else expect(existsSync(folder), folder).toBe(false);
    }
  });

  test("a work recording two repos at Reverse Engineering: each recorded repo's code knowledge base and staging folders", () => {
    const proj = createOrchestrationTestProject();
    created.push(proj);
    writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-brownfield-init-done.md"), "utf-8"), "utf-8");
    const registry = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
    const rows = JSON.parse(readFileSync(registry, "utf-8")) as Array<Record<string, unknown>>;
    rows[0].repos = ["repo-a", "repo-b"];
    writeFileSync(registry, `${JSON.stringify(rows, null, 2)}\n`, "utf-8");
    const codekb = join(proj, "aidlc", "spaces", "default", "codekb");
    const before = existsSync(codekb) ? readdirSync(codekb) : [];
    const step = next(proj);
    expect(step, JSON.stringify(step).slice(0, 300)).toMatchObject({ kind: "run-stage", stage: "reverse-engineering" });
    expect(step.produces?.some((file) => file.includes("{repo}"))).toBe(true);
    expect(readdirSync(codekb).filter((name) => !before.includes(name)).sort()).toEqual(["repo-a", "repo-b"]);
    for (const repo of ["repo-a", "repo-b"]) emptyFolder(join(codekb, repo));
    // The developer's scan handoff and the architect's candidate for each repo.
    emptyFolder(join(seededRecordDir(proj), "inception", "reverse-engineering"));
    const engine = join(seededRecordDir(proj), ".aidlc-engine");
    expect(readdirSync(engine).filter((name) => name.startsWith("codekb-stage-")).sort())
      .toEqual(["codekb-stage-repo-a", "codekb-stage-repo-b"]);
    for (const repo of ["repo-a", "repo-b"]) emptyFolder(join(engine, `codekb-stage-${repo}`));
  });

  // The live run on the Copilot CLI on Windows that found it: every refusal left
  // was the developer's scan handoff and the architect's nine staged files.
  test("Reverse Engineering on a project that records no repo: its handoff folder and the project's staging folder", () => {
    const proj = createOrchestrationTestProject();
    created.push(proj);
    writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-brownfield-init-done.md"), "utf-8"), "utf-8");
    const step = next(proj);
    expect(step, JSON.stringify(step).slice(0, 300)).toMatchObject({ kind: "run-stage", stage: "reverse-engineering" });
    emptyFolder(join(seededRecordDir(proj), "inception", "reverse-engineering"));
    const store = (step.produces ?? [])[0]?.split("/")[4];
    expect(store).toBeTruthy();
    const engine = join(seededRecordDir(proj), ".aidlc-engine");
    expect(readdirSync(engine).filter((name) => name.startsWith("codekb-stage-"))).toEqual([`codekb-stage-${store}`]);
    emptyFolder(join(engine, `codekb-stage-${store}`));
  });

  test("a route check makes nothing", () => {
    const proj = bugfixProject();
    const probe = next(proj, { AIDLC_ROUTE_CHECK: "1" });
    expect(probe).toMatchObject({ kind: "run-stage", stage: "requirements-analysis" });
    expect(existsSync(stageFolder(proj))).toBe(false);
  });

  test("a file where the folder goes, or a link out of the record, leaves the step as it was", () => {
    const blocked = bugfixProject();
    mkdirSync(dirname(stageFolder(blocked)), { recursive: true });
    writeFileSync(stageFolder(blocked), "", "utf-8");
    expect(next(blocked)).toMatchObject({ kind: "run-stage", stage: "requirements-analysis" });
    expect(readFileSync(join(hooksHealthDir(blocked), "record-folders.drops"), "utf-8")).toContain("EEXIST");
    if (process.platform === "win32") return; // A link needs a privilege Windows does not give by default.
    const linked = bugfixProject();
    const outside = mkdtempSync(join(tmpdir(), "t-record-folder-outside-"));
    try {
      symlinkSync(outside, join(seededRecordDir(linked), "inception"));
      expect(next(linked)).toMatchObject({ kind: "run-stage", stage: "requirements-analysis" });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
