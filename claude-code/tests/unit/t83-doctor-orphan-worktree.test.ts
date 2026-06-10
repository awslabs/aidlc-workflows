// covers: subcommand:aidlc-utility:doctor
//
// CLI-contract port of tests/unit/t83-doctor-orphan-worktree.sh (TAP plan 16),
// mechanism = cli. The .sh has no colon-form `# covers:` header; its prose
// header declares it covers v0.4.0 milestone 15 doctor reconciliation Checks 1, 3, 4,
// 6 — the orphan-reconciliation family. All of that surface is the
// `handleDoctor(projectDir)` subcommand of aidlc-utility.ts, so the covers id
// is `subcommand:aidlc-utility:doctor` (the SAME id t104's doctor twin uses;
// the registry joins on it).
//
// Equal-or-stronger migration: every .sh assertion shelled out to
// `bun aidlc-utility.ts doctor --project-dir <p> 2>&1 || true` and grepped the
// combined stdout+stderr. We preserve that by SPAWNING the real CLI via
// node:child_process spawnSync (BUN + the tool .ts path), asserting on
// stdout+stderr — the PROCESS boundary the .sh tested. mechanism = cli.
//
// WHY SPAWN (not in-process): handleDoctor terminates with
// `process.exit(failed > 0 ? 1 : 0)` (aidlc-utility.ts:1385 region) and writes
// its report via `process.stdout.write`. A bare temp project fails the
// hook/settings checks, so doctor exits 1 — the .sh swallows that with
// `|| true` and asserts on stdout content, where the reconciliation rows
// render regardless of exit code. We mirror exactly: capture status for parity
// but assert on the rendered report lines.
//
// Source under test (dist/claude/.claude/tools/aidlc-utility.ts, handleDoctor):
//   Check 1 — Orphan worktrees (:563-670)
//     - `observed === 0`        → "Orphan worktrees: 0 observed" (:644)
//     - active fork (Bolt Refs) → "Orphan worktrees: 0 (N active fork[s])" (:647-649)
//     - preserved-by-abort      → "... N preserved-by-abort (awaiting resume)" (:648)
//     - cleanup-orphan          → "Orphan worktrees: N drift" + "cleanup-orphan" (:655-660)
//     - unmatched (no trail)    → "Orphan worktrees: N drift" + "unmatched" (:652-660)
//   Check 3 — Orphan state files (:734-781)
//     - none observed           → "Orphan state files: 0 observed" (:765)
//     - active/discarded        → "Orphan state files: 0 (N active)" (:766)
//     - orphan state            → "Orphan state files: N drift" (:771)
//   Check 4 — Orphan audit drift (:784-892)
//     - clean                   → "Orphan audit: 0 observed" (:866)
//     - reconciled              → "Orphan audit: 0 (N reconciled)" (:868)
//     - sub-case (a)            → "... AUDIT_FORKED-without-disk: <slug>" (:876)
//     - sub-case (b)            → "... orphan-delta (no AUDIT_MERGED): <slug>" (:877)
//     - PRACTICES_OVERRIDE      → "... without follow-up PRACTICES_AFFIRMED" (:878)
//     - unknown Reason          → "... unknown Reason — track for follow-up" (:871)
//   Check 6 — MERGE_DISPATCH advisory (:948-1014)
//     - orphan INVOKED          → "MERGE_DISPATCH: N orphan INVOKED (advisory ...)" (:1013)
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project / seed_* /
// append_audit / cleanup_test_project per-case lifecycle):
//   - Each case gets a FRESH temp project via createTestProject(), seeded with
//     audit-sample.md (seedAuditFile) + state-mid-ideation.md (seedStateFile),
//     exactly the .sh's `seed_audit_file` + `seed_state_file` pair.
//   - Audit blocks are appended in the .sh's `append_audit` shape: a leading
//     "\n", the block body, then "\n\n---\n" — so findAllEvents' `\n---\n`
//     split (aidlc-lib.ts:668) sees each block as a discrete entry, byte-for-
//     byte the heredocs the .sh wrote.
//   - Bolt Refs are set via sedReplaceInFile, the TS port of the .sh's sed_i on
//     the `- **Bolt Refs**:` state line.
//   - Worktree dirs are mkdir'd under <proj>/.aidlc/worktrees/bolt-<slug>/,
//     the same layout Check 1/3/4 walk.
//   - Every temp dir is torn down in afterEach (cleanupTestProject).
//
// Old TAP -> new test parity (1:1, plan 16; several STRONGER via co-location):
//   .sh test 1  fail-clean on empty worktrees       -> test 1
//   .sh test 2  active fork not orphan              -> test 2
//   .sh test 3  cleanup-orphan (WORKTREE_MERGED)     -> test 3
//   .sh test 4  unmatched orphan                     -> test 4
//   .sh test 5  orphan state file flagged            -> test 5
//   .sh test 6  orphan state + WORKTREE_DISCARDED ok  -> test 6
//   .sh test 7  AUDIT_FORKED-without-disk (a)         -> test 7
//   .sh test 8  orphan-delta (b)                      -> test 8
//   .sh test 9  PRACTICES_OVERRIDE write-failure flag -> test 9
//   .sh test 10 bolt-plan-marker-conflict NOT flagged -> test 10
//   .sh test 11 MERGE_DISPATCH orphan advisory        -> test 11
//   .sh test 12 merged-and-cleaned NOT orphan (BLOCKER)-> test 12
//   .sh test 13 multi-INVOKED pair-matching (MAJOR)    -> test 13
//   .sh test 14 ms-precision AFFIRMED reconciles (MAJOR)-> test 14
//   .sh test 15 preserved-by-abort sub-class (MAJOR)    -> test 15
//   .sh test 16 unknown Reason tracked (MINOR)          -> test 16

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  FIXTURES_DIR,
  cleanupTestProject,
  createTestProject,
  seedAuditFile,
  seedStateFile,
  sedReplaceInFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const STATE_FIXTURE = join(FIXTURES_DIR, "state-mid-ideation.md");

