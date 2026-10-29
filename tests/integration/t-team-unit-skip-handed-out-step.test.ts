// covers: subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next, subcommand:aidlc-state:skip, subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land, audit:UNIT_SKIPPED
//
// A team works its claimed Unit in its own checkout. After NFR Design the
// engine hands out Infrastructure Design for the Unit, the agent judges the
// stage does not apply (no infrastructure) and reports the skip. The engine
// refused it, before the step was started and again right after `unit start`:
// "a step can be skipped only while it is the step in progress for one of your
// units", because the skip report read only the solo Unit walk. Two turns went
// by with no progress on every Claude Code leg of the team-Unit proofs. The
// skip of the step the team walk handed out is now taken, recorded for that
// Unit, travels with its published work, and pin, gate and land take the
// stage as one the Unit owes nothing. A Unit whose files for the step are
// already written still stops the agent's own skip with its own line.
//
// Mechanism: cli - spawns the shipped tools against a seeded team project, a
// bare remote and a claimed clone.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ORCH,
  STATE,
  UNIT,
  cleanupTempDirs,
  gateAndLand,
  git,
  makeSeed,
  nextDirective,
  prepareCandidate,
  runMergeTool,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";
import { seededAuditDir, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  artifactFilename,
  auditBlockField,
  loadStageGraphAll,
  PERSON_ASKED_SKIP_REASON,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const STAGE = "infrastructure-design";
// Every per-Unit stage but Infrastructure Design: its documents, receipts,
// reviews and approvals are written; Infrastructure Design is the step the
// team walk hands out next.
const WORKED = ["functional-design", "nfr-requirements", "nfr-design", "code-generation"];
const AGENT_REASON = "alpha is a pure library function: nothing to provision, no network, no storage";
const STALE_POINTER = /message (above|it showed)|showed you|the step it shows/i;

function skipReport(checkout: string, extra: string[], reason = AGENT_REASON) {
  return runMergeTool(ORCH, ["report", "--stage", STAGE, ...extra, "--result", "skipped", "--reason", reason], checkout);
}

function handedOut(checkout: string): void {
  const step = nextDirective(checkout);
  expect(step.kind, JSON.stringify(step)).toBe("run-stage");
  expect(step.stage).toBe(STAGE);
  expect(step.unit).toBe("alpha");
}

function unitSkips(checkout: string): string[] {
  return readAuditShardEvents(checkout)
    .filter((row) => row.event === "UNIT_SKIPPED" && auditBlockField(row.block, "Stage") === STAGE)
    .map((row) => `${auditBlockField(row.block, "Unit")}@${auditBlockField(row.block, "Attempt Generation")}`);
}

// The project's main with its skeleton stance answered, as a run has it when
// a team claims a Unit, so the claimed checkout's walk hands out the Unit's
// steps.
function teamSeed(): { seed: string; remote: string } {
  const made = makeSeed();
  const statePath = seededStateFile(made.seed);
  writeFileSync(
    statePath,
    readFileSync(statePath, "utf-8").replace("- **State Version**: 8", "- **State Version**: 8\n- **Skeleton Stance**: on"),
  );
  git(made.seed, ["commit", "-am", "skeleton stance"]);
  git(made.seed, ["push", "origin", "main"]);
  return made;
}

function writeStageFiles(checkout: string): void {
  const stage = loadStageGraphAll().find((entry) => entry.slug === STAGE)!;
  const dir = join(seededRecordDir(checkout), "construction", "alpha", STAGE);
  mkdirSync(dir, { recursive: true });
  for (const name of stage.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n\nwritten\n`);
}

describe("t-team-unit-skip-handed-out-step: a team Unit's skip of the step the engine handed out is taken", () => {
  test("taken right after the step is handed out, recorded for the Unit's claim, and the walk goes on", () => {
    const { remote } = teamSeed();
    let generation = 0;
    prepareCandidate(remote, "alpha", "alpha-team", {
      stages: WORKED,
      beforeCommit: (checkout) => {
        handedOut(checkout);
        const skipped = skipReport(checkout, ["--unit", "alpha"]);
        expect(skipped.status, skipped.out).toBe(0);
        expect(JSON.parse(skipped.stdout).kind, skipped.out).toBe("done");
        // The claimed checkout walks alpha only: the line says nothing of other Units.
        expect(JSON.parse(skipped.stdout).reason).toBe('Skipped "infrastructure-design" for unit "alpha". Run next to continue.');
        generation = Number(JSON.parse(readFileSync(join(checkout, "aidlc", ".aidlc-unit-scope.json"), "utf-8")).generation);
        expect(unitSkips(checkout)).toEqual([`alpha@${generation}`]);
        // The stage is the Unit's to skip, not the checkout's: no [S] on it.
        expect(readFileSync(seededStateFile(checkout), "utf-8")).not.toMatch(/^- \[S\] infrastructure-design/m);
        // No summary, review or approval is asked for the skipped step: the
        // claimed Unit is done in this checkout.
        const after = nextDirective(checkout);
        expect(String(after.message ?? after.reason ?? ""), JSON.stringify(after)).toContain(
          'Unit "alpha" is complete and approved in this checkout.',
        );
        const cells = unitProgressRow(checkout, "alpha").split("|").slice(1, -1).map((cell) => cell.trim());
        expect(cells.slice(2)).toEqual(["[x]", "[x]", "[x]", "[x]", "[x]", "[x]"]);
      },
    });
    expect(generation).toBeGreaterThan(0);
  });

  test("taken right after `unit start` for that step too", () => {
    const { remote } = teamSeed();
    prepareCandidate(remote, "alpha", "alpha-team", {
      stages: WORKED,
      beforeCommit: (checkout) => {
        handedOut(checkout);
        const started = runMergeTool(STATE, ["unit", "start", "--stage", STAGE, "--unit", "alpha"], checkout);
        expect(started.status, started.out).toBe(0);
        const skipped = skipReport(checkout, ["--unit", "alpha"]);
        expect(skipped.status, skipped.out).toBe(0);
        expect(JSON.parse(skipped.stdout).kind, skipped.out).toBe("done");
        expect(unitSkips(checkout)).toHaveLength(1);
      },
    });
  });

  test("the person's skip, as the plan-change step names it with no Unit, is taken for the claimed Unit", () => {
    const { remote } = teamSeed();
    prepareCandidate(remote, "alpha", "alpha-team", {
      stages: WORKED,
      beforeCommit: (checkout) => {
        handedOut(checkout);
        const skipped = skipReport(checkout, [], PERSON_ASKED_SKIP_REASON);
        expect(skipped.status, skipped.out).toBe(0);
        expect(JSON.parse(skipped.stdout).kind, skipped.out).toBe("done");
        expect(unitSkips(checkout)).toHaveLength(1);
        expect(readFileSync(seededStateFile(checkout), "utf-8")).not.toMatch(/^- \[S\] infrastructure-design/m);
      },
    });
  });

  test("a Unit whose files for the step are written still stops the agent's skip with its own line; the person's skip goes through", () => {
    const { remote } = teamSeed();
    prepareCandidate(remote, "alpha", "alpha-team", {
      stages: WORKED,
      beforeCommit: (checkout) => {
        writeStageFiles(checkout);
        const own = skipReport(checkout, ["--unit", "alpha"]);
        const refusal = String(JSON.parse(own.stdout).message ?? "");
        expect(JSON.parse(own.stdout).kind, own.out).toBe("error");
        expect(refusal).toContain("that unit's files for this step are already written");
        expect(refusal).not.toMatch(STALE_POINTER);
        expect(unitSkips(checkout)).toEqual([]);
        const asked = skipReport(checkout, ["--unit", "alpha"], PERSON_ASKED_SKIP_REASON);
        expect(JSON.parse(asked.stdout).kind, asked.out).toBe("done");
        expect(unitSkips(checkout)).toHaveLength(1);
      },
    });
  });

  test("a skip naming another step says the step in progress and how to skip it, in its own words", () => {
    const { remote } = teamSeed();
    prepareCandidate(remote, "alpha", "alpha-team", {
      stages: WORKED,
      beforeCommit: (checkout) => {
        handedOut(checkout);
        const other = runMergeTool(ORCH, [
          "report", "--stage", "nfr-design", "--unit", "alpha", "--result", "skipped", "--reason", AGENT_REASON,
        ], checkout);
        const refusal = String(JSON.parse(other.stdout).message ?? "");
        expect(JSON.parse(other.stdout).kind, other.out).toBe("error");
        expect(refusal).toContain('the step in progress is "infrastructure-design" for unit "alpha"');
        expect(refusal).toContain("report --stage infrastructure-design --unit alpha --result skipped");
        expect(refusal).not.toMatch(STALE_POINTER);
        // The checkout's own Unit is the step's: the skip it names is taken.
        const skipped = skipReport(checkout, ["--unit", "alpha"]);
        expect(JSON.parse(skipped.stdout).kind, skipped.out).toBe("done");
      },
    });
  });

  test("publish carries the skip, pin takes the stage as owing nothing, and the Unit lands with its row done", () => {
    const { seed, remote } = teamSeed();
    // The skip is reported without a `next` first: the beat is the team walk's
    // either way, and the fixture's claimed row keeps the owner it was given.
    const { auditShard } = prepareCandidate(remote, "alpha", "alpha-team", {
      stages: WORKED,
      beforeCommit: (checkout) => {
        const skipped = skipReport(checkout, ["--unit", "alpha"]);
        expect(JSON.parse(skipped.stdout).kind, skipped.out).toBe("done");
        // The engine's turn marker, which a real install's .gitignore keeps out
        // with the rest of the record's engine folder.
        appendFileSync(join(checkout, ".git", "info", "exclude"), "**/.aidlc-engine/engine-touch\n");
      },
    });
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    const pinned = JSON.parse(pin.stdout) as { evidence: {
      stages_completed: string[];
      stages_skipped?: Array<{ stage: string; reason: string }>;
      reviewers_expected: string[];
      gates_expected: string[];
      artifact_paths: string[];
    }; merge_gate: Record<string, string> };
    const evidence = pinned.evidence;
    // Not counted as done: the merge question says it was skipped, and why.
    expect(evidence.stages_completed).not.toContain(STAGE);
    expect(evidence.stages_skipped).toEqual([{ stage: STAGE, reason: AGENT_REASON }]);
    expect(pinned.merge_gate.skipped_steps).toBe(
      `Unit "alpha" skipped Infrastructure Design (${AGENT_REASON}). Say so in the question, in one line.`,
    );
    expect(evidence.reviewers_expected).not.toContain(STAGE);
    expect(evidence.gates_expected).not.toContain(STAGE);
    expect(evidence.artifact_paths.some((path) => path.includes(`/${STAGE}/`))).toBe(false);
    gateAndLand(seed, "alpha");
    const cells = unitProgressRow(seed, "alpha").split("|").slice(1, -1).map((cell) => cell.trim());
    expect(cells.slice(2)).toEqual(cells.slice(2).map(() => "[x]"));
    // The landed shard carries the Unit's skip.
    const landed = readFileSync(join(seededAuditDir(seed), auditShard), "utf-8");
    expect(landed).toContain("Unit Skipped");
  });
});
