// Directive schema — the frozen engine↔conductor interface. The engine
// (aidlc-orchestrate.ts) answers "what's next?" with exactly one typed
// `Directive`; the conductor reads its `kind` and does the one move it names.
// This module defines the discriminated union over the 9 kinds the engine can
// emit, plus a runtime validator. Sibling of aidlc-stage-schema.ts and
// aidlc-sensor-schema.ts — same tool-boundary discipline: a refused or
// malformed directive is a clear signal, not a silent miss.
//
// Pure contract: no emit, no consume, reads/writes NO state, no I/O. The engine
// constructs directives and validates them before printing; the conductor
// parses and validates them on receipt. This file is the single shared
// definition both sides import, so the wire shape cannot drift between them.
//
// A directive names a `kind` and carries EXACTLY the fields that kind needs.
// `validateDirective` mirrors aidlc-stage-schema.ts: a ValidationResult union,
// per-field presence/type checks collected into an errors[] array, and
// unknown-key rejection per kind. The shape guard reuses isPlainObject from
// aidlc-lib.ts.

import { isPlainObject } from "./aidlc-lib.ts";

// --- Public types ---

// The classify-round-trip sentinel (per the engine design). Most
// `gate` values are deterministic — the scope's stage map says whether a stage
// gates — and the engine emits a plain boolean. ONE case is irreducibly
// knowledge: the first Construction Bolt's gate depends on the walking-skeleton
// STANCE, which an LLM resolves by reading a team's free-form `## Walking
// Skeleton` practices prose (no parser turns free English into a stance). The
// engine cannot decide it without smuggling an LLM into routing, so it DEFERS:
// it emits `gate: "unresolved"` for that one stage, the conductor classifies
// the prose and feeds the stance back via `aidlc-orchestrate report
// --skeleton-stance`, and the NEXT `next` emits the now-determined boolean gate.
// The engine still owns the transition — only a typed stance ever crosses back
// in. Every OTHER run-stage carries a boolean gate; the sentinel is exclusively
// the skeleton case.
export const GATE_UNRESOLVED = "unresolved" as const;
export type GateValue = boolean | typeof GATE_UNRESOLVED;

// The 9 kinds, keyed on the `kind` discriminator.
export type DirectiveKind =
  | "run-stage"
  | "dispatch-subagent"
  | "invoke-swarm"
  | "present-gate"
  | "ask"
  | "print"
  | "error"
  | "done"
  | "parked";

