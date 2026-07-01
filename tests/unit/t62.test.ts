// covers: aidlc-stage-schema.ts:validateStageFrontmatter
//   (the sole exported validator; also exercises the exported constants
//    VALID_PHASES / VALID_EXECUTIONS / VALID_MODES / VALID_CONDITIONAL_ON
//    and RESERVED_KEYS indirectly via the error strings they drive, plus the
//    RESERVED_AGENT_SLUG export directly — the orchestrator pseudo-agent that
//    Rule 9 exempts from the agent-registration cross-check)
//
// t62 — stage-frontmatter schema validation. Migrated from the bash TAP test
// tests/unit/t62-stage-schema.sh (plan 62). The original spawned `bun -e`
// importing validateStageFrontmatter (and RESERVED_AGENT_SLUG) and stringifying
// the result as "VALID" / "INVALID:<errors joined by |>". The tool is a PURE
// validator — "no I/O, no YAML parsing, no mutation" (aidlc-stage-schema.ts:6-7)
// — so every one of the 62 behavioural contracts can be asserted in-process by
// importing and CALLING validateStageFrontmatter directly. There is no CLI
// arg-parsing or process.exit shell to keep as a spawn seam: the .ts file is a
// library, not an executable entrypoint (no `import.meta.main` block,
// grep-verified). So all 62 contracts migrate to in-process expect() calls;
// zero spawns remain.
//
// Mechanism: none (pure function calls, zero subprocess, zero LLM, zero tokens).
//
// PARITY NOTE on the .sh "VALID" / "INVALID:..." string protocol: the original
// reduced the ValidationResult discriminated union to a single line so bash
// could grep it. In-process we assert the union directly — `result.valid`
// (boolean) and either `result.data` (on success) or `result.errors` (string[])
// on failure. assert_eq "$OUT" "VALID" becomes expect(result.valid).toBe(true);
// assert_contains "$OUT" "<substr>" becomes
// expect(result.errors.join("|")).toContain("<substr>") — same observable
// behaviour (the substring is present in the surfaced error set), expressed
// against the real return value instead of its stringification.

import { describe, expect, test } from "bun:test";
import {
  RESERVED_AGENT_SLUG,
  type StageFrontmatter,
  type ValidationContext,
  validateStageFrontmatter,
} from "../../dist/claude/.claude/tools/aidlc-stage-schema.ts";

// Shared valid fixture — mirrors the .sh FIXTURE (t62-stage-schema.sh:18-34),
// itself the scope-definition worked example at stage-definition.md:84-109.
// A fresh deep copy per case (via fixture()) replaces the .sh's `{...$FIXTURE, …}`
// spread + per-call `delete fx.$field`, so no case can leak mutation into another.
function fixture(): Record<string, unknown> {
  return {
    slug: "scope-definition",
    phase: "ideation",
    execution: "ALWAYS",
    condition: "Always executes",
    lead_agent: "aidlc-product-agent",
    support_agents: ["aidlc-delivery-agent"],
    mode: "inline",
    produces: ["scope-document", "intent-backlog"],
    consumes: [
      { artifact: "intent-statement", required: true },
      { artifact: "feasibility-assessment", required: false },
    ],
    requires_stage: ["intent-capture"],
    inputs: "prose",
    outputs: "prose",
  };
}

// Mirror of the .sh run_validator helper: call the validator and reduce the
// failure case to the pipe-joined error string the original asserted against.
// On success we return the literal "VALID" so the positive assertions read
// identically to assert_eq "$OUT" "VALID".
function errs(obj: unknown, ctx?: ValidationContext): string {
  const r = validateStageFrontmatter(obj, ctx);
  return r.valid ? "VALID" : r.errors.join("|");
}

