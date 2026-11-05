// covers: subcommand:aidlc-unit:preflight, subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:land

// A Unit that would not land was found out only after the person approved
// its merge: land refused on source conflicts with a Unit that landed after
// this one published, and pin refused a stage review that the Unit's merge of
// main had left stale. Each refusal sent the Unit back and cost the person a
// new approval. Pin now trial-merges the candidate with main before it asks
// the merge question, and `aidlc unit preflight` runs pin's checks and the
// trial merge in the Unit's own checkout, before it publishes.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readUnitMergeTransaction } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  gateAndLand,
  git,
  makeSeed,
  parallelDependencyBody,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

// The seed's src/shared.ts with one line changed.
function sharedWith(left: string, right = "base"): string {
  return `export const left = "${left}";\n` +
    'export const keep1 = "same";\n' +
    'export const keep2 = "same";\n' +
    'export const keep3 = "same";\n' +
    `export const right = "${right}";\n`;
}

// The Unit's checkout merges main, as a session does after a sibling landed:
// the remote's, or another checkout's that was not pushed. The Unit Progress
// table is engine metadata both sides change: it keeps main's and its own
// row, as the Unit's session resolves it.
function mergeMain(checkout: string, unit: string, from = "origin"): void {
  const statePath = seededStateFile(checkout);
  const ownRow = readFileSync(statePath, "utf-8").split(/\r?\n/).find((line) => line.startsWith(`| ${unit} |`))!;
  git(checkout, ["fetch", from, "main"]);
  try {
    git(checkout, ["merge", "--no-edit", "FETCH_HEAD"]);
  } catch {
    const stateRelative = statePath.slice(checkout.length + 1).replaceAll("\\", "/");
    expect(git(checkout, ["diff", "--name-only", "--diff-filter=U"])).toBe(stateRelative);
    git(checkout, ["checkout", "FETCH_HEAD", "--", stateRelative]);
    // Main's table has a column the Unit's row was written without.
    const merged = readFileSync(statePath, "utf-8");
    const columns = merged.split(/\r?\n/).find((line) => line.startsWith("| unit |"))!.split("|").length;
    const cells = ownRow.split("|");
    while (cells.length < columns) cells.splice(cells.length - 1, 0, " ");
    writeFileSync(statePath, merged.replace(new RegExp(`^\\| ${unit} \\|.*$`, "m"), cells.join("|")));
    git(checkout, ["add", stateRelative]);
    git(checkout, ["commit", "--no-edit"]);
  }
}

function preflight(checkout: string, unit: string): {
  land_ready: boolean;
  blockers: string[];
  notes: string[];
} {
  const run = runMergeTool(UNIT, ["preflight", unit], checkout);
  expect(run.status, run.out).toBe(0);
  return JSON.parse(run.stdout);
}

describe("t326 a team Unit's land-ready preflight", () => {
  test("a conflict with a Unit that landed since publish is named before the merge question", () => {
    const { seed, remote } = makeSeed(parallelDependencyBody());
    const alpha = prepareCandidate(remote, "alpha", "alpha-conflict", { sharedText: sharedWith("alpha") });
    prepareCandidate(remote, "beta", "beta-conflict", { sharedText: sharedWith("beta") });
    gateAndLand(seed, "beta");
    git(seed, ["push", "origin", "main"]);

    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).not.toBe(0);
    expect(pin.out).toContain('Unit \\"alpha\\" source conflicts: src/shared.ts.');
    expect(pin.out).toContain("merge origin/main");
    expect(pin.out).not.toContain("merge_gate");
    expect(readUnitMergeTransaction(seed, "alpha")).toBeNull();

    // The Unit's own checkout learns the same before it publishes again.
    const report = preflight(alpha.checkout, "alpha");
    expect(report.land_ready).toBe(false);
    expect(report.blockers.join(" ")).toContain('Unit "alpha" source conflicts: src/shared.ts.');
    expect(report.blockers.join(" ")).toContain("Merge origin/main here");
  });

  test("a review the merge of main left stale is named in the Unit's checkout before it publishes", () => {
    const { seed, remote } = makeSeed(parallelDependencyBody());
    const alpha = prepareCandidate(remote, "alpha", "alpha-stale", { sharedText: sharedWith("alpha") });
    prepareCandidate(remote, "beta", "beta-stale", { sharedText: sharedWith("base", "beta") });
    gateAndLand(seed, "beta");
    git(seed, ["push", "origin", "main"]);

    const before = preflight(alpha.checkout, "alpha");
    expect(before.land_ready, JSON.stringify(before)).toBe(true);
    expect(before.notes.join(" ")).toContain("merges cleanly");
    expect(before.notes.join(" ")).not.toContain("landing of");

    mergeMain(alpha.checkout, "alpha");
    // The merge's resolution brings the Unit's code summary up to date.
    const summary = join(seededRecordDir(alpha.checkout), "construction", "alpha", "code-generation", "code-summary.md");
    writeFileSync(summary, `${readFileSync(summary, "utf-8")}\nAlso reads beta's shared.ts change.\n`);
    git(alpha.checkout, ["commit", "-am", "merge main into alpha"]);

    const report = preflight(alpha.checkout, "alpha");
    expect(report.land_ready).toBe(false);
    expect(report.blockers.join(" ")).toContain("Code Generation has no review that stands for it");
    expect(report.blockers.join(" ")).toContain("have it reviewed again here");

    // What pin says when the Unit publishes anyway: the same review.
    expect(runMergeTool(UNIT, ["publish", "alpha"], alpha.checkout).status).toBe(0);
    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status).not.toBe(0);
    expect(pin.out).toContain("Code Generation has no review that stands for it as published");
  });

  test("a sibling's landing the branch merged from an unpushed main is named as the cause", () => {
    const { seed, remote } = makeSeed(parallelDependencyBody());
    const alpha = prepareCandidate(remote, "alpha", "alpha-unpushed", { sharedText: sharedWith("alpha") });
    prepareCandidate(remote, "beta", "beta-unpushed", { sharedText: sharedWith("base", "beta") });
    gateAndLand(seed, "beta");

    mergeMain(alpha.checkout, "alpha", seed);
    const report = preflight(alpha.checkout, "alpha");
    expect(report.land_ready).toBe(false);
    expect(report.notes.join(" ")).toContain('This branch holds the landing of "beta"');
    expect(report.notes.join(" ")).toContain("Push main from main's checkout");
    expect(report.blockers.join(" ")).toContain("construction/beta/");
  });
});
