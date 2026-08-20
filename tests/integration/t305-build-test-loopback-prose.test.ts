// covers: doc:aidlc-common/protocols/stage-protocol.md, doc:aidlc-common/protocols/stage-protocol-construction.md, doc:aidlc-common/protocols/stage-protocol-recovery.md, file:aidlc-common/stages/construction/build-and-test.md, file:aidlc-common/stages/construction/code-generation.md
//
// t305 — Build-and-Test failure loop-back PROSE-PIN (issue #611). t34-style:
// mechanism = none. Every assertion is readFileSync + a string / regex check
// over the real bytes of the shipped documents — no spawn, no LLM, zero
// tokens, no process boundary. The bytes on disk ARE the contract.
//
// SUBJECT: the bounded Build & Test → Code Generation failure loop-back in the
// conditional Construction protocol module.
// Five surfaces carry the contract:
//   1. dist/claude/.claude/aidlc-common/stages/construction/build-and-test.md
//      — Step 10's 4-rung failure-escalation ladder, the `## Loop-Back Log`
//      artifact shape, and the single-stage (--single) carve-out.
//   2. dist/claude/.claude/aidlc-common/protocols/
//      stage-protocol-construction.md — the loop-back subsection as a sibling
//      of "Halt-and-ask on failure", including the ledger, engine-routed jump,
//      settlement paths, swarm path, question variants, and second
//      autonomous-stop case.
//   3. dist/claude/.claude/aidlc-common/protocols/stage-protocol.md — the
//      NO EMERGENT carve-out, checklist-item-5 exception, and both Artifact
//      Re-use overrides.
//   4. dist/claude/.claude/aidlc-common/protocols/stage-protocol-recovery.md
//      — the crash-resume bullet (logged-but-not-jumped detection), now under
//      "Session resume" rather than "Stage re-run".
//   5. Every harness conductor SKILL (authored harness/<h>/skills/aidlc/
//      SKILL.md AND its dist copy via the harness matrix) — the parenthetical
//      exception on the "STAGE RITUAL IS ATOMIC" Key Principles bullet.
//
// FIXTURE DISCIPLINE: inputs are the REAL committed shipped files (AIDLC_SRC
// = <repo>/dist/claude/.claude from tests/harness/fixtures.ts) plus the
// authored + dist conductor SKILLs discovered through HARNESS_MATRIX (so a
// new harness cannot escape the gate). NOTHING is written; no temp project,
// no teardown — there is no mutable surface.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, REPO_ROOT } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const MAIN_PROTOCOL = readFileSync(
  join(AIDLC_SRC, "aidlc-common", "protocols", "stage-protocol.md"),
  "utf-8",
);
const CONSTRUCTION_PROTOCOL = readFileSync(
  join(
    AIDLC_SRC,
    "aidlc-common",
    "protocols",
    "stage-protocol-construction.md",
  ),
  "utf-8",
);
const AUTHORED_CONSTRUCTION_PROTOCOL = readFileSync(
  join(
    REPO_ROOT,
    "core",
    "aidlc-common",
    "protocols",
    "stage-protocol-construction.md",
  ),
  "utf-8",
);
const RECOVERY = readFileSync(
  join(AIDLC_SRC, "aidlc-common", "protocols", "stage-protocol-recovery.md"),
  "utf-8",
);
const STAGE = readFileSync(
  join(AIDLC_SRC, "aidlc-common", "stages", "construction", "build-and-test.md"),
  "utf-8",
);
const CODE_GENERATION = readFileSync(
  join(AIDLC_SRC, "aidlc-common", "stages", "construction", "code-generation.md"),
  "utf-8",
);

