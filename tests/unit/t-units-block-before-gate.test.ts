// covers: function:unitsBlockRepair, subcommand:aidlc-log:review, subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next, audit:REVIEW_REQUESTED
//
// Units Generation's units block (the fenced yaml in unit-of-work-dependency.md)
// is what Construction walks its Units from. Seen live on Kiro IDE: the block
// was missing, the reviewer flagged it, the person approved the stage anyway,
// and Construction's first `next` was an error telling the person to fix that
// engine-read file. Now the block is checked before the review and before the
// gate, and a block that breaks later is a step for the agent: the exact defect,
// the block's shape, and the command to run again. Nothing tells the person to
// fix it. The review request hands the same step back as a print, not a failed
// command: a failed command has the agent tell the person a step to take.
//
// Mechanism: cli. Every step drives the real aidlc-log.ts and
// aidlc-orchestrate.ts against a seeded record.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { findStageBySlug, readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const SEP = "\u2014";
const STAGE = "units-generation";
const SHAPE = "`units:`";
const OLD_PERSON_LINE = "Fix the fenced units block";

const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

const BROKEN: Record<string, { body: string; defect: string }> = {
  missing: {
    body: "# Unit Dependencies\n\n## Dependency DAG\n\n- alpha depends on nothing\n- beta depends on alpha\n",
    defect: "no fenced ```yaml units: block found",
  },
  malformed: {
    body: "# Unit Dependencies\n\n```yaml\nunits:\n  - name: alpha\n    depends_on: [missing]\n```\n",
    defect: 'unit "alpha" depends on unknown unit "missing"',
  },
};

const GOOD = "# Unit Dependencies\n\n```yaml\nunits:\n  - name: alpha\n    depends_on: []\n" +
  "  - name: beta\n    depends_on: [alpha]\n```\n";

function row(marker: " " | "-" | "x", slug: string): string {
  return `- [${marker}] ${slug} ${SEP} EXECUTE`;
}

function state(current: "units-generation" | "functional-design", review: string | null): string {
  const inception = current === "units-generation" ? "-" : "x";
  const construction = current === "functional-design" ? "-" : " ";
  return `# AI-DLC State Tracking

## Project Information
- **Project**: units block before the gate
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8

## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
${review === null ? "" : `- **Review Override**: ${review}\n`}
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
${row("x", "domain-design")}
${row(inception, "units-generation")}

### CONSTRUCTION PHASE
${row(construction, "functional-design")}
${row(" ", "nfr-requirements")}
${row(" ", "nfr-design")}
${row(" ", "infrastructure-design")}
${row(" ", "code-generation")}
${row(" ", "build-and-test")}

## Current Status
- **Lifecycle Phase**: ${current === "units-generation" ? "INCEPTION" : "CONSTRUCTION"}
- **Current Stage**: ${current}
- **Status**: Running
`;
}

function project(current: "units-generation" | "functional-design", review: string | null, dependency: string): string {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), state(current, review));
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, proj);
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "unit-of-work.md"),
    "# Units of Work\n\n| Unit ID | Directory | Name |\n|---|---|---|\n| U1 | u1-alpha | alpha |\n| U2 | u2-beta | beta |\n");
  writeFileSync(join(dir, "unit-of-work-story-map.md"), "# Story Map\n\n| Item | Unit ID |\n|---|---|\n| FR1 | U1 |\n");
  writeFileSync(join(dir, "traceability.json"), "{}\n");
  writeDependency(proj, dependency);
  return proj;
}

function writeDependency(proj: string, body: string): void {
  writeFileSync(join(seededRecordDir(proj), "inception", STAGE, "unit-of-work-dependency.md"), body);
}