// run-stage — load lead + support agents, load `consumes` artifacts, run the
// stage body, write `produces`, keep memory.md. Routing fields (lead_agent,
// support_agents, mode, gate, sensors_applicable, rules_in_context, stage_file)
// are read straight off the compiled stage-graph.json node; consumes/produces
// carry RESOLVED aidlc-docs/... paths (the engine resolves vocabulary names →
// paths at emit time; the conductor never re-derives them).
export interface RunStageDirective {
  kind: "run-stage";
  stage: string;
  phase: string;
  lead_agent: string;
  support_agents: string[];
  mode: "inline" | "subagent" | "agent-team";
  // gate is a boolean for every deterministic case; the string sentinel
  // GATE_UNRESOLVED ("unresolved") appears ONLY for the first Construction Bolt's
  // walking-skeleton gate, which the conductor resolves via report (the
  // classify round-trip — see GATE_UNRESOLVED above).
  gate: GateValue;
  memory_path: string;
  // consumes carries only the declared inputs that EXIST on disk at emit time;
  // declared inputs whose file is absent move to consumes_absent so the
  // conductor is never pointed at a path that cannot be read.
  consumes: string[];
  produces: string[];
  rules_in_context: string[];
  sensors_applicable: string[];
  stage_file: string;
  // reviewer — the agent to invoke as a separate sub-agent for quality review
  // after the stage body completes. Absent (undefined) when no review step is
  // configured for this stage. See stage-protocol.md §12a.
  reviewer?: string;
  // reviewer_max_iterations — how many review cycles before escalating to the
  // human. Default 2 when reviewer is present. Absent when no reviewer.
  reviewer_max_iterations?: number;
  // conductor_persona — set ONLY on the first run-stage of a workflow (decision
  // D-E, SPIKE 6). The engine reads `.claude/aidlc-common/conductor.md` and bakes
  // its contents here so the conductor receives its execution-quality charter
  // in-context, with no skill referencing that file by path. Absent on every
  // later directive (the persona persists in the session once delivered).
  conductor_persona?: string;
  // next_stage: the display name of the in-scope stage that FOLLOWS this one,
  // resolved by the engine so the approval gate's Approve option can read
  // "Continue to <next_stage>" verbatim. null = this is the final in-scope
  // stage (the conductor renders "Complete workflow" instead). Optional: absent
  // and null both carry no next-stage name. The conductor renders this value
  // verbatim and NEVER infers the next stage itself (issue: the placeholder used
  // to render as a guessed "Code Generation" regardless of the real target).
  next_stage?: string | null;
  // unit: present ONLY on a per-unit Construction directive (for_each:
  // unit-of-work) that the engine resolved to a CONCRETE Unit of Work; absent
  // otherwise, and absent when the engine fell back to the {unit-name}
  // placeholder (no compiled unit DAG). It is informational for the conductor
  // (the produces/consumes/memory paths already carry the unit segment) AND a
  // marker that this run-stage is ONE iteration of N: the engine drives the
  // per-unit loop, re-emitting the next uncovered unit on each `next` and
  // suppressing the gate (gate:false) on EVERY not-yet-covered unit. The stage's
  // real gate is presented only once, on the re-entry after the last unit's
  // artifacts land on disk (no uncovered units remain), so the conductor must
  // build a gate:false unit and re-run `next` rather than approve it. See
  // aidlc-orchestrate.ts emitPerUnitRunStage.
  unit?: string;
  // consumes_absent: REQUIRED declared inputs whose resolved file does NOT
  // exist on disk at emit time, each annotated with why. `expected: true` =
  // the producing stage is not on the active scope's path (the scope
  // deliberately skipped it — absence is by design; substitute available
  // context, do not invent the artifact). `expected: false` = a producer IS
  // on the path but the file is still missing (runtime-skipped conditional
  // producer, or a real gap worth surfacing per stage-protocol-recovery).
  // Optional (`required: false`) consumes never appear here — missing means
  // dropped, not flagged. Omitted entirely when nothing qualifies, and on
  // the ctx-less emit path (no projectDir to check against). Paths with an
  // unresolved {unit-name} placeholder are never listed here (existence is
  // unknowable).
  consumes_absent?: Array<{ path: string; expected: boolean }>;
}

// dispatch-subagent — same as run-stage, but the stage runs via a Task call to
// a named worker (e.g. code-generation, reverse-engineering). Carries every
// run-stage field PLUS `worker` (the named worker the conductor Tasks).
export interface DispatchSubagentDirective {
  kind: "dispatch-subagent";
  stage: string;
  phase: string;
  lead_agent: string;
  support_agents: string[];
  mode: "inline" | "subagent" | "agent-team";
  gate: GateValue;
  memory_path: string;
  consumes: string[];
  produces: string[];
  rules_in_context: string[];
  sensors_applicable: string[];
  stage_file: string;
  worker: string;
  conductor_persona?: string;
  next_stage?: string | null;
  consumes_absent?: Array<{ path: string; expected: boolean }>;
}

