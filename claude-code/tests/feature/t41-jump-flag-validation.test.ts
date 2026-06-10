// covers: file:skills/aidlc/SKILL.md
//
// t41 — SKILL.md forwarding-loop contract + stage-graph data table.
// Migrated from tests/feature/t41-jump-flag-validation.sh (TAP plan 15, all
// assert_grep / assert_not_grep against the shipped SKILL.md).
//
// Mechanism: none. The subject is a STATIC shipped file — the orchestrator
// SKILL.md (dist/claude/.claude/skills/aidlc/SKILL.md). The .sh did 15
// grep / grep -v assertions against its bytes; the equal-or-stronger TS twin
// reads the SAME file in-process (via AIDLC_SRC from tests/harness/fixtures.ts,
// the TS port of fixtures.sh's $AIDLC_SRC) and asserts on its content. No
// spawn, no LLM, no tokens — a structural file-content contract.
//
// Subject / history (verbatim from the .sh header, t41:2-22):
//   This is the ENGINE-CUTOVER REWRITE of t41. It formerly validated the prose
//   orchestrator's flag-handling HANDLER STRUCTURE. At the cutover that entire
//   dispatch surface moved into the deterministic orchestration engine
//   (aidlc-orchestrate.ts), so t41 flipped: it now asserts the cutover's
//   SKILL.md contract — the forwarding loop is PRESENT, flag handling is
//   DELEGATED to the engine (the dispatch prose is GONE), and the two
//   human-readable data tables (scope-table + stage-graph) survive. The
//   positive flag-dispatch behaviours that USED to live here are now pinned by
//   the engine's own tests (t114-orchestrate-next, t118-engine-differential).
//
// Source under test (read directly):
//   dist/claude/.claude/skills/aidlc/SKILL.md — the /aidlc orchestrator prose.
//     - the forwarding loop invokes aidlc-orchestrate (engine), calling its
//       `next` and `report` subcommands and acting on the emitted `directive`.
//     - the prose flag-dispatch handlers (Composable Flag Extraction, prose
//       jump-direction "FORWARD JUMP", the Unknown-depth / Unknown-test-strategy
//       / mutual-exclusivity error wordings) are ABSENT — the engine owns them.
//     - a run-stage directive still branches on its `gate` (the §13 ritual seam).
//     - the stage-graph data table (mirrored from data/stage-graph.json) survives
//       the cutover: 5 representative slugs verified.
//
// Test-design note (house style): assert the OBSERVABLE contract the .sh
// asserted — presence/absence of literal strings in the shipped SKILL.md.
// Each assertion hard-codes the expected literal independently of the source.
//
// Old TAP -> new test parity (1:1, no guarantee dropped, several STRONGER):
//   .sh test 1  (grep 'aidlc-orchestrate')               -> "loop invokes the orchestration engine (aidlc-orchestrate)"
//   .sh test 2  (grep 'aidlc-orchestrate.ts next')       -> "loop calls the engine's next subcommand"
//   .sh test 3  (grep 'aidlc-orchestrate.ts report')     -> "loop calls the engine's report subcommand"
//   .sh test 4  (grep 'directive')                       -> "loop acts on the engine's directive"
//   .sh test 5  (grep -v 'Composable Flag Extraction')   -> "no prose Composable Flag Extraction handler"
//   .sh test 6  (grep -v 'FORWARD JUMP')                 -> "no prose jump-direction computation"
//   .sh test 7  (grep -v 'Unknown depth')                -> "no invalid-depth error wording"
//   .sh test 8  (grep -v 'Unknown test strategy')        -> "no invalid-test-strategy error wording"
//   .sh test 9  (grep -v 'Cannot use --stage and --phase together') -> "no mutual-exclusivity error wording"
//   .sh test 10 (grep 'gate')                            -> "documents branching a run-stage on its gate"
//   .sh test 11-15 (grep <slug> x5)                      -> "stage-graph table includes slug: <slug>" x5

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// The .sh resolved $AIDLC_SRC/skills/aidlc/SKILL.md from fixtures.sh; AIDLC_SRC
// here is the TS port of that same path (fixtures.ts:42).
const SKILL_PATH = join(AIDLC_SRC, "skills", "aidlc", "SKILL.md");
const SKILL = readFileSync(SKILL_PATH, "utf-8");

