// covers: subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land
//
// A Unit's kind decides which Construction documents apply to it: Functional
// Design writes nothing for a `packaging` Unit. The walk settles such a stage
// for the Unit with no directive, so the Unit never earns a UNIT_COMPLETED
// receipt or a review for it. Pin still asked for both, so a team packaging
// Unit could never be pinned: "Pinned candidate evidence is incomplete:
// UNIT_COMPLETED receipts, reviewer READY receipts (functional-design)". Pin
// now settles a stage the Unit's kind owes nothing as the walk does, and the
// landed row shows it done.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  UNIT,
  cleanupTempDirs,
  gateAndLand,
  makeSeed,
  prepareCandidate,
  runMergeTool,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

function packagingDependencyBody(): string {
  return `# Unit dependencies

\`\`\`yaml
units:
  - name: skeleton
    depends_on: []
  - name: alpha
    kind: packaging
    depends_on: [skeleton]
  - name: beta
    depends_on: [alpha]
\`\`\`
`;
}

// Every per-Unit stage but Functional Design, which a packaging Unit owes nothing.
const OWED = ["nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];

describe("t-team-unit-kind-vacuous-stage: a stage the Unit's kind owes nothing needs no receipt at pin", () => {
  test("pin takes a packaging Unit that has no Functional Design receipt or review", () => {
    const { seed, remote } = makeSeed(packagingDependencyBody());
    prepareCandidate(remote, "alpha", "alpha-team", { stages: OWED });
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    const evidence = JSON.parse(pin.stdout).evidence as { reviewers_expected: string[] };
    expect(evidence.reviewers_expected).not.toContain("functional-design");
  });

  test("it lands, and the row shows the stage done", () => {
    const { seed, remote } = makeSeed(packagingDependencyBody());
    prepareCandidate(remote, "alpha", "alpha-team", { stages: OWED });
    gateAndLand(seed, "alpha");
    const row = unitProgressRow(seed, "alpha").split("|").slice(1, -1).map((cell) => cell.trim());
    expect(row.slice(2, 7)).toEqual(["[x]", "[x]", "[x]", "[x]", "[x]"]);
  });
});
