// covers: audit:GUARDRAIL_LOADED
//
// CLI-contract port of tests/integration/t105-doctor-paired-coverage.sh (TAP
// plan 6), mechanism = cli. Drives the REAL `/aidlc --doctor` handler by
// SPAWNING the utility CLI via node:child_process spawnSync (BUN +
// aidlc-utility.ts) against AIDLC_RULES_DIR fixtures and the seed
// stage-graph (AIDLC_STAGE_GRAPH), exactly as the .sh's run_doctor helper
// did (t105:41-47). The contract under test is the PROCESS boundary plus
// the side effect the tool writes — the paired-coverage advisory row on
// stdout and the GUARDRAIL_LOADED block appended to aidlc-docs/audit.md.
// An in-process twin would lose the audit-file write (doctor calls
// appendAuditEvent -> appendAuditEntry, which self-creates the file/dir
// under projectDir, aidlc-audit.ts:186-196) and the process.exit shell the
// .sh swallowed with `|| true` (doctor exits 1 on any failed check,
// aidlc-utility.ts:1385). So all cases stay spawn-based.
//
// GUARDRAIL_LOADED contract (aidlc-utility.ts:1348-1352, audit row shape at
// aidlc-audit.ts:251-267, heading map :173):
//   ## Guardrail Loaded
//   **Event**: GUARDRAIL_LOADED
//   **Scope**: all
//   **Path**: .claude/rules/
//   **Rule count**: <N>   (N = pairedRules.length = loadRules() count over
//                          AIDLC_RULES_DIR)
// Emitted once per doctor run, in BOTH the needing>0 branch and the
// needing==0 (no-sensor-bound) branch (utility.ts:1335-1352 — the emit sits
// AFTER the branch and always fires).
//
// Paired-coverage label contract (utility.ts:1333-1346): P/(M-X) fraction
// where M = rules carrying frontmatter.pairing, X = feedforward-only count,
// needing = M-X, P = rules whose pairing sensor id (aidlc- stripped) resolves
// in the seed graph's sensors_applicable set. needing==0 -> the
// "no sensor-bound rules" label. Unpaired rules (named sensor absent
// everywhere) append "unpaired: <path> → <sensor> (no stage binds it)".
//
// EQUAL-OR-STRONGER PARITY (every .sh `ok`/`assert` maps to an expect()):
//   - .sh case 1 assert_contains "Paired sensor coverage: 1/2 guardrails
//       paired (1 feedforward-only)"            -> test 1 (same substring).
//   - .sh case 2 assert_contains
//       "unpaired: .claude/rules/aidlc-team.md → aidlc-ghost (no stage binds
//       it)"                                    -> test 2 (same substring).
//   - .sh case 3 COV_LINE grep "^✓" on the coverage line -> test 3: the
//       coverage line is prefixed "✓  " (advisory pass), asserted by isolating
//       the "Paired sensor coverage:" line and checking its ✓ prefix.
//   - .sh case 4 audit.md has GUARDRAIL_LOADED AND "## Guardrail Loaded"
//       headings                                -> test 4: BOTH preserved;
//       STRONGER — auditEventCount(...,"GUARDRAIL_LOADED")===1 (exact count
//       against a fresh-project zero baseline, not a bare presence grep) AND
//       the heading present.
//   - .sh case 5 grep "^**Scope**: all" + "^**Path**: .claude/rules/" +
//       "^**Rule count**: 3"                    -> test 5: STRONGER —
//       block-scoped exact field values on the GUARDRAIL_LOADED block
//       (Scope==="all", Path===".claude/rules/", Rule count==="3"). The .sh's
//       `grep "^\*\*Path\*\*: .claude/rules/"` is a regex whose `.` is any-char;
//       we assert the exact literal ".claude/rules/" (the tool writes it
//       literally, utility.ts:1350).
//   - .sh case 6 no-pairing fixture -> stdout
//       "Paired sensor coverage: no sensor-bound rules (0 feedforward-only)"
//       AND audit has GUARDRAIL_LOADED -> test 6: both preserved; STRONGER —
//       GUARDRAIL_LOADED count===1 AND Rule count==="1" (the single
//       no-pairing org rule), pinning the M-X==0 branch still emits the row
//       with the right rule count.
//
// FIXTURE DISCIPLINE (mirrors the .sh's mktemp -d rules dir + per-call fresh
// project + rm -rf): each runDoctor() builds a FRESH temp project
// (toPortablePath-wrapped so the audit.md the tool writes via forward-slash
// helpers round-trips when read back on Windows — mirrors createTestProject)
// and points AIDLC_RULES_DIR at a FRESH temp rules dir written inline. The
// seed stage-graph (AIDLC_STAGE_GRAPH = dist .../data/stage-graph.json) is the
// shipped graph whose sensors_applicable carries required-sections /
// upstream-coverage — exactly the .sh's SEED_GRAPH. NOTHING is written under
// tests/fixtures/**; all temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toPortablePath } from "../harness/fixtures.ts";
import {
  auditFilePath,
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// P9: with no intent cursor seeded, doctor's appendAuditEvent resolves the BARE
// space record root's per-clone audit SHARD (auditFilePath -> aidlc/spaces/
// default/intents/audit/<host>-<clone>.md) — the flat aidlc-docs/audit.md is
// retired. Seed + read THAT shard. The single-clone fixture means the shard is
// the whole trail (no merge needed).
const RECORD_REL = join("aidlc", "spaces", "default", "intents");
function recordRoot(proj: string): string {
  return join(proj, RECORD_REL);
}

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const AIDLC_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SEED_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

interface DoctorResult {
  rc: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  proj: string; // the fresh project dir; caller reads its audit.md
}

/**
 * run_doctor (t105:41-47): fresh project dir (survives the call so the test
 * reads aidlc-docs/audit.md), AIDLC_RULES_DIR + AIDLC_STAGE_GRAPH env, spawn
 * `bun aidlc-utility.ts doctor --project-dir <proj>` capturing stdout+stderr.
 * doctor process.exit(1)s on any failed check; the .sh swallowed that with
 * `|| true`, so the rc is captured but not asserted (advisory row + audit
 * write are the contract). toPortablePath wraps the project dir for the
 * Windows audit.md round-trip.
 */
function runDoctor(rulesDir: string): DoctorResult {
  const proj = toPortablePath(mkdtempSync(join(tmpdir(), "aidlc-t105-proj-")));
  tempDirs.push(proj);
  mkdirSync(recordRoot(proj), { recursive: true });
  // Seed the per-clone audit shard so doctor's GUARDRAIL_LOADED / HEALTH_CHECKED
  // emits fire. As of v0.6.10 doctor is COLD-SAFE: on a project with no audit
  // shard it prints the health report and creates NOTHING (it no longer
  // self-scaffolds the audit file as a side effect — see t27 test 13b). This
  // suite asserts the GUARDRAIL_LOADED row's content, which is the
  // initialized-project path, so we seed the shard the tool resolves first.
  // (The pristine/cold-safe arm is covered by t27.) A bare header line is enough
  // for appendAuditEntry to append onto.
  const shard = auditFilePath(proj);
  mkdirSync(dirname(shard), { recursive: true });
  writeFileSync(shard, "# AI-DLC Audit Log\n", "utf-8");
  const res = spawnSync(BUN, [UTIL, "doctor", "--project-dir", proj], {
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_RULES_DIR: rulesDir,
      AIDLC_STAGE_GRAPH: SEED_GRAPH,
    },
  });
  return {
    rc: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    proj,
  };
}

