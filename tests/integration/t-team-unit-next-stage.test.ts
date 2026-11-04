// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// The Approve option of a team Unit's gate reads "Continue to <next_stage>".
// next_stage was the next stage in plan order, so in the checkout that claimed
// the Unit its last step's gate named Build and Test. What follows that step
// there is the Unit's landing (publish here, then pin, the merge gate and
// land); Build and Test runs once, after every Unit lands. The gate now says
// so, and an earlier step's gate names the Unit's next step: the next one its
// kind owes, not the next in plan order.
//
// Mechanism: cli - spawns the shipped tools against a seeded team project, a
// bare remote and a claimed clone.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ORCH,
  cleanupTempDirs,
  git,
  makeSeed,
  nextDirective,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";
import { seededAuditDir, seededStateFile } from "../harness/fixtures.ts";
import { auditShardName } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const LANDING = "landing Unit alpha";

// The project's main with its skeleton stance answered, as a run has it when
// a team claims a Unit, so the claimed checkout's walk hands out the Unit's
// steps.
function teamSeed(dependencies?: string): { seed: string; remote: string } {
  const made = makeSeed(dependencies);
  const statePath = seededStateFile(made.seed);
  writeFileSync(
    statePath,
    readFileSync(statePath, "utf-8").replace("- **State Version**: 8", "- **State Version**: 8\n- **Skeleton Stance**: on"),
  );
  git(made.seed, ["commit", "-am", "skeleton stance"]);
  git(made.seed, ["push", "origin", "main"]);
  return made;
}

// The Unit's work for the stage is done; its approval is not given yet, so
// the walk stops at the stage's gate. The harness's review records are shaped
// for pin, not for the gate's own review check, so reviews are off here.
function gateOpen(checkout: string, stage: string): void {
  const state = seededStateFile(checkout);
  writeFileSync(
    state,
    readFileSync(state, "utf-8").replace("- **Review Override**: adversarial", "- **Review Override**: none"),
  );
  const shard = join(seededAuditDir(checkout), auditShardName(checkout));
  const blocks = readFileSync(shard, "utf-8").split(/(?=^## )/m);
  writeFileSync(
    shard,
    blocks.filter((block) => !(block.startsWith("## GATE_APPROVED") && block.includes(`**Stage**: ${stage}\n`))).join(""),
  );
}

function specDependencyBody(): string {
  return `# Unit dependencies

\`\`\`yaml
units:
  - name: skeleton
    depends_on: []
  - name: alpha
    kind: spec
    depends_on: [skeleton]
  - name: beta
    depends_on: [alpha]
\`\`\`
`;
}

function report(checkout: string, args: string[]): Record<string, unknown> {
  const res = runMergeTool(ORCH, ["report", ...args], checkout);
  expect(res.status, res.out).toBe(0);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}

describe("t-team-unit-next-stage: a team Unit's last step is followed by its landing", () => {
  test("the Code Generation gate in the claimed checkout names the Unit's landing, not Build and Test", () => {
    const { remote } = teamSeed();
    prepareCandidate(remote, "alpha", "alpha-team", {
      beforeCommit: (checkout) => {
        gateOpen(checkout, "code-generation");
        const gate = nextDirective(checkout);
        expect(gate, JSON.stringify(gate)).toMatchObject({ stage: "code-generation", unit: "alpha", gate: true });
        expect(gate.next_stage).toBe(LANDING);
        // The reply that opens the gate names the next step, else the gate's does.
        const opened = report(checkout, ["--stage", "code-generation", "--unit", "alpha", "--result", "awaiting-approval"]);
        expect(opened.next_stage ?? gate.next_stage, JSON.stringify(opened)).toBe(LANDING);
      },
    });
  });

  test("an earlier step's gate names the next step the Unit's kind owes", () => {
    // A spec Unit owes no Infrastructure Design: its step after NFR Design is Code Generation.
    const { remote } = teamSeed(specDependencyBody());
    prepareCandidate(remote, "alpha", "alpha-team", {
      stages: ["functional-design", "nfr-requirements", "nfr-design"],
      beforeCommit: (checkout) => {
        gateOpen(checkout, "nfr-design");
        const gate = nextDirective(checkout);
        expect(gate, JSON.stringify(gate)).toMatchObject({ stage: "nfr-design", unit: "alpha", gate: true });
        expect(gate.next_stage).toBe("Code Generation");
      },
    });
  });
});
