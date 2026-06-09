// covers: subcommand:aidlc-utility:doctor
//
// CLI-contract port of tests/unit/t84-doctor-stale-branch.sh (TAP plan 5),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-utility.ts doctor --project-dir <p>` and grepped
// the stdout report is preserved by SPAWNING the real CLI via
// node:child_process spawnSync (BUN + the tool .ts path), asserting on the
// combined stdout+stderr the tool writes (2>&1 in the .sh) — the PROCESS
// boundary. handleDoctor ends in process.exit(failed > 0 ? 1 : 0)
// (aidlc-utility.ts:1385) and writes its report to process.stdout
// (aidlc-utility.ts:1373), so an in-process twin would lose the exit-code
// half AND the rendered-report half the .sh's `2>&1` grep relies on.
//
// CONTRACT under test — Check 2 "stale branches" (aidlc-utility.ts:672-731):
// walks `git branch --list 'bolt-*'`; flags any `bolt-<slug>` branch whose
// worktree dir (`.aidlc/worktrees/bolt-<slug>`, lib.ts worktreePath:155-157)
// is gone AND no terminal WORKTREE_MERGED / WORKTREE_DISCARDED audit row
// landed for that slug (slugTerminated, aidlc-utility.ts:551-560, keyed on
// `**Bolt slug**: <slug>` via findAllEvents). Three label shapes are pinned:
//   - not a git repo : "Stale branches: 0 observed (not a git repo)" (:691)
//   - clean / live   : "Stale branches: 0 (<N> bolt-* observed)"      (:715)
//   - stale drift    : "Stale branches: <N> drift" + slug in fix       (:720)
//
// PARITY NOTES (every .sh `ok`/`not_ok` line maps to a test() below; several
// are STRONGER than the original grep):
//   - .sh Test 1  grep "Stale branches: 0 observed (not a git repo)" ->
//       Test 1: out contains that exact label (same observable).
//   - .sh Test 2  grep -E "Stale branches: 0 \(0 bolt-\* observed\)"  ->
//       Test 2: out contains "Stale branches: 0 (0 bolt-* observed)" (same).
//   - .sh Test 3  grep "Stale branches: 1 drift" AND grep "stalefoo"  ->
//       Test 3: out contains "Stale branches: 1 drift" AND "stalefoo"
//       (both .sh greps preserved) + STRONGER: res.status === 1 (the .sh
//       swallowed $? with `|| true`; a stale-branch drift is a doctor
//       failure → exit 1, which the .sh never checked).
//   - .sh Test 4  grep -E "Stale branches: 0 \(1 bolt-\* observed\)" with
//       worktree dir present (live branch)                            ->
//       Test 4: out contains "Stale branches: 0 (1 bolt-* observed)" (same).
//   - .sh Test 5  grep -E "Stale branches: 0 \(1 bolt-\* observed\)" with
//       WORKTREE_MERGED audit row present (terminated branch)         ->
//       Test 5: out contains "Stale branches: 0 (1 bolt-* observed)" (same)
//       + STRONGER: the drift label is asserted ABSENT, so a regression that
//       both flags the branch AND counts it can't sneak past the count grep.
//
// 5 .sh asserts -> 5 expect()-bearing test() cases here (the .sh's 5 `ok`
// lines), with the STRONGER exit-code / absence additions noted above.
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + seed_audit_file
// + seed_state_file + init_git_repo + cleanup_test_project per case): each
// case uses a FRESH temp project (createTestProject, which toPortablePath-
// converts on Windows so audit.md — written by the tool via toPosix() —
// round-trips when read back) seeded with audit-sample.md (which contains NO
// bolt/worktree rows, grep-verified, so the seeded baseline can't perturb
// Check 2) and state-mid-ideation.md, exactly as the .sh seeded. Cases 2-5
// init a real git repo on `main` with one commit (init_git_repo). All temp
// dirs are cleaned in afterAll. NOTHING is written under tests/fixtures/**.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  REPO_ROOT as HARNESS_REPO_ROOT,
  seedAuditFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = HARNESS_REPO_ROOT;
const UTIL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-utility.ts",
);
const STATE_FIXTURE = join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "state-mid-ideation.md",
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface DoctorResult {
  status: number;
  /** combined stdout+stderr (mirrors the .sh's `2>&1`). */
  out: string;
}