describe("t305 build-and-test.md — Step 10 failure-escalation ladder", () => {
  test("On-failure block is the ladder, not the old flat retry list", () => {
    expect(STAGE).toContain(
      "**On failure**: If build or tests fail, run the failure-escalation ladder:",
    );
    // The retired flat prose must be gone (replaced, not duplicated).
    expect(STAGE).not.toContain(
      "If unable to fix after 2 attempts, log the failure in test-results.md and present the issue to the user at the approval gate",
    );
  });

  test("rung 1: in-stage fix bounded at 2 attempts, scoped to this stage's remit", () => {
    expect(STAGE).toContain("**In-stage fix (max 2 attempts)**");
    expect(STAGE).toContain("this stage's own\n   remit");
    expect(STAGE).not.toContain("small code defects");
    expect(STAGE).toContain("generated source or test code — regardless of defect size");
  });

  test("rung 2: classify and estimate impact — impact-unestimated write-offs forbidden", () => {
    expect(STAGE).toContain("**Classify and estimate impact**");
    expect(STAGE).toContain(
      "an approach\n   chosen at code-generation (library/version,",
    );
    expect(STAGE).toContain(
      "ESTIMATE ITS\n   IMPACT — effort, financial cost, risk",
    );
    expect(STAGE).toContain(
      "Never declare a feasible path out of\n   scope on an IMPACT-UNESTIMATED effort assumption.",
    );
  });

  test("rung 3: autonomous bounded loop-back keyed to mode + impact-estimated fix + ledger bound", () => {
    expect(STAGE).toContain("**Autonomous bounded loop-back**");
    expect(STAGE).toContain("`Construction Autonomy Mode:\n   autonomous` (in aidlc-state.md)");
    expect(STAGE).toContain("an impact-estimated fix exists, and fewer than\n   3 entries exist under `## Loop-Back Log` in test-results.md");
    expect(STAGE).toContain(
      "construction protocol module\n   (`aidlc-common/protocols/stage-protocol-construction.md`)",
    );
    expect(STAGE).toContain(
      "approval gate on the failed run.",
    );
  });

  test("rung 4: halt-and-ask — impact-estimated options, giving up is the human's call", () => {
    expect(STAGE).toContain("**Halt-and-ask**");
    expect(STAGE).toContain(
      "listing every candidate fix WITH ITS\n   ESTIMATED IMPACT",
    );
    expect(STAGE).toContain(
      "Giving up is the human's decision to make, never the\n   agent's.",
    );
  });

  test("artifact list carries the Loop-Back Log shape (append-only, Modify-never-Redo)", () => {
    expect(STAGE).toContain("`## Loop-Back Log` (only when the failure ladder's rung 3 or 4 fires a");
    expect(STAGE).toContain("`### Loop-back N — <ISO timestamp>` entry per attempt");
    expect(STAGE).toContain("Diagnosis / Root-cause stage / Planned fix / Estimated impact");
    expect(STAGE).toContain("APPEND-ONLY");
    expect(STAGE).toContain("choose Modify,\n     never Redo, on loop-back re-entry");
  });

  test("single-stage runs stop at rung 2 (no main-workflow position to move)", () => {
    expect(STAGE).toContain("**Single-stage runs**");
    expect(STAGE).toContain("rungs 3-4 never execute a jump");
    expect(STAGE).toContain("no main-workflow position");
    expect(STAGE).toContain("Stop at rung 2");
    expect(STAGE).toContain("log the diagnosis + impact-estimated options in");
  });
});

