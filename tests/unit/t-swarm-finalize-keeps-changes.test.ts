// covers: subcommand:aidlc-swarm:finalize, subcommand:aidlc-bolt:swarm-checkpoint, audit:CHANGE_ACCEPTED
//
// With Guard Policy off or relaxed, a swarm Unit whose code, Code Generation
// documents or list of files changed after its review keeps the review: finalize
// lands the Unit with one line saying what changed, and the batch checkpoint
// that follows is ready to ask, with no second line. Under strict, finalize
// still sends the Unit back for a fresh review, naming what changed.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { auditBlockField, auditShardDir, boltSlugForUnit, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  cleanupCheckpointFixtures, fixture, prepare, publish, reviewRevisedSource, runCheckpointTool,
  swarm, wt, writeUnitSource,
} from "../harness/swarm-checkpoint.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

function setPolicy(pd: string, line: string): void {
  const path = seededStateFile(pd);
  writeFileSync(path, readFileSync(path, "utf-8").replace(/^- \*\*Change Control\*\*: .*$/m, `- **Guard Policy**: ${line}`));
  // The swarm directive is bound to the state it was published for.
  publish(pd, ["alpha"]);
}

type Edit = (pd: string) => void;

// The sweep's repro: the Unit is checked and reviewed, then changed, then finalized.
function reviewedThenChanged(policy: string, edit: Edit) {
  const pd = fixture(["alpha"]);
  if (policy !== "strict") setPolicy(pd, policy);
  const prepared = prepare(pd);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
  writeUnitSource(pd, "alpha", 2);
  const checked = swarm(pd, ["check", "alpha"]);
  expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
  reviewRevisedSource(pd);
  edit(pd);
  const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]);
  const row = (JSON.parse(finalized.out) as { units: Array<{ unit: string; detail?: string; change_notices?: string[] }> })
    .units.find((unit) => unit.unit === "alpha");
  return { pd, finalized, row };
}

function land(pd: string): void {
  const merged = runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
    "merge", "--slug", boltSlugForUnit("alpha"), "--target", "main", "--strategy", "squash", "--project-dir", pd,
  ]);
  expect(merged.code, `${merged.out}\n${merged.err}`).toBe(0);
}

function landAndStatus(pd: string) {
  land(pd);
  return batchStatus(pd);
}

function batchStatus(pd: string) {
  const status = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
    "swarm-checkpoint", "--action", "status", "--batch", "1", "--units", "alpha", "--project-dir", pd,
  ]);
  expect(status.code, `${status.out}\n${status.err}`).toBe(0);
  return JSON.parse(status.out) as { ready: boolean; errors: string[]; changed_after_check: boolean; notices?: string[] };
}

function ask(pd: string): string[] {
  const asked = runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
    "swarm-checkpoint", "--action", "ask", "--batch", "1", "--units", "alpha", "--session", "keeps-changes", "--project-dir", pd,
  ]);
  expect(asked.code, `${asked.out}\n${asked.err}`).toBe(0);
  return JSON.parse(asked.out).notices ?? [];
}

const accepted = (pd: string) => readAuditShardEvents(pd).filter((row) => row.event === "CHANGE_ACCEPTED");

const CASES: Array<{ what: string; edit: Edit; strict: string; kept: string }> = [
  {
    what: "code",
    edit: (pd) => writeUnitSource(pd, "alpha", 3),
    strict: "the reviewed source no longer matches its worktree's fingerprint",
    kept: "The alpha Unit's code changed after it was reviewed. Kept the change.",
  },
  {
    what: "Code Generation documents",
    edit: (pd) => appendFileSync(join(codeGenerationRecordDir(wt(pd), "alpha"), "code-generation-plan.md"), "\nA note after the review.\n"),
    strict: "unit \"alpha\"'s Code Generation documents changed after its review",
    kept: "The alpha Unit's Code Generation documents changed after it was reviewed. Kept them.",
  },
  {
    what: "list of files",
    edit: (pd) => appendFileSync(join(codeGenerationRecordDir(wt(pd), "alpha"), "source-manifest.json"), "\n"),
    strict: "reviewed source manifest binding is missing, corrupt, or no longer matches its review",
    kept: "The alpha Unit's list of files changed after it was reviewed. Kept the review.",
  },
];

describe("a swarm Unit changed after its review", () => {
  for (const { what, edit, strict, kept } of CASES) {
    test(`its ${what}: strict sends it back for review; off keeps the review, says so once, and the batch is ready`, () => {
      const refused = reviewedThenChanged("strict", edit);
      expect(refused.finalized.code).toBe(2);
      expect(refused.row?.detail).toContain(strict);

      const { pd, finalized, row } = reviewedThenChanged("off (set by you)", edit);
      expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
      expect(row?.change_notices).toEqual([kept]);
      expect(accepted(pd).map((r) => auditBlockField(r.block, "Checkpoint"))).toEqual(["review-receipt"]);

      const status = landAndStatus(pd);
      expect(status.errors).toEqual([]);
      expect(status.ready).toBe(true);
      // Said once, at finalize: the batch adds no second row and no second line.
      expect(ask(pd)).toEqual([]);
      expect(accepted(pd)).toHaveLength(1);
    });
  }

  // Audit timestamps are to the second: a finalize in the review's own second
  // still counts as after it.
  test("a change kept in the same second as the review still leaves the batch ready", () => {
    const { pd, finalized } = reviewedThenChanged("off (set by you)", (p) => writeUnitSource(p, "alpha", 3));
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    land(pd);
    const events = readAuditShardEvents(pd);
    const review = events.filter((row) => row.event === "REVIEW_COMPLETED").at(-1)!;
    const kept = events.find((row) => row.event === "CHANGE_ACCEPTED")!;
    const path = isAbsolute(kept.shard) ? kept.shard : join(auditShardDir(pd)!, kept.shard);
    const text = readFileSync(path, "utf-8");
    const sameSecond = kept.block.replace(`**Timestamp**: ${kept.timestamp}`, `**Timestamp**: ${review.timestamp}`);
    expect(sameSecond).not.toBe(kept.block);
    expect(text).toContain(kept.block);
    writeFileSync(path, text.replace(kept.block, sameSecond));
    const status = batchStatus(pd);
    expect(status.errors).toEqual([]);
    expect(status.ready).toBe(true);
  });

  test("its list of files changed after finalize: strict names it; off keeps it with one line", () => {
    for (const policy of ["strict", "off (set by you)"]) {
      const { pd, finalized, row } = reviewedThenChanged(policy, () => {});
      expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
      expect(row?.change_notices ?? []).toEqual([]);
      land(pd);
      appendFileSync(join(codeGenerationRecordDir(pd, "alpha"), "source-manifest.json"), "\n");
      const status = batchStatus(pd);
      if (policy === "strict") {
        expect(status.errors.join("\n")).toContain("source manifest or claimed source does not match the native reviewed binding");
        continue;
      }
      expect(status.errors).toEqual([]);
      expect(status.ready).toBe(true);
      expect(ask(pd)).toEqual(["The alpha Unit's list of files changed after its batch was checked. Kept them."]);
    }
  });
});
