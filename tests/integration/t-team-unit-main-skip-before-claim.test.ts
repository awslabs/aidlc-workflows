// covers: subcommand:aidlc-unit:claim, subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land, audit:UNIT_SKIPPED
//
// On a main that hands its Units to teams, the person skips a per-Unit step
// before any team has claimed a Unit. With no Unit named, the skip reaches
// every Unit: main records a UNIT_SKIPPED row for each, with no attempt. A
// claimed checkout reads only its own attempt's rows, so the team that then
// claimed a Unit was handed the skipped step again, and the person's skip was
// lost without a word. The claim now records main's skip for its attempt: the
// Unit's walk passes the step, and pin and the merge question read it as
// skipped, with the person's reason.
//
// Mechanism: cli - spawns the shipped tools against a seeded team project, a
// bare remote and a claimed clone.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ORCH,
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
import { seededStateFile } from "../harness/fixtures.ts";
import {
  auditBlockField,
  PERSON_ASKED_SKIP_REASON,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const STAGE = "functional-design";
const WORKED = ["nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];

function unitSkips(checkout: string): string[] {
  return readAuditShardEvents(checkout)
    .filter((row) => row.event === "UNIT_SKIPPED" && auditBlockField(row.block, "Stage") === STAGE)
    .map((row) => `${auditBlockField(row.block, "Unit")}@${auditBlockField(row.block, "Attempt Generation") ?? "main"}`);
}

// The team's main with its skeleton stance answered, where the person skips
// Functional Design for every Unit before any team claims one.
function mainSkippedBeforeClaim(): { seed: string; remote: string } {
  const made = makeSeed();
  const statePath = seededStateFile(made.seed);
  writeFileSync(
    statePath,
    readFileSync(statePath, "utf-8").replace("- **State Version**: 8", "- **State Version**: 8\n- **Skeleton Stance**: on"),
  );
  const skipped = runMergeTool(
    ORCH,
    ["report", "--stage", STAGE, "--result", "skipped", "--reason", PERSON_ASKED_SKIP_REASON],
    made.seed,
  );
  expect(skipped.status, skipped.out).toBe(0);
  expect(JSON.parse(skipped.stdout).reason).toBe('Skipped "functional-design" for unit "alpha", unit "beta". Run next to continue.');
  expect(unitSkips(made.seed)).toEqual(["alpha@main", "beta@main"]);
  git(made.seed, ["add", "-A"]);
  git(made.seed, ["commit", "-m", "skip functional design for every Unit"]);
  git(made.seed, ["push", "origin", "main"]);
  return made;
}

describe("t-team-unit-main-skip-before-claim: a step skipped on main before any claim stays skipped for the claimed Unit", () => {
  test("the claimed Unit's walk starts after the skipped step, and the claim records the skip for its attempt", () => {
    const { remote } = mainSkippedBeforeClaim();
    prepareCandidate(remote, "alpha", "alpha-team", {
      stages: WORKED,
      publish: false,
      afterClaim: (checkout) => {
        const generation = Number(
          JSON.parse(readFileSync(join(checkout, "aidlc", ".aidlc-unit-scope.json"), "utf-8")).generation,
        );
        // Main's row for alpha, and the claim's own for its attempt; beta's
        // skip stays main's until a team claims beta.
        expect(unitSkips(checkout)).toEqual(["alpha@main", "beta@main", `alpha@${generation}`]);
        const step = nextDirective(checkout);
        expect(step.kind, JSON.stringify(step)).toBe("run-stage");
        expect(step.unit).toBe("alpha");
        expect(step.stage).toBe("nfr-requirements");
      },
    });
  });

  test("pin reads the step as skipped with the person's reason, and the Unit lands with its row done", () => {
    const { seed, remote } = mainSkippedBeforeClaim();
    prepareCandidate(remote, "alpha", "alpha-team", {
      stages: WORKED,
      beforeCommit: (checkout) => {
        // The engine's turn marker, which a real install's .gitignore keeps out
        // with the rest of the record's engine folder.
        appendFileSync(join(checkout, ".git", "info", "exclude"), "**/.aidlc-engine/engine-touch\n");
      },
    });
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    const evidence = JSON.parse(pin.stdout).evidence as {
      stages_completed: string[];
      stages_skipped?: Array<{ stage: string; reason: string }>;
    };
    expect(evidence.stages_completed).not.toContain(STAGE);
    expect(evidence.stages_skipped).toEqual([{ stage: STAGE, reason: PERSON_ASKED_SKIP_REASON }]);
    gateAndLand(seed, "alpha");
    const cells = unitProgressRow(seed, "alpha").split("|").slice(1, -1).map((cell) => cell.trim());
    expect(cells.slice(2)).toEqual(cells.slice(2).map(() => "[x]"));
  });
});
