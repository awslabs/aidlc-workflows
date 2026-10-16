// covers: subcommand:aidlc-utility:init
//
// Mechanism = cli. A data-driven sweep over all 11 canonical scopes (enterprise,
// feature, mvp, poc, bugfix, refactor, infra, security-patch, classic, workshop,
// express), running `bun aidlc-utility.ts intent-create --scope <s>
// --project-dir <p>` once per scope and asserting 3 observables per scope (33
// total). Every one of those observables is asserted by SPAWNING the real CLI via
// node:child_process spawnSync (BUN + the tool .ts path) and asserting on the
// audit PHASE_STARTED/PHASE_SKIPPED rows the tool writes + the aidlc-state.md
// `## Phase Progress` section it writes - the PROCESS boundary plus those file
// effects. An in-process handleIntentCreate() twin would lose the creation-time
// process side effects.
//
// The contract under test is aidlc-utility.ts's handleIntentCreate. At creation
// it emits exactly one PHASE_STARTED{Phase: initialization}, one PHASE_SKIPPED
// per phase the scope excludes entirely (no EXECUTE stages), and - when the
// first post-init stage is in a later phase - a SECOND PHASE_STARTED for that
// phase at the init->first-phase handoff. It writes the `## Phase Progress`
// block with each phase tagged Verified/Active/Pending/Skipped
// (handleIntentCreateStateBuild). The audit row shape is `**Event**: <TYPE>` at
// line start (aidlc-audit.ts), exactly what the .sh greps.
//
// 11 scopes × 3 assertions = 33 expect()-bearing test() cases here
// (one describe per scope, 3 test()s each).
//
// FIXTURE DISCIPLINE: each scope uses a FRESH temp project dir
// (createTestProject, which toPortablePath-converts on Windows so the
// state.md / audit.md the tool writes via forward-slash path helpers
// round-trip when read back). No seed is needed — init bootstraps audit.md +
// aidlc-state.md from scratch (aidlc-utility.ts), matching the .sh,
// which created bare projects and let init populate both. All temp dirs
// cleaned in afterAll. Nothing is written under tests/fixtures/**.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const BUN = process.execPath;
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

// intent-create writes state into the created intent's per-intent record dir
// (aidlc/spaces/<space>/intents/<YYMMDD>-<slug>/), not the flat aidlc-docs/, and
// audit into per-clone shards under <record>/audit/<host>-<token>.md. Resolve
// the record dir from the active-space + active-intent cursors, falling back to
// the flat layout for a not-yet-created / seeded-flat project.
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
// Audit is written as per-clone shards under <record>/audit/<host>-<token>.md.
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
  out: string; // combined stdout+stderr
}

function runInit(scope: string, p: string): InitResult {
  const res = spawnSync(
    BUN,
    [UTIL, "intent-create", "--scope", scope, "--project-dir", p],
    {
      encoding: "utf-8",
      env: { ...process.env, AIDLC_WORKFLOW_INTENT: "phase sequence test" },
    },
  );
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/**
 * Count audit blocks with `**Event**: <ev>` at line start in audit CONTENT
 * (shard-concat); renderAuditBlock in aidlc-audit.ts writes the row at column 0
 * of its line.
 */
function auditEventCount(content: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return content.split("\n").filter((l) => re.test(l)).length;
}

/**
 * Collect the `**Phase**: <name>` values from every PHASE_SKIPPED block in
 * audit CONTENT (shard-concat). Resets matched flag at `## ` headings and `---`
 * separators. Lets us assert WHICH phases were skipped, not just how many.
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
 * Read the status of a phase from the state file, where the tool
 * (handleIntentCreateStateBuild in aidlc-utility.ts) writes `## Phase Progress`
 * lines like `- **Ideation**: Skipped`. Returns the actual status string so we
 * can assert the full enum (Verified / Active / Pending / Skipped), not just the
 * Skipped predicate.
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

const cap = (phase: string): string =>
  phase.charAt(0).toUpperCase() + phase.slice(1);

// Expected SKIPPED phases per scope. A phase is skipped iff every stage in it
// is SKIP (no EXECUTE) - confirmed against the compiled scope grid.
const EXPECTED_SKIPPED: Record<string, string[]> = {
  enterprise: [],
  feature: [],
  mvp: ["operation"],
  poc: ["operation"],
  bugfix: ["ideation"],
  refactor: ["ideation"],
  infra: ["ideation"],
  "security-patch": ["ideation"],
  classic: ["ideation", "operation"],
  workshop: ["ideation"],
  express: ["ideation"],
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
  "classic",
  "workshop",
  "express",
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
        expect(init.status).toBe(0);
        // At least one PHASE_STARTED fired AND the initialization one specifically is
        // present in the audit (intent-create always emits it). Read the created
        // record's audit shards, not the flat audit.md.
        const audit = readAudit(proj);
        expect(auditEventCount(audit, "PHASE_STARTED")).toBeGreaterThanOrEqual(1);
        expect(audit).toContain("**Event**: PHASE_STARTED");
        expect(audit).toContain("**Phase**: initialization");
      });

      // --- Assertion 2: PHASE_SKIPPED emitted once per excluded phase ---
      test(`2: ${excluded.length} PHASE_SKIPPED events (matches scope-mapping.json)`, () => {
        const audit = readAudit(proj);
        expect(auditEventCount(audit, "PHASE_SKIPPED")).toBe(excluded.length);
        const skipped = skippedPhases(audit).sort();
        expect(skipped).toEqual([...excluded].sort());
      });

      // --- Assertion 3: Phase Progress records excluded phases as Skipped ---
      test(`3: Phase Progress records excluded phases as Skipped`, () => {
        const s = statePath(proj);
        for (const phase of excluded) {
          expect(phaseProgressStatus(s, cap(phase))).toBe("Skipped");
        }
        // Creation completes every initialization stage and hands off to the first
        // post-init stage, so the seed reads Initialization=Verified with the first
        // post-init stage's phase Active (handleIntentCreateStateBuild). We
        // deliberately do NOT assert the non-excluded post-init phases are non-Skipped:
        // the PHASE_SKIPPED audit count (driven by stagesInScope) and the Phase Progress
        // status (driven by the adjustedMapping) legitimately DIVERGE for Minimal-depth
        // scopes - e.g. security-patch emits one PHASE_SKIPPED (ideation) yet Phase
        // Progress also marks Inception Skipped after depth adjustment drops its lone
        // EXECUTE stage. That divergence is outside this test's contract (it only
        // asserts the excluded set appears as Skipped), so asserting the complement
        // would over-reach past the observable.
        expect(phaseProgressStatus(s, "Initialization")).toBe("Verified");
      });
    });
  }
});
