// The orchestration engine — the deterministic "what's next?" answerer that
// stands BESIDE the prose orchestrator (skills/aidlc/SKILL.md), not inside it.
// Nothing in SKILL.md calls this file yet; it is exercised only by its own
// unit tests until the differential corpus proves it emits the same directive
// sequence the prose orchestrator produces today. Framework behaviour is
// unchanged by this file's existence.
//
// The engine reads workflow state (aidlc-docs/aidlc-state.md) and the compiled
// stage graph (data/stage-graph.json), then emits EXACTLY ONE typed Directive
// (JSON) to stdout. `next` mutates no workflow state itself (state md5 is
// unchanged across a `next` call). The one transitive exception is `next --init`
// over an EXISTING workspace: to relay the canonical guard message verbatim it
// shells out to the init guard, which appends its own ERROR_LOGGED audit row
// before dying — the guard tool's own behaviour, mirrored from the prose
// orchestrator's relay-the-guard path, not a state write by the engine. The
// directive's `kind` tells the conductor the single move to make next; the
// conductor relays human choices
// and supplies resolved facts, but the engine never originates a deviation,
// never calls AskUserQuestion (that is a Bash tool the conductor owns), and
// never spawns agents. Clean boundaries: a refused or malformed directive is a
// clear signal, not a silent miss — every emitted directive is validated
// against the frozen aidlc-directive.ts contract before it is printed.
//
// Subcommand dispatch table:
//   next   — read-only. Resolve scope (state > flag > env > default), find the
//            workflow's position, and emit one directive. LIVE.
//   report — commit a transition after the conductor acted on a directive.
//            LIVE. A stage-aware dispatcher: it shells out to aidlc-state.ts
//            transitions so the next `next` reads fresh state. Explicit
//            `--stage` pins the acted directive, and a missing gated
//            in-progress state is recovered by opening the gate before approve.
//
// COMPOSE, don't reimplement. Every read composes an existing deterministic
// tool/library function:
//   - aidlc-graph.ts loadGraph()        — the compiled stage graph (one read,
//                                          cached); the node carries every
//                                          routing field the run-stage
//                                          directive needs.
//   - aidlc-lib.ts   nextInScopeStage() — the next EXECUTE stage after a slug
//                                          for a scope (state-override aware).
//   - aidlc-lib.ts   firstInScopeStageOfPhase() — first EXECUTE stage of a
//                                          phase (for the --phase resolution).
//   - aidlc-lib.ts   validScopes()      — the canonical scope-name set, derived
//                                          from scope-mapping.json.
//   - aidlc-lib.ts   getField/parseCheckboxes — state-field + checkbox reads.
//   - aidlc-lib.ts   resolveProjectDir/readStateFile — project-dir + state I/O.
//
// The non-happy-path branches (jump, resume, init, scope/config-change,
// env-scope validation) COMPOSE the sibling CLI tools by SHELLING OUT — none of
// those handlers is an importable symbol (aidlc-jump.ts and aidlc-utility.ts
// both export zero CLI handlers; they are reachable only by argv dispatch). The
// engine spawns the subcommand with Bun.spawnSync, inspects its exitCode, and
// captures its stderr VERBATIM so the user-facing error wording (e.g. the
// canonical `Invalid AWS_AIDLC_DEFAULT_SCOPE "...". Valid scopes: ...`) is
// relayed unchanged rather than reconstructed — reconstruction would drift from
// the tool the rest of the framework asserts on. The one read-only invariant
// `next` keeps: it never spawns a subcommand that MUTATES. The jump-direction
// (resolve) and env-scope (resolve-env-scope) subcommands are pure reads; the
// init guard is spawned ONLY on the already-state-exists path, where the tool
// dies at its guard before any scaffold write.
//
// The things the engine ADDS — not composes — are (1) the decision rule that
// maps (observed state + graph) -> directive kind, and (2) the artifact-path
// resolver that turns the graph node's vocabulary NAMES into canonical
// aidlc-docs/... paths and drops conditional_on consumes-entries against the
// workflow's project type. The primitives above expose the facts; no existing
// query answers "what directive applies here?" and no graph function maps a
// vocabulary name to a path. Both are pure deterministic code — the right home
// per the tool/agent/human split (routing string-building to an LLM would
// invert the whole thesis).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AskDirective,
  type Directive,
  type ErrorDirective,
  GATE_UNRESOLVED,
  type GateValue,
  type PrintDirective,
  type RunStageDirective,
  validateDirective,
} from "./aidlc-directive.ts";
import {
  type CheckboxLine,
  errorMessage,
  firstInScopeStageOfPhase,
  getField,
  nextInScopeStage,
  parseCheckboxes,
  PHASE_NUMBERS,
  PHASES,
  resolveProjectDir,
  type StageEntry,
  stateFilePath,
  validScopes,
  harnessDir,
} from "./aidlc-lib.ts";
import {
  type Consume,
  type GraphStage,
  loadGraph,
  producersOf,
  subgraphForScope,
} from "./aidlc-graph.ts";

