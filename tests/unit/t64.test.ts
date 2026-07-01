// covers: function:parseStageFrontmatter, function:emitStageFrontmatter, function:validateStageFrontmatter
//
// t64 — stage-frontmatter parse/emit round-trip + schema integration.
// Mechanism: none (pure functions, zero I/O, zero LLM, zero tokens).
// Technique: example-based.
//
// In-process migration of tests/unit/t64-stage-parser.sh (TAP plan 45).
// The .sh spawned `bun -e` 7 times (parse_field, parse_catching,
// roundtrip, parse_and_validate, parse_json, plus two inline `bun -e`
// blocks) against inline YAML heredocs. Every assertion exercised one of
// three exported functions and asserted an OBSERVABLE result — a field
// value, a thrown error message, JSON-equality of a round-trip, or a
// VALID/INVALID validator verdict. None of the 45 touched the CLI shell,
// argv parsing, or process.exit, so all 45 port to direct calls with no
// env-seam Bun.spawnSync case retained.
//
// Sources read for this port:
//   dist/claude/.claude/tools/aidlc-lib.ts
//     :882 parseStageFrontmatter(raw: string): Record<string, unknown>
//          throws "parseStageFrontmatter expected string, got <type>" on
//          non-string (:886); throws "Stage file missing YAML frontmatter
//          (---...---)" when the ^---\n...\n--- block is absent (:892).
//     :1154 emitStageFrontmatter(obj): string  — FIELD_ORDER-pinned YAML;
//          quotes scalars matching /[:#]|^\s|\s$/ (:1155).
//     objectListField (:1242) throws "Malformed consumes[] entry ..."
//          (:1286) and "Blank line not allowed inside consumes[] block ..."
//          (:1264).
//   dist/claude/.claude/tools/aidlc-stage-schema.ts
//     :108 validateStageFrontmatter(obj) => { valid, data } | { valid,
//          errors }. "slug must be kebab-case" (:333 via checkSlugPattern),
//          "consumes[i].artifact must be kebab-case" (:196), reserved-key
//          "<key> is reserved (<reason>); not active yet" (:128).
//
// Behavioural-contract note (house style): the .sh asserted observable
// outputs, not implementation. This file does the same — it never
// re-implements the YAML grammar; it pins return values, thrown-error
// substrings, and round-trip JSON-equality exactly as the .sh did.
//
// Parity mapping (.sh assertion text -> test below) is documented inline
// per describe block. 45 old TAP assertions -> 45 expect() calls.

