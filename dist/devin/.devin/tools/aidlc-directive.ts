// Directive schema — the frozen engine↔conductor interface. The engine
// (aidlc-orchestrate.ts) answers "what's next?" with exactly one typed
// `Directive`; the conductor reads its `kind` and does the one move it names.
// This module defines the discriminated union over the 11 kinds the engine can
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

// narration: the OPTIONAL spoken line for a directive, authored by the engine
// and relayed by the conductor. It is a presentation field: it carries no
// routing meaning, every kind may omit it, and dropping it changes nothing
// about what the framework does.
//
// WHY THE ENGINE AUTHORS IT: the engine already knows, deterministically, which
// stage this is, what scope resolved, what it just decided, and what comes
// next. The conductor does not need to infer any of that to describe it, and
// when it does infer it, it describes the mechanism it can see (the tool call,
// the directive kind, the routing) rather than the user's project. Authoring the
// sentence where the facts live makes the spoken line deterministic too, and
// leaves the conductor a relay instead of an improviser - the same move the
// framework already made for rule delivery, where prose compliance failed and
// deterministic injection replaced it.
//
// This field is legal on EVERY kind (see NARRATION_FIELD in the allowed-key
// sets) so a new emission point can carry a line without a schema change. Keep
// values to one sentence, two at most: a load-steering directive's rule payload
// is chunked against DIRECTIVE_MAX_BYTES with limited headroom, so narration is
// never the thing that pushes a directive over transport budget.
export type NarrationField = string;

export const VALID_PROTOCOL_MODULES = [
  "reviewer",
  "ensemble",
  "construction",
  "swarm",
] as const;
export type ProtocolModule = (typeof VALID_PROTOCOL_MODULES)[number];

// The 11 kinds, keyed on the `kind` discriminator.
export type DirectiveKind =
  | "load-steering"
  | "run-stage"
  | "dispatch-subagent"
  | "invoke-swarm"
  | "present-gate"
  | "ask"
  | "print"
  | "error"
  | "done"
  | "parked"
  | "notice";

// load-steering - one bounded part of the active stage's deterministic rule
// bundle. The conductor applies rules_content in order and immediately invokes
// `aidlc-orchestrate continue <continue_token>`; the final continuation emits
// the run-stage directive. Chunking is an engine transport detail and is not
// surfaced as conversational progress.
export interface LoadSteeringDirective {
  kind: "load-steering";
  /** Optional spoken line for the user; presentation only (see NarrationField). */
  narration?: NarrationField;
  stage: string;
  bundle: string;
  part: number;
  parts: number;
  rules_content: Array<{ path: string; text: string }>;
  continue_token: string;
}

export type WaveReviewState =
  | "outstanding"
  | "retry-required"
  | "repair-required"
  | "recovery-required"
  | "escalation-required"
  | "READY"
  | "NOT-READY"
  | "not-required";

// One engine-resolved unit in an optional stage-major batch wave. Every path
// is resolved independently from this unit's kind against the same healed DAG
// snapshot. The parent run-stage retains stage-level steering, context, and
// memory; the entry carries only the unit-local execution surface.
export interface RunStageWaveEntry {
  unit: string;
  unit_kind: string | null;
  build_required: boolean;
  completion_required: boolean;
  review_state: WaveReviewState;
  review_iteration: number | null;
  unit_memory_path: string;
  consumes: string[];
  consumes_absent: Array<{ path: string; expected: boolean }>;
  produces: string[];
  required_produces: string[];
}

export interface RunStageWave {
  batch_index: number;
  entries: RunStageWaveEntry[];
}

export interface RunStagePipeline {
  links: string[];
  completed: string[];
}

export interface LegacyPlanApprovalChoices {
  approve: string;
  request_changes: string;
}

