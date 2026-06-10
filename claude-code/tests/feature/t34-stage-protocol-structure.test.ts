// covers: file:aidlc-common/protocols/stage-protocol.md, file:knowledge/aidlc-shared/state-template.md
//
// In-process port of tests/feature/t34-stage-protocol-structure.sh (TAP plan
// 69), mechanism = none. The .sh is a documentation structure + cross-reference
// check: it greps the SHIPPED stage-protocol.md and state-template.md for the
// sections, patterns, field names, and agent list the orchestrator relies on,
// and verifies the two files agree where they reference the same thing
// (state-tracking field names exist in both the protocol's sed-field guidance
// AND the state template). The .sh carried NO `# covers:` header, so it joined
// to zero enumerated registry units — and none of the seven enumerated unit
// classes (function/audit/scope/stage/hook/subcommand/render-surface) models a
// markdown document's structure. The `file:` covers ids above name the two
// documents under test honestly; they parse through gen-coverage-registry's
// parseCoversHeader and (like the .sh) join to no enumerated unit. No coverage
// guarantee is lost: the .sh contributed none.
//
// MECHANISM = none. The .sh shelled out to `grep` / `sed` over file content and
// never touched a function, a CLI tool, argv, exit codes, or a process boundary.
// gen-coverage-registry derives mechanism from the DRIVERS a test body calls
// (milestone 3): this twin calls NO driver (no driveAidlc, no tui-drive.ts, no spawn of
// an aidlc-*.ts tool or run-tests.sh), so its derived set is the deterministic
// `none` floor — matching the t14 / t43 / t44 protocol-content family. Every
// assertion is readFileSync + a string / regex / count check on the real bytes
// of the shipped docs, the same observable the .sh's grep / sed asserted.
//
// FIXTURE DISCIPLINE: the inputs are the REAL committed shipped files under
// dist/claude/.claude/, read-only, resolved through AIDLC_SRC from
// tests/harness/fixtures.ts (the same anchor the .sh's $AIDLC_SRC pointed at —
// fixtures resolves AIDLC_SRC to <repo>/dist/claude/.claude). NOTHING is written; no temp
// project, no teardown — there is no mutable surface.
//
// Source under test (read fresh each run):
//   dist/claude/.claude/aidlc-common/protocols/stage-protocol.md   (PROTOCOL)
//   dist/claude/.claude/knowledge/aidlc-shared/state-template.md   (STATE_TEMPLATE)
// The .sh also DEFINED SKILL / AGENTS_DIR / STAGES_DIR but referenced none of
// them in any assertion (verified: only $PROTOCOL and $STATE_TEMPLATE appear in
// assert lines). They are deliberately omitted here — porting an unused var
// would be dead code, not a guarantee.
//
// Old TAP → new test parity (1:1; the .sh's plan was 69 = 42 assert_grep + 8
// scope-loop + 7 state-field-loop + 11 agent-loop + 1 knowledge-steps). Every
// .sh assertion maps to one expect() below; several are STRONGER (anchored
// `^##` regex instead of substring grep, exact counts, single-line co-location
// of the state-field-in-both-files check, exact agent count == 11):
//
//   §1 section headings  (.sh 20-31, 12 asserts) → test "required ## sections"
//      block: 12 anchored `^## N. <Title>` regex matches.
//   §1 init-exempt list  (.sh 38)   → "exempts the 3 initialization stages"
//   §1 2-option (C/O)     (.sh 42)   → "Construction/Operation restricted to 2-option"
//   §1 3-option (I/I)     (.sh 46)   → "Ideation/Inception may add a 3rd option"
//   §1 escape hatch 3x    (.sh 50)   → "revision escape hatch after 3 cycles"
//   §1 Accept as-is       (.sh 52)   → "escape hatch offers Accept as-is"
//   §2 Part 0..4          (.sh 57-61, 5 asserts) → "completion 5-part structure"
//   §2 scope rows         (.sh 64-70, 8 asserts)  → "depth/progress tables list scope" each
//   §3 Guide me           (.sh 76)   → "question mode: Guide me"
//   §3 I'll edit the file (.sh 77)   → "question mode: I'll edit the file"
//   §3 Chat               (.sh 78)   → "question mode: Chat"
//   §3 contradiction      (.sh 80)   → "contradiction detection MANDATORY heading"
//   §4 state field in both(.sh 88-96, 7 asserts) → "state field <f> in BOTH protocol+template"
//   §4 checkbox [ ]       (.sh 99)   → "checkbox notation [ ] not started" (anchored)
//   §4 checkbox [-]       (.sh 100)  → "checkbox notation [-] in progress"  (anchored)
//   §4 checkbox [x]       (.sh 101)  → "checkbox notation [x] completed"    (anchored)
//   §5 11 agents          (.sh 106-114, 11 asserts) → "agent list line includes <a>" each
//                                       (STRONGER: also asserts exactly 11 on the line)
//   §5 knowledge >=6 steps(.sh 117-122)→ "knowledge loading order has >= 6 steps"
//   §4 audit Error fmt    (.sh 127)  → "audit format: Error"
//   §4 audit Recovery fmt (.sh 128)  → "audit format: Recovery"
//   §4 audit ChangeReq fmt(.sh 129)  → "audit format: Change Request"
//   §4 audit Question fmt (.sh 130)  → "audit format: Question interaction"
//   §8 depth-aware gen    (.sh 133)  → "depth-aware question generation section"
//   §8 ~2-4 range         (.sh 134)  → "Minimal range ~2-4"
//   §8 ~8-12 range        (.sh 135)  → "Comprehensive range ~8-12"
//   §8 Test Strategy      (.sh 138)  → "Test Strategy section in §8"
//   §8 Nyquist            (.sh 139)  → "test strategy mentions Nyquist"
//   §8 5-8 per component  (.sh 140)  → "Standard volume 5-8 tests per component"
//   §3 within-bolt        (.sh 143)  → "Within-Bolt Question Collection section"
//   §3 QUESTION-ONLY      (.sh 144)  → "references QUESTION-ONLY mode"
//   §3 ARTIFACT-ONLY      (.sh 145)  → "references ARTIFACT-ONLY mode"

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

