// covers: subcommand:aidlc-utility:init
//
// CLI-contract port of tests/integration/t39-per-scope-phase-sequence.sh (TAP
// plan 27), mechanism = cli. Equal-or-stronger migration: the .sh is a
// data-driven sweep over all 9 canonical scopes (enterprise, feature, mvp,
// poc, bugfix, refactor, infra, security-patch, workshop), running `bun
// aidlc-utility.ts init --scope <s> --project-dir <p>` once per
// scope and asserting 3 observables per scope (27 total). Every one of those
// observables is preserved here by SPAWNING the real CLI via
// node:child_process spawnSync (BUN + the tool .ts path) and asserting on the
// audit.md PHASE_STARTED/PHASE_SKIPPED rows the tool writes + the
// aidlc-state.md `## Phase Progress` section it writes — the PROCESS boundary
// plus those file effects. An in-process handleInit() twin would lose the
// init-time process side effects the .sh's grep-on-disk arm relies on.
//
// The contract under test is aidlc-utility.ts's init handler (lines
// 1717-2158): at init it emits exactly one PHASE_STARTED{Phase:
// initialization} (line 1791), one PHASE_SKIPPED per phase the scope excludes
// entirely (no EXECUTE stages — line 1804), and — when the first post-init
// stage is in a later phase — a SECOND PHASE_STARTED for that phase at the
// init→first-phase handoff (line 2130). It writes the `## Phase Progress`
// block (lines 2036-2042) with each phase tagged Active/Pending/Skipped
// (phaseStatus, line 2028). The audit row shape is `**Event**: <TYPE>` at
// line start (aidlc-audit.ts:258), exactly what the .sh greps.
//
// EQUAL-OR-STRONGER PARITY (per the .sh's 3 `ok` lines per scope):
//   - .sh assertion 1  grep -qE '^\*\*Event\*\*: PHASE_STARTED'  -> here:
//       phaseStartedCount >= 1 AND the Phase=initialization PHASE_STARTED
//       block is present (STRONGER: the .sh only grepped *any* PHASE_STARTED;
//       we pin that the initialization one specifically fired). Also pins
//       rc===0 on the init spawn (the .sh swallowed $? with `|| true`).
//   - .sh assertion 2  grep -cE '^\*\*Event\*\*: PHASE_SKIPPED' == expected ->
//       here: phaseSkippedCount === expected (same observable, exact count,
//       expected table lifted verbatim from the .sh's expected_skipped_phases).
//       STRONGER: we additionally assert WHICH phases were skipped (the
//       PHASE_SKIPPED rows carry `**Phase**: <name>`), not just the count.
//   - .sh assertion 3  every excluded phase recorded `- **<Phase>**: Skipped`
//       in `## Phase Progress` -> here: phaseProgressStatus(state, phase) ===
//       "Skipped" for each excluded phase (same observable, exact line match).
//       STRONGER: we also assert Initialization === "Verified" (birth
//       completes every init stage before handing off; the .sh only checked
//       the excluded set).
//
// 9 scopes × 3 .sh asserts = 27 -> 27 expect()-bearing test() cases here
// (one describe per scope, 3 test()s each).
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project +
// cleanup_test_project per scope): each scope uses a FRESH temp project dir
// (createTestProject, which toPortablePath-converts on Windows so the
// state.md / audit.md the tool writes via forward-slash path helpers
// round-trip when read back). No seed is needed — init bootstraps audit.md +
// aidlc-state.md from scratch (aidlc-utility.ts:1766/2099), matching the .sh,
// which created bare projects and let init populate both. All temp dirs
// cleaned in afterAll. Nothing is written under tests/fixtures/**.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const UTIL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-utility.ts",
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

