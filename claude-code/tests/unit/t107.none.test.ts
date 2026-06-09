// covers: function:parseCheckboxes
//
// t107 — property-based floor test for parseCheckboxes() in
// dist/claude/.claude/tools/aidlc-lib.ts:449.
//
// WHY THIS EXISTS. parseCheckboxes drives every checkbox state transition
// in the orchestrator (countCheckboxes, the state-table render at
// lib.ts:1345, and indirectly setCheckbox round-trips). Its contract is a
// single regex — /^- \[([ xSR?-])\] (\S+)\s*—\s*(.*)$/gm — coupled to the
// CHECKBOX_MAP marker table at lib.ts:50. That coupling is never unit-tested
// today: if the regex marker class and CHECKBOX_MAP drift apart, a state
// silently stops parsing and a stage's progress is mis-counted with no error.
//
// TEST DESIGN (matches the house note in tests/unit/t69-worktree-path.sh):
// assert OBSERVABLE CONTRACTS, never implementation parity. We do NOT
// re-implement the regex — a test that reconstructs the parser only catches
// deletion. Instead we DRIVE generated lines from the real CHECKBOX_MAP, then
// assert parseCheckboxes recovers (state, slug, suffix) for each, in document
// order, and that garbage / degraded / non-checkbox lines are IGNORED. Adding
// a marker to CHECKBOX_MAP automatically extends the generation, so the suite
// stays honest as the marker set grows.

import { describe, expect, test } from "bun:test";
import {
  CHECKBOX_MAP,
  type CheckboxState,
  parseCheckboxes,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// The em-dash separator the regex requires: U+2014 (bytes e2 80 94),
// confirmed against aidlc-lib.ts:451. Spelled out so a literal swap to a
// hyphen-minus in the source would surface here.
const EMDASH = "—";
expect(EMDASH).toBe("—");

// Markers come from the production table, not a local copy. Every CHECKBOX_MAP
// value is the bracketed form "[c]"; the regex captures the inner char c via
// the class [ xSR?-]. We extract c here so generation and the source stay
// joined at the hip.
const STATES = Object.keys(CHECKBOX_MAP) as CheckboxState[];
const innerMarker = (state: CheckboxState): string => {
  const m = CHECKBOX_MAP[state]; // e.g. "[x]"
  return m.slice(1, -1); // e.g. "x"  (space for pending)
};

// A deterministic, seedable PRNG so failures are reproducible. (Property-based
// here means "many generated cases", not "needs an external fuzz lib".)
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

// Slug must be \S+ and must not contain the em-dash (it is non-whitespace, so
// a greedy \S+ would swallow it). We build slugs from a separator-free
// alphabet drawn from real stage-slug shape: lowercase, digits, hyphen, dot,
// underscore, slash (slugs like "bolt-1", "2.1", "a/b" all occur in the repo).
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789-._/";
function randomSlug(rng: () => number): string {
  const len = 1 + Math.floor(rng() * 24);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += SLUG_ALPHABET[Math.floor(rng() * SLUG_ALPHABET.length)];
  }
  return out;
}

// Suffix is .* then .trim()'d by the parser. We generate NON-EMPTY suffixes
// with no leading/trailing whitespace (so the expected value equals the
// input), allowing interior spaces and an em-dash, mirroring
// "SKIP: reason — detail". Non-empty is deliberate: the parser's separator is
// \s*—\s*, and JS \s matches \n, so an empty/whitespace-only suffix lets the
// trailing \s* swallow the newline and merge the FOLLOWING line into the
// suffix. That newline-swallowing quirk is pinned by its own test below;
// here we generate the realistic case where EXECUTE/SKIP always carry text.
const SUFFIX_WORDS = [
  "EXECUTE",
  "SKIP",
  "SKIP: out of scope",
  "EXECUTE — bolt 1",
  "awaiting product sign-off",
  "regenerated after revision",
];
function randomSuffix(rng: () => number): string {
  return SUFFIX_WORDS[Math.floor(rng() * SUFFIX_WORDS.length)];
}

function lineFor(state: CheckboxState, slug: string, suffix: string): string {
  // Exactly the shape the regex accepts: "- " + "[c]" + " " + slug + " — " + suffix
  return `- ${CHECKBOX_MAP[state]} ${slug} ${EMDASH} ${suffix}`;
}