describe("t305 construction protocol module — Build-and-Test failure loop-back subsection", () => {
  test("authored Construction module is byte-aligned across every dist", () => {
    const normalize = (body: string, harnessDir: string) =>
      body.replaceAll(harnessDir, "{{HARNESS_DIR}}");
    expect(normalize(CONSTRUCTION_PROTOCOL, ".claude")).toBe(
      AUTHORED_CONSTRUCTION_PROTOCOL,
    );
    const mismatched = HARNESS_MATRIX.flatMap((harness) => {
      const path = join(
        harness.engineRoot,
        "aidlc-common",
        "protocols",
        "stage-protocol-construction.md",
      );
      return normalize(
        readFileSync(path, "utf-8"),
        harness.capabilities.harnessDir,
      ) === AUTHORED_CONSTRUCTION_PROTOCOL
        ? []
        : [harness.name];
    });
    expect(mismatched).toEqual([]);
  });

  test('the "### Build-and-Test failure loop-back (3.6 → 3.5)" heading exists (anchored H3)', () => {
    expect(/^### Build-and-Test failure loop-back \(3\.6 → 3\.5\)$/m.test(CONSTRUCTION_PROTOCOL)).toBe(true);
  });

  test("the subsection is a SIBLING of the Construction Halt-and-ask block", () => {
    const haltIdx = CONSTRUCTION_PROTOCOL.indexOf("**Halt-and-ask on failure**");
    const loopIdx = CONSTRUCTION_PROTOCOL.indexOf("### Build-and-Test failure loop-back (3.6 → 3.5)");
    const nextSectionIdx = CONSTRUCTION_PROTOCOL.indexOf("\n---\n", loopIdx);
    expect(haltIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(haltIdx);
    expect(nextSectionIdx).toBeGreaterThan(loopIdx);
  });

  test("sanctioned-exception sentence on the NO EMERGENT BEHAVIOR RULE paragraph", () => {
    expect(MAIN_PROTOCOL).toContain(
      "Two sanctioned carve-outs exist: the revision loop escape hatch (below) and the Build-and-Test failure loop-back in the construction protocol module (`aidlc-common/protocols/stage-protocol-construction.md`).",
    );
  });

  test("EXCEPTION sentence on Critical-checklist item 5 (stage ritual atomic)", () => {
    expect(MAIN_PROTOCOL).toContain(
      "EXCEPTION: the Build-and-Test failure loop-back in the construction protocol module (`aidlc-common/protocols/stage-protocol-construction.md`) jumps back from a deliberately in-flight failed stage; its §13 learnings ritual defers to the eventual passing run.",
    );
  });

  test("ledger paragraph: artifact ledger beats counting STAGE_JUMPED rows", () => {
    expect(CONSTRUCTION_PROTOCOL).toContain("the count of `### Loop-back N` entries IS the bound (max 3 per intent)");
    expect(CONSTRUCTION_PROTOCOL).toContain("survives the backward jump (jumps reset checkboxes, never artifacts)");
    expect(CONSTRUCTION_PROTOCOL).toContain("colocated with the diagnosis");
    expect(CONSTRUCTION_PROTOCOL).toContain("readable at the\nfinal gate");
    expect(CONSTRUCTION_PROTOCOL).toContain("STAGE_JUMPED rows the jump tool emits remain the\ndeterministic audit cross-check");
    expect(CONSTRUCTION_PROTOCOL).toContain("The log is append-only.");
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "A human-directed\nbackward jump does not count against the bound",
    );
  });

  test("autonomous procedure routes the jump through the ENGINE, not a hand-composed execute", () => {
    // Step 2 names the engine invocation…
    expect(CONSTRUCTION_PROTOCOL).toContain("tools/aidlc-orchestrate.ts next --stage code-generation`");
    // …which answers with the validated jump print the conductor runs verbatim.
    expect(CONSTRUCTION_PROTOCOL).toContain("`aidlc-jump.ts execute --target code-generation --direction\n   backward --scope <scope>`");
    expect(CONSTRUCTION_PROTOCOL).toContain("run that printed command verbatim");
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "Never compose the `execute` call by hand — the engine's print is the\n   validated form.",
    );
  });

  test("procedure step 1 appends the ledger entry AND a Deviations note in memory.md", () => {
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "Append the `### Loop-back N — <ISO timestamp>` entry (Diagnosis /\n   Root-cause stage / Planned fix / Estimated impact) to test-results.md and a matching\n   Deviations entry to this stage's memory.md.",
    );
  });

  test("the standing autonomy grant covers the replayed code-generation gate (explicit marker)", () => {
    expect(CONSTRUCTION_PROTOCOL).toContain(
      '`--user-input "Autonomous loop-back N per construction protocol module"`',
    );
    expect(CONSTRUCTION_PROTOCOL).toContain("not a new autonomy inference");
    expect(CONSTRUCTION_PROTOCOL).toContain("checklist item\n   6");
  });

  test("plan approval remains authoritative across the repair replay", () => {
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "The recorded Plan Approval answer remains\nauthoritative: the conductor MUST NOT blank its `[Answer]:` for the loop-back\nrevision",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "the human's \"Retry with fix\" answer IS the re-approval of the\nrevised approach",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "The plan-approval guard's evidence survives\nthe jump because the non-empty plan and its approved questions file are\npreserved.",
    );
    expect(CODE_GENERATION).toContain(
      "**Build-and-Test loop-back exception:** The loop-back in the construction",
    );
    expect(CODE_GENERATION).toContain(
      "Do not blank the Plan Approval `[Answer]:`",
    );
    expect(CODE_GENERATION).toContain(
      "The plan-approval guard's evidence survives the jump",
    );
  });

  test("cross-file references point to the conditional Construction module", () => {
    const modulePath =
      "aidlc-common/protocols/stage-protocol-construction.md";
    expect(MAIN_PROTOCOL).toContain(modulePath);
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "### Build-and-Test failure loop-back (3.6 → 3.5)",
    );
    expect(STAGE).toContain(modulePath);
    expect(CODE_GENERATION).toContain(modulePath);
    expect(RECOVERY).toContain(modulePath);
    expect(STAGE).not.toContain("stage-protocol.md §1");
    expect(CODE_GENERATION).not.toContain("stage-protocol.md §1");
    expect(RECOVERY).not.toContain("stage-protocol.md\n§1");
  });

  test("replay ends with Modify at build-and-test's own re-use prompt + fresh Step 10", () => {
    expect(CONSTRUCTION_PROTOCOL).toContain("choose Modify\n   at its own Artifact Re-use prompt");
    expect(CONSTRUCTION_PROTOCOL).toContain("re-execute Step 10 fresh");
  });

  test("re-entry is settlement-aware and every path refreshes per-unit reviews", () => {
    expect(CONSTRUCTION_PROTOCOL).toContain("**Re-entry settlement and review.**");
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "**Artifact-only workflow** — when no code-generation lifecycle row has ever",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "The re-entry `next`\n   call can therefore emit the all-covered `gate: true` fast path",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "**Receipt-mode workflow** — once any code-generation lifecycle row exists,\n   receipt mode is sticky",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "re-mint `unit start` / `unit complete`",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "On BOTH paths, after every fix and re-use decision and BEFORE presenting or\nauto-approving the settle/approval gate, dispatch code-generation's declared\nreviewer for every applicable unit",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "The backward jump's `STAGE_JUMPED` invalidates\nevery prior review receipt, and the engine refuses approval",
    );
  });

  test("unit-major replay stays serial and uses the same receipt/review route", () => {
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "Under unit-major iteration the autonomous swarm never\nfires: the replay follows the ordinary per-unit walk",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "the plan-approval carve-out keeps the\nautonomous repair free of an extra human turn",
    );
  });

  test("swarm interaction: exact attempt floor, fresh prepare, review-before-finalize cheap path", () => {
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "the jump establishes a new exact stage-attempt `Run floor`\nboundary token (`<event>:<timestamp>#<ordinal>`",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain("prior-attempt rows no longer count and all units\nre-dispatch by default");
    expect(CONSTRUCTION_PROTOCOL).toContain("after\n`prepare`, run\n`check <unit> --check-cmd");
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "A unit already green needs no builder turn, but before putting it in\n`finalize --claimed`, dispatch code-generation's reviewer",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "`finalize`\nthen verifies the current prepare stamp, the terminal receipt, and its current\nartifact fingerprint",
    );
  });

  test("halt-and-ask question template: 3 impact-estimated options, bound surfaced", () => {
    expect(CONSTRUCTION_PROTOCOL).toContain(
      'prompt: "Build and Test failed: [short error]. Root cause: [diagnosis]. Candidate fix: [fix] — estimated impact — effort: [effort]; financial cost: [cost]; risk: [risk]. Loop-backs used: [N]/3. How would you like to proceed?"',
    );
    const lines = CONSTRUCTION_PROTOCOL.split("\n");
    const retryIdx = lines.findIndex((l) => /^\s*- label: Retry with fix$/.test(l));
    expect(retryIdx).toBeGreaterThan(-1);
    expect(lines[retryIdx + 1]).toContain(
      "apply [fix] (estimated impact — effort: [effort]; financial cost: [cost]; risk: [risk]), re-run",
    );
    const acceptIdx = lines.findIndex((l) => /^\s*- label: Accept failure$/.test(l));
    expect(acceptIdx).toBeGreaterThan(-1);
    expect(lines[acceptIdx + 1]).toContain("proceed to this stage's approval gate");
  });

  test("impact-unestimated give-up option is a protocol violation; human retry counts + may override bound", () => {
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "presenting an\nimpact-unestimated give-up option is a protocol violation",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "A human-approved retry does count an entry in the Loop-Back",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "the human may override the bound explicitly",
    );
  });

  test("Artifact Re-use tail: deterministic auto-decision, Redo forbidden, still audited", () => {
    const tailIdx = MAIN_PROTOCOL.indexOf("### Artifact Re-use (backward jump / redo)");
    expect(tailIdx).toBeGreaterThan(-1);
    const tail = MAIN_PROTOCOL.slice(tailIdx);
    expect(tail).toContain("**Autonomous failure loop-back**");
    expect(tail).toContain("the 3-option question is NOT presented");
    expect(tail).toContain("**Modify** for the unit(s) the fix targets");
    expect(tail).toContain("**Keep** for all other units");
    expect(tail).toContain("**Modify** for build-and-test itself");
    expect(tail).toContain("Redo is forbidden there — it would erase the Loop-Back Log");
    // Nit fix: the audit call is spelled out in full (positional slug +
    // --artifacts), never abbreviated to a form that errors if run literally.
    expect(tail).toContain(
      'aidlc-state.ts reuse-artifact <slug>\n--decision <keep|modify> --artifacts "<comma-separated list of existing\nartifacts found>"',
    );
  });

  test("Finding 1 (must-fix): Gated failure loop-back mirrors the autonomous override", () => {
    const tailIdx = MAIN_PROTOCOL.indexOf("### Artifact Re-use (backward jump / redo)");
    const tail = MAIN_PROTOCOL.slice(tailIdx);
    const gatedIdx = tail.indexOf("**Gated failure loop-back**");
    expect(gatedIdx).toBeGreaterThan(-1);
    const gated = tail.slice(gatedIdx);
    expect(gated).toContain('"Retry with fix" at the Build-and-Test halt-and-ask');
    expect(gated).toContain(
      "Artifact-only workflows may\narrive directly at the all-covered `gate: true` directive",
    );
    expect(gated).toContain(
      "receipt-mode workflows instead receive\nper-unit replay directives",
    );
    expect(gated).toContain("In the fast path, BEFORE presenting the gate");
    expect(gated).toContain("apply the planned fix through the override");
    expect(gated).toContain("**Modify** for the unit(s) the fix targets");
    expect(gated).toContain("**Keep** for all other units");
    expect(gated).toContain("**Modify** for build-and-test itself");
    expect(gated).toContain(
      "aidlc-state.ts reuse-artifact <slug> --decision <keep|modify>",
    );
    expect(gated).toContain(
      '--artifacts "<comma-separated list of existing artifacts found>"',
    );
    expect(gated).toContain(
      "dispatch the declared reviewer for every applicable unit and\nrecord fresh current-attempt reviews BEFORE presenting the settle/approval\ngate",
    );
    expect(gated).toContain("not a second, silent autonomy inference");
  });

  test("Finding 1 (must-fix): Retry with fix names both settlement routes and fresh reviews", () => {
    const retryIdx = CONSTRUCTION_PROTOCOL.indexOf('"Retry with fix" runs the same procedure as the autonomous loop-back');
    const settlementAwareIdx = CONSTRUCTION_PROTOCOL.indexOf('"Retry with fix" runs the same settlement-aware procedure as the autonomous');
    expect(retryIdx).toBe(-1);
    expect(settlementAwareIdx).toBeGreaterThan(-1);
    const retry = CONSTRUCTION_PROTOCOL.slice(settlementAwareIdx, settlementAwareIdx + 1_100);
    expect(retry).toContain(
      "Artifact-only workflows may take the\nall-covered `gate: true` fast path",
    );
    expect(retry).toContain(
      "receipt-mode workflows instead re-emit\nper-unit directives",
    );
    expect(retry).toContain(
      "every applicable unit MUST receive a fresh current-attempt review",
    );
    expect(retry).toContain("gate is presented");
  });
});

