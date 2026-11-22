// covers: cli:aidlc-utility(intent add-checkout, intent remove-checkout), function:handleIntentCheckouts, function:readRecordedSourceCheckouts, function:writeRecordedSourceCheckouts, function:sourceWalkReach, function:recordUnitClaimCheckouts, function:walkSourceCheckouts, function:registryExcludedSourceKeys
//
// A checkout the work's code is kept in where the review would not see it (a
// worktree in the harness folder, or one outside the project) is recorded by
// name: by `intent add-checkout <path>`, or by a Unit's claim inside it at the
// review request. The record is per clone, never asks, and is undone by
// `remove-checkout`. The one source identity then walks the checkout, its files
// listed as `<label>@checkout/<path>`; an empty record changes no fingerprint,
// AI-DLC's own records in a same-repo worktree stay out of it, and 400 other
// worktrees in the harness folder are never walked. A cache in the checkout is
// left out by the exclude in the checkout's own .aidlc-source-paths.json, the
// file its walk reads, and the refusal names that file.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { seededRecordDir } from "../harness/fixtures.ts";
import {
  _resetWorkspaceSourceStateCacheForTests,
  auditBlockField,
  readAuditShardEvents,
  readRecordedSourceCheckouts,
  registryExcludedSourceKeys,
  workspaceSourceState,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  checkoutCommand,
  cleanupLayouts,
  commitRecords,
  git,
  isGuardAsk,
  outsideRepo,
  PERSON,
  personSays,
  reasonCodes,
  report,
  review,
  setGuardPolicy,
  shellWorkspace,
  sourceWorkRows,
  stageBox,
  startCodeGeneration,
  state,
  tempDir,
  worktreeOf,
  writeCode,
} from "../harness/source-work-layouts.ts";

// The stage's checks run once before its review or gate, and again at the gate
// (completionChecksStep, t-checks-before-review); this file's fixture documents
// are not written for them and its subject is not them, so they stay off here.
process.env.AIDLC_DISABLE_SENSORS = "1";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

afterEach(() => cleanupLayouts());

function fingerprint(proj: string): string | undefined {
  _resetWorkspaceSourceStateCacheForTests();
  return workspaceSourceState(proj)?.fingerprint;
}

function listedKeys(proj: string): string[] {
  _resetWorkspaceSourceStateCacheForTests();
  return [...(workspaceSourceState(proj)?.listing.keys() ?? [])].map((key) => key.slice(key.indexOf("\0") + 1));
}

function checkoutRows(proj: string): Array<Record<string, string | null>> {
  return readAuditShardEvents(proj)
    .filter((row) => row.event === "INTENT_CHECKOUTS_CHANGED")
    .map((row) => ({
      added: auditBlockField(row.block, "Added"),
      removed: auditBlockField(row.block, "Removed"),
      path: auditBlockField(row.block, "Path"),
      checkouts: auditBlockField(row.block, "Checkouts"),
    }));
}

// Code Generation under way with the code in a worktree of the project in its
// harness folder, which the walk leaves out.
function harnessWorktree(): { proj: string; worktree: string } {
  const proj = shellWorkspace(".claude/worktrees/\n");
  startCodeGeneration(proj, false);
  commitRecords(proj);
  const worktree = worktreeOf(proj, join(proj, ".claude", "worktrees", "feature"));
  writeCode(worktree);
  return { proj, worktree };
}

