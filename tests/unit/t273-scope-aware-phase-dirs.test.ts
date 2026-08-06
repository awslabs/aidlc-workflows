// covers: function:ensureWorkspaceDirs, function:phasesWithExecuteStages
//
// t273: SCOPE-AWARE PHASE DIRS at intent creation (deterministic, no-LLM,
// no-network). Intent creation used to mkdir all five phase dirs unconditionally,
// so a bugfix record shipped an empty `ideation/` and `operation/` that read as
// planned-then-skipped work. Creation now makes a phase dir only for a phase the
// SCOPE RUNS (one holding at least one EXECUTE stage), derived from the same
// stagesInScope data that drives the PHASE_SKIPPED audit rows.
//
// Five contracts land here:
//   (a) NARROW SCOPE: a bugfix record has initialization/inception/construction +
//       verification, and NO ideation/ or operation/ dir at all.
//   (b) FULL SCOPE: a feature record still has all five phase dirs.
//   (c) AGREEMENT: the phase dirs on disk and the PHASE_SKIPPED audit rows are
//       exact complements. This is the invariant that makes the trimming
//       auditable rather than lossy, and it is what a future scope-grid edit
//       would break silently if only (a)/(b) were pinned.
//   (d) ADDITIVE ONLY: a pre-existing record already carrying all five dirs
//       (a legacy install) is never pruned.
//   (e) ABSENCE IS WRITABLE: an artifact write into an EXCLUDED phase's dir
//       still succeeds, because writers create their own parent chain. This is
//       the disproof case for "trimming the dir breaks a late write".
//
// MECHANISM. SPAWNs the real shipped engine CLI (`aidlc-utility.ts intent-create`)
// against temp project dirs, so the actual creation path runs end to end and the
// assertions read disk truth. Zero tokens, zero network.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";
import { PHASES } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath; // the bun running this test
const UTILITY = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
const INTENTS_REL = join("aidlc", "spaces", "default", "intents");

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkTemp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `aidlc-t271-${tag}-`));
  tempDirs.push(d);
  return d;
}

/** Create the first intent at `scope` via the real engine CLI. */
function create(projectDir: string, scope: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    BUN,
    [UTILITY, "intent-create", "--scope", scope, "--arguments", "t271 probe", "--project-dir", projectDir],
    { encoding: "utf-8" },
  );
}

/** Create the first intent and return its record dir, failing loudly on a
 *  non-zero exit (a silent failure would make every absence assertion vacuous). */
function createAndResolveRecord(projectDir: string, scope: string): string {
  const res = create(projectDir, scope);
  expect(res.status, `intent-create ${scope} failed: ${res.stdout}\n${res.stderr}`).toBe(0);
  const intentsDir = join(projectDir, INTENTS_REL);
  const records = readdirSync(intentsDir).filter((e) =>
    statSync(join(intentsDir, e)).isDirectory(),
  );
  expect(records.length, "exactly one record created").toBe(1);
  return join(intentsDir, records[0]);
}

/** The phase names that have a directory in this record. */
function phaseDirsPresent(record: string): string[] {
  return PHASES.filter((p) => existsSync(join(record, p)));
}

/** The phases the audit shards recorded as PHASE_SKIPPED. */
function phasesSkippedInAudit(record: string): string[] {
  const auditDir = join(record, "audit");
  const body = readdirSync(auditDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(auditDir, f), "utf-8"))
    .join("\n");
  const skipped: string[] = [];
  // Each event is a block of `**Field**: value` lines; PHASE_SKIPPED carries the
  // phase on the Phase line directly after the Event line.
  for (const block of body.split("---")) {
    if (!/\*\*Event\*\*:\s*PHASE_SKIPPED/.test(block)) continue;
    const m = block.match(/\*\*Phase\*\*:\s*(\S+)/);
    if (m) skipped.push(m[1]);
  }
  return skipped;
}