describe("t305 Finding 3 (must-fix): rung 4 is a second autonomous-stop case", () => {
  test("the Bolt halt-and-ask sentence names rung 4 as the second case, not 'the one case'", () => {
    expect(CONSTRUCTION_PROTOCOL).not.toContain(
      "This is the one case where `autonomous` mode stops to consult the user.",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "This is one of two cases where `autonomous` mode stops to consult the user — the other is the Build-and-Test failure loop-back's rung 4",
    );
  });
});

describe("t305 Finding 4 (should-fix): no-fix halt-and-ask variant", () => {
  test("a distinct no-fix template exists with no Candidate fix slot and no Retry with fix option", () => {
    const headingIdx = CONSTRUCTION_PROTOCOL.indexOf("**Halt-and-ask, no-fix variant");
    expect(headingIdx).toBeGreaterThan(-1);
    // Only the fenced question TEMPLATE itself must lack the slot/option —
    // the preceding prose legitimately names "Retry with fix" to explain
    // why it's omitted, so the template fence is isolated first.
    const fenceStart = CONSTRUCTION_PROTOCOL.indexOf("```question", headingIdx);
    const fenceEnd = CONSTRUCTION_PROTOCOL.indexOf("```", fenceStart + 10) + 3;
    expect(fenceStart).toBeGreaterThan(-1);
    const block = CONSTRUCTION_PROTOCOL.slice(fenceStart, fenceEnd);
    expect(block).toContain(
      'prompt: "Build and Test failed: [short error]. Root cause: [diagnosis]. No identifiable fix exists in any swappable dimension',
    );
    expect(block).not.toContain("Candidate fix:");
    expect(block).not.toContain("Retry with fix");
    const lines = block.split("\n");
    const acceptIdx = lines.findIndex((l) => /^\s*- label: Accept failure$/.test(l));
    expect(acceptIdx).toBeGreaterThan(-1);
    const abortIdx = lines.findIndex((l) => /^\s*- label: Abort$/.test(l));
    expect(abortIdx).toBeGreaterThan(acceptIdx);
  });

  test("the impact-estimated variant is explicitly named as the other option, keyed on rung 2's outcome", () => {
    expect(CONSTRUCTION_PROTOCOL).toContain("**Halt-and-ask, impact-estimated variant");
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "Choose the variant by whether rung 2's classify-and-estimate step actually\nproduced an impact-estimated candidate fix",
    );
  });

  test("build-and-test.md's rung 4 names both variants", () => {
    expect(STAGE).toContain(
      "When rung 2 found no identifiable fix at all, present that\n   section's no-fix variant instead",
    );
  });
});