// Every project dir registered here is torn down after each test (mirrors the
// .sh's cleanup_test_project at the end of each block).
const created: string[] = [];

afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

/**
 * Fresh project seeded with audit-sample.md + state-mid-ideation.md — the .sh's
 * `PROJ=$(create_test_project); seed_audit_file; seed_state_file <state>` trio.
 */
function freshProject(): string {
  const proj = createTestProject();
  created.push(proj);
  seedAuditFile(proj);
  seedStateFile(proj, STATE_FIXTURE);
  return proj;
}

/** The .sh's append_audit: leading blank line, the block body, then a `---`
 *  separator surrounded by blank lines. Matches findAllEvents' `\n---\n` split. */
function appendAudit(proj: string, body: string): void {
  appendFileSync(join(proj, "aidlc-docs", "audit.md"), `\n${body}\n\n---\n`);
}

/** mkdir -p <proj>/.aidlc/worktrees/bolt-<slug>[/aidlc-docs] */
function mkWorktree(proj: string, slug: string, withDocs = false): string {
  const dir = join(proj, ".aidlc", "worktrees", `bolt-${slug}`);
  mkdirSync(withDocs ? join(dir, "aidlc-docs") : dir, { recursive: true });
  return dir;
}

/** The .sh's sed_i on the `- **Bolt Refs**:` line — set the bracketed list. */
function setBoltRefs(proj: string, value: string): void {
  sedReplaceInFile(
    join(proj, "aidlc-docs", "aidlc-state.md"),
    /^- \*\*Bolt Refs\*\*:.*$/m,
    `- **Bolt Refs**: ${value}`,
  );
}