// run-stage — load the resolved rules, load lead + support agents, load
// `consumes` artifacts, run the stage body, write `produces`, keep memory.md. Routing fields (lead_agent,
// support_agents, mode, gate, sensors_applicable, rules_in_context, stage_file)
// are read straight off the compiled stage-graph.json node; consumes/produces
// carry RESOLVED aidlc-docs/... paths (the engine resolves vocabulary names →
// paths at emit time; the conductor never re-derives them).
export interface RunStageDirective {
  kind: "run-stage";
  /** Optional spoken line for the user; presentation only (see NarrationField). */
  narration?: NarrationField;
  stage: string;
  phase: string;
  lead_agent: string;
  support_agents: string[];
  mode: "inline" | "subagent" | "pipeline" | "mob" | "agent-team";
  // Pipeline recovery surface. links is the declared lead→support chain;
  // completed contains current-attempt receipts (repo-qualified as
  // `<repo>:<agent>` whenever the intent records repository identity).
  pipeline?: RunStagePipeline;
  // single marks an isolated stage-runner invocation. The conductor branches
  // on this before gate handling, reports with `report --single`, and treats
  // the returned `done` as terminal.
  single?: boolean;
  // Exact persona + knowledge files the conductor must read for work it owns
  // inline: lead + supports on inline stages, lead only on a mob (supports are
  // dispatched), and empty on fully-dispatched subagent/pipeline topologies.
  // Carrying paths makes persona loading observable and enforceable in traces.
  inline_context_paths: string[];
  // Non-fatal problems discovered while building the path-loaded persona /
  // knowledge roster. The conductor shows these actionable warnings and
  // continues with the readable context; rule-delivery failures are blocking
  // error directives instead.
  context_warnings?: string[];
  // gate is a boolean for every deterministic case; the string sentinel
  // GATE_UNRESOLVED ("unresolved") appears ONLY for the first Construction Bolt's
  // walking-skeleton gate, which the conductor resolves via report (the
  // classify round-trip — see GATE_UNRESOLVED above).
  gate: GateValue;
  // Present only for team-owned unit-major approval beats. The stage body is
  // already settled; the conductor opens/reports this unit gate with --unit.
  unit_gate?: "per-stage" | "unit-end";
  memory_path: string;
  // consumes carries only the declared inputs that EXIST on disk at emit time;
  // declared inputs whose file is absent move to consumes_absent so the
  // conductor is never pointed at a path that cannot be read.
  consumes: string[];
  produces: string[];
  // Exact active-space rule paths represented by the preceding load-steering
  // bundle. On dispatched topologies the conductor passes the already-loaded
  // rule text to every agent brief.
  rules_in_context: string[];
  // Presentation projection only: detailed fire policy remains on stage-graph.
  sensors_applicable: string[];
  stage_file: string;
  // Kiro IDE 0.12 has no chat/session id. The engine emits this one-time
  // capability only to the `next`/`continue` caller that owns legacy planning;
  // runtime authority stores hashes, never these plaintext labels.
  legacy_plan_approval_choices?: LegacyPlanApprovalChoices;
  // reviewer — the agent to invoke as a separate sub-agent for quality review
  // after the stage body completes. Absent (undefined) when no review step is
  // configured for this stage. See stage-protocol-reviewer.md §12a.
  reviewer?: string;
  // Required Markdown output that owns the appended reviewer section.
  review_artifact?: string;
  // reviewer_max_iterations — how many review cycles before escalating to the
  // human. Default 2 when reviewer is present. Absent when no reviewer.
  reviewer_max_iterations?: number;
  // review_class — how the §12a review runs, RESOLVED by the engine (stage
  // declaration lowered by the scope's review_cap and any per-run Review
  // Override): "adversarial" = refute + fix loop up to the cap; "advisory" =
  // one pass, findings quoted verbatim at the approval gate, no fix loop
  // (reviewer_max_iterations is 1). A "none" resolution never reaches the
  // conductor - the engine omits the whole reviewer block instead. Absent
  // when reviewer is absent.
  review_class?: "adversarial" | "advisory";
  // protocol_modules — optional deterministic hints naming conditional
  // protocol files the conductor reads before the stage body. The prose
  // triggers remain the compatibility fallback when this field is absent.
  protocol_modules?: ProtocolModule[];
  // Gate-only re-entry after every autonomous swarm Unit and reviewer receipt
  // converged. Present only as literal true; the conductor must not rerun the
  // stage body or reviewer.
  swarm_settled?: true;
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
  // artifacts and review receipts settle, so the conductor must complete a
  // gate:false unit and re-run `next` rather than approve it. See
  // aidlc-orchestrate.ts emitPerUnitRunStage.
  unit?: string;
  // wave: optional stage-major parallelization surface for the four inline
  // per-unit design stages. Entries come from one healed Bolt-DAG snapshot and
  // are complete per-unit execution records. build_required/review_state make
  // crash recovery deterministic: covered-but-unreviewed units stay in their
  // current batch as review-only work instead of allowing a dependent batch or
  // the stage gate to advance. Absent on unit-major iteration, code-generation,
  // and the no-DAG degrade path.
  wave?: RunStageWave;
  // consumes_absent: REQUIRED declared inputs whose resolved file does NOT
  // exist on disk at emit time, each annotated with why. `expected: true` =
  // the producing stage is not on the active scope's path or every on-path
  // producer has audit provenance for a conditional runtime skip (absence is
  // by design; substitute available context, do not invent the artifact).
  // `expected: false` = an on-path producer was not skipped but the file is
  // still missing, including a stage marked [S] by a forward jump, so this is
  // a real gap worth surfacing per stage-protocol-recovery.
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
  /** Optional spoken line for the user; presentation only (see NarrationField). */
  narration?: NarrationField;
  stage: string;
  phase: string;
  lead_agent: string;
  support_agents: string[];
  mode: "inline" | "subagent" | "pipeline" | "mob" | "agent-team";
  inline_context_paths: string[];
  context_warnings?: string[];
  gate: GateValue;
  memory_path: string;
  consumes: string[];
  produces: string[];
  rules_in_context: string[];
  // Presentation projection only: detailed fire policy remains on stage-graph.
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
// The reviewer fields make the post-convergence verifier explicit. They remain
// optional for compatibility with older/custom emitters, but the shipped engine
// includes them whenever the swarm stage declares a reviewer.
export interface InvokeSwarmDirective {
  kind: "invoke-swarm";
  /** Optional spoken line for the user; presentation only (see NarrationField). */
  narration?: NarrationField;
  units: string[];
  stage?: string;
  stage_file?: string;
  reviewer?: string;
  review_artifact?: string;
  reviewer_max_iterations?: number;
  // review_class — the stage's DECLARED class, carried for observability.
  // Swarm reviews are exempt from scope caps and run overrides (the reviewer
  // is the only pre-merge verification inside a Bolt), so unlike run-stage
  // this is not a resolved value.
  review_class?: "adversarial" | "advisory";
  protocol_modules?: ProtocolModule[];
  // repo — OPTIONAL. The sibling repo NAME this batch targets, present only when
  // the engine can resolve it deterministically: the intent records exactly one
  // repo (the lone sibling). Absent for a legacy/single-projectDir intent (no
  // recorded repos — the conductor's `prepare` runs without --repo, today's
  // behaviour) AND for a multi-repo intent (>1 recorded repos — the engine cannot
  // autonomously disambiguate which sibling a batch targets; that is the
  // conductor's knowledge call, so it supplies --repo from the intent's recorded
  // set). When present, the conductor passes it straight through as `prepare --repo`.
  repo?: string;
  legacy_plan_approval_choices?: LegacyPlanApprovalChoices;
}

// present-gate — run the stage-protocol §13 learnings ritual, then render the
// approval gate. The conductor surfaces judgement to the human here.
export interface PresentGateDirective {
  kind: "present-gate";
  /** Optional spoken line for the user; presentation only (see NarrationField). */
  narration?: NarrationField;
  stage: string;
  phase: string;
  memory_path: string;
}

// ask — render a specific structured question. Most asks return through report.
// The new-work-routing subtype is different: it classifies prose that has not
// started stage work, so its answer routes through `next` and must never be
// recorded as a stage report.
interface AskDirectiveBase {
  kind: "ask";
  /** Optional spoken line for the user; presentation only (see NarrationField). */
  narration?: NarrationField;
  question: string;
}

export interface ReportAskDirective extends AskDirectiveBase {
  ask_type?: undefined;
  response_route?: undefined;
  new_work_description?: undefined;
  proposed_scope?: undefined;
  available_intents?: undefined;
  numbered_prose_question?: undefined;
  claimable_units?: undefined;
  claimed_units?: undefined;
  waiting_units?: undefined;
  recovery_choice?: undefined;
}

export interface NewWorkRoutingAskDirective extends AskDirectiveBase {
  ask_type: "new-work-routing";
  response_route: "next";
  new_work_description: string;
  proposed_scope: string;
  /** Existing unselected intent record-dir selectors, when the clone-local cursor is missing. */
  available_intents?: string[];
  /** Engine-authored numbered rendering for prose-only harnesses such as Kiro. */
  numbered_prose_question: string;
  claimable_units?: undefined;
  claimed_units?: undefined;
  waiting_units?: undefined;
  recovery_choice?: undefined;
}

export interface UnitClaimAskDirective extends AskDirectiveBase {
  ask_type: "unit-claim";
  response_route: "claim";
  claimable_units: string[];
  claimed_units: Array<{ unit: string; holder: string }>;
  waiting_units: Array<{ unit: string; blocked_by: string[] }>;
  new_work_description?: undefined;
  proposed_scope?: undefined;
  available_intents?: undefined;
  numbered_prose_question?: undefined;
  recovery_choice?: undefined;
}

export interface LegacyPlanApprovalRecoveryAskDirective
  extends AskDirectiveBase {
  ask_type: "legacy-plan-approval-recovery";
  response_route: "next";
  recovery_choice: "Recover Plan Approval";
  new_work_description?: undefined;
  proposed_scope?: undefined;
  available_intents?: undefined;
  numbered_prose_question?: undefined;
  claimable_units?: undefined;
  claimed_units?: undefined;
  waiting_units?: undefined;
}

export type AskDirective =
  | ReportAskDirective
  | NewWorkRoutingAskDirective
  | UnitClaimAskDirective
  | LegacyPlanApprovalRecoveryAskDirective;

// print — print verbatim and stop (status / help / doctor / version).
export interface PrintDirective {
  kind: "print";
  /** Optional spoken line for the user; presentation only (see NarrationField). */
  narration?: NarrationField;
  message: string;
}

// error — stop with an error (unknown scope, mutually-exclusive flags, init
// guard, malformed stage file). The message is shown to the user verbatim.
export interface ErrorDirective {
  kind: "error";
  /** Optional spoken line for the user; presentation only (see NarrationField). */
  narration?: NarrationField;
  message: string;
}

// done — stop the loop (workflow or single-stage complete). `reason` records
// why the loop ended.
export interface DoneDirective {
  kind: "done";
  /** Optional spoken line for the user; presentation only (see NarrationField). */
  narration?: NarrationField;
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
  /** Optional spoken line for the user; presentation only (see NarrationField). */
  narration?: NarrationField;
  reason: string;
  stage: string;
}

export interface StageValidityAdvisory {
  state: "drifted" | "untracked" | "unavailable";
  directly_stale: string[];
  needs_revalidation: string[];
  untracked: string[];
  earliest_affected_stage: string | null;
  warning: string;
}

export interface NoticeDirective {
  kind: "notice";
  narration?: NarrationField;
  message: string;
}

// The Directive union — the engine emits exactly one of these per `next`.
type DirectivePayload =
  | LoadSteeringDirective
  | RunStageDirective
  | DispatchSubagentDirective
  | InvokeSwarmDirective
  | PresentGateDirective
  | AskDirective
  | PrintDirective
  | ErrorDirective
  | DoneDirective
  | ParkedDirective
  | NoticeDirective;

/** `stage_validity` is universal and advisory; `kind` still owns routing. */
export type Directive = DirectivePayload & {
  stage_validity?: StageValidityAdvisory;
};

export type ValidationResult =
  | { valid: true; data: Directive }
  | { valid: false; errors: string[] };

// --- Exported constants (imported by tests) ---

// The 11 kinds, in the engine design's catalogue order. Used both for the unknown-kind
// error message and as the discriminator allowlist.
export const VALID_KINDS = [
  "load-steering",
  "run-stage",
  "dispatch-subagent",
  "invoke-swarm",
  "present-gate",
  "ask",
  "print",
  "error",
  "done",
  "parked",
  "notice",
] as const;

// The mode enum carried by run-stage / dispatch-subagent. Mirrors
// aidlc-stage-schema.ts VALID_MODES (the directive's mode is read straight off
// the stage node, so the value set is identical).
export const VALID_MODES = ["inline", "subagent", "pipeline", "mob", "agent-team"] as const;
export const VALID_REVIEW_CLASSES = ["adversarial", "advisory"] as const;

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
  "pipeline",
  "single",
  "inline_context_paths",
  "context_warnings",
  "gate",
  "unit_gate",
  "memory_path",
  "consumes",
  "produces",
  "rules_in_context",
  "sensors_applicable",
  "stage_file",
  "reviewer",
  "review_artifact",
  "reviewer_max_iterations",
  "review_class",
  "protocol_modules",
  "swarm_settled",
  "conductor_persona",
  "next_stage",
  "unit",
  "wave",
  "consumes_absent",
  "legacy_plan_approval_choices",
] as const;