// Read the workflow state file if it exists, else null. The engine's `next` is
// a pure read: an absent state file is a legitimate branch (no workflow yet),
// not an error to throw. Composes stateFilePath() for the canonical location.
function loadStateFileIfPresent(projectDir: string): string | null {
  const path = stateFilePath(projectDir);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

// The default scope when neither the state file, a --scope flag, nor the
// AWS_AIDLC_DEFAULT_SCOPE env var supplies one. Mirrors the prose
// orchestrator's freeform-fallback default (SKILL.md detect-scope fallback).
const DEFAULT_SCOPE = "feature";

// Read-only utility flags dispatched before any state inspection (SKILL.md
// "Read-Only Utility Commands"). Each maps to a terminal directive (print)
// rather than running the tool — the engine answers "what move?", and the
// conductor runs the tool and prints its stdout.
const READ_ONLY_FLAGS = new Set([
  "--status",
  "--help",
  "--doctor",
  "--version",
]);

// --- Directive emission ---

// Print exactly one directive as JSON to stdout, after validating it against
// the frozen contract. A malformed directive is a hard error (clean
// boundaries), never a silent miss — we exit non-zero so a wiring bug surfaces
// loudly rather than emitting a lie the conductor would act on.
function emit(directive: Directive): void {
  const result = validateDirective(directive);
  if (!result.valid) {
    console.error(
      `aidlc-orchestrate: refusing to emit a malformed directive: ${result.errors.join("; ")}`,
    );
    process.exit(1);
  }
  console.log(JSON.stringify(result.data));
}

// --- Composing the sibling CLI tools (shell-out) ---
//
// The non-happy-path branches reuse aidlc-jump.ts / aidlc-utility.ts handlers,
// none of which is importable (both files export zero CLI handlers). We resolve
// the tools directory off THIS module's own location so the spawned `bun <tool>`
// runs the same shipped copy regardless of the caller's cwd.
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

function toolPath(file: string): string {
  return join(TOOLS_DIR, file);
}

// The result of spawning a sibling tool: its exit code plus captured streams.
// stderr carries the tool's canonical error envelope on a non-zero exit (the
// shared die()/emitError() helper prints `{"error":"<verbatim message>"}` to
// stderr and exits 1), which we relay UNCHANGED into an error directive.
interface ToolRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runTool(toolFile: string, args: string[]): ToolRun {
  const proc = Bun.spawnSync({
    cmd: ["bun", toolPath(toolFile), ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

// Extract the human-facing message from a tool's failure. The shared error
// helper prints `{"error":"<message>"}` to stderr; we unwrap that envelope so
// the directive carries the message itself (e.g. the verbatim
// `Invalid AWS_AIDLC_DEFAULT_SCOPE "...". Valid scopes: ...`) rather than the
// JSON wrapper. If stderr is not the expected envelope (an unexpected crash),
// fall back to the raw stderr so nothing is swallowed.
function toolErrorMessage(run: ToolRun): string {
  const raw = run.stderr.trim();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
    ) {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return raw.length > 0 ? raw : run.stdout.trim();
}

// --- Terminal-directive constructors (the non-run-stage kinds) ---

function askDirective(question: string): AskDirective {
  return { kind: "ask", question };
}

function printDirective(message: string): PrintDirective {
  return { kind: "print", message };
}

function errorDirective(message: string): ErrorDirective {
  return { kind: "error", message };
}

// --- Flag parsing ---

interface ParsedFlags {
  scope?: string;
  stage?: string;
  phase?: string;
  depth?: string;
  testStrategy?: string;
  readOnly?: string; // the matched read-only flag, if any
  init?: boolean; // --init: scaffold the workspace (guard-checked)
  force?: boolean; // --force: bypass the init/state-exists guard
  resume?: boolean; // --resume: re-enter an existing workflow (resume choice)
  testRun?: boolean; // --test-run: CI/automation mode (rides through to a jump's execute)
  single?: boolean; // --single: run ONE stage under a synthetic workflow id, never touching the main pointer
  intent?: string; // freeform request text (no leading --flag)
  projectDir?: string;
}

// Extract the flags the `next` decision rule consumes. --project-dir is pulled
// out by the caller before this runs; here we read scope/stage/phase/depth/
// test-strategy, the boolean mode flags (--init/--force/--resume), and detect a
// read-only utility flag. Any leading non-flag token is the freeform intent
// (mirrors `/aidlc <freeform description>`). Mirrors the prose orchestrator's
// flag extraction — the value of a valued flag is the following argv token.
function parseNextFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {};
  const intentWords: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (READ_ONLY_FLAGS.has(a)) {
      flags.readOnly = a;
      continue;
    }
    if (a === "--init") {
      flags.init = true;
    } else if (a === "--force") {
      flags.force = true;
    } else if (a === "--resume") {
      flags.resume = true;
    } else if (a === "--test-run") {
      flags.testRun = true;
    } else if (a === "--single") {
      flags.single = true;
    } else if (a === "--scope" && i + 1 < args.length) {
      flags.scope = args[i + 1];
      i++;
    } else if (a === "--stage" && i + 1 < args.length) {
      flags.stage = args[i + 1];
      i++;
    } else if (a === "--phase" && i + 1 < args.length) {
      flags.phase = args[i + 1];
      i++;
    } else if (a === "--depth" && i + 1 < args.length) {
      flags.depth = args[i + 1];
      i++;
    } else if (a === "--test-strategy" && i + 1 < args.length) {
      flags.testStrategy = args[i + 1];
      i++;
    } else if (!a.startsWith("--")) {
      intentWords.push(a);
    }
  }
  if (intentWords.length > 0) flags.intent = intentWords.join(" ");
  return flags;
}

// The workflow-birth print for an EXPLICITLY NAMED scope on a fresh workspace
// (no aidlc-docs/aidlc-state.md). A user who names a scope — `next --scope
// bugfix` or the bare positional `next bugfix` — asked to START a workflow;
// there is nothing to run until the workspace is scaffolded, and scaffolding
// is a mutation (init's job), so `next` names the move as a run-then-continue
// print and the conductor runs it, then re-runs `next` to land on the first
// stage. Threads --depth / --test-strategy / --test-run onto the named init
// command (mirrors Branch 3's flag-threading idiom; `aidlc-utility.ts init`
// accepts all three). Shared by Branch 7b (valid-scope positional) and
// Branch 9 (explicit --scope flag) so the two explicit-naming shapes emit
// byte-identical directives. The harness dir is resolved through harnessDir()
// so the directive names the right tree on every harness (.claude/.kiro/.codex).
function birthPrintDirective(scope: string, flags: ParsedFlags): PrintDirective {
  const cmd = [`init --scope ${scope}`];
  if (flags.depth) cmd.push(`--depth ${flags.depth}`);
  if (flags.testStrategy) cmd.push(`--test-strategy ${flags.testStrategy}`);
  if (flags.testRun) cmd.push("--test-run");
  return printDirective(
    `Run \`bun ${harnessDir()}/tools/aidlc-utility.ts ${cmd.join(" ")}\` to start the workflow, then re-run \`next\` to continue.`,
  );
}

// --- The decision rule (the engine's one ADDED responsibility) ---
//
// Maps (state + graph + resolved scope) -> directive kind. Read-only and
// terminal branches resolve first; the happy path resolves a run-stage off the
// graph node. The branches that need a human turn (resume / scope-confirm) emit
// `ask`; init / scope-change / config-change name the conductor's move via
// `print` (the mutation stays conductor-side, `next` is read-only); jumps relay
// the tool-computed direction. Under an autonomy grant the happy path emits
// `invoke-swarm` for an eligible Construction batch (the conductor fans the
// per-unit build stage out across worktrees — see tryEmitSwarm). The remaining kinds —
// `present-gate` and `dispatch-subagent` — arrive in later waves; this handler
// emits run-stage / invoke-swarm / print / error / ask / done and cleanly omits
// those two.

// Resolve the scope by the precedence ladder: state file Scope field wins (an
// active workflow is authoritative), then an explicit --scope flag, then the
// AWS_AIDLC_DEFAULT_SCOPE env var, then the default. Returns the resolved scope
// plus whether it was found in the valid set (an unknown scope is the caller's
// to turn into an error directive).
function resolveScope(
  stateContent: string | null,
  flags: ParsedFlags,
): { scope: string; source: "state" | "flag" | "env" | "default" } {
  const stateScope = stateContent ? getField(stateContent, "Scope") : null;
  if (stateScope && stateScope.length > 0) {
    return { scope: stateScope, source: "state" };
  }
  if (flags.scope && flags.scope.length > 0) {
    return { scope: flags.scope, source: "flag" };
  }
  const envScope = process.env.AWS_AIDLC_DEFAULT_SCOPE;
  if (envScope && envScope.length > 0) {
    return { scope: envScope, source: "env" };
  }
  return { scope: DEFAULT_SCOPE, source: "default" };
}

// Derive the memory diary path for a stage (SKILL.md: every stage keeps
// aidlc-docs/<phase>/<stage>/memory.md). Per-unit Construction stages embed a
// {unit-name} segment that a later engine change resolves; until then the bare
// phase/slug form is the faithful, deterministic derivation.
function memoryPathFor(phase: string, slug: string): string {
  return `aidlc-docs/${phase}/${slug}/memory.md`;
}

// Derive the stage file path from phase + slug (the shipped layout:
// .claude/aidlc-common/stages/<phase>/<slug>.md — relocated to the shared
// aidlc-common/ spine, a peer of skills/). Matches the engine design's example
// directive's stage_file field.
function stageFileFor(phase: string, slug: string): string {
  return `${harnessDir()}/aidlc-common/stages/${phase}/${slug}.md`;
}

// --- The conductor persona (decision D-E, SPIKE 6) ---
//
// The conductor's execution-quality prose lives ONCE at
// `.claude/aidlc-common/conductor.md` (a root-level peer of skills/). Skills do
// NOT reference it by path; instead the engine reads it and bakes its contents
// into the FIRST run-stage directive of a workflow, so the conductor receives
// its persona in-context with zero per-skill diligence (per the engine design). The file
// is resolved relative to THIS module (tools/ → ../aidlc-common/) so the shipped
// copy is read regardless of the caller's cwd, mirroring how stage files resolve.
const CONDUCTOR_PERSONA_PATH = join(TOOLS_DIR, "..", "aidlc-common", "conductor.md");

// Read the conductor persona, or null if it is absent (a fork that deleted it,
// or a partial install). The delivery is best-effort: a missing persona is not a
// routing error — the run-stage directive is still well-formed without the
// optional field — so we never fail the workflow over it.
function readConductorPersona(): string | null {
  if (!existsSync(CONDUCTOR_PERSONA_PATH)) return null;
  try {
    return readFileSync(CONDUCTOR_PERSONA_PATH, "utf-8");
  } catch {
    return null;
  }
}

// "First run-stage of the workflow" — the deterministic signal D-E delivery
// keys on. The engine is stateless per call, so it cannot track a "session";
// the faithful, reproducible proxy is the WORKFLOW's opening move: no non-init
// stage has been completed yet. We read the completed-checkbox count from state
// — zero completed EXECUTE stages outside initialization means the conductor is
// at the very start of real work and has not yet been handed the persona. (Init
// stages are bootstrap and auto-proceed; a workflow that has only finished init
// is still at its first substantive run-stage.) Resume re-enters via the `ask`
// branch, not a run-stage, so this does not double-deliver on resume of an
// in-flight workflow; a resume that lands back on the very first stage correctly
// re-delivers, which is harmless (the persona is idempotent in-context).
//
// HONEST LIMITATION: because the engine has no session memory, "first" means
// "first of the workflow's substantive stages", not "first call this session".
// In a long single session the persona is delivered once (at workflow open) and
// the conductor carries it; a fresh session resuming mid-workflow relies on the
// persona persisting in the prior context OR on the Stop-hook/loop re-priming —
// it is NOT re-baked mid-workflow. This is the SPIKE-6 contract (deliver on the
// opening directive); documented here so the boundary is visible, not faked.
function isFirstRunStageOfWorkflow(
  stateContent: string | null,
  node: GraphStage,
): boolean {
  if (!stateContent) return false; // no workflow yet → no run-stage emitted anyway
  // An initialization stage is bootstrap; the persona belongs to substantive
  // work, so we never attach it to an init run-stage (those auto-proceed).
  if (node.phase === "initialization") return false;
  const checkboxes = parseCheckboxes(stateContent);
  // Count completed/skipped NON-initialization stages. Zero → this is the first
  // substantive stage the conductor will run, so deliver the persona now.
  const initSlugs = new Set(
    loadGraph().filter((s) => s.phase === "initialization").map((s) => s.slug),
  );
  const advancedSubstantive = checkboxes.some(
    (c) =>
      !initSlugs.has(c.slug) &&
      (c.state === "completed" || c.state === "skipped"),
  );
  return !advancedSubstantive;
}

// --- The walking-skeleton classify round-trip (per the engine design) ---
//
// The first Construction Bolt's gate depends on the walking-skeleton STANCE,
// which an LLM resolves by reading a team's free-form `## Walking Skeleton`
// practices prose. The engine cannot classify free English, so it DEFERS: it
// emits `gate: "unresolved"` for that one stage, the conductor classifies and
// reports the stance (recorded in the state field below), and the next `next`
// resolves the gate from the recorded stance. Every OTHER run-stage keeps its
// boolean gate.

// The state field the conductor's classified stance is recorded in (written by
// `report --skeleton-stance`, read by the next `next`). One of the three stance
// values, or absent before the round-trip completes.
const SKELETON_STANCE_FIELD = "Skeleton Stance";
type SkeletonStance = "on" | "off" | "scope-dependent";
const VALID_SKELETON_STANCES: ReadonlySet<string> = new Set([
  "on",
  "off",
  "scope-dependent",
]);

// The scope-mapping fallback the "scope-dependent" stance resolves through
// (SKILL.md:686-692, verbatim): skeleton-on for greenfield-shaped scopes,
// skeleton-off for incremental-work scopes. `infra` is greenfield-shaped, so it
// is skeleton-on — and it DOES reach the skeleton gate: its first in-scope
// construction stage is `nfr-requirements` (code-generation is SKIP for infra,
// but nfr-requirements EXECUTEs and is what isSkeletonGateStage matches), so an
// `infra` Construction workflow emits gate:"unresolved" at nfr-requirements and
// resolves through this set like any other greenfield scope.
const SKELETON_ON_SCOPES: ReadonlySet<string> = new Set([
  "enterprise",
  "mvp",
  "feature",
  "poc",
  "workshop",
  "infra",
]);

// Read the recorded skeleton stance from state, or null if the round-trip has
// not completed yet (the field is absent or empty). Composes getField.
function readSkeletonStance(stateContent: string | null): SkeletonStance | null {
  const raw = stateContent ? getField(stateContent, SKELETON_STANCE_FIELD) : null;
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  return VALID_SKELETON_STANCES.has(lower) ? (lower as SkeletonStance) : null;
}

// The state field recording the human's autonomy grant at the walking-skeleton
// ladder (stage-protocol.md "Ladder prompt" — set via `aidlc-bolt set-autonomy
// --mode <autonomous|gated>`). ONLY the exact value "autonomous" triggers the
// swarm; unset / absent / "gated" all read as not-autonomous (the safe default —
// the human stays in the gate loop). This is deliberately strict: an empty or
// unrecognised value never auto-activates the swarm fan-out.
const AUTONOMY_MODE_FIELD = "Construction Autonomy Mode";

// Read the recorded Construction autonomy mode, or null when it is not exactly
// "autonomous". Mirrors readSkeletonStance's read-and-narrow shape. The swarm
// trigger checks `=== "autonomous"`, so any other value (including "gated") is
// safely treated as "not granted".
function readAutonomyMode(stateContent: string | null): "autonomous" | null {
  const raw = stateContent ? getField(stateContent, AUTONOMY_MODE_FIELD) : null;
  if (!raw) return null;
  return raw.trim() === "autonomous" ? "autonomous" : null;
}

// Read the compiled batch DAG (the Bolt/unit topological levels) off the
// runtime graph that `aidlc-runtime compile` materialises. Returns the
// `batches` array (each inner array is one parallel batch = one topological
// level) or null when there is no graph file or no bolt_dag node. A pure read:
// an absent graph is a legitimate branch (the swarm simply does not trigger).
function readBoltDagBatches(projectDir: string): string[][] | null {
  const path = join(projectDir, "aidlc-docs", "runtime-graph.json");
  if (!existsSync(path)) return null;
  try {
    const graph: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (graph !== null && typeof graph === "object" && "bolt_dag" in graph) {
      const boltDag = (graph as { bolt_dag?: { batches?: unknown } }).bolt_dag;
      const batches = boltDag?.batches;
      if (Array.isArray(batches)) return batches as string[][];
    }
  } catch {
    // Malformed runtime graph — fail safe to "no DAG"; the swarm does not fire.
  }
  return null;
}

// True when `node` is the SKELETON-GATE stage for `scope` — the FIRST
// Construction EXECUTE stage in scope (the start of Bolt 1). This is derived,
// not hardcoded: firstInScopeStageOfPhase("construction", scope) walks the
// scope's EXECUTE-only sub-DAG and returns its first construction stage (e.g.
// functional-design for feature/enterprise/mvp/refactor/workshop, code-generation
// for poc/bugfix/security-patch, nfr-requirements for infra). A scope-mapping
// edit that moves the first construction stage moves the skeleton gate with it,
// no code change. Non-construction stages are never the skeleton gate.
function isSkeletonGateStage(node: GraphStage, scope: string): boolean {
  if (node.phase !== "construction") return false;
  const first = firstInScopeStageOfPhase("construction", scope);
  return first !== null && first.slug === node.slug;
}

// Resolve the determined boolean gate for the skeleton-gate stage once the
// conductor's classified stance is in hand. The round-trip's whole point is to
// turn "unresolved" into a DETERMINED boolean; this function is that resolution.
//
// The faithful answer (SKILL.md:655-720 — the per-Bolt steps + the walking-
// skeleton section) is that the FIRST construction stage gates in every stance.
// Both skeleton-on AND skeleton-off present a gate at Bolt 1: skeleton-on forces
// an always-gate "regardless of Construction Autonomy Mode" (SKILL.md Step 5 /
// "When skeleton-on" §1); skeleton-off runs Bolt 1 "as a regular Bolt with the
// standard batch-gate path", and since `Construction Autonomy Mode` is `unset`
// (treated as `gated`) until the post-Bolt-1 ladder prompt sets it, that batch
// gate IS presented (it is only skipped when `autonomous`, which cannot be true
// before Bolt 1 ships). The stance changes the CEREMONY (solo + always-gate +
// ladder prompt vs regular Bolt + batch gate) — orchestration the conductor
// runs — not whether a gate is presented at Bolt 1. The gate axis is on for all
// construction work (only bootstrap init stages auto-proceed; gate-axis ≠
// execution-axis). So the resolved value is `true` for every stance.
//
// Why the round-trip still earns its keep: the engine cannot EMIT a boolean it
// has not determined. Classifying the prose is what rules out a stance that
// WOULD change Bolt-1 routing; only after the conductor hands back a typed
// stance can the engine commit the determined gate. The value being true in
// every branch is the correct outcome, not a no-op — the determinism is in
// having classified, not in the boolean differing per stance. `scope` and the
// scope-default set are threaded through so the resolution reads against the
// SKILL.md rules verbatim and a future scope/ceremony change resolves here, in
// one legible place, rather than silently.
function resolveSkeletonGate(stance: SkeletonStance, scope: string): boolean {
  switch (stance) {
    case "on":
      // skeleton-on: always-gate at Bolt 1.
      return true;
    case "off":
      // skeleton-off: regular Bolt; the standard gate is still presented at
      // Bolt 1 (autonomy is gated until the post-Bolt-1 ladder sets it).
      return true;
    case "scope-dependent": {
      // Fall back to the scope-mapping defaults to SELECT the ceremony
      // (greenfield → skeleton-on, incremental → skeleton-off); either ceremony
      // presents a gate at Bolt 1, so the determined gate is true regardless.
      const _ceremony: SkeletonStance = SKELETON_ON_SCOPES.has(scope)
        ? "on"
        : "off";
      return resolveSkeletonGate(_ceremony, scope);
    }
  }
}

// --- Artifact path resolution (the engine's deterministic string-building) ---
//
// The compiled stage-graph.json carries artifacts as VOCABULARY NAMES, not
// paths: produces is a bare-name array (e.g. ["components","decisions"]) and
// consumes is an array of {artifact, required, conditional_on?} objects. The
// conductor must act on an aidlc-docs/... path, so the engine resolves names →
// paths at emit time and never asks the conductor to re-derive them. This is
// pure deterministic string-building — the textbook tool job (the engine design:
// "computes the paths ... routing string-building to an LLM would invert the
// whole thesis"). The mapping is documented at
// docs/reference/16-artifact-vocabulary.md:144-167.

// The per-unit marker carried by the five Construction stages that run once per
// Unit of Work. It lives on the stage's `for_each` field (stage frontmatter,
// compiled onto the GraphStage and into stage-graph.json) — NOT as a
// `**Per-Unit:**` line (no such field exists) and NOT behind a later wave. The
// canonical 5-stage set (nfr-requirements, nfr-design, functional-design,
// infrastructure-design, code-generation) is the defensive cross-check; the
// node's own `for_each` is the source of truth so a future per-unit stage is
// picked up without editing this file.
const PER_UNIT_FOR_EACH = "unit-of-work";
const KNOWN_PER_UNIT_STAGES: ReadonlySet<string> = new Set([
  "nfr-requirements",
  "nfr-design",
  "functional-design",
  "infrastructure-design",
  "code-generation",
]);

// The literal token used in the per-unit path shape when no concrete Unit of
// Work is supplied at emit time. The unit value comes from active Bolt context
// (a later engine increment threads it in); when absent, the faithful emission
// is the documented `{unit-name}` placeholder shape, matching
// 16-artifact-vocabulary.md:159.
const UNIT_NAME_PLACEHOLDER = "{unit-name}";

// True when the node runs once per Unit of Work. Reads the node's own
// `for_each` marker (source of truth); the known-set membership is a defensive
// cross-check so a typo'd marker on one of the five canonical stages still
// resolves per-unit.
function isPerUnit(node: GraphStage): boolean {
  return node.for_each === PER_UNIT_FOR_EACH || KNOWN_PER_UNIT_STAGES.has(node.slug);
}

// Resolve a single artifact vocabulary name to its canonical aidlc-docs/... path
// UNDER THE STAGE THAT OWNS THE FILE. Non-per-unit stages map to
// `aidlc-docs/<phase>/<stage-slug>/<name>.md`; per-unit Construction stages
// inject a `{unit-name}` segment: `aidlc-docs/construction/{unit}/<stage>/<name>.md`.
// `unit` defaults to the documented placeholder token; a caller with active
// Bolt context passes the concrete unit name to materialise the real path. The
// {unit-name} segment is INJECTED here — it never appears in the node's
// structured produces[]/consumes[] (those are bare names even for per-unit
// stages); it lives only in the node's prose `outputs` string.
//
// `owner` is the stage whose directory the artifact lives under — the stage
// that PRODUCES it. For produces[] the owner is trivially the directive's own
// node (the node IS the producer). For consumes[] the owner is the OTHER stage
// that produced the artifact (resolved via producersOf), because a consumed
// artifact is "a canonical identifier declared by exactly one PRODUCING stage"
// (docs/reference/16-artifact-vocabulary.md:20-24, 44-48) and lives in that
// producer's directory, NOT the consuming stage's. The per-unit decision is
// likewise the OWNER's — a consume of a per-unit-produced artifact resolves
// under construction/{unit}/<producer>/, a consume of a non-per-unit artifact
// under <producer-phase>/<producer-slug>/ with no construction prefix.
function resolveArtifactPath(
  name: string,
  owner: GraphStage,
  unit: string,
): string {
  if (isPerUnit(owner)) {
    return `aidlc-docs/construction/${unit}/${owner.slug}/${name}.md`;
  }
  return `aidlc-docs/${owner.phase}/${owner.slug}/${name}.md`;
}

// Resolve a CONSUMED artifact's path. A consumed artifact lives under the stage
// that PRODUCES it (the 1:1 producer rule above), so we key the path on the
// producer node — never on the consuming `node`. producersOf returns the
// producing stages; the verified graph invariant is exactly one producer per
// artifact (a clean 1:1 map), so producersOf(name)[0] is the owner. Defensive
// fallback: if no producer is found (an orphan consume — a graph defect the
// doctor surfaces, not expected in the shipped graph), resolve under the
// consuming node's own directory rather than crash, so the engine still emits a
// well-formed directive.
function resolveConsumePath(
  name: string,
  node: GraphStage,
  unit: string,
): string {
  const producer = producersOf(name)[0];
  return resolveArtifactPath(name, producer ?? node, unit);
}

// Normalise the workflow's Project Type to the lowercase token the graph's
// conditional_on values use ("brownfield"/"greenfield"), or null when state is
// absent or the field is unset. Composes getField for the canonical state read.
function projectTypeFrom(
  stateContent: string | null,
): "brownfield" | "greenfield" | null {
  const raw = stateContent ? getField(stateContent, "Project Type") : null;
  if (!raw) return null;
  const lower = raw.toLowerCase();
  return lower === "brownfield" || lower === "greenfield" ? lower : null;
}

// Resolve a node's consumes[] to canonical paths, dropping conditional_on
// entries that don't match the project type. The drop guard mirrors the verbatim
// idiom in aidlc-graph.ts:733-739 (validateScope): an entry conditional on a
// project type other than the workflow's is excluded. When projectType is null
// (no state / unset field) the filter is a no-op — every entry is kept and
// resolved, matching the prose orchestrator's "list everything when type is
// unknown" behaviour. Each surviving entry resolves UNDER ITS PRODUCER (see
// resolveConsumePath): the filter decides WHICH consumes appear; the producer
// lookup decides WHERE each one lives. `node` is passed only for the orphan
// fallback, not as the resolution key.
function resolveConsumes(
  consumes: Consume[],
  node: GraphStage,
  projectType: "brownfield" | "greenfield" | null,
  unit: string,
): string[] {
  const paths: string[] = [];
  for (const consume of consumes) {
    if (
      consume.conditional_on &&
      projectType &&
      consume.conditional_on !== projectType
    ) {
      continue;
    }
    paths.push(resolveConsumePath(consume.artifact, node, unit));
  }
  return paths;
}

// Resolve a node's produces[] (always bare names, even for per-unit stages) to
// canonical paths. produces has no conditional_on axis, so every name resolves.
function resolveProduces(node: GraphStage, unit: string): string[] {
  return (node.produces ?? []).map((name) =>
    resolveArtifactPath(name, node, unit),
  );
}

// Compute the `gate` value for a run-stage directive — the human-judgement
// boundary axis. Three outcomes:
//   - initialization stage → false (bootstrap auto-proceed, no governance gate).
//   - the skeleton-gate stage (first Construction EXECUTE stage of the scope =
//     Bolt 1) with NO stance recorded yet → GATE_UNRESOLVED, the classify
//     round-trip sentinel. The conductor classifies `## Walking Skeleton` prose
//     and reports the stance; the next `next` re-emits with the determined gate.
//   - everything else (incl. the skeleton stage AFTER the stance is recorded) →
//     the determined boolean (true for every EXECUTE stage outside init).
//
// gate is ORTHOGONAL to the conditional-inclusion axis (`execution`
// ALWAYS|CONDITIONAL answers "is this stage included", not "does it gate"). The
// node-level gate stays true for construction stages; Construction-Bolt autonomy
// is a separate runtime axis. The init-batching note still holds: the engine
// models the 3 init stages as individual gate:false run-stages (masked on every
// real path; only a synthetic mid-init fixture surfaces one — t118's gate-axis
// anchor).
function computeGate(
  node: GraphStage,
  scope: string,
  stateContent: string | null,
): GateValue {
  if (node.phase === "initialization") return false;
  if (isSkeletonGateStage(node, scope)) {
    const stance = readSkeletonStance(stateContent);
    // No stance yet → defer (the classify round-trip). The conductor will
    // report a stance and the next `next` lands in the resolved branch below.
    if (stance === null) return GATE_UNRESOLVED;
    return resolveSkeletonGate(stance, scope);
  }
  // Every other EXECUTE stage gates deterministically.
  return true;
}

// Build a run-stage directive by reading the routing fields straight off the
// compiled graph node. consumes/produces carry RESOLVED aidlc-docs/... paths:
// the engine resolves the node's vocabulary names → paths at emit time (so the
// conductor never re-derives them) and drops conditional_on consumes-entries
// against the workflow's Project Type. rules_in_context maps to the node's
// resolved rule paths; sensors_applicable maps to the node's resolved sensor ids.
// `unit` is the active Unit of Work for per-unit Construction stages; callers
// without Bolt context omit it and the per-unit path keeps the {unit-name}
// placeholder. `scope` + `stateContent` feed the gate computation (the skeleton
// round-trip) and the first-run-stage persona delivery (decision D-E).
function buildRunStageDirective(
  node: GraphStage,
  projectType: "brownfield" | "greenfield" | null = null,
  unit: string = UNIT_NAME_PLACEHOLDER,
  scope: string = DEFAULT_SCOPE,
  stateContent: string | null = null,
): RunStageDirective {
  const directive: RunStageDirective = {
    kind: "run-stage",
    stage: node.slug,
    phase: node.phase,
    lead_agent: node.lead_agent,
    support_agents: node.support_agents ?? [],
    // The graph constrains mode to inline|subagent today; the directive's
    // mode enum is inline|subagent|agent-team. The node value is always one
    // of the first two, so it satisfies the contract; the validator is the
    // backstop if a future graph adds agent-team.
    mode: node.mode as RunStageDirective["mode"],
    gate: computeGate(node, scope, stateContent),
    memory_path: memoryPathFor(node.phase, node.slug),
    consumes: resolveConsumes(node.consumes ?? [], node, projectType, unit),
    produces: resolveProduces(node, unit),
    rules_in_context: (node.rules_in_context ?? []).map((r) => r.path),
    sensors_applicable: (node.sensors_applicable ?? []).map((s) => s.id),
    stage_file: stageFileFor(node.phase, node.slug),
  };
  // Reviewer — include if the stage declares one (§12a).
  if (node.reviewer) {
    directive.reviewer = node.reviewer;
    directive.reviewer_max_iterations = node.reviewer_max_iterations ?? 2;
  }
  // Decision D-E: bake the conductor persona into the FIRST run-stage of the
  // workflow. The optional field is omitted on every later directive (the
  // persona persists in the session once delivered). A missing conductor.md is
  // best-effort — the directive stays well-formed without the field.
  if (isFirstRunStageOfWorkflow(stateContent, node)) {
    const persona = readConductorPersona();
    if (persona !== null) directive.conductor_persona = persona;
  }
  return directive;
}

// Find the graph node for a slug. Composes loadGraph() (the one cached read).
function nodeForSlug(slug: string): GraphStage | undefined {
  return loadGraph().find((s) => s.slug === slug);
}

// The `next` handler — pure read, emits exactly one directive.
function handleNext(args: string[], projectDir: string | undefined): void {
  const flags = parseNextFlags(args);

  // Branch 1 — read-only utility flags dispatch FIRST, before any state
  // inspection (SKILL.md absolute-precedence rule: --status/--help/--doctor/
  // --version run even when a state file exists). The engine names the move as
  // a print directive; the conductor runs the matching tool and prints its
  // stdout verbatim.
  if (flags.readOnly) {
    emit({
      kind: "print",
      message: `Run the read-only utility for ${flags.readOnly} and print its output verbatim.`,
    });
    return;
  }

  // Branch 2 — mutually-exclusive --stage + --phase (SKILL.md step 6). The
  // message is VERBATIM from SKILL.md:120 so the prose and the engine emit the
  // same user-facing text.
  if (flags.stage && flags.phase) {
    emit(errorDirective(
      "Cannot use --stage and --phase together. Use one or the other.",
    ));
    return;
  }

  const pd = resolveProjectDir(projectDir);
  const stateContent = loadStateFileIfPresent(pd);

  // Branch 3 — --init (SKILL.md:134). Scaffolding the workspace is a mutation,
  // so `next` never performs it; it names the move (print) or relays the guard
  // rejection (error). The ONE guard `next` can verify read-only is "state
  // already exists" — and in exactly that case the `init` tool dies at its own
  // guard BEFORE writing anything, so we shell out to capture the VERBATIM
  // `aidlc-state.md already exists at ... Use --force to reinitialize.` message
  // rather than reconstruct it. With --force, or on a clean workspace, init
  // would mutate, so we do NOT spawn it — we emit a print naming the command.
  if (flags.init) {
    if (stateContent && !flags.force) {
      const initArgs = ["init", "--project-dir", pd];
      if (flags.scope) initArgs.push("--scope", flags.scope);
      const run = runTool("aidlc-utility.ts", initArgs);
      if (!run.ok) {
        emit(errorDirective(toolErrorMessage(run)));
        return;
      }
      // Defensive: the guard should have failed above. If the tool somehow
      // succeeded, fall through to naming the move rather than asserting.
    }
    const cmd = ["init"];
    if (flags.scope) cmd.push(`--scope ${flags.scope}`);
    if (flags.depth) cmd.push(`--depth ${flags.depth}`);
    if (flags.force) cmd.push("--force");
    if (flags.testRun) cmd.push("--test-run");
    emit(printDirective(
      `Run \`bun ${harnessDir()}/tools/aidlc-utility.ts ${cmd.join(" ")}\` to scaffold the workspace, then print its output verbatim and stop.`,
    ));
    return;
  }

  // Resolve scope by the precedence ladder before any graph lookup.
  const { scope, source } = resolveScope(stateContent, flags);

  // Branch 3b — UNCONDITIONAL --scope validation. An explicit `--scope` flag is
  // validated even when state supplies a valid scope that wins the precedence
  // ladder (Wave-1 audit finding 4). Without this, `next --scope bogus` over a
  // valid-scope workflow silently runs the current stage — the resolved scope is
  // the (valid) state scope, so the unknown-scope check below never sees the
  // bogus flag. The prose orchestrator errors unconditionally (SKILL.md:110), so
  // we mirror that with the SAME wording the no-state path already emits. A VALID
  // `--scope` that differs from the state scope is a legitimate scope-change and
  // passes this check, reaching Branch 5 below; a valid same-as-state flag is a
  // no-op that falls through to the happy path.
  if (flags.scope && !validScopes().has(flags.scope)) {
    const valid = [...validScopes()].join(", ");
    emit(errorDirective(
      `Unknown scope "${flags.scope}". Valid scopes: ${valid}.`,
    ));
    return;
  }

  // Branch 4 — env-scope validation. When the scope was supplied by
  // AWS_AIDLC_DEFAULT_SCOPE, the canonical validator owns the error wording.
  // Shell out to `resolve-env-scope` (a pure read) and relay its VERBATIM
  // `Invalid AWS_AIDLC_DEFAULT_SCOPE "...". Valid scopes: ...` on a non-zero
  // exit — do NOT reconstruct it via validScopes(), which would drift from the
  // string downstream tests + SKILL.md:101 assert on. This precedes the generic
  // unknown-scope check so the env-specific wording wins for the env source.
  if (source === "env") {
    const run = runTool("aidlc-utility.ts", ["resolve-env-scope"]);
    if (!run.ok) {
      emit(errorDirective(toolErrorMessage(run)));
      return;
    }
  }

  // An unresolvable (unknown) scope is a hard error — the engine cannot derive
  // a path through a scope it doesn't know. Mirrors the prose orchestrator's
  // verbatim "Unknown scope" error so downstream assertions hold.
  if (!validScopes().has(scope)) {
    const valid = [...validScopes()].join(", ");
    emit(errorDirective(`Unknown scope "${scope}". Valid scopes: ${valid}.`));
    return;
  }

  // Read the workflow's Project Type once — it feeds the conditional_on filter
  // when any run-stage directive resolves its consumes paths below. Null when
  // there is no state file or the field is unset (the filter then keeps every
  // entry).
  const projectType = projectTypeFrom(stateContent);

  // Branch 4b — --single stage-runner mode. A stage-runner skill
  // (skills/aidlc-<stage>/) drives ONE stage in isolation: `next --stage <slug>
  // --single` emits exactly one run-stage directive for <slug> and STOPS. The
  // load-bearing invariant is the POINTER RULE: a single-stage run NEVER touches
  // the main workflow's `Current Stage`. The with-state jump path (Branch 7) would
  // pivot Current Stage (it emits a `print` naming `aidlc-jump.ts execute`, a
  // mutation), so --single must short-circuit it and emit the run-stage DIRECTLY
  // here — exactly the read-only no-state `next --stage` shape, but unconditional
  // on whether a main workflow exists. The companion `report --single` commits the
  // STAGE_STARTED/STAGE_COMPLETED pair under a synthetic workflow id (audit only);
  // it never dispatches advance/approve/complete-workflow, so the main pointer is
  // structurally untouchable from a single-stage run. This branch precedes Branch
  // 5 (scope/config-change) and Branch 7 (jump) so neither mutating path is reached
  // under --single.
  if (flags.single) {
    if (flags.phase) {
      // A single run targets ONE stage; --phase is a range, so the two are
      // mutually exclusive (mirrors the --stage/--phase guard above).
      emit(errorDirective(
        "Cannot use --single with --phase. --single runs one stage; pass --stage <slug>.",
      ));
      return;
    }
    if (!flags.stage) {
      emit(errorDirective(
        "--single requires --stage <slug>. A stage-runner runs exactly one named stage.",
      ));
      return;
    }
    emitSingleRunStage(flags.stage, scope, projectType);
    return;
  }

  // Branch 5 — natural-language scope/depth/test-strategy change against an
  // existing workflow (SKILL.md:141/:144/:147 + step 7/8). Changing scope or
  // config is a MUTATION, so `next` names the move (print) and the conductor
  // runs the tool; it never mutates here. Fires only when a modifier is present
  // WITHOUT an explicit --stage/--phase jump (those take the jump path below).
  if (stateContent && !flags.stage && !flags.phase) {
    // A scope-change requires a VALID --scope that DIFFERS from the active
    // workflow's scope. An invalid or same-as-current --scope is not a change —
    // state wins on the precedence ladder and we fall through to the happy path
    // (this is also why an active workflow's scope is authoritative: a stray
    // --scope flag never silently re-routes a live workflow).
    const currentStateScope = getField(stateContent, "Scope") ?? "";
    if (
      flags.scope &&
      validScopes().has(flags.scope) &&
      flags.scope !== currentStateScope
    ) {
      const parts = [`scope-change --scope ${flags.scope}`];
      if (flags.depth) parts.push(`--depth ${flags.depth}`);
      if (flags.testStrategy) parts.push(`--test-strategy ${flags.testStrategy}`);
      emit(printDirective(
        `Run \`bun ${harnessDir()}/tools/aidlc-utility.ts ${parts.join(" ")}\` to change scope, then print its output verbatim and stop.`,
      ));
      return;
    }
    // A depth / test-strategy modifier with no scope change is a config-change.
    // Gate it on the absence of a scope flag so a `--scope X --depth Y` combo
    // routes through scope-change above (which carries the depth), not here.
    if (!flags.scope && (flags.depth || flags.testStrategy)) {
      const parts = ["config-change"];
      if (flags.depth) parts.push(`--depth ${flags.depth}`);
      if (flags.testStrategy) parts.push(`--test-strategy ${flags.testStrategy}`);
      emit(printDirective(
        `Run \`bun ${harnessDir()}/tools/aidlc-utility.ts ${parts.join(" ")}\` to update the configuration, then print its output verbatim and stop.`,
      ));
      return;
    }
  }

  // Branch 5b — test-run persistence on RESUME. When `--test-run` re-enters an
  // EXISTING workflow whose state file lacks the `Test Run Mode` field, the
  // marking must be re-stamped: aidlc-jump.ts:229 reads `getField(content,
  // "Test Run Mode")` — NOT the CLI flag — for forward-jump termination, so a
  // resume that carries the flag but not the field silently loses test-run
  // mode (t56/t57 fail indirectly through it). Birth stamps the field via
  // `init --test-run` (Branch 3); resume has no init to ride, so the field is
  // absent until re-stamped. Persisting it is a MUTATION, so — exactly like
  // scope-change/config-change (Branch 5) and the jump `execute` (Branch 7) —
  // `next` NAMES the move (a run-then-continue print) and the conductor runs
  // the tool; `next` stays read-only and writes nothing here. The named tool
  // (`aidlc-utility.ts enable-test-run`) requires existing state, no-ops when
  // the field is already present, inserts `- **Test Run Mode**: true` after the
  // Revision Count line, and emits TEST_RUN_MODE_ENABLED. After the conductor
  // runs it, the NEXT `next` sees the field present, this branch no-ops, and
  // the happy path (Branch 10) emits the run-stage — the loop continues.
  //
  // Ordering (branch_order_check): this fires AFTER Branch 5, so a
  // `--scope X --test-run` against a differing scope routes to scope-change
  // first (the bigger move) and returns — test-run persistence rides the next
  // loop iteration once the scope-change tool has re-stamped state. It is
  // gated on `!flags.stage && !flags.phase` so a `--test-run` jump takes the
  // jump path below (Branch 7), which threads `--test-run` into `execute`
  // itself. And it fires BEFORE Branch 10, so the plain `next <scope>
  // --test-run` resume persists the field before any run-stage. Composes
  // getField — the canonical state-field read — rather than hand-rolling.
  if (
    stateContent &&
    flags.testRun &&
    !flags.stage &&
    !flags.phase &&
    getField(stateContent, "Test Run Mode") === null
  ) {
    emit(printDirective(
      `Run \`bun ${harnessDir()}/tools/aidlc-utility.ts enable-test-run\` to persist ` +
        "test-run mode, then re-run `next` to continue.",
    ));
    return;
  }

  // Branch 6 — resume (SKILL.md:292). When the conductor re-enters an existing
  // workflow (`/aidlc --resume`), the prose presents a resume-choice
  // AskUserQuestion. The engine NEVER calls AskUserQuestion (it is a Bash tool
  // the conductor owns); it emits an `ask` directive carrying the question and
  // STOPS, and the conductor renders it and feeds the answer back via report.
  // No state file → there is nothing to resume, so fall through to the
  // no-state error below.
  if (flags.resume && stateContent) {
    const currentSlug = getField(stateContent, "Current Stage") ?? "";
    const where = currentSlug.length > 0 ? ` (currently at "${currentSlug}")` : "";
    emit(askDirective(
      `An existing workflow was found${where}. How would you like to proceed? ` +
        "Resume from last checkpoint, redo the current stage, jump to a stage, or start fresh.",
    ));
    return;
  }

  // Branch 7 — explicit --phase / --stage jump. The conductor relays the
  // human's jump target; the engine SUPPLIES the resolved direction by shelling
  // out to `aidlc-jump.ts resolve` (a pure read) rather than re-deriving the
  // SKILL.md:191-193 forward/backward/redo comparison by hand. resolve also
  // owns the in-scope SKIP validation, so a jump to a stage the scope skips is
  // relayed as its VERBATIM `Stage "..." is skipped for scope "...".` error.
  // On success we surface the run-stage directive for the resolved target,
  // carrying resolved artifact paths (projectType feeds the conditional_on
  // filter for the jumped-to stage).
  if (flags.phase || flags.stage) {
    emitJumpDirective(flags, scope, pd, projectType);
    return;
  }

  // Branch 7b — bare KNOWN-SCOPE positional with no workflow yet. A user who
  // types `/aidlc bugfix` (no `--scope`) named a scope, not freeform intent —
  // but the parser captures any non-`--` token as `flags.intent`, so without
  // this branch the literal scope name would slip into Branch 8 and surface a
  // freeform `ask` defaulting to the wrong scope (Wave-1 audit finding 2). When
  // the positional IS a valid scope name, treat it as the scope: an explicitly
  // named scope on a fresh workspace is a request to START a workflow, and the
  // move is identical to `next --scope <known>` with no state (Branch 9's
  // explicit-flag arm) — scaffolding is a mutation, so the engine names the
  // init move as a run-then-continue print and the conductor births the
  // workflow. This precedes Branch 8 so the known-scope name never reaches the
  // freeform ask; Branch 8's own guard is also tightened to exclude
  // valid-scope intents. Two guards keep the birth unambiguous: an explicit
  // `--scope` flag outranks the positional (the precedence ladder's top rung
  // — Branch 9a births the FLAG's scope instead of silently preferring the
  // positional), and `--resume` is a claim that a workflow already exists, so
  // it never births (falls through to the 9b no-state error).
  if (
    !stateContent &&
    flags.intent &&
    validScopes().has(flags.intent) &&
    !flags.scope &&
    !flags.resume
  ) {
    emit(birthPrintDirective(flags.intent, flags));
    return;
  }

  // Branch 8 — freeform intent with no workflow yet (SKILL.md:355-362). The
  // user described what to build in prose rather than naming a scope. Scope
  // inference (`detect-scope`) and recording it are MUTATIONS the conductor
  // performs; `next` stays read-only and surfaces the scope-confirmation
  // question as an `ask` (the engine design's `ask` = "scope confirmation"). The engine
  // never calls AskUserQuestion itself — it emits `ask` and stops. The resolved
  // scope here is the precedence-ladder result (flag/env/default); the
  // conductor's keyword inference may refine it before confirming. A bare
  // KNOWN-SCOPE positional was already handled by Branch 7b above, so the guard
  // excludes valid-scope intents — only genuine prose reaches the freeform ask.
  if (
    !stateContent &&
    flags.intent &&
    !flags.scope &&
    !validScopes().has(flags.intent)
  ) {
    emit(askDirective(
      `This looks like a "${scope}" workflow for: "${flags.intent}". ` +
        "Confirm the scope to proceed, or name a different one.",
    ));
    return;
  }

  // Branch 9 — no state file. Two arms, split on whether the user EXPLICITLY
  // named a scope:
  //
  // 9a — an explicit `--scope <valid>` flag (source === "flag"; an invalid
  // flag already died at Branch 3b). Naming a scope on a fresh workspace is a
  // request to START a workflow — the same birth move as Branch 7b's
  // valid-scope positional, reached here because the flag passes Branch 3b
  // validation and no jump/init/resume branch fired. Scaffolding is a
  // mutation, so the engine names the init move (run-then-continue print)
  // rather than performing it. `--resume` never births: resuming claims a
  // workflow already exists, so with no state it falls to the 9b error.
  if (!stateContent && source === "flag" && !flags.resume) {
    emit(birthPrintDirective(scope, flags));
    return;
  }
  //
  // 9b — no state and NO explicitly named scope (the resolved scope came from
  // env or the default — never a birth signal on its own). The engine cannot
  // read a position to advance from, and creating one is a mutation (init's
  // job). Emit a clear error rather than guessing — pure read. The message
  // names the two explicit moves that DO start a workflow; it must not imply
  // the user already made one (the pre-hardening wording told a user who had
  // just typed `/aidlc <scope>` to type exactly that — circular now that a
  // named scope births).
  if (!stateContent) {
    emit(errorDirective(
      "No workflow state found (aidlc-docs/aidlc-state.md is absent). " +
        "Name a scope to start a workflow (/aidlc --scope <scope>) or scaffold one with /aidlc --init.",
    ));
    return;
  }

  // Branch 10 — the happy path. Read the workflow's position from state and map
  // it to the stage to run next.
  const currentSlug = getField(stateContent, "Current Stage");
  if (!currentSlug || currentSlug.length === 0) {
    emit(errorDirective(
      "State file has no Current Stage field — cannot determine the next stage.",
    ));
    return;
  }

  const checkboxes = parseCheckboxes(stateContent);
  const currentState = checkboxStateOf(checkboxes, currentSlug);

  // If the current stage is still in-flight (pending / in-progress /
  // awaiting-approval / revising), the next move is to run THAT stage — the
  // workflow has not yet completed it. If it is already completed or skipped,
  // walk to the next EXECUTE stage for the scope (state-override aware).
  const currentIsInFlight =
    currentState === "pending" ||
    currentState === "in-progress" ||
    currentState === "awaiting-approval" ||
    currentState === "revising" ||
    currentState === undefined; // no checkbox row → treat as the active stage

  if (currentIsInFlight) {
    // Under an autonomy grant, an eligible per-unit build stage fans out as a
    // swarm batch instead of a single run-stage. tryEmitSwarm emits the
    // invoke-swarm directive (and returns true) only when all trigger
    // conditions hold; otherwise the normal run-stage emit fires.
    if (!tryEmitSwarm(currentSlug, scope, stateContent, pd)) {
      emitRunStageForSlug(currentSlug, projectType, scope, stateContent);
    }
    return;
  }

  // Current stage is done — find the next in-scope stage. Pass stateContent so
  // per-stage EXECUTE/SKIP overrides and prior [x]/[S] checkboxes are honoured.
  const next: StageEntry | null = nextInScopeStage(
    currentSlug,
    scope,
    stateContent,
  );
  if (!next) {
    // No stage left to run — the workflow is complete.
    emit({
      kind: "done",
      reason: `Workflow complete — no in-scope stage remains after ${currentSlug} (scope: ${scope}).`,
    });
    return;
  }
  // Same swarm guard on the advance path: an eligible per-unit build stage
  // under autonomy fans out as a batch rather than a single run-stage.
  if (!tryEmitSwarm(next.slug, scope, stateContent, pd)) {
    emitRunStageForSlug(next.slug, projectType, scope, stateContent);
  }
}

// The per-unit marker + run mode that isolate the per-unit build stage. The
// swarm only fires for a Construction stage that runs once per Unit of Work AND
// runs as a subagent — which, in the shipped graph, is EXACTLY code-generation
// (verified: it is the only construction stage with for_each:unit-of-work +
// mode:subagent; every other for_each:unit-of-work stage is mode:inline). We
// match on those two fields rather than the slug so a graph that moves the
// per-unit build stage moves the trigger with it, no code change.
const SWARM_FOR_EACH = "unit-of-work";
const SWARM_MODE = "subagent";

// Try to emit an `invoke-swarm` directive instead of a run-stage, returning true
// (and emitting) ONLY when every trigger condition holds:
//   - the slug resolves to a Construction stage that is the per-unit build stage
//     (for_each:unit-of-work + mode:subagent — code-generation today);
//   - the human granted autonomy at the walking-skeleton ladder
//     (Construction Autonomy Mode: autonomous);
//   - the compiled Bolt/unit DAG yields a non-empty first batch.
// On all-true it emits `{kind:"invoke-swarm", units: batches[0]}` — the first
// topological level, the units eligible to fan out now — and returns true. On any
// miss it returns false and emits nothing, so the caller falls back to the normal
// run-stage emit (which keeps its computed gate, including the skeleton round-trip
// sentinel). The skeleton Bolt 1 is protected two ways: temporally (autonomy stays
// unset until the ladder fires after Bolt 1 ships) AND structurally — the
// isSkeletonGateStage guard below refuses to swarm the walking-skeleton gate stage
// regardless of autonomy state. The structural guard matters for scopes where the
// per-unit build stage (code-generation) IS the skeleton-gate stage (poc / bugfix /
// security-patch): there the skeleton's always-gated approval must never be bypassed
// by a stray autonomous setting, so the engine enforces it rather than trusting the
// conductor's ordering.
function tryEmitSwarm(
  slug: string,
  scope: string,
  stateContent: string | null,
  projectDir: string,
): boolean {
  const node = nodeForSlug(slug);
  if (!node) return false;
  if (node.phase !== "construction") return false;
  if (node.for_each !== SWARM_FOR_EACH || node.mode !== SWARM_MODE) return false;
  // Never swarm the walking-skeleton gate stage — Bolt 1 is always gated and
  // human-approved before any batch fans out (structural defense-in-depth).
  if (isSkeletonGateStage(node, scope)) return false;
  if (readAutonomyMode(stateContent) !== "autonomous") return false;
  const batches = readBoltDagBatches(projectDir);
  if (!batches || batches.length === 0) return false;
  const firstBatch = batches[0];
  if (!Array.isArray(firstBatch) || firstBatch.length === 0) return false;
  emit({ kind: "invoke-swarm", units: firstBatch });
  return true;
}

// Emit a run-stage directive for a slug, resolving the graph node first. A slug
// that resolves through the scope/lib helpers but is missing from the graph is
// an internal inconsistency — surface it as an error rather than a crash.
// projectType threads through to the consumes conditional_on filter; scope +
// stateContent thread through to the gate computation (skeleton round-trip) and
// the first-run-stage persona delivery (D-E).
function emitRunStageForSlug(
  slug: string,
  projectType: "brownfield" | "greenfield" | null = null,
  scope: string = DEFAULT_SCOPE,
  stateContent: string | null = null,
): void {
  const node = nodeForSlug(slug);
  if (!node) {
    emit({
      kind: "error",
      message: `Internal: stage "${slug}" resolved by routing but not found in the compiled graph.`,
    });
    return;
  }
  emit(buildRunStageDirective(node, projectType, UNIT_NAME_PLACEHOLDER, scope, stateContent));
}

// --- --single stage-runner mode ---
//
// Emit the lone run-stage directive for a `--single` stage-runner invocation. A
// single-stage run is deliberately ISOLATED from any main workflow: it computes
// the directive purely from the graph node + scope, passing `stateContent: null`
// so neither the skeleton round-trip nor the main-pointer-derived persona signal
// reads the main state file. The pointer rule is the whole point — a single-stage
// run must leave the main workflow's `Current Stage` exactly where it was, so it
// never consults or mutates that pointer. We then attach the conductor persona
// unconditionally, because for a stage-runner THIS is the conductor's first (and
// only) directive of the invocation — the same D-E delivery the orchestrator's
// first run-stage gets (per the engine design), just keyed on "first of this single run"
// rather than "first of the workflow".
//
// Guards, in order: the stage must exist in the compiled graph; an initialization
// stage is rejected (bootstrap stages create/scaffold state — they have no
// isolated single-stage meaning, mirroring the jump init-guard); and the stage
// must be a member of the scope's EXECUTE-only sub-DAG (a SKIP-for-scope stage is
// not runnable, relayed with the verbatim skip wording the jump path uses, so the
// directive stream is identical regardless of entry point).
const SINGLE_INIT_ERROR =
  "Cannot run an initialization stage with --single. Initialization is bootstrap (it scaffolds state); run /aidlc --init instead.";

function emitSingleRunStage(
  slug: string,
  scope: string,
  projectType: "brownfield" | "greenfield" | null,
): void {
  const node = nodeForSlug(slug);
  if (!node) {
    emit(errorDirective(
      `Unknown stage "${slug}". Run /aidlc --help for the full list.`,
    ));
    return;
  }
  if (node.phase === "initialization") {
    emit(errorDirective(SINGLE_INIT_ERROR));
    return;
  }
  const inScopeSlugs = new Set(subgraphForScope(scope).map((s) => s.slug));
  if (!inScopeSlugs.has(node.slug)) {
    emit(errorDirective(
      `Stage "${node.slug}" is skipped for scope "${scope}". ` +
        "Choose a different stage or change scope.",
    ));
    return;
  }
  // Build the directive from the graph node alone (stateContent: null → no main
  // state read, no skeleton round-trip, no main-pointer persona signal), then
  // attach the persona explicitly: this is the conductor's first directive of the
  // single run, so D-E delivery applies.
  const directive = buildRunStageDirective(
    node,
    projectType,
    UNIT_NAME_PLACEHOLDER,
    scope,
    null,
  );
  if (directive.conductor_persona === undefined) {
    const persona = readConductorPersona();
    if (persona !== null) directive.conductor_persona = persona;
  }
  emit(directive);
}

// Resolve an explicit --stage / --phase jump and emit the resulting directive.
//
// A jump against an EXISTING workflow is a MUTATION: it marks intervening
// stages [S] (forward), resets downstream stages (backward), emits STAGE_JUMPED,
// and pivots Current Stage. `next` is read-only and never mutates, so — exactly
// like the scope-change (Branch 5) and config-change branches, which emit a
// `print` directive naming a CLI tool for the conductor to run — the WITH-STATE
// jump path emits a `print` naming `aidlc-jump.ts execute`. The conductor runs
// that mutating tool, then re-runs `next`; the next `next` reads the pivoted
// state and naturally emits the run-stage for the now-current target. This
// composes the existing CLI-only `execute` handler (no new directive field, no
// jump vocabulary in `report`, and `next` stays read-only).
//
// The conductor RELAYS the human's jump target; the engine SUPPLIES the
// resolved facts. It shells out to `aidlc-jump.ts resolve` (a pure read) —
// that handler both validates the target is in-scope for the scope (rejecting a
// SKIP stage with its VERBATIM `Stage "..." is skipped for scope "...".`
// message) AND computes the forward/backward/redo direction at
// aidlc-jump.ts:142-145. We relay a rejection verbatim and, on success, compose
// the `execute` command with the tool's own `target_slug` + `direction`.
// Re-deriving the SKILL.md:191-193 comparison by hand would be an LLM-shaped
// move; delegating it to the tool is the deterministic one.
//
// resolve REQUIRES a state file (it reads `Current Stage` to anchor the
// direction). With no workflow yet, there is no position to jump FROM — the
// direction is undefined, and there are no intervening stages to skip or reset,
// so a jump is really just "start here". That NO-STATE path falls back to a
// direct graph lookup that names the requested target (the prose's "or 0.3 if
// freshly initialized" degenerate case) and emits a plain run-stage — it is NOT
// a commit, so it does not route through `execute`.
// SKILL.md step 5 (Initialization guard) verbatim: jumping to an initialization
// stage — or `--phase initialization` — is rejected. Init stages have bootstrap
// behavior (create the state file, scaffold dirs) that doesn't fit the jump
// model; the user must run `/aidlc --init`. The guard is prose-only in SKILL.md
// (`aidlc-jump.ts resolve` treats init stages as valid targets, returning
// valid:true), so the engine enforces it here rather than relaying a tool error.
const INIT_JUMP_ERROR =
  "Cannot jump to initialization stages. Use /aidlc --init to run the Initialization phase.";

function emitJumpDirective(
  flags: ParsedFlags,
  scope: string,
  projectDir: string,
  projectType: "brownfield" | "greenfield" | null = null,
): void {
  // --phase initialization is rejected up front (applies with or without state).
  if (flags.phase && canonicalisePhase(flags.phase) === "initialization") {
    emit(errorDirective(INIT_JUMP_ERROR));
    return;
  }

  const hasState = existsSync(stateFilePath(projectDir));

  if (hasState) {
    const resolveArgs = ["resolve", "--scope", scope, "--project-dir", projectDir];
    if (flags.phase) resolveArgs.push("--phase", flags.phase);
    else if (flags.stage) resolveArgs.push("--stage", flags.stage);

    const run = runTool("aidlc-jump.ts", resolveArgs);
    if (!run.ok) {
      // SKIP-for-scope, unknown stage/phase, etc. — relay the tool's verbatim
      // error (it owns the wording the rest of the framework asserts on).
      emit(errorDirective(toolErrorMessage(run)));
      return;
    }
    const resolved = parseResolved(run.stdout);
    if (!resolved) {
      emit(errorDirective(
        `Internal: aidlc-jump.ts resolve returned no target_slug/direction for ${flags.phase ? `--phase ${flags.phase}` : `--stage ${flags.stage}`}.`,
      ));
      return;
    }
    const { targetSlug, direction } = resolved;
    // resolve validates SKIP/unknown but NOT the init-stage guard — enforce it
    // on the resolved target (covers --stage <init> against existing state).
    const targetNode = nodeForSlug(targetSlug);
    if (targetNode && targetNode.phase === "initialization") {
      emit(errorDirective(INIT_JUMP_ERROR));
      return;
    }
    // Committing the jump is a MUTATION — name the move (print) and let the
    // conductor run `execute`, exactly as scope-change/config-change do. The
    // command carries the tool-resolved direction so `execute` skips/resets the
    // right stages, emits STAGE_JUMPED, and pivots Current Stage. --test-run
    // rides through: resolve/execute honour it, and `execute --test-run` owns
    // the terminal stop for a test-run forward jump (SKILL.md origin/main:92).
    // After the conductor runs it, the NEXT `next` sees the pivoted state and
    // emits the run-stage for the now-current target.
    const executeParts = [
      `execute --target ${targetSlug} --direction ${direction} --scope ${scope}`,
    ];
    if (flags.testRun) executeParts.push("--test-run");
    emit(printDirective(
      `Run \`bun ${harnessDir()}/tools/aidlc-jump.ts ${executeParts.join(" ")}\` to perform the jump, then re-run \`next\` to continue from the jump target.`,
    ));
    return;
  }

  // No state file — resolve cannot compute a direction. Name the requested
  // target directly off the graph (the no-position behaviour is preserved from
  // the read-only `next` baseline this branch extends).
  if (flags.phase) {
    const canonical = canonicalisePhase(flags.phase);
    if (!canonical) {
      emit(errorDirective(
        `Unknown phase "${flags.phase}". Valid phases: ${PHASES.join(", ")}.`,
      ));
      return;
    }
    const first = firstInScopeStageOfPhase(canonical, scope);
    if (!first) {
      emit(errorDirective(
        `Phase "${canonical}" has no executable stages for scope "${scope}".`,
      ));
      return;
    }
    // No-state jump: pass scope for the gate computation; stateContent stays
    // null (no workflow yet → no skeleton round-trip, no persona delivery —
    // both correct, this is a degenerate "start here" before init).
    emitRunStageForSlug(first.slug, projectType, scope, null);
    return;
  }

  // flags.stage (guaranteed by the caller's `phase || stage` guard).
  const stageSlug = flags.stage ?? "";
  const node = nodeForSlug(stageSlug);
  if (!node) {
    emit(errorDirective(
      `Unknown stage "${stageSlug}". Run /aidlc --help for the full list.`,
    ));
    return;
  }
  // Init-stage guard applies on the no-state path too (SKILL.md step 5).
  if (node.phase === "initialization") {
    emit(errorDirective(INIT_JUMP_ERROR));
    return;
  }
  // Scope-membership guard (Wave-1 audit finding 3). The with-state path gets
  // SKIP validation for free from `aidlc-jump.ts resolve`, but resolve REQUIRES
  // a state file, so this no-state branch did a bare graph lookup with no
  // in-scope check — emitting run-stage for a stage the scope SKIPs (e.g.
  // `next --scope bugfix --stage user-stories`). Mirror the with-state error by
  // testing membership against the scope's EXECUTE-only sub-DAG; relay the
  // verbatim skip wording resolve uses (aidlc-jump.ts:118) so the directive
  // stream is identical regardless of whether state exists yet.
  const inScopeSlugs = new Set(subgraphForScope(scope).map((s) => s.slug));
  if (!inScopeSlugs.has(node.slug)) {
    emit(errorDirective(
      `Stage "${node.slug}" is skipped for scope "${scope}". ` +
        "Choose a different stage or change scope.",
    ));
    return;
  }
  // No-state jump: scope feeds the gate; stateContent is null (no workflow yet).
  emit(buildRunStageDirective(node, projectType, UNIT_NAME_PLACEHOLDER, scope, null));
}

// Pull `target_slug` AND `direction` out of `aidlc-jump.ts resolve`'s stdout
// JSON. resolve emits both fields (aidlc-jump.ts:168-180) — the engine needs
// the slug to name the target and the direction to compose the `execute` commit
// directive (forward marks intervening stages [S]; backward resets downstream;
// redo resets only the target). Returns null when the payload is unparseable or
// missing either field, so the caller surfaces a clean internal error rather
// than composing a half-specified jump command.
function parseResolved(
  stdout: string,
): { targetSlug: string; direction: string } | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "target_slug" in parsed &&
      typeof (parsed as { target_slug: unknown }).target_slug === "string" &&
      "direction" in parsed &&
      typeof (parsed as { direction: unknown }).direction === "string"
    ) {
      const p = parsed as { target_slug: string; direction: string };
      return { targetSlug: p.target_slug, direction: p.direction };
    }
  } catch {
    // unparseable — fall through to null
  }
  return null;
}

