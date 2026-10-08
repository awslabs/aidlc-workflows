// covers: subcommand:aidlc-bolt:start
//
// t46 — parallel-bolt concurrency. Migrated from
// tests/integration/t46-parallel-bolt.sh (TAP plan 5). The .sh forked 5
// concurrent `bun aidlc-bolt.ts start` OS processes racing on a single
// audit.md and proved the cross-process audit lock prevents lost writes /
// half-writes / separator corruption, with successful process exits.
//
// Mechanism: cli (REQUIRED — not none). The guarantee under test is
// CROSS-PROCESS serialisation of audit.md appends. The lock is a real
// filesystem mkdir-EEXIST lock (acquireAuditLock's shared acquisition backstop
// and 100ms retry cadence), and only separate OS
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
//   .sh 3 (each name appears once)                    -> "each Unit display name appears exactly once"
//   .sh 4 (#Event == #heading, no half-writes)          -> "every BOLT_STARTED has a matching heading (no half-writes)"
//   .sh 5 (separator count == fixture + 5)              -> "separator count == fixture (3) + 5 bolts == 8"
//
// All five assertions are computed off the real bytes on disk after the race,
// the same surfaces the .sh grepped. Several are STRONGER: test 3 asserts
// EXACTLY one occurrence per name (the .sh only grepped presence); test 4
// asserts the two counts equal AND both equal 5 (the .sh only asserted the
// counts equal).

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import {
  setDefaultTimeout,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seedAuditFile,
  seedStateFile,
  seededAuditDir,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath; // the bun running this test
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");

interface RaceResult {
  proj: string;
  body: string;
  elapsedMs: number;
  exitCodes: number[];
  /** Child outcomes and lock-name transitions, attached to failures. */
  diagnostic: string;
}

/** The audit lock lives in the temp directory the children inherit. List only
 *  that directory's lock-related names: opening anything inside a lock
 *  directory is itself what Windows refuses a lock rename for. */
function lockNames(): string[] {
  try {
    return readdirSync(tmpdir()).filter((name) => name.startsWith(".aidlc-audit-")).sort();
  } catch {
    return [];
  }
}

let raceNumber = 0;

/** Concatenate every audit shard (audit/*.md) for the seeded record — the 5
 *  racing processes share one clone-id (pre-seeded below) so they contend on a
 *  single shard, but the fixture rides a separate fixture.md shard, so we merge. */
function readAllShards(proj: string): string {
  const dir = seededAuditDir(proj);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  return names.map((n) => readFileSync(join(dir, n), "utf-8")).join("\n");
}

let current: { proj: string } | null = null;

/**
 * Fork 5 concurrent `bun aidlc-bolt.ts start --name unit-<i> --batch 1
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
  // Pre-seed a stable clone-id so all 5 racing processes resolve the SAME
  // per-clone audit shard (the cross-process audit-lock serialisation under test
  // is on one shard file). Without this, the 5 processes would race to MINT the
  // clone-id and a first-run mint race could split the 5 writes across two shards
  // — non-deterministic. The lock contention this test asserts is unchanged.
  mkdirSync(join(proj, "aidlc"), { recursive: true });
  writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), "cccccccccccc\n", "utf-8");

  const start = Date.now();
  // Record each change in the lock names so a stalled race shows whether its
  // owner was still claiming and retiring, and which names outlived the race.
  const transitions: Array<{ ms: number; names: string[] }> = [];
  let previous = "";
  const sample = () => {
    const names = lockNames();
    const key = names.join("\n");
    if (key !== previous && transitions.length < 2000) {
      previous = key;
      transitions.push({ ms: Date.now() - start, names });
    }
  };
  sample();
  const sampler = setInterval(sample, 50);
  const procs = [1, 2, 3, 4, 5].map((i) =>
    Bun.spawn({
      cmd: [
        BUN,
        BOLT,
        "start",
        "--name",
        `unit-${i}`,
        "--batch",
        "1",
        "--walking-skeleton",
        "false",
        "--project-dir",
        proj,
      ],
      stdout: "pipe",
      stderr: "pipe",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    }),
  );
  const children = await Promise.all(procs.map(async (p, index) => {
    const [code, stdout, stderr] = await Promise.all([
      p.exited, new Response(p.stdout).text(), new Response(p.stderr).text(),
    ]);
    return { unit: index + 1, pid: p.pid, code, signal: p.signalCode, exitedMs: Date.now() - start, stdout, stderr };
  }));
  clearInterval(sampler);
  sample();
  const exitCodes = children.map((child) => child.code);
  const elapsedMs = Date.now() - start;
  const race = ++raceNumber;
  const diagnostic = JSON.stringify({ race, elapsedMs, tmpdir: tmpdir(), children, transitions }, null, 1);
  // Keep the whole record with the run's evidence; failures also inline it.
  try {
    const logs = process.env.AIDLC_TEST_LOG_DIR ?? tmpdir();
    appendFileSync(join(logs, "t46-parallel-bolt-races.ndjson"), `${JSON.stringify({ race, elapsedMs, children, transitions })}\n`);
  } catch {
    // Evidence is best effort; the assertions below still decide the case.
  }

  return { proj, body: readAllShards(proj), elapsedMs, exitCodes, diagnostic };
}

// Run the race once per test (each test gets a fresh project + fresh race) so
// a single test failing can't poison the others, matching the .sh's single
// race feeding 5 independent greps. Teardown removes the temp project.
let race: RaceResult;

beforeEach(async () => {
  race = await raceFiveBolts();
}, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

afterEach(() => {
  cleanupTestProject(current?.proj);
  current = null;
});

describe("t46 parallel-bolt — 5 racing aidlc-bolt start processes (migrated from t46-parallel-bolt.sh, plan 5)", () => {
  test("completes under the 10s lock-timeout ceiling [.sh 1]", () => {
    // Keep the historical case name for evidence continuity. Successful exits
    // prove all contenders acquired and released the lock; process startup
    // and owner probing are not a lock-speed contract.
    expect(race.exitCodes, race.diagnostic).toEqual([0, 0, 0, 0, 0]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("all 5 BOLT_STARTED entries land (no lost writes) [.sh 2]", () => {
    // The .sh: grep -cE '^\*\*Event\*\*: BOLT_STARTED'. Count exactly 5 — a
    // lost write under the race would drop this below 5.
    const eventCount = race.body
      .split("\n")
      .filter((l) => l === "**Event**: BOLT_STARTED").length;
    expect(eventCount, race.diagnostic).toBe(5);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("each Unit display name appears exactly once [.sh 3]", () => {
    // Human display names are audit identities, not physical Bolt branch names.
    const lines = race.body.split("\n");
    for (let i = 1; i <= 5; i++) {
      const hits = lines.filter((l) => l === `**Bolt names**: unit-${i}`).length;
      expect(hits, race.diagnostic).toBe(1);
    }
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    expect(headingCount, race.diagnostic).toBe(eventCount);
    expect(eventCount, race.diagnostic).toBe(5);
    expect(headingCount, race.diagnostic).toBe(5);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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
    expect(actualDashes, race.diagnostic).toBe(fixtureDashes + 5);
    expect(actualDashes, race.diagnostic).toBe(8);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
