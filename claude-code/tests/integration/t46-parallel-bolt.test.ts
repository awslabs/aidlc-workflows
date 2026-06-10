// covers: subcommand:aidlc-bolt:start
//
// t46 — parallel-bolt concurrency. Migrated from
// tests/integration/t46-parallel-bolt.sh (TAP plan 5). The .sh forked 5
// concurrent `bun aidlc-bolt.ts start` OS processes racing on a single
// audit.md and proved the cross-process audit lock prevents lost writes /
// half-writes / separator corruption, all under a wall-clock ceiling.
//
// Mechanism: cli (REQUIRED — not none). The guarantee under test is
// CROSS-PROCESS serialisation of audit.md appends. The lock is a real
// filesystem mkdir-EEXIST lock (aidlc-lib.ts:517-534 acquireAuditLock:
// `mkdirSync(lockDir)` with 50×100ms retries), and only separate OS
// processes exercise it — an in-process loop would share one Bun runtime,
// trip the AUDIT_LOCK_DEPTH reentrancy counter (aidlc-lib.ts:567), and prove
// nothing about concurrency. So the twin SPAWNS 5 real `bun aidlc-bolt.ts
// start` processes via Bun.spawn and races them, exactly as the .sh forked
// `bun "$BOLT" start ... &`. spawnCount = all.
//
// Source under test:
//   dist/claude/.claude/tools/aidlc-bolt.ts
//     :149 handleStart — validates --name/--batch, then emitAudit("BOLT_STARTED",
//          { "Bolt names": <name>, "Batch number": <batch>,
//            "Walking skeleton": <bool> }) via appendAuditEntry (:197).
//   dist/claude/.claude/tools/aidlc-audit.ts
//     :214 appendAuditEntry — acquireAuditLock → appendAuditEntryUnlocked →
//          releaseAuditLock (the locked critical section each process enters).
//     :254 heading = EVENT_HEADINGS["BOLT_STARTED"] = "Bolt Started" (:153);
//          each block = "\n## Bolt Started\n**Timestamp**: <iso>\n**Event**:
//          BOLT_STARTED\n**Bolt names**: <name>\n...\n\n---\n".
//
// Fixture discipline (mirrors the .sh): a fresh temp project with an
// aidlc-docs/ dir, seeded with audit-sample.md (3 `---` separators) + a
// mid-ideation state file so any accidental error path lands cleanly. Torn
// down in afterEach. Nothing written under tests/fixtures/**.
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh 1 (elapsed < 10s ceiling)                       -> "completes under the 10s lock-timeout ceiling"
//   .sh 2 (5 BOLT_STARTED entries, no lost writes)      -> "all 5 BOLT_STARTED entries land (no lost writes)"
//   .sh 3 (each bolt-1..bolt-5 name appears once)       -> "each of bolt-1..bolt-5 appears exactly once"
//   .sh 4 (#Event == #heading, no half-writes)          -> "every BOLT_STARTED has a matching heading (no half-writes)"
//   .sh 5 (separator count == fixture + 5)              -> "separator count == fixture (3) + 5 bolts == 8"
//
// All five assertions are computed off the real bytes on disk after the race,
// the same surfaces the .sh grepped. Several are STRONGER: test 3 asserts
// EXACTLY one occurrence per name (the .sh only grepped presence); test 4
// asserts the two counts equal AND both equal 5 (the .sh only asserted the
// counts equal).

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seedAuditFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");

interface RaceResult {
  proj: string;
  audit: string;
  body: string;
  elapsedMs: number;
}

let current: { proj: string } | null = null;

/**
 * Fork 5 concurrent `bun aidlc-bolt.ts start --name bolt-<i> --batch 1
 * --walking-skeleton false` processes against one audit.md (mirrors the .sh's
 * `for i in 1..5; bun "$BOLT" start ... &` + wait). Returns the post-race
 * bytes + wall-clock elapsed. Uses Bun.spawn (async, non-blocking launch) so
 * all 5 are genuinely in flight before any awaits — a true race, not a serial
 * loop. resetAidlcEnv() first so a leaked default scope can't shift behaviour.
 */