// P4: intent-birth (the back-compat target of `init`) writes state into the
// born intent's per-intent record dir (aidlc/spaces/<space>/intents/<slug>-<id8>/),
// not the flat aidlc-docs/, and audit into per-clone shards under
// <record>/audit/<host>-<pid>.md. Resolve the record dir from the active-space +
// active-intent cursors, falling back to the flat layout for a not-yet-born /
// seeded-flat project. The PHASE_STARTED/PHASE_SKIPPED rows + `## Phase Progress`
// content are unchanged — only the LOCATION moved (per-intent, sharded).
function recordDirOf(p: string): string {
  const spaceCursor = join(p, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf-8").trim() || "default"
    : "default";
  const intentsDir = join(p, "aidlc", "spaces", space, "intents");
  const intentCursor = join(intentsDir, "active-intent");
  if (existsSync(intentCursor)) {
    const rec = readFileSync(intentCursor, "utf-8").trim();
    if (rec && existsSync(join(intentsDir, rec, "aidlc-state.md"))) {
      return join(intentsDir, rec);
    }
  }
  return join(p, "aidlc-docs");
}
const statePath = (p: string): string =>
  join(recordDirOf(p), "aidlc-state.md");
// Audit is written as per-clone shards under <record>/audit/<host>-<pid>.md.
// Concatenate every shard for a content read; fall back to the flat
// aidlc-docs/audit.md for a seeded-flat / pre-migration project.
function readAudit(p: string): string {
  const auditDir = join(recordDirOf(p), "audit");
  if (existsSync(auditDir)) {
    return readdirSync(auditDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(join(auditDir, f), "utf-8"))
      .join("\n");
  }
  const flat = join(p, "aidlc-docs", "audit.md");
  return existsSync(flat) ? readFileSync(flat, "utf-8") : "";
}

interface InitResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/**
 * Spawn `bun aidlc-utility.ts init --scope <scope> --project-dir <p>`.
 * Mirrors the .sh's
 *   AIDLC_WORKFLOW_INTENT="phase sequence test" bun "$UTIL" init --scope ...
 * The .sh exported AIDLC_WORKFLOW_INTENT defensively (the tool does not read
 * it — grep-verified — but workshop's flow historically needed an intent), so
 * we carry it through the env for byte-for-byte parity.
 */
function runInit(scope: string, p: string): InitResult {
  const res = spawnSync(
    BUN,
    [UTIL, "intent-birth", "--scope", scope, "--project-dir", p],
    {
      encoding: "utf-8",
      env: { ...process.env, AIDLC_WORKFLOW_INTENT: "phase sequence test" },
    },
  );
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/**
 * Count audit blocks with `**Event**: <ev>` at line start in audit CONTENT
 * (shard-concat). Mirrors the .sh's `grep -cE '^\*\*Event\*\*: <ev>'`
 * (aidlc-audit.ts:258 writes the row at column 0 of its line).
 */
function auditEventCount(content: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return content.split("\n").filter((l) => re.test(l)).length;
}

/**
 * Collect the `**Phase**: <name>` values from every PHASE_SKIPPED block in
 * audit CONTENT (shard-concat). Resets matched flag at `## ` headings and `---`
 * separators. STRONGER than the .sh's bare count — lets us assert WHICH phases
 * were skipped, not just how many.
 */
function skippedPhases(content: string): string[] {
  let matched = false;
  const phases: string[] = [];
  for (const line of content.split("\n")) {
    if (line.startsWith("## ") || line === "---") {
      matched = false;
      continue;
    }
    if (line.startsWith("**Event**: ")) {
      matched = line === "**Event**: PHASE_SKIPPED";
      continue;
    }
    if (matched && line.startsWith("**Phase**: ")) {
      phases.push(line.slice("**Phase**: ".length));
    }
  }
  return phases;
}

/**
 * Read the status of a phase from the state file's `## Phase Progress`
 * section. The tool writes lines like `- **Ideation**: Skipped`
 * (aidlc-utility.ts:2036-2042). Mirrors the .sh's
 *   grep -qE "^- \*\*$phase_cap\*\*: Skipped$"
 * but returns the actual status string so we can assert the full enum
 * (Active / Pending / Skipped), not just the Skipped predicate.
 */
function phaseProgressStatus(file: string, phaseCap: string): string {
  if (!existsSync(file)) return "(no state file)";
  const re = new RegExp(`^- \\*\\*${phaseCap}\\*\\*: (\\w+)$`);
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const m = line.match(re);
    if (m) return m[1];
  }
  return "(not found)";
}

// Capitalize a lowercase phase slug the way the state file renders it
// (aidlc-utility.ts:2037-2041: "Ideation", "Operation", ...). Mirrors the
// .sh's `${excluded:0:1}|upper${excluded:1}`.
const cap = (phase: string): string =>
  phase.charAt(0).toUpperCase() + phase.slice(1);

// Expected SKIPPED phases per scope — lifted verbatim from the .sh's
// expected_skipped_phases() table (t39-per-scope-phase-sequence.sh:46-54).
// A phase is skipped iff every stage in it is SKIP (no EXECUTE) — confirmed
// against scope-mapping.json. The .sh's expected_skipped_count is just the
// length of this list.
const EXPECTED_SKIPPED: Record<string, string[]> = {
  enterprise: [],
  feature: [],
  mvp: ["operation"],
  poc: ["operation"],
  bugfix: ["ideation", "operation"],
  refactor: ["ideation", "operation"],
  infra: ["ideation"],
  "security-patch": ["ideation"],
  workshop: ["ideation"],
};

const SCOPES = [
  "enterprise",
  "feature",
  "mvp",
  "poc",
  "bugfix",
  "refactor",
  "infra",
  "security-patch",
  "workshop",
] as const;

describe("t39 aidlc-utility init — per-scope phase sequence (migrated from t39-per-scope-phase-sequence.sh, plan 27)", () => {
  for (const scope of SCOPES) {
    const excluded = EXPECTED_SKIPPED[scope];

    describe(`scope=${scope}`, () => {
      // One init per scope, shared across the scope's 3 cases. Fresh temp dir.
      const proj = createTestProject();
      tempDirs.push(proj);
      const init = runInit(scope, proj);

      // --- Assertion 1: PHASE_STARTED emitted for initialization ---
      test(`1: PHASE_STARTED emitted for initialization (init exits 0)`, () => {
        // STRONGER than the .sh's `|| true` swallow: pin a clean init exit.
        expect(init.status).toBe(0);
        // .sh: grep -qE '^\*\*Event\*\*: PHASE_STARTED' (any). STRONGER: at
        // least one PHASE_STARTED fired AND the initialization one specifically
        // is present in the audit (init always emits it — line 1791). P4: read
        // the born record's audit shards, not the flat audit.md.
        const audit = readAudit(proj);
        expect(auditEventCount(audit, "PHASE_STARTED")).toBeGreaterThanOrEqual(1);
        expect(audit).toContain("**Event**: PHASE_STARTED");
        expect(audit).toContain("**Phase**: initialization");
      });

      // --- Assertion 2: PHASE_SKIPPED emitted once per excluded phase ---
      test(`2: ${excluded.length} PHASE_SKIPPED events (matches scope-mapping.json)`, () => {
        const audit = readAudit(proj);
        // .sh: grep -cE '^\*\*Event\*\*: PHASE_SKIPPED' === expected count.
        expect(auditEventCount(audit, "PHASE_SKIPPED")).toBe(excluded.length);
        // STRONGER: assert the EXACT set of skipped phases, not just the count.
        const skipped = skippedPhases(audit).sort();
        expect(skipped).toEqual([...excluded].sort());
      });

      // --- Assertion 3: Phase Progress records excluded phases as Skipped ---
      test(`3: Phase Progress records excluded phases as Skipped`, () => {
        const s = statePath(proj);
        // .sh: each excluded phase (from the audit-driven expected_skipped_phases
        // table) appears as `- **<Phase>**: Skipped` in `## Phase Progress`.
        // This is exact parity with the .sh's grep-per-excluded-phase loop.
        for (const phase of excluded) {
          expect(phaseProgressStatus(s, cap(phase))).toBe("Skipped");
        }
        // STRONGER (the .sh never checked the Init row): birth completes every
        // initialization stage and hands off to the first post-init stage, so
        // the seed reads Initialization=Verified with the first post-init
        // stage's phase Active (phaseStatus in aidlc-utility.ts - before the
        // issue-556 flip landed this seeded Active/Pending, which then never
        // advanced). We deliberately
        // do NOT assert the non-excluded post-init phases are non-Skipped: the
        // PHASE_SKIPPED audit count (driven by stagesInScope) and the Phase
        // Progress status (driven by the depth-adjustedMapping, line 2032)
        // legitimately DIVERGE for Minimal-depth scopes — e.g. security-patch
        // emits one PHASE_SKIPPED (ideation) yet Phase Progress also marks
        // Inception Skipped after depth adjustment drops its lone EXECUTE
        // stage. That divergence is outside this .sh's contract (it only
        // asserts the excluded set appears as Skipped), so asserting the
        // complement would over-reach past the original observable.
        expect(phaseProgressStatus(s, "Initialization")).toBe("Verified");
      });
    });
  }
});
