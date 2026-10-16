// covers: invariant:stage-protocol-governance-phase-boundaries
//
// t36 — stage-protocol governance + phase-boundary structural meta-test.
//
// This test claims no enumerated tool unit (its covers id is an invariant);
// it is a pure structural meta-test that the shipped governance protocol
// (dist/claude/.claude/aidlc-common/protocols/stage-protocol-governance.md)
// carries §13 Phase Boundary Verification, names the three valid phase-
// transition stage pairs, references the verification knowledge file, and
// has SHED the dead guardrail-learning model (superseded by the §13 Learnings
// Ritual in stage-protocol.md). The honest covers id is therefore the
// structural INVARIANT under test, declared free-form like
// t12's `invariant:` id (tests/integration/t12-state-fixture-validation.test.ts)
// and t125's invariant ids — invariant ids are descriptive claims, not joined
// to an enumerated subcommand/function unit.
//
// Mechanism: none. The test reads the shipped bytes with readFileSync /
// existsSync and asserts in-process.
//
// Subject under test (the shipped, real bytes — no temp project, no tool):
//   - dist/claude/.claude/aidlc-common/protocols/stage-protocol-governance.md
//     (GOVERNANCE; AIDLC_SRC-relative)
//   - dist/claude/.claude/aidlc-common/stages/<phase>/<slug>.md
//     (STAGES_DIR; the boundary stage files, found by walking each phase dir)
//   - dist/claude/.claude/knowledge/aidlc-shared/verification.md
//     (KNOWLEDGE_DIR; the verification methodology the governance file points at)
//
// Behavioural contract verified against the shipped file
// (stage-protocol-governance.md):
//   - "## 13. Phase Boundary Verification" heading present
//   - "supplement to `stage-protocol.md`" - names the parent protocol
//   --   the dead §12 guardrail-learning model is GONE: no
//        "Guardrail Learning Protocol", no "NEVER/ALWAYS" format, no
//        "GUARDRAIL_LEARNED" emission anywhere in the file
//   - "### When to verify" subsection
//   - "### Verification process" subsection
//   - "### Phase boundary checks" subsection
//   - the three phase-transition stage pairs co-located on one line each:
//          approval-handoff → reverse-engineering   (Ideation→Inception)
//          delivery-planning → functional-design     (Inception→Construction)
//          ci-pipeline → deployment-pipeline          (Construction→Operation)
//   - "verification.md" referenced as the methodology file

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

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

function someLineHasBoth(a: string, b: string): boolean {
  return GOVERNANCE_LINES.some((l) => l.includes(a) && l.includes(b));
}

// The six boundary stages. Each must resolve to a file under one of the
// shipped phase dirs.
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

/** Returns the phase dir holding `<slug>.md`, or null if none does. */
function resolveBoundaryStage(slug: string): string | null {
  for (const phase of PHASE_DIRS) {
    if (existsSync(join(STAGES_DIR, phase, `${slug}.md`))) return phase;
  }
  return null;
}

describe("t36 stage-protocol-governance — top-level structure (migrated from t36-stage-protocol-governance.sh, plan 19)", () => {
  test("§13 Phase Boundary Verification heading is present [.sh 1]", () => {
    expect(
      GOVERNANCE_LINES.some((l) => l.startsWith("## 13. Phase Boundary Verification")),
    ).toBe(true);
  });

  test("names stage-protocol.md as the parent protocol [.sh 2]", () => {
    expect(GOVERNANCE).toContain("supplement to `stage-protocol.md`");
  });
});

describe("t36 — dead guardrail-learning model is gone", () => {
  test("no dead §12 guardrail-learning content remains [.sh 3 + 4 + 5]", () => {
    // The file must NOT carry any of the dead guardrail-learning vocabulary
    // (superseded by the Section 13 Learnings Ritual in stage-protocol.md). A
    // regression re-introducing the model would fire.
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
    // Both stage names of each transition appear on the SAME line of the
    // governance file (the Section 13 boundary sentence).
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
