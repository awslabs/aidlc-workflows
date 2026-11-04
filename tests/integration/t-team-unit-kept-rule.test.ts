// covers: subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land, subcommand:aidlc-learnings:persist

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AIDLC_SRC, DEFAULT_SPACE } from "../harness/fixtures.ts";
import {
  UNIT,
  approveMerge,
  cleanupTempDirs,
  gateAndLand,
  git,
  makeSeed,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

// A person working a claimed Unit corrects the agent and keeps the correction
// as a rule for the project ("Yes, for this project"). The learning loop
// writes it to the space's project.md, outside the Unit's own folder, and the
// clone commits it with the Unit's work. Pin takes the Unit with the rule's
// file named among the files outside the Unit's folder, which the merge gate
// asks about, and the rule reaches main when the Unit lands.

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

const LEARNINGS = join(AIDLC_SRC, "tools", "aidlc-learnings.ts");
const RULE = "Name every payment amount in minor units";
const PROJECT_RULES = `aidlc/spaces/${DEFAULT_SPACE}/memory/project.md`;
const TEAM_RULES = `aidlc/spaces/${DEFAULT_SPACE}/memory/team.md`;

function keepRule(checkout: string, scope: "project" | "team", text: string): void {
  const surfaced = runMergeTool(
    LEARNINGS,
    ["surface", "--slug", "functional-design", "--correction", text],
    checkout,
  );
  expect(surfaced.status, surfaced.out).toBe(0);
  const { selections_file, space, intent } = JSON.parse(surfaced.stdout);
  mkdirSync(dirname(join(checkout, selections_file)), { recursive: true });
  writeFileSync(
    join(checkout, selections_file),
    JSON.stringify({
      stage_slug: "functional-design",
      space,
      intent,
      selections: [{ candidate_id: "c1", type: "learning", scope, heading: "Corrections", text }],
    }),
  );
  const persisted = runMergeTool(
    LEARNINGS,
    ["persist", "--slug", "functional-design", "--selections-json", selections_file],
    checkout,
  );
  expect(persisted.status, persisted.out).toBe(0);
}

describe("a rule kept in a claimed clone", () => {
  test("pin takes the Unit, names the rule's file, and the rule lands on main", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team", {
      beforeCommit: (checkout) => keepRule(checkout, "project", RULE),
    });

    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    expect(JSON.parse(pin.stdout).evidence.outside_unit_record_paths).toContain(PROJECT_RULES);

    gateAndLand(seed, "alpha");
    expect(readFileSync(join(seed, PROJECT_RULES), "utf-8")).toContain(RULE);
    expect(git(seed, ["status", "--porcelain"])).toBe("");
  });

  test("a rule kept for the team pins the same way", () => {
    const { seed, remote } = makeSeed();
    prepareCandidate(remote, "alpha", "alpha-team", {
      beforeCommit: (checkout) => keepRule(checkout, "team", RULE),
    });

    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
    expect(JSON.parse(pin.stdout).evidence.outside_unit_record_paths).toContain(TEAM_RULES);
  });

  // Two teams each keep a rule in the same place: the second meets the file
  // as it meets any shared file main changed since its claim.
  test("a second Unit's rule meets the first one's at land as a shared file does", () => {
    const { seed, remote } = makeSeed(parallelDependencyBody());
    prepareCandidate(remote, "alpha", "alpha-team", {
      beforeCommit: (checkout) => keepRule(checkout, "project", RULE),
    });
    prepareCandidate(remote, "beta", "beta-team", {
      beforeCommit: (checkout) => keepRule(checkout, "project", "Log every refund with its reason"),
    });
    gateAndLand(seed, "alpha");
    git(seed, ["push", "origin", "main"]);

    approveMerge(seed, "beta");
    const landed = runMergeTool(UNIT, ["land", "beta"], seed);
    expect(landed.status).not.toBe(0);
    expect(landed.out).toContain(`source conflicts: ${PROJECT_RULES}`);
    // Main is back where it was: alpha's rule, no merge left half done.
    expect(readFileSync(join(seed, PROJECT_RULES), "utf-8")).toContain(RULE);
    expect(git(seed, ["status", "--porcelain", "--", PROJECT_RULES, "src"])).toBe("");
    expect(spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: seed }).status).not.toBe(0);
  });
});
