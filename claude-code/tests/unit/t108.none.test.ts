// covers: function:setCheckbox
//
// t108 — setCheckbox() in aidlc-lib.ts.
// Mechanism: none (pure string transform, zero I/O, zero LLM, zero tokens).
// Technique: metamorphic — the no-clobber-neighbours invariant.
//
// Source (dist/claude/.claude/tools/aidlc-lib.ts):
//   :484  setCheckbox(content, slug, newState): string
//   :489    marker = CHECKBOX_MAP[newState]        // a BRACKETED literal, e.g. "[x]"
//   :491    regex  = /^(- )\[[ xSR?-]\]( <slug> —)/  with flag "m" ONLY (no "g")
//   :495    return content.replace(regex, `$1${marker}$2`)
//
// Verified facts the assertions below depend on (read at the cited lines):
//   - CHECKBOX_MAP (:50-57) maps states to bracketed markers:
//       pending "[ ]", in-progress "[-]", awaiting-approval "[?]",
//       revising "[R]", completed "[x]", skipped "[S]".
//     setCheckbox swaps the WHOLE bracket group; group 1 is "- " and group 2
//     is " <slug> —" (space + slug + space + U+2014 em-dash).
//   - The divider is an EM-DASH U+2014 (bytes e2 80 94), confirmed via od on
//     line 492. A line that uses a hyphen-minus instead will NOT match.
//   - Flag is "m" but NOT "g": content.replace fires on the FIRST match only.
//     Slugs are normally unique per checkbox list, so this flips exactly the
//     target line; a later identical slug (pathological) would be untouched.
//   - escapeRegex (:1540) escapes regex metachars in the slug, so a slug like
//     "v0.4.0" is matched literally (the "." is not a wildcard).
//   - ABSENT slug => regex has no match => content.replace returns the SAME
//     string reference, unchanged. NOT an insert, NOT a throw. (Verified by
//     reading :491-495: there is no else-branch, no push, no error path.)
//
// Test-design note (house style, per tests/unit/t69-worktree-path.sh and
// t106.none.test.ts): assert the OBSERVABLE CONTRACT, never re-implement the
// regex. The load-bearing assertion is metamorphic: build a multi-checkbox
// block, flip exactly one slug, and prove every OTHER line is byte-identical
// to the input. A test that merely re-runs replace() would only catch
// deletion; the line-by-line neighbour diff catches a regex that over-matches
// (drops the slug anchor, becomes global, or swallows adjacent lines).