const LOAD_STEERING_FIELDS = [
  "kind",
  "stage",
  "bundle",
  "part",
  "parts",
  "rules_content",
  "continue_token",
] as const;

// dispatch-subagent = shared run-stage fields + `worker`; the isolated-run
// marker belongs only to the emitted run-stage kind.
const DISPATCH_SUBAGENT_FIELDS = [
  ...RUN_STAGE_FIELDS.filter(
    (field) =>
      field !== "single" &&
      field !== "wave" &&
      field !== "protocol_modules" &&
      field !== "swarm_settled" &&
      field !== "legacy_plan_approval_choices",
  ),
  "worker",
] as const;

const INVOKE_SWARM_FIELDS = [
  "kind",
  "units",
  "stage",
  "stage_file",
  "reviewer",
  "review_artifact",
  "reviewer_max_iterations",
  "review_class",
  "protocol_modules",
  "repo",
  "legacy_plan_approval_choices",
] as const;
const PRESENT_GATE_FIELDS = ["kind", "stage", "phase", "memory_path"] as const;
const ASK_FIELDS = [
  "kind",
  "question",
  "ask_type",
  "response_route",
  "new_work_description",
  "proposed_scope",
  "available_intents",
  "numbered_prose_question",
  "claimable_units",
  "claimed_units",
  "waiting_units",
  "recovery_choice",
] as const;
const PRINT_FIELDS = ["kind", "message"] as const;
const ERROR_FIELDS = ["kind", "message"] as const;
const DONE_FIELDS = ["kind", "reason"] as const;
const PARKED_FIELDS = ["kind", "reason", "stage"] as const;
const NOTICE_FIELDS = ["kind", "message"] as const;