describe("t41 SKILL.md forwarding-loop contract (migrated from t41-jump-flag-validation.sh, plan 15)", () => {
  test("SKILL.md exists and is non-empty (precondition)", () => {
    // The .sh's grep would silently fail-open on a missing file; pin existence
    // explicitly so a relocated/renamed SKILL.md reds here, not by accident.
    expect(existsSync(SKILL_PATH)).toBe(true);
    expect(SKILL.length).toBeGreaterThan(0);
  });

  // --- Tests 1-4: the forwarding loop is present and consults the engine ---
  test("1: loop invokes the orchestration engine (aidlc-orchestrate) [.sh test 1]", () => {
    expect(SKILL.includes("aidlc-orchestrate")).toBe(true);
  });

  test("2: loop calls the engine's next subcommand [.sh test 2]", () => {
    expect(SKILL.includes("aidlc-orchestrate.ts next")).toBe(true);
  });

  test("3: loop calls the engine's report subcommand [.sh test 3]", () => {
    expect(SKILL.includes("aidlc-orchestrate.ts report")).toBe(true);
  });

  test("4: loop acts on the engine's directive [.sh test 4]", () => {
    expect(SKILL.includes("directive")).toBe(true);
  });

  // --- Tests 5-9: the engine owns the flag-dispatch surface (prose is GONE) ---
  // The verbatim error wording + handler sections that USED to live in SKILL.md
  // are now the engine's; assert they are NOT re-grown as prose here. (Each
  // behaviour is positively pinned in t114 / t118.) A regression that re-grows
  // any of these prose strings in SKILL.md reds the corresponding guard.
  test("5: no prose Composable Flag Extraction handler (engine owns flag parsing) [.sh test 5]", () => {
    expect(SKILL.includes("Composable Flag Extraction")).toBe(false);
  });

  test("6: no prose jump-direction computation (engine delegates to aidlc-jump resolve) [.sh test 6]", () => {
    expect(SKILL.includes("FORWARD JUMP")).toBe(false);
  });

  test("7: no invalid-depth error wording (engine emits it) [.sh test 7]", () => {
    expect(SKILL.includes("Unknown depth")).toBe(false);
  });

  test("8: no invalid-test-strategy error wording (engine emits it) [.sh test 8]", () => {
    expect(SKILL.includes("Unknown test strategy")).toBe(false);
  });

  test("9: no mutual-exclusivity error wording (engine emits it) [.sh test 9]", () => {
    expect(SKILL.includes("Cannot use --stage and --phase together")).toBe(false);
  });

  // --- Test 10: the run-stage directive's mode/gate branch is documented ---
  // The conductor still branches a run-stage on its gate (the §13 ritual seam);
  // that intra-stage control flow stays in SKILL.md.
  test("10: documents branching a run-stage on its gate [.sh test 10]", () => {
    expect(SKILL.includes("gate")).toBe(true);
  });

  // --- Tests 11-15: the stage-graph data table survives (5 representative slugs) ---
  // The stage graph is human-readable DATA the engine mirrors from
  // data/stage-graph.json — preserved through the cutover (like the scope-table).
  // A --stage jump can target any of these; t32 cross-checks the full table.
  const STAGE_SLUGS = [
    "intent-capture",
    "reverse-engineering",
    "code-generation",
    "ci-pipeline",
    "observability-setup",
  ] as const;

  for (const slug of STAGE_SLUGS) {
    test(`stage-graph table includes slug: ${slug} [.sh test 11-15]`, () => {
      expect(SKILL.includes(slug)).toBe(true);
    });
  }
});
