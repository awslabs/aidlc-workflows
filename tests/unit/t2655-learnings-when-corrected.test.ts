// covers: subcommand:aidlc-learnings:surface, subcommand:aidlc-orchestrate:next, file:aidlc-common/protocols/stage-protocol-learnings.md
//
// t2655: the learnings step asks only when the person corrected the agent
// (#2655). With nothing corrected, `learnings surface` prints no question, so
// the stage goes from its summary to its gate. For each correction the agent
// read in the person's words it prints one question in their words, "You asked
// me to <it>. Keep that for next time?", with the three exact choices. The
// agent's own diary notes are never offered. A note the person gave with their
// approval is kept under the stage they approved after that approval is
// recorded, and a stage being revised after Request Changes keeps the step, so
// the change they asked for can be asked about before the revised gate.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reviewVerdictNote } from "../../dist/claude/.claude/tools/aidlc-directive.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  runOrchestrateNext,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const LEARNINGS_TS = join(AIDLC_SRC, "tools", "aidlc-learnings.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STAGE = "user-stories";
const CHOICES = ["Yes, for this project", "Yes, for the team", "No"];

const projects: string[] = [];
afterEach(() => {
  for (const p of projects.splice(0)) cleanupTestProject(p);
});

function stateAt(current: string, rows: string): string {
  return `# AI-DLC State Tracking\n- **Current Stage**: ${current}\n- **Scope**: feature\n\n## Stage Progress\n${rows}`;
}

function project(state: string): string {
  const pd = createTestProject();
  projects.push(pd);
  writeFileSync(seededStateFile(pd), state, "utf-8");
  return pd;
}

function surface(pd: string, slug: string, ...extra: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [LEARNINGS_TS, "surface", "--slug", slug, ...extra, "--project-dir", pd], {
    cwd: pd,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function surfaced(pd: string, slug: string, ...extra: string[]): Record<string, unknown> {
  const r = surface(pd, slug, ...extra);
  expect(r.status, r.out).toBe(0);
  return JSON.parse(r.out);
}

function writeDiary(pd: string): void {
  const diary = join(seededRecordDir(pd), "inception", STAGE, "memory.md");
  mkdirSync(dirname(diary), { recursive: true });
  writeFileSync(diary, [
    "## Interpretations",
    "- 2026-10-25T01:00:00Z - Developer runs pipeline alone when collaborators off; the scope says so",
    "## Deviations",
    "- 2026-10-25T01:01:00Z - skipped the optional caching layer; small dataset",
    "## Tradeoffs",
    "## Open questions",
    "- 2026-10-25T01:02:00Z - confirm the retention window",
    "",
  ].join("\n"), "utf-8");
}

describe("t2655 the learnings step asks only after a correction", () => {
  test("nothing corrected: no question, and the agent's diary notes are not offered", () => {
    const pd = project(stateAt(STAGE, `- [-] ${STAGE}\n`));
    writeDiary(pd);
    const out = surfaced(pd, STAGE);
    expect(out.questions).toEqual([]);
    expect(out.candidates).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("Anything to add");
    // The diary stays the stage's record.
    expect(out.memory_entries_total).toBe(3);
  });

  test("one correction: one question in the person's words, with the three choices", () => {
    const pd = project(stateAt(STAGE, `- [-] ${STAGE}\n`));
    writeDiary(pd);
    const out = surfaced(pd, STAGE, "--correction", "name files in kebab-case.");
    expect(out.questions).toEqual([{
      question: "You asked me to name files in kebab-case. Keep that for next time?",
      multi_select: false,
      options: CHOICES,
      question_kind: "learnings-note",
    }]);
    expect(out.candidates).toEqual([{ id: "c1", correction: "name files in kebab-case", default_scope: "project" }]);
  });

  test("two corrections: two questions, in the order the agent read them", () => {
    const pd = project(stateAt(STAGE, `- [-] ${STAGE}\n`));
    const out = surfaced(pd, STAGE, "--correction", "name files in kebab-case", "--correction", "keep handlers thin");
    expect((out.questions as Array<{ question: string }>).map((q) => q.question)).toEqual([
      "You asked me to name files in kebab-case. Keep that for next time?",
      "You asked me to keep handlers thin. Keep that for next time?",
    ]);
  });

  test("a note given with the approval is kept under the stage approved, after the approval is recorded", () => {
    const next = "refined-mockups";
    const pd = project(stateAt(next, `- [x] ${STAGE}\n- [-] ${next}\n`));
    mkdirSync(dirname(seededAuditShard(pd)), { recursive: true });
    appendFileSync(seededAuditShard(pd), [
      "# AI-DLC Audit Log", "",
      "## Gate Approved", "**Timestamp**: 2026-10-25T02:00:00Z", "**Event**: GATE_APPROVED", `**Stage**: ${STAGE}`, "",
      "---", "",
      "## Stage Started", "**Timestamp**: 2026-10-25T02:00:01Z", "**Event**: STAGE_STARTED", `**Stage**: ${next}`, "",
      "---", "",
    ].join("\n"), "utf-8");
    const out = surfaced(pd, STAGE);
    expect(out.stage_slug).toBe(STAGE);
    expect(String(out.selections_file)).toContain(`${STAGE}-selections.json`);
    // A stage approved earlier than the last approval is still refused.
    expect(surface(pd, "requirements-analysis").status).toBe(1);
  });
});

describe("t2655 a stage being revised keeps the step", () => {
  test("the run-stage of a stage being revised after Request Changes lists learnings", () => {
    const pd = createOrchestrationTestProject();
    projects.push(pd);
    seedStateFile(pd, "state-mid-inception.md");
    writeFileSync(seededStateFile(pd), readFileSync(seededStateFile(pd), "utf-8")
      .replace("- **Scope**: bugfix", "- **Scope**: feature")
      .replace("- [-] requirements-analysis", "- [R] requirements-analysis"));
    const result = runOrchestrateNext(ORCHESTRATE, pd, [], { cwd: pd });
    expect(result.status, JSON.stringify(result.directive)).toBe(0);
    expect(result.directive?.kind).toBe("run-stage");
    expect(result.directive?.stage).toBe("requirements-analysis");
    expect(result.directive?.protocol_modules as string[]).toContain("learnings");
  });

  test("after the last review pass, the step names the learnings question only for a correction, then the gate", () => {
    const note = reviewVerdictNote({
      kind: "learnings",
      report: "aidlc engine orchestrate report --stage user-stories --result revised",
      summary: false,
      brief: "aidlc engine orchestrate brief --stage user-stories",
    });
    expect(note).toContain("stage-protocol-learnings.md");
    expect(note).toContain("`aidlc engine orchestrate report --stage user-stories --result revised`");
    expect(note).toContain("or now when it has none");
    expect(note).toContain("ask the approval question.");
    expect(note).not.toContain("run the learnings ritual and ask its questions");
  });
});