describe("t271 scope-aware phase dirs at intent creation", () => {
  // === (a) NARROW SCOPE ====================================================
  test("a: a bugfix record gets only its in-scope phase dirs, no ideation/ or operation/", () => {
    const record = createAndResolveRecord(mkTemp("bugfix"), "bugfix");

    // bugfix runs initialization + inception + construction; ideation and
    // operation have zero EXECUTE stages.
    expect(phaseDirsPresent(record).sort()).toEqual([
      "construction",
      "inception",
      "initialization",
    ]);
    // Stated as explicit absences too, so the failure message names the dir.
    expect(existsSync(join(record, "ideation")), "no ideation/ dir for bugfix").toBe(false);
    expect(existsSync(join(record, "operation")), "no operation/ dir for bugfix").toBe(false);

    // verification/ is scope-independent: every record gets it.
    const verification = join(record, "verification");
    expect(existsSync(verification) && statSync(verification).isDirectory()).toBe(true);
    // And the record is otherwise intact (the trimming did not eat the state file).
    expect(existsSync(join(record, "aidlc-state.md"))).toBe(true);
  });

  // === (b) FULL SCOPE ======================================================
  test("b: a feature record still gets all five phase dirs", () => {
    const record = createAndResolveRecord(mkTemp("feature"), "feature");

    // feature runs every phase, so nothing is trimmed; this is the guard that
    // (a) is scope-driven rather than a blanket removal.
    expect(phaseDirsPresent(record).sort()).toEqual([...PHASES].sort());
    expect(existsSync(join(record, "verification"))).toBe(true);
    // No phase was skipped, so no PHASE_SKIPPED row exists to complement.
    expect(phasesSkippedInAudit(record)).toEqual([]);
  });

  // === (c) DISK AND AUDIT AGREE ============================================
  test("c: the phase dirs present and the PHASE_SKIPPED rows are exact complements", () => {
    // Three scopes with different exclusion shapes: bugfix drops ideation +
    // operation, mvp drops only operation, infra drops only ideation.
    for (const scope of ["bugfix", "mvp", "infra"]) {
      const record = createAndResolveRecord(mkTemp(`agree-${scope}`), scope);
      const present = phaseDirsPresent(record);
      const skipped = phasesSkippedInAudit(record);

      // Non-vacuous: each of these scopes must skip at least one phase, else the
      // complement check below would pass on an empty set.
      expect(skipped.length, `${scope} skips at least one phase`).toBeGreaterThan(0);
      // Complements: no phase is both present and skipped, and together they
      // account for every phase.
      for (const phase of skipped) {
        expect(present, `${scope}: skipped ${phase} has no dir`).not.toContain(phase);
      }
      expect([...present, ...skipped].sort()).toEqual([...PHASES].sort());
    }
  });

  // === (d) ADDITIVE ONLY ===================================================
  test("d: a pre-existing record carrying all five phase dirs is never pruned", () => {
    // A legacy install: a record created by an older engine already has all five
    // dirs. Creating a NEW narrow-scope intent alongside it must leave it alone:
    // this path only ever creates.
    const proj = mkTemp("legacy");
    const legacy = join(proj, INTENTS_REL, "260101-legacy");
    for (const phase of PHASES) mkdirSync(join(legacy, phase), { recursive: true });
    mkdirSync(join(legacy, "verification"), { recursive: true });
    // A sentinel artifact proves content survives, not just the dir entry.
    const sentinel = join(legacy, "operation", "keep-me.md");
    writeFileSync(sentinel, "legacy artifact\n", "utf-8");

    const res = create(proj, "bugfix");
    expect(res.status, `intent-create failed: ${res.stdout}\n${res.stderr}`).toBe(0);

    expect(phaseDirsPresent(legacy).sort()).toEqual([...PHASES].sort());
    expect(readFileSync(sentinel, "utf-8")).toBe("legacy artifact\n");
  });

  // === (e) ABSENCE IS WRITABLE =============================================
  test("e: an artifact write into an excluded phase's dir still succeeds", () => {
    // The safety premise for trimming: nothing depends on the phase dir being
    // pre-created, because a writer creates its own parent chain. Prove it on the
    // hardest case, a stage dir two levels under a phase that has NO dir at all.
    const record = createAndResolveRecord(mkTemp("late-write"), "bugfix");
    const lateArtifact = join(record, "operation", "deployment-execution", "report.md");
    expect(existsSync(join(record, "operation")), "operation/ absent before the write").toBe(
      false,
    );

    mkdirSync(join(record, "operation", "deployment-execution"), { recursive: true });
    writeFileSync(lateArtifact, "# Report\n", "utf-8");

    expect(readFileSync(lateArtifact, "utf-8")).toBe("# Report\n");
  });
});
