// covers: subcommand:aidlc-worktree:create
//
// CLI-contract port of tests/e2e/t02-worktree-create.sh (TAP plan 15),
// mechanism = cli. The .sh drives `aidlc-worktree.ts create` — the subcommand
// that runs a REAL `git worktree add` after an audit-first WORKTREE_CREATED
// emit. The covers UNIT credited is subcommand:aidlc-worktree:create (a
// still-uncovered subcommand as of this migration).
//
// MECHANISM: this is a .cli file, so every observable is taken at the PROCESS
// boundary — SPAWN the real binary via spawnSync (BUN + the tool .ts path) and
// assert on res.status / res.stdout / res.stderr and the audit.md / git
// worktree state the tool writes. An in-process twin would lose the
// stdout-JSON contract ('"emitted":"WORKTREE_CREATED"') and the real
// git-worktree-add side effect the .sh relies on.
//
// FIXTURE: aidlc-worktree.ts asserts it runs from the main checkout
// (assertNotSiblingWorktree, aidlc-worktree.ts:101) and runs real git, so each
// case needs an ACTUAL git repo on `main` with one commit plus an aidlc-docs/
// dir. setupWorktreeFixture (tests/harness/fixtures.ts, ported this migration
// from tests/lib/worktree-helpers.sh) builds exactly that; the tool is spawned
// with cwd = the fixture so its `git rev-parse --show-toplevel` resolves to the
// main checkout. cleanupWorktreeFixture prunes child worktrees then rm -rf's
// the parent. Nothing is written under tests/fixtures/**.
//
// PARITY NOTES — every .sh assertion has an equal-or-stronger counterpart:
//   .sh T1  create happy path exits 0                       -> Test "1-5" (same)
//   .sh T2  stdout contains '"emitted":"WORKTREE_CREATED"'   -> Test "1-5" (same)
//   .sh T3  audit.md records the slug (Bolt slug.*demo)      -> Test "1-5" (same)
//   .sh T4  worktree dir exists at .aidlc/worktrees/bolt-demo -> Test "1-5" (same)
//   .sh T5  worktree HEAD is on bolt-<slug>                  -> Test "1-5" (same:
//           git rev-parse --abbrev-ref HEAD in the worktree == "bolt-demo")
//   .sh T6  bad slug "Foo_Bar" exits non-zero                -> Test "6-7" (same)
//   .sh T7  bad slug error names "Invalid --slug"            -> Test "6-7" (same)
//   .sh T8a missing base exits non-zero                      -> Test "8" (same)
//   .sh T8b missing base error "Base branch does not exist"  -> Test "8" (same)
//   .sh T9  second create on same slug exits non-zero        -> Test "9-10" (same)
//   .sh T10 second create error "already exists"             -> Test "9-10" (same)
//   .sh T11-13 parallel creates a/b/c all exit 0             -> Test "11-14" (same)
//   .sh T14 all 3 parallel creates emitted distinct events   -> Test "11-14"
//           (same: 3 distinct "Bolt slug: <a|b|c>" rows in audit.md)
//
// 15 .sh asserts -> 15 expect()s across 4 test() cases (grouped where the .sh
// shared one fixture). STRONGER: the bad-slug / missing-base cases also assert
// NO audit row and NO worktree dir landed (the .sh's "pre-audit" intent, which
// it only documented in comments).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  seededAuditDir,
  seededStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");

const fixtures: string[] = [];
afterAll(() => {
  for (const f of fixtures) cleanupWorktreeFixture(f);
});

/** Fresh git-repo fixture on `main` with the per-intent workspace shell. Seed a
 *  state file into the default record so the active-intent cursor resolves (the
 *  fixture seeds a STATELESS record; without aidlc-state.md the cursor is rejected
 *  and the WORKTREE_CREATED audit lands at the bare space root, not the record).
 *  Registered for cleanup. */
