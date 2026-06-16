// covers: function:legacyFlatFallback, function:stateFilePath
//
// TRANSITIONAL — remove in P9/Stage D once fixtures migrate; this test flips RED
// to force removal; see goal-loop-stages.md Stage D checklist.
//
// t159 — FAIL-SAFE TRIPWIRE for the migration-aware legacy flat-layout fallback
// (P1 Step B), deferred for RETIREMENT to P9/Stage D. Sibling of the Stage-A
// t158 reader/writer-seam tripwire; same `test.failing` mechanism.
//
// P1 Step B re-rooted the record tree per-intent (aidlc/spaces/<sp>/intents/
// <slug>-<id8>/). Resolution is MIGRATION-AWARE: a path helper resolves the
// per-intent record when a new-layout intent exists, and resolves the legacy
// flat `aidlc-docs/` location ONLY in the not-yet-migrated state — via the SINGLE
// named `legacyFlatFallback()` funnel in aidlc-lib.ts. That transitional fallback
// is what keeps the large existing flat-seeded fixture corpus green WITHOUT
// pulling P9's comprehensive 120-fixture migration into Stage B (the plan assigns
// that rewrite to P9; B must not absorb it).
//
// THE HAZARD this guards (the human's explicit requirement): the flat fallback is
// a TRANSITIONAL bridge, not a GA layout — the vision's end state is a single
// per-intent layout with no flat root. If the fallback silently survives to GA,
// the workspace ships a dual-layout it was explicitly designed to retire. P9/
// Stage D retires it by DELETING legacyFlatFallback + the LEGACY_FLAT_ROOT /
// LEGACY_FLAT_RELATIVE_PREFIX constants in aidlc-lib.ts and migrating every
// fixture to seed the per-intent layout.
//
// HOW THIS TRIPWIRE WORKS:
//   - The NORMAL tests below document + lock the transitional contract: the
//     single named funnel exists + is reachable, and a flat project (flat
//     aidlc-docs/aidlc-state.md, no intent record) resolves to the flat path via
//     legacyFlatFallback. This is the behaviour P1 Step B ships.
//   - The `test.failing` tripwire DEMANDS the END STATE: that a flat project does
//     NOT resolve to a flat path (the fallback is gone). TODAY that demand is
//     false — stateFilePath returns the flat path — so the assertion throws, and
//     because this is `test.failing`, a throw == PASS. The suite stays green
//     while the fallback is legitimately transitional.
//   - The MOMENT P9/Stage D migrates the fixtures so nothing hits the fallback
//     and deletes legacyFlatFallback (a flat project then resolves per-intent /
//     errors instead of returning aidlc-docs/aidlc-state.md), the assertion stops
//     throwing → `test.failing` FLIPS TO RED → P9 is forced to delete this
//     tripwire. The bridge cannot silently survive to GA.
//
// Mechanism: in-process import of the shipped helpers. No LLM, no process boundary.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LEGACY_FLAT_ROOT,
  legacyFlatFallback,
  stateFilePath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

let proj: string;

/** A flat legacy project: aidlc-docs/aidlc-state.md present, no aidlc/ workspace
 *  layout, no intent record — the not-yet-migrated state. */
function seedFlat(p: string): void {
  mkdirSync(join(p, LEGACY_FLAT_ROOT), { recursive: true });
  writeFileSync(join(p, LEGACY_FLAT_ROOT, "aidlc-state.md"), "- **Current Stage**: x\n", "utf-8");
}

beforeEach(() => {
  proj = createTestProject();
});
afterEach(() => {
  cleanupTestProject(proj);
});

describe("t159 migration-aware flat fallback — transitional contract (locked)", () => {
  test("the SINGLE named fallback funnel exists + is reachable (one P9 deletion site)", () => {
    // legacyFlatFallback is the one site every absolute pre-migration fallback
    // funnels through — P9/Stage D retires the layer by deleting it. Reachable:
    expect(legacyFlatFallback(proj)).toBe(join(proj, LEGACY_FLAT_ROOT));
    expect(legacyFlatFallback(proj, "aidlc-state.md")).toBe(join(proj, LEGACY_FLAT_ROOT, "aidlc-state.md"));
  });

  test("a not-yet-migrated flat project resolves to the flat path (P1 Step B contract)", () => {
    seedFlat(proj);
    expect(stateFilePath(proj)).toBe(join(proj, LEGACY_FLAT_ROOT, "aidlc-state.md"));
  });
});

describe("t159 RETIREMENT tripwire (flips RED when P9/Stage D removes the fallback)", () => {
  // test.failing: passes while the body THROWS. The body demands the END STATE
  // (no flat fallback). Today that demand is false → throws → passes. When P9
  // migrates fixtures + deletes legacyFlatFallback so a flat project no longer
  // resolves to the flat path, the demand holds → stops throwing → FLIPS RED →
  // P9 must delete this tripwire. See goal-loop-stages.md Stage D checklist.
  test.failing(
    "RETIREMENT: a flat project must NOT resolve to the flat aidlc-docs/ path (true only AFTER P9/Stage D removes the fallback)",
    () => {
      seedFlat(proj);
      // DEMAND the end state: stateFilePath should NOT return the flat location.
      // While the migration-aware fallback exists, it DOES — so this throws today.
      expect(stateFilePath(proj)).not.toBe(join(proj, LEGACY_FLAT_ROOT, "aidlc-state.md"));
    },
  );
});