// Look up a slug's checkbox state from the parsed list. Returns undefined when
// the slug has no checkbox row (a freshly-targeted stage).
function checkboxStateOf(
  checkboxes: CheckboxLine[],
  slug: string,
): CheckboxLine["state"] | undefined {
  return checkboxes.find((c) => c.slug === slug)?.state;
}

// Canonicalise a phase token (name or number) to its canonical name, or null.
// Composes the same PHASE_NUMBERS / PHASES tables the jump tool uses.
function canonicalisePhase(input: string): string | null {
  const lower = input.toLowerCase();
  return (
    PHASE_NUMBERS[lower] ||
    ((PHASES as readonly string[]).includes(lower) ? lower : null)
  );
}

// --- report: commit the transition (the engine's WRITE half) ---
//
// `report` records what happened after the conductor acted on a directive, so
// the next `next` reads fresh state. It is a dispatcher over aidlc-state.ts's
// transition subcommands and reimplements none of their transition logic.
// Those subcommands are CLI-only (aidlc-state.ts
// exports nothing); importing a handle* function is a hard build failure, so
// the only seam is the argv dispatch — Bun.spawnSync the subcommand.
//
// Why no withAuditLock here: each spawned aidlc-state.ts subcommand is already
// atomic — it does its own per-emit OS mkdir-lock acquire/release in its own
// process. The engine's withAuditLock would NOT span that subprocess (the lock
// is per-process), so wrapping the spawn in one buys nothing. The engine holds
// a lock only if it emits its OWN in-process audit row, which report does not —
// it delegates every emission to the already-atomic subcommand.
//
// The dispatch choice is the engine's small ADDED decision rule (mirroring the
// `next` decision rule): map the acted stage to its committing subcommand by
// GATE STATUS first, then finality.
//   - gated stage   -> `approve`. approve OWNS the full transition: it emits
//                      GATE_APPROVED + STAGE_COMPLETED and then self-delegates
//                      in-process to advance (non-final) or complete-workflow
//                      (final). We must NOT also call advance after approve
//                      (SKILL.md: "approve owns the full transition — do not
//                      call advance after approve"). Branching on finality here
//                      would double-dispatch a final gated stage. When an
//                      explicit --stage report finds the stage still active,
//                      report first opens the missing gate, then approves.
//   - non-gated, not the final in-scope stage -> `advance`.
//   - non-gated, final in-scope stage          -> `complete-workflow`.
// Gate status is the same axis `next` uses to build a run-stage directive: only
// the bootstrap initialization stages auto-proceed with no gate; every other
// EXECUTE stage gates. Finality is "no in-scope stage remains after this one".