import { describe, expect, test } from "bun:test";
import {
  emitStageFrontmatter,
  parseStageFrontmatter,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { validateStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-stage-schema.ts";

// --- Helpers mirroring the .sh's bun -e wrappers, but in-process. ---

// roundtrip(): the .sh's `roundtrip()` — parse -> emit -> parse, compare
// JSON. Returns "EQ"/"NE" exactly like the shell helper so the parity is
// obvious.
function roundtrip(yaml: string): "EQ" | "NE" {
  const obj1 = parseStageFrontmatter(yaml);
  const yaml2 = emitStageFrontmatter(obj1 as Record<string, unknown>);
  const obj2 = parseStageFrontmatter(yaml2);
  return JSON.stringify(obj1) === JSON.stringify(obj2) ? "EQ" : "NE";
}

// parseAndValidate(): the .sh's `parse_and_validate()` — parse, then run
// the schema validator, returning "VALID" or "INVALID:<errs joined by |>"
// so the assert_contains substrings (e.g. "slug must be kebab-case",
// "must be kebab-case", "<key> is reserved ...") match the same bytes.
function parseAndValidate(yaml: string): string {
  const obj = parseStageFrontmatter(yaml);
  const r = validateStageFrontmatter(obj);
  return r.valid ? "VALID" : `INVALID:${r.errors.join("|")}`;
}

// parseCatching(): the .sh's `parse_catching()` — returns "OK" or
// "ERR:<message>" so thrown-error substring assertions port 1:1.
function parseCatching(yaml: unknown): string {
  try {
    parseStageFrontmatter(yaml as string);
    return "OK";
  } catch (e) {
    return `ERR:${(e as Error).message}`;
  }
}

// --- Fixtures (verbatim from t64-stage-parser.sh heredocs). The .sh
// interpolated each heredoc into a `bun -e` backtick template, so the
// leading `---\n` and exact whitespace are part of the contract. ---

const WORKED = `---
slug: scope-definition
phase: ideation
execution: ALWAYS
condition: Always executes
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-delivery-agent
mode: inline
produces:
  - scope-document
  - intent-backlog
consumes:
  - artifact: intent-statement
    required: true
  - artifact: feasibility-assessment
    required: false
requires_stage:
  - intent-capture
inputs: Intent statement
outputs: aidlc-docs/ideation/scope-definition/scope-document.md
---

# body
`;

const UNCLOSED = `---
slug: test
phase: ideation

# body with no closing delimiter
`;

const MALFORMED_CONSUMES = `---
slug: test
consumes:
  - artifact: foo
    garbage line with no colon
    required: true
---
`;

const SCALAR_FIX = `---
slug: test
phase: ideation
condition: unquoted value with spaces
lead_agent: "aidlc-product-agent"
inputs: value with trailing space
outputs: "aidlc-docs/path/CONDITIONAL: file.md"
support_agents: []
produces: []
consumes: []
requires_stage: []
execution: ALWAYS
mode: inline
---
`;

const QUOTED_TRUE = `---
slug: test
phase: ideation
execution: ALWAYS
condition: "true"
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces: []
consumes: []
requires_stage: []
inputs: a
outputs: b
---
`;

const FLOW_EMPTY = `---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
requires_stage: []
consumes: []
inputs: a
outputs: b
---
`;

const POP_LIST = `---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents:
  - a
  - b
  - c
produces: []
requires_stage: []
consumes: []
inputs: a
outputs: b
---
`;

const ZERO_ITEMS = `---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
consumes: []
requires_stage: []
inputs: a
outputs: b
---
`;

const SINGLE_CONSUME = `---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
requires_stage: []
consumes:
  - artifact: one-artifact
    required: true
inputs: a
outputs: b
---
`;

const MULTI_CONSUME = `---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
requires_stage: []
consumes:
  - artifact: first
    required: true
  - artifact: second
    required: false
    conditional_on: brownfield
inputs: a
outputs: b
---
`;

const TRAIL_NO_NL = `---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces: []
requires_stage: []
inputs: a
outputs: b
consumes:
  - artifact: foo
    required: true
  - artifact: bar
    required: false
---
`;

const ALL_ABSENT = `---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
inputs: a
outputs: b
---
`;

const BOOL_TRUE = `---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
requires_stage: []
consumes:
  - artifact: foo
    required: true
inputs: a
outputs: b
---
`;

const BOOL_FALSE = `---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
requires_stage: []
consumes:
  - artifact: foo
    required: false
inputs: a
outputs: b
---
`;

const FOR_EACH = `---
slug: test
phase: construction
execution: ALWAYS
condition: x
lead_agent: aidlc-developer-agent
mode: inline
for_each: unit-of-work
support_agents: []
produces: []
requires_stage: []
consumes: []
inputs: a
outputs: b
---
`;

const FULL = `---
slug: test
phase: construction
execution: CONDITIONAL
condition: x
lead_agent: aidlc-developer-agent
mode: subagent
for_each: unit-of-work
support_agents:
  - aidlc-quality-agent
produces:
  - code
consumes:
  - artifact: design
    required: true
    conditional_on: greenfield
requires_stage:
  - functional-design
inputs: a
outputs: b
---
`;

const COLON_SCALAR = `---
slug: test
phase: construction
execution: ALWAYS
condition: x
lead_agent: aidlc-developer-agent
support_agents: []
mode: inline
produces: []
consumes: []
requires_stage: []
inputs: some: prefix
outputs: "aidlc-docs/CONDITIONAL: file.md"
---
`;

const BAD_SLUG = `---
slug: Test-Stage
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
consumes: []
requires_stage: []
inputs: a
outputs: b
---
`;

const BAD_ARTIFACT = `---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
consumes:
  - artifact: BadArtifact
    required: true
requires_stage: []
inputs: a
outputs: b
---
`;

// reserved_passthrough(): the .sh built this fixture per-key with the
// reserved key appended just before the closing ---.
function reservedPassthrough(key: string): string {
  const fix = `---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
consumes: []
requires_stage: []
inputs: a
outputs: b
${key}: some-value
---
`;
  return parseAndValidate(fix);
}

const BLANK_IN_CONSUMES = `---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
requires_stage: []
inputs: a
outputs: b
consumes:
  - artifact: foo
    required: true

  - artifact: bar
    required: false
---
`;

const EMPTY_SCALAR = `---
slug: test
phase: ideation
execution: ALWAYS
condition: ""
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
consumes: []
requires_stage: []
inputs: a
outputs: b
---
`;

// Reviewer-bearing stage — `reviewer` is a string, `reviewer_max_iterations`
// is authored as an unquoted integer (the canonical on-disk form). Exercises
// V1: the parser coerces the cap to a NUMBER, and the emitter round-trips it
// as an unquoted number.
const REVIEWER = `---
slug: test
phase: inception
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
reviewer: aidlc-product-lead-agent
reviewer_max_iterations: 2
support_agents: []
produces: []
consumes: []
requires_stage: []
inputs: a
outputs: b
---
`;

// ============================================================
// Positive baseline (.sh assertions 1-6)
// ============================================================
describe("worked example parses each field", () => {
  const obj = parseStageFrontmatter(WORKED) as Record<string, unknown>;

  test("slug -> scope-definition", () => {
    // .sh: "worked example → slug"
    expect(obj.slug).toBe("scope-definition");
  });

  test("phase -> ideation", () => {
    // .sh: "worked example → phase"
    expect(obj.phase).toBe("ideation");
  });

  test("execution -> ALWAYS", () => {
    // .sh: "worked example → execution"
    expect(obj.execution).toBe("ALWAYS");
  });

  test("produces length -> 2", () => {
    // .sh: "worked example → produces length"
    expect((obj.produces as unknown[]).length).toBe(2);
  });

  test("consumes length -> 2", () => {
    // .sh: "worked example → consumes length"
    expect((obj.consumes as unknown[]).length).toBe(2);
  });

  test("consumes[0].required is boolean true", () => {
    // .sh: "worked example → consumes[0].required is boolean true"
    // The .sh stringified `obj.consumes[0].required` and compared to the
    // string "true"; here we pin the stronger contract — actual boolean.
    const entry = (obj.consumes as Array<Record<string, unknown>>)[0];
    expect(entry.required).toBe(true);
  });
});

// ============================================================
// Missing frontmatter (.sh assertion 7)
// ============================================================
describe("missing frontmatter", () => {
  test("no --- throws clear 'missing YAML frontmatter' error", () => {
    // .sh: assert_contains parse_catching "no frontmatter here"
    //      "missing YAML frontmatter"
    expect(parseCatching("no frontmatter here")).toContain(
      "missing YAML frontmatter"
    );
  });
});

// ============================================================
// Malformed frontmatter (.sh assertions 8-9)
// ============================================================
describe("malformed frontmatter", () => {
  test("unclosed frontmatter throws 'missing YAML frontmatter'", () => {
    // .sh: "unclosed frontmatter throws"
    expect(parseCatching(UNCLOSED)).toContain("missing YAML frontmatter");
  });

  test("malformed consumes line throws 'Malformed consumes'", () => {
    // .sh: "malformed consumes line throws"
    expect(parseCatching(MALFORMED_CONSUMES)).toContain("Malformed consumes");
  });
});

// ============================================================
// Scalar parsing (.sh assertions 10-14)
// ============================================================
describe("scalar parsing", () => {
  test("unquoted scalar with spaces", () => {
    // .sh: "unquoted scalar with spaces"
    const obj = parseStageFrontmatter(SCALAR_FIX) as Record<string, unknown>;
    expect(obj.condition).toBe("unquoted value with spaces");
  });

  test("double-quoted scalar strips quotes", () => {
    // .sh: "double-quoted scalar strips quotes"
    const obj = parseStageFrontmatter(SCALAR_FIX) as Record<string, unknown>;
    expect(obj.lead_agent).toBe("aidlc-product-agent");
  });

  test("scalar containing colon parses when quoted", () => {
    // .sh: "scalar containing colon parses when quoted"
    const obj = parseStageFrontmatter(SCALAR_FIX) as Record<string, unknown>;
    expect(obj.outputs).toBe("aidlc-docs/path/CONDITIONAL: file.md");
  });

  test('quoted "true" in scalar stays string type', () => {
    // .sh: 'quoted "true" in scalar stays string type'
    const obj = parseStageFrontmatter(QUOTED_TRUE) as Record<string, unknown>;
    expect(typeof obj.condition).toBe("string");
  });

  test('quoted "true" scalar value', () => {
    // .sh: 'quoted "true" scalar value'
    const obj = parseStageFrontmatter(QUOTED_TRUE) as Record<string, unknown>;
    expect(obj.condition).toBe("true");
  });
});

// ============================================================
// List parsing (.sh assertions 15-17)
// ============================================================
describe("list parsing", () => {
  test("flow-form empty list -> length 0", () => {
    // .sh: "flow-form empty list → length 0"
    const obj = parseStageFrontmatter(FLOW_EMPTY) as Record<string, unknown>;
    expect((obj.produces as unknown[]).length).toBe(0);
  });

  test("populated list -> length 3", () => {
    // .sh: "populated list → length 3"
    const obj = parseStageFrontmatter(POP_LIST) as Record<string, unknown>;
    expect((obj.support_agents as unknown[]).length).toBe(3);
  });

  test("absent required list -> [] (empty array, present)", () => {
    // .sh: "absent required list → [] (empty array, present)"
    // Stringified "true:0" in the .sh; here split into the two facts.
    const obj = parseStageFrontmatter(ZERO_ITEMS) as Record<string, unknown>;
    expect(Array.isArray(obj.produces)).toBe(true);
    expect((obj.produces as unknown[]).length).toBe(0);
  });
});

// ============================================================
// Nested-object list consumes[] (.sh assertions 18-21)
// ============================================================
describe("nested-object list consumes[]", () => {
  test("single consumes[] entry -> artifact", () => {
    // .sh: "single consumes[] entry → artifact"
    const obj = parseStageFrontmatter(SINGLE_CONSUME) as Record<string, unknown>;
    const entry = (obj.consumes as Array<Record<string, unknown>>)[0];
    expect(entry.artifact).toBe("one-artifact");
  });

  test("multi-entry consumes[]", () => {
    // .sh: "multi-entry consumes[]"
    const obj = parseStageFrontmatter(MULTI_CONSUME) as Record<string, unknown>;
    expect((obj.consumes as unknown[]).length).toBe(2);
  });

  test("conditional_on present", () => {
    // .sh: "conditional_on present"
    const obj = parseStageFrontmatter(MULTI_CONSUME) as Record<string, unknown>;
    const entry = (obj.consumes as Array<Record<string, unknown>>)[1];
    expect(entry.conditional_on).toBe("brownfield");
  });

  test("trailing-no-newline: last required: line captured", () => {
    // .sh: "trailing-no-newline: last required: line captured"
    // consumes is the LAST key, so the extractor strips the newline before
    // the closing ---; the parser's `(?:\r?\n|$)` must still capture the
    // final `required: false`.
    const obj = parseStageFrontmatter(TRAIL_NO_NL) as Record<string, unknown>;
    const entry = (obj.consumes as Array<Record<string, unknown>>)[1];
    expect(entry.required).toBe(false);
  });
});

// ============================================================
// Required-field presence guarantees (.sh assertions 22-25)
// ============================================================
describe("required-field presence guarantees", () => {
  const obj = parseStageFrontmatter(ALL_ABSENT) as Record<string, unknown>;

  test("support_agents absent -> array []", () => {
    // .sh: "support_agents absent → array []"
    expect(Array.isArray(obj.support_agents)).toBe(true);
  });

  test("produces absent -> array []", () => {
    // .sh: "produces absent → array []"
    expect(Array.isArray(obj.produces)).toBe(true);
  });

  test("requires_stage absent -> array []", () => {
    // .sh: "requires_stage absent → array []"
    expect(Array.isArray(obj.requires_stage)).toBe(true);
  });

  test("consumes absent -> array []", () => {
    // .sh: "consumes absent → array []"
    expect(Array.isArray(obj.consumes)).toBe(true);
  });
});

// ============================================================
// Boolean coercion in consumes[].required (.sh assertions 26-27)
// ============================================================
describe("boolean coercion in consumes[].required", () => {
  test("required: true -> boolean type", () => {
    // .sh: "required: true → boolean type"
    const obj = parseStageFrontmatter(BOOL_TRUE) as Record<string, unknown>;
    const entry = (obj.consumes as Array<Record<string, unknown>>)[0];
    expect(typeof entry.required).toBe("boolean");
  });

  test("required: false -> boolean false", () => {
    // .sh: "required: false → boolean false"
    const obj = parseStageFrontmatter(BOOL_FALSE) as Record<string, unknown>;
    const entry = (obj.consumes as Array<Record<string, unknown>>)[0];
    expect(entry.required).toBe(false);
  });
});

// ============================================================
// Optional for_each (.sh assertions 28-29)
// ============================================================
describe("optional for_each", () => {
  test("for_each present -> value", () => {
    // .sh: "for_each present → value"
    const obj = parseStageFrontmatter(FOR_EACH) as Record<string, unknown>;
    expect(obj.for_each).toBe("unit-of-work");
  });

  test("for_each absent -> key not in object", () => {
    // .sh: "for_each absent → key not in object"
    const obj = parseStageFrontmatter(ALL_ABSENT) as Record<string, unknown>;
    expect("for_each" in obj).toBe(false);
  });
});

// ============================================================
// Round-trip (.sh assertions 30-33)
// ============================================================
describe("round-trip parse -> emit -> parse", () => {
  test("minimal (no optional) -> EQ", () => {
    // .sh: "round-trip: minimal (no optional)"
    expect(roundtrip(ALL_ABSENT)).toBe("EQ");
  });

  test("full (for_each + conditional_on) -> EQ", () => {
    // .sh: "round-trip: full (for_each + conditional_on)"
    expect(roundtrip(FULL)).toBe("EQ");
  });

  test("colon in scalar -> EQ", () => {
    // .sh: "round-trip: colon in scalar"
    expect(roundtrip(COLON_SCALAR)).toBe("EQ");
  });

  test("empty lists -> EQ", () => {
    // .sh: "round-trip: empty lists"
    expect(roundtrip(FLOW_EMPTY)).toBe("EQ");
  });

  // V1: reviewer-bearing stage round-trips with the cap as a NUMBER.
  test("reviewer + numeric cap -> EQ", () => {
    expect(roundtrip(REVIEWER)).toBe("EQ");
  });
});

// ============================================================
// Reviewer field parse/emit (V1) — reviewer_max_iterations is the one
// numeric scalar field: the parser returns it as a NUMBER (not the string
// "2"), and the emitter writes it back as an unquoted number that re-parses
// to the same number.
// ============================================================
describe("reviewer fields parse/emit (V1)", () => {
  test("reviewer_max_iterations parses to a number", () => {
    const obj = parseStageFrontmatter(REVIEWER) as Record<string, unknown>;
    expect(typeof obj.reviewer_max_iterations).toBe("number");
    expect(obj.reviewer_max_iterations).toBe(2);
  });

  test("reviewer stays a string", () => {
    const obj = parseStageFrontmatter(REVIEWER) as Record<string, unknown>;
    expect(typeof obj.reviewer).toBe("string");
    expect(obj.reviewer).toBe("aidlc-product-lead-agent");
  });

  test("emitted cap is an unquoted number that re-parses as a number", () => {
    const obj = parseStageFrontmatter(REVIEWER) as Record<string, unknown>;
    const yaml = emitStageFrontmatter(obj);
    // Canonical on-disk form: unquoted integer, no surrounding quotes.
    expect(yaml).toContain("reviewer_max_iterations: 2\n");
    const reparsed = parseStageFrontmatter(yaml) as Record<string, unknown>;
    expect(typeof reparsed.reviewer_max_iterations).toBe("number");
    expect(reparsed.reviewer_max_iterations).toBe(2);
  });
});

// ============================================================
// Schema integration (.sh assertions 34-35)
// ============================================================
describe("schema integration (parse -> validate)", () => {
  test("worked example -> VALID", () => {
    // .sh: "worked example: parse → validate = VALID"
    expect(parseAndValidate(WORKED)).toBe("VALID");
  });

  test("full fixture -> VALID", () => {
    // .sh: "full fixture: parse → validate = VALID"
    expect(parseAndValidate(FULL)).toBe("VALID");
  });
});

// ============================================================
// Shape regressions (.sh assertions 36-37)
// ============================================================
describe("shape regressions via parse -> validate chain", () => {
  test("bad slug rejected ('slug must be kebab-case')", () => {
    // .sh: "bad slug rejected via parse→validate chain"
    expect(parseAndValidate(BAD_SLUG)).toContain("slug must be kebab-case");
  });

  test("bad artifact name rejected ('must be kebab-case')", () => {
    // .sh: "bad artifact name rejected via chain"
    expect(parseAndValidate(BAD_ARTIFACT)).toContain("must be kebab-case");
  });
});

// ============================================================
// Reserved-key passthrough (.sh assertions 38-42)
// ============================================================
describe("reserved-key passthrough (parser keeps key, validator rejects)", () => {
  // `when` is NO LONGER reserved — it became an active structured activation
  // predicate (plugin mechanism, Layer 4). Its shape validation lives in t62;
  // it is deliberately absent from the reserved-passthrough set here.

  test("on_failure", () => {
    // .sh: "reserved: on_failure"
    expect(reservedPassthrough("on_failure")).toContain(
      "on_failure is reserved (loop driver); not active yet"
    );
  });

  test("blocks_on", () => {
    // .sh: "reserved: blocks_on"
    expect(reservedPassthrough("blocks_on")).toContain(
      "blocks_on is reserved (construction worktrees); not active yet"
    );
  });

  test("timeout", () => {
    // .sh: "reserved: timeout"
    expect(reservedPassthrough("timeout")).toContain(
      "timeout is reserved (sensor binding); not active yet"
    );
  });

  test("retry", () => {
    // .sh: "reserved: retry"
    expect(reservedPassthrough("retry")).toContain(
      "retry is reserved (loop driver); not active yet"
    );
  });
});

// ============================================================
// Adversarial edge cases (.sh assertions 43-45)
// ============================================================
describe("adversarial edge cases", () => {
  test("non-string input -> clean 'expected string' error", () => {
    // .sh: inline `bun -e` calling parseStageFrontmatter(undefined),
    //      assert_contains OUT "expected string". Ported in-process: the
    //      type-guard throw is pure logic, not the CLI shell, so it stays
    //      an in-process call (NOT a Bun.spawnSync env-seam case).
    expect(parseCatching(undefined)).toContain("expected string");
  });

  test("blank line inside consumes[] throws 'Blank line not allowed'", () => {
    // .sh: "blank line inside consumes[] throws"
    expect(parseCatching(BLANK_IN_CONSUMES)).toContain("Blank line not allowed");
  });

  test("empty-string scalar value reaches object", () => {
    // .sh: "empty-string scalar value reaches object" — the .sh checked
    //      `'condition' in obj ? 'PRESENT' : 'MISSING'` === "PRESENT".
    const obj = parseStageFrontmatter(EMPTY_SCALAR) as Record<string, unknown>;
    expect("condition" in obj).toBe(true);
  });
});