// `narration` is legal on EVERY kind, so it is folded into each allowed-key set
// centrally rather than repeated in eleven literals. A presentation field carries no
// per-kind meaning: the conductor speaks it when present and works silently when
// absent, on any kind. Folding it here also means a future emission point can
// attach a line without touching this file.
const NARRATION_FIELD = "narration" as const;
const STAGE_VALIDITY_FIELD = "stage_validity" as const;

// Every kind's set gains `narration`, so the per-kind literals above stay the
// record of what is kind-SPECIFIC and this one helper adds what is universal.
function withNarration(fields: readonly string[]): readonly string[] {
  return [...fields, NARRATION_FIELD, STAGE_VALIDITY_FIELD];
}

const KNOWN_FIELDS_BY_KIND: Readonly<Record<DirectiveKind, readonly string[]>> = {
  "load-steering": withNarration(LOAD_STEERING_FIELDS),
  "run-stage": withNarration(RUN_STAGE_FIELDS),
  "dispatch-subagent": withNarration(DISPATCH_SUBAGENT_FIELDS),
  "invoke-swarm": withNarration(INVOKE_SWARM_FIELDS),
  "present-gate": withNarration(PRESENT_GATE_FIELDS),
  ask: withNarration(ASK_FIELDS),
  print: withNarration(PRINT_FIELDS),
  error: withNarration(ERROR_FIELDS),
  done: withNarration(DONE_FIELDS),
  parked: withNarration(PARKED_FIELDS),
  notice: withNarration(NOTICE_FIELDS),
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

  // Rule 3b: narration is legal on every kind, so it is type-checked once here
  // rather than in each of the eleven switch arms. Optional: absent is the normal
  // case and never an error; present-but-not-a-string is, because the conductor
  // would otherwise be handed a non-sentence to speak.
  checkOptionalString(o, NARRATION_FIELD, kind, errors);
  checkOptionalStageValidity(o, kind, errors);

  // Rule 4-6: per-kind required-field presence + type checks, with specific,
  // kind-aware messages.
  switch (kind) {
    case "load-steering":
      checkString(o, "stage", kind, errors);
      checkString(o, "bundle", kind, errors);
      checkPositiveInteger(o, "part", kind, errors);
      checkPositiveInteger(o, "parts", kind, errors);
      checkPathTextArray(o, "rules_content", kind, errors);
      checkString(o, "continue_token", kind, errors);
      if (
        typeof o.part === "number" &&
        typeof o.parts === "number" &&
        Number.isInteger(o.part) &&
        Number.isInteger(o.parts) &&
        o.part > o.parts
      ) {
        errors.push(`${kind}: part must be less than or equal to parts`);
      }
      break;
    case "run-stage":
      checkRunStageShared(o, kind, errors);
      checkOptionalBoolean(o, "single", kind, errors);
      checkOptionalWave(o, "wave", kind, errors);
      break;
    case "dispatch-subagent":
      checkRunStageShared(o, kind, errors);
      checkString(o, "worker", kind, errors);
      break;
    case "invoke-swarm":
      checkStringArray(o, "units", kind, errors);
      checkOptionalString(o, "stage", kind, errors);
      checkOptionalString(o, "stage_file", kind, errors);
      checkOptionalString(o, "reviewer", kind, errors);
      checkOptionalString(o, "review_artifact", kind, errors);
      checkOptionalPositiveInteger(o, "reviewer_max_iterations", kind, errors);
      checkOptionalString(o, "review_class", kind, errors);
      checkEnum(o, "review_class", VALID_REVIEW_CLASSES, kind, errors);
      if ("review_class" in o && typeof o.reviewer !== "string") {
        errors.push(`${kind}: review_class requires reviewer`);
      }
      if (
        typeof o.reviewer === "string" &&
        typeof o.review_artifact !== "string"
      ) {
        errors.push(`${kind}: reviewer requires review_artifact`);
      }
      if (
        "review_artifact" in o &&
        typeof o.review_artifact === "string" &&
        typeof o.reviewer !== "string"
      ) {
        errors.push(`${kind}: review_artifact requires reviewer`);
      }
      checkOptionalProtocolModules(o, kind, errors);
      checkOptionalString(o, "repo", kind, errors);
      checkOptionalLegacyPlanApprovalChoices(o, kind, errors);
      break;
    case "present-gate":
      checkString(o, "stage", kind, errors);
      checkString(o, "phase", kind, errors);
      checkString(o, "memory_path", kind, errors);
      break;
    case "ask":
      checkString(o, "question", kind, errors);
      checkOptionalString(o, "ask_type", kind, errors);
      checkOptionalString(o, "response_route", kind, errors);
      checkOptionalString(o, "new_work_description", kind, errors);
      checkOptionalString(o, "proposed_scope", kind, errors);
      checkOptionalStringArray(o, "available_intents", kind, errors);
      checkOptionalString(o, "numbered_prose_question", kind, errors);
      checkOptionalString(o, "recovery_choice", kind, errors);
      if (
        "ask_type" in o &&
        o.ask_type !== "new-work-routing" &&
        o.ask_type !== "unit-claim" &&
        o.ask_type !== "legacy-plan-approval-recovery"
      ) {
        errors.push(
          `${kind}: ask_type must be one of new-work-routing | unit-claim | legacy-plan-approval-recovery, got ${String(o.ask_type)}`,
        );
      }
      if (o.ask_type === "new-work-routing") {
        if (o.response_route !== "next") {
          errors.push(`${kind}: new-work-routing response_route must be "next"`);
        }
        checkString(o, "new_work_description", kind, errors);
        checkString(o, "proposed_scope", kind, errors);
        checkString(o, "numbered_prose_question", kind, errors);
        for (const field of [
          "claimable_units",
          "claimed_units",
          "waiting_units",
          "recovery_choice",
        ] as const) {
          if (field in o) {
            errors.push(
              `${kind}: ${field} is not valid for new-work-routing`,
            );
          }
        }
      } else if (o.ask_type === "unit-claim") {
        if (o.response_route !== "claim") {
          errors.push(`${kind}: unit-claim response_route must be "claim"`);
        }
        checkStringArray(o, "claimable_units", kind, errors);
        checkUnitClaimRows(o, "claimed_units", "holder", kind, errors);
        checkUnitClaimRows(o, "waiting_units", "blocked_by", kind, errors);
        for (const field of [
          "new_work_description",
          "proposed_scope",
          "available_intents",
          "numbered_prose_question",
          "recovery_choice",
        ] as const) {
          if (field in o) {
            errors.push(`${kind}: ${field} is not valid for unit-claim`);
          }
        }
      } else if (o.ask_type === "legacy-plan-approval-recovery") {
        if (o.response_route !== "next") {
          errors.push(
            `${kind}: legacy-plan-approval-recovery response_route must be "next"`,
          );
        }
        if (o.recovery_choice !== "Recover Plan Approval") {
          errors.push(
            `${kind}: legacy-plan-approval-recovery recovery_choice must be "Recover Plan Approval"`,
          );
        }
        for (const field of [
          "new_work_description",
          "proposed_scope",
          "available_intents",
          "numbered_prose_question",
          "claimable_units",
          "claimed_units",
          "waiting_units",
        ] as const) {
          if (field in o) {
            errors.push(
              `${kind}: ${field} is not valid for legacy-plan-approval-recovery`,
            );
          }
        }
      } else {
        for (const field of [
          "response_route",
          "new_work_description",
          "proposed_scope",
          "available_intents",
          "numbered_prose_question",
          "claimable_units",
          "claimed_units",
          "waiting_units",
          "recovery_choice",
        ] as const) {
          if (field in o) {
            errors.push(
              `${kind}: ${field} requires ask_type "new-work-routing"`,
            );
          }
        }
      }
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
    case "notice":
      checkString(o, "message", kind, errors);
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
  checkOptionalPipeline(o, kind, errors);
  checkStringArray(o, "inline_context_paths", kind, errors);
  checkOptionalStringArray(o, "context_warnings", kind, errors);
  checkGate(o, "gate", kind, errors);
  checkString(o, "memory_path", kind, errors);
  checkStringArray(o, "consumes", kind, errors);
  checkStringArray(o, "produces", kind, errors);
  checkStringArray(o, "rules_in_context", kind, errors);
  checkStringArray(o, "sensors_applicable", kind, errors);
  checkString(o, "stage_file", kind, errors);
  checkOptionalLegacyPlanApprovalChoices(o, kind, errors);
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
  checkOptionalString(o, "review_artifact", kind, errors);
  checkOptionalPositiveInteger(o, "reviewer_max_iterations", kind, errors);
  checkOptionalString(o, "review_class", kind, errors);
  checkEnum(o, "review_class", VALID_REVIEW_CLASSES, kind, errors);
  if ("review_class" in o && typeof o.reviewer !== "string") {
    errors.push(`${kind}: review_class requires reviewer`);
  }
  if (
    typeof o.reviewer === "string" &&
    typeof o.review_artifact !== "string"
  ) {
    errors.push(`${kind}: reviewer requires review_artifact`);
  }
  if (
    "review_artifact" in o &&
    typeof o.review_artifact === "string" &&
    typeof o.reviewer !== "string"
  ) {
    errors.push(`${kind}: review_artifact requires reviewer`);
  }
  if (kind === "run-stage") {
    checkOptionalProtocolModules(o, kind, errors);
    checkOptionalTrue(o, "swarm_settled", kind, errors);
  }
  // unit: optional on a run-stage directive (present only on a per-unit
  // Construction directive resolved to a concrete Unit of Work). A present
  // value must be a string; absent is valid.
  checkOptionalString(o, "unit", kind, errors);
  checkOptionalString(o, "unit_gate", kind, errors);
  checkEnum(
    o,
    "unit_gate",
    ["per-stage", "unit-end"] as const,
    kind,
    errors,
  );
  if ("unit_gate" in o && typeof o.unit !== "string") {
    errors.push(`${kind}: unit_gate requires unit`);
  }
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

function checkOptionalStageValidity(
  o: Record<string, unknown>,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!(STAGE_VALIDITY_FIELD in o)) return;
  const raw = o[STAGE_VALIDITY_FIELD];
  if (!isPlainObject(raw)) {
    errors.push(`${kind}: ${STAGE_VALIDITY_FIELD} must be object, got ${describe(raw)}`);
    return;
  }
  const allowed = new Set([
    "state",
    "directly_stale",
    "needs_revalidation",
    "untracked",
    "earliest_affected_stage",
    "warning",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push(`${kind}: ${STAGE_VALIDITY_FIELD} unknown key: ${key}`);
    }
  }
  if (!(["drifted", "untracked", "unavailable"] as unknown[]).includes(raw.state)) {
    errors.push(
      `${kind}: ${STAGE_VALIDITY_FIELD}.state must be drifted, untracked, or unavailable`,
    );
  }
  for (const field of [
    "directly_stale",
    "needs_revalidation",
    "untracked",
  ] as const) {
    const value = raw[field];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      errors.push(`${kind}: ${STAGE_VALIDITY_FIELD}.${field} must be string array`);
    }
  }
  if (
    raw.earliest_affected_stage !== null &&
    typeof raw.earliest_affected_stage !== "string"
  ) {
    errors.push(
      `${kind}: ${STAGE_VALIDITY_FIELD}.earliest_affected_stage must be string or null`,
    );
  }
  if (typeof raw.warning !== "string") {
    errors.push(`${kind}: ${STAGE_VALIDITY_FIELD}.warning must be string`);
  }
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

function checkOptionalLegacyPlanApprovalChoices(
  o: Record<string, unknown>,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!("legacy_plan_approval_choices" in o)) return;
  const value = o.legacy_plan_approval_choices;
  if (!isPlainObject(value)) {
    errors.push(
      `${kind}: legacy_plan_approval_choices must be object, got ${describe(value)}`,
    );
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "approve" && key !== "request_changes") {
      errors.push(
        `${kind}: legacy_plan_approval_choices unknown key: ${key}`,
      );
    }
  }
  const approve = value.approve;
  const requestChanges = value.request_changes;
  if (typeof approve !== "string") {
    errors.push(
      `${kind}: legacy_plan_approval_choices.approve must be string, got ${describe(approve)}`,
    );
  }
  if (typeof requestChanges !== "string") {
    errors.push(
      `${kind}: legacy_plan_approval_choices.request_changes must be string, got ${describe(requestChanges)}`,
    );
  }
  if (typeof approve !== "string" || typeof requestChanges !== "string") return;
  const approveMatch = /^Approve Plan \[([0-9a-f]{12})\]$/.exec(approve);
  const changesMatch =
    /^Request Changes \[([0-9a-f]{12})\]$/.exec(requestChanges);
  if (!approveMatch || !changesMatch || approveMatch[1] !== changesMatch[1]) {
    errors.push(
      `${kind}: legacy_plan_approval_choices must carry matching protected choice labels`,
    );
  }
}