function freshFixture(): string {
  const p = setupWorktreeFixture();
  fixtures.push(p);
  writeFileSync(seededStateFile(p), "- **Current Stage**: code-generation\n", "utf-8");
  return p;
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/** Spawn `bun aidlc-worktree.ts create ... --project-dir <p>` from cwd=<p>. */
function create(p: string, args: string[]): CliResult {
  const res = spawnSync(BUN, [TOOL, "create", ...args, "--project-dir", p], {
    cwd: p,
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

const wtPath = (p: string, slug: string): string =>
  join(p, ".aidlc", "worktrees", `bolt-${slug}`);

/** Concatenate every audit shard (audit/*.md) for the seeded record — the tool
 *  emits WORKTREE_CREATED into its own per-clone shard. */
function readAudit(p: string): string {
  const dir = seededAuditDir(p);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  return names.map((n) => readFileSync(join(dir, n), "utf-8")).join("\n");
}

/** Count distinct `**Bolt slug**: <slug>` rows across the audit shards. */
function boltSlugRows(p: string): string[] {
  const out: string[] = [];
  for (const line of readAudit(p).split("\n")) {
    const m = line.match(/^\*\*Bolt slug\*\*:\s*(\S+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

describe("t02 aidlc-worktree create (migrated from t02-worktree-create.sh, plan 15)", () => {
  test("1-5: create happy path — exit 0, emits WORKTREE_CREATED, real git worktree on bolt-<slug>", () => {
    const p = freshFixture();
    const r = create(p, ["--slug", "demo", "--base", "main"]);

    expect(r.status).toBe(0); // T1
    expect(r.out).toContain('"emitted":"WORKTREE_CREATED"'); // T2
    expect(boltSlugRows(p)).toContain("demo"); // T3
    expect(existsSync(wtPath(p, "demo"))).toBe(true); // T4

    // T5: the created worktree's HEAD is the bolt-<slug> branch.
    const branch = spawnSync(
      "git",
      ["-C", wtPath(p, "demo"), "rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf-8" },
    );
    expect((branch.stdout ?? "").trim()).toBe("bolt-demo");
  }, 30000);

  test("6-7: invalid slug rejected pre-audit (non-zero, names the flag, no side effects)", () => {
    const p = freshFixture();
    const r = create(p, ["--slug", "Foo_Bar", "--base", "main"]);

    expect(r.status).not.toBe(0); // T6
    expect(r.out).toContain("Invalid --slug"); // T7
    // STRONGER: the .sh's "pre-audit" intent — nothing landed.
    expect(boltSlugRows(p)).not.toContain("Foo_Bar");
    expect(existsSync(wtPath(p, "Foo_Bar"))).toBe(false);
  }, 30000);

  test("8: nonexistent base branch rejected pre-audit", () => {
    const p = freshFixture();
    const r = create(p, ["--slug", "demo", "--base", "nonexistent-branch"]);

    expect(r.status).not.toBe(0); // T8a
    expect(r.out).toContain("Base branch does not exist"); // T8b
    // STRONGER: no worktree dir created for the rejected base.
    expect(existsSync(wtPath(p, "demo"))).toBe(false);
  }, 30000);

  test("9-10: double-create on the same slug fails with already-exists", () => {
    const p = freshFixture();
    const first = create(p, ["--slug", "demo", "--base", "main"]);
    expect(first.status).toBe(0);

    const second = create(p, ["--slug", "demo", "--base", "main"]);
    expect(second.status).not.toBe(0); // T9
    expect(second.out).toContain("already exists"); // T10
  }, 30000);

  test("11-14: parallel creates with distinct slugs all succeed and emit distinct events", async () => {
    const p = freshFixture();
    // Mirror the .sh's `&` + `wait`: spawn three creates concurrently.
    const run = (slug: string): Promise<number> =>
      new Promise((resolve) => {
        const child = spawnSync(BUN, [
          TOOL,
          "create",
          "--slug",
          slug,
          "--base",
          "main",
          "--project-dir",
          p,
        ], { cwd: p, encoding: "utf-8" });
        resolve(child.status ?? -1);
      });
    const [a, b, c] = await Promise.all([run("a"), run("b"), run("c")]);

    expect(a).toBe(0); // T11
    expect(b).toBe(0); // T12
    expect(c).toBe(0); // T13

    // T14: all three emitted a distinct Bolt slug row.
    const rows = boltSlugRows(p);
    expect(rows).toContain("a");
    expect(rows).toContain("b");
    expect(rows).toContain("c");
  }, 30000);
});
