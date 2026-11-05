// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-learnings:surface
//
// Under Unit Ownership: team a Unit's per-Unit stage runs in that Unit's own
// claimed checkout, which commits only the Unit's record tree
// (`construction/<unit>/`; publish leaves the record's shared files out). The
// run-stage directive still named the stage-level
// `construction/<stage>/memory.md` as the diary, so
// the agent was told to keep its notes in a file its checkout cannot land, and
// the learnings step at the Unit's gate counted that same file's entries. The diary is now
// the Unit's own `construction/<unit>/<stage>/memory.md`, the path a per-Unit
// wave entry already uses, and the learnings step counts it there. A directive
// that names no Unit (the skeleton-stance ask before the Unit's first stage)
// takes the claimed checkout's Unit too, and never creates the stage-level
// diary, which publish would leave out. On main working the Units unclaimed it
// stays main's own stage-level diary.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { relativeRecordDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  clone,
  asLeadsOwnCheckout,
  makeSeed,
  nextDirective,
  parallelDependencyBody,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const LEARNINGS = join(AIDLC_SRC, "tools", "aidlc-learnings.ts");

function claimedCheckout(unit: string): string {
  const { remote } = makeSeed(parallelDependencyBody());
  const checkout = clone(remote, `${unit}-team`);
  const claim = runMergeTool(UNIT, ["claim", unit, "--team", `${unit}-team`], checkout);
  expect(claim.status, claim.out).toBe(0);
  writeFileSync(
    seededStateFile(checkout),
    readFileSync(seededStateFile(checkout), "utf-8").replace(
      "- **Unit Gate Rhythm**: per-stage",
      "- **Unit Gate Rhythm**: per-stage\n- **Skeleton Stance**: on",
    ),
  );
  return checkout;
}

describe("t-team-unit-stage-diary a team Unit keeps its stage diary in its own record tree", () => {
  test("the run-stage directive names the Unit's own diary, not the stage-level one", () => {
    const checkout = claimedCheckout("alpha");
    const directive = nextDirective(checkout);
    expect(directive).toMatchObject({ kind: "run-stage", stage: "functional-design", unit: "alpha" });
    const prefix = relativeRecordDir(checkout);
    expect(directive.memory_path).toBe(`${prefix}/construction/alpha/functional-design/memory.md`);
  });

  test("a directive that names no Unit takes the claimed Unit's diary and creates no stage-level one", () => {
    const { remote } = makeSeed(parallelDependencyBody());
    const checkout = clone(remote, "alpha-team");
    const claim = runMergeTool(UNIT, ["claim", "alpha", "--team", "alpha-team"], checkout);
    expect(claim.status, claim.out).toBe(0);
    // The diary is bootstrapped from the installed template.
    const shared = join(checkout, ".claude", "knowledge", "aidlc-shared");
    mkdirSync(shared, { recursive: true });
    copyFileSync(join(AIDLC_SRC, "knowledge", "aidlc-shared", "memory-template.md"), join(shared, "memory-template.md"));
    // No skeleton stance yet: the first directive asks for it and names no Unit.
    const directive = nextDirective(checkout);
    expect(directive).toMatchObject({ kind: "run-stage", stage: "functional-design" });
    expect(directive.unit).toBeUndefined();
    const prefix = relativeRecordDir(checkout);
    expect(directive.memory_path).toBe(`${prefix}/construction/alpha/functional-design/memory.md`);
    expect(existsSync(join(checkout, prefix!, "construction", "functional-design", "memory.md"))).toBe(false);
  });

  test("on main working the Units unclaimed, a directive that names no Unit keeps main's own stage diary", () => {
    const { remote } = makeSeed(parallelDependencyBody());
    const checkout = clone(remote, "main-no-stance");
    asLeadsOwnCheckout(checkout);
    const shared = join(checkout, ".claude", "knowledge", "aidlc-shared");
    mkdirSync(shared, { recursive: true });
    copyFileSync(join(AIDLC_SRC, "knowledge", "aidlc-shared", "memory-template.md"), join(shared, "memory-template.md"));
    const directive = nextDirective(checkout);
    expect(directive).toMatchObject({ kind: "run-stage", stage: "functional-design" });
    expect(directive.unit).toBeUndefined();
    const prefix = relativeRecordDir(checkout);
    expect(directive.memory_path).toBe(`${prefix}/construction/functional-design/memory.md`);
    expect(existsSync(join(checkout, prefix!, "construction", "functional-design", "memory.md"))).toBe(true);
  });

  test("on main working the Units unclaimed, the directive and the learnings step use the same Unit diary", () => {
    const { remote } = makeSeed(parallelDependencyBody());
    const checkout = clone(remote, "main-unclaimed");
    asLeadsOwnCheckout(checkout);
    writeFileSync(
      seededStateFile(checkout),
      readFileSync(seededStateFile(checkout), "utf-8").replace(
        "- **Unit Gate Rhythm**: per-stage",
        "- **Unit Gate Rhythm**: per-stage\n- **Skeleton Stance**: on",
      ),
    );
    // With a remote, the walk first asks whether to share the plan with the
    // teams; "Build them here for now" runs next and the walk goes on.
    expect(nextDirective(checkout)).toMatchObject({ kind: "ask", ask_type: "team-handover", handovers: ["share"] });
    const directive = nextDirective(checkout);
    expect(directive).toMatchObject({ kind: "run-stage", stage: "functional-design" });
    const unit = directive.unit as string;
    expect(typeof unit).toBe("string");
    const prefix = relativeRecordDir(checkout);
    expect(directive.memory_path).toBe(`${prefix}/construction/${unit}/functional-design/memory.md`);
    const unitDiary = join(checkout, prefix!, "construction", unit, "functional-design");
    mkdirSync(unitDiary, { recursive: true });
    writeFileSync(join(unitDiary, "memory.md"), "## Tradeoffs\n- Took the shorter list over the grid\n");
    const surfaced = runMergeTool(
      LEARNINGS,
      ["surface", "--slug", "functional-design", "--unit", unit],
      checkout,
    );
    expect(surfaced.status, surfaced.out).toBe(0);
    const out = JSON.parse(surfaced.stdout) as { memory_entries_total: number };
    expect(out.memory_entries_total).toBe(1);
  });

  test("the learnings step at the Unit's gate counts the Unit's own diary", () => {
    const checkout = claimedCheckout("beta");
    const prefix = relativeRecordDir(checkout);
    const unitDiary = join(checkout, prefix!, "construction", "beta", "functional-design");
    mkdirSync(unitDiary, { recursive: true });
    writeFileSync(
      join(unitDiary, "memory.md"),
      "## Interpretations\n- Kept the profile form to one page, as the person asked\n",
    );
    const surfaced = runMergeTool(LEARNINGS, ["surface", "--slug", "functional-design"], checkout);
    expect(surfaced.status, surfaced.out).toBe(0);
    const out = JSON.parse(surfaced.stdout) as { phase: string; memory_entries_total: number };
    expect(out.phase).toBe("construction");
    expect(out.memory_entries_total).toBe(1);
  });
});