// checkOptionalBoolean — a field that may be absent, but if present must be a
// boolean (e.g. run-stage.single, emitted only for isolated stage runners).
function checkOptionalBoolean(
  o: Record<string, unknown>,
  field: string,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!(field in o)) return;
  if (typeof o[field] !== "boolean") {
    errors.push(`${kind}: ${field} must be boolean, got ${describe(o[field])}`);
  }
}

function checkOptionalPipeline(
  o: Record<string, unknown>,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!("pipeline" in o)) return;
  const value = o.pipeline;
  if (!isPlainObject(value)) {
    errors.push(`${kind}: pipeline must be object, got ${describe(value)}`);
    return;
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== "links" && key !== "completed") {
      errors.push(`${kind}: pipeline unknown key: ${key}`);
    }
  }
  checkStringArray(value, "links", kind, errors);
  checkStringArray(value, "completed", kind, errors);
}

function checkOptionalTrue(
  o: Record<string, unknown>,
  field: string,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!(field in o)) return;
  if (o[field] !== true) {
    errors.push(`${kind}: ${field} must be true when present, got ${describe(o[field])}`);
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

function checkPositiveInteger(
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
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    errors.push(
      `${kind}: ${field} must be a positive integer, got ${describe(v)}`,
    );
  }
}

// checkOptionalStringArray - a field that may be absent, but if present must
// be an array of strings. Mirrors checkStringArray's per-element error wording
// with the checkOptional* early-return idiom.
function checkOptionalStringArray(
  o: Record<string, unknown>,
  field: string,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!(field in o)) return;
  checkStringArray(o, field, kind, errors);
}

