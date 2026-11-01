// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land
//
// A team Unit claimed with the unit-end rhythm skips the step the team walk
// hands out (Infrastructure Design), as a team Unit's skip is taken. Its one
// gate, after Code Generation, then refused: it checked every per-Unit stage
// for its artifacts, the skipped one too, so `next` stopped at a
// guard-recovery question (REQUIRED_ARTIFACTS_MISSING for Infrastructure
// Design) whose only way out was Request Changes. The unit-end gate covers the
// stages the Unit ran: a stage skipped for the Unit is left out of its checks
// and of the approval row's Gate Stages, and the Unit lands.
//
// Mechanism: cli - spawns the shipped tools against a seeded team project, a
// bare remote and a claimed clone.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { seededAuditDir, seededStateFile } from "../harness/fixtures.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const STAGE = "infrastructure-design";
// Every per-Unit stage but Infrastructure Design is written; the walk hands
// that one out next.
const WORKED = ["functional-design", "nfr-requirements", "nfr-design", "code-generation"];
const REASON = "alpha is a pure library function: nothing to provision";

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

// The fixture writes the Unit's gate approved and its reviews shaped for pin,
// not for the walk's own review check: the gate is taken out so the case asks
// it, and reviews are off so the walk routes.
function ungated(checkout: string): void {
  for (const name of readdirSync(seededAuditDir(checkout))) {
    const path = join(seededAuditDir(checkout), name);
    const blocks = readFileSync(path, "utf-8").split(/(?=^## )/m);
    writeFileSync(path, blocks.filter((block) => !block.startsWith("## GATE_APPROVED")).join(""));
  }
  const statePath = seededStateFile(checkout);
  writeFileSync(
    statePath,
    readFileSync(statePath, "utf-8").replace(
      "- **Review Override**: adversarial",
      "- **Review Override**: none\n- **Plan Approval**: off (set by you)",
    ),
  );
}

function gateReport(checkout: string, args: string[]): Record<string, unknown> {
  const res = runMergeTool(ORCH, ["report", "--stage", "code-generation", "--unit", "alpha", ...args], checkout);
  expect(res.status, res.out).toBe(0);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

describe("t-team-unit-end-skipped-step: a unit-end gate leaves out the step skipped for the Unit", () => {
  test("the gate opens, takes Approve, records only the stages the Unit ran, and the Unit lands", () => {
    const { seed, remote } = teamSeed();
    prepareCandidate(remote, "alpha", "alpha-team", {
      unitEnd: true,
      stages: WORKED,
      beforeCommit: (checkout) => {
        ungated(checkout);
        const handed = nextDirective(checkout);
        expect(handed.stage, JSON.stringify(handed)).toBe(STAGE);
        const skipped = runMergeTool(ORCH, ["report", "--stage", STAGE, "--unit", "alpha", "--result", "skipped", "--reason", REASON], checkout);
        expect(JSON.parse(skipped.stdout).kind, skipped.out).toBe("done");

        const atGate = nextDirective(checkout);
        expect(atGate.ask_type, JSON.stringify(atGate)).not.toBe("guard-recovery");
        expect(atGate.stage, JSON.stringify(atGate)).toBe("code-generation");
        expect(gateReport(checkout, ["--result", "awaiting-approval"]).kind).toBe("print");
        expect(gateReport(checkout, ["--result", "approved", "--user-input", "Approve"]).kind).toBe("done");

        const approval = readAuditShardEvents(checkout)
          .filter((row) => row.event === "GATE_APPROVED" && auditBlockField(row.block, "Gate Scope") === "unit-end")
          .at(-1);
        expect(auditBlockField(approval?.block ?? "", "Gate Stages")?.split(",")).toEqual(WORKED);
        expect(String(nextDirective(checkout).message ?? "")).toContain('Unit "alpha" is complete and approved in this checkout.');
        // The engine's turn marker, which a real install's .gitignore keeps out.
        appendFileSync(join(checkout, ".git", "info", "exclude"), "**/.aidlc-engine/engine-touch\n");
      },
    });
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    expect(JSON.parse(pin.stdout).evidence.stages_skipped).toEqual([{ stage: STAGE, reason: REASON }]);
    gateAndLand(seed, "alpha");
    const cells = unitProgressRow(seed, "alpha").split("|").slice(1, -1).map((cell) => cell.trim());
    expect(cells.slice(2)).toEqual(cells.slice(2).map(() => "[x]"));
  });
});
