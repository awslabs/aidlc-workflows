// covers: subcommand:aidlc-utility:doctor
//
// CLI-contract port of tests/integration/t104-doctor-rule-drift.sh (TAP plan 6),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-utility.ts doctor --project-dir <p>` against
// AIDLC_RULES_DIR fixtures is preserved by SPAWNING the real CLI via
// node:child_process spawnSync (BUN + the tool .ts path), asserting on the
// combined stdout+stderr the tool writes (the .sh ran `2>&1 || true`) — the
// PROCESS boundary. The contract under test is the deterministic-tool half of
// T2: doctor surfaces same-`##`-heading overlap between aidlc-org.md's
// POPULATED headings and team/project(-learnings) files as an advisory `✓`
// row, quoting the org sentence inline. The contradiction VERDICT is the
// orchestrator-LLM's at observation time — doctor never blocks on it.
//
// SPAWN (not in-process): the handler is `handleDoctor(projectDir)` which
// terminates with `process.exit(failed > 0 ? 1 : 0)` (aidlc-utility.ts:1385)
// and writes its report via `process.stdout.write` (:1373). The rule-drift row
// is only observable on that stdout, and the AIDLC_RULES_DIR / AIDLC_STAGE_GRAPH
// fixture-isolation seams (aidlc-graph.ts:160-162) are evaluated inside the
// subprocess. An in-process twin would lose the env-seam isolation and the
// process.exit shell the .sh's `|| true` is written around. spawnCount = all.
//
// EXIT-CODE NOTE: the .sh runs `bun "$UTIL" doctor ... 2>&1 || true` — it
// SWALLOWS the exit code, because a bare temp project fails the hook/settings
// checks (doctor exits 1 on any failure, :1385). The rule-drift row is an
// always-`pass:true` advisory (:1239,:1268,:1276) regardless. So like the .sh
// we assert on stdout content, not on res.status — the row renders identically
// at exit 1. (We DO capture status to mirror the `|| true` semantics.)
//
// FIXTURE DISCIPLINE (mirrors the .sh's per-case mktemp -d rules dir + a fresh
// mktemp -d project with aidlc-docs/, both rm -rf'd):
//   - Each case writes its rules fixture (the relocated method files org.md /
//     team.md / project.md, neutral names) into a FRESH temp dir handed
//     to the tool via AIDLC_RULES_DIR. Byte-for-byte the .sh heredocs.
//   - The project dir is a FRESH temp dir with aidlc-docs/ (toPortablePath so
//     audit.md the tool may append round-trips on Windows). doctor reads no
//     audit.md content here — the assertion surface is stdout — but the dir
//     must exist so doctor's aidlc-docs checks don't crash, exactly as the .sh
//     did `mkdir -p "$proj/aidlc-docs"`.
//   - AIDLC_STAGE_GRAPH points at the shipped stage-graph.json (the .sh's
//     SEED_GRAPH) so the unrelated graph-backed doctor checks resolve.
//   - NOTHING is written under tests/fixtures/**; all dirs cleaned in afterAll.
//
// PARITY NOTES (every .sh `ok` line maps to an expect()-bearing test() below;
// several are STRONGER than the original grep):
//   - .sh case 1  assert_contains OUT "Rule drift: 1 team/project rule(s)
//       overlap org policy (review for contradiction)"  -> test 1: stdout
//       contains the same literal headline (N=1, team.md drift).
//   - .sh case 2  grep file + "Testing Posture" + the quoted org sentence
//       -> test 2: STRONGER — asserts the SINGLE rendered drift line carries
//       all three (file `team.md`, `## Testing Posture`, and
//       the exact org sentence) co-located, not merely present somewhere in
//       stdout.
//   - .sh case 3  DRIFT_LINE prefixed `^✓` (advisory pass)  -> test 3: the
//       grepped `Rule drift:` line starts with `✓ ` (✓ + two spaces, the
//       tool's pass prefix at :1361), proving it did NOT push `failed`.
//   - .sh case 4  N=0 fixture -> "Rule drift: no team/project rule overlaps
//       org policy" AND `^✓`  -> test 4: both, on the same grepped line.
//   - .sh case 5  org-absent fixture -> "Rule drift: org rules absent
//       (informational)"  -> test 5: stdout contains it (STRONGER: also pins
//       the `✓` advisory prefix on that line).
//   - .sh case 6  fixture isolation -> "UNIQUEFIXTURETOKEN" quoted AND
//       "Rule drift: 1 team/project rule(s) overlap org policy"  -> test 6:
//       both on the same rendered drift line (read seam honoured end-to-end).
//
// 6 .sh asserts -> 6 expect()-bearing test() cases here (same count, same
// observables, several STRONGER via single-line co-location + prefix pinning).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toPortablePath } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const AIDLC_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SEED_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** Fresh temp dir registered for afterAll teardown (mirrors the .sh mktemp -d). */
function mkTemp(tag: string): string {
  const d = toPortablePath(mkdtempSync(join(tmpdir(), `aidlc-t104-${tag}-`)));
  tempDirs.push(d);
  return d;
}

/**
 * Build a rules fixture dir from the given filename->body map (the relocated
 * method files org.md / team.md / project.md, neutral names).
 */
function rulesDir(files: Record<string, string>): string {
  const rd = mkTemp("rules");
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(rd, name), body, "utf-8");
  }
  return rd;
}