async function raceFiveBolts(): Promise<RaceResult> {
  resetAidlcEnv();
  const proj = createTestProject();
  current = { proj };
  seedAuditFile(proj);
  // Bolt-start doesn't require state, but emitError's workflow check does;
  // seed it so any accidental error path lands cleanly (mirrors the .sh).
  seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
  const audit = join(proj, "aidlc-docs", "audit.md");

  const start = Date.now();
  const procs = [1, 2, 3, 4, 5].map((i) =>
    Bun.spawn({
      cmd: [
        BUN,
        BOLT,
        "start",
        "--name",
        `bolt-${i}`,
        "--batch",
        "1",
        "--walking-skeleton",
        "false",
        "--project-dir",
        proj,
      ],
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
  // Wait for all 5 to exit (mirrors the .sh's `wait "$pid" || true`).
  await Promise.all(procs.map((p) => p.exited));
  const elapsedMs = Date.now() - start;

  return { proj, audit, body: readFileSync(audit, "utf-8"), elapsedMs };
}

// Run the race once per test (each test gets a fresh project + fresh race) so
// a single test failing can't poison the others, matching the .sh's single
// race feeding 5 independent greps. Teardown removes the temp project.
let race: RaceResult;

beforeEach(async () => {
  race = await raceFiveBolts();
});

afterEach(() => {
  cleanupTestProject(current?.proj);
  current = null;
});

describe("t46 parallel-bolt — 5 racing aidlc-bolt start processes (migrated from t46-parallel-bolt.sh, plan 5)", () => {
  test("completes under the 10s lock-timeout ceiling [.sh 1]", () => {
    // Lock retry budget is 50×100ms = 5s max wait per process; with 5 racing,
    // worst case the last waits ~500ms. The .sh ceilinged at 10s to catch real
    // hangs while leaving headroom. Same ceiling here (in ms).
    expect(race.elapsedMs).toBeLessThan(10_000);
  }, 30_000);

  test("all 5 BOLT_STARTED entries land (no lost writes) [.sh 2]", () => {
    // The .sh: grep -cE '^\*\*Event\*\*: BOLT_STARTED'. Count exactly 5 — a
    // lost write under the race would drop this below 5.
    const eventCount = race.body
      .split("\n")
      .filter((l) => l === "**Event**: BOLT_STARTED").length;
    expect(eventCount).toBe(5);
  }, 30_000);

  test("each of bolt-1..bolt-5 appears exactly once [.sh 3]", () => {
    // The .sh grepped presence per name; STRONGER here — assert EXACTLY one
    // `**Bolt names**: bolt-<i>` line per i, so no name is dropped or doubled.
    const lines = race.body.split("\n");
    for (let i = 1; i <= 5; i++) {
      const hits = lines.filter((l) => l === `**Bolt names**: bolt-${i}`).length;
      expect(hits).toBe(1);
    }
  }, 30_000);

  test("every BOLT_STARTED has a matching heading (no half-writes) [.sh 4]", () => {
    // The .sh compared #'**Event**: BOLT_STARTED' to #'## Bolt Started': any
    // half-written block would diverge the counts. STRONGER: assert equal AND
    // both == 5 (a coherent-but-short pair would pass the .sh's equality but
    // fail here).
    const lines = race.body.split("\n");
    const eventCount = lines.filter(
      (l) => l === "**Event**: BOLT_STARTED",
    ).length;
    const headingCount = lines.filter((l) => l === "## Bolt Started").length;
    expect(headingCount).toBe(eventCount);
    expect(eventCount).toBe(5);
    expect(headingCount).toBe(5);
  }, 30_000);

  test("separator count == fixture (3) + 5 bolts == 8 [.sh 5]", () => {
    // The .sh: expected = #'^---$' in audit-sample.md (3) + 5. Each well-formed
    // block closes with a standalone "---", so 5 clean appends add exactly 5.
    const fixtureDashes = readFileSync(
      join(FIXTURES_DIR, "audit-sample.md"),
      "utf-8",
    )
      .split("\n")
      .filter((l) => l === "---").length;
    const actualDashes = race.body.split("\n").filter((l) => l === "---").length;
    expect(fixtureDashes).toBe(3); // pin the fixture precondition the .sh relied on
    expect(actualDashes).toBe(fixtureDashes + 5);
    expect(actualDashes).toBe(8);
  }, 30_000);
});
