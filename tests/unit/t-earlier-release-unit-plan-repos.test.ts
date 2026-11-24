// covers: subcommand:aidlc-state:approve, subcommand:aidlc-orchestrate:report, function:classifyStateVersion
//
// Work one person builds across repos, planned on this release: its approved
// Unit plan names each Unit's likely repos (`repos:` lines), which an AI-DLC
// from 2.11.0 to 2.11.4 cannot read. When a second computer or a teammate on
// such a release opens the work, its own engine reads the State Version first
// and the Unit plan only past it. Read at 8, that older reader refuses the
// block and its step tells the agent to write the approved Unit plan again
// without those lines. So the approval of such a plan writes 9 in the same
// write (as it does for any `repos:` line under a Unit, an empty list too),
// and the older release stops at its own line to update first, before it
// reads the plan. Its gate and reader are in
// tests/fixtures/unit-plan-gate-2.11.0, made by generate.ts there from
// `git show v2.11.0:...` with comment-only lines left out and characters
// outside printable ASCII written as escapes; the hashes below are that
// output, and the three functions hash the same on v2.11.0 to v2.11.3
// (`generate.ts --hashes <tags>`). On v2.11.4 two differ in nothing read here:
// classifyStateVersion's line for an older State Version is shorter, and
// parseBoltDag takes its parser's error text without errorMessage; the line
// at 9, the refusal of a `repos:` line and its step are the same. The
// approval runs as the agent's report runs it, and as a direct state approve.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { declaration, hash, MARKER, PINNED_FUNCTIONS } from "../fixtures/unit-plan-gate-2.11.0/generate.ts";
import { classifyStateVersion, parseBoltDag, unitsBlockRepair } from "../fixtures/unit-plan-gate-2.11.0/unit-plan-gate.ts";
import { REPO_ROOT, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { cleanupTeamBuild, ORCH, run, STATE } from "../harness/team-build.ts";
import { AT_THE_UNITS_GATE, soloAtTheUnitsGate } from "../harness/team-unit-replan.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTeamBuild);

const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "unit-plan-gate-2.11.0", "unit-plan-gate.ts");
// sha256 of generate.ts's output from v2.11.0, below its marker line.
const BODY = "16ce3139c59452bac59dd65d510fbb1a33630ffbfe16e272685b57806e069918";
// The same on v2.11.0 to v2.11.3 (v2.11.4: see the header).
const FUNCTIONS: Record<string, string> = {
  classifyStateVersion: "4ada5158cb998daa8631c290446db95f85601a631b7542b49b1b4d07d249eb56",
  parseBoltDag: "15d9939104725b393d5c96e04b1aaf1d8fface6cced92f8e7a4e91b591e33746",
  parseUnitsBlock: "f063d328f31c9e0c8902e0ba4810be5bae2022112002fe0162970b083f79b10a",
};

// The Unit plan as Units Generation writes it for work across repos.
const UNIT_PLAN = "# Unit dependencies\n\n```yaml\nunits:\n" +
  "  - name: refunds\n    kind: service\n    repos: [app]\n    depends_on: []\n" +
  "  - name: reporting\n    kind: service\n    repos: [app]\n    depends_on: [refunds]\n```\n";

const read = (path: string): string => readFileSync(path, "utf-8").replace(/\r\n/g, "\n");

// What an older AI-DLC's next does with the work: its State Version gate
// first, its Unit plan reader only past the gate.
function olderReads(dir: string): string {
  const verdict = classifyStateVersion(read(seededStateFile(dir)));
  if (verdict.kind !== "ok") return verdict.message;
  const parsed = parseBoltDag(read(join(seededRecordDir(dir), "inception", "units-generation", "unit-of-work-dependency.md")));
  return parsed.ok ? "reads the Units" : unitsBlockRepair(parsed.reason, parsed.detail);
}

const stateVersion = (dir: string): string | undefined => /^- \*\*State Version\*\*: (\S+)$/m.exec(read(seededStateFile(dir)))?.[1];

const APPROVALS: Array<[string, string, string[]]> = [
  ["the agent's report", ORCH, ["report", "--stage", "units-generation", "--result", "approved", "--user-input", "Approve"]],
  ["a direct state approve", STATE, ["approve", "units-generation", "--user-input", "Approve"]],
];

describe("an AI-DLC from 2.11.0 to 2.11.4 opens work one person builds across repos, planned on this release", () => {
  test("the copied State Version gate and Unit plan reader are those releases' own", () => {
    const fixture = read(FIXTURE);
    const at = fixture.indexOf(`${MARKER}\n`);
    expect(at).toBeGreaterThan(0);
    expect(hash(fixture.slice(at + MARKER.length + 1))).toBe(BODY);
    expect(PINNED_FUNCTIONS.map((name) => [name, hash(declaration(fixture, name))])).toEqual(Object.entries(FUNCTIONS));
  });

  test.each(APPROVALS)("after %s of a Unit plan with repos lines, it stops at its own line and never reads the plan", (_how, tool, args) => {
    const dir = soloAtTheUnitsGate(UNIT_PLAN);
    const plan = join(seededRecordDir(dir), "inception", "units-generation", "unit-of-work-dependency.md");
    const approved = run(tool, args, dir, { ...AT_THE_UNITS_GATE, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: tool === STATE ? "1" : "0" });
    expect(approved.status, approved.out).toBe(0);
    expect(read(seededStateFile(dir)), approved.out).toMatch(/^- \[x\] units-generation /m);
    expect(olderReads(dir)).toBe(
      "Incompatible workflow state: State Version 9 is newer than the current v8 stage graph this build understands, " +
        "so it cannot be advanced safely. Upgrade the framework to a build that ships state schema v9 (or newer), or " +
        "finish this workflow on the shell that produced it. Run `/aidlc --doctor` for the full diagnosis.",
    );
    expect(stateVersion(dir)).toBe("9");
    // The approved Unit plan is as approved.
    expect(read(plan)).toBe(UNIT_PLAN);
  });

  // What the gate keeps it from: the same plan read at 8, before the approval.
  test("before the approval, at 8, its Unit plan reader would have the agent write the approved plan again", () => {
    const dir = soloAtTheUnitsGate(UNIT_PLAN);
    expect(stateVersion(dir)).toBe("8");
    expect(olderReads(dir)).toStartWith(
      "The units block in inception/units-generation/unit-of-work-dependency.md cannot be read " +
        "(malformed: unrecognised line in units block: repos: [app]), and Construction walks its Units from it.",
    );
  });
});