import { describe, expect, test } from "bun:test";
import {
  CHECKBOX_MAP,
  type CheckboxState,
  setCheckbox,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// U+2014 EM DASH — the divider setCheckbox's regex requires between slug and
// suffix. Spelled out as an escape so the literal can't be silently mangled
// by an editor that "helpfully" normalises dashes.
const EM = "—";

// A realistic multi-checkbox block. Mixed starting states across the six
// markers, distinct slugs, and varied suffixes (including one with a colon
// and one with regex-metachar-laden text) so a flip has plenty of neighbours
// that MUST stay byte-identical.
function buildBlock(): string {
  return [
    `- [ ] ideation ${EM} EXECUTE`,
    `- [-] inception ${EM} EXECUTE`,
    `- [x] construction ${EM} SKIP: already shipped`,
    `- [S] operation ${EM} SKIP: out of scope (v2.0+)`,
    `- [?] review ${EM} awaiting sign-off`,
    `- [R] rework ${EM} EXECUTE`,
  ].join("\n");
}

const ALL_SLUGS = [
  "ideation",
  "inception",
  "construction",
  "operation",
  "review",
  "rework",
] as const;

// Split into lines and return only the lines whose slug is NOT `target`.
// Used to assert neighbours are untouched.
function neighbourLines(content: string, target: string): string[] {
  return content.split("\n").filter((line) => {
    // A checkbox line for slug S looks like: "- [m] S — ...". Extract the slug
    // token (3rd whitespace-delimited field) to decide membership without
    // re-implementing setCheckbox's regex.
    const m = /^- \[.\] (\S+) /.exec(line);
    return m ? m[1] !== target : true;
  });
}

// The line for a given slug, or undefined if absent.
function lineForSlug(content: string, slug: string): string | undefined {
  return content
    .split("\n")
    .find((line) => new RegExp(`^- \\[.\\] ${slug} `).test(line));
}

describe("setCheckbox() — target line flips to the new state", () => {
  test("yields the exact bracketed marker for the target slug", () => {
    // Pin the observable literal. CHECKBOX_MAP.completed is "[x]"; after the
    // flip the target line must START with "- [x] inception ". This catches a
    // marker map drift OR a replacement that dropped/duplicated the brackets.
    const out = setCheckbox(buildBlock(), "inception", "completed");
    expect(lineForSlug(out, "inception")).toBe(`- [x] inception ${EM} EXECUTE`);
  });

  test("flips through every state correctly, preserving the suffix", () => {
    // For each target state, the marker must equal CHECKBOX_MAP[state] and the
    // " inception — EXECUTE" tail must survive verbatim. Drives all six
    // markers so a single corrupted CHECKBOX_MAP entry is caught.
    const states: CheckboxState[] = [
      "pending",
      "in-progress",
      "awaiting-approval",
      "revising",
      "completed",
      "skipped",
    ];
    for (const state of states) {
      const out = setCheckbox(buildBlock(), "inception", state);
      const marker = CHECKBOX_MAP[state]; // bracketed, e.g. "[?]"
      expect(lineForSlug(out, "inception")).toBe(
        `- ${marker} inception ${EM} EXECUTE`
      );
    }
  });

  test("flipping a slug that already holds the target state is a clean no-op on that line", () => {
    // "construction" starts at "[x]" (completed). Re-setting it to completed
    // must leave the line identical — group-1/group-2 are preserved and the
    // marker is rewritten to the same value.
    const block = buildBlock();
    const out = setCheckbox(block, "construction", "completed");
    expect(lineForSlug(out, "construction")).toBe(
      `- [x] construction ${EM} SKIP: already shipped`
    );
  });
});

describe("setCheckbox() — metamorphic no-clobber-neighbours invariant", () => {
  test("every non-target line is byte-identical after a single flip", () => {
    // THE load-bearing assertion. For each slug, flip it and assert that the
    // multiset of all OTHER lines is unchanged byte-for-byte. A regex that
    // over-matches (lost the per-slug anchor, went global, or consumed an
    // adjacent line) would mutate a neighbour and fail here.
    const block = buildBlock();
    for (const target of ALL_SLUGS) {
      const out = setCheckbox(block, target, "skipped");
      const before = neighbourLines(block, target);
      const after = neighbourLines(out, target);
      expect(after).toEqual(before);
    }
  });

  test("only the target line changes; the diff against the input is exactly one line", () => {
    // Complementary framing of the invariant at the whole-string level.
    // Flipping "review" ("[?]" -> "[x]") must change EXACTLY one line. Counts
    // the per-line differences; any count other than 1 means the transform
    // either touched a neighbour (>1) or failed to match its target (0).
    const block = buildBlock();
    const out = setCheckbox(block, "review", "completed");

    const beforeLines = block.split("\n");
    const afterLines = out.split("\n");
    expect(afterLines.length).toBe(beforeLines.length); // no inserted/removed lines

    let changed = 0;
    let changedIndex = -1;
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i] !== afterLines[i]) {
        changed++;
        changedIndex = i;
      }
    }
    expect(changed).toBe(1);
    // And the one changed line is precisely the "review" line, now completed.
    expect(afterLines[changedIndex]).toBe(`- [x] review ${EM} awaiting sign-off`);
  });

  test("does not touch a slug that is a substring-prefix of the target", () => {
    // The slug is anchored by the trailing " <slug> —". Two slugs where one is
    // a prefix of the other must not cross-contaminate: flipping "build" must
    // leave "build-extra" alone, because "build" is not followed by " —" on
    // the "build-extra" line.
    const block = [
      `- [ ] build ${EM} EXECUTE`,
      `- [ ] build-extra ${EM} EXECUTE`,
    ].join("\n");
    const out = setCheckbox(block, "build", "completed");
    expect(lineForSlug(out, "build")).toBe(`- [x] build ${EM} EXECUTE`);
    // The neighbour, whose slug merely shares the "build" prefix, is untouched.
    expect(out.split("\n")[1]).toBe(`- [ ] build-extra ${EM} EXECUTE`);
  });

  test("treats a regex-metachar slug literally (escapeRegex contract)", () => {
    // A slug containing "." must be matched as a literal dot, not a wildcard.
    // If escapeRegex were dropped, "v0X4X0" would also match "v0.4.0"'s
    // pattern. We assert the dotted slug flips and a same-shape neighbour that
    // differs only by literal vs. wildcard char is NOT touched.
    const block = [
      `- [ ] v0.4.0 ${EM} EXECUTE`,
      `- [ ] v0X4X0 ${EM} EXECUTE`,
    ].join("\n");
    const out = setCheckbox(block, "v0.4.0", "completed");
    expect(out.split("\n")[0]).toBe(`- [x] v0.4.0 ${EM} EXECUTE`);
    // The wildcard-collision candidate must remain pending and byte-identical.
    expect(out.split("\n")[1]).toBe(`- [ ] v0X4X0 ${EM} EXECUTE`);
  });
});

describe("setCheckbox() — absent slug behaviour (verified real contract)", () => {
  test("returns the content UNCHANGED when the slug is absent (no insert, no throw)", () => {
    // Source has no match -> no replacement -> original string returned. This
    // is the real behaviour at :491-495: there is no insert branch and no
    // error path. Pin it so a future "helpful" insert-on-missing change is
    // caught as a behavioural break.
    const block = buildBlock();
    const out = setCheckbox(block, "nonexistent-stage", "completed");
    expect(out).toBe(block);
  });

  test("a slug present in text but NOT followed by the em-dash divider is absent for matching purposes", () => {
    // The regex anchors on " <slug> —" (em-dash). A line that names the slug
    // without the em-dash divider (e.g. a hyphen-minus, or no divider) does
    // NOT match, so the call is a no-op. Confirms the divider is load-bearing.
    const hyphenBlock = `- [ ] ideation - EXECUTE`; // ASCII hyphen, not U+2014
    expect(setCheckbox(hyphenBlock, "ideation", "completed")).toBe(hyphenBlock);

    const noDivider = `- [ ] ideation EXECUTE`;
    expect(setCheckbox(noDivider, "ideation", "completed")).toBe(noDivider);
  });

  test("empty content is returned unchanged", () => {
    // Degenerate input: no lines, no match. Must not throw.
    expect(setCheckbox("", "ideation", "completed")).toBe("");
  });
});