// invoke-swarm — fan out N parallel workers across N worktrees for a build
// batch; converge each on a signal. `units` is the build batch to fan out.
//
// invoke-swarm shape is intentionally minimal. The engine now EMITS this kind
// (aidlc-orchestrate `next` answers with it for an eligible Construction batch
// under an autonomy grant) and the conductor CONSUMES it (runs aidlc-swarm.ts,
// takes the baton back on the failure envelope). `units` is the only field both
// sides need: the conductor reads the rest of the batch context off the compiled
// runtime graph, so this shape stays minimal.
export interface InvokeSwarmDirective {
  kind: "invoke-swarm";
  units: string[];
  // repo — OPTIONAL. The sibling repo NAME this batch targets, present only when
  // the engine can resolve it deterministically: the intent records exactly one
  // repo (the lone sibling). Absent for a legacy/single-projectDir intent (no
  // recorded repos — the conductor's `prepare` runs without --repo, today's
  // behaviour) AND for a multi-repo intent (>1 recorded repos — the engine cannot
  // autonomously disambiguate which sibling a batch targets; that is the
  // conductor's knowledge call, so it supplies --repo from the intent's recorded
  // set). When present, the conductor passes it straight through as `prepare --repo`.
  repo?: string;
}

// present-gate — run the stage-protocol §13 learnings ritual, then render the
// approval gate. The conductor surfaces judgement to the human here.
export interface PresentGateDirective {
  kind: "present-gate";
  stage: string;
  phase: string;
  memory_path: string;
}

// ask — render a specific structured question (resume choice, scope
// confirmation, the autonomy ladder). The engine never calls AskUserQuestion
// itself; it emits `ask` and stops, the conductor renders it and feeds the
// answer back via report.
export interface AskDirective {
  kind: "ask";
  question: string;
}

// print — print verbatim and stop (status / help / doctor / version).
export interface PrintDirective {
  kind: "print";
  message: string;
}

// error — stop with an error (unknown scope, mutually-exclusive flags, init
// guard, malformed stage file). The message is shown to the user verbatim.
export interface ErrorDirective {
  kind: "error";
  message: string;
}

// done — stop the loop (workflow or single-stage complete). `reason` records
// why the loop ended.
export interface DoneDirective {
  kind: "done";
  reason: string;
}

// parked - the workflow was intentionally parked mid-flow (a human resumes it
// later via /aidlc --resume). Distinct from `done` (which means "workflow
// complete"): a parked workflow has in-scope stages still pending. The Stop
// hook treats `parked` as a terminal allow, so the conductor can end its turn
// at a clean inter-stage boundary instead of rubber-stamping stages to reach
// `done` (issue #367). `stage` names the slug the workflow parked at.
export interface ParkedDirective {
  kind: "parked";
  reason: string;
  stage: string;
}

// The Directive union — the engine emits exactly one of these per `next`.
export type Directive =
  | RunStageDirective
  | DispatchSubagentDirective
  | InvokeSwarmDirective
  | PresentGateDirective
  | AskDirective
  | PrintDirective
  | ErrorDirective
  | DoneDirective
  | ParkedDirective;

export type ValidationResult =
  | { valid: true; data: Directive }
  | { valid: false; errors: string[] };

// --- Exported constants (imported by tests) ---

// The 9 kinds, in the engine design's catalogue order. Used both for the unknown-kind
// error message and as the discriminator allowlist.
export const VALID_KINDS = [
  "run-stage",
  "dispatch-subagent",
  "invoke-swarm",
  "present-gate",
  "ask",
  "print",
  "error",
  "done",
  "parked",
] as const;

// The mode enum carried by run-stage / dispatch-subagent. Mirrors
// aidlc-stage-schema.ts VALID_MODES (the directive's mode is read straight off
// the stage node, so the value set is identical).
export const VALID_MODES = ["inline", "subagent", "agent-team"] as const;