function checkOptionalProtocolModules(
  o: Record<string, unknown>,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!("protocol_modules" in o)) return;
  const value = o.protocol_modules;
  if (!Array.isArray(value)) {
    errors.push(
      `${kind}: protocol_modules must be array, got ${describe(value)}`,
    );
    return;
  }
  for (let i = 0; i < value.length; i++) {
    const moduleName = value[i];
    if (
      typeof moduleName !== "string" ||
      !(VALID_PROTOCOL_MODULES as readonly string[]).includes(moduleName)
    ) {
      errors.push(
        `${kind}: protocol_modules[${i}] must be one of ${VALID_PROTOCOL_MODULES.join(" | ")}`,
      );
    }
  }
}

// checkPathTextArray - a required array of {path: string, text: string}
// objects, used by load-steering's deterministic rule-content payload.
function checkPathTextArray(
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
    if (typeof item.text !== "string") {
      errors.push(
        `${kind}: ${field}[${i}].text must be string, got ${describe(item.text)}`,
      );
    }
  });
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

function checkOptionalWave(
  o: Record<string, unknown>,
  field: string,
  kind: DirectiveKind,
  errors: string[],
): void {
  if (!(field in o)) return;
  const value: unknown = o[field];
  if (!isPlainObject(value)) {
    errors.push(`${kind}: ${field} must be object, got ${describe(value)}`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "batch_index" && key !== "entries") {
      errors.push(`${kind}: ${field}: unknown key: ${key}`);
    }
  }
  if (
    typeof value.batch_index !== "number" ||
    !Number.isInteger(value.batch_index) ||
    value.batch_index < 0
  ) {
    errors.push(
      `${kind}: ${field}.batch_index must be a non-negative integer, got ${describe(value.batch_index)}`,
    );
  }
  if (!Array.isArray(value.entries)) {
    errors.push(
      `${kind}: ${field}.entries must be array, got ${describe(value.entries)}`,
    );
    return;
  }
  if (value.entries.length === 0) {
    errors.push(`${kind}: ${field}.entries must contain at least one entry`);
    return;
  }

  const known = new Set([
    "unit",
    "unit_kind",
    "build_required",
    "completion_required",
    "review_state",
    "review_iteration",
    "unit_memory_path",
    "consumes",
    "consumes_absent",
    "produces",
    "required_produces",
  ]);
  const units = new Set<string>();
  value.entries.forEach((item: unknown, i: number) => {
    const prefix = `${kind}: ${field}.entries[${i}]`;
    if (!isPlainObject(item)) {
      errors.push(`${prefix} must be object, got ${describe(item)}`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (!known.has(key)) errors.push(`${prefix}: unknown key: ${key}`);
    }
    if (typeof item.unit !== "string") {
      errors.push(`${prefix}.unit must be string, got ${describe(item.unit)}`);
    } else if (units.has(item.unit)) {
      errors.push(`${prefix}.unit duplicates "${item.unit}"`);
    } else {
      units.add(item.unit);
    }
    if (item.unit_kind !== null && typeof item.unit_kind !== "string") {
      errors.push(
        `${prefix}.unit_kind must be string or null, got ${describe(item.unit_kind)}`,
      );
    }
    if (typeof item.build_required !== "boolean") {
      errors.push(
        `${prefix}.build_required must be boolean, got ${describe(item.build_required)}`,
      );
    }
    if (typeof item.completion_required !== "boolean") {
      errors.push(
        `${prefix}.completion_required must be boolean, got ${describe(item.completion_required)}`,
      );
    }
    if (
      item.review_state !== "outstanding" &&
      item.review_state !== "retry-required" &&
      item.review_state !== "repair-required" &&
      item.review_state !== "recovery-required" &&
      item.review_state !== "escalation-required" &&
      item.review_state !== "READY" &&
      item.review_state !== "NOT-READY" &&
      item.review_state !== "not-required"
    ) {
      errors.push(
        `${prefix}.review_state must be one of outstanding | retry-required | repair-required | recovery-required | escalation-required | READY | NOT-READY | not-required, got ${JSON.stringify(item.review_state)}`,
      );
    }
    if (
      item.review_iteration !== null &&
      (
        typeof item.review_iteration !== "number" ||
        !Number.isInteger(item.review_iteration) ||
        item.review_iteration < 1
      )
    ) {
      errors.push(
        `${prefix}.review_iteration must be a positive integer or null, got ${describe(item.review_iteration)}`,
      );
    }
    for (const key of ["unit_memory_path"] as const) {
      if (typeof item[key] !== "string") {
        errors.push(`${prefix}.${key} must be string, got ${describe(item[key])}`);
      }
    }
    for (const key of ["consumes", "produces", "required_produces"] as const) {
      const nested = item[key];
      if (!Array.isArray(nested)) {
        errors.push(`${prefix}.${key} must be array, got ${describe(nested)}`);
        continue;
      }
      nested.forEach((entry: unknown, j: number) => {
        if (typeof entry !== "string") {
          errors.push(
            `${prefix}.${key}[${j}] must be string, got ${describe(entry)}`,
          );
        }
      });
    }
    if (
      Array.isArray(item.required_produces) &&
      item.required_produces.length === 0
    ) {
      errors.push(
        `${prefix}.required_produces must contain at least one kind-applicable required path`,
      );
    }
    if (Array.isArray(item.produces) && Array.isArray(item.required_produces)) {
      const produces = new Set(item.produces);
      item.required_produces.forEach((path: unknown, j: number) => {
        if (typeof path === "string" && !produces.has(path)) {
          errors.push(
            `${prefix}.required_produces[${j}] must also appear in produces`,
          );
        }
      });
    }
    if (!Array.isArray(item.consumes_absent)) {
      errors.push(
        `${prefix}.consumes_absent must be array, got ${describe(item.consumes_absent)}`,
      );
    } else {
      item.consumes_absent.forEach((entry: unknown, j: number) => {
        if (!isPlainObject(entry)) {
          errors.push(
            `${prefix}.consumes_absent[${j}] must be object, got ${describe(entry)}`,
          );
          return;
        }
        if (typeof entry.path !== "string") {
          errors.push(
            `${prefix}.consumes_absent[${j}].path must be string, got ${describe(entry.path)}`,
          );
        }
        if (typeof entry.expected !== "boolean") {
          errors.push(
            `${prefix}.consumes_absent[${j}].expected must be boolean, got ${describe(entry.expected)}`,
          );
        }
      });
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

function checkUnitClaimRows(
  o: Record<string, unknown>,
  field: string,
  valueField: "holder" | "blocked_by",
  kind: DirectiveKind,
  errors: string[],
): void {
  const value = o[field];
  if (!Array.isArray(value)) {
    errors.push(`${kind}: field ${field} must be an array`);
    return;
  }
  for (let i = 0; i < value.length; i++) {
    const row = value[i];
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      errors.push(`${kind}: ${field}[${i}] must be an object`);
      continue;
    }
    const record = row as Record<string, unknown>;
    if (typeof record.unit !== "string") {
      errors.push(`${kind}: ${field}[${i}].unit must be a string`);
    }
    if (
      valueField === "holder" &&
      typeof record.holder !== "string"
    ) {
      errors.push(`${kind}: ${field}[${i}].holder must be a string`);
    }
    if (
      valueField === "blocked_by" &&
      (
        !Array.isArray(record.blocked_by) ||
        !record.blocked_by.every((entry) => typeof entry === "string")
      )
    ) {
      errors.push(`${kind}: ${field}[${i}].blocked_by must be a string array`);
    }
  }
}

// --- CLI self-check ---
//
// `bun aidlc-directive.ts` constructs one well-formed example of each of the 11
// kinds, validates each, prints one line per kind ("<kind>: VALID" or the
// errors), and exits 0 iff all 11 validate. Satisfies the acceptance check
// "bun .../aidlc-directive.ts validates the 11 kinds".
if (import.meta.main) {
  // One well-formed example per kind. run-stage mirrors the engine design's example
  // directive verbatim (domain-design); the others follow the same catalogue table.
  const examples: Directive[] = [
    {
      kind: "load-steering",
      stage: "domain-design",
      bundle: "sha256:0123456789abcdef",
      part: 1,
      parts: 2,
      rules_content: [
        { path: "aidlc-org.md", text: "## Testing Posture\n\nTests are first-class.\n" },
      ],
      continue_token: "opaque-token",
    },
    {
      kind: "run-stage",
      stage: "domain-design",
      phase: "inception",
      lead_agent: "aidlc-architect-agent",
      support_agents: ["aidlc-aws-platform-agent", "aidlc-design-agent"],
      mode: "inline",
      inline_context_paths: [
        ".claude/agents/aidlc-architect-agent.md",
        ".claude/agents/aidlc-aws-platform-agent.md",
        ".claude/agents/aidlc-design-agent.md",
      ],
      gate: true,
      memory_path: "aidlc-docs/inception/domain-design/memory.md",
      consumes: ["aidlc-docs/inception/requirements/requirements.md"],
      produces: ["aidlc-docs/inception/domain-design/components.md"],
      rules_in_context: [
        "aidlc-org.md",
        "aidlc-team.md",
        "aidlc-project.md",
        "aidlc-phase-inception.md",
      ],
      context_warnings: [
        "Could not read optional knowledge file example.md; fix its permissions.",
      ],
      sensors_applicable: ["required-sections", "upstream-coverage"],
      stage_file: ".claude/aidlc-common/stages/inception/domain-design.md",
      next_stage: "Units Generation",
    },
    {
      kind: "dispatch-subagent",
      stage: "code-generation",
      phase: "construction",
      lead_agent: "aidlc-developer-agent",
      support_agents: ["aidlc-quality-agent"],
      mode: "subagent",
      inline_context_paths: [],
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
      stage: "domain-design",
      phase: "inception",
      memory_path: "aidlc-docs/inception/domain-design/memory.md",
    },
    { kind: "ask", question: "Resume from the last checkpoint, or start fresh?" },
    { kind: "print", message: "AIDLC framework version 0.0.0" },
    { kind: "error", message: 'Unknown scope: "frobnicate"' },
    { kind: "done", reason: "Workflow complete — all in-scope stages approved." },
    { kind: "parked", reason: 'Workflow parked at "feasibility". Resume with /aidlc --resume.', stage: "feasibility" },
    { kind: "notice", message: "Team Unit fan-out is active." },
    // The classify-round-trip skeleton case: gate is the unresolved sentinel,
    // and the first run-stage of a workflow also carries the conductor persona.
    {
      kind: "run-stage",
      stage: "functional-design",
      phase: "construction",
      lead_agent: "aidlc-architect-agent",
      support_agents: ["aidlc-developer-agent"],
      mode: "inline",
      inline_context_paths: [
        ".claude/agents/aidlc-architect-agent.md",
        ".claude/agents/aidlc-developer-agent.md",
      ],
      gate: GATE_UNRESOLVED,
      memory_path: "aidlc-docs/construction/{unit-name}/functional-design/memory.md",
      consumes: [],
      produces: ["aidlc-docs/construction/{unit-name}/functional-design/functional-spec.md"],
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