describe("t62 stage-schema — validateStageFrontmatter (migrated from t62-stage-schema.sh, plan 59)", () => {
  // ============================================================
  // Positive baseline — the valid fixture (2 assertions)
  // ============================================================

  test("valid fixture -> VALID", () => {
    const r = validateStageFrontmatter(fixture());
    expect(r.valid).toBe(true);
  });

  test("valid fixture -> data.slug returned", () => {
    const r = validateStageFrontmatter(fixture());
    expect(r.valid).toBe(true);
    // narrowed by valid===true; data aliases the input per the validator's
    // documented trust boundary (aidlc-stage-schema.ts:262-271).
    const data = (r as { valid: true; data: StageFrontmatter }).data;
    expect(data.slug).toBe("scope-definition");
  });

  // ============================================================
  // Shape failures — non-object inputs (5 assertions)
  // ============================================================

  test("null -> shape error", () => {
    expect(errs(null)).toContain("expected object, got null");
  });

  test("undefined -> shape error", () => {
    expect(errs(undefined)).toContain("expected object, got undefined");
  });

  test("array -> shape error", () => {
    expect(errs([])).toContain("expected object, got array");
  });

  test("string -> shape error", () => {
    expect(errs("string")).toContain("expected object, got string");
  });

  test("number -> shape error", () => {
    expect(errs(42)).toContain("expected object, got number");
  });

  // ============================================================
  // Required fields missing — one per (12 assertions)
  // Mirrors the .sh `for field in … delete fx.$field` loop (lines 88-101).
  // ============================================================

  const REQUIRED_FIELDS = [
    "slug",
    "phase",
    "execution",
    "condition",
    "lead_agent",
    "support_agents",
    "mode",
    "produces",
    "consumes",
    "requires_stage",
    "inputs",
    "outputs",
  ] as const;

  for (const field of REQUIRED_FIELDS) {
    test(`missing ${field} -> error names field`, () => {
      const fx = fixture();
      delete fx[field];
      expect(errs(fx)).toContain(`missing required field: ${field}`);
    });
  }

  // ============================================================
  // Type mismatches — 6 representative (6 assertions)
  // ============================================================

  test("slug: 42 -> type error", () => {
    expect(errs({ ...fixture(), slug: 42 })).toContain("slug must be string");
  });

  test("support_agents: 'x' -> type error", () => {
    expect(errs({ ...fixture(), support_agents: "x" })).toContain(
      "support_agents must be array",
    );
  });

  test("consumes: {} -> type error", () => {
    expect(errs({ ...fixture(), consumes: {} })).toContain(
      "consumes must be array",
    );
  });

  test("produces: 'x' -> type error", () => {
    expect(errs({ ...fixture(), produces: "x" })).toContain(
      "produces must be array",
    );
  });

  test("condition: 99 -> type error", () => {
    expect(errs({ ...fixture(), condition: 99 })).toContain(
      "condition must be string",
    );
  });

  test("requires_stage: 'x' -> type error", () => {
    expect(errs({ ...fixture(), requires_stage: "x" })).toContain(
      "requires_stage must be array",
    );
  });

  // ============================================================
  // Enum misses (4 assertions)
  // ============================================================

  test("phase enum miss -> error", () => {
    expect(errs({ ...fixture(), phase: "bogus" })).toContain(
      "phase must be one of",
    );
  });

  test("execution enum miss -> error", () => {
    expect(errs({ ...fixture(), execution: "YES" })).toContain(
      "execution must be one of",
    );
  });

  test("mode enum miss -> error", () => {
    expect(errs({ ...fixture(), mode: "hologram" })).toContain(
      "mode must be one of",
    );
  });

  test("conditional_on enum miss -> error", () => {
    expect(
      errs({
        ...fixture(),
        consumes: [{ artifact: "x", required: true, conditional_on: "maybe" }],
      }),
    ).toContain("conditional_on must be one of");
  });

  // ============================================================
  // Enum positive — all 3 modes accepted (3 assertions)
  // ============================================================

  for (const m of ["inline", "subagent", "agent-team"] as const) {
    test(`mode=${m} accepted`, () => {
      expect(errs({ ...fixture(), mode: m })).toBe("VALID");
    });
  }

  // ============================================================
  // Slug regex rejections (3 assertions)
  // ============================================================

  test("slug 'Bad Slug' rejected", () => {
    expect(errs({ ...fixture(), slug: "Bad Slug" })).toContain(
      "slug must be kebab-case",
    );
  });

  test("slug 'has_underscore' rejected", () => {
    expect(errs({ ...fixture(), slug: "has_underscore" })).toContain(
      "slug must be kebab-case",
    );
  });

  test("slug '-leading-dash' rejected", () => {
    expect(errs({ ...fixture(), slug: "-leading-dash" })).toContain(
      "slug must be kebab-case",
    );
  });

  // ============================================================
  // Reserved keys — each produces a reserved-key error (5 assertions)
  // Exact strings pin RESERVED_KEYS map (aidlc-stage-schema.ts:67-73).
  // ============================================================

  // `when` is an ACTIVE structured activation predicate (plugin mechanism,
  // Layer 4) — no longer reserved. A valid single-key producer-in-plan map
  // passes; a wrong-shape or unknown-predicate value is rejected.
  test("when: valid producer-in-plan predicate passes", () => {
    const r = validateStageFrontmatter({ ...fixture(), when: { "producer-in-plan": "some-artifact" } });
    expect(r.valid).toBe(true);
  });

  test("when: string value rejected (must be object)", () => {
    expect(errs({ ...fixture(), when: "x" })).toContain("when must be object, got string");
  });

  test("when: unknown predicate rejected", () => {
    expect(errs({ ...fixture(), when: { "bogus-predicate": "x" } })).toContain(
      'when has unknown predicate "bogus-predicate"; allowed: producer-in-plan',
    );
  });

  // number / name / bundle — optional plugin-mechanism metadata, accepted when
  // shape-valid (previously rejected as unknown keys).
  test("number/name/bundle: valid values pass", () => {
    const r = validateStageFrontmatter({ ...fixture(), number: "4.50", name: "My Stage", bundle: "test-pro" });
    expect(r.valid).toBe(true);
  });

  test("number: wrong shape rejected", () => {
    expect(errs({ ...fixture(), number: "4-50" })).toContain(
      "number must be <phase-prefix>.<index>",
    );
  });

  test("reserved: on_failure", () => {
    expect(errs({ ...fixture(), on_failure: "x" })).toContain(
      "on_failure is reserved (loop driver); not active yet",
    );
  });

  test("reserved: blocks_on", () => {
    expect(errs({ ...fixture(), blocks_on: "x" })).toContain(
      "blocks_on is reserved (construction worktrees); not active yet",
    );
  });

  test("reserved: timeout", () => {
    expect(errs({ ...fixture(), timeout: "x" })).toContain(
      "timeout is reserved (sensor binding); not active yet",
    );
  });

  test("reserved: retry", () => {
    expect(errs({ ...fixture(), retry: "x" })).toContain(
      "retry is reserved (loop driver); not active yet",
    );
  });

  // ============================================================
  // Unknown key (1 assertion)
  // ============================================================

  test("unknown key rejected", () => {
    expect(errs({ ...fixture(), foo: "bar" })).toContain("unknown key: foo");
  });

  // ============================================================
  // for_each optionality — absent/string/number (3 assertions)
  // ============================================================

  test("for_each absent -> valid", () => {
    expect(errs(fixture())).toBe("VALID");
  });

  test("for_each string -> valid", () => {
    expect(errs({ ...fixture(), for_each: "unit-of-work" })).toBe("VALID");
  });

  test("for_each number -> error", () => {
    expect(errs({ ...fixture(), for_each: 42 })).toContain(
      "for_each must be string",
    );
  });

  // ============================================================
  // consumes[] shape (5 assertions)
  // ============================================================

  test("consumes missing artifact", () => {
    expect(errs({ ...fixture(), consumes: [{ required: true }] })).toContain(
      "consumes[0].artifact missing",
    );
  });

  test("consumes missing required", () => {
    expect(errs({ ...fixture(), consumes: [{ artifact: "x" }] })).toContain(
      "consumes[0].required missing",
    );
  });

  test("consumes required wrong type", () => {
    expect(
      errs({ ...fixture(), consumes: [{ artifact: "x", required: "yes" }] }),
    ).toContain("consumes[0].required must be boolean");
  });

  test("consumes bad conditional_on", () => {
    expect(
      errs({
        ...fixture(),
        consumes: [{ artifact: "x", required: true, conditional_on: "always" }],
      }),
    ).toContain("conditional_on must be one of");
  });

  test("consumes unconditional (no conditional_on key) -> valid", () => {
    expect(
      errs({ ...fixture(), consumes: [{ artifact: "x", required: true }] }),
    ).toBe("VALID");
  });

  // ============================================================
  // conditional_on positive (2 assertions)
  // ============================================================

  test("conditional_on: brownfield accepted", () => {
    expect(
      errs({
        ...fixture(),
        consumes: [
          { artifact: "x", required: true, conditional_on: "brownfield" },
        ],
      }),
    ).toBe("VALID");
  });

  test("conditional_on: greenfield accepted", () => {
    expect(
      errs({
        ...fixture(),
        consumes: [
          { artifact: "x", required: true, conditional_on: "greenfield" },
        ],
      }),
    ).toBe("VALID");
  });

  // ============================================================
  // Empty-array positives (2 assertions)
  // ============================================================

  test("all four array fields empty -> valid", () => {
    expect(
      errs({
        ...fixture(),
        produces: [],
        consumes: [],
        requires_stage: [],
        support_agents: [],
      }),
    ).toBe("VALID");
  });

  test("produces: [] alone -> valid", () => {
    expect(errs({ ...fixture(), produces: [] })).toBe("VALID");
  });

  // ============================================================
  // Dynamic agent lookup (3 assertions)
  // Exercises the ctx.agents branch (aidlc-stage-schema.ts:242-256).
  // ============================================================

  test("lead_agent not in ctx.agents -> error", () => {
    const out = errs(
      { ...fixture(), lead_agent: "ghost-agent" },
      { agents: ["aidlc-product-agent", "aidlc-delivery-agent"] },
    );
    expect(out).toContain('lead_agent "ghost-agent" has no matching');
  });

  test("support_agents[0] not in ctx.agents -> error", () => {
    const out = errs(
      { ...fixture(), support_agents: ["ghost-agent"] },
      { agents: ["aidlc-product-agent"] },
    );
    expect(out).toContain('support_agents[0] "ghost-agent" has no matching');
  });

  test("without ctx.agents -> lead_agent not checked", () => {
    // No ctx → agent-slug lookup skipped, so a ghost lead_agent still validates.
    expect(errs({ ...fixture(), lead_agent: "ghost-agent" })).toBe("VALID");
  });

  // ============================================================
  // Reserved orchestrator pseudo-agent exemption (3 assertions)
  // The conductor session names itself as lead_agent on the bootstrap
  // initialization stages; it has no .claude/agents/*.md file by design, so
  // Rule 9 must exempt it even when ctx.agents is supplied. Exercises the
  // RESERVED_AGENT_SLUG export and the `!== RESERVED_AGENT_SLUG` guards on both
  // the lead_agent and support_agents arms of Rule 9
  // (aidlc-stage-schema.ts:75 + :274-295).
  // ============================================================

  test("RESERVED_AGENT_SLUG export is 'orchestrator'", () => {
    expect(RESERVED_AGENT_SLUG).toBe("orchestrator");
  });

  test("lead_agent 'orchestrator' exempt from Rule 9 with ctx.agents", () => {
    // 'orchestrator' is NOT in ctx.agents, yet a ghost lead_agent would error
    // here — the exemption is what keeps it VALID.
    expect(
      errs(
        {
          ...fixture(),
          lead_agent: RESERVED_AGENT_SLUG,
          support_agents: [],
        },
        { agents: ["aidlc-product-agent"] },
      ),
    ).toBe("VALID");
  });

  test("support_agents 'orchestrator' exempt from Rule 9 with ctx.agents", () => {
    expect(
      errs(
        {
          ...fixture(),
          lead_agent: "aidlc-product-agent",
          support_agents: [RESERVED_AGENT_SLUG],
        },
        { agents: ["aidlc-product-agent"] },
      ),
    ).toBe("VALID");
  });

  // ============================================================
  // Error-field-name regression guard (3 assertions)
  // The .sh asserted the error ARRAY contains an entry mentioning the field —
  // i.e. errors are field-addressable, not a generic blob. In-process we assert
  // against r.errors.find(...) just like the original `r.errors.find(e => …)`.
  // ============================================================

  test("empty object error mentions slug", () => {
    const r = validateStageFrontmatter({});
    expect(r.valid).toBe(false);
    const errors = (r as { valid: false; errors: string[] }).errors;
    expect(errors.find((e) => e.includes("slug"))).toBeDefined();
  });

  test("phase enum-miss error names phase", () => {
    const r = validateStageFrontmatter({ ...fixture(), phase: "bogus" });
    expect(r.valid).toBe(false);
    const errors = (r as { valid: false; errors: string[] }).errors;
    expect(errors.find((e) => e.includes("phase"))).toBeDefined();
  });

  test("consumes error path includes index + field", () => {
    const r = validateStageFrontmatter({
      ...fixture(),
      consumes: [{ required: true }],
    });
    expect(r.valid).toBe(false);
    const errors = (r as { valid: false; errors: string[] }).errors;
    expect(errors.find((e) => e.includes("consumes[0].artifact"))).toBeDefined();
  });

  // ============================================================
  // Reviewer field validation (V2 + V3) — type, positive-integer,
  // cap⇒reviewer coupling, and the Rule 9 roster cross-check.
  // Both fields are OPTIONAL: absent → valid; the only required relation is
  // the coupling (cap present ⇒ reviewer present). Exercises checkString on
  // `reviewer`, the new checkPositiveInteger on `reviewer_max_iterations`,
  // and the reviewer arm of Rule 9.
  // ============================================================

  test("both reviewer fields absent -> valid", () => {
    expect(errs(fixture())).toBe("VALID");
  });

  test("reviewer present, cap absent -> valid (cap defaults to 2)", () => {
    expect(errs({ ...fixture(), reviewer: "aidlc-product-lead-agent" })).toBe(
      "VALID",
    );
  });

  test("valid reviewer + cap 2 -> valid", () => {
    expect(
      errs({
        ...fixture(),
        reviewer: "aidlc-product-lead-agent",
        reviewer_max_iterations: 2,
      }),
    ).toBe("VALID");
  });

  test("non-string reviewer (42) -> type error", () => {
    expect(errs({ ...fixture(), reviewer: 42 })).toContain(
      "reviewer must be string",
    );
  });

  test("reviewer_max_iterations as string '2' -> positive-integer error", () => {
    // The parser only coerces an integer LITERAL to a number; a value that
    // reaches the validator still a string must be rejected, not coerced.
    expect(
      errs({
        ...fixture(),
        reviewer: "aidlc-product-lead-agent",
        reviewer_max_iterations: "2",
      }),
    ).toContain("reviewer_max_iterations must be a positive integer");
  });

  test("reviewer_max_iterations zero -> positive-integer error", () => {
    expect(
      errs({
        ...fixture(),
        reviewer: "aidlc-product-lead-agent",
        reviewer_max_iterations: 0,
      }),
    ).toContain("reviewer_max_iterations must be a positive integer");
  });

  test("reviewer_max_iterations negative -> positive-integer error", () => {
    expect(
      errs({
        ...fixture(),
        reviewer: "aidlc-product-lead-agent",
        reviewer_max_iterations: -3,
      }),
    ).toContain("reviewer_max_iterations must be a positive integer");
  });

  test("reviewer_max_iterations non-integer (2.5) -> positive-integer error", () => {
    expect(
      errs({
        ...fixture(),
        reviewer: "aidlc-product-lead-agent",
        reviewer_max_iterations: 2.5,
      }),
    ).toContain("reviewer_max_iterations must be a positive integer");
  });

  test("cap present with reviewer absent -> coupling error", () => {
    expect(errs({ ...fixture(), reviewer_max_iterations: 2 })).toContain(
      "reviewer_max_iterations requires a reviewer",
    );
  });

  test("reviewer not in ctx.agents -> Rule 9 roster error", () => {
    const out = errs(
      { ...fixture(), reviewer: "ghost-reviewer-agent" },
      { agents: ["aidlc-product-agent", "aidlc-delivery-agent"] },
    );
    expect(out).toContain('reviewer "ghost-reviewer-agent" has no matching');
  });

  test("reviewer in ctx.agents -> valid", () => {
    expect(
      errs(
        { ...fixture(), reviewer: "aidlc-product-lead-agent" },
        {
          agents: [
            "aidlc-product-agent",
            "aidlc-delivery-agent",
            "aidlc-product-lead-agent",
          ],
        },
      ),
    ).toBe("VALID");
  });

  test("without ctx.agents -> reviewer not roster-checked", () => {
    // No ctx → agent-slug lookup skipped (same as lead_agent), so a ghost
    // reviewer still validates as a string.
    expect(errs({ ...fixture(), reviewer: "ghost-reviewer-agent" })).toBe(
      "VALID",
    );
  });
});
