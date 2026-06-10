// covers: invariant:stage-protocol-governance-phase-boundaries
//
// t36 — stage-protocol governance + phase-boundary structural meta-test.
// Migrated from tests/feature/t36-stage-protocol-governance.sh (TAP plan 19).
//
// The .sh carried NO `# covers:` header (it claims no enumerated tool unit);
// it is a pure structural meta-test that the shipped governance protocol
// (dist/claude/.claude/aidlc-common/protocols/stage-protocol-governance.md)
// carries §13 Phase Boundary Verification, names the three valid phase-
// transition stage pairs, references the verification knowledge file, and
// has SHED the dead guardrail-learning model (superseded by the §13 Learnings
// Ritual in stage-protocol.md — v0.5.0 milestone 15). The honest covers id is
// therefore the structural INVARIANT under test, declared free-form like
// t12's `invariant:` id (tests/feature/t12-state-fixture-validation.test.ts:1)
// and t125's invariant ids — invariant ids are descriptive claims, not joined
// to an enumerated subcommand/function unit.
//
// Mechanism: none. The .sh did `grep` / `grep -v` against on-disk shipped
// `.md` files plus `[ -f ... ]` file-existence walks — zero tool spawn, zero
// LLM, zero tokens. The twin reads the SAME shipped bytes with readFileSync /
// existsSync and asserts in-process.
//
// Subject under test (the shipped, real bytes — no temp project, no tool):
//   - dist/claude/.claude/aidlc-common/protocols/stage-protocol-governance.md
//     (GOVERNANCE; AIDLC_SRC-relative — the .sh's
//      "$AIDLC_SRC/aidlc-common/protocols/stage-protocol-governance.md")
//   - dist/claude/.claude/aidlc-common/stages/<phase>/<slug>.md
//     (STAGES_DIR; the boundary stage files, found by walking each phase dir
//      exactly as the .sh's nested `for phase_dir in "$STAGES_DIR"/*/` loop)
//   - dist/claude/.claude/knowledge/aidlc-shared/verification.md
//     (KNOWLEDGE_DIR; the verification methodology the governance file points at)
//
// Behavioural contract verified against the shipped file
// (stage-protocol-governance.md:4,6,10,12,14,19,29,30-32,20):
//   :10  "## 13. Phase Boundary Verification" heading present
//   :4   "supplement to `stage-protocol.md`" — names the parent protocol
//   --   the dead §12 guardrail-learning model is GONE: no
//        "Guardrail Learning Protocol", no "NEVER/ALWAYS" format, no
//        "GUARDRAIL_LEARNED" emission anywhere in the file
//   :14  "### When to verify" subsection
//   :19  "### Verification process" subsection
//   :29  "### Phase boundary checks" subsection
//   :12  the three phase-transition stage pairs co-located on one line each:
//          approval-handoff → reverse-engineering   (Ideation→Inception)
//          delivery-planning → functional-design     (Inception→Construction)
//          ci-pipeline → deployment-pipeline          (Construction→Operation)
//   :20  "verification.md" referenced as the methodology file
//
// Old TAP -> new test parity (1:1, every .sh `ok` -> a named test()):
//   .sh 1  (§13 Phase Boundary Verification exists)        -> "§13 Phase Boundary Verification heading is present"
//   .sh 2  (references main protocol as parent)            -> "names stage-protocol.md as the parent protocol"
//   .sh 3  (no dead Guardrail Learning Protocol)           -> "dead guardrail-learning model is gone" (sub-expect)
//   .sh 4  (no dead NEVER/ALWAYS)                          -> "dead guardrail-learning model is gone" (sub-expect)
//   .sh 5  (no dead GUARDRAIL_LEARNED)                     -> "dead guardrail-learning model is gone" (sub-expect)
//   .sh 6  (### When to verify exists)                     -> "carries the three §13 subsections" (sub-expect)
//   .sh 7  (### Verification process exists)               -> "carries the three §13 subsections" (sub-expect)
//   .sh 8  (### Phase boundary checks exists)              -> "carries the three §13 subsections" (sub-expect)
//   .sh 9  (Ideation→Inception boundary pair)              -> "names the three phase-transition stage pairs" (sub-expect, STRONGER: same line)
//   .sh 10 (Inception→Construction boundary pair)          -> "names the three phase-transition stage pairs" (sub-expect, STRONGER: same line)
//   .sh 11 (Construction→Operation boundary pair)          -> "names the three phase-transition stage pairs" (sub-expect, STRONGER: same line)
//   .sh 12-17 (6 boundary stages exist as files)           -> "every boundary stage exists as a file under STAGES_DIR" (sub-expect per slug; STRONGER: pins the resolved phase dir)
//   .sh 18 (references verification.md knowledge file)     -> "references the verification.md knowledge file"
//   .sh 19 (verification.md exists on disk)                -> "verification.md exists on disk under aidlc-shared"
//
// STRONGER than the original where called out:
//   - .sh 9/10/11 grepped "A.*B" (A and B somewhere, A before B). The twin
//     asserts BOTH stage names land on the SAME line of the file (the §13
//     boundary-pairs sentence at :12), which is the actual co-location the
//     grep was approximating.
//   - .sh 12-17 only asked "the file exists somewhere under STAGES_DIR". The
//     twin records WHICH phase dir resolved each slug and asserts it is one of
//     the five known phase dirs — a regression that moved a stage to a bogus
//     dir would still pass the .sh's `-f` walk but fail here.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// Mirrors the .sh's three path anchors (t36.sh:9-11).
const GOVERNANCE_PATH = join(
  AIDLC_SRC,
  "aidlc-common",
  "protocols",
  "stage-protocol-governance.md",
);
const STAGES_DIR = join(AIDLC_SRC, "aidlc-common", "stages");
const KNOWLEDGE_DIR = join(AIDLC_SRC, "knowledge", "aidlc-shared");