/** Spawn `bun aidlc-utility.ts doctor --project-dir <p>`. Mirrors `bun "$UTIL" doctor --project-dir "$PROJ" 2>&1`. */
function doctor(p: string): DoctorResult {
  const res = spawnSync(BUN, [UTIL, "doctor", "--project-dir", p], {
    encoding: "utf-8",
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/** git -C <p> <args...>; throws on non-zero so fixture setup never silently fails. */
function git(p: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", p, ...args], { encoding: "utf-8" });
  if ((res.status ?? -1) !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (status ${res.status}): ${res.stderr ?? ""}`,
    );
  }
}

/**
 * Fresh seeded project: createTestProject + seed_audit_file + seed_state_file.
 * Mirrors the per-case scaffold the .sh repeats (t84-doctor-stale-branch.sh:63-65).
 */
function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  seedAuditFile(p);
  seedStateFile(p, STATE_FIXTURE);
  return p;
}

/**
 * Init a fresh git repo with one commit on `main`. Mirrors init_git_repo
 * (t84-doctor-stale-branch.sh:33-47): init -b main (fallback init), set
 * user/email, disable gpgsign, commit a README, rename to main if needed.
 */
function initGitRepo(p: string): void {
  // git init -b main; fall back to plain init on older git.
  const initB = spawnSync("git", ["-C", p, "init", "-b", "main"], {
    encoding: "utf-8",
  });
  if ((initB.status ?? -1) !== 0) {
    git(p, "init");
  }
  git(p, "config", "user.email", "test@example.com");
  git(p, "config", "user.name", "Test");
  git(p, "config", "commit.gpgsign", "false");
  writeFileSync(join(p, "README.md"), "init\n", "utf-8");
  git(p, "add", "README.md");
  git(p, "commit", "-m", "init");
  // Some git versions land on `master`; rename if so (best-effort, as the .sh).
  const head = spawnSync("git", ["-C", p, "symbolic-ref", "--short", "HEAD"], {
    encoding: "utf-8",
  });
  if ((head.stdout ?? "").trim() !== "main") {
    spawnSync("git", ["-C", p, "branch", "-m", "main"], { encoding: "utf-8" });
  }
}

/**
 * Append an audit block, then a `---` separator. Mirrors append_audit
 * (t84-doctor-stale-branch.sh:50-60): a blank line, the body, a blank line,
 * then `---`. findAllEvents keys terminal events on `**Bolt slug**: <slug>`.
 */
function appendAudit(p: string, body: string): void {
  const f = join(p, "aidlc-docs", "audit.md");
  writeFileSync(f, `${readFileSync(f, "utf-8")}\n${body}\n\n---\n`, "utf-8");
}

describe("t84 aidlc-utility doctor — Check 2 stale branches (migrated from t84-doctor-stale-branch.sh, plan 5)", () => {
  // --- Test 1: not a git repo -> skip silently with informational pass ---
  test("1: stale-branch check skips silently when not a git repo", () => {
    const p = proj();
    // No initGitRepo: `git -C <p> branch --list 'bolt-*'` exits non-zero ->
    // the not-a-git-repo informational pass arm (aidlc-utility.ts:689-691).
    const r = doctor(p);
    expect(r.out).toContain("Stale branches: 0 observed (not a git repo)");
  });

  // --- Test 2: clean git repo, zero bolt-* branches -> passes ---
  test("2: stale-branch check passes on clean git repo with zero bolt-* branches", () => {
    const p = proj();
    initGitRepo(p);
    const r = doctor(p);
    expect(r.out).toContain("Stale branches: 0 (0 bolt-* observed)");
  });

  // --- Test 3: stale (branch + no worktree dir + no terminal audit row) -> flagged ---
  test("3: stale branch flagged when worktree dir absent and no terminal audit row", () => {
    const p = proj();
    initGitRepo(p);
    git(p, "branch", "bolt-stalefoo");
    // No .aidlc/worktrees/bolt-stalefoo dir, no WORKTREE_MERGED/_DISCARDED row.
    const r = doctor(p);
    expect(r.out).toContain("Stale branches: 1 drift");
    expect(r.out).toContain("stalefoo");
    // STRONGER than the .sh (which `|| true`-swallowed $?): a stale drift is a
    // doctor failure -> non-zero exit (aidlc-utility.ts:1385).
    expect(r.status).toBe(1);
  });

  // --- Test 4: live (branch + worktree dir present) -> not flagged ---
  test("4: live branch (worktree dir present) is not flagged as stale", () => {
    const p = proj();
    initGitRepo(p);
    git(p, "branch", "bolt-livefoo");
    // worktreePath(p,"livefoo") = <p>/.aidlc/worktrees/bolt-livefoo (lib.ts:155).
    mkdirSync(join(p, ".aidlc", "worktrees", "bolt-livefoo"), {
      recursive: true,
    });
    const r = doctor(p);
    expect(r.out).toContain("Stale branches: 0 (1 bolt-* observed)");
  });

  // --- Test 5: terminated (branch + no worktree + WORKTREE_MERGED row) -> not flagged ---
  test("5: terminated branch (WORKTREE_MERGED row present) is not flagged as stale", () => {
    const p = proj();
    initGitRepo(p);
    git(p, "branch", "bolt-mergedfoo");
    appendAudit(
      p,
      [
        "## Worktree Merged",
        "**Timestamp**: 2026-05-19T10:00:00Z",
        "**Event**: WORKTREE_MERGED",
        "**Bolt slug**: mergedfoo",
        "**Worktree path**: /tmp/bolt-mergedfoo",
        "**Target branch**: main",
        "**Strategy**: squash",
      ].join("\n"),
    );
    const r = doctor(p);
    expect(r.out).toContain("Stale branches: 0 (1 bolt-* observed)");
    // STRONGER than the .sh: the drift label must be ABSENT — a regression
    // that both flags the terminated branch AND counts it (printing a drift
    // line alongside the count) can't slip past the count-only grep.
    expect(r.out).not.toContain("Stale branches: 1 drift");
  });
});
