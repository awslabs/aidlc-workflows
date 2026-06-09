// covers: function:validateDirective
//
// t113 — Directive schema + validator. Migrated from the bash TAP test
// tests/unit/t113-directive-schema.sh (plan 26). The original spawned `bun -e`
// once per case, importing validateDirective from aidlc-directive.ts and
// stringifying the ValidationResult as "VALID" / "INVALID:<errors joined by |>"
// so bash could grep it. The module is a PURE contract — "no emit, no consume,
// reads/writes NO state, no I/O" (aidlc-directive.ts:9) — so every one of the
// 26 behavioural assertions can be exercised in-process by importing and
// CALLING validateDirective directly. The .ts file does have an
// `if (import.meta.main)` CLI self-check (aidlc-directive.ts:396), but the .sh
// never drives the CLI seam — it always imports validateDirective via `bun -e`.
// So this is a `.none.test.ts` (mechanism = none): pure function calls, zero
// subprocess, zero LLM, zero tokens.
//
// PARITY NOTE on the .sh "VALID" / "INVALID:..." string protocol: the original
// reduced the ValidationResult discriminated union to a single line via the
// run_validator helper (t113-directive-schema.sh:60-67) so bash could grep it.
// In-process we assert the union directly — `result.valid` (boolean) and either
// `result.data` (on success) or `result.errors` (string[]) on failure.
//   - assert_eq "$OUT" "VALID"            -> expect(result.valid).toBe(true)
//   - assert_contains "$OUT" "<substr>"   -> expect(errs(...)).toContain("<substr>")
// where errs() reproduces run_validator's reduction. Same observable behaviour
// (the substring is present in the surfaced error set), asserted against the
// real return value rather than its stringification.
//
// The .sh used `delete d.field` and object-spread mutation against inline JS
// fixture expressions. In-process each fixture is a function returning a fresh
// deep object, so no case can leak mutation into another — the equivalent of
// the .sh re-evaluating the inline expression per run_validator call.

import { describe, expect, test } from "bun:test";
import {
  type Directive,
  validateDirective,
} from "../../dist/claude/.claude/tools/aidlc-directive.ts";

// --- Well-formed fixtures, one per kind (mirror t113-directive-schema.sh:18-56) ---
// Fresh object per call so a `delete`/spread in one case can't bleed into another.

function runStage(): Record<string, unknown> {
  return {
    kind: "run-stage",
    stage: "application-design",
    phase: "inception",
    lead_agent: "aidlc-architect-agent",
    support_agents: ["aidlc-aws-platform-agent", "aidlc-design-agent"],
    mode: "inline",
    gate: true,
    memory_path: "aidlc-docs/inception/application-design/memory.md",
    consumes: ["aidlc-docs/inception/requirements/requirements.md"],
    produces: ["aidlc-docs/inception/application-design/decisions.md"],
    rules_in_context: ["aidlc-org.md", "aidlc-team.md"],
    sensors_applicable: ["required-sections"],
    stage_file: ".claude/skills/aidlc/stages/inception/application-design.md",
  };
}

function dispatchSubagent(): Record<string, unknown> {
  return {
    kind: "dispatch-subagent",
    stage: "code-generation",
    phase: "construction",
    lead_agent: "aidlc-developer-agent",
    support_agents: ["aidlc-quality-agent"],
    mode: "subagent",
    gate: false,
    memory_path: "aidlc-docs/construction/auth/code-generation/memory.md",
    consumes: [
      "aidlc-docs/construction/auth/functional-design/functional-design.md",
    ],
    produces: ["aidlc-docs/construction/auth/code-generation/code-manifest.md"],
    rules_in_context: ["aidlc-org.md"],
    sensors_applicable: ["linter"],
    stage_file: ".claude/skills/aidlc/stages/construction/code-generation.md",
    worker: "code-generation",
  };
}

function invokeSwarm(): Record<string, unknown> {
  return { kind: "invoke-swarm", units: ["auth", "billing"] };
}

function presentGate(): Record<string, unknown> {
  return {
    kind: "present-gate",
    stage: "application-design",
    phase: "inception",
    memory_path: "aidlc-docs/inception/application-design/memory.md",
  };
}

function ask(): Record<string, unknown> {
  return { kind: "ask", question: "Resume from the last checkpoint, or start fresh?" };
}

function print(): Record<string, unknown> {
  return { kind: "print", message: "AIDLC framework version 0.0.0" };
}

function error(): Record<string, unknown> {
  return { kind: "error", message: "Unknown scope" };
}

function done(): Record<string, unknown> {
  return { kind: "done", reason: "Workflow complete." };
}

// Mirror of the .sh run_validator helper (t113-directive-schema.sh:60-67):
// call the validator and reduce the failure case to the pipe-joined error
// string the original asserted against. On success return "VALID".
function errs(obj: unknown): string {
  const r = validateDirective(obj);
  return r.valid ? "VALID" : r.errors.join("|");
}