// The outcomes `report --result` accepts. A forward commit reports that the
// stage the conductor just worked on succeeded; `approved` and `completed` are
// accepted synonyms for that verdict (the conductor naturally says "approved"
// at a gate and "completed" for a non-gated stage). The engine — not the
// caller — picks the committing subcommand from gate status + finality, so the
// two synonyms are interchangeable; what matters is that a verdict was given.
// Reject/revise are NOT report outcomes: report commits FORWARD transitions
// only (the reject path stays in the prose orchestrator's gate handling).
const FORWARD_RESULTS = new Set(["approved", "completed", "complete", "done"]);

interface ReportFlags {
  result?: string;
  userInput?: string;
  reason?: string;
  testRun?: boolean;
  skeletonStance?: string; // the classify round-trip's classified stance
  single?: boolean; // --single: commit a synthetic-id STAGE_STARTED/COMPLETED pair, never the main pointer
  stage?: string; // --stage <slug>: the acted stage (required under --single; preferred for main workflow reports)
}

// Extract report's flags. --result is the verdict; --user-input rides through
// to approve's GATE_APPROVED row; --reason rides through to complete-workflow;
// --test-run rides through to approve (it auto-approves and stamps Test-Run).
// --skeleton-stance carries the conductor's classified walking-skeleton stance
// (the classify round-trip): it does NOT commit a transition — it records the
// stance so the next `next` resolves the deferred gate.
function parseReportFlags(args: string[]): ReportFlags {
  const flags: ReportFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--result" && i + 1 < args.length) {
      flags.result = args[i + 1];
      i++;
    } else if (a === "--user-input" && i + 1 < args.length) {
      flags.userInput = args[i + 1];
      i++;
    } else if (a === "--reason" && i + 1 < args.length) {
      flags.reason = args[i + 1];
      i++;
    } else if (a === "--skeleton-stance" && i + 1 < args.length) {
      flags.skeletonStance = args[i + 1];
      i++;
    } else if (a === "--stage" && i + 1 < args.length) {
      flags.stage = args[i + 1];
      i++;
    } else if (a === "--test-run") {
      flags.testRun = true;
    } else if (a === "--single") {
      flags.single = true;
    }
  }
  return flags;
}