describe("intent add-checkout and remove-checkout", () => {
  test("add-checkout records the checkout in one line, writes the audit row first, and asks nothing", () => {
    const { proj } = harnessWorktree();
    expect(listedKeys(proj).some((path) => path.includes("login.ts"))).toBe(false);
    const added = checkoutCommand(proj, "add-checkout", ".claude/worktrees/feature");
    expect(added.rc, added.out).toBe(0);
    expect(added.out.trim()).toBe(
      "Recorded .claude/worktrees/feature for this piece of work's review, as feature@checkout. You can remove it any time.",
    );
    expect(added.out).not.toContain("?");
    expect(added.out).not.toContain("add-checkout");
    expect(readRecordedSourceCheckouts(proj).map((entry) => [entry.label, entry.path])).toEqual([
      ["feature", ".claude/worktrees/feature"],
    ]);
    expect(checkoutRows(proj)).toEqual([
      { added: "feature", removed: null, path: ".claude/worktrees/feature", checkouts: "feature" },
    ]);
    expect(listedKeys(proj)).toContain("feature@checkout/src/auth/login.ts");
  });

  test("remove-checkout undoes it, and an empty record changes no fingerprint", () => {
    const { proj } = harnessWorktree();
    const before = fingerprint(proj);
    expect(checkoutCommand(proj, "add-checkout", ".claude/worktrees/feature").rc).toBe(0);
    expect(fingerprint(proj)).not.toBe(before);
    const removed = checkoutCommand(proj, "remove-checkout", ".claude/worktrees/feature");
    expect(removed.rc, removed.out).toBe(0);
    expect(removed.out.trim()).toBe(
      "Removed .claude/worktrees/feature from this piece of work's review. You can add it back any time.",
    );
    expect(readRecordedSourceCheckouts(proj)).toEqual([]);
    expect(fingerprint(proj)).toBe(before);
    expect(checkoutRows(proj).map((row) => row.removed)).toEqual([null, "feature"]);
    const engine = join(seededRecordDir(proj), ".aidlc-engine");
    writeFileSync(join(engine, "source-checkouts.json"), `${JSON.stringify({ version: 1, checkouts: [] })}\n`);
    expect(fingerprint(proj)).toBe(before);
  });

  test("the same path again, or one not recorded, changes nothing and says so", () => {
    const { proj } = harnessWorktree();
    expect(checkoutCommand(proj, "add-checkout", ".claude/worktrees/feature").rc).toBe(0);
    const again = checkoutCommand(proj, "add-checkout", ".claude/worktrees/feature");
    expect(again.rc).toBe(0);
    expect(again.out).toContain("is already recorded for this piece of work's review (as feature@checkout); nothing changed.");
    const absent = checkoutCommand(proj, "remove-checkout", "elsewhere");
    expect(absent.rc).toBe(0);
    expect(absent.out).toContain("elsewhere is not one of the checkouts this piece of work records; nothing changed.");
    expect(checkoutRows(proj)).toHaveLength(1);
  });

  test("a folder with no .git entry, a missing path, AI-DLC's own folder, or one the review already sees is refused or left as it is", () => {
    const { proj } = harnessWorktree();
    mkdirSync(join(proj, "plain"), { recursive: true });
    const plain = checkoutCommand(proj, "add-checkout", "plain");
    expect(plain.rc).not.toBe(0);
    expect(plain.out).toContain("plain is not a Git checkout (no .git entry in it)");
    const missing = checkoutCommand(proj, "add-checkout", "nowhere");
    expect(missing.rc).not.toBe(0);
    expect(missing.out).toContain("nowhere is not a folder on this machine");
    const inside = join(proj, "aidlc", "copy");
    mkdirSync(inside, { recursive: true });
    git(inside, ["init", "-q"]);
    const own = checkoutCommand(proj, "add-checkout", "aidlc/copy");
    expect(own.rc).not.toBe(0);
    expect(own.out).toContain("is inside AI-DLC's own aidlc/ folder");
    const nested = worktreeOf(proj, join(proj, ".worktrees", "other"));
    writeCode(nested);
    const reached = checkoutCommand(proj, "add-checkout", ".worktrees/other");
    expect(reached.rc).toBe(0);
    expect(reached.out.trim()).toBe("The review already covers .worktrees/other; nothing to record.");
    expect(readRecordedSourceCheckouts(proj)).toEqual([]);
    expect(checkoutRows(proj)).toEqual([]);
  });

  test("a checkout outside the project is labelled by its folder name, never its path", () => {
    const { proj } = harnessWorktree();
    const outside = worktreeOf(outsideRepo(), join(tempDir("t-add-checkout-out-"), "feature"));
    writeCode(outside);
    expect(checkoutCommand(proj, "add-checkout", ".claude/worktrees/feature").rc).toBe(0);
    const added = checkoutCommand(proj, "add-checkout", outside);
    expect(added.rc, added.out).toBe(0);
    expect(added.out).toContain("as feature-2@checkout");
    const labels = readRecordedSourceCheckouts(proj).map((entry) => entry.label);
    expect(labels).toEqual(["feature", "feature-2"]);
    expect(listedKeys(proj)).toContain("feature-2@checkout/src/auth/login.ts");
    expect(listedKeys(proj).some((path) => path.includes(outside))).toBe(false);
  });

  // A same-repo worktree carries the project's committed records and harness
  // folder: they are AI-DLC's own there too, never a source change.
  test("AI-DLC's records and harness folder inside a recorded same-repo worktree stay out of the identity", () => {
    const { proj, worktree } = harnessWorktree();
    expect(checkoutCommand(proj, "add-checkout", worktree).rc).toBe(0);
    const bound = fingerprint(proj);
    expect(listedKeys(proj).some((path) => path.startsWith("feature@checkout/aidlc/"))).toBe(false);
    expect(listedKeys(proj).some((path) => path.startsWith("feature@checkout/.claude/"))).toBe(false);
    writeFileSync(join(worktree, "aidlc", "spaces", "default", "memory", "team.md"), "# Team\n\nchanged on the branch\n");
    expect(fingerprint(proj)).toBe(bound);
    writeCode(worktree, "export const login = 3;\n");
    expect(fingerprint(proj)).not.toBe(bound);
  });

  test("400 other worktrees in the harness folder are never walked and the report stays quick", () => {
    const { proj, worktree } = harnessWorktree();
    for (let n = 0; n < 400; n++) {
      const other = join(proj, ".claude", "worktrees", `other-${n}`);
      mkdirSync(join(other, "src"), { recursive: true });
      writeFileSync(join(other, ".git"), "gitdir: /nowhere\n");
      writeFileSync(join(other, "src", "x.ts"), `export const x = ${n};\n`);
    }
    expect(checkoutCommand(proj, "add-checkout", worktree).rc).toBe(0);
    expect(review(proj, false, []).rc).toBe(0);
    const keys = listedKeys(proj);
    expect(keys.some((path) => path.includes("other-"))).toBe(false);
    const started = Date.now();
    const gate = report(proj, "awaiting-approval", PERSON);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(isGuardAsk(gate), gate.out).toBe(false);
    expect(stageBox(proj)).toBe("?");
    expect(sourceWorkRows(proj)).toEqual([]);
  });
});

