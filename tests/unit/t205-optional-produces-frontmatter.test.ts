// covers: function:parseStageFrontmatter, function:emitStageFrontmatter, function:validateStageFrontmatter, function:artifactsRegistry, function:producersOf
//
// t205 - the `optional_produces` stage-frontmatter key: parse, emit,
// validate, and compile-carry-through.
// Mechanism: none (pure functions + a read of the shipped stage-graph.json).
// Technique: example-based.
//
// optional_produces names artifacts a stage MAY write per unit (the stage body
// marks them CONDITIONAL). It is a plain kebab string list, parallel to
// produces:, and is exempt from the per-unit coverage check in
// aidlc-orchestrate.ts unitCovered (behaviour proven in t206). Here we pin the
// FRONTMATTER contract:
//   - parse: present -> array value; absent -> key not on the object (mirrors
//     for_each, so only annotated stages carry it and the compiled JSON stays
//     minimal).
//   - emit: round-trips (parse -> emit -> parse EQ) and places the key directly
//     after produces:.
//   - validate: a valid kebab list passes; a non-kebab entry is rejected with
//     the field-named error; the unknown-key rule does NOT fire for the key.
//   - compile: the SHIPPED graph carries optional_produces on exactly the two
//     annotated Construction stages (functional-design, infrastructure-design)
//     and their produces[] no longer lists the conditional artifact.
//   - registry: artifactsRegistry() still contains both conditional names and
//     producersOf resolves them to their producer stage (the union keeps the
//     vocabulary whole; t66's 122-artifact pin depends on it).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  artifactsRegistry,
  loadGraph,
  producersOf,
  __resetGraphCache,
} from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import {
  emitStageFrontmatter,
  parseStageFrontmatter,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { validateStageFrontmatter } from "../../dist/claude/.claude/tools/aidlc-stage-schema.ts";

// A complete, valid stage frontmatter that DECLARES optional_produces. Shaped
// like the worked example in t64: every required field present so the only
// axis under test is optional_produces.
const WITH_OPTIONAL = `---
slug: functional-design
phase: construction
execution: CONDITIONAL
condition: x
lead_agent: aidlc-architect-agent
support_agents: []
mode: inline
for_each: unit-of-work
produces:
  - business-logic-model
  - business-rules
optional_produces:
  - frontend-components
consumes: []
requires_stage: []
inputs: a
outputs: b
---

# body
`;

// The same stage with NO optional_produces key at all.
const WITHOUT_OPTIONAL = `---
slug: functional-design
phase: construction
execution: CONDITIONAL
condition: x
lead_agent: aidlc-architect-agent
support_agents: []
mode: inline
produces:
  - business-logic-model
consumes: []
requires_stage: []
inputs: a
outputs: b
---

# body
`;

// A non-kebab optional_produces entry (uppercase) - must be rejected.
const BAD_OPTIONAL = `---
slug: functional-design
phase: construction
execution: CONDITIONAL
condition: x
lead_agent: aidlc-architect-agent
support_agents: []
mode: inline
produces:
  - business-logic-model
optional_produces:
  - FrontendComponents
consumes: []
requires_stage: []
inputs: a
outputs: b
---

# body
`;

function parseAndValidate(yaml: string): string {
  const obj = parseStageFrontmatter(yaml);
  const r = validateStageFrontmatter(obj);
  return r.valid ? "VALID" : `INVALID:${r.errors.join("|")}`;
}

describe("t205 optional_produces frontmatter", () => {
  describe("parse", () => {
    test("present -> array value", () => {
      const obj = parseStageFrontmatter(WITH_OPTIONAL) as Record<string, unknown>;
      expect(obj.optional_produces).toEqual(["frontend-components"]);
    });

    test("absent -> key not in object (mirrors for_each)", () => {
      const obj = parseStageFrontmatter(WITHOUT_OPTIONAL) as Record<string, unknown>;
      expect("optional_produces" in obj).toBe(false);
    });

    test("the produces: block does not leak into optional_produces and vice versa", () => {
      const obj = parseStageFrontmatter(WITH_OPTIONAL) as Record<string, unknown>;
      // No prefix collision: produces keeps only its own entries.
      expect(obj.produces).toEqual(["business-logic-model", "business-rules"]);
      expect(obj.optional_produces).toEqual(["frontend-components"]);
    });
  });

  describe("emit / round-trip", () => {
    test("parse -> emit -> parse is EQ with optional_produces present", () => {
      const obj1 = parseStageFrontmatter(WITH_OPTIONAL);
      const yaml2 = emitStageFrontmatter(obj1 as Record<string, unknown>);
      const obj2 = parseStageFrontmatter(yaml2);
      expect(JSON.stringify(obj1)).toBe(JSON.stringify(obj2));
    });

    test("parse -> emit -> parse is EQ when the key is absent (stays absent)", () => {
      const obj1 = parseStageFrontmatter(WITHOUT_OPTIONAL);
      const yaml2 = emitStageFrontmatter(obj1 as Record<string, unknown>);
      const obj2 = parseStageFrontmatter(yaml2);
      expect("optional_produces" in (obj2 as Record<string, unknown>)).toBe(false);
      expect(JSON.stringify(obj1)).toBe(JSON.stringify(obj2));
    });

    test("emitted YAML places optional_produces after produces", () => {
      const yaml = emitStageFrontmatter(
        parseStageFrontmatter(WITH_OPTIONAL) as Record<string, unknown>,
      );
      const producesIdx = yaml.indexOf("\nproduces:");
      const optionalIdx = yaml.indexOf("\noptional_produces:");
      expect(producesIdx).toBeGreaterThan(-1);
      expect(optionalIdx).toBeGreaterThan(producesIdx);
    });
  });

  describe("validate", () => {
    test("a valid kebab list passes", () => {
      expect(parseAndValidate(WITH_OPTIONAL)).toBe("VALID");
    });

    test("absent key still validates", () => {
      expect(parseAndValidate(WITHOUT_OPTIONAL)).toBe("VALID");
    });

    test("a non-kebab entry is rejected with the field-named error", () => {
      const r = parseAndValidate(BAD_OPTIONAL);
      expect(r).toContain("optional_produces[0] must be kebab-case");
    });

    test("the unknown-key rule does NOT fire for optional_produces", () => {
      const r = parseAndValidate(WITH_OPTIONAL);
      expect(r).not.toContain("unknown key: optional_produces");
    });
  });

  describe("compile carry-through (shipped graph)", () => {
    beforeEach(() => {
      __resetGraphCache();
    });
    afterEach(() => {
      __resetGraphCache();
    });

    test("functional-design carries optional_produces and drops it from produces", () => {
      const fd = loadGraph().find((s) => s.slug === "functional-design");
      expect(fd).toBeDefined();
      expect(fd?.optional_produces).toEqual(["frontend-components"]);
      expect(fd?.produces).not.toContain("frontend-components");
    });

    test("infrastructure-design carries optional_produces and drops it from produces", () => {
      const infra = loadGraph().find((s) => s.slug === "infrastructure-design");
      expect(infra).toBeDefined();
      expect(infra?.optional_produces).toEqual(["shared-infrastructure"]);
      expect(infra?.produces).not.toContain("shared-infrastructure");
    });

    test("only the two annotated stages carry optional_produces", () => {
      const carriers = loadGraph()
        .filter((s) => s.optional_produces !== undefined)
        .map((s) => s.slug)
        .sort();
      expect(carriers).toEqual(["functional-design", "infrastructure-design"]);
    });
  });

  describe("registry union (shipped graph)", () => {
    beforeEach(() => {
      __resetGraphCache();
    });
    afterEach(() => {
      __resetGraphCache();
    });

    test("artifactsRegistry still contains both conditional names", () => {
      const reg = artifactsRegistry();
      expect(reg.has("frontend-components")).toBe(true);
      expect(reg.has("shared-infrastructure")).toBe(true);
    });

    test("producersOf resolves the conditional artifacts to their producer stage", () => {
      expect(producersOf("frontend-components").map((s) => s.slug)).toContain(
        "functional-design",
      );
      expect(producersOf("shared-infrastructure").map((s) => s.slug)).toContain(
        "infrastructure-design",
      );
    });
  });
});