// Per-kind allowed-key sets. A field outside its kind's set is rejected as an
// unknown key (mirrors aidlc-stage-schema.ts KNOWN_FIELDS). `kind` is always
// allowed. The string-array fields a kind requires are listed in
// KIND_STRING_ARRAY_FIELDS below; the rest are scalars checked individually.
const RUN_STAGE_FIELDS = [
  "kind",
  "stage",
  "phase",
  "lead_agent",
  "support_agents",
  "mode",
  "gate",
  "memory_path",
  "consumes",
  "produces",
  "rules_in_context",
  "sensors_applicable",
  "stage_file",
  "reviewer",
  "reviewer_max_iterations",
  "conductor_persona",
  "next_stage",
  "unit",
  "consumes_absent",
] as const;

// dispatch-subagent = run-stage fields + `worker`.
const DISPATCH_SUBAGENT_FIELDS = [...RUN_STAGE_FIELDS, "worker"] as const;

const INVOKE_SWARM_FIELDS = ["kind", "units", "repo"] as const;
const PRESENT_GATE_FIELDS = ["kind", "stage", "phase", "memory_path"] as const;
const ASK_FIELDS = ["kind", "question"] as const;
const PRINT_FIELDS = ["kind", "message"] as const;
const ERROR_FIELDS = ["kind", "message"] as const;
const DONE_FIELDS = ["kind", "reason"] as const;
const PARKED_FIELDS = ["kind", "reason", "stage"] as const;

const KNOWN_FIELDS_BY_KIND: Readonly<Record<DirectiveKind, readonly string[]>> = {
  "run-stage": RUN_STAGE_FIELDS,
  "dispatch-subagent": DISPATCH_SUBAGENT_FIELDS,
  "invoke-swarm": INVOKE_SWARM_FIELDS,
  "present-gate": PRESENT_GATE_FIELDS,
  ask: ASK_FIELDS,
  print: PRINT_FIELDS,
  error: ERROR_FIELDS,
  done: DONE_FIELDS,
  parked: PARKED_FIELDS,
};

// --- Validator ---