// Shell out to a sibling aidlc-state.ts subcommand. Resolves the tool relative
// to this file so the engine and the tool it drives stay co-located. Returns
// the child's exitCode + captured streams; a non-zero exitCode means
// aidlc-state.ts rejected the transition via error() (which exits non-zero),
// and the engine surfaces that as an error directive rather than a silent miss.
function spawnState(
  projectDir: string,
  subArgs: string[],
): { exitCode: number; stdout: string; stderr: string } {
  const toolPath = fileURLToPath(new URL("./aidlc-state.ts", import.meta.url));
  const result = Bun.spawnSync({
    cmd: ["bun", "run", toolPath, ...subArgs, "--project-dir", projectDir],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

// Shell out to `aidlc-audit.ts append <event> [--field k=v ...]` — the audit
// CLI's atomic, lock-acquiring append. The `--single` synthetic-pair emission
// (handleSingleReport below) uses this, mirroring report's spawn-the-atomic-tool
// discipline: the engine itself writes nothing; the spawned tool acquires the
// per-emit audit lock in its own process. This is the audit-only path — it
// touches `audit.md`, never `aidlc-state.md` — so a `--single` commit cannot
// reach the main pointer even by accident (aidlc-audit.ts has no state write).
function spawnAuditAppend(
  projectDir: string,
  eventType: string,
  fields: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
  const auditTool = fileURLToPath(new URL("./aidlc-audit.ts", import.meta.url));
  const fieldArgs: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    fieldArgs.push("--field", `${k}=${v}`);
  }
  const result = Bun.spawnSync({
    cmd: ["bun", "run", auditTool, "append", eventType, ...fieldArgs, "--project-dir", projectDir],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

// Record the conductor's classified walking-skeleton stance (the classify
// round-trip's hand-back) and name the next move. Validates the stance value,
// confirms a workflow exists AND its current stage is the skeleton-gate stage
// awaiting an unresolved gate (so a stray stance report cannot scribble the
// field at the wrong moment), writes the `Skeleton Stance` field via the atomic
// `aidlc-state.ts set` subcommand, then emits a `print` telling the conductor to
// re-run `next` — the follow-up `next` reads the recorded stance and emits the
// determined gate. The write lives in the spawned tool; the engine writes
// nothing itself (mirrors the scope-change/jump pattern: name the move, the
// conductor's tool mutates).
function handleSkeletonStanceReport(
  stance: string,
  projectDir: string | undefined,
): void {
  if (!VALID_SKELETON_STANCES.has(stance)) {
    emit(errorDirective(
      `Unknown --skeleton-stance "${stance}". Accepted: ${[...VALID_SKELETON_STANCES].join(", ")} ` +
        "(the walking-skeleton stance classified from the team's ## Walking Skeleton prose).",
    ));
    return;
  }

  const pd = resolveProjectDir(projectDir);
  const stateContent = loadStateFileIfPresent(pd);
  if (!stateContent) {
    emit(errorDirective(
      "No workflow state found (aidlc-docs/aidlc-state.md is absent) — nothing to record a skeleton stance for.",
    ));
    return;
  }

  // Defensive: a stance only makes sense when the workflow is parked on the
  // skeleton-gate stage with an unresolved gate. If the current stage is not the
  // skeleton-gate stage for the scope, the conductor mis-fired — surface it
  // rather than write the field at the wrong moment.
  const slug = getField(stateContent, "Current Stage");
  const scope = getField(stateContent, "Scope");
  if (!slug || slug.length === 0) {
    emit(errorDirective(
      "State file has no Current Stage field — cannot record a skeleton stance.",
    ));
    return;
  }
  if (!scope || scope.length === 0) {
    emit(errorDirective(
      "State file has no Scope field — cannot validate the skeleton-gate stage.",
    ));
    return;
  }
  const node = nodeForSlug(slug);
  if (!node || !isSkeletonGateStage(node, scope)) {
    emit(errorDirective(
      `Current stage "${slug}" is not the skeleton-gate stage for scope "${scope}" — ` +
        "a skeleton stance is only reported for the first Construction Bolt's gate.",
    ));
    return;
  }

  // Record the stance via the dedicated state subcommand. `set-skeleton-stance`
  // uses setOrInsertField so the runtime-only `Skeleton Stance` field is written
  // even on a state file that predates it (plain `set` silently no-ops on an
  // absent field). The engine writes nothing itself — the spawned tool mutates.
  const res = spawnState(pd, ["set-skeleton-stance", stance]);
  if (res.exitCode !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    emit(errorDirective(
      `Failed to record skeleton stance for "${slug}"` + (detail ? `: ${detail}` : "."),
    ));
    return;
  }

  emit(printDirective(
    `Recorded walking-skeleton stance "${stance}" for "${slug}". ` +
      "Re-run `next` to continue — the gate is now determined.",
  ));
}

// --- --single report: commit the synthetic-id pair ---
//
// The synthetic workflow id a `--single` stage-runner's events are tagged with.
// It is NOT a real WORKFLOW_STARTED id — it exists only to mark the
// STAGE_STARTED/STAGE_COMPLETED pair in `audit.md` as belonging to an isolated
// single-stage run, never to the main workflow. The `<slug>` segment makes the
// provenance legible in the audit trail.
function syntheticWorkflowId(slug: string): string {
  return `single-stage:${slug}`;
}

// Handle `report --single --stage <slug> --result <outcome>`: commit the lone
// STAGE_STARTED / STAGE_COMPLETED pair for `<slug>` under a SYNTHETIC workflow
// id, audit-only, then emit `done`. This is the WRITE half of the stage-runner
// contract, and it carries the load-bearing pointer invariant:
//
//   A `--single` run NEVER touches the main state file's `Current Stage`.
//
// It is tool-enforced two ways. (1) STRUCTURAL: this path shells out ONLY to
// `aidlc-audit.ts append` (which has no state write) — never to aidlc-state.ts
// advance / approve / complete-workflow, the only subcommands that pivot the main
// pointer. So a single-stage run is mechanically incapable of advancing the main
// workflow. (2) EXPLICIT: `--single` REQUIRES a `--stage <slug>` naming the stage
// that was run. A `report --single` with NO `--stage` is exactly an attempt to
// "advance the main workflow" (commit against whatever `Current Stage` points at)
// — and that returns an `error` directive rather than silently mutating. The two
// together make "advance the main workflow from a single run" unreachable.
//
// The pair is emitted via the atomic audit-append CLI (mirrors report's
// spawn-the-atomic-tool discipline — the engine writes nothing itself). STAGE_STARTED
// carries Stage + Agent + Workflow (the synthetic id); STAGE_COMPLETED carries
// Stage + Details + Workflow, matching the field shape aidlc-state.ts emits for
// the same events so the audit format stays uniform.
function handleSingleReport(
  flags: ReportFlags,
  projectDir: string | undefined,
): void {
  if (!flags.result) {
    emit(errorDirective(
      "report --single requires --result <outcome>. Accepted: " +
        [...FORWARD_RESULTS].join(", ") +
        " (the verdict for the single stage just run).",
    ));
    return;
  }
  if (!FORWARD_RESULTS.has(flags.result)) {
    emit(errorDirective(
      `Unknown --result "${flags.result}". report commits forward outcomes only; ` +
        `accepted: ${[...FORWARD_RESULTS].join(", ")}.`,
    ));
    return;
  }
  // The pointer invariant, explicit half: a --single report with no --stage is an
  // attempt to advance the MAIN workflow (commit against Current Stage). Refuse it.
  if (!flags.stage || flags.stage.length === 0) {
    emit(errorDirective(
      "report --single must not advance the main workflow. Pass --stage <slug> to commit the " +
        "single stage's synthetic-id pair; --single never writes the main workflow's Current Stage.",
    ));
    return;
  }
  const node = nodeForSlug(flags.stage);
  if (!node) {
    emit(errorDirective(
      `Unknown stage "${flags.stage}". Run /aidlc --help for the full list.`,
    ));
    return;
  }
  if (node.phase === "initialization") {
    emit(errorDirective(SINGLE_INIT_ERROR));
    return;
  }

  const pd = resolveProjectDir(projectDir);
  const wfId = syntheticWorkflowId(node.slug);

  const started = spawnAuditAppend(pd, "STAGE_STARTED", {
    Stage: node.slug,
    Agent: node.lead_agent,
    Workflow: wfId,
  });
  if (started.exitCode !== 0) {
    const detail = (started.stderr || started.stdout).trim();
    emit(errorDirective(
      `Failed to record single-stage STAGE_STARTED for "${node.slug}"` +
        (detail ? `: ${detail}` : "."),
    ));
    return;
  }
  const completed = spawnAuditAppend(pd, "STAGE_COMPLETED", {
    Stage: node.slug,
    Details: `Single-stage run of ${node.slug} completed`,
    Workflow: wfId,
  });
  if (completed.exitCode !== 0) {
    const detail = (completed.stderr || completed.stdout).trim();
    emit(errorDirective(
      `Failed to record single-stage STAGE_COMPLETED for "${node.slug}"` +
        (detail ? `: ${detail}` : "."),
    ));
    return;
  }

  emit({
    kind: "done",
    reason:
      `Single-stage run of "${node.slug}" committed under synthetic workflow "${wfId}". ` +
      "The main workflow's Current Stage is untouched.",
  });
}

function checkboxForSlug(
  stateContent: string,
  slug: string,
): CheckboxLine | undefined {
  return parseCheckboxes(stateContent).find((c) => c.slug === slug);
}

function approveArgs(slug: string, flags: ReportFlags): string[] {
  const args = ["approve", slug];
  if (flags.userInput) args.push("--user-input", flags.userInput);
  if (flags.testRun) args.push("--test-run");
  return args;
}

// The `report` handler. Reads the acted stage + scope from state, decides the
// committing subcommand(s) (gate status, then finality), shells out to the
// atomic state tool, and emits a terminal `done` directive on success or an
// `error` directive on a rejected transition. Mutation happens entirely inside
// the spawned subcommand(s) — the engine itself writes nothing.
function handleReport(args: string[], projectDir: string | undefined): void {
  const flags = parseReportFlags(args);

  // Branch -1 — the --single stage-runner commit. A stage-runner reports
  // its lone stage via `report --single --stage <slug> --result <outcome>`; the
  // engine commits a synthetic-id STAGE_STARTED/STAGE_COMPLETED pair (audit only)
  // and NEVER touches the main `Current Stage`. Resolves first, before the
  // main-workflow branches, so a single-stage commit can never fall through to a
  // state-mutating subcommand.
  if (flags.single) {
    handleSingleReport(flags, projectDir);
    return;
  }

  // Branch 0 — the classify round-trip (per the engine design). `report
  // --skeleton-stance <on|off|scope-dependent>` is NOT a transition commit: the
  // conductor classified the team's `## Walking Skeleton` prose (knowledge work
  // the engine cannot do) and hands the typed stance back. We RECORD it in the
  // state field the next `next` reads, then name the move (re-run `next`) — the
  // next `next` resolves the now-determined gate. Recording is a state write, so
  // it goes through the atomic `aidlc-state.ts set` subcommand (the engine never
  // writes state itself). This branch resolves BEFORE the --result requirement
  // because a stance report carries no verdict.
  if (flags.skeletonStance !== undefined) {
    handleSkeletonStanceReport(flags.skeletonStance, projectDir);
    return;
  }

  // A verdict is required: report commits the outcome of an acted directive, so
  // it cannot run without one. An unrecognised verdict is a hard error (clean
  // boundaries) rather than a silent no-op.
  if (!flags.result) {
    emit({
      kind: "error",
      message:
        "report requires --result <outcome>. Accepted: " +
        [...FORWARD_RESULTS].join(", ") +
        " (the verdict for the stage just acted on).",
    });
    return;
  }
  if (!FORWARD_RESULTS.has(flags.result)) {
    emit({
      kind: "error",
      message:
        `Unknown --result "${flags.result}". report commits forward transitions only; ` +
        `accepted outcomes: ${[...FORWARD_RESULTS].join(", ")}.`,
    });
    return;
  }

  const pd = resolveProjectDir(projectDir);
  const stateContent = loadStateFileIfPresent(pd);
  if (!stateContent) {
    emit({
      kind: "error",
      message:
        "No workflow state found (aidlc-docs/aidlc-state.md is absent) — nothing to report a transition for.",
    });
    return;
  }

  // Prefer the stage the conductor explicitly reports. This closes the stale
  // pointer gap where the conductor may have already moved Current Stage by a
  // direct state-tool recovery, then reports the older directive it actually
  // acted on. Omitted --stage keeps the historical Current Stage fallback.
  const currentSlug = getField(stateContent, "Current Stage");
  if (!currentSlug || currentSlug.length === 0) {
    emit({
      kind: "error",
      message:
        "State file has no Current Stage field — cannot determine which stage's transition to commit.",
    });
    return;
  }
  const explicitStage = flags.stage?.trim();
  const slug = explicitStage && explicitStage.length > 0 ? explicitStage : currentSlug;

  const scope = getField(stateContent, "Scope");
  if (!scope || scope.length === 0) {
    emit({
      kind: "error",
      message: "State file has no Scope field — cannot resolve the next in-scope stage.",
    });
    return;
  }

  // Gate status off the graph node — the same axis `next` uses for run-stage's
  // `gate` field: only bootstrap initialization stages auto-proceed; every
  // other EXECUTE stage gates.
  const node = nodeForSlug(slug);
  if (!node) {
    emit({
      kind: "error",
      message: `Internal: reported stage "${slug}" is not in the compiled graph — cannot commit its transition.`,
    });
    return;
  }
  const stageCheckbox = checkboxForSlug(stateContent, slug);
  if (!stageCheckbox) {
    emit({
      kind: "error",
      message: `Stage "${slug}" is not present in the state file — cannot commit its transition.`,
    });
    return;
  }
  const isGated = node.phase !== "initialization";

  // Finality — is there an in-scope stage after this one? (state-override aware,
  // so EXECUTE/SKIP suffixes and prior [x]/[S] checkboxes are honoured.)
  const isFinal = nextInScopeStage(slug, scope, stateContent) === null;

  const status = getField(stateContent, "Status") ?? "";

  // Decide the committing subcommand(s). Normal gated stages still dispatch
  // to approve only. Explicit-stage recovery may first open a missing gate:
  // this preserves the state-machine audit trail (STAGE_AWAITING_APPROVAL
  // before GATE_APPROVED) without asking the conductor to hand-roll the
  // deterministic transition.
  const sequence: string[][] = [];
  if (stageCheckbox.state === "skipped" || stageCheckbox.state === "revising") {
    emit({
      kind: "error",
      message:
        `Stage "${slug}" is ${stageCheckbox.state}; report commits forward completions only.`,
    });
    return;
  }
  if (stageCheckbox.state === "pending") {
    emit({
      kind: "error",
      message:
        `Stage "${slug}" is still pending. Run the stage before reporting it complete.`,
    });
    return;
  }

  if (stageCheckbox.state === "completed") {
    if (isFinal) {
      if (status === "Completed") {
        emit({
          kind: "done",
          reason:
            `Workflow is already completed at "${slug}" (scope: ${scope}); no transition was needed.`,
        });
        return;
      }
      const completeArgs = ["complete-workflow", slug];
      if (flags.reason) completeArgs.push("--reason", flags.reason);
      sequence.push(completeArgs);
    } else {
      // Stale re-report guard. If the workflow has already moved on — Current
      // Stage points at a DIFFERENT slug whose checkbox has left pending — a
      // re-report of the completed stage is a replay, not a recovery. Spawning
      // advance here would demote a gate-held `[?]`/`[R]` current stage back to
      // `[-]` and re-emit STAGE_STARTED. The legitimate recovery (approve
      // landed but advance crashed: slug === currentSlug, next still pending)
      // falls through to advance below.
      const currentCb =
        slug === currentSlug ? undefined : checkboxForSlug(stateContent, currentSlug);
      if (currentCb && currentCb.state !== "pending") {
        emit({
          kind: "done",
          reason:
            `Stage "${slug}" is already completed and the workflow has moved on to ` +
            `"${currentSlug}" (scope: ${scope}); idempotent re-report, no transition needed.`,
        });
        return;
      }
      sequence.push(["advance", slug]);
    }
  } else if (isGated) {
    if (stageCheckbox.state === "in-progress") {
      if (!explicitStage) {
        emit({
          kind: "error",
          message:
            `Stage "${slug}" is still in-progress. To approve a gated stage that has not entered ` +
            `awaiting-approval, report the acted directive explicitly with --stage "${slug}" so ` +
            "the engine cannot mistake a freshly advanced Current Stage for the completed one.",
        });
        return;
      }
      // Backfilled gate — tag the row Recovered=true so audit consumers can
      // tell the engine-opened gate from an organic gate-start.
      sequence.push(["gate-start", slug, "--recovered"]);
    }
    sequence.push(approveArgs(slug, flags));
  } else if (isFinal) {
    const completeArgs = ["complete-workflow", slug];
    if (flags.reason) completeArgs.push("--reason", flags.reason);
    sequence.push(completeArgs);
  } else {
    sequence.push(["advance", slug]);
  }

  const committed: string[] = [];
  for (const subArgs of sequence) {
    const res = spawnState(pd, subArgs);
    if (res.exitCode !== 0) {
      // aidlc-state.ts rejected the transition (error() exits non-zero). Surface
      // its message verbatim so the rejection is a clear signal, not a silent miss.
      const detail = (res.stderr || res.stdout).trim();
      emit({
        kind: "error",
        message:
          `Transition rejected by aidlc-state.ts ${subArgs[0]} for "${slug}"` +
          (detail ? `: ${detail}` : "."),
      });
      return;
    }
    committed.push(subArgs[0]);
  }
  if (committed.length === 0) {
    emit({
      kind: "error",
      message: `Internal: no transition selected for "${slug}".`,
    });
    return;
  }

  // The transition committed. Emit a terminal `done` directive naming the move
  // — the loop driver reads this to know the report landed and the next `next`
  // will see fresh state.
  emit({
    kind: "done",
    reason:
      `Committed ${committed.join(" + ")} for "${slug}" (scope: ${scope}). ` +
      "State advanced; run next to continue.",
  });
}

// --- CLI entry point ---

function main(): void {
  const rawArgs = process.argv.slice(2);

  // Extract --project-dir (mirrors aidlc-jump.ts / aidlc-state.ts).
  let projectDir: string | undefined;
  const filteredArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--project-dir" && i + 1 < rawArgs.length) {
      projectDir = rawArgs[i + 1];
      i++;
    } else {
      filteredArgs.push(rawArgs[i]);
    }
  }

  const subcommand = filteredArgs[0];
  const subArgs = filteredArgs.slice(1);

  switch (subcommand) {
    case "next":
      handleNext(subArgs, projectDir);
      break;
    case "report":
      handleReport(subArgs, projectDir);
      break;
    default:
      // Unknown / missing subcommand — usage to stderr, exit 1. Matches the
      // stderr-only usage shape the sibling tools use for a bad subcommand.
      console.error(
        `Unknown subcommand: ${subcommand ?? "(none)"}. Valid: next, report`,
      );
      process.exit(1);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (e) {
    // Any uncaught read error (missing graph, malformed state) surfaces as a
    // non-zero exit with the message on stderr — never a half-emitted
    // directive on stdout.
    console.error(`aidlc-orchestrate: ${errorMessage(e)}`);
    process.exit(1);
  }
}