describe("t305 Finding 5 (should-fix): isolated-run summary, not a workflow gate", () => {
  test("build-and-test.md's single-stage carve-out says isolated-run summary, not 'this run's gate'", () => {
    expect(STAGE).toContain(
      "test-results.md, and present them in this run's isolated-run summary.",
    );
    expect(STAGE).not.toContain("presented at this run's gate");
    expect(STAGE).not.toContain("presented at that run's gate");
  });

  test("no stray 'at this/that run's gate' phrasing remains anywhere in the pinned protocol or stage files", () => {
    expect(MAIN_PROTOCOL).not.toContain("run's gate");
    expect(CONSTRUCTION_PROTOCOL).not.toContain("run's gate");
    expect(STAGE).not.toContain("run's gate");
  });
});

describe("t305 Finding 6 (should-fix): crash-resume bullet lives under Session resume, not Stage re-run", () => {
  test("the logged-but-not-jumped detection is under Session resume", () => {
    const sessionResumeIdx = RECOVERY.indexOf("### Session resume\n");
    const stageRerunIdx = RECOVERY.indexOf("### Stage re-run");
    const detectionIdx = RECOVERY.indexOf(
      "Build-and-Test failure loop-back, logged-but-not-jumped detection",
    );
    expect(sessionResumeIdx).toBeGreaterThan(-1);
    expect(stageRerunIdx).toBeGreaterThan(sessionResumeIdx);
    expect(detectionIdx).toBeGreaterThan(sessionResumeIdx);
    expect(detectionIdx).toBeLessThan(stageRerunIdx);
  });

  test("Stage re-run no longer duplicates the crash-resume bullet, but cross-references it", () => {
    const stageRerunIdx = RECOVERY.indexOf("### Stage re-run");
    const nextHeadingIdx = RECOVERY.indexOf("### Context compaction");
    const stageRerunBlock = RECOVERY.slice(stageRerunIdx, nextHeadingIdx);
    expect(stageRerunBlock).not.toContain("## Loop-Back Log");
    expect(stageRerunBlock).toContain("is handled\nunder \"Session resume\" above");
  });
});