const GOVERNANCE = readFileSync(GOVERNANCE_PATH, "utf-8");
const GOVERNANCE_LINES = GOVERNANCE.split("\n");

/** Does any single line of the governance file contain BOTH substrings? */
function someLineHasBoth(a: string, b: string): boolean {
  return GOVERNANCE_LINES.some((l) => l.includes(a) && l.includes(b));
}

// The six boundary stages the .sh loops over (t36.sh:52). Each must resolve to
// a file under exactly one of the shipped phase dirs.
const BOUNDARY_STAGES = [
  "approval-handoff",
  "reverse-engineering",
  "delivery-planning",
  "functional-design",
  "ci-pipeline",
  "deployment-pipeline",
];

const PHASE_DIRS = readdirSync(STAGES_DIR).filter((d) =>
  statSync(join(STAGES_DIR, d)).isDirectory(),
);

/** Replicates the .sh's nested phase-dir walk: returns the phase dir holding
 *  `<slug>.md`, or null if none does. */
function resolveBoundaryStage(slug: string): string | null {
  for (const phase of PHASE_DIRS) {
    if (existsSync(join(STAGES_DIR, phase, `${slug}.md`))) return phase;
  }
  return null;
}

describe("t36 stage-protocol-governance — top-level structure (migrated from t36-stage-protocol-governance.sh, plan 19)", () => {
  test("§13 Phase Boundary Verification heading is present [.sh 1]", () => {
    // grep "^## 13\. Phase Boundary Verification" — assert as a real line start.
    expect(
      GOVERNANCE_LINES.some((l) => l.startsWith("## 13. Phase Boundary Verification")),
    ).toBe(true);
  });

  test("names stage-protocol.md as the parent protocol [.sh 2]", () => {
    // grep "supplement to .stage-protocol.md" (the `.` matched the backtick).
    expect(GOVERNANCE).toContain("supplement to `stage-protocol.md`");
  });
});

describe("t36 — dead guardrail-learning model is gone", () => {
  test("no dead §12 guardrail-learning content remains [.sh 3 + 4 + 5]", () => {
    // Three assert_not_grep rows: the file must NOT carry any of the dead
    // guardrail-learning vocabulary (superseded by the §13 Learnings Ritual in
    // stage-protocol.md). A regression re-introducing the model would fire.
    expect(GOVERNANCE.includes("Guardrail Learning Protocol")).toBe(false);
    expect(GOVERNANCE.includes("NEVER/ALWAYS")).toBe(false);
    expect(GOVERNANCE.includes("GUARDRAIL_LEARNED")).toBe(false);
  });
});

describe("t36 — §13 subsections + phase-boundary stage pairs", () => {
  test("carries the three §13 subsections [.sh 6 + 7 + 8]", () => {
    expect(GOVERNANCE.includes("### When to verify")).toBe(true);
    expect(GOVERNANCE.includes("### Verification process")).toBe(true);
    expect(GOVERNANCE.includes("### Phase boundary checks")).toBe(true);
  });

  test("names the three phase-transition stage pairs on one line each [.sh 9 + 10 + 11]", () => {
    // STRONGER than the .sh's "A.*B" greps: both stage names of each transition
    // appear on the SAME line of the governance file (the §13 boundary sentence).
    // Ideation → Inception
    expect(someLineHasBoth("approval-handoff", "reverse-engineering")).toBe(true);
    // Inception → Construction
    expect(someLineHasBoth("delivery-planning", "functional-design")).toBe(true);
    // Construction → Operation
    expect(someLineHasBoth("ci-pipeline", "deployment-pipeline")).toBe(true);
  });
});

describe("t36 — boundary stages exist as files under STAGES_DIR", () => {
  test("every boundary stage resolves to a file in a known phase dir [.sh 12-17]", () => {
    // STRONGER than the .sh's bare `-f` walk: assert each slug resolves AND that
    // the resolving dir is one of the actual shipped phase dirs.
    for (const slug of BOUNDARY_STAGES) {
      const phase = resolveBoundaryStage(slug);
      expect(phase, `boundary stage '${slug}' must exist as a file under STAGES_DIR`).not.toBeNull();
      expect(PHASE_DIRS).toContain(phase as string);
    }
  });
});

describe("t36 — verification knowledge file", () => {
  test("references the verification.md knowledge file [.sh 18]", () => {
    expect(GOVERNANCE.includes("verification.md")).toBe(true);
  });

  test("verification.md exists on disk under aidlc-shared [.sh 19]", () => {
    expect(existsSync(join(KNOWLEDGE_DIR, "verification.md"))).toBe(true);
  });
});