describe("parseCheckboxes — regex/CHECKBOX_MAP coupling guard", () => {
  test("every CHECKBOX_MAP marker is a bracketed single char inside the regex class [ xSR?-]", () => {
    // The parser regex hardcodes the marker class. If a future state is added
    // to CHECKBOX_MAP with a marker char outside this class, lines for that
    // state would silently fail to parse. This guard fails loudly instead.
    const REGEX_CLASS = new Set([" ", "x", "S", "R", "?", "-"]);
    for (const state of STATES) {
      const marker = CHECKBOX_MAP[state];
      expect(marker.startsWith("[")).toBe(true);
      expect(marker.endsWith("]")).toBe(true);
      const inner = innerMarker(state);
      expect(inner.length).toBe(1);
      expect(REGEX_CLASS.has(inner)).toBe(true);
    }
  });

  test("the six known states map to their documented markers", () => {
    // Pins the literal table at lib.ts:50-57. Catches a marker swap that the
    // coupling guard alone would miss (a swap that stays inside the class).
    expect(CHECKBOX_MAP).toMatchObject({
      pending: "[ ]",
      "in-progress": "[-]",
      "awaiting-approval": "[?]",
      revising: "[R]",
      completed: "[x]",
      skipped: "[S]",
    });
  });
});

describe("parseCheckboxes — round-trip per marker", () => {
  test("each CHECKBOX_MAP state round-trips through a generated line", () => {
    // Drive directly off the production marker table: one valid line per
    // state, recover state + slug + suffix verbatim. Adding a marker to
    // CHECKBOX_MAP extends this loop automatically.
    for (const state of STATES) {
      const slug = `stage-${state}`;
      const suffix = "EXECUTE";
      const parsed = parseCheckboxes(lineFor(state, slug, suffix));
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual({ slug, state, suffix });
    }
  });
});

describe("parseCheckboxes — property-based bulk recovery", () => {
  test("recovers state+slug+suffix for N random valid lines, in document order", () => {
    const rng = makeRng(0xC0FFEE);
    const N = 400;
    type Expected = { slug: string; state: CheckboxState; suffix: string };
    const expected: Expected[] = [];
    const lines: string[] = [];

    for (let i = 0; i < N; i++) {
      const state = STATES[Math.floor(rng() * STATES.length)];
      const slug = randomSlug(rng);
      const suffix = randomSuffix(rng);
      expected.push({ slug, state, suffix });
      lines.push(lineFor(state, slug, suffix));
    }

    const content = lines.join("\n");
    const parsed = parseCheckboxes(content);

    // Every generated checkbox line must come back, in order, intact.
    expect(parsed).toHaveLength(N);
    expect(parsed).toEqual(expected);
  });

  test("suffix surrounding whitespace is trimmed (contract: match[3].trim())", () => {
    // The parser trims the captured suffix. Feed padded suffixes and assert
    // the recovered value is trimmed. This pins lib.ts:478's .trim().
    const slug = "padded-stage";
    const content =
      `- ${CHECKBOX_MAP.completed} ${slug} ${EMDASH}    spaced reason   \n` +
      `- ${CHECKBOX_MAP.pending} ${slug}2 ${EMDASH}\tEXECUTE\t`;
    const parsed = parseCheckboxes(content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      slug,
      state: "completed",
      suffix: "spaced reason",
    });
    expect(parsed[1]).toEqual({
      slug: `${slug}2`,
      state: "pending",
      suffix: "EXECUTE",
    });
  });

  test("flexible whitespace around the em-dash separator (\\s*—\\s*) still parses", () => {
    // The regex separator is \s*—\s*, so zero or many spaces on either side
    // are valid. Assert the slug and suffix are still cleanly recovered.
    const tight = `- ${CHECKBOX_MAP.skipped} slug-a${EMDASH}reason-a`;
    const loose = `- ${CHECKBOX_MAP.revising} slug-b     ${EMDASH}     reason-b`;
    const parsed = parseCheckboxes(`${tight}\n${loose}`);
    expect(parsed).toEqual([
      { slug: "slug-a", state: "skipped", suffix: "reason-a" },
      { slug: "slug-b", state: "revising", suffix: "reason-b" },
    ]);
  });
});