describe("t113 directive-schema — validateDirective (migrated from t113-directive-schema.sh, plan 26)", () => {
  // ============================================================
  // Positive baseline — a well-formed directive of each kind (8 assertions)
  // .sh lines 75-82
  // ============================================================

  test("run-stage well-formed -> VALID", () => {
    expect(validateDirective(runStage()).valid).toBe(true);
  });

  test("dispatch-subagent well-formed -> VALID", () => {
    expect(validateDirective(dispatchSubagent()).valid).toBe(true);
  });

  test("invoke-swarm well-formed -> VALID", () => {
    expect(validateDirective(invokeSwarm()).valid).toBe(true);
  });

  test("present-gate well-formed -> VALID", () => {
    expect(validateDirective(presentGate()).valid).toBe(true);
  });

  test("ask well-formed -> VALID", () => {
    expect(validateDirective(ask()).valid).toBe(true);
  });

  test("print well-formed -> VALID", () => {
    expect(validateDirective(print()).valid).toBe(true);
  });

  test("error well-formed -> VALID", () => {
    expect(validateDirective(error()).valid).toBe(true);
  });

  test("done well-formed -> VALID", () => {
    expect(validateDirective(done()).valid).toBe(true);
  });

  // ============================================================
  // Positive returns the parsed directive as data (1 assertion)
  // .sh lines 88-93: `kind=` + r.data.kind
  // ============================================================

  test("valid run-stage -> data.kind returned", () => {
    const r = validateDirective(runStage());
    expect(r.valid).toBe(true);
    // narrowed by valid===true; data aliases the input per the validator's
    // documented trust boundary (aidlc-directive.ts:281-288).
    const data = (r as { valid: true; data: Directive }).data;
    expect(data.kind).toBe("run-stage");
  });

  // ============================================================
  // Per-kind missing required field — names the field + kind (8 assertions)
  // .sh lines 99-121
  // ============================================================

  test("run-stage missing lead_agent -> error", () => {
    const d = runStage();
    delete d.lead_agent;
    expect(errs(d)).toContain("run-stage: missing required field: lead_agent");
  });

  test("dispatch-subagent missing worker -> error", () => {
    const d = dispatchSubagent();
    delete d.worker;
    expect(errs(d)).toContain(
      "dispatch-subagent: missing required field: worker",
    );
  });

  test("invoke-swarm missing units -> error", () => {
    const d = invokeSwarm();
    delete d.units;
    expect(errs(d)).toContain("invoke-swarm: missing required field: units");
  });

  test("present-gate missing memory_path -> error", () => {
    const d = presentGate();
    delete d.memory_path;
    expect(errs(d)).toContain(
      "present-gate: missing required field: memory_path",
    );
  });

  test("ask missing question -> error", () => {
    const d = ask();
    delete d.question;
    expect(errs(d)).toContain("ask: missing required field: question");
  });

  test("print missing message -> error", () => {
    const d = print();
    delete d.message;
    expect(errs(d)).toContain("print: missing required field: message");
  });

  test("error missing message -> error", () => {
    const d = error();
    delete d.message;
    expect(errs(d)).toContain("error: missing required field: message");
  });

  test("done missing reason -> error", () => {
    const d = done();
    delete d.reason;
    expect(errs(d)).toContain("done: missing required field: reason");
  });

  // ============================================================
  // Unknown kind (1 assertion)
  // .sh lines 127-128
  // ============================================================

  test("unknown kind -> specific error", () => {
    expect(errs({ kind: "frobnicate", message: "x" })).toContain(
      'unknown kind: "frobnicate"',
    );
  });

  // ============================================================
  // Unknown key on a valid run-stage (1 assertion)
  // .sh lines 134-135
  // ============================================================

  test("unknown key on run-stage -> error", () => {
    expect(errs({ ...runStage(), bogus: "x" })).toContain(
      "run-stage: unknown key: bogus",
    );
  });

  // ============================================================
  // Type mismatches (3 assertions)
  // .sh lines 141-148
  // ============================================================

  test("run-stage gate 'yes' -> boolean type error", () => {
    expect(errs({ ...runStage(), gate: "yes" })).toContain(
      'run-stage: gate must be boolean or "unresolved", got string',
    );
  });

  test("run-stage support_agents 'x' -> array type error", () => {
    expect(errs({ ...runStage(), support_agents: "x" })).toContain(
      "run-stage: support_agents must be array, got string",
    );
  });

  test("ask question 42 -> string type error", () => {
    expect(errs({ ...ask(), question: 42 })).toContain(
      "ask: question must be string, got number",
    );
  });

  // ============================================================
  // mode enum miss on run-stage (1 assertion)
  // .sh lines 154-155
  // ============================================================

  test("run-stage mode enum miss -> error", () => {
    expect(errs({ ...runStage(), mode: "hologram" })).toContain(
      "run-stage: mode must be one of",
    );
  });

  // ============================================================
  // Shape failures — non-object inputs (3 assertions)
  // .sh lines 161-163
  // ============================================================

  test("null -> shape error", () => {
    expect(errs(null)).toContain("expected object, got null");
  });

  test("array -> shape error", () => {
    expect(errs([])).toContain("expected object, got array");
  });

  test("string -> shape error", () => {
    expect(errs("x")).toContain("expected object, got string");
  });
});