interface DoctorResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/**
 * run_doctor (t104:37-45): a fresh project dir with aidlc-docs/, then
 * `AIDLC_RULES_DIR=<rd> AIDLC_STAGE_GRAPH=<seed> bun UTIL doctor --project-dir <proj>`
 * captured 2>&1. The .sh swallows the exit code with `|| true` (bare temp
 * projects fail unrelated hook/settings checks); we capture it for parity but
 * assert on stdout, where the always-pass rule-drift row renders.
 */
function runDoctor(rd: string): DoctorResult {
  const proj = mkTemp("proj");
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
  const res = spawnSync(BUN, [UTIL, "doctor", "--project-dir", proj], {
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_RULES_DIR: rd,
      AIDLC_STAGE_GRAPH: SEED_GRAPH,
    },
  });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/** The single `Rule drift:` line from doctor's report (the .sh's grep "Rule drift:"). */
function driftLine(out: string): string {
  return out.split("\n").find((l) => l.includes("Rule drift:")) ?? "";
}

describe("t104 aidlc-utility doctor — rule-drift row (migrated from t104-doctor-rule-drift.sh, plan 6)", () => {
  // ===========================================================================
  // N=1 drift fixture: org ## Testing Posture + team ## Testing Posture with
  // contradicting content. P6: a learning IS a practice (no `*-learnings.md`
  // slot) — team.md is the team-scoped surface the drift walk reads. Drives
  // cases 1, 2, 3.
  // ===========================================================================
  const DRIFT_RULES = {
    "org.md":
      "# Org\n\n## Testing Posture\n\nWe require 80% line coverage on every Bolt before merge.\n",
    "team.md":
      "# Team\n\n## Testing Posture\n\nThis team skips the coverage floor on spike branches.\n",
  };

  test("1: drift headline renders with N=1", () => {
    const r = runDoctor(rulesDir(DRIFT_RULES));
    expect(r.out).toContain(
      "Rule drift: 1 team/project rule(s) overlap org policy (review for contradiction)",
    );
  }, 30000);

  test("2: detail carries file + heading + quoted org sentence (co-located on one line)", () => {
    const r = runDoctor(rulesDir(DRIFT_RULES));
    // STRONGER than the .sh's three independent greps: assert all three appear
    // on the SAME rendered drift line, in the tool's `<file> ## <heading> ⇄
    // org "<sentence>"` detail format (aidlc-utility.ts:1273).
    const line = driftLine(r.out);
    expect(line).toContain("team.md");
    expect(line).toContain("Testing Posture");
    expect(line).toContain(
      "We require 80% line coverage on every Bolt before merge.",
    );
  }, 30000);

  test("3: drift row prefixed ✓ (advisory pass — does NOT push failed)", () => {
    const r = runDoctor(rulesDir(DRIFT_RULES));
    // The tool prefixes a pass row with `✓  ` (✓ + two spaces,
    // aidlc-utility.ts:1361); a fail row would carry `✗  ` (:1364).
    // Mirrors the .sh `grep -q "^✓"` on the drift line.
    expect(driftLine(r.out).startsWith("✓  ")).toBe(true);
  }, 30000);

  // ===========================================================================
  // Case 4 — N=0 fixture (no overlap) → quiet headline, ✓.
  // org ## Way of Working + team ## Code Style: disjoint headings, no overlap.
  // ===========================================================================
  test("4: N=0 fixture → quiet '✓ no overlap' render", () => {
    const r = runDoctor(
      rulesDir({
        "org.md":
          "# Org\n\n## Way of Working\n\nWe use trunk-based development.\n",
        "team.md": "# Team\n\n## Code Style\n\nWe prefer tabs.\n",
      }),
    );
    const line = driftLine(r.out);
    expect(line).toContain("Rule drift: no team/project rule overlaps org policy");
    expect(line.startsWith("✓  ")).toBe(true);
  }, 30000);

  // ===========================================================================
  // Case 5 — Org-absent fixture → informational pass, no crash.
  // team-only ## Testing Posture with no aidlc-org.md to compare against.
  // ===========================================================================
  test("5: org-absent fixture → informational pass", () => {
    const r = runDoctor(
      rulesDir({
        "team.md":
          "# Team\n\n## Testing Posture\n\nA team-only posture with no org to compare against.\n",
      }),
    );
    const line = driftLine(r.out);
    expect(line).toContain("Rule drift: org rules absent (informational)");
    // STRONGER than the .sh (which only grepped the label): the informational
    // row is also an advisory pass (aidlc-utility.ts:1239), so it carries ✓.
    expect(line.startsWith("✓  ")).toBe(true);
  }, 30000);

  // ===========================================================================
  // Case 6 — Fixture isolation: the fixture's ## Testing Posture (NOT the
  // shipped rules') drives N=1. Proves AIDLC_RULES_DIR + the .headings read
  // seam are honoured end-to-end — a sentence existing ONLY in the fixture is
  // what gets quoted. org + project both carry ## Testing Posture.
  // ===========================================================================
  test("6: fixture isolation — fixture's posture drives N=1 (read seam honoured)", () => {
    const r = runDoctor(
      rulesDir({
        "org.md":
          "# Org\n\n## Testing Posture\n\nUNIQUEFIXTURETOKEN must appear in the quoted drift detail.\n",
        "project.md":
          "# Project\n\n## Testing Posture\n\nThis project overrides the posture.\n",
      }),
    );
    // STRONGER: both the unique fixture token and the N=1 headline land on the
    // same rendered drift line — the quoted sentence is sourced from the
    // fixture org, not the shipped aidlc-org.md.
    const line = driftLine(r.out);
    expect(line).toContain("UNIQUEFIXTURETOKEN");
    expect(line).toContain(
      "Rule drift: 1 team/project rule(s) overlap org policy",
    );
  }, 30000);
});