describe("parseCheckboxes — garbage and degraded lines are IGNORED", () => {
  test("non-checkbox and malformed lines are skipped, valid ones still recovered", () => {
    // Each entry pairs a line with whether parseCheckboxes should emit a row.
    // Build a document interleaving valid lines with every flavour of junk we
    // can think of; assert ONLY the valid lines come back, in order.
    const NOISE: string[] = [
      "", // blank line
      "## A markdown heading", // heading
      "Just a sentence with — an em-dash but no checkbox.", // prose w/ em-dash
      "- not a checkbox at all", // dash bullet, no brackets
      "- [x] missing-emdash-separator EXECUTE", // no em-dash → not matched
      `- [z] bad-marker ${EMDASH} EXECUTE`, // marker outside class
      `- [] empty-bracket ${EMDASH} EXECUTE`, // empty marker (needs 1 char)
      `- [xx] double-marker ${EMDASH} EXECUTE`, // two chars in bracket
      `  - [x] indented-stage ${EMDASH} EXECUTE`, // leading space → ^ fails
      `- [x]nospace-after-bracket ${EMDASH} EXECUTE`, // missing space after ]
      `- [x] ${EMDASH} no-slug`, // slug is \S+ → empty slug fails
      `* [x] wrong-bullet ${EMDASH} EXECUTE`, // asterisk bullet, not "- "
      `-[x] no-space-after-dash ${EMDASH} EXECUTE`, // "- " literal missing
      `random [x] mid-line-marker ${EMDASH} EXECUTE`, // not at line start
    ];

    const valids: Array<{ slug: string; state: CheckboxState; suffix: string }> =
      [
        { slug: "first-good", state: "completed", suffix: "EXECUTE" },
        { slug: "second-good", state: "skipped", suffix: "SKIP: reason" },
        // Non-empty suffix on purpose: an empty suffix would let the
        // separator's trailing \s* swallow the following line's newline and
        // merge it in (pinned by the newline-swallowing test below). Realistic
        // state lines always carry a suffix.
        { slug: "third-good", state: "in-progress", suffix: "in flight" },
      ];

    // Interleave: noise, valid, noise, valid, noise, valid, noise...
    const doc: string[] = [];
    let vi = 0;
    for (let i = 0; i < NOISE.length; i++) {
      doc.push(NOISE[i]);
      if (vi < valids.length && i % 4 === 1) {
        const v = valids[vi++];
        doc.push(lineFor(v.state, v.slug, v.suffix));
      }
    }
    // Push any remaining valids at the end so all three are present.
    while (vi < valids.length) {
      const v = valids[vi++];
      doc.push(lineFor(v.state, v.slug, v.suffix));
    }

    const parsed = parseCheckboxes(doc.join("\n"));
    expect(parsed).toEqual(valids);
  });

  test("a document of pure garbage yields zero rows", () => {
    const garbage = [
      "- [ ] no-emdash here",
      `[x] missing-leading-dash ${EMDASH} x`,
      `- ( ) wrong-bracket-shape ${EMDASH} x`,
      "plain text",
      "",
      `#### heading ${EMDASH} heading`,
    ].join("\n");
    expect(parseCheckboxes(garbage)).toEqual([]);
  });

  test("empty input yields zero rows", () => {
    expect(parseCheckboxes("")).toEqual([]);
  });

  test("a whitespace-only suffix swallows the following line's newline (documents \\s*—\\s* greediness)", () => {
    // CONTRACT QUIRK, pinned deliberately. The separator is \s*—\s* and in
    // JavaScript \s matches \n. So when the suffix is empty/whitespace, the
    // trailing \s* eats the line break and the (.*) capture continues onto the
    // NEXT line — merging it into the suffix and DROPPING it as its own row.
    // Callers must therefore give every state line a non-empty suffix
    // (EXECUTE / SKIP: reason / ...). If the regex were tightened to stop at a
    // line boundary, this assertion flags the behaviour change for review.
    const content =
      `- ${CHECKBOX_MAP.completed} alpha ${EMDASH} \n` +
      `- ${CHECKBOX_MAP.pending} beta ${EMDASH} EXECUTE`;
    const parsed = parseCheckboxes(content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].slug).toBe("alpha");
    expect(parsed[0].state).toBe("completed");
    // The whole following line is absorbed as alpha's suffix.
    expect(parsed[0].suffix).toBe(
      `- ${CHECKBOX_MAP.pending} beta ${EMDASH} EXECUTE`
    );
  });

  test("an empty suffix at end-of-document parses cleanly as an empty string", () => {
    // The mirror image of the swallowing quirk: with no following line, the
    // trailing \s* has nothing to eat, so an empty suffix is recovered as "".
    expect(parseCheckboxes(`- ${CHECKBOX_MAP.completed} omega ${EMDASH} `)).toEqual([
      { slug: "omega", state: "completed", suffix: "" },
    ]);
    expect(parseCheckboxes(`- ${CHECKBOX_MAP["in-progress"]} omega ${EMDASH}`)).toEqual([
      { slug: "omega", state: "in-progress", suffix: "" },
    ]);
  });

  test("a slug containing an em-dash is consumed greedily and shifts the separator (documents \\S+ behaviour)", () => {
    // \S+ is greedy and the em-dash is non-whitespace. A slug literally
    // containing "—" makes the parser treat the LAST em-dash as the
    // separator. We assert the observed, documented behaviour rather than an
    // idealised one — this is the contract callers must respect (slugs are
    // separator-free in practice). If the regex changed to forbid this, the
    // assertion would flag it for review.
    const line = `- ${CHECKBOX_MAP.pending} a${EMDASH}b ${EMDASH} EXECUTE`;
    const parsed = parseCheckboxes(line);
    expect(parsed).toHaveLength(1);
    // Greedy \S+ swallows "a—b"; the second em-dash becomes the separator.
    expect(parsed[0].slug).toBe(`a${EMDASH}b`);
    expect(parsed[0].state).toBe("pending");
    expect(parsed[0].suffix).toBe("EXECUTE");
  });
});