// validateDirective — runtime schema check on a parsed object. Returns a
// ValidationResult union (mirrors validateStageFrontmatter): { valid:true, data }
// or { valid:false, errors[] }. Collects every field-level error rather than
// throwing on the first, so a caller (engine emit-time check, conductor
// receipt check, the t113 test) sees the full list.
export function validateDirective(obj: unknown): ValidationResult {
  // Rule 1: shape. Must be a plain object. If not, return a single error — we
  // can't collect field-level errors on a non-object. Matches stage-schema's
  // "expected object, got <x>" wording exactly.
  if (!isPlainObject(obj)) {
    const actual =
      obj === null ? "null" : Array.isArray(obj) ? "array" : typeof obj;
    return { valid: false, errors: [`expected object, got ${actual}`] };
  }

  const o = obj;
  const errors: string[] = [];

  // Rule 2: kind discriminator. Must be present and a string, and one of the 8.
  if (!("kind" in o) || typeof o.kind !== "string") {
    errors.push("missing or non-string required field: kind");
    return { valid: false, errors };
  }
  if (!(VALID_KINDS as readonly string[]).includes(o.kind)) {
    errors.push(
      `unknown kind: "${o.kind}" (expected one of ${VALID_KINDS.join(" | ")})`,
    );
    return { valid: false, errors };
  }
  const kind = o.kind as DirectiveKind;

  // Rule 3: unknown keys — any key not in this kind's allowed set.
  const known = new Set<string>(KNOWN_FIELDS_BY_KIND[kind]);
  for (const key of Object.keys(o)) {
    if (!known.has(key)) {
      errors.push(`${kind}: unknown key: ${key}`);
    }
  }

  // Rule 4-6: per-kind required-field presence + type checks, with specific,
  // kind-aware messages.
  switch (kind) {
    case "run-stage":
      checkRunStageShared(o, kind, errors);
      break;
    case "dispatch-subagent":
      checkRunStageShared(o, kind, errors);
      checkString(o, "worker", kind, errors);
      break;
    case "invoke-swarm":
      checkStringArray(o, "units", kind, errors);
      checkOptionalString(o, "repo", kind, errors);
      break;
    case "present-gate":
      checkString(o, "stage", kind, errors);
      checkString(o, "phase", kind, errors);
      checkString(o, "memory_path", kind, errors);
      break;
    case "ask":
      checkString(o, "question", kind, errors);
      break;
    case "print":
      checkString(o, "message", kind, errors);
      break;
    case "error":
      checkString(o, "message", kind, errors);
      break;
    case "done":
      checkString(o, "reason", kind, errors);
      break;
    case "parked":
      checkString(o, "reason", kind, errors);
      checkString(o, "stage", kind, errors);
      break;
    // No default: the union is exhaustive — every member of DirectiveKind has a
    // case above. TS flags a missing case at compile time if a kind is added.
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // On success, return the same reference — no copy, no normalisation. Callers
  // must NOT mutate `data`; it aliases the input. The double-cast is the
  // documented trust boundary: rules 1-6 have verified each field's presence
  // and type, so the structural compatibility is guaranteed at runtime even
  // though TS can't follow the per-field checks. Centralising this single cast
  // in the validator keeps the rest of the codebase cast-free.
  // type-coverage:ignore-next-line — documented validator trust boundary
  return { valid: true, data: o as unknown as Directive };
}

// checkRunStageShared — the field set common to run-stage and
// dispatch-subagent. `kind` is threaded through so each error names the actual
// kind being validated (e.g. "dispatch-subagent: missing required field: lead_agent").
function checkRunStageShared(
  o: Record<string, unknown>,
  kind: DirectiveKind,
  errors: string[],
): void {
  checkString(o, "stage", kind, errors);
  checkString(o, "phase", kind, errors);
  checkString(o, "lead_agent", kind, errors);
  checkStringArray(o, "support_agents", kind, errors);
  checkString(o, "mode", kind, errors);
  checkEnum(o, "mode", VALID_MODES, kind, errors);
  checkGate(o, "gate", kind, errors);
  checkString(o, "memory_path", kind, errors);
  checkStringArray(o, "consumes", kind, errors);
  checkStringArray(o, "produces", kind, errors);
  checkStringArray(o, "rules_in_context", kind, errors);
  checkStringArray(o, "sensors_applicable", kind, errors);
  checkString(o, "stage_file", kind, errors);
  checkOptionalString(o, "conductor_persona", kind, errors);
  // next_stage: optional-nullable on a run-stage directive. Present as a string
  // names the following in-scope stage; null means this is the final in-scope
  // stage; absent carries no name. So string OR null validates; any other
  // present value is rejected.
  checkOptionalNullableString(o, "next_stage", kind, errors);
  // reviewer fields — optional on a run-stage directive (present only when the
  // stage declares a reviewer). Mirror the stage-schema validator: reviewer is
  // an optional string, reviewer_max_iterations an optional positive integer.
  checkOptionalString(o, "reviewer", kind, errors);
  checkOptionalPositiveInteger(o, "reviewer_max_iterations", kind, errors);
  // unit: optional on a run-stage directive (present only on a per-unit
  // Construction directive resolved to a concrete Unit of Work). A present
  // value must be a string; absent is valid.
  checkOptionalString(o, "unit", kind, errors);
  // consumes_absent: optional (present only when a declared consume's file is
  // missing at emit time). Each entry must be {path: string, expected: boolean}.
  checkOptionalConsumesAbsent(o, "consumes_absent", kind, errors);
}

// --- Helpers (mirror aidlc-stage-schema.ts: presence first, then type) ---

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function checkString(
  o: Record<string, unknown>,
  field: string,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!(field in o)) {
    errors.push(`${kind}: missing required field: ${field}`);
    return;
  }
  if (typeof o[field] !== "string") {
    errors.push(`${kind}: ${field} must be string, got ${describe(o[field])}`);
  }
}