describe("a Unit's claim records the checkout it lies in", () => {
  test("a claim inside a harness-folder worktree records it at the review request, and the review binds it", () => {
    const proj = shellWorkspace(".claude/worktrees/\n");
    startCodeGeneration(proj, true);
    commitRecords(proj);
    const worktree = worktreeOf(proj, join(proj, ".claude", "worktrees", "feature"));
    writeCode(worktree);
    expect(review(proj, true, [{ path: ".claude/worktrees/feature/src/" }]).rc).toBe(0);
    expect(readRecordedSourceCheckouts(proj).map((entry) => entry.label)).toEqual(["feature"]);
    const requested = readAuditShardEvents(proj).filter((row) => row.event === "REVIEW_REQUESTED").at(-1);
    expect(requested === undefined ? null : auditBlockField(requested.block, "Checkouts Recorded")).toBe(
      "feature (.claude/worktrees/feature)",
    );
    const gate = report(proj, "awaiting-approval");
    expect(isGuardAsk(gate), gate.out).toBe(false);
    expect(stageBox(proj)).toBe("?");
  });

  // Work that records repos: a claim by a checkout's listing name is the walk's,
  // never one of the repos', so it binds the checkout's code like any claim.
  for (const repos of [["repo-a"], ["repo-a", "repo-b"]]) {
    test(`in work that records ${repos.length === 1 ? "one repo" : "two repos"}, a claim by the checkout's name binds it`, () => {
      const proj = shellWorkspace(repos.map((repo) => `${repo}/\n`).join(""));
      setGuardPolicy(proj, "strict", "set by you");
      for (const repo of repos) {
        mkdirSync(join(proj, repo), { recursive: true });
        git(join(proj, repo), ["init", "-q"]);
      }
      const registry = join(dirname(seededRecordDir(proj)), "intents.json");
      const rows = JSON.parse(readFileSync(registry, "utf-8")) as Array<Record<string, unknown>>;
      writeFileSync(registry, `${JSON.stringify(rows.map((row) => ({ ...row, repos })), null, 2)}\n`);
      startCodeGeneration(proj, true);
      commitRecords(proj);
      const outside = worktreeOf(outsideRepo(), join(tempDir("t-add-checkout-repos-"), "feature"));
      writeCode(outside);
      const unrecorded = review(proj, true, [{ path: "feature@checkout/src/" }]);
      expect(unrecorded.rc).not.toBe(0);
      expect(unrecorded.out).toContain("names a checkout this piece of work has not recorded.");
      expect(checkoutCommand(proj, "add-checkout", outside).rc).toBe(0);
      const claim = [{ path: "feature@checkout/src/" }];
      const reviewed = review(proj, true, claim);
      expect(reviewed.rc, reviewed.out).toBe(0);
      writeCode(outside, "export const login = 2;\n");
      const stale = report(proj, "awaiting-approval");
      expect(isGuardAsk(stale), stale.out).toBe(true);
      expect(reasonCodes(stale)).toContain("SOURCE_REVIEW_STALE");
      expect(review(proj, true, claim, 2).rc).toBe(0);
      const gate = report(proj, "awaiting-approval");
      expect(isGuardAsk(gate), gate.out).toBe(false);
      expect(stageBox(proj)).toBe("?");
    });
  }

  test("a claim by a checkout name nobody recorded is refused with the step", () => {
    const proj = shellWorkspace("");
    startCodeGeneration(proj, true);
    commitRecords(proj);
    const refused = review(proj, true, [{ path: "feature@checkout/src/" }]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("feature@checkout/src/");
    expect(refused.out).toContain("names a checkout this piece of work has not recorded.");
    expect(refused.out).toContain("intent add-checkout <its path>");
  });

  // A teammate's clone has no record: the review it reads was bound to the
  // checkout, so it is stale, never unbindable, and the recovery review
  // records the checkout again from the claim; the reports reach the gate.
  test("with the record gone, the review is stale, never unbindable, and the reports reach the gate", () => {
    const proj = shellWorkspace(".claude/worktrees/\n");
    startCodeGeneration(proj, true);
    commitRecords(proj);
    const worktree = worktreeOf(proj, join(proj, ".claude", "worktrees", "feature"));
    writeCode(worktree);
    const claim = [{ path: ".claude/worktrees/feature/src/" }];
    expect(review(proj, true, claim).rc).toBe(0);
    rmSync(join(seededRecordDir(proj), ".aidlc-engine", "source-checkouts.json"));
    const codes: string[] = [];
    for (let reports = 0; reports < 4 && stageBox(proj) !== "?"; reports++) {
      const step = report(proj, "awaiting-approval", PERSON);
      codes.push(...reasonCodes(step));
      expect(step.out).not.toContain("nothing I can safely do");
      if (reasonCodes(step).includes("SOURCE_REVIEW_STALE")) expect(review(proj, true, claim, 2).rc).toBe(0);
    }
    expect(codes).toContain("SOURCE_REVIEW_STALE");
    expect(codes).not.toContain("SOURCE_BOUNDARY_UNBINDABLE");
    expect(stageBox(proj)).toBe("?");
  });
});

// A tool cache inside the recorded checkout (a test run's, the project does not
// ignore it) rewritten after the review, on a plan with no Units, strict.
describe("an exclude in a recorded checkout's own .aidlc-source-paths.json", () => {
  const CACHE = "apps/web/.jest-cache";
  const CHANGED = `feature@checkout/${CACHE}/haste-map-abc`;

  function cacheRewrittenAfterReview(): { proj: string; worktree: string } {
    const proj = shellWorkspace(".claude/worktrees/\n");
    setGuardPolicy(proj, "strict", "set by you");
    startCodeGeneration(proj, false);
    commitRecords(proj);
    const worktree = worktreeOf(proj, join(proj, ".claude", "worktrees", "feature"));
    writeCode(worktree);
    expect(checkoutCommand(proj, "add-checkout", ".claude/worktrees/feature").rc).toBe(0);
    mkdirSync(join(worktree, CACHE), { recursive: true });
    writeFileSync(join(worktree, CACHE, "haste-map-abc"), "\u0000haste-v1");
    expect(review(proj, false, []).rc).toBe(0);
    expect(report(proj, "awaiting-approval", PERSON).rc).toBe(0);
    expect(stageBox(proj)).toBe("?");
    writeFileSync(join(worktree, CACHE, "haste-map-abc"), "\u0000haste-v2");
    return { proj, worktree };
  }

  function excludeIn(dir: string): void {
    writeFileSync(join(dir, ".aidlc-source-paths.json"), `${JSON.stringify({ version: 1, exclude: [CACHE] })}\n`);
  }

  function reviewRequests(proj: string): number {
    return readAuditShardEvents(proj).filter((row) => row.event === "REVIEW_REQUESTED").length;
  }

  test("the refusal names the checkout's own file, and the exclude written there completes with no further review", () => {
    const { proj, worktree } = cacheRewrittenAfterReview();
    const stale = state(proj, ["approve", "code-generation", "--user-input", "Approve"]);
    expect(stale.rc).not.toBe(0);
    expect(stale.out).toContain(`What changed: ${CHANGED}`);
    expect(stale.out).toContain("of the path's own folder (.claude/worktrees/feature/.aidlc-source-paths.json)");
    const requests = reviewRequests(proj);
    excludeIn(worktree);
    personSays(proj);
    const approved = report(proj, "approved", PERSON, ["--user-input", "Approve"]);
    expect(stageBox(proj), approved.out).toBe("x");
    expect(reviewRequests(proj)).toBe(requests);
  });

  test("the project root's exclude does not leave out a checkout's file of the same path", () => {
    const { proj } = cacheRewrittenAfterReview();
    excludeIn(proj);
    const stale = state(proj, ["approve", "code-generation", "--user-input", "Approve"]);
    expect(stale.rc).not.toBe(0);
    expect(stale.out).toContain(`What changed: ${CHANGED}`);
    expect(stale.out).toContain("of the path's own folder (.claude/worktrees/feature/.aidlc-source-paths.json)");
  });

  test("each key reads its own checkout's registry, and a checkout no longer recorded leaves its keys counted", () => {
    const { proj, worktree } = cacheRewrittenAfterReview();
    excludeIn(worktree);
    const key = `\0${CHANGED}`;
    const code = "\0feature@checkout/src/auth/login.ts";
    expect([...registryExcludedSourceKeys(proj, [key, code])]).toEqual([key]);
    expect(checkoutCommand(proj, "remove-checkout", ".claude/worktrees/feature").rc).toBe(0);
    expect([...registryExcludedSourceKeys(proj, [key])]).toEqual([]);
  });
});