/** Make a fresh temp rules dir; returns its path (cleaned in afterAll). */
function makeRulesDir(): string {
  const rd = mkdtempSync(join(tmpdir(), "aidlc-t105-cov-"));
  tempDirs.push(rd);
  return rd;
}

// The merged per-clone audit trail doctor wrote (its SUBPROCESS mints its own
// clone-id, distinct from the test process's memoized one, so read the whole
// audit/ dir rather than a single memoized shard path).
function readAudit(proj: string): string {
  return readAllAuditShards(proj);
}

/**
 * Count audit blocks with `**Event**: <ev>`. Mirrors the .sh's `grep -q
 * "GUARDRAIL_LOADED"` but as an exact count against a fresh-project zero
 * baseline (STRONGER than bare presence).
 */
function auditEventCount(proj: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return readAudit(proj)
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/** Whole-trail presence of a needle (mirrors a bare unanchored grep). */
function fileContains(proj: string, needle: string): boolean {
  return readAudit(proj).includes(needle);
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Resets at `## ` headings and `---` separators; splits `**label**: value`
 * on the literal `**: `. Mirrors the audit_field helper in t31.cli.test.ts.
 * Returns "" when absent.
 */
function auditField(proj: string, ev: string, key: string): string {
  let matched = false;
  for (const line of readAudit(proj).split("\n")) {
    if (line.startsWith("## ")) {
      matched = false;
      continue;
    }
    if (line === "---") {
      matched = false;
      continue;
    }
    if (line.startsWith("**Event**: ")) {
      matched = line === `**Event**: ${ev}`;
      continue;
    }
    if (matched && line.startsWith("**")) {
      const stripped = line.replace(/^\*\*/, "");
      const pos = stripped.indexOf("**: ");
      if (pos > 0) {
        const label = stripped.slice(0, pos);
        const value = stripped.slice(pos + 4);
        if (label === key) return value;
      }
    }
  }
  return "";
}

/** Isolate the "Paired sensor coverage:" line from doctor stdout (case 3). */
function coverageLine(out: string): string {
  return (
    out.split("\n").find((l) => l.includes("Paired sensor coverage:")) ?? ""
  );
}

// ---------------------------------------------------------------------------
// Coverage fixture (t105:54-77): 2 sensor-bound rules (one resolves:
// aidlc-required-sections; one ghost: aidlc-ghost) + 1 feedforward-only.
// So M=3, X=1, needing=M-X=2, P=1 (required-sections resolves), U=1 (ghost).
// Label: 1/2, 1 feedforward; rule count = 3.
// ---------------------------------------------------------------------------
function seedCoverageRules(rd: string): void {
  writeFileSync(
    join(rd, "org.md"),
    `---
pairing: aidlc-required-sections
---

# Org rule bound to a real sensor
`,
    "utf-8",
  );
  writeFileSync(
    join(rd, "team.md"),
    `---
pairing: aidlc-ghost
---

# Team rule bound to a non-existent sensor
`,
    "utf-8",
  );
  writeFileSync(
    join(rd, "project.md"),
    `---
pairing: feedforward-only
---

# Project rule that needs no sensor
`,
    "utf-8",
  );
}

describe("t105 doctor paired-coverage + GUARDRAIL_LOADED (migrated from t105-doctor-paired-coverage.sh, plan 6)", () => {
  // The 5-assertion coverage fixture is a single doctor run; the .sh read its
  // stdout (OUT) and the project's audit.md across cases 1-5. We run it once
  // and assert all five observables, one per test() (one observable each).
  let cov: DoctorResult;
  function ensureCov(): DoctorResult {
    if (!cov) {
      const rd = makeRulesDir();
      seedCoverageRules(rd);
      cov = runDoctor(rd);
    }
    return cov;
  }

  // --- Case 1: exact P/(M-X) label 1/2 (1 feedforward-only) on stdout ---
  test("1: coverage row reads the exact P/(M-X) label 1/2", () => {
    const r = ensureCov();
    expect(r.out).toContain(
      "Paired sensor coverage: 1/2 guardrails paired (1 feedforward-only)",
    );
  });

  // --- Case 2: unpaired ghost rule surfaces in the detail ---
  test("2: unpaired ghost rule surfaces in the coverage detail", () => {
    const r = ensureCov();
    // The rule display path is harness-neutral now (the method relocated to
    // aidlc/spaces/default/memory/), so the unpaired detail names the team
    // layer by its neutral path.
    expect(r.out).toContain(
      "unpaired: aidlc/spaces/default/memory/team.md → aidlc-ghost (no stage binds it)",
    );
  });

  // --- Case 3: coverage row prefixed ✓ (advisory pass) ---
  test("3: coverage row is prefixed ✓ (advisory pass)", () => {
    const r = ensureCov();
    const line = coverageLine(r.out);
    expect(line).not.toBe("");
    // doctor renders a passing row as "✓  <label>" (utility.ts:1361).
    expect(line.startsWith("✓")).toBe(true);
  });

  // --- Case 4: GUARDRAIL_LOADED row written to audit.md ---
  test("4: GUARDRAIL_LOADED row + heading written to audit.md", () => {
    const r = ensureCov();
    // STRONGER than the .sh's bare presence grep: exact count of 1 against a
    // fresh-project zero baseline (doctor emits exactly once per run).
    expect(auditEventCount(r.proj, "GUARDRAIL_LOADED")).toBe(1);
    expect(fileContains(r.proj, "## Guardrail Loaded")).toBe(true);
  });

  // --- Case 5: required fields (Scope, Path, Rule count) on the row ---
  test("5: GUARDRAIL_LOADED carries Scope/Path/Rule count fields", () => {
    const r = ensureCov();
    // Block-scoped exact values (STRONGER than the file-wide ^-anchored grep).
    expect(auditField(r.proj, "GUARDRAIL_LOADED", "Scope")).toBe("all");
    expect(auditField(r.proj, "GUARDRAIL_LOADED", "Path")).toBe(".claude/rules/");
    expect(auditField(r.proj, "GUARDRAIL_LOADED", "Rule count")).toBe("3");
  });

  // -------------------------------------------------------------------------
  // Case 6 (t105:120-134): no-pairing fixture -> "no sensor-bound rules
  // (0 feedforward-only)" label AND still emits GUARDRAIL_LOADED (the M-X==0
  // branch still emits). Single org rule with no frontmatter -> M=0, X=0,
  // needing=0; rule count = 1.
  // -------------------------------------------------------------------------
  test("6: M-X==0 branch label + still emits GUARDRAIL_LOADED", () => {
    const rd = makeRulesDir();
    writeFileSync(
      join(rd, "org.md"),
      "# Org rule with no pairing\n",
      "utf-8",
    );
    const r = runDoctor(rd);
    expect(r.out).toContain(
      "Paired sensor coverage: no sensor-bound rules (0 feedforward-only)",
    );
    expect(auditEventCount(r.proj, "GUARDRAIL_LOADED")).toBe(1);
    // STRONGER: the M-X==0 branch still emits with the correct rule count (1).
    expect(auditField(r.proj, "GUARDRAIL_LOADED", "Rule count")).toBe("1");
  });
});