// checkGate — the gate field accepts a boolean (every deterministic case) OR
// the string sentinel GATE_UNRESOLVED (the classify round-trip's skeleton case).
// Any other value — including a different string — is rejected, so a typo'd
// sentinel surfaces loudly rather than being acted on as a deferred gate.
function checkGate(
  o: Record<string, unknown>,
  field: string,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!(field in o)) {
    errors.push(`${kind}: missing required field: ${field}`);
    return;
  }
  const v = o[field];
  if (typeof v !== "boolean" && v !== GATE_UNRESOLVED) {
    errors.push(
      `${kind}: ${field} must be boolean or "${GATE_UNRESOLVED}", got ${describe(v)}`,
    );
  }
}

// checkOptionalString — a field that may be absent, but if present must be a
// string (e.g. conductor_persona, delivered only on the first run-stage).
function checkOptionalString(
  o: Record<string, unknown>,
  field: string,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!(field in o)) return;
  if (typeof o[field] !== "string") {
    errors.push(`${kind}: ${field} must be string, got ${describe(o[field])}`);
  }
}

// checkOptionalNullableString - a field that may be absent, but if present must
// be a string OR null (e.g. next_stage, where null is the meaningful "final
// in-scope stage" signal, distinct from absent).
function checkOptionalNullableString(
  o: Record<string, unknown>,
  field: string,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!(field in o)) return;
  const v = o[field];
  if (v !== null && typeof v !== "string") {
    errors.push(`${kind}: ${field} must be string or null, got ${describe(v)}`);
  }
}

// checkOptionalPositiveInteger — a field that may be absent, but if present
// must be a positive integer (>= 1) — e.g. reviewer_max_iterations. Mirrors
// the stage-schema validator's checkPositiveInteger so the directive contract
// matches the frontmatter contract.
function checkOptionalPositiveInteger(
  o: Record<string, unknown>,
  field: string,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!(field in o) || o[field] === undefined) return;
  const v = o[field];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    errors.push(
      `${kind}: ${field} must be a positive integer, got ${describe(v)}`,
    );
  }
}

// checkOptionalConsumesAbsent — a field that may be absent, but if present
// must be an array of {path: string, expected: boolean} objects. Mirrors the
// checkOptional* early-return idiom and checkStringArray's per-element error
// wording.
function checkOptionalConsumesAbsent(
  o: Record<string, unknown>,
  field: string,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!(field in o)) return;
  const v: unknown = o[field];
  if (!Array.isArray(v)) {
    errors.push(`${kind}: ${field} must be array, got ${describe(v)}`);
    return;
  }
  const arr: unknown[] = v;
  arr.forEach((item: unknown, i: number) => {
    if (!isPlainObject(item)) {
      errors.push(
        `${kind}: ${field}[${i}] must be object, got ${describe(item)}`,
      );
      return;
    }
    if (typeof item.path !== "string") {
      errors.push(
        `${kind}: ${field}[${i}].path must be string, got ${describe(item.path)}`,
      );
    }
    if (typeof item.expected !== "boolean") {
      errors.push(
        `${kind}: ${field}[${i}].expected must be boolean, got ${describe(item.expected)}`,
      );
    }
  });
}

function checkStringArray(
  o: Record<string, unknown>,
  field: string,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!(field in o)) {
    errors.push(`${kind}: missing required field: ${field}`);
    return;
  }
  const v: unknown = o[field];
  if (!Array.isArray(v)) {
    errors.push(`${kind}: ${field} must be array, got ${describe(v)}`);
    return;
  }
  const arr: unknown[] = v;
  arr.forEach((item: unknown, i: number) => {
    if (typeof item !== "string") {
      errors.push(`${kind}: ${field}[${i}] must be string, got ${describe(item)}`);
    }
  });
}

function checkEnum(
  o: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!(field in o)) return; // presence already reported by checkString
  const v = o[field];
  if (typeof v !== "string") return; // type error already reported by checkString
  if (!allowed.includes(v)) {
    errors.push(`${kind}: ${field} must be one of ${allowed.join(" | ")}, got "${v}"`);
  }
}