interface DoctorResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/** `bun UTIL doctor --project-dir <proj>` captured 2>&1, exit code swallowed. */
function runDoctor(proj: string): DoctorResult {
  const res = spawnSync(BUN, [UTIL, "doctor", "--project-dir", proj], {
    encoding: "utf-8",
    env: { ...process.env },
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

describe("t83 aidlc-utility doctor — orphan-reconciliation family (migrated from t83-doctor-orphan-worktree.sh, plan 16)", () => {
  test("1: fail-clean on no-worktrees — all three orphan checks render 0 observed", () => {
    const proj = freshProject();
    const { out } = runDoctor(proj);
    expect(out).toContain("Orphan worktrees: 0 observed");
    expect(out).toContain("Orphan state files: 0 observed");
    expect(out).toContain("Orphan audit: 0 observed");
  }, 30000);

  test("2: active fork (slug in Bolt Refs) does not flag as orphan", () => {
    const proj = freshProject();
    setBoltRefs(proj, "[activeslug]");
    mkWorktree(proj, "activeslug", true);
    writeFileSync(
      join(proj, ".aidlc", "worktrees", "bolt-activeslug", "aidlc-docs", "aidlc-state.md"),
      "# stub state\n",
    );
    const { out } = runDoctor(proj);
    // .sh grepped two ERE lines; assert the same two literals render.
    expect(out).toContain("Orphan worktrees: 0 (1 active fork)");
    expect(out).toContain("Orphan state files: 0 (1 active)");
  }, 30000);

  test("3: cleanup-orphan classification (WORKTREE_MERGED + dir persists)", () => {
    const proj = freshProject();
    mkWorktree(proj, "cleanuptest");
    appendAudit(
      proj,
      [
        "## Worktree Merged",
        "**Timestamp**: 2026-05-19T10:00:00Z",
        "**Event**: WORKTREE_MERGED",
        "**Bolt slug**: cleanuptest",
        "**Worktree path**: /tmp/bolt-cleanuptest",
        "**Target branch**: main",
        "**Strategy**: squash",
      ].join("\n"),
    );
    // STRONGER than the .sh's two independent greps: assert the classification
    // and the slug land on the SAME worktree-drift line (Check 1's fix string).
    const { out } = runDoctor(proj);
    const line = out.split("\n").find((l) => l.includes("cleanup-orphan")) ?? "";
    expect(line).toContain("cleanup-orphan");
    expect(line).toContain("cleanuptest");
  }, 30000);

  test("4: unmatched orphan (no Bolt Refs, no audit row)", () => {
    const proj = freshProject();
    mkWorktree(proj, "orphanunmatched");
    const { out } = runDoctor(proj);
    // STRONGER: "unmatched" + the slug co-located on the same drift line.
    const line = out.split("\n").find((l) => l.includes("unmatched")) ?? "";
    expect(line).toContain("unmatched");
    expect(line).toContain("orphanunmatched");
  }, 30000);

  test("5: orphan state file flagged when slug not in Bolt Refs and no DISCARDED row", () => {
    const proj = freshProject();
    mkWorktree(proj, "orphanstate", true);
    writeFileSync(
      join(proj, ".aidlc", "worktrees", "bolt-orphanstate", "aidlc-docs", "aidlc-state.md"),
      "# state\n",
    );
    const { out } = runDoctor(proj);
    const line = out.split("\n").find((l) => l.includes("Orphan state files: 1 drift")) ?? "";
    expect(out).toContain("Orphan state files: 1 drift");
    // The slug is named in the fix string for this drift row.
    expect(out).toContain("orphanstate");
    expect(line).toContain("Orphan state files: 1 drift");
  }, 30000);

  test("6: orphan state paired with WORKTREE_DISCARDED is not flagged (legit pre-discard)", () => {
    const proj = freshProject();
    mkWorktree(proj, "discardedstate", true);
    writeFileSync(
      join(proj, ".aidlc", "worktrees", "bolt-discardedstate", "aidlc-docs", "aidlc-state.md"),
      "# state\n",
    );
    appendAudit(
      proj,
      [
        "## Worktree Discarded",
        "**Timestamp**: 2026-05-19T11:00:00Z",
        "**Event**: WORKTREE_DISCARDED",
        "**Bolt slug**: discardedstate",
        "**Worktree path**: /tmp/bolt-discardedstate",
        "**Reason**: user-discard",
      ].join("\n"),
    );
    const { out } = runDoctor(proj);
    // Observed but reconciled → "0 (1 active)", NOT a drift row.
    expect(out).toContain("Orphan state files: 0 (1 active)");
    expect(out).not.toContain("Orphan state files: 1 drift");
  }, 30000);

  test("7: AUDIT_FORKED-without-disk-state flagged (sub-case a)", () => {
    const proj = freshProject();
    // AUDIT_FORKED but no <wt>/aidlc-docs/audit.md on disk for slug `noaudit`.
    appendAudit(
      proj,
      [
        "## Audit Forked",
        "**Timestamp**: 2026-05-19T10:00:00Z",
        "**Event**: AUDIT_FORKED",
        "**Bolt slug**: noaudit",
        "**Source Audit Hash**: dummy",
        "**Fork Boundary**: 0",
      ].join("\n"),
    );
    const { out } = runDoctor(proj);
    const line = out.split("\n").find((l) => l.includes("AUDIT_FORKED-without-disk")) ?? "";
    expect(line).toContain("AUDIT_FORKED-without-disk");
    expect(line).toContain("noaudit");
  }, 30000);

  test("8: orphan-delta drift flagged (sub-case b: no AUDIT_MERGED, no active, no discard)", () => {
    const proj = freshProject();
    // Disk audit present (passes sub-case a) but no AUDIT_MERGED, slug not in
    // Bolt Refs, no WORKTREE_DISCARDED → sub-case (b).
    mkWorktree(proj, "deltatest", true);
    writeFileSync(
      join(proj, ".aidlc", "worktrees", "bolt-deltatest", "aidlc-docs", "audit.md"),
      "# wt audit\n",
    );
    appendAudit(
      proj,
      [
        "## Audit Forked",
        "**Timestamp**: 2026-05-19T10:00:00Z",
        "**Event**: AUDIT_FORKED",
        "**Bolt slug**: deltatest",
        "**Source Audit Hash**: dummy",
        "**Fork Boundary**: 0",
      ].join("\n"),
    );
    const { out } = runDoctor(proj);
    const line = out.split("\n").find((l) => l.includes("orphan-delta")) ?? "";
    expect(line).toContain("orphan-delta");
    expect(line).toContain("deltatest");
  }, 30000);

  test("9: PRACTICES_OVERRIDE write-failure-* without follow-up AFFIRMED is flagged", () => {
    const proj = freshProject();
    appendAudit(
      proj,
      [
        "## Practices Override",
        "**Timestamp**: 2026-05-19T10:00:00Z",
        "**Event**: PRACTICES_OVERRIDE",
        "**Reason**: write-failure-permission",
        "**Failure detail**: chmod denied",
      ].join("\n"),
    );
    const { out } = runDoctor(proj);
    // Both phrases the .sh grepped land on the Check-4 fix string.
    expect(out).toContain("PRACTICES_OVERRIDE write-failure");
    expect(out).toContain("without follow-up PRACTICES_AFFIRMED");
  }, 30000);

  test("10: PRACTICES_OVERRIDE bolt-plan-marker-conflict is expected (not flagged)", () => {
    const proj = freshProject();
    appendAudit(
      proj,
      [
        "## Practices Override",
        "**Timestamp**: 2026-05-19T10:00:00Z",
        "**Event**: PRACTICES_OVERRIDE",
        "**Reason**: bolt-plan-marker-conflict",
        "**Bolt slug**: foo",
        "**Practices Stance**: always-skeleton",
        "**Bolt-Plan Marker**: skeleton-off",
      ].join("\n"),
    );
    const { out } = runDoctor(proj);
    // The .sh grepped `Orphan audit: 0( |$)`. The conflict reason is skipped
    // entirely (continue before the reconciled tally), so the only override row
    // does not count as observed/reconciled — render is "0 observed".
    // STRONGER: assert the audit check is a 0-row AND no drift fired.
    const line = out.split("\n").find((l) => l.includes("Orphan audit:")) ?? "";
    expect(line).toMatch(/Orphan audit: 0(\s|$)/);
    expect(out).not.toContain("Orphan audit: 1 drift");
  }, 30000);

  test("11: MERGE_DISPATCH_INVOKED orphan is advisory (pass=true with advisory label)", () => {
    const proj = freshProject();
    // Pre-2026 timestamp → well outside the 60s timeout window.
    appendAudit(
      proj,
      [
        "## Merge Dispatch Invoked",
        "**Timestamp**: 2024-01-01T00:00:00Z",
        "**Event**: MERGE_DISPATCH_INVOKED",
        "**Bolt slug**: mergedispatchtest",
        "**Practices excerpt**: trunk-based",
      ].join("\n"),
    );
    const { out } = runDoctor(proj);
    const line = out.split("\n").find((l) => l.includes("MERGE_DISPATCH:")) ?? "";
    expect(line).toContain("MERGE_DISPATCH: 1 orphan INVOKED");
    expect(line).toContain("advisory");
  }, 30000);

  test("12: merged-and-cleaned Bolt does not flag as orphan (BLOCKER regression)", () => {
    const proj = freshProject();
    // Full merge cycle: AUDIT_FORKED + AUDIT_MERGED, worktree dir gone. The
    // AUDIT_MERGED short-circuit must run BEFORE the disk-existence check, else
    // sub-case (a) flags every healthy historical fork forever.
    appendAudit(
      proj,
      [
        "## Audit Forked",
        "**Timestamp**: 2026-05-19T10:00:00Z",
        "**Event**: AUDIT_FORKED",
        "**Bolt slug**: cleanmerge",
        "**Source Audit Hash**: dummy",
        "**Fork Boundary**: 0",
      ].join("\n"),
    );
    appendAudit(
      proj,
      [
        "## Audit Merged",
        "**Timestamp**: 2026-05-19T11:00:00Z",
        "**Event**: AUDIT_MERGED",
        "**Bolt slug**: cleanmerge",
        "**Entries Merged**: 5",
        "**Source Audit Hash**: dummy",
        "**Fork Boundary**: 0",
      ].join("\n"),
    );
    const { out } = runDoctor(proj);
    expect(out).toContain("Orphan audit: 0 (1 reconciled)");
    expect(out).not.toContain("AUDIT_FORKED-without-disk");
  }, 30000);

  test("13: multi-INVOKED pair-matching — 2 INVOKED + 1 RETURNED reports 1 orphan", () => {
    const proj = freshProject();
    appendAudit(
      proj,
      [
        "## Merge Dispatch Invoked",
        "**Timestamp**: 2024-01-01T00:00:00Z",
        "**Event**: MERGE_DISPATCH_INVOKED",
        "**Bolt slug**: pair",
        "**Practices excerpt**: trunk-based",
      ].join("\n"),
    );
    appendAudit(
      proj,
      [
        "## Merge Dispatch Invoked",
        "**Timestamp**: 2024-01-01T00:01:00Z",
        "**Event**: MERGE_DISPATCH_INVOKED",
        "**Bolt slug**: pair",
        "**Practices excerpt**: trunk-based",
      ].join("\n"),
    );
    appendAudit(
      proj,
      [
        "## Merge Dispatch Returned",
        "**Timestamp**: 2024-01-01T00:02:00Z",
        "**Event**: MERGE_DISPATCH_RETURNED",
        "**Bolt slug**: pair",
        "**Strategy**: squash",
        "**Target**: main",
        "**Confidence**: 0.9",
        "**Notes**: ok",
      ].join("\n"),
    );
    const { out } = runDoctor(proj);
    // Each terminal consumes one preceding INVOKED → exactly 1 orphan, not 0.
    expect(out).toContain("MERGE_DISPATCH: 1 orphan INVOKED");
  }, 30000);

  test("14: ms-precision PRACTICES_AFFIRMED reconciles seconds-precision OVERRIDE", () => {
    const proj = freshProject();
    // write-failure OVERRIDE at seconds precision, AFFIRMED at ms precision a
    // fraction later. Date.parse must win over lex string compare
    // ('...123Z' < '...Z'); else this flags as orphan.
    appendAudit(
      proj,
      [
        "## Practices Override",
        "**Timestamp**: 2026-05-19T10:00:00Z",
        "**Event**: PRACTICES_OVERRIDE",
        "**Reason**: write-failure-permission",
        "**Failure detail**: chmod denied",
      ].join("\n"),
    );
    appendAudit(
      proj,
      [
        "## Practices Affirmed",
        "**Timestamp**: 2026-05-19T10:00:00.123Z",
        "**Event**: PRACTICES_AFFIRMED",
        "**Bolt slug**: foo",
        "**Practices Stance**: trunk-based",
      ].join("\n"),
    );
    const { out } = runDoctor(proj);
    expect(out).toContain("Orphan audit: 0 (1 reconciled)");
    expect(out).not.toContain("without follow-up");
  }, 30000);

  test("15: preserved-by-abort sub-classification distinguishes from active forks", () => {
    const proj = freshProject();
    setBoltRefs(proj, "[aborted, active]");
    mkWorktree(proj, "aborted");
    mkWorktree(proj, "active");
    appendAudit(
      proj,
      [
        "## Bolt Failed",
        "**Timestamp**: 2026-05-19T10:00:00Z",
        "**Event**: BOLT_FAILED",
        "**Failed Bolt**: my-bolt",
        "**Bolt slug**: aborted",
        "**Error summary**: aborted: user halted at AUQ 1 of 2",
        "**Reason**: aborted",
      ].join("\n"),
    );
    const { out } = runDoctor(proj);
    // STRONGER than the .sh's two independent greps: both segments render on the
    // SAME Check-1 worktree line ("0 (1 active fork, 1 preserved-by-abort ...)").
    const line = out.split("\n").find((l) => l.includes("preserved-by-abort")) ?? "";
    expect(line).toContain("preserved-by-abort");
    expect(line).toContain("active fork");
  }, 30000);

  test("16: unknown PRACTICES_OVERRIDE Reason value surfaces as advisory", () => {
    const proj = freshProject();
    appendAudit(
      proj,
      [
        "## Practices Override",
        "**Timestamp**: 2026-05-19T10:00:00Z",
        "**Event**: PRACTICES_OVERRIDE",
        "**Reason**: future-variant-not-yet-routed",
        "**Some Field**: value",
      ].join("\n"),
    );
    const { out } = runDoctor(proj);
    // Both phrases the .sh grepped land on the Check-4 advisory label.
    expect(out).toContain("unknown Reason");
    expect(out).toContain("track for follow-up");
  }, 30000);
});