describe("t305 Finding 7 (should-fix): swarm cheap-path premises are handled, not silently assumed", () => {
  test("prepare-collision handling: discard stale worktrees/branches before a fresh prepare", () => {
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "`prepare` hard-errors on collision, and\n`finalize` refuses a unit without the current attempt's prepare stamp, so\ndiscard the stale worktrees/branches before a fresh `prepare`",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain("never adopt\nthem into the new attempt");
    expect(CONSTRUCTION_PROTOCOL).not.toContain("or adopt them if their code is still wanted");
  });

  test("the already-green premise is softened: depends on the prior attempt's code merge completing", () => {
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "true only\nonce that attempt's git code merge actually completed",
    );
    expect(CONSTRUCTION_PROTOCOL).toContain(
      "the cheap\npath degrades gracefully to full re-dispatch rather than silently claiming\nunbuilt units",
    );
  });
});

describe("t305 stage-protocol-recovery.md — crash-resume bullet", () => {
  test("logged-but-not-jumped detection re-executes the jump instead of re-diagnosing", () => {
    expect(RECOVERY).toContain(
      "`## Loop-Back Log` whose latest entry has a planned fix but the audit shows\nno matching `STAGE_JUMPED` (Target: code-generation) after it",
    );
    expect(RECOVERY).toContain("the session\ndied between logging and jumping");
    expect(RECOVERY).toContain(
      "re-execute the jump per the construction\nprotocol module (`aidlc-common/protocols/stage-protocol-construction.md`)",
    );
  });

  test("on any resume the loop-back count is the ledger's entry count, never zero", () => {
    expect(RECOVERY).toContain(
      "On any resume,\nthe loop-back count is the ledger's entry count, never zero.",
    );
  });

  test("resume after the jump covers inline and swarm routes without trusting stale reviews", () => {
    expect(RECOVERY).toContain(
      "If the matching\njump already exists, resume the settlement-aware re-entry instead",
    );
    expect(RECOVERY).toContain(
      "receipt-mode continues from the first unsettled unit, artifact-only mode\nresumes the pre-gate override",
    );
    expect(RECOVERY).toContain(
      "a replay that re-emits `invoke-swarm`\n(autonomous stage-major) follows that section's \"Swarm interaction\" procedure",
    );
    expect(RECOVERY).toContain(
      "discard stale worktrees/branches, run a fresh `prepare`, check every unit\nfirst, record fresh reviewer receipts, and `finalize`",
    );
    expect(RECOVERY).toContain(
      "None of the three paths\nmay treat preserved artifacts or prior receipts as current-attempt evidence",
    );
  });
});