// The two shipped documents the .sh's $PROTOCOL / $STATE_TEMPLATE pointed at.
const PROTOCOL_PATH = join(
  AIDLC_SRC,
  "aidlc-common",
  "protocols",
  "stage-protocol.md",
);
const STATE_TEMPLATE_PATH = join(
  AIDLC_SRC,
  "knowledge",
  "aidlc-shared",
  "state-template.md",
);

const PROTOCOL = readFileSync(PROTOCOL_PATH, "utf-8");
const STATE_TEMPLATE = readFileSync(STATE_TEMPLATE_PATH, "utf-8");

/** assert_grep equivalent: the .sh's `grep -E "<re>"` over the protocol. The
 *  pattern is matched with multiline semantics so a `^`-anchored heading regex
 *  behaves exactly like the line-oriented grep the .sh ran. */
function protocolMatches(re: RegExp): boolean {
  return re.test(PROTOCOL);
}

/** Plain-substring presence (the .sh's `grep -F` / unanchored `grep`). */
function protocolHas(s: string): boolean {
  return PROTOCOL.includes(s);
}

describe("t34 stage-protocol.md structure + cross-references (migrated from t34-stage-protocol-structure.sh, plan 69)", () => {
  // =========================================================================
  // §1 — Required ## sections exist (.sh 20-31). Anchored `^## N. <Title>`
  // regex per section — STRONGER than the .sh's per-line grep (the heading
  // must be a real H2 at line start, not a mid-line mention).
  // =========================================================================
  const REQUIRED_SECTIONS: ReadonlyArray<[number, string]> = [
    [1, "Approval Gates"],
    [2, "Completion Messages"],
    [3, "Question Format"],
    [4, "State Tracking"],
    [5, "Agent Persona Loading"],
    [6, "Error Recovery"],
    [8, "Depth Guidance"],
    [9, "Terminology"],
    [10, "Content Validation"],
    [11, "Subagent Return Summary"],
    [12, "Phase Boundary Verification"],
    [13, "Learnings Ritual"],
  ];
  for (const [n, title] of REQUIRED_SECTIONS) {
    test(`§1: required heading "## ${n}. ${title}" exists`, () => {
      // Mirror the .sh's anchored `^## N\. Title` grep, multiline.
      const re = new RegExp(`^## ${n}\\. ${title}\\b`, "m");
      expect(protocolMatches(re)).toBe(true);
    });
  }

  // =========================================================================
  // §1 — Approval gate patterns (.sh 38-52).
  // =========================================================================
  test("§1: approval gate exempts all 3 initialization stages", () => {
    expect(protocolHas("workspace-scaffold, workspace-detection, state-init")).toBe(true);
  });

  test("§1: Construction/Operation restricted to 2-option approval", () => {
    expect(protocolHas("CONSTRUCTION and OPERATION stages: Strictly 2-option only")).toBe(true);
  });

  test("§1: Ideation/Inception may include a 3rd option", () => {
    expect(protocolHas("IDEATION and INCEPTION stages may include a 3rd option")).toBe(true);
  });

  test('§1: revision escape hatch triggers after 3 "Request Changes" cycles', () => {
    expect(protocolHas('After 3 "Request Changes" cycles')).toBe(true);
  });

  test("§1: escape hatch offers Accept as-is option", () => {
    expect(protocolHas("Accept as-is")).toBe(true);
  });

  // =========================================================================
  // §2 — Completion message 5-part structure (.sh 57-61). Anchored `^### Part`.
  // =========================================================================
  const COMPLETION_PARTS: ReadonlyArray<[string, string]> = [
    ["Part 0", "Enter the approval gate"],
    ["Part 1", "Announcement"],
    ["Part 2", "Summary"],
    ["Part 3", "Review + Approval"],
    ["Part 4", "Progress update"],
  ];
  for (const [part, label] of COMPLETION_PARTS) {
    test(`§2: completion "### ${part}: ${label}" defined`, () => {
      // The .sh grepped the literal `### Part N: Label`; assert it anchored at
      // line start (it IS an H3 heading), which is stronger. Escape regex
      // metacharacters in the label so "Review + Approval" matches the literal
      // `+` rather than treating it as a quantifier.
      const escaped = `${part}: ${label}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^### ${escaped}`, "m");
      expect(protocolMatches(re)).toBe(true);
    });
  }

  // =========================================================================
  // §2 — Progress/depth tables list every scope (.sh 64-70). The .sh's
  // `grep -qF "| $scope"`: a markdown table cell opening with the scope name.
  // =========================================================================
  const SCOPES = [
    "enterprise",
    "feature",
    "mvp",
    "poc",
    "bugfix",
    "refactor",
    "infra",
    "security-patch",
  ] as const;
  for (const scope of SCOPES) {
    test(`§2: depth/progress tables list scope "${scope}"`, () => {
      // Byte-for-byte the .sh's grep -qF "| <scope>".
      expect(protocolHas(`| ${scope}`)).toBe(true);
    });
  }

  // =========================================================================
  // §3 — Question format: three interaction modes + mandatory contradiction
  // detection (.sh 76-80).
  // =========================================================================
  test("§3: question mode 'Guide me' present", () => {
    expect(protocolHas("Guide me")).toBe(true);
  });

  test("§3: question mode \"I'll edit the file\" present", () => {
    expect(protocolHas("I'll edit the file")).toBe(true);
  });

  test("§3: question mode 'Chat' present", () => {
    expect(protocolHas("Chat")).toBe(true);
  });

  test("§3: contradiction detection is MANDATORY (### heading)", () => {
    expect(protocolHas("### Contradiction detection (MANDATORY)")).toBe(true);
  });

  // =========================================================================
  // §4 — State tracking: each sed-referenced field exists in BOTH the protocol
  // guidance AND the state template (.sh 88-96). The .sh required
  // `grep "**FIELD**"` in BOTH files. STRONGER here: assert co-presence in one
  // test per field, so a field present in only one file fails loudly.
  // =========================================================================
  const STATE_FIELDS = [
    "Current Stage",
    "Lifecycle Phase",
    "Status",
    "Last Updated",
    "Active Agent",
    "In Progress",
    "Completed",
  ] as const;
  for (const field of STATE_FIELDS) {
    test(`§4: sed field "${field}" appears as **${field}** in BOTH protocol and state template`, () => {
      const marker = `**${field}**`;
      expect(PROTOCOL.includes(marker)).toBe(true);
      expect(STATE_TEMPLATE.includes(marker)).toBe(true);
    });
  }

  // =========================================================================
  // §4 — Stage-progress checkbox notation (.sh 99-101). The .sh used
  // line-anchored greps; reproduce with `^`-anchored multiline regex.
  // =========================================================================
  test("§4: checkbox notation `[ ]` — Not started (anchored)", () => {
    expect(protocolMatches(/^- `\[ \]` — Not started/m)).toBe(true);
  });

  test("§4: checkbox notation `[-]` — In progress (anchored)", () => {
    expect(protocolMatches(/^- `\[-\]` — In progress/m)).toBe(true);
  });

  test("§4: checkbox notation `[x]` — Completed (anchored)", () => {
    expect(protocolMatches(/^- `\[x\]` — Completed/m)).toBe(true);
  });

  // =========================================================================
  // §5 — Agent persona loading: all 11 agents on the agent-list line
  // (.sh 106-114). The .sh extracted the `^aidlc-product-agent` line, then
  // grepped each agent within it. Reproduce: pull THAT line, assert each agent
  // is on it, AND (STRONGER) assert it carries exactly 11 comma-separated
  // agents — so a dropped or added agent fails.
  // =========================================================================
  const AGENT_LINE =
    PROTOCOL.split("\n").find((l) => l.startsWith("aidlc-product-agent")) ?? "";
  const ELEVEN_AGENTS = [
    "aidlc-product-agent",
    "aidlc-design-agent",
    "aidlc-delivery-agent",
    "aidlc-architect-agent",
    "aidlc-aws-platform-agent",
    "aidlc-compliance-agent",
    "aidlc-devsecops-agent",
    "aidlc-developer-agent",
    "aidlc-quality-agent",
    "aidlc-pipeline-deploy-agent",
    "aidlc-operations-agent",
  ] as const;
  for (const agent of ELEVEN_AGENTS) {
    test(`§5: protocol agent-list line includes ${agent}`, () => {
      // The .sh's `echo "$AGENT_LIST" | grep -qF "$agent"`.
      expect(AGENT_LINE.includes(agent)).toBe(true);
    });
  }
  test("§5: agent-list line names exactly 11 agents (no drop/add)", () => {
    // STRONGER than the .sh: pin the cardinality so the list can't silently
    // grow or shrink while still containing the 11 names above.
    const names = AGENT_LINE.split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("aidlc-") && s.endsWith("-agent"));
    expect(names.length).toBe(11);
  });

  // =========================================================================
  // §5 — Knowledge loading order has >= 6 numbered steps (.sh 117-122). The
  // .sh sliced the protocol between "### Knowledge loading order" and the next
  // "### For inline" heading, then counted lines starting `N.`. Reproduce the
  // slice + count exactly.
  // =========================================================================
  test("§5: knowledge loading order has >= 6 numbered steps", () => {
    const lines = PROTOCOL.split("\n");
    const start = lines.findIndex((l) => l.includes("### Knowledge loading order"));
    expect(start).toBeGreaterThanOrEqual(0);
    const endRel = lines
      .slice(start + 1)
      .findIndex((l) => l.includes("### For inline"));
    const end = endRel === -1 ? lines.length : start + 1 + endRel;
    // The .sh's `grep -c "^[0-9]\."` over the sed slice (inclusive of both
    // boundary lines). Count numbered-step lines `N.` at line start.
    const slice = lines.slice(start, end + 1);
    const steps = slice.filter((l) => /^[0-9]+\./.test(l)).length;
    expect(steps).toBeGreaterThanOrEqual(6);
  });

  // =========================================================================
  // §4 — Specialized audit log formats all present (.sh 127-130). Anchored
  // `#### ... log format` H4 headings.
  // =========================================================================
  const AUDIT_FORMATS: ReadonlyArray<[string, string]> = [
    ["Error", "#### Error log format"],
    ["Recovery", "#### Recovery log format"],
    ["Change Request", "#### Change Request log format"],
    ["Question interaction", "#### Question interaction log format"],
  ];
  for (const [name, heading] of AUDIT_FORMATS) {
    test(`§4: specialized audit format present — ${name}`, () => {
      expect(protocolHas(heading)).toBe(true);
    });
  }

  // =========================================================================
  // §8 — Depth-aware question generation + ranges (.sh 133-135).
  // =========================================================================
  test("§8: Depth-aware question generation section exists", () => {
    expect(protocolHas("Depth-aware question generation")).toBe(true);
  });

  test("§8: depth guidance includes Minimal range ~2-4", () => {
    expect(protocolHas("~2-4")).toBe(true);
  });

  test("§8: depth guidance includes Comprehensive range ~8-12", () => {
    expect(protocolHas("~8-12")).toBe(true);
  });

  // =========================================================================
  // §8 — Test Strategy section (.sh 138-140).
  // =========================================================================
  test("§8: Test Strategy section exists (### heading)", () => {
    expect(protocolHas("### Test Strategy")).toBe(true);
  });

  test("§8: test strategy mentions the Nyquist model", () => {
    expect(protocolHas("Nyquist")).toBe(true);
  });

  test("§8: test strategy defines Standard volume (5-8 tests per component)", () => {
    expect(protocolHas("5-8 tests per component")).toBe(true);
  });

  // =========================================================================
  // §3 — Within-Bolt Question Collection + execution modes (.sh 143-145).
  // =========================================================================
  test("§3: Within-Bolt Question Collection section exists", () => {
    expect(protocolHas("### Within-Bolt Question Collection")).toBe(true);
  });

  test("§3: bolt protocol references QUESTION-ONLY mode", () => {
    expect(protocolHas("QUESTION-ONLY mode")).toBe(true);
  });

  test("§3: bolt protocol references ARTIFACT-ONLY mode", () => {
    expect(protocolHas("ARTIFACT-ONLY mode")).toBe(true);
  });
});