function run(tool: string, args: string[], proj: string): { rc: number; out: string } {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const r = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function directiveOf(out: string): Record<string, unknown> {
  const line = out.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  return line ? JSON.parse(line) as Record<string, unknown> : {};
}

function reviewRequest(proj: string): { rc: number; out: string } {
  return run(LOG, ["review", "--stage", STAGE, "--reviewer", findStageBySlug(STAGE)!.reviewer!, "--iteration", "1"], proj);
}

// The step names the file, the exact defect and the block's shape, and never
// asks the person to fix it.
function expectRepairStep(said: string, defect: string): void {
  expect(said).toContain("unit-of-work-dependency.md");
  expect(said).toContain(defect);
  expect(said).toContain(SHAPE);
  expect(said).toContain("depends_on:");
  expect(said).not.toContain(OLD_PERSON_LINE);
}

describe("t-units-block-before-gate: Units Generation's units block is checked before its review and its gate", () => {
  for (const [label, broken] of Object.entries(BROKEN)) {
    test(`block ${label}: the review request hands the agent the fix and the same request, and records no review`, () => {
      const proj = project("units-generation", null, broken.body);
      const step = reviewRequest(proj);
      // A step the agent follows, not a failed command it reports to the person.
      expect(step.rc, step.out).toBe(0);
      const d = directiveOf(step.out);
      expect(d.kind, step.out).toBe("print");
      expectRepairStep(String(d.message), broken.defect);
      expect(String(d.message)).toMatch(
        new RegExp(`review --stage ${STAGE} --reviewer ${findStageBySlug(STAGE)!.reviewer!} --iteration 1 --project-dir \\S+\` again\\.$`),
      );
      expect(step.out).not.toContain('"error"');
      expect(readAllAuditShards(proj)).not.toContain("REVIEW_REQUESTED");
      expect(readAllAuditShards(proj)).not.toContain("ERROR_LOGGED");

      // Once the block reads, the same request goes through.
      writeDependency(proj, GOOD);
      const accepted = reviewRequest(proj);
      expect(accepted.out).not.toContain("unit-of-work-dependency.md");
      expect(accepted.rc, accepted.out).toBe(0);
    });

    test(`block ${label}, reviews off: opening the gate names the fix and the same report, and no gate opens`, () => {
      const proj = project("units-generation", "none", broken.body);
      const r = run(ORCH, ["report", "--stage", STAGE, "--result", "awaiting-approval"], proj);
      const d = directiveOf(r.out);
      expect(d.kind, r.out).toBe("print");
      expectRepairStep(String(d.message), broken.defect);
      expect(String(d.message)).toContain(`report --stage ${STAGE} --result awaiting-approval\` again`);
      expect(readAllAuditShards(proj)).not.toContain("STAGE_AWAITING_APPROVAL");
      expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(`- [-] ${STAGE}`);

      // The same report no longer stops on the block once it reads.
      writeDependency(proj, GOOD);
      const again = run(ORCH, ["report", "--stage", STAGE, "--result", "awaiting-approval"], proj);
      expect(again.out).not.toContain("unit-of-work-dependency.md cannot be read");
    });

    test(`block ${label}: an approval names the fix and the same approval, so the person is not asked again`, () => {
      const proj = project("units-generation", "none", broken.body);
      const report = ["report", "--stage", STAGE, "--result", "approved", "--user-input", "Approve"];
      const d = directiveOf(run(ORCH, report, proj).out);
      expect(d.kind, JSON.stringify(d)).toBe("print");
      expectRepairStep(String(d.message), broken.defect);
      expect(String(d.message)).toContain(`report --stage ${STAGE} --result approved --user-input`);
      expect(readAllAuditShards(proj)).not.toContain("GATE_APPROVED");
    });
  }
});

describe("t-units-block-before-gate: a block that breaks after approval is the agent's step", () => {
  for (const [label, broken] of Object.entries(BROKEN)) {
    test(`block ${label}: Construction's next names the repair and next, never an error for the person`, () => {
      const proj = project("functional-design", null, broken.body);
      const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" };
      delete env.AWS_AIDLC_DEFAULT_SCOPE;
      const d = runOrchestrateNext(ORCH, proj, [], { env }).directive ?? {};
      expect(d.kind, JSON.stringify(d)).toBe("print");
      expectRepairStep(String(d.message), broken.defect);
      expect(String(d.message)).toMatch(/orchestrate(?:\.ts)? next`\.$/);

      writeDependency(proj, GOOD);
      const after = runOrchestrateNext(ORCH, proj, [], { env }).directive ?? {};
      expect(after.kind, JSON.stringify(after)).toBe("run-stage");
      expect(after.stage).toBe("functional-design");
    });

    test(`block ${label}: approving a per-Unit stage names the repair and the same approval`, () => {
      const proj = project("functional-design", null, broken.body);
      const report = ["report", "--stage", "functional-design", "--result", "approved", "--user-input", "Approve"];
      const d = directiveOf(run(ORCH, report, proj).out);
      expect(d.kind, JSON.stringify(d)).toBe("print");
      expectRepairStep(String(d.message), broken.defect);
      expect(String(d.message)).toContain("report --stage functional-design --result approved --user-input");
    });
  }
});