// --- CLI self-check ---
//
// `bun aidlc-directive.ts` constructs one well-formed example of each of the 9
// kinds, validates each, prints one line per kind ("<kind>: VALID" or the
// errors), and exits 0 iff all 9 validate. Satisfies the acceptance check
// "bun .../aidlc-directive.ts validates the 9 kinds".
if (import.meta.main) {
  // One well-formed example per kind. run-stage mirrors the engine design's example
  // directive verbatim (application-design); the others follow the same catalogue table.
  const examples: Directive[] = [
    {
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
      rules_in_context: [
        "aidlc-org.md",
        "aidlc-team.md",
        "aidlc-project.md",
        "aidlc-phase-inception.md",
      ],
      sensors_applicable: ["required-sections", "upstream-coverage"],
      stage_file: ".claude/aidlc-common/stages/inception/application-design.md",
      next_stage: "Units Generation",
    },
    {
      kind: "dispatch-subagent",
      stage: "code-generation",
      phase: "construction",
      lead_agent: "aidlc-developer-agent",
      support_agents: ["aidlc-quality-agent"],
      mode: "subagent",
      gate: false,
      memory_path: "aidlc-docs/construction/auth/code-generation/memory.md",
      consumes: ["aidlc-docs/construction/auth/functional-design/functional-design.md"],
      produces: ["aidlc-docs/construction/auth/code-generation/code-manifest.md"],
      rules_in_context: ["aidlc-org.md", "aidlc-phase-construction.md"],
      sensors_applicable: ["linter", "type-check"],
      stage_file: ".claude/aidlc-common/stages/construction/code-generation.md",
      worker: "code-generation",
    },
    {
      kind: "invoke-swarm",
      units: ["auth", "billing", "notifications"],
    },
    // invoke-swarm carrying the optional repo (the single-recorded-repo case).
    {
      kind: "invoke-swarm",
      units: ["auth", "billing"],
      repo: "repo-a",
    },
    {
      kind: "present-gate",
      stage: "application-design",
      phase: "inception",
      memory_path: "aidlc-docs/inception/application-design/memory.md",
    },
    { kind: "ask", question: "Resume from the last checkpoint, or start fresh?" },
    { kind: "print", message: "AIDLC framework version 0.0.0" },
    { kind: "error", message: 'Unknown scope: "frobnicate"' },
    { kind: "done", reason: "Workflow complete — all in-scope stages approved." },
    { kind: "parked", reason: 'Workflow parked at "feasibility". Resume with /aidlc --resume.', stage: "feasibility" },
    // The classify-round-trip skeleton case: gate is the unresolved sentinel,
    // and the first run-stage of a workflow also carries the conductor persona.
    {
      kind: "run-stage",
      stage: "functional-design",
      phase: "construction",
      lead_agent: "aidlc-architect-agent",
      support_agents: ["aidlc-developer-agent"],
      mode: "inline",
      gate: GATE_UNRESOLVED,
      memory_path: "aidlc-docs/construction/{unit-name}/functional-design/memory.md",
      consumes: [],
      produces: ["aidlc-docs/construction/{unit-name}/functional-design/business-logic-model.md"],
      rules_in_context: ["aidlc-org.md", "aidlc-phase-construction.md"],
      sensors_applicable: ["required-sections"],
      stage_file: ".claude/aidlc-common/stages/construction/functional-design.md",
      conductor_persona: "# The Conductor's Craft …",
    },
  ];

  let allValid = true;
  for (const ex of examples) {
    const r = validateDirective(ex);
    if (r.valid) {
      console.log(`${ex.kind}: VALID`);
    } else {
      allValid = false;
      console.log(`${ex.kind}: INVALID — ${r.errors.join("; ")}`);
    }
  }
  process.exit(allValid ? 0 : 1);
}