describe("t305 conductor SKILLs — STAGE RITUAL IS ATOMIC exception (authored + dist, every harness)", () => {
  const EXCEPTION_SENTENCE =
    "(One exception: the Build-and-Test failure loop-back — the construction protocol module (`aidlc-common/protocols/stage-protocol-construction.md`) — jumps back to code-generation from a deliberately in-flight failed stage; its learnings ritual fires on the eventual passing run.)";

  test("every authored conductor SKILL carries the exception on the atomic-ritual bullet", () => {
    expect(HARNESS_MATRIX).toHaveLength(7);
    const missing: string[] = [];
    for (const harness of HARNESS_MATRIX) {
      const rel = `harness/${harness.name}/skills/aidlc/SKILL.md`;
      const body = readFileSync(join(REPO_ROOT, rel), "utf-8");
      const bullet = body
        .split("\n")
        .find((l) => l.includes("**STAGE RITUAL IS ATOMIC**"));
      if (!bullet) {
        missing.push(`${rel}  missing the STAGE RITUAL IS ATOMIC bullet`);
      } else if (!bullet.includes(EXCEPTION_SENTENCE)) {
        // Same-line co-location: the exception is part of the bullet itself,
        // not merely present somewhere in the file.
        missing.push(`${rel}  bullet lacks the loop-back exception sentence`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every dist conductor SKILL copy carries the same exception (byte-parity spot check)", () => {
    const missing: string[] = [];
    for (const harness of HARNESS_MATRIX) {
      const path = join(harness.skillsRoot, "aidlc", "SKILL.md");
      const bullet = readFileSync(path, "utf-8")
        .split("\n")
        .find((l) => l.includes("**STAGE RITUAL IS ATOMIC**"));
      if (!bullet?.includes(EXCEPTION_SENTENCE)) {
        missing.push(`dist ${harness.name}: ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
