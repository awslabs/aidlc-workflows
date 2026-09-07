// The orchestration engine — the deterministic "what's next?" answerer that
// stands BESIDE the prose orchestrator (skills/aidlc/SKILL.md), not inside it.
// Nothing in SKILL.md calls this file yet; it is exercised only by its own
// unit tests until the differential corpus proves it emits the same directive
// sequence the prose orchestrator produces today. Framework behaviour is
// unchanged by this file's existence.
//
// The engine reads workflow state (aidlc-docs/aidlc-state.md) and the compiled
// stage graph (data/stage-graph.json), then emits EXACTLY ONE typed Directive
// (JSON) to stdout. `next` is read-only for every legacy/solo workflow. Exact
// team ownership is the narrow exception: before routing it delegates a
// guarded `refresh-unit-progress` projection to aidlc-state.ts so the derived
// grid and aggregate Construction checkboxes cannot drift from audit receipts.
// Creation remains read-only: on a fresh workspace the engine NAMES the
// deterministic `intent-create` move via a print directive, and the conductor
// runs that separate tool. The directive's `kind` tells the conductor the
// single move to make next; the conductor relays human choices
// and supplies resolved facts, but the engine never originates a deviation,
// never calls AskUserQuestion (that is a Bash tool the conductor owns), and
// never spawns agents. Clean boundaries: a refused or malformed directive is a
// clear signal, not a silent miss — every emitted directive is validated
// against the frozen aidlc-directive.ts contract before it is printed.
//
// Subcommand dispatch table:
//   next   — resolve scope (state > flag > env > default), find the workflow's
//            position, refresh only the exact-team derived projection, and emit
//            one directive. Ordinary routing is otherwise read-only; `--single`
//            records its isolated audit start before dispatch. LIVE.
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

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  type Dirent,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AskDirective,
  type Directive,
  type ErrorDirective,
  GATE_UNRESOLVED,
  type GateValue,
  type LegacyPlanApprovalChoices,
  type LoadSteeringDirective,
  type ParkedDirective,
  type PrintDirective,
  type NoticeDirective,
  type ProtocolModule,
  type RunStageDirective,
  type RunStageWave,
  type RunStageWaveEntry,
  type StageValidityAdvisory,
  validateDirective,
} from "./aidlc-directive.ts";
import {
  ActiveDirectiveLockContendedError,
  advanceContinuationCursor,
  activeUnitCheckpoint,
  artifactFilename,
  auditBlockField,
  BLOCKING_SENSOR_OVERRIDE_CHOICE,
  type CheckboxState,
  type CheckboxLine,
  checkSummaryConfirmationEvidence,
  clearActiveDirectiveMarker,
  codekbRepoName,
  currentUnitLifecycleMode,
  effectivePlanAction,
  errorMessage,
  filterProducesByKind,
  firstInScopeStageOfPhase,
  formatReceivedReply,
  freshReviewReceipts,
  getField,
  gridCostSummary,
  hasAnyUnitClaimRefs,
  installedHarnessName,
  intentRepos,
  inspectContinuationCursor,
  isPluginEnabled,
  isPerUnitStage,
  isRegularFile,
  isTeamUnitOwnership,
  KNOWN_CODEKB_STAGES,
  listIntents,
  LEGACY_PLAN_APPROVAL_RECOVERY_CHOICE,
  loadScopeMetadata,
  loadScopeMetadataAll,
  resolveReviewClass,
  loadScopeMapping,
  nextInScopeStage,
  parseCheckboxes,
  pipelineLinkEvidence,
  parseBoltDag,
  type KnowledgeCommand,
  parseKnowledgeCommand,
  type PluginCommand,
  parsePluginCommand,
  PHASE_NUMBERS,
  PHASES,
  parseWorkspaceCommand,
  READ_ONLY_FLAGS,
  readKiroIdeLegacyPlanApprovalHost,
  readAllAuditShards,
  readAuditShardEvents,
  readApplicableTeamUnitScopeStamp,
  readStateFile,
  recordHookDrop,
  markEngineTouch,
  kiroIdeLegacyPlanApprovalSessionId,
  relativeCodekbDir,
  relativeRecordDirForSelection,
  relativeSpaceRecordPrefix,
  resolveBoltDag,
  type BoltDagResolution,
  resolveProjectDir,
  resolveWorkflowSelection,
  scopeCostSummary,
  selectionAwareDefaultScope,
  singleStageAttemptIsOpen,
  resolveDefaultScope,
  DEFAULT_SCOPE,
  type StageEntry,
  type AuditShardEvent,
  stateFilePath,
  STOP_HOOK_PROBE_ENV,
  stateFilePathForSelection,
  unitDependencyPath,
  unitParkedPath,
  unitParticipantPath,
  swarmConvergedUnits,
  unitCompletedReceipts,
  unitGateStatus,
  type UnitGateRhythm,
  unitLifecycleReceiptsInUse,
  usesStageLevelPerUnitArtifacts,
  unitLifecycleSnapshot,
  unitMergedReceipts,
  unitMergeTransactions,
  unitMergeTransactionsForIdentity,
  unitMajorConstructionStageSlugs,
  toPosix,
  validateLiveUnitScope,
  validScopes,
  harnessDir,
  type WorkspaceCommand,
  type WorkflowSelection,
  writeActiveDirectiveMarker,
  type PlanApprovalLegacyOfferCandidate,
  workspaceCommandUtilityArgv,
  classifyStateVersion,
  currentSwarmAttemptObligations,
  effectiveUnitGateRhythm,
} from "./aidlc-lib.ts";
import {
  cachedUnitClaimOverview,
  localUnitClaimOverviewForIntent,
  type UnitClaimOverview,
} from "./aidlc-unit.ts";
import {
  type Consume,
  type GraphStage,
  loadGraph,
  producersOf,
  subgraphForScope,
} from "./aidlc-graph.ts";
// inferScopeFromText is a PURE function (keyword matching over the scope
// registry) - importing it keeps `next` read-only. The audit-emitting
// detect-scope verb remains the conductor's separate recording move; the
// import is safe (aidlc-utility.ts main() runs only under import.meta.main,
// and utility never imports this module - no cycle).
import { detectWorkspace, inferScopeFromText } from "./aidlc-utility.ts";
import {
  isCompiledExecutable,
  resolveHarnessPath,
  resolveHarnessRoot,
} from "./aidlc-runtime-paths.ts";
import { appendAuditEntries } from "./aidlc-audit.ts";
import { inspectRequiredArtifactInstances } from "./aidlc-artifact-resolution.ts";
import { inspectStageValidity } from "./aidlc-validity.ts";
import {
  readRuleBundle,
  rulesContentEntries,
  type RuleContent,
} from "./aidlc-steering.ts";

// Read the workflow state file if it exists, else null. The engine's `next` is
// a pure read: an absent state file is a legitimate branch (no workflow yet),
// not an error to throw. Composes engineStateFilePath() for the canonical location.
function loadStateFileIfPresent(projectDir: string): string | null {
  const path = engineStateFilePath(projectDir);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

// The default scope when neither the state file, a --scope flag, nor the
// AWS_AIDLC_DEFAULT_SCOPE env var supplies one lives in aidlc-lib.ts
// (DEFAULT_SCOPE, imported above) so exactly one constant plus the env var
// control the implicit default everywhere. Mirrors the prose orchestrator's
// freeform-fallback default (SKILL.md detect-scope fallback).
// selectionAwareDefaultScope() maps it to the sole enabled plugin's
// nominated default on a plugin-only install where it is deselected.

// READ_ONLY_FLAGS (--status/--help/--doctor/--version) and the shared workspace
// parser (space/space-create/intent) are the terminal-command sources of truth
// in aidlc-lib.ts, so the engine's `next` routing and any pre-LLM harness seam
// (the Kiro userPromptSubmit dispatch) classify the same tokens identically.
// See classifyTerminalCommand there.
// Both dispatch before any state inspection (SKILL.md "Read-Only Utility
// Commands" + workspace-vision §3): each maps to a TERMINAL print directive —
// the engine answers "what move?", the conductor runs the tool and prints its
// stdout. The verbs never advance a workflow, so there is nothing for `next` to
// continue into; they are recognised ONLY as the LEADING positional token
// (parseNextFlags guards on i === 0) so freeform prose containing
// "space"/"intent" mid-sentence stays freeform intent text.

// --- Directive emission ---

interface PreparedEmission {
  transported: Directive; serialized: string; resultSha256: string; projectDir?: string;
  marker?: {
    kind: "load-steering" | "run-stage" | "invoke-swarm"; stage: string; unit?: string;
    units?: string[];
    part?: number; parts?: number; continue_token?: string; state_sha256: string;
  };
}

interface PreparedLegacyPlanApproval {
  prepared: PreparedEmission;
  offer?: PlanApprovalLegacyOfferCandidate;
  session?: string;
}

let engineInvocation: { attemptId?: string; commandKind: "next" | "continue" | "report" | "park"; commandSha256: string } | null = null;
let activeStageValidityAdvisory: StageValidityAdvisory | undefined;

function projectStageValidityAdvisory(
  projectDir: string,
  stateContent: string,
): StageValidityAdvisory | undefined {
  try {
    const validity = inspectStageValidity(projectDir, stateContent);
    if (validity.issues.length === 0 && validity.warnings.length === 0) {
      return undefined;
    }
    const direct = validity.issues
      .filter((issue) => issue.direct)
      .map((issue) => issue.stage);
    const downstream = validity.issues
      .filter((issue) => !issue.direct)
      .map((issue) => issue.stage);
    const earliest = direct[0] ?? validity.issues[0]?.stage ?? null;
    const state = validity.warnings.length > 0 ? "unavailable" : "drifted";
    const warning = state === "drifted"
      ? `Completed stage results have drifted; routing is continuing in advisory mode` +
        (earliest ? `. Suggested redo: /aidlc --stage ${earliest}.` : ".")
      : `Stage-validity inspection is partly unavailable; routing is continuing in advisory mode. ${validity.warnings.join(" ")}`;
    return {
      state,
      directly_stale: direct,
      needs_revalidation: downstream,
      untracked: validity.untracked,
      earliest_affected_stage: earliest,
      warning,
    };
  } catch (error) {
    return {
      state: "unavailable",
      directly_stale: [],
      needs_revalidation: [],
      untracked: [],
      earliest_affected_stage: null,
      warning:
        `Stage-validity inspection failed; routing is continuing in advisory mode: ` +
        errorMessage(error),
    };
  }
}

let engineSessionId: string | undefined;
const engineSelections = new Map<string, WorkflowSelection>();

function engineSelection(projectDir: string): WorkflowSelection {
  const cached = engineSelections.get(projectDir);
  if (cached) return cached;
  const selection = resolveWorkflowSelection(projectDir, {
    sessionId: engineSessionId,
  });
  engineSelections.set(projectDir, selection);
  return selection;
}

function engineStateFilePath(projectDir: string): string {
  return stateFilePathForSelection(projectDir, engineSelection(projectDir));
}

function engineRelativeRecordDir(projectDir: string): string | null {
  return relativeRecordDirForSelection(engineSelection(projectDir));
}

function engineChildEnv(
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  return {
    ...process.env,
    ...extra,
    ...(engineSessionId
      ? { AIDLC_SESSION_OVERRIDE: engineSessionId }
      : {}),
  };
}

// Print exactly one directive as JSON to stdout, after validating it against
// the frozen contract. A malformed directive is a hard error (clean
// boundaries), never a silent miss — we exit non-zero so a wiring bug surfaces
// loudly rather than emitting a lie the conductor would act on.
function prepareEmission(directive: Directive): PreparedEmission {
  const route =
    directive.kind === "run-stage" ? runStageRoutes.get(directive) : undefined;
  const publication = publicationContexts.get(directive);
  let transported =
    directive.kind === "run-stage" && route
      ? transportRunStage(directive, route)
      : directive;
  if (activeStageValidityAdvisory) {
    transported = {
      ...transported,
      stage_validity: activeStageValidityAdvisory,
    } as Directive;
  }
  // Per-unit Construction beats: `unit` is attached by callers after the
  // run-stage is built, so the builder's stage-entry line is wrong here (the
  // stage was entered on the first unit, not on this one). Every path that sets
  // `unit` funnels through here - stage-major, unit-major, the swarm settle, and
  // the continue-token rehydration - so this is the one place the rule can hold.
  //
  // Silence was the original answer and it did not survive contact: a moment
  // with no words is a moment the conductor fills, and what it reaches for is
  // the loop's own bookkeeping (which pass this is, what the gate boolean now
  // says). So a building beat gets ONE short line naming the two things that are
  // real to the user: the stage and the unit. The settle beat stays silent
  // because the gate ritual immediately owns that turn.
  if (transported.kind === "run-stage" && transported.unit !== undefined) {
    const line = narratePerUnitBeat(transported);
    if (line === null) delete transported.narration;
    else transported.narration = line;
  }
  const result = validateDirective(transported);
  if (!result.valid) {
    console.error(
      `aidlc-orchestrate: refusing to emit a malformed directive: ${result.errors.join("; ")}`,
    );
    process.exit(1);
  }
  const serialized = JSON.stringify(result.data);
  if (Buffer.byteLength(serialized, "utf-8") > DIRECTIVE_MAX_BYTES) {
    console.error(
      `aidlc-orchestrate: refusing to emit a directive larger than ${DIRECTIVE_MAX_BYTES} bytes`,
    );
    process.exit(1);
  }
  let marker: PreparedEmission["marker"];
  if ((transported.kind === "load-steering" || transported.kind === "run-stage") && route) {
    const markerStateHash =
      route.stateHash ??
      (
        directive.kind === "run-stage" && directive.single === true &&
          existsSync(engineStateFilePath(route.codekbCtx.projectDir))
          ? sha256(readFileSync(engineStateFilePath(route.codekbCtx.projectDir), "utf-8"))
          : sha256("")
      );
    marker = {
      kind: transported.kind,
      stage: transported.stage,
      ...(directive.kind === "run-stage" && directive.unit ? { unit: directive.unit } : {}),
      ...(transported.kind === "load-steering"
        ? {
            part: transported.part,
            parts: transported.parts,
            continue_token: transported.continue_token,
          }
        : {}),
      state_sha256: markerStateHash,
    };
  }
  if (transported.kind === "invoke-swarm" && publication) {
    marker = {
      kind: "invoke-swarm",
      stage: "code-generation",
      units: transported.units,
      state_sha256: publication.stateHash,
    };
  }
  return {
    transported,
    serialized,
    resultSha256: sha256(serialized),
    ...(route
      ? { projectDir: route.codekbCtx.projectDir }
      : publication
        ? { projectDir: publication.projectDir }
        : {}),
    ...(marker ? { marker } : {}),
  };
}

function attachLegacyKiroPlanApprovalChoices(
  prepared: PreparedEmission,
): PreparedLegacyPlanApproval {
  const projectDir = prepared.projectDir;
  const directive = prepared.transported;
  if (
    !projectDir ||
    prepared.marker?.stage !== "code-generation" ||
    installedHarnessName(projectDir) !== "kiro-ide"
  ) {
    return { prepared };
  }
  const session = kiroIdeLegacyPlanApprovalSessionId();
  if (
    !session ||
    readKiroIdeLegacyPlanApprovalHost(projectDir, session)?.session !== session
  ) {
    return { prepared };
  }
  const eligible =
    (
      directive.kind === "run-stage" &&
      directive.stage === "code-generation" &&
      directive.swarm_settled !== true
    ) ||
    directive.kind === "invoke-swarm";
  if (!eligible) return { prepared, session };

  const nonce = randomBytes(6).toString("hex");
  const choices: LegacyPlanApprovalChoices = {
    approve: `Approve Plan [${nonce}]`,
    request_changes: `Request Changes [${nonce}]`,
  };
  directive.legacy_plan_approval_choices = choices;
  const validated = validateDirective(directive);
  if (!validated.valid) {
    throw new Error(
      `legacy Plan Approval choices produced an invalid directive: ${validated.errors.join("; ")}`,
    );
  }
  const serialized = JSON.stringify(validated.data);
  if (Buffer.byteLength(serialized, "utf-8") > DIRECTIVE_MAX_BYTES) {
    throw new Error(
      "legacy Plan Approval choices exceed the directive transport limit",
    );
  }
  const optionHashes = [
    sha256(choices.approve.toLowerCase()),
    sha256(choices.request_changes.toLowerCase()),
  ] as [string, string];
  return {
    prepared: {
      ...prepared,
      transported: validated.data,
      serialized,
      resultSha256: sha256(serialized),
    },
    offer: { session, optionHashes },
    session,
  };
}

function writePrepared(prepared: PreparedEmission): void {
  writeFileSync(1, `${prepared.serialized}\n`, "utf-8");
}

function isTeamStopHookProbe(projectDir: string | undefined): boolean {
  if (
    process.env.AIDLC_STOP_HOOK_PROBE !== "1" ||
    !projectDir
  ) {
    return false;
  }
  try {
    return isTeamUnitOwnership(readStateFile(projectDir));
  } catch {
    return false;
  }
}

// The Stop hook's own `next` consultation, whatever the Unit Ownership. That
// probe is READ-ONLY BY CONTRACT: aidlc-continue-workflow.ts parses the prepared
// directive off stdout and never reads the durable marker, so publishing from a
// probe buys nothing and costs correctness. Publishing from a bare probe `next`
// fails preserveCodeGenerationAuthority in writeActiveDirectiveMarker (the base
// marker is `run-stage`, not swarm planning), so the write bumps
// code_generation_authority_revision and calls resetPlanApprovalRuntime, which
// removes the whole plan-approval runtime dir. Recording the human's "Approve
// Plan" answer needs a turn boundary, so the challenge minted in turn N was
// destroyed by turn N's own Stop probe and Plan Approval could never stabilize
// (issue #995). The predicate is deliberately env-only: the deadlock is not
// specific to team-owned units, and handleContinue already suppresses its cursor
// advance for every probe rather than only the team ones.
function isStopHookProbe(): boolean {
  return process.env[STOP_HOOK_PROBE_ENV] === "1";
}

function legacyPlanApprovalRecoveryDirective(): AskDirective {
  return {
    kind: "ask",
    ask_type: "legacy-plan-approval-recovery",
    response_route: "next",
    recovery_choice: LEGACY_PLAN_APPROVAL_RECOVERY_CHOICE,
    question:
      "This legacy Kiro window must recover the current Code Generation Plan Approval capability before it can be reissued. Choose exactly: Recover Plan Approval",
  };
}

function emit(directive: Directive): void {
  const withLegacyOffer = attachLegacyKiroPlanApprovalChoices(
    prepareEmission(directive),
  );
  const prepared = withLegacyOffer.prepared;
  if (
    prepared.marker &&
    !isStopHookProbe()
  ) {
    const projectDir = prepared.projectDir;
    try {
      if (projectDir) {
        const publication = writeActiveDirectiveMarker(projectDir, prepared.marker, {
          ...(engineInvocation?.attemptId ? { attemptId: engineInvocation.attemptId } : {}),
          ...(engineInvocation ? { commandKind: engineInvocation.commandKind } : {}),
          ...(engineInvocation ? { commandSha256: engineInvocation.commandSha256 } : {}),
          ...(withLegacyOffer.offer
            ? { legacyPlanApprovalOffer: withLegacyOffer.offer }
            : {}),
          ...(withLegacyOffer.session
            ? { legacyPlanApprovalSession: withLegacyOffer.session }
            : {}),
          resultSha256: prepared.resultSha256,
        });
        if (publication === "legacy-plan-approval-owned") {
          writePrepared(prepareEmission(errorDirective(
            "Legacy Kiro Plan Approval is owned by another active IDE window. Continue the pending approval there; this call did not receive or rotate its protected choices.",
          )));
          return;
        }
        if (publication === "legacy-plan-approval-recovery-required") {
          writePrepared(
            prepareEmission(legacyPlanApprovalRecoveryDirective()),
          );
          return;
        }
        if (
          publication === "legacy-plan-approval-reissued" ||
          publication === "legacy-plan-approval-transport"
        ) {
          writePrepared(prepared);
          return;
        }
        if (publication === "stale-attempt") {
          recordHookDrop(projectDir, "active-directive", "tracked fresh next attempt was superseded before publication");
          writePrepared(prepareEmission(errorDirective(
            "This tracked `next` attempt is stale or superseded, so its prepared result was not issued. Run a fresh `next` in the current Copilot session.",
          )));
          return;
        }
        if (publication !== "copilot-committed" && publication !== "generic-committed") {
          recordHookDrop(projectDir, "active-directive", "fresh next did not commit its directive");
          writePrepared(prepareEmission(errorDirective(
            "The directive could not be published, so no work directive was issued. Retry the command; if coordination remains busy, run `/aidlc --doctor`.",
          )));
          return;
        }
      }
    } catch (e) {
      if (projectDir) {
        recordHookDrop(projectDir, "active-directive", errorMessage(e));
      }
      writePrepared(prepareEmission(errorDirective(
        "The directive could not be published, so no work directive was issued. Retry the command; if coordination remains busy, run `/aidlc --doctor`.",
      )));
      return;
    }
  }
  writePrepared(prepared);
}

// --- Composing sibling CLI tools ---
//
// The non-happy-path branches reuse aidlc-jump.ts / aidlc-utility.ts handlers,
// none of which is importable (both files export zero CLI handlers). We resolve
// the tools directory off THIS module's own location in source mode. A compiled
// executable re-enters the public dispatcher grammar instead.
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const IS_COMPILED = isCompiledExecutable();

function isKiroRoutingHarness(): boolean {
  if (IS_COMPILED) {
    const explicit = process.env.AIDLC_HARNESS_NAME?.trim();
    return explicit === "kiro" || explicit === "kiro-ide";
  }
  const invokedScript = (process.argv[1] ?? "").replaceAll("\\", "/");
  if (/(^|\/)\.kiro\/tools\/aidlc-orchestrate\.ts$/.test(invokedScript)) {
    return true;
  }
  try {
    const parsed = JSON.parse(
      readFileSync(join(TOOLS_DIR, "data", "harness.json"), "utf-8"),
    ) as { name?: unknown };
    return parsed.name === "kiro" || parsed.name === "kiro-ide";
  } catch {
    // Authored core and compiled binaries can lack generated metadata.
    const explicit = process.env.AIDLC_HARNESS_NAME?.trim();
    return explicit === "kiro" || explicit === "kiro-ide";
  }
}

function toolPath(file: string): string {
  return join(TOOLS_DIR, file);
}

function toolCommand(toolFile: string, args: string[]): string[] {
  if (IS_COMPILED) {
    if (toolFile === "aidlc-utility.ts" && args[0] === "resolve-env-scope") {
      return [process.execPath, "scope", "resolve-env", ...args.slice(1)];
    }
    if (toolFile === "aidlc-jump.ts") {
      return [process.execPath, "jump", ...args];
    }
    throw new Error(`No compiled dispatcher route for ${toolFile} ${args.join(" ")}`);
  }
  return [process.execPath, toolPath(toolFile), ...args];
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
    cmd: toolCommand(toolFile, args),
    env: engineChildEnv(),
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

// --- Narration (the spoken line the conductor relays) ---
//
// Every line below is authored HERE, next to the facts, because the engine knows
// them deterministically and the conductor does not have to guess. Left to
// improvise, the conductor narrates what it can see - the tool it ran, the kind
// it received, the routing it is following - which is the machinery, not the
// user's project. These lines describe the work instead.
//
// House style for anything added here:
//   - One sentence. Two only when the second one tells the user what to expect.
//   - About the user's project, never about this framework's parts. No internal
//     nouns: the reader has no engine, no directive, no dispatch, no conductor.
//   - Present tense, first person, plain. "Setting up ...", "Starting ...".
//   - Name real things by their real names: stage display names, scope names,
//     and file paths are the user's landmarks and stay verbatim.
//   - Say nothing a reader would have to already know the framework to parse.
//
// A line is deliberately ABSENT for beats that should be silent: rule-bundle
// transport, per-unit iteration beats, and anything the user did not ask about.
// Absence is the instruction to say nothing, and it is the common case.

// The user-facing name for a phase. The graph's phase tokens are SHOUTED
// machine values (IDEATION); spoken prose wants ordinary words.
function phaseInWords(phase: string): string {
  const normalized = phase.trim().toLowerCase();
  if (normalized.length === 0) return "";
  return normalized;
}

// The first run-stage of a workflow is the one place a spoken line can set the
// whole frame: what kind of plan is running, and what the first real step is.
// Later stages get the shorter per-stage line.
function narrateStageEntry(
  node: GraphStage,
  scope: string,
  isFirst: boolean,
  gate: GateValue,
): string {
  const stageName = node.name;
  if (isFirst) {
    return (
      `Starting the ${scope} plan for this project. First step is ${stageName}, ` +
      `and I will stop for your review before anything is final.`
    );
  }
  // Entering the build phase names a piece of vocabulary the user is about to
  // see in their own artifacts (bolt-plan.md, and every later beat of this
  // phase), so the line that introduces it defines it in the same breath. The
  // definition is delivery-planning's own, said the way a colleague would say
  // it. Said once, on the phase boundary; later Construction stages get the
  // ordinary per-stage line.
  if (isFirstConstructionStage(node, scope)) {
    return (
      `Starting the first Bolt now: one build pass over the code, tests and ` +
      `checks for a piece of the work. First step is ${stageName}.`
    );
  }
  // A non-gating stage runs straight through, so the line says so rather than
  // leaving the user waiting for a prompt that is not coming.
  if (gate === false) {
    return `Next up: ${stageName}. This one runs through without needing your input.`;
  }
  // Who is in the room. On an inline stage the session adopts the lead's
  // perspective and any supports as further perspectives, and that is worth one
  // clause: the user is meeting colleagues by trade, which is a fact about their
  // project's work, where "loaded the persona files" is a fact about ours.
  return `Now working on ${stageName}, ${peopleClause(node)}.`;
}

// The trades participating in an inline stage, phrased as a person would:
// "wearing the product manager hat, with the architect on hand". Falls back to
// the phase clause when no trade resolves, so a stage never gets a broken line.
function peopleClause(node: GraphStage): string {
  const lead = roleInWords(node.lead_agent);
  if (!lead) return `in the ${phaseInWords(node.phase)} phase`;
  const supports = (node.support_agents ?? [])
    .map(roleInWords)
    .filter((trade) => trade.length > 0);
  if (supports.length === 0) return `wearing the ${lead} hat`;
  const list =
    supports.length === 1
      ? supports[0]
      : `${supports.slice(0, -1).join(", ")} and ${supports[supports.length - 1]}`;
  return `wearing the ${lead} hat, with the ${list} on hand`;
}

// A dispatched stage hands the work to a named specialist. The user cares that
// someone with a particular focus is doing it, not that a Task call happened.
function narrateSpecialistStage(node: GraphStage): string {
  const role = roleInWords(node.lead_agent);
  return role
    ? `Bringing in the ${role} to work on ${node.name}.`
    : `Now working on ${node.name}.`;
}

// The spoken line for ONE iteration of a per-unit Construction stage. Called
// from emit(), the single choke point every unit-carrying directive passes
// through, and deliberately the SHORTEST line in this file: the user is watching
// the same stage name go past once per piece of work, so anything longer reads
// as repetition. Two facts, both theirs: the stage, and which piece of their
// work it is running for.
//
// null = say nothing. That is the settle beat (gate not false), where the stage
// is fully built and the very next thing the conductor does is present the gate
// ritual, which owns its own words. A line here would preface that with a
// re-announcement of a stage the user has already watched run.
//
// The placeholder unit (a scope with no unit DAG) is not a real name, so it
// falls back to the stage alone rather than saying the token out loud.
function narratePerUnitBeat(directive: RunStageDirective): string | null {
  if (directive.gate !== false) return null;
  const unit = directive.unit;
  if (unit === undefined || unit === UNIT_NAME_PLACEHOLDER) return null;
  const stageName = nodeForSlug(directive.stage)?.name ?? directive.stage;
  return `Now working on ${unit}: the ${stageName} pass.`;
}

// True when `node` is the FIRST in-scope Construction stage, i.e. the stage the
// workflow crosses the Construction boundary on. Reuses the same resolution the
// walking-skeleton gate uses (isSkeletonGateStage), so "the first Bolt" means
// the same stage to the spoken line as it does to the gate.
function isFirstConstructionStage(node: GraphStage, scope: string): boolean {
  return isSkeletonGateStage(node, scope);
}

// Turn an agent filename into the TRADE a person would say out loud:
// aidlc-architect-agent -> "architect", aidlc-product-agent -> "product manager".
// The user is meeting a colleague, so the words are the ones a colleague would
// use about themselves; a slug fragment like "product" or "aws platform" is not
// one. Unmapped names fall back to the de-slugged fragment, and an unfamiliar
// shape returns "" so the caller can drop the role clause rather than invent it.
const TRADE_BY_ROLE: Readonly<Record<string, string>> = {
  product: "product manager",
  "product lead": "product lead",
  design: "designer",
  delivery: "delivery lead",
  architect: "architect",
  "architecture reviewer": "architecture reviewer",
  "aws platform": "platform engineer",
  compliance: "compliance specialist",
  devsecops: "security engineer",
  developer: "developer",
  quality: "quality engineer",
  "pipeline deploy": "release engineer",
  operations: "operations engineer",
};

function roleInWords(agent: string): string {
  const match = /^aidlc-(.+)-agent$/.exec(agent.trim());
  if (!match) return "";
  const fragment = match[1].replaceAll("-", " ");
  return TRADE_BY_ROLE[fragment] ?? fragment;
}

// Record that the engine was ADVANCED this turn, for the Stop hook's
// conversational carve-out on transcript-free harnesses (Kiro, opencode). The
// hook compares .aidlc-engine-touch's mtime against .aidlc-human-turn's: newer
// engine => the conductor engaged the workflow => a bail mid-loop must still be
// nudged; older => the human's last prompt was answered as pure chat.
//
// TWO exclusions keep the marker honest, and BOTH are load-bearing:
//   1. The Stop hook's OWN `next` probe. markEngineTouch is a no-op when
//      STOP_HOOK_PROBE_ENV is set (aidlc-lib.ts). Without it the hook's own
//      consultation would refresh the marker on every stop, the predicate would
//      be permanently false, and the carve-out would be silently dead code.
//   2. Read-only routing (--status / --doctor / --help / --version, and the
//      workspace verbs). These carry no workflow intent, so counting them as
//      engagement would make "what's my status?" a non-conversational turn.
//      isEngineToolCall exempts the same read-only flags, so the two predicates
//      agree HERE — but they do not agree everywhere: the marker is blind to
//      aidlc-jump / aidlc-bolt / aidlc-swarm and the mutating aidlc-state verbs,
//      which the transcript predicate does count. See the coverage-gap note on
//      markEngineTouch in aidlc-lib.ts; do not restate this as full parity.
// Advisory throughout: a marker failure must never fail an engine invocation.
function touchEngineMarker(projectDir: string | undefined): void {
  try {
    markEngineTouch(resolveProjectDir(projectDir));
  } catch {
    /* advisory - the marker is a Stop-hook optimisation, never a hard dependency */
  }
}

// --- Terminal-directive constructors (the non-run-stage kinds) ---

function askDirective(question: string): AskDirective {
  return { kind: "ask", question };
}

function newWorkRoutingAskDirective(
  question: string,
  numberedProseQuestion: string,
  description: string,
  proposedScope: string,
  availableIntents?: string[],
): AskDirective {
  // Once emitted, this typed ask is the sole route authority for the pending
  // prose. Harnesses render it and stop rather than reclassifying the request.
  return {
    kind: "ask",
    ask_type: "new-work-routing",
    response_route: "next",
    question,
    numbered_prose_question: numberedProseQuestion,
    new_work_description: description,
    proposed_scope: proposedScope,
    ...(availableIntents ? { available_intents: availableIntents } : {}),
  };
}

function printDirective(message: string): PrintDirective {
  return { kind: "print", message };
}

function noticeDirective(message: string): NoticeDirective {
  return { kind: "notice", message };
}

function unitClaimAskDirective(
  overview: ReturnType<typeof cachedUnitClaimOverview>,
): AskDirective {
  const claimed = overview.claimed.length === 0
    ? "none"
    : overview.claimed.map((row) => `${row.unit} (${row.owner})`).join(", ");
  const waiting = overview.waiting.length === 0
    ? "none"
    : overview.waiting
        .map((row) => `${row.unit} waits on ${row.blockedBy.join(", ")}`)
        .join("; ");
  return {
    kind: "ask",
    ask_type: "unit-claim",
    response_route: "claim",
    question:
      `Choose a Unit to claim. Claimable: ${overview.claimable.join(", ") || "none"}. ` +
      `Claimed: ${claimed}. Waiting: ${waiting}.`,
    claimable_units: overview.claimable,
    claimed_units: overview.claimed.map((row) => ({
      unit: row.unit,
      holder: row.owner,
    })),
    waiting_units: overview.waiting.map((row) => ({
      unit: row.unit,
      blocked_by: row.blockedBy,
    })),
  };
}

export interface TeamConstructionBoard {
  grid: string;
  claims: Array<{
    unit: string;
    status: "claimed" | "released";
    owner: string;
    generation: number;
    observedActivity: string;
  }>;
  awaitingMerge: Array<{
    unit: string;
    status: string;
    pinnedOid: string;
    readiness: string;
    releasedAfterGitAccepted: boolean;
  }>;
  claimable: string[];
  blocked: Array<{ unit: string; blockedBy: string[] }>;
  warning?: string;
  fanoutActive: boolean;
}

function observedClaimActivity(
  claim: UnitClaimOverview["claims"] extends Map<string, infer T> ? T : never,
): string {
  if (claim.movementObserved) {
    return claim.observedAt
      ? `observed ref movement since ${claim.observedAt}`
      : "observed ref movement since the prior snapshot";
  }
  return claim.observedAt
    ? `last observed ref movement ${claim.observedAt}`
    : "no ref movement observation recorded";
}

function mergeReadiness(status: string): string {
  switch (status) {
    case "pinned":
      return "pinned and ready for merge gate";
    case "approved":
      return "merge gate approved; ready to land";
    case "rejected":
      return "merge gate rejected; revise and re-pin";
    case "git-landed":
      return "content landed; state fold pending";
    case "state-folded":
      return "state folded; audit finalization pending";
    default:
      return status;
  }
}

function compareBoardKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildTeamConstructionBoard(
  projectDir: string,
  stateContent: string,
  options: {
    readOnly?: boolean;
    overview?: UnitClaimOverview;
  } = {},
): TeamConstructionBoard {
  const overview = options.overview ??
    cachedUnitClaimOverview(projectDir, {
      writeCache: options.readOnly !== true,
    });
  const model = deriveTeamUnitProgressModel(
    projectDir,
    stateContent,
    undefined,
    undefined,
    { readOnly: options.readOnly === true },
  );
  return assembleTeamConstructionBoard(
    model.section,
    overview,
    unitMergeTransactions(projectDir),
  );
}

function unitProgressSectionFromState(stateContent: string): string | null {
  const heading = /^## Unit Progress\s*$/m.exec(stateContent);
  if (!heading) return null;
  const after = heading.index + heading[0].length;
  const next = /^## /m.exec(stateContent.slice(after));
  return stateContent
    .slice(heading.index, next ? after + next.index : stateContent.length)
    .trimEnd();
}

function initialUnitProgressSection(
  stateContent: string,
  dependencyBody: string,
  overview: UnitClaimOverview,
  transactions: ReturnType<typeof unitMergeTransactions>,
): string {
  const parsed = parseBoltDag(dependencyBody);
  if (!parsed.ok || parsed.units.length === 0) {
    throw new Error(
      `Team Construction board requires a valid non-empty Unit DAG: ${
        parsed.ok ? "no Units found" : `${parsed.reason}: ${parsed.detail}`
      }.`,
    );
  }
  const scope = getField(stateContent, "Scope") ?? "";
  const stages = unitMajorConstructionStageSlugs(scope, stateContent, true);
  if (stages.length === 0) {
    throw new Error(
      "Team Construction board found no active per-Unit Construction stages.",
    );
  }
  const transactionByUnit = new Map(
    transactions.map((transaction) => [transaction.unit, transaction]),
  );
  const mergeTracking = transactions.length > 0;
  return [
    "## Unit Progress",
    "<!-- Derived read-only snapshot; the engine persists this projection on the next active workflow refresh. -->",
    `| unit | owner | ${stages.join(" | ")} | gate |${
      mergeTracking ? " merged |" : ""
    }`,
    `| --- | --- | ${stages.map(() => "---").join(" | ")} | --- |${
      mergeTracking ? " --- |" : ""
    }`,
    ...parsed.units.map((entry) => {
      const claim = overview.claims.get(entry.name);
      const transaction = transactionByUnit.get(entry.name);
      const owner = claim?.status === "claimed"
        ? claim.owner
        : transaction?.owner ?? "-";
      return `| ${entry.name} | ${owner} | ${
        stages.map(() => "[ ]").join(" | ")
      } | [ ] |${
        mergeTracking
          ? ` ${transaction?.status === "complete" ? "[x]" : "[ ]"} |`
          : ""
      }`;
    }),
  ].join("\n");
}

export function buildTeamConstructionBoardForIntent(
  projectDir: string,
  stateContent: string,
  selector: {
    space: string;
    intentUuid: string;
    dependencyBody: string;
  },
): TeamConstructionBoard {
  const overview = localUnitClaimOverviewForIntent(projectDir, {
    space: selector.space,
    intentUuid: selector.intentUuid,
    stateContent,
    dependencyBody: selector.dependencyBody,
  });
  const transactions = unitMergeTransactionsForIdentity(
    projectDir,
    selector.space,
    selector.intentUuid,
  );
  const grid = unitProgressSectionFromState(stateContent) ??
    initialUnitProgressSection(
      stateContent,
      selector.dependencyBody,
      overview,
      transactions,
    );
  return assembleTeamConstructionBoard(
    grid,
    overview,
    transactions,
  );
}

function assembleTeamConstructionBoard(
  grid: string,
  overview: UnitClaimOverview,
  transactions: ReturnType<typeof unitMergeTransactions>,
): TeamConstructionBoard {
  const claims = [...overview.claims.values()]
    .sort((a, b) => compareBoardKeys(a.unit, b.unit))
    .map((claim) => ({
      unit: claim.unit,
      status: claim.status,
      owner: claim.owner,
      generation: claim.generation,
      observedActivity: observedClaimActivity(claim),
    }));
  const awaitingMerge = transactions
    .filter((transaction) => transaction.status !== "complete")
    .sort((a, b) => compareBoardKeys(a.unit, b.unit))
    .map((transaction) => ({
      unit: transaction.unit,
      status: transaction.status,
      pinnedOid: transaction.pinned_oid,
      readiness: mergeReadiness(transaction.status),
      releasedAfterGitAccepted:
        transaction.released_after_git !== undefined,
    }));
  const claimable = [...overview.claimable].sort();
  const blocked = overview.waiting
    .map((row) => ({
      unit: row.unit,
      blockedBy: [...row.blockedBy].sort(),
    }))
    .sort((a, b) => compareBoardKeys(a.unit, b.unit));
  return {
    grid,
    claims,
    awaitingMerge,
    claimable,
    blocked,
    ...(overview.warning ? { warning: overview.warning } : {}),
    fanoutActive:
      awaitingMerge.length > 0 ||
      overview.claimed.length > 0,
  };
}

export function renderTeamConstructionBoard(
  board: TeamConstructionBoard,
  mode: "dispatcher" | "snapshot",
): string {
  const title = mode === "snapshot"
    ? "# Team Construction Snapshot"
    : "# Team Construction Dispatcher";
  const claimRows = board.claims.length === 0
    ? ["| - | - | - | - | no claim refs observed |"]
    : board.claims.map(
      (claim) =>
        `| ${claim.unit} | ${claim.status} | ${claim.owner} | ${claim.generation} | ${claim.observedActivity} |`,
    );
  const mergeRows = board.awaitingMerge.length === 0
    ? ["| - | - | - | none |"]
    : board.awaitingMerge.map(
      (row) =>
        `| ${row.unit} | ${row.status} | \`${row.pinnedOid.slice(0, 12)}\` | ${row.readiness} |`,
    );
  const blockedRows = board.blocked.length === 0
    ? ["| - | none |"]
    : board.blocked.map(
      (row) => `| ${row.unit} | ${row.blockedBy.join(", ")} |`,
    );
  const claimedSummary = board.claims
    .filter((claim) => claim.status === "claimed")
    .map((claim) => `${claim.unit} (${claim.owner})`)
    .join(", ") || "none";
  const blockedSummary = board.blocked
    .map((row) => `${row.unit} waits on ${row.blockedBy.join(", ")}`)
    .join("; ") || "none";
  const nextActions: string[] = [];
  const reclaimable = new Set([
    ...board.claimable,
    ...board.claims
      .filter((claim) => claim.status === "released")
      .map((claim) => claim.unit),
  ]);
  for (const unit of [...reclaimable].sort(compareBoardKeys)) {
    nextActions.push(
      `- Claim or reclaim \`${unit}\` when eligible with \`/aidlc --claim ${unit}\`.`,
    );
  }
  for (const row of board.awaitingMerge) {
    if (row.status === "pinned") {
      nextActions.push(
        `- Record the pinned merge decision for \`${row.unit}\` with \`aidlc unit gate ${row.unit}\`.`,
      );
    } else if (
      row.status === "approved" ||
      row.status === "git-landed" ||
      row.status === "state-folded"
    ) {
      const released = board.claims.some(
        (claim) =>
          claim.unit === row.unit && claim.status === "released",
      );
      nextActions.push(
        released &&
            row.status === "git-landed" &&
            !row.releasedAfterGitAccepted
          ? `- The landed attempt for \`${row.unit}\` was released. Inspect the merge commit, then run \`aidlc unit land ${row.unit} --accept-released-attempt --user-input "<human acknowledgment>"\`.`
          : `- Resume \`${row.unit}\` with \`aidlc unit land ${row.unit}\`.`,
      );
    } else if (row.status === "rejected") {
      nextActions.push(
        `- Revise, publish, and re-pin \`${row.unit}\` before requesting another merge gate.`,
      );
    }
  }
  if (nextActions.length === 0) {
    nextActions.push(
      "- No dispatcher action is pending; main may resume the normal Construction walk.",
    );
  }
  return [
    title,
    mode === "snapshot"
      ? "_Read-only local snapshot; observed activity is not a remote push time._"
      : "_Turn-terminal dispatcher view; observed activity is not a remote push time._",
    `**Claimed:** ${claimedSummary}. **Claimable:** ${
      board.claimable.join(", ") || "none"
    }. **Waiting:** ${blockedSummary}.`,
    "",
    board.grid,
    "",
    "## Claim Registry",
    "| unit | status | owner | attempt | observed activity |",
    "| --- | --- | --- | ---: | --- |",
    ...claimRows,
    "",
    "## Awaiting Merge",
    "| unit | transaction | pinned OID | readiness |",
    "| --- | --- | --- | --- |",
    ...mergeRows,
    "",
    `## Claimable Units\n${board.claimable.length > 0 ? board.claimable.map((unit) => `- ${unit}`).join("\n") : "- none"}`,
    "",
    "## Blocked Units",
    "| unit | blockers |",
    "| --- | --- |",
    ...blockedRows,
    "",
    "## Next Actions",
    ...nextActions,
    ...(board.warning ? ["", `> Warning: ${board.warning}`] : []),
  ].join("\n");
}

function errorDirective(message: string): ErrorDirective {
  return { kind: "error", message };
}

// State-schema-version guard. The classifier (aidlc-lib.ts
// `classifyStateVersion`) is the single source of truth for parsing and
// classifying `- **State Version**: N` lines; runtime (next/report) and doctor
// call it the same way so they can never disagree on whether a state is
// unparseable / past / future / ok. staleStateVersionError() is the runtime
// adapter: it returns the classifier's message on any incompatible verdict and
// null on `ok`, so next/report can emit the message as an errorDirective
// before any workflow-cursor read/advance.
function staleStateVersionError(stateContent: string): string | null {
  const verdict = classifyStateVersion(stateContent);
  return verdict.kind === "ok" ? null : verdict.message;
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

// parked - the terminal directive a parked workflow emits (issue #367). Carries
// the slug it parked at; the Stop hook treats `parked` as a terminal allow so
// the conductor can end its turn at a clean inter-stage boundary.
function parkedDirective(reason: string, stage: string): ParkedDirective {
  return {
    kind: "parked",
    reason,
    stage,
    // Parking is the one stop that a user could mistake for a crash, so the
    // spoken line says the work is safe and names the way back in.
    narration:
      "Pausing here with everything saved. Run `/aidlc --resume` when you want to pick it back up.",
  };
}

// Workspace detection can serve several scope examples in one routing answer;
// cache it so a process scans each project root at most once.
const workspaceProjectType = new Map<string, string | null>();

function detectedProjectType(projectDir: string): string | null {
  if (workspaceProjectType.has(projectDir)) {
    return workspaceProjectType.get(projectDir) ?? null;
  }
  let projectType: string | null = null;
  try {
    projectType = detectWorkspace(projectDir).projectType.toLowerCase();
  } catch {
    // Cost disclosure must never block routing; nominal counts remain useful.
  }
  workspaceProjectType.set(projectDir, projectType);
  return projectType;
}

function effectiveScopeCostSummary(scope: string, projectDir: string) {
  const nominal = scopeCostSummary(scope);
  if (!nominal) return null;
  const definition = loadScopeMapping()[scope];
  if (
    definition?.stages["reverse-engineering"] !== "EXECUTE" ||
    detectedProjectType(projectDir) !== "greenfield"
  ) {
    return nominal;
  }
  const adjusted = { ...definition.stages, "reverse-engineering": "SKIP" as const };
  return gridCostSummary(adjusted);
}

// The one-line ceremony preview for a scope, deterministic from the effective
// compiled grid: "N of T stages, G approval gates" plus a per-unit clause when
// Construction stages fan out per Unit of Work. Greenfield previews apply the
// same reverse-engineering adjustment intent creation writes into state.
// Returns "" for a scope that does not resolve (a fixture tree without it), so
// callers can drop the whole clause rather than emit a broken preview.
function costClause(scope: string, projectDir: string): string {
  const c = effectiveScopeCostSummary(scope, projectDir);
  if (!c) return "";
  const perUnit = c.perUnitStages > 0
    ? `, ${c.perUnitStages} ${c.perUnitStages === 1 ? "stage repeats" : "stages repeat"} per unit of work in Construction`
    : "";
  return `${c.execute} of ${c.total} stages, ${c.gates} approval gates${perUnit}`;
}

// --- Flag parsing ---

interface ParsedFlags {
  scope?: string;
  positionalScope?: string; // leading valid scope token (e.g. `/aidlc bugfix Fix the crash`)
  stage?: string;
  phase?: string;
  depth?: string;
  testStrategy?: string;
  review?: string; // --review <adversarial|advisory|none>: per-run review-class override
  readOnly?: string; // the matched read-only flag, if any
  readOnlyArgs?: string[]; // allowlisted trailing args for the read-only flag (e.g. --doctor --export --output <dir>)
  resume?: boolean; // --resume: continue an existing workflow directly
  single?: boolean; // --single: run ONE stage under a synthetic workflow id, never touching the main pointer
  newIntent?: boolean; // --new-intent: the conductor confirmed new-work alongside an active intent → emit the SAME creation directive (with the --label seam) the fresh-start path uses, instead of constructing intent-create from SKILL.md prose
  intent?: string; // freeform request text (no leading --flag)
  workspaceCommand?: WorkspaceCommand; // leading workspace command (space/space-create/intent)
  pluginCommand?: Exclude<PluginCommand, { kind: "not-plugin" }>; // leading plugin noun: terminal list/sync/select/help/error
  knowledgeCommand?: Exclude<KnowledgeCommand, { kind: "not-knowledge" }>; // leading knowledge noun: terminal DocumentKB verbs/help/error
  compose?: boolean; // leading `compose` verb: force the composer (front or in-flight)
  newScope?: boolean; // --new-scope: force the composer to SYNTHESIZE a custom scope even when a stock scope matches
  report?: string; // --report <path>: compose from a scan report (the composer triages the file)
  claim?: string;
  release?: string;
  claimTeam?: string;
  claimRhythm?: string;
  projectDir?: string;
  parseError?: string;
}

// Extract the flags the `next` decision rule consumes. --project-dir is pulled
// out by the caller before this runs; here we read scope/stage/phase/depth/
// test-strategy, the boolean mode flags (--resume/--single), and detect a
// read-only utility flag. Any leading non-flag token is the freeform intent
// (mirrors `/aidlc <freeform description>`). Mirrors the prose orchestrator's
// flag extraction — the value of a valued flag is the following argv token.
function parseNextFlags(args: string[]): ParsedFlags {
  // A SOLE bare `help` / `-h` token is a help REQUEST, not intent text. Without
  // this, the token falls into intentWords and the freeform funnel offers to
  // create an intent literally named "help" (fresh workspace) or silently
  // advances the active stage (live workflow). Sole-token only: `help` inside a
  // longer description ("help me build auth") stays freeform intent text.
  // PARITY: classifyTerminalCommand (aidlc-lib.ts) mirrors this rule - the Kiro
  // verb-intercept seam and the engine must never disagree on what is terminal.
  if (args.length === 1 && (args[0] === "help" || args[0] === "-h")) {
    return { readOnly: "--help" };
  }
  const pluginCommand = parsePluginCommand(args);
  if (pluginCommand.kind !== "not-plugin") return { pluginCommand };
  const knowledgeCommand = parseKnowledgeCommand(args);
  if (knowledgeCommand.kind !== "not-knowledge") return { knowledgeCommand };
  // Leading workspace nouns own the command. Any later read-only-looking token
  // is part of that workspace command's argv, not a mode switch, because the
  // public grammar promises leading-token semantics.
  const workspaceCommand = parseWorkspaceCommand(args);
  if (workspaceCommand.kind !== "not-workspace") {
    if (workspaceCommand.kind === "help") return { readOnly: "--help" };
    return { workspaceCommand };
  }
  const flags: ParsedFlags = {};
  const intentWords: string[] = [];
  let literalIntent = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (literalIntent) {
      intentWords.push(a);
      continue;
    }
    if (a === "--") {
      literalIntent = true;
      continue;
    }
    if (READ_ONLY_FLAGS.has(a)) {
      flags.readOnly = a;
      continue;
    }
    // Allowlisted trailing args for `--doctor`: `--export` (boolean) and
    // `--output <dir>`. Recognised ONLY once `--doctor` has matched, so they
    // never leak into another read-only flag or into freeform intent text.
    // Kept as a fixed allowlist (mirrored by classifyTerminalCommand in
    // aidlc-lib.ts) so an arbitrary token can never ride the read-only path
    // into the tool. The value of `--output` is the following non-flag token.
    if (flags.readOnly === "--doctor" && (a === "--export" || a === "--output")) {
      flags.readOnlyArgs = flags.readOnlyArgs ?? [];
      flags.readOnlyArgs.push(a);
      if (a === "--output") {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.readOnlyArgs.push(next);
          i++;
        }
      }
      continue;
    }
    // A LEADING `compose` verb forces the composer (front on a fresh workspace,
    // in-flight recompose over an active one). DELIBERATELY its own check, NOT a
    // WORKSPACE_VERBS entry: that set feeds classifyTerminalCommand, which the
    // Kiro verb-intercept hook runs OFF-BAND as a terminal aidlc-utility
    // subcommand (and arms the roll-forward latch) - compose is workflow work
    // the conductor must dispatch, never a terminal utility. Only the FIRST
    // positional token counts, so freeform prose containing "compose"
    // mid-sentence stays intent text. Any text after the verb is the compose
    // request (falls through to intentWords).
    if (i === 0 && a === "compose") {
      flags.compose = true;
      continue;
    }
    if (a === "--resume") {
      flags.resume = true;
    } else if (a === "--single") {
      flags.single = true;
    } else if (a === "--new-intent") {
      flags.newIntent = true;
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
    } else if (a === "--review") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        flags.parseError = "--review requires <adversarial|advisory|none>.";
      } else {
        flags.review = value;
        i++;
      }
    } else if (a === "--new-scope") {
      flags.newScope = true;
    } else if (a === "--report" && i + 1 < args.length) {
      // CONSUME the value: an unrecognized valued flag would leak its value
      // into the freeform intent text (the path would read as intent words).
      flags.report = args[i + 1];
      i++;
    } else if (a === "--claim" && i + 1 < args.length) {
      flags.claim = args[i + 1];
      i++;
    } else if (a === "--claim") {
      flags.parseError = "--claim requires <unit>.";
    } else if (a === "--release" && i + 1 < args.length) {
      flags.release = args[i + 1];
      i++;
    } else if (a === "--release") {
      flags.parseError = "--release requires <unit>.";
    } else if (a === "--team" && i + 1 < args.length) {
      flags.claimTeam = args[i + 1];
      i++;
    } else if (a === "--team") {
      flags.parseError = "--team requires <label>.";
    } else if (a === "--rhythm" && i + 1 < args.length) {
      flags.claimRhythm = args[i + 1];
      i++;
    } else if (a === "--rhythm") {
      flags.parseError = "--rhythm requires <per-stage|unit-end>.";
    } else {
      // Unknown flag-looking tokens are task text, not disposable noise. Use
      // the standard `--` delimiter when a task must contain a token that is
      // otherwise a recognized AIDLC flag (for example `compose -- --scope`).
      intentWords.push(a);
    }
  }
  // A leading valid scope token is positional scope syntax, even when a
  // description follows it (`/aidlc bugfix Fix duplicate todos`). Peel only
  // after parsing all flags so explicit routing modes can keep their complete
  // trailing arguments. When --scope or --new-intent already names the routing
  // explicitly, the positional text is pure description — peeling there
  // truncates an intent that happens to OPEN with a scope word
  // (`--new-intent --scope feature "feature flags for billing"`).
  if (
    intentWords.length > 0 &&
    validScopes().has(intentWords[0]) &&
    !flags.scope &&
    !flags.newIntent &&
    !flags.compose &&
    !flags.newScope &&
    !flags.report &&
    !flags.stage &&
    !flags.phase
  ) {
    flags.positionalScope = intentWords.shift();
  }
  if (intentWords.length > 0) flags.intent = intentWords.join(" ");
  if (!flags.claim && (flags.claimTeam || flags.claimRhythm)) {
    flags.parseError = "--team and --rhythm require --claim <unit>.";
  }
  if (flags.release && (flags.claimTeam || flags.claimRhythm)) {
    flags.parseError = "--release does not accept --team or --rhythm.";
  }
  return flags;
}

// Appended to the `done` reason emitted when the ACTIVE intent has no in-scope
// stage left (a completed workflow). Without this, a scope-runner's forwarding
// loop ("repeat until done") dead-ends here with no cue that new, unrelated
// work has an escape hatch. This is a HINT to the conductor, not an instruction
// to act: starting a second intent is still gated on the SKILL's
// recognise-vs-continue judgement plus the human "yes" offer (never auto-create).
// The leading space lets callers concatenate it onto their own reason text.
const NEW_WORK_HINT =
  " If this input is genuinely NEW, unrelated work (not a follow-up to the " +
  "completed intent), don't stop here: offer to start a second intent, and on " +
  "the human's yes run `next --new-intent --scope <scope> \"<text>\"` (see the " +
  "SKILL's new-work offer, never auto-create).";

// The workflow creation print for a resolved scope on a fresh workspace (no intent
// record yet). A user who described what to build — `/aidlc "build the auth
// service"`, the bare positional `next bugfix`, or `next --scope bugfix` — asked
// to START a workflow; there is nothing to run until an intent is created, and
// creation is a mutation, so `next` (read-only) NAMES the move as a
// run-then-continue print and the conductor runs it, then re-runs `next` to land
// on the first stage. The named move is the deterministic `intent-create` handler
// (mint UUIDv7, create the intent dir, append intents.json, set active-intent,
// emit WORKFLOW_STARTED/PHASE_STARTED into the new intent's audit) — the
// read-only-engine invariant is preserved: the routing tool names, a separate
// deterministic tool mutates, the human's "start a new intent?" judgement gated
// the get-here. Threads the freeform feature description (--arguments) so the
// created intent's slug + state Project field carry it, plus --depth /
// --test-strategy / --review. Shared by Branch 7b (valid-scope positional) and
// Branch 9 (explicit --scope flag) so the explicit-naming shapes emit identical
// directives. The harness dir is resolved through harnessDir() so the directive
// names the right tree on every harness (.claude/.kiro/.codex).
function createPrintDirective(
  scope: string,
  flags: ParsedFlags,
  projectDir: string,
  description?: string,
): PrintDirective {
  const cmd = [`intent-create --scope ${scope}`];
  let labelHint = "";
  if (description && description.length > 0) {
    // Shell-quote the freeform description so multi-word intents survive intact.
    cmd.push(`--arguments=${shellArg(description)}`);
    // The conductor (LLM) condenses the description into the short dir-name label
    // — the engine can't summarize. Name the missing --label in the directive so
    // the conductor adds it; the dir name becomes `<YYMMDD>-<label>`. (A bare run
    // without --label still creates a sane name by truncating --arguments.)
    cmd.push(`--label "<2-3 word kebab essence>"`);
    labelHint =
      ` Replace \`--label\` with a 2-3 word kebab essence of the description (e.g. "simple calc"), which becomes the readable folder name for this piece of work.`;
  }
  if (flags.depth) cmd.push(`--depth ${flags.depth}`);
  if (flags.testStrategy) cmd.push(`--test-strategy ${flags.testStrategy}`);
  if (flags.review) cmd.push(`--review ${flags.review}`);
  // Disclose the ceremony on the print: an explicitly named scope creates
  // directly (no confirm ask by design), so the stage/gate counts ride here.
  // Omit the parenthetical when the scope does not resolve (fixture trees).
  const clause = costClause(scope, projectDir);
  const cost = clause ? ` (${clause})` : "";
  const runCmd = `Run \`bun ${harnessDir()}/tools/aidlc-utility.ts ${cmd.join(" ")}\``;
  const directive = flags.newIntent
    ? printDirective(
      `${runCmd} to start the new intent${cost}.${labelHint} Then STOP, do NOT re-run \`next\` in this session. ` +
        `This is a NEW, unrelated intent, and the current session still carries the previous intent's context. ` +
        `Tell the user to start a fresh session using this harness's reset or restart flow, then invoke its AI-DLC entry skill to begin the new intent with a clean slate. ` +
        `Nothing is lost: the intent is saved on disk and resumes on the next \`next\`.`,
      )
    : printDirective(
      `${runCmd} to start the workflow${cost}, then re-run \`next\` to continue.${labelHint}`,
    );
  // The user named a scope (or one was inferred and confirmed), so the spoken
  // line can say what is being set up and how much process that means, with the
  // counts the compiled grid already gave us.
  directive.narration = clause
    ? `Setting up a ${scope} workflow for this: ${clause}.`
    : `Setting up a ${scope} workflow for this.`;
  return directive;
}

// The composer-dispatch print for a compose request (the adaptive-workflows
// composer). The engine stays read-only: it NAMES the dispatch move (the
// conductor Tasks the composer agent, renders the proposal, and holds the
// approve/edit/reject gate); it never dispatches or writes itself. Two modes:
//   - front (no state file): compose a scope from the prompt (or a scan
//     report) BEFORE creation. The composer proposes; on approval the conductor
//     continues into the normal intent-create with the chosen scope.
//   - in-flight (state file present): re-shape the RUNNING workflow's pending
//     stages (SKIP / un-SKIP), which lands as suffix flips via the recompose
//     verb - never a silent advance of the current stage.
// The message threads the compose inputs (task text, --new-scope, --report)
// so the conductor forwards them to the composer verbatim.
function composeDispatchDirective(
  flags: ParsedFlags,
  inFlight: boolean,
): PrintDirective {
  const hd = harnessDir();
  const parts: string[] = [];
  if (inFlight) {
    parts.push(
      `Dispatch the composer agent (${hd}/agents/aidlc-composer-agent.md) as a subagent to propose re-shaping the RUNNING workflow's pending stages` +
        (flags.intent ? ` for: "${flags.intent}".` : "."),
      "The composer reads the live state file's Stage Progress, re-estimates the entropy components from what completed stages resolved, validates the flipped grid with --strict, and proposes SKIP/un-SKIP flips for PENDING, ahead-of-cursor stages only (completed [x], in-progress [-], and skipped [S] stages are frozen; an ADD whose required producer is skipped or behind the cursor is rejected, not proposed).",
      "This is mode in-flight, not matched/custom routing: preserve the current scope, depth, frozen actions, and full effective grid; stock-distance rankings are advisory only and MUST NOT trigger stock-grid adoption. Return the exact approved command delta as changes.skip and changes.add arrays.",
      "BEFORE presenting the gate, write the pending-proposal marker `aidlc/.aidlc-compose-pending` (any content) so the turn can end at the gate; on approve run `bun " +
        hd +
        "/tools/aidlc-utility.ts recompose --skip <changes.skip> --add <changes.add>` (comma-separated) and DELETE the marker; on reject/edit-then-resolve delete the marker too. Never write scope registry files for an in-flight proposal.",
    );
  } else {
    parts.push(
      `Dispatch the composer agent (${hd}/agents/aidlc-composer-agent.md) as a subagent to propose the workflow plan for: "${flags.intent ?? ""}".`,
    );
    if (flags.intent) {
      parts.push(
        `The proposal's required \`creationDescription\` MUST equal the original task text verbatim: ${JSON.stringify(flags.intent)}. On approval, pass it after the literal \`--\` delimiter as one shell-safe argv value; for this exact task the command is \`next --scope <scopeName> -- ${shellArg(flags.intent)}\`. Never use double quotes around untrusted task text and never use a bare \`next --scope <scopeName>\`, so shell metacharacters and flag-like descriptions stay literal and the created Project field preserves the real description.`,
      );
    } else {
      parts.push(
        "The proposal MUST include a nonblank `creationDescription` grounded in the approved work. For report-driven composition, derive it from the report's actual findings; for a task-less front composition, derive it from the approved proposal. Never approve a proposal that would continue into a scope-only creation.",
      );
    }
    if (flags.report) {
      parts.push(
        `First have it read and triage the scan report at "${flags.report}" (auto-fixable vs human-decision findings), then compose a compact fix-and-ship grid - this often routes to the stock bugfix or security-patch scope rather than minting a new one.`,
      );
    }
    if (flags.newScope) {
      parts.push(
        "--new-scope was passed: the composer must SYNTHESIZE a custom scope even if a stock scope matches.",
      );
    }
  }
  const proposalShape = inFlight
    ? "mode in-flight, the current scopeName, an ars block (the five component scores with method codekb|fallback), an arsRationale, the preserved full effective grid, exact changes.skip and changes.add arrays, a per-change rationale, a summary the strict validator computed, and two pre-rendered markdown tables (ARS scores with bands; per-stage decisions with reasoning)"
    : "mode matched|custom, scopeName, a nonblank creationDescription, an ars block (the five component scores with method codekb|fallback), an arsRationale, the per-stage EXECUTE/SKIP grid, a per-SKIP rationale, a summary the validator computed, and two pre-rendered markdown tables (ARS scores with bands; per-stage decisions with reasoning)";
  const modeContract = inFlight
    ? "the composer's mode is IN-FLIGHT and FINAL for the returned delta: nearest_stock is advisory, the running scope and frozen actions stay unchanged, and approval uses only changes.skip/changes.add through recompose; neither presentation nor comparison with stock grids may alter that delta"
    : "the composer's mode is FINAL for the grid it returned: it routed matched-vs-custom solely on the final proposal validator's nearest_stock distance, a matched proposal already carries the revalidated stock grid verbatim, and neither presentation nor your own comparison of grids ever changes the verdict - never re-derive it, and a MATCHED proposal writes no scope file; if the human edits that stock grid, re-dispatch the composer, which must convert it to CUSTOM and revalidate before re-presenting";
  parts.push(
    `The composer runs \`bun ${hd}/tools/aidlc-utility.ts detect --json\` (read-only scan + scope-registry paths), estimates the five entropy components (intent ambiguity, structural uncertainty, verification entropy, risk, unresolved assumptions) per its persona, and returns a structured proposal: ${proposalShape}.`,
    `Render the proposal to the human as THREE blocks before the approve/edit/reject gate (see the composer block in SKILL.md), leading with plain language rather than the scores: (1) a two-or-three-sentence recommendation in your own words - what kind of change this looks like, how much process you suggest, and the steps in plain terms - followed by the validator's summary line formatted "<execute> stages EXECUTE / <skip> SKIP, <gates> approval gates" plus scopeName and mode (${modeContract}); (2) the composer's stage-decision table verbatim, with any fold advisories beneath it; (3) under a "Scoring detail (advisory)" heading, the composer's ARS score table verbatim with its method line and arsRationale. Relay the composer's tables and numbers as returned - never recompute, collapse into prose, or drop them. Do NOT write any file and do NOT advance any stage before an explicit approval.`,
  );
  const directive = printDirective(parts.join(" "));
  // This is the moment issue 682's reporter described: the user has asked for a
  // plan and the framework goes quiet while it works one out. Say what is
  // happening in their terms. In-flight means a plan is already running and only
  // the not-yet-run steps are on the table.
  directive.narration = inFlight
    ? "Looking at what is left to do and working out which of the remaining steps still earn their place. I will show you the change before anything moves."
    : "Working out which steps of the development process this piece of work actually needs, based on what you have asked for and what is already in the codebase. I will show you the plan before anything runs.";
  return directive;
}

// Guard the creation gate against a DUPLICATE intent on a fresh clone of a
// multi-intent workspace. A no-state creation arm (Branch 7b / 9a) fires purely on
// `!stateContent`, but stateContent is empty in TWO different worlds: a truly
// empty workspace (zero intents → creation is correct), AND a workspace that
// already holds intents whose active-intent CURSOR is unset. The cursor
// (`aidlc/spaces/<sp>/intents/active-intent`) is gitignored per-user state, so a
// fresh clone of a >1-intent workspace lands with records on disk but no cursor
// → activeIntent() returns null (lib:357-361) → stateContent is empty → the
// creation gate would mint a SECOND intent over the top of the existing ones
// (violates the P4 hazard "auto-create fires only on ZERO intents").
//
// This consults the deterministic query layer (listIntents over the active
// space) and, when intents EXIST but none is flagged active, NAMES the
// disambiguation move as an `ask` directive that lists the existing intents and
// asks the human to pick one via `/aidlc intent <name>` - instead of creating.
// Returns null when creation should proceed unchanged (zero intents in the space,
// or one already resolved active — the latter only when this is reached with an
// explicit scope/intent that didn't load a cursor'd state). The engine stays
// read-only: it emits a directive, it does not touch the cursor.
function intentPickPromptIfRecordsExist(
  projectDir: string,
  pendingWork?: { description: string; proposedScope: string },
): AskDirective | null {
  const selection = engineSelection(projectDir);
  const space = selection.space;
  const intents = listIntents(projectDir, space, selection.intent);
  if (intents.length === 0) return null; // zero intents → creation is correct
  if (intents.some((i) => i.active)) return null; // a cursor already resolves → not a creation path
  // Records exist but no cursor is set (the fresh-clone / >1-no-cursor case).
  // Carry exact record-dir selectors accepted by `intent <name>`. Slugs remain
  // display labels because duplicate labels are legal and ambiguous to switch.
  const intentStates = intents.map((intent) => {
    let state = "";
    if (intent.dirName) {
      try {
        state = readFileSync(
          stateFilePath(projectDir, intent.dirName, space),
          "utf-8",
        );
      } catch {
        // Registry-only or incomplete record: leave unannotated.
      }
    }
    return { intent, state };
  });
  const annotate = intents.length > 1 &&
    intentStates.some(({ state }) => isTeamUnitOwnership(state));
  const selectable = intentStates.flatMap(({ intent, state }) =>
    intent.dirName
      ? [{ intent, state, selector: intent.dirName }]
      : []
  );
  const selectors = selectable.map(({ selector }) => selector);
  const displayRows = selectable.length > 0
    ? selectable
    : intentStates.map(({ intent, state }) => ({
        intent,
        state,
        selector: undefined as string | undefined,
      }));
  const list = displayRows.map(({ intent, state, selector }) => {
    let annotation = "";
    if (annotate) {
      const completed =
        intent.status.toLowerCase() === "complete" ||
        getField(state, "Status") === "Completed";
      const parked = (getField(state, "Parked") ?? "").trim();
      const parkedAt = (getField(state, "Parked At Stage") ?? "").trim();
      const currentStage = (getField(state, "Current Stage") ?? "").trim();
      if (completed) {
        annotation = "complete";
      } else if (parked && parkedAt && parkedAt === currentStage) {
        annotation = `parked at ${parkedAt}`;
      } else if (
        intent.dirName &&
        intent.uuid &&
        isTeamUnitOwnership(state)
      ) {
        try {
          const dependencyBody = readFileSync(
            unitDependencyPath(projectDir, intent.dirName, space),
            "utf-8",
          );
          const overview = localUnitClaimOverviewForIntent(projectDir, {
            space,
            intentUuid: intent.uuid,
            stateContent: state,
            dependencyBody,
          });
          annotation =
            `team construction, ${overview.claimable.length} units claimable`;
        } catch {
          annotation = "team construction, claim status unavailable";
        }
      }
    }
    const identity = selector
      ? intent.slug === selector
        ? `\`${selector}\``
        : `\`${intent.slug}\` (record: \`${selector}\`)`
      : `\`${intent.slug}\``;
    return `${identity}${annotation ? ` (${annotation})` : ""}`;
  }).join(", ");
  const spaceLabel = space === "default" ? "" : ` in space "${space}"`;
  // Only Kiro consumes the typed prose contract. Other harnesses retain their
  // established picker and scope-confirm behavior.
  if (
    isKiroRoutingHarness() &&
    pendingWork?.description.trim() &&
    selectors.length > 0
  ) {
    return newWorkRoutingAskDirective(
      `This project already has ${intents.length} piece${intents.length === 1 ? "" : "s"} of work in progress${spaceLabel}, ` +
        `and none is currently selected: ${list}. You said: "${pendingWork.description}". ` +
        `Is this (1) part of existing work - select its record and continue it; ` +
        `(2) a separate new piece of work - Yes, set it up alongside the existing work as ` +
        `"${pendingWork.proposedScope}" work without changing it; or (3) a change to an ` +
        "existing remaining plan - select its record, then reshape it?",
      `**New work routing** — This project already has ${intents.length} piece${intents.length === 1 ? "" : "s"} of work in progress${spaceLabel}, ` +
        `and none is currently selected: ${list}. You said: "${pendingWork.description}". What should I do?\n\n` +
        `1. **Part of existing work** — Select one of ${list} and continue it\n` +
        `2. **Separate new piece of work** — Yes, set it up alongside the existing work as "${pendingWork.proposedScope}" work without changing it\n` +
        `3. **Reshape existing work** — Select one of ${list}, then reshape its remaining plan\n` +
        "4. **Other** — describe what you want instead\n\n" +
        "Reply with a number (or just tell me).",
      pendingWork.description,
      pendingWork.proposedScope,
      selectors,
    );
  }
  return askDirective(
    `This project already has ${intents.length} piece${intents.length === 1 ? "" : "s"} of work in progress${spaceLabel}, and none is currently selected ` +
      `(which one you are on is tracked per-person and does not travel with the repo). ` +
      `Pick the one to work on with \`/aidlc intent <name>\`: ${list}. ` +
      "That selects it; re-run `next` afterward to carry on where it left off.",
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
// active workflow is authoritative), then an explicit --scope flag, then a
// leading positional scope, then the AWS_AIDLC_DEFAULT_SCOPE env var, then the
// default. Returns the resolved scope plus whether it was found in the valid
// set (an unknown scope is the caller's to turn into an error directive).
function resolveScope(
  stateContent: string | null,
  flags: ParsedFlags,
): { scope: string; source: "state" | "flag" | "positional" | "env" | "default"; error?: string } {
  const stateScope = stateContent ? getField(stateContent, "Scope") : null;
  if (stateScope && stateScope.length > 0) {
    return { scope: stateScope, source: "state" };
  }
  if (flags.scope && flags.scope.length > 0) {
    return { scope: flags.scope, source: "flag" };
  }
  if (flags.positionalScope && flags.positionalScope.length > 0) {
    return { scope: flags.positionalScope, source: "positional" };
  }
  const envScope = (process.env.AWS_AIDLC_DEFAULT_SCOPE || "").trim();
  if (envScope.length > 0) {
    if (validScopes().has(envScope)) return { scope: envScope, source: "env" };
    // Only installed-but-disabled scopes participate in selection-aware
    // fallback. The resolve-env-scope validator below owns the canonical error
    // for an explicit unknown value.
    if (loadScopeMetadataAll()[envScope] === undefined) {
      return { scope: envScope, source: "env" };
    }
    const fallback = selectionAwareDefaultScope(envScope);
    if (!fallback.error && fallback.note) {
      process.stderr.write(
        `AWS_AIDLC_DEFAULT_SCOPE="${envScope}" is not an enabled scope; using ${fallback.scope} (sole enabled plugin's first scope)\n`,
      );
    }
    return { scope: fallback.scope, source: "env", error: fallback.error };
  }
  const fallback = selectionAwareDefaultScope(DEFAULT_SCOPE);
  return { scope: fallback.scope, source: "default", error: fallback.error };
}

// Derive the memory diary path for a stage (SKILL.md: every stage keeps a
// <record>/<phase>/<stage>/memory.md diary). `recordPrefix` is the RELATIVE
// per-intent record dir (aidlc/spaces/<space>/intents/<slug>-<id8>) the engine
// threads in from the active intent (relativeRecordDir), or null → the bare space
// record prefix (relativeSpaceRecordPrefix - a pre-creation shell with no intent
// yet). These are agent-consumed RELATIVE paths the conductor resolves against
// the workspace root; the engine only joins them to projectDir for deterministic
// diary bootstrap. Re-rooting remains a pure prefix swap, not a route through
// the absolute projectDir-keyed state helpers.
// Per-unit Construction stages embed a {unit-name} segment that a later engine
// change resolves; until then the bare phase/slug form is the faithful derivation.
function memoryPathFor(phase: string, slug: string, recordPrefix: string | null): string {
  const prefix = recordPrefix ?? relativeSpaceRecordPrefix();
  return `${prefix}/${phase}/${slug}/memory.md`;
}

function unitMemoryPathFor(
  slug: string,
  unit: string,
  recordPrefix: string | null,
): string {
  const prefix = recordPrefix ?? relativeSpaceRecordPrefix();
  return `${prefix}/construction/${unit}/${slug}/memory.md`;
}

// Create the stage diary at the deterministic directive-emission boundary so
// the conductor never has to probe a maybe-absent path. This is advisory: a
// missing install template, unresolved placeholder, or filesystem failure must
// not prevent the run-stage directive from being emitted.
export function bootstrapDirectiveMemory(
  memoryPath: string,
  codekbCtx?: { projectDir: string },
): void {
  try {
    if (
      !codekbCtx ||
      memoryPath.includes("{") ||
      process.env[STOP_HOOK_PROBE_ENV] === "1"
    ) {
      return;
    }
    const template = join(
      codekbCtx.projectDir,
      harnessDir(),
      "knowledge",
      "aidlc-shared",
      "memory-template.md",
    );
    if (!existsSync(template)) return;

    const target = join(codekbCtx.projectDir, memoryPath);
    if (existsSync(target)) return;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(template, target, fsConstants.COPYFILE_EXCL);
  } catch {
    // Diary bootstrap is best-effort; directive routing remains authoritative.
  }
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
// Read the conductor persona, or null if it is absent (a fork that deleted it,
// or a partial install). The delivery is best-effort: a missing persona is not a
// routing error — the run-stage directive is still well-formed without the
// optional field — so we never fail the workflow over it.
function readConductorPersona(): string | null {
  const conductorPersonaPath = resolveHarnessPath(["aidlc-common", "conductor.md"]);
  if (!existsSync(conductorPersonaPath)) return null;
  try {
    return readFileSync(conductorPersonaPath, "utf-8");
  } catch {
    return null;
  }
}

// --- Deterministic rule delivery --------------------------------------------
//
// Rule paths are compile-time routing metadata; the text is required steering.
// Before a run-stage is emitted, the engine reads the active-space files and
// sends their content through one or more bounded load-steering directives.
// The conductor immediately follows each opaque continuation token. No rule is
// downgraded to a discretionary path read because it did not fit one tool
// result. Every serialized directive stays below the common 28 KiB harness
// floor; a fresh `next` deterministically restarts at part one.
const DIRECTIVE_MAX_BYTES = 28 * 1024;
const STEERING_TEXT_TARGET_BYTES = 20 * 1024;
const CONTEXT_WARNINGS_MAX_BYTES = 6 * 1024;
const INLINE_CONTEXT_PATHS_MAX_BYTES = 8 * 1024;

type RunStageRoute = {
  node: GraphStage;
  scope: string;
  stateAware: boolean;
  stateHash: string | null;
  codekbCtx: CodekbCtx;
  unit: string | null;
  unitKind: string | null;
  forcePersona: boolean;
};

type SteeringTokenPayload = {
  v: 1;
  s: string;
  c: string;
  i: number;
  b: string;
  d: string;
  r: string;
  a: boolean;
  u: string | null;
  k: string | null;
  f: boolean;
  g: GateValue;
  n: string | null | undefined;
  x: boolean;
  p: boolean;
  w: boolean;
  z?: boolean;
  q?: UnitGateRhythm;
  h: string | null;
};

const runStageRoutes = new WeakMap<RunStageDirective, RunStageRoute>();
const publicationContexts = new WeakMap<
  Directive,
  { projectDir: string; stateHash: string }
>();
let requestedSteeringContinuation: SteeringTokenPayload | null = null;

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

// The state field recording how construction DESIGN stages iterate over units.
// Runtime metadata set by the delivery-planning classify round-trip (or a human)
// via `aidlc-state.ts set-construction-iteration`. ONLY the exact value
// "unit-major" activates the unit-outer / stage-inner walk; unset / absent /
// "stage-major" / any other value all read as stage-major (today's behaviour, the
// safe default). Deliberately strict, mirroring readAutonomyMode: an empty or
// unrecognised value never activates the new order.
const CONSTRUCTION_ITERATION_FIELD = "Construction Iteration";

// Read the recorded Construction iteration mode, or null when it is not exactly
// "unit-major". Any other value (including "stage-major") is stage-major.
function readConstructionIteration(
  stateContent: string | null,
): "unit-major" | null {
  const raw = stateContent
    ? getField(stateContent, CONSTRUCTION_ITERATION_FIELD)
    : null;
  if (!raw) return null;
  return raw.trim() === "unit-major" ? "unit-major" : null;
}

function readUnitOwnership(stateContent: string | null): "team" | null {
  return isTeamUnitOwnership(stateContent) ? "team" : null;
}

// The set of Units of Work the swarm referee has recorded as CONVERGED for the
// active intent, read from the audit ledger. This is the swarm's completion
// signal, NOT on-disk artifact presence. A swarm unit builds inside an isolated
// Bolt worktree and `aidlc-bolt complete --merge` consolidates only the AIDLC
// metadata (state + audit + runtime-graph fragment) back to the main checkout;
// the unit's produced artifacts (code-generation-plan.md,
// unit-test-instructions.md, code-summary.md, and the generated source) are NOT
// copied into the main record tree by the swarm
// finalize flow. So unitCovered's disk check (the INLINE per-unit ledger) never
// sees a swarm unit as covered, and the batch-advance signal must instead be the
// `SWARM_UNIT_CONVERGED` audit rows `aidlc-swarm.ts finalize` writes from the
// main checkout, one per genuinely-converged unit, each carrying `Unit name`.
// Composes the same shard-concat + block-parse the other audit readers use; an
// absent/empty audit yields the empty set (no batch has converged yet).
//
// The read lives in aidlc-lib.ts (swarmConvergedUnits), shared with the
// state-tool consumer and the emitter: a row counts only when its Stage names
// this slug AND its Run floor equals the stage's exact current-attempt token,
// so a prior attempt's late finalize retry or another swarm stage's rows can
// never satisfy the current run. The
// audit is append-only and per-intent, and the stage CAN legitimately re-run
// within the same intent with the same unit names: a backward/redo jump
// resets completed stages to pending without touching the ledger (and without
// clearing the autonomy grant), and a re-init appends a second
// WORKFLOW_STARTED to the same shards. Without the attempt scoping, the prior
// run's converged rows would make the fresh run's batches look already built
// and the rebuild would be silently skipped.

// The resolved unit batch DAG for the active intent, cache-validated with a
// self-heal: when units-generation's dependency artifact exists, it is the
// authority and a compiled bolt_dag is accepted only while its batches and
// unit kinds still match. A graph that is missing, malformed, lacks the node,
// or disagrees with the artifact is a STALE CACHE, not a zero-unit workflow.
// In that case the batches are recomputed directly from
// unit-of-work-dependency.md via the same pure parse the runtime compiler uses,
// so the per-unit loop, the approve-side coverage guard, and the swarm fan-out
// never truncate a multi-unit plan because a hook failed to refresh the graph.
// Three states:
//   ok        - batches resolved (healed=true when recomputed; a heal writes
//               one stderr note, since the compile hook should have run).
//   none      - no dependency artifact: a genuine zero-unit scope; callers
//               keep the single-iteration degrade byte-identical.
//   malformed - the artifact exists but its fenced units block does not
//               parse; the unit list is unknowable, callers surface an error
//               instead of silently building one unit.
// Pure in-memory: never writes the graph (next stays read-only); the
// rebuild-stage-graph hook repairs the cache on the next transition.
type BoltBatchesResolution = BoltDagResolution;

function resolveBoltBatches(projectDir: string): BoltBatchesResolution {
  const resolution = resolveBoltDag(projectDir);
  if (resolution.state === "ok" && resolution.healed) {
    process.stderr.write(
      `aidlc-orchestrate: runtime-graph.json bolt_dag is missing or stale; recomputed ${resolution.batches.length} unit batch(es) from unit-of-work-dependency.md (check the rebuild-stage-graph hook)\n`,
    );
  }
  return resolution;
}

// True when `node` is the SKELETON-GATE stage for `scope` — the FIRST
// Construction EXECUTE stage in scope (the start of Bolt 1). This is derived,
// not hardcoded: firstInScopeStageOfPhase("construction", scope) walks the
// scope's EXECUTE-only sub-DAG and returns its first construction stage (e.g.
// functional-design for feature/enterprise/mvp/refactor/classic, code-generation
// for poc/bugfix/security-patch, nfr-requirements for infra). A scope-mapping
// edit that moves the first construction stage moves the skeleton gate with it,
// no code change. Non-construction stages are never the skeleton gate.
function isSkeletonGateStage(node: GraphStage, scope: string): boolean {
  if (node.phase !== "construction") return false;
  const first = firstInScopeStageOfPhase("construction", scope);
  return first !== null && first.slug === node.slug;
}

function scopeDefaultSkeletonStance(scope: string): SkeletonStance {
  try {
    return loadScopeMetadata()[scope]?.skeleton === true ? "on" : "off";
  } catch {
    return "off";
  }
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
      // Fall back to the active scope's metadata to SELECT the ceremony.
      // Missing metadata is skeleton-off; composed/runtime-approved scopes
      // reshape an existing plan and must opt in explicitly to conjure a
      // walking-skeleton Bolt.
      const _ceremony = scopeDefaultSkeletonStance(scope);
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

// The literal token used in the per-unit path shape when no concrete Unit of
// Work is supplied at emit time. The unit value comes from active Bolt context
// (a later engine increment threads it in); when absent, the faithful emission
// is the documented `{unit-name}` placeholder shape, matching
// 16-artifact-vocabulary.md:159.
const UNIT_NAME_PLACEHOLDER = "{unit-name}";

// True when the node runs once per Unit of Work. The marker + known-set rule
// lives in aidlc-lib.ts (isPerUnitStage) so the runtime resolver and the cost
// summary (gridCostSummary) agree on the per-unit set.
function isPerUnit(node: GraphStage): boolean {
  return isPerUnitStage(node);
}

// The KNOWN SET of stages whose artifacts live in the durable, space-level
// code knowledge base (`aidlc/spaces/<space>/codekb/<repo>/`) rather than under
// a per-intent record dir. Keyed on the slug ALONE — deliberately NOT a stage
// frontmatter marker: aidlc-stage-schema.ts OPTIONAL_FIELDS omits `codekb`, so a
// `codekb: true` field would trip the schema's unknown-key rule and fail the
// stage compile. reverse-engineering is the sole member today (it builds the
// brownfield code understanding the whole space reuses); a future codekb stage
// joins by adding its slug here, no schema change.
// True when the node's artifacts belong in the space-level codekb (see set
// above). Pure predicate over the slug — the per-repo/per-space placement is
// resolved by the CodekbCtx threaded into resolveArtifactPath.
function isCodekb(node: GraphStage): boolean {
  return KNOWN_CODEKB_STAGES.has(node.slug);
}

// The small, fs-free payload that lets resolveArtifactPath build a codekb path
// without reading the disk itself (the resolver stays PURE — the conductor's
// chokepoint computes these once where projectDir is live, exactly as
// recordPrefix is). `codekbRepo` is the deterministic repo NAME from
// codekbRepoName(projectDir); `space` is the active-space cursor. When absent
// (a non-codekb caller, e.g. a test invoking buildRunStageDirective with
// defaults) the codekb branch never fires and the record-dir path stands.
type CodekbCtx = {
  projectDir: string;
  space: string;
  codekbRepo: string;
  repos: string[];
};

// Build the CodekbCtx for a live projectDir, resolving the active-space cursor
// and the deterministic codekb repo name (both read-only). One place so the
// `next` happy path, the jump paths, and the report-side per-unit coverage guard
// share the same construction instead of repeating the object literal.
function codekbCtxFor(pd: string): CodekbCtx {
  const selection = engineSelection(pd);
  return {
    projectDir: pd,
    space: selection.space,
    codekbRepo: codekbRepoName(
      pd,
      selection.space,
      selection.intent ?? undefined,
    ),
    repos: intentRepos(
      pd,
      selection.intent ?? undefined,
      selection.space,
    ),
  };
}

function codekbArtifactRepos(ctx: CodekbCtx): string[] {
  return ctx.repos.length > 1 ? ctx.repos : [ctx.codekbRepo];
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
// artifact has exactly one producing stage (enforced by graph compile) and
// lives in that producer's directory, NOT the consuming stage's. The per-unit
// decision is likewise the OWNER's — a consume of a per-unit-produced artifact
// resolves under construction/{unit}/<producer>/, a consume of a non-per-unit
// artifact under <producer-phase>/<producer-slug>/ with no construction prefix.
function resolveArtifactPath(
  name: string,
  owner: GraphStage,
  unit: string | null,
  recordPrefix: string | null,
  codekbCtx?: CodekbCtx,
): string {
  const filename = artifactFilename(name);
  // Codekb artifacts live in the space-level codekb dir, keyed by repo — NOT
  // under the per-intent record dir. This arm fires for BOTH produces[] (owner
  // is the directive's own node) AND consumes[] (owner is the producing stage
  // resolved via producersOf — so a consume of an RE artifact also lands here).
  // It drops the intents/<slug> tail and keeps only the aidlc/spaces/<space>/
  // stem, mirroring relativeCodekbDir. Guarded on the ctx being present so a
  // ctx-less caller (defaults) falls through to the record-dir arms below.
  if (isCodekb(owner) && codekbCtx) {
    return `${relativeCodekbDir(codekbCtx.projectDir, codekbCtx.codekbRepo, codekbCtx.space)}/${filename}`;
  }
  const prefix = recordPrefix ?? relativeSpaceRecordPrefix();
  if (isPerUnit(owner) && unit !== null) {
    return `${prefix}/construction/${unit}/${owner.slug}/${filename}`;
  }
  return `${prefix}/${owner.phase}/${owner.slug}/${filename}`;
}

function resolveArtifactPaths(
  name: string,
  owner: GraphStage,
  unit: string | null,
  recordPrefix: string | null,
  codekbCtx?: CodekbCtx,
): string[] {
  if (isCodekb(owner) && codekbCtx && codekbCtx.repos.length > 1) {
    const filename = artifactFilename(name);
    return codekbArtifactRepos(codekbCtx).map(
      (repo) =>
        `${relativeCodekbDir(codekbCtx.projectDir, repo, codekbCtx.space)}/${filename}`,
    );
  }
  return [resolveArtifactPath(name, owner, unit, recordPrefix, codekbCtx)];
}

// Resolve a consumed artifact under its producer. Compile enforces exactly one
// producer for every consumed name; unconsumed shared names never reach here.
// Multi-repo codekb producers expand to one path per registered repo; an orphan
// consume defensively falls back to the consuming node so the directive remains
// well formed.
function resolveConsumePaths(
  name: string,
  node: GraphStage,
  unit: string | null,
  recordPrefix: string | null,
  codekbCtx?: CodekbCtx,
): string[] {
  const producer = producersOf(name)[0];
  return resolveArtifactPaths(
    name,
    producer ?? node,
    unit,
    recordPrefix,
    codekbCtx,
  );
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
// A resolved consume: the artifact NAME and required flag carried alongside
// the resolved path, so the presence split downstream can key producer lookups
// and required-ness off the authored vocabulary instead of re-deriving the
// name from the path shape.
type ResolvedConsume = { artifact: string; required: boolean; path: string };

function resolveConsumes(
  consumes: Consume[],
  node: GraphStage,
  projectType: "brownfield" | "greenfield" | null,
  unit: string | null,
  recordPrefix: string | null,
  codekbCtx?: CodekbCtx,
  unitKind: string | null = null,
): ResolvedConsume[] {
  const resolved: ResolvedConsume[] = [];
  for (const consume of consumes) {
    if (
      consume.conditional_on &&
      projectType &&
      consume.conditional_on !== projectType
    ) {
      continue;
    }
    const producer = producersOf(consume.artifact)[0];
    if (
      producer &&
      isPerUnit(producer) &&
      filterProducesByKind(
        producer.produces_kinds,
        [consume.artifact],
        unitKind,
      ).length === 0
    ) {
      continue;
    }
    for (const path of resolveConsumePaths(
      consume.artifact,
      node,
      unit,
      recordPrefix,
      codekbCtx,
    )) {
      resolved.push({
        artifact: consume.artifact,
        required: consume.required,
        path,
      });
    }
  }
  return resolved;
}

// Split resolved consumes into PRESENT (file exists on disk) and ABSENT
// (it does not), so the directive never points the conductor at a path that
// cannot be read. Only REQUIRED absent consumes are reported: an optional
// (`required: false`) input that does not exist simply is not an input — it
// is dropped from the directive entirely, never flagged as a gap. Each
// required absent entry is annotated: `expected: true` when no producer of
// the artifact is on the active scope's path, or every on-path producer has
// audit provenance for a conditional runtime skip. In both cases the producer
// did not run, so the stage's documented fallback owns the absence.
// `expected: false` means an on-path producer was not conditionally skipped
// but its output is still missing, which is a real gap the recovery protocol
// owns. A bare [S] is insufficient because forward jumps also mark stages [S].
//
// Existence resolves like unitCovered: the resolved paths are
// workspace-RELATIVE with forward slashes, re-rooted absolutely under
// codekbCtx.projectDir (splitting on "/" so the join is OS-correct). Two
// deliberate skips keep the split total:
//   - no codekbCtx (the ctx-less test/default path) → no absolute base to
//     check against; everything stays in `consumes`, exactly as before.
//   - a path still carrying the {unit-name} placeholder → existence is
//     unknowable pre-Bolt; it stays in `consumes`.
function conditionalRuntimeSkipStages(projectDir: string): Set<string> {
  const mainRows = readAuditShardEvents(projectDir).filter(
    (row) =>
      !auditBlockField(row.block, "Workflow")?.startsWith("single-stage:"),
  );
  const workflowFloor = mainRows
    .filter((row) => row.event === "WORKFLOW_STARTED")
    .reduce(
      (latest, row) => row.timestamp > latest ? row.timestamp : latest,
      "",
    );
  const latestByStage = new Map<
    string,
    Map<string, (typeof mainRows)[number]>
  >();

  for (const row of mainRows) {
    if (workflowFloor && row.timestamp < workflowFloor) continue;
    if (row.event !== "STAGE_STARTED" && row.event !== "STAGE_SKIPPED") {
      continue;
    }
    const stage = auditBlockField(row.block, "Stage");
    if (!stage) continue;
    const current = latestByStage.get(stage);
    const currentTimestamp = current?.values().next().value?.timestamp ?? "";
    if (!current || row.timestamp > currentTimestamp) {
      latestByStage.set(stage, new Map([[row.shard, row]]));
      continue;
    }
    if (row.timestamp < currentTimestamp) continue;
    const sameShard = current.get(row.shard);
    if (!sameShard || row.pos > sameShard.pos) current.set(row.shard, row);
  }

  const conditional = new Set<string>();
  for (const [stage, latestRows] of latestByStage) {
    const rows = [...latestRows.values()];
    if (
      rows.length > 0 &&
      rows.every((row) => {
        if (row.event !== "STAGE_SKIPPED") return false;
        const kind = auditBlockField(row.block, "Skip Kind");
        if (kind !== null) return kind === "conditional-runtime";
        const reason = auditBlockField(row.block, "Reason");
        return reason !== null && !reason.startsWith("Skipped by jump to ");
      })
    ) {
      conditional.add(stage);
    }
  }
  return conditional;
}

function splitConsumesByPresence(
  consumes: ResolvedConsume[],
  scope: string,
  codekbCtx?: CodekbCtx,
  stateContent?: string | null,
): { present: string[]; absent: Array<{ path: string; expected: boolean }> } {
  if (!codekbCtx) return { present: consumes.map((c) => c.path), absent: [] };
  const onPath = new Set(subgraphForScope(scope).map((s) => s.slug));
  const conditionallySkipped = conditionalRuntimeSkipStages(
    codekbCtx.projectDir,
  );
  const present: string[] = [];
  const absent: Array<{ path: string; expected: boolean }> = [];
  for (const c of consumes) {
    if (c.path.includes(UNIT_NAME_PLACEHOLDER)) {
      present.push(c.path);
      continue;
    }
    const abs = join(codekbCtx.projectDir, ...c.path.split("/"));
    if (existsSync(abs)) {
      present.push(c.path);
      continue;
    }
    if (!c.required) continue; // optional + missing → not an input, not a gap
    const onPathProducers = producersOf(c.artifact).filter((p) =>
      onPath.has(p.slug)
    );
    const allOnPathProducersSkipped = onPathProducers.length > 0 &&
      stateContent != null &&
      onPathProducers.every((p) =>
        checkboxForSlug(stateContent, p.slug)?.state === "skipped" &&
        conditionallySkipped.has(p.slug)
      );
    absent.push({
      path: c.path,
      expected: onPathProducers.length === 0 || allOnPathProducersSkipped,
    });
  }
  return { present, absent };
}

// Resolve a node's produces[] + optional_produces[] (always bare names, even for
// per-unit stages) to canonical paths. produces has no conditional_on axis, so
// every name resolves; optional_produces entries resolve too (the conductor
// still needs the path when the unit DOES write the conditional artifact) but
// are exempt from the per-unit coverage check in unitCovered.
// `unitKind` prunes the COMBINED list to the artifacts that apply to that unit
// kind (via the stage's produces_kinds map, which may point at either list);
// null (an untagged unit, or a non-per-unit stage) keeps the full list: zero
// behaviour change off the kind path.
function resolveProduces(
  node: GraphStage,
  unit: string | null,
  recordPrefix: string | null,
  codekbCtx?: CodekbCtx,
  unitKind: string | null = null,
): string[] {
  return applicableProduceNames(node, unitKind, true)
    .flatMap((name) =>
      resolveArtifactPaths(name, node, unit, recordPrefix, codekbCtx)
    );
}

// The one applicability rule for a stage's kind-aware produce set. Callers
// choose whether optional produces belong in their operation: directives name
// them, while coverage and ensemble execution evidence use required produces
// only. Keeping the filter here prevents the three paths from drifting on how
// untagged units and unannotated artifacts behave.
function applicableProduceNames(
  node: GraphStage,
  unitKind: string | null,
  includeOptional: boolean,
): string[] {
  const names = includeOptional
    ? [...(node.produces ?? []), ...(node.optional_produces ?? [])]
    : (node.produces ?? []);
  return filterProducesByKind(node.produces_kinds, names, unitKind);
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
//
// gridCostSummary() in aidlc-lib.ts counts a scope's approval gates as the
// closed form of this rule (EXECUTE stages whose phase is not initialization);
// if a per-stage gate flag ever lands here, update that counter too so the
// preview matches what the engine gates.
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

// Walk a knowledge directory into path-roster entries. Knowledge remains
// path-loaded until the future retrieval layer lands. We do a cheap read
// preflight so an unreadable file produces an actionable warning instead of a
// path the conductor cannot use.
function assertReadableUtf8(path: string): void {
  const bytes = readFileSync(path);
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function markdownFilesUnder(
  absDir: string,
  relativeDir: string,
  warnings: string[],
): Array<{ abs: string; rel: string }> {
  if (!existsSync(absDir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch (e) {
    warnings.push(
      `Warning: optional persona/knowledge directory "${toPosix(relativeDir)}" is unreadable (${errorMessage(e)}). ` +
        "Fix the directory or its permissions; this stage will continue without that context.",
    );
    return [];
  }
  const files: Array<{ abs: string; rel: string }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absPath = join(absDir, entry.name);
    const relativePath = toPosix(join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      files.push(...markdownFilesUnder(absPath, relativePath, warnings));
    } else if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      entry.name.endsWith(".md")
    ) {
      try {
        assertReadableUtf8(absPath);
      } catch (e) {
        warnings.push(
          `Warning: optional persona/knowledge file "${relativePath}" is unreadable or invalid UTF-8 (${errorMessage(e)}). ` +
            "Fix the file, encoding, or permissions; this stage will continue without that context.",
        );
        continue;
      }
      files.push({ abs: absPath, rel: relativePath });
    }
  }
  return files;
}

// The agents whose persona + knowledge the CONDUCTOR itself must hold for a
// stage: lead + supports on inline stages, lead only on a mob (supports are
// dispatched), none on fully-dispatched subagent/pipeline topologies. Shared
// by the roster builder and the deliver-once derivation so both agree on
// "who is inline here".
function inlineAgentsFor(node: GraphStage): string[] {
  const inlineAgents = node.mode === "inline"
    ? [node.lead_agent, ...(node.support_agents ?? [])]
    : node.mode === "mob"
      ? [node.lead_agent]
      : [];
  return [...new Set(inlineAgents)].filter((agent) => agent !== "orchestrator");
}

// Conductor-owned context is a concrete file roster, not an instruction inferred
// from lead/support names. Inline stages load lead + supports; mob stages keep the
// lead inline but dispatch every support, so only the lead belongs in this roster.
// Fully-dispatched subagent/pipeline stages carry no inline context.
//
// Returns {abs, rel, agent} entries: `rel` is the display path the directive
// names, `abs` where the file lives, `agent` the roster member the file
// belongs to (null for the aidlc-shared tree, which belongs to every agent) -
// the deliver-once derivation filters on it. inlineContextPaths below is the
// path-only projection the directive's roster field carries.
type InlineContextEntry = { abs: string; rel: string; agent: string | null };
type PluginKnowledgeOwners = ReadonlyMap<string, ReadonlySet<string>>;

// Minimal scopes still load every active-space rule, persona, stage file,
// consume, and user/team knowledge file. The only pruning here is shipped
// framework knowledge whose subject belongs to another stage. Standard and
// Comprehensive depth keep the full historical roster.
const MINIMAL_INLINE_KNOWLEDGE: Readonly<
  Record<string, Readonly<Record<string, ReadonlySet<string>>>>
> = {
  "intent-capture": {
    "aidlc-shared": new Set([
      "ai-dlc-principles.md",
      "rules-reading.md",
      "verification.md",
    ]),
    "aidlc-product-agent": new Set([
      "requirements-elicitation.md",
      "requirements-guide.md",
    ]),
    "aidlc-architect-agent": new Set(["architecture-guide.md"]),
  },
  "requirements-analysis": {
    "aidlc-shared": new Set([
      "ai-dlc-principles.md",
      "brownfield.md",
      "rules-reading.md",
      "verification.md",
    ]),
    "aidlc-product-agent": new Set([
      "requirements-elicitation.md",
      "requirements-guide.md",
    ]),
  },
};

const SHIPPED_INLINE_KNOWLEDGE: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  "aidlc-shared": new Set([
    "ai-dlc-principles.md",
    "audit-format.md",
    "brownfield.md",
    "knowledge-readme-template.md",
    "memory-template.md",
    "rules-reading.md",
    "state-template.md",
    "verification.md",
    "worktree-info-schema.md",
  ]),
  "aidlc-product-agent": new Set([
    "functional-design-guide.md",
    "market-research-methods.md",
    "prioritization-frameworks.md",
    "product-guide.md",
    "requirements-elicitation.md",
    "requirements-guide.md",
    "user-story-patterns.md",
  ]),
  "aidlc-architect-agent": new Set([
    "adr-template.md",
    "architecture-guide.md",
    "architecture-patterns.md",
    "ddd-patterns.md",
    "nfr-design-guide.md",
    "nfr-design-patterns.md",
  ]),
};

function pluginKnowledgeOwners(
  harnessRoot: string,
  warnings: string[],
): PluginKnowledgeOwners {
  const dataDir = join(harnessRoot, "tools", "data");
  if (!existsSync(dataDir)) return new Map();
  const owners = new Map<string, Set<string>>();
  let files: string[];
  try {
    files = readdirSync(dataDir)
      .filter((name) =>
        name.startsWith("plugin-files-") && name.endsWith(".json")
      )
      .sort();
  } catch (e) {
    warnings.push(
      `Warning: plugin knowledge ownership data "${toPosix(dataDir)}" is unreadable (${errorMessage(e)}). ` +
        "Minimal context will continue without plugin provenance.",
    );
    return owners;
  }
  for (const name of files) {
    const path = join(dataDir, name);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
        schema_version?: unknown;
        plugin?: unknown;
        knowledge?: unknown;
      };
      if (
        parsed.schema_version !== 1 ||
        typeof parsed.plugin !== "string" ||
        !Array.isArray(parsed.knowledge)
      ) {
        throw new Error("expected schema_version 1, plugin, and knowledge[]");
      }
      for (const value of parsed.knowledge) {
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.startsWith("/") ||
          value.split("/").includes("..")
        ) {
          throw new Error("knowledge paths must be relative path segments");
        }
        const rel = toPosix(join("knowledge", value));
        const pathOwners = owners.get(rel) ?? new Set<string>();
        pathOwners.add(parsed.plugin);
        owners.set(rel, pathOwners);
      }
    } catch (e) {
      warnings.push(
        `Warning: plugin knowledge ownership file "${toPosix(path)}" is invalid (${errorMessage(e)}). ` +
          "Re-run plugin composition before relying on Minimal context pruning.",
      );
    }
  }
  return owners;
}

function selectShippedInlineKnowledge(
  files: Array<{ abs: string; rel: string }>,
  stage: string,
  owner: string,
  depth: string | null,
  harnessRoot: string,
  pluginOwners: PluginKnowledgeOwners,
): Array<{ abs: string; rel: string }> {
  if (depth?.trim().toLowerCase() !== "minimal") return files;
  const selected = MINIMAL_INLINE_KNOWLEDGE[stage]?.[owner];
  if (!selected) return files;
  const shipped = SHIPPED_INLINE_KNOWLEDGE[owner];
  return files.filter((file) => {
    const harnessRelative = toPosix(relative(harnessRoot, file.abs));
    const pathOwners = pluginOwners.get(harnessRelative);
    if (pathOwners) {
      return [...pathOwners].some((plugin) => isPluginEnabled(plugin));
    }
    const ownerRelative = toPosix(relative(
      join(harnessRoot, "knowledge", owner),
      file.abs,
    ));
    return shipped?.has(ownerRelative) !== true ||
      selected.has(ownerRelative);
  });
}

function inlineContextEntries(
  node: GraphStage,
  codekbCtx?: CodekbCtx,
  warnings: string[] = [],
  depth: string | null = null,
): InlineContextEntry[] {
  const agents = inlineAgentsFor(node);
  if (agents.length === 0) return [];
  // The resolver ladder, not raw import.meta.url: in a compiled binary this
  // module's URL is inside the bundle (/$bunfs), where no markdown ships —
  // a raw derivation returns [] and inline stages silently lose persona +
  // knowledge context. The ladder falls back to the on-disk packaged
  // distribution the same way readConductorPersona resolves conductor.md.
  const harnessRoot = resolveHarnessRoot();
  const harnessPrefix = harnessDir();
  const entries: InlineContextEntry[] = [];
  const pluginOwners = pluginKnowledgeOwners(harnessRoot, warnings);

  for (const agent of agents) {
    const persona = join(harnessRoot, "agents", `${agent}.md`);
    const rel = toPosix(join(harnessPrefix, "agents", `${agent}.md`));
    if (!existsSync(persona)) {
      warnings.push(
        `Warning: optional persona/knowledge file "${rel}" is missing. ` +
          "Restore the file; this stage will continue without that context.",
      );
      continue;
    }
    try {
      assertReadableUtf8(persona);
    } catch (e) {
      warnings.push(
        `Warning: optional persona/knowledge file "${rel}" is unreadable or invalid UTF-8 (${errorMessage(e)}). ` +
          "Fix the file, encoding, or permissions; this stage will continue without that context.",
      );
      continue;
    }
    entries.push({
      abs: persona,
      rel,
      agent,
    });
  }
  entries.push(
    ...selectShippedInlineKnowledge(
      markdownFilesUnder(
        join(harnessRoot, "knowledge", "aidlc-shared"),
        join(harnessPrefix, "knowledge", "aidlc-shared"),
        warnings,
      ),
      node.slug,
      "aidlc-shared",
      depth,
      harnessRoot,
      pluginOwners,
    ).map((f) => ({ ...f, agent: null })),
  );
  for (const agent of agents) {
    entries.push(
      ...selectShippedInlineKnowledge(
        markdownFilesUnder(
          join(harnessRoot, "knowledge", agent),
          join(harnessPrefix, "knowledge", agent),
          warnings,
        ),
        node.slug,
        agent,
        depth,
        harnessRoot,
        pluginOwners,
      ).map((f) => ({ ...f, agent })),
    );
  }

  if (codekbCtx) {
    const customRoot = join(
      codekbCtx.projectDir,
      "aidlc",
      "spaces",
      codekbCtx.space,
      "knowledge",
    );
    const customPrefix = join("aidlc", "spaces", codekbCtx.space, "knowledge");
    entries.push(
      ...markdownFilesUnder(
        join(customRoot, "aidlc-shared"),
        join(customPrefix, "aidlc-shared"),
        warnings,
      ).map((f) => ({ ...f, agent: null })),
    );
    for (const agent of agents) {
      entries.push(
        ...markdownFilesUnder(
          join(customRoot, agent),
          join(customPrefix, agent),
          warnings,
        ).map((f) => ({ ...f, agent })),
      );
    }
  }

  // De-duplicate on rel (first wins), matching the old Set-of-paths shape.
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.rel)) return false;
    seen.add(e.rel);
    return true;
  });
}

function inlineContextRoster(
  node: GraphStage,
  codekbCtx?: CodekbCtx,
  depth: string | null = null,
): { paths: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const allPaths = inlineContextEntries(node, codekbCtx, warnings, depth).map((e) => e.rel);
  const paths: string[] = [];
  for (const path of allPaths) {
    const candidate = [...paths, path];
    if (
      Buffer.byteLength(JSON.stringify(candidate), "utf-8") >
        INLINE_CONTEXT_PATHS_MAX_BYTES
    ) {
      break;
    }
    paths.push(path);
  }
  const omitted = allPaths.length - paths.length;
  if (omitted > 0) {
    warnings.push(
      `Warning: ${omitted} optional persona/knowledge path(s) were omitted because there was ` +
        `no room to pass them all (inline_context_paths is capped at ${INLINE_CONTEXT_PATHS_MAX_BYTES} bytes). ` +
        "Configure fewer knowledge files if this matters; the stage runs without the omitted optional context.",
    );
  }
  return { paths, warnings: boundedContextWarnings(warnings) };
}

function boundedContextWarnings(warnings: string[]): string[] {
  if (
    Buffer.byteLength(JSON.stringify(warnings), "utf-8") <=
      CONTEXT_WARNINGS_MAX_BYTES
  ) {
    return warnings;
  }

  const kept: string[] = [];
  for (let i = 0; i < warnings.length; i++) {
    const omitted = warnings.length - i - 1;
    const summary = omitted > 0
      ? `Warning: ${omitted} additional optional persona/knowledge warning(s) were omitted from this directive. Inspect the configured context directories and repair missing, unreadable, or invalid UTF-8 files.`
      : null;
    const candidate = [...kept, warnings[i], ...(summary ? [summary] : [])];
    if (
      Buffer.byteLength(JSON.stringify(candidate), "utf-8") >
        CONTEXT_WARNINGS_MAX_BYTES
    ) {
      break;
    }
    kept.push(warnings[i]);
  }

  const omitted = warnings.length - kept.length;
  return [
    ...kept,
    `Warning: ${omitted} additional optional persona/knowledge warning(s) were omitted from this directive. Inspect the configured context directories and repair missing, unreadable, or invalid UTF-8 files.`,
  ];
}

// Build a run-stage directive by reading the routing fields straight off the
// compiled graph node. consumes/produces carry resolved active-record paths:
// the engine resolves the node's vocabulary names → paths at emit time (so the
// conductor never re-derives them) and drops conditional_on consumes-entries
// against the workflow's Project Type. rules_in_context maps to the node's
// resolved rule paths; sensors_applicable maps to the node's resolved sensor ids.
// `unit` is the active Unit of Work for per-unit Construction stages. The
// placeholder keeps the documented unresolved shape for isolated/ctx-less
// callers; null is the explicit zero-Unit fallback and resolves artifacts at the
// stage-level Construction directory. `scope` + `stateContent` feed the gate
// computation (the skeleton round-trip) and the first-run-stage persona delivery
// (decision D-E).
function buildRunStageDirective(
  node: GraphStage,
  projectType: "brownfield" | "greenfield" | null = null,
  unit: string | null = UNIT_NAME_PLACEHOLDER,
  scope: string = resolveDefaultScope(DEFAULT_SCOPE),
  stateContent: string | null = null,
  recordPrefix: string | null = null,
  codekbCtx?: CodekbCtx,
  unitKind: string | null = null,
  forcePersona = false,
  singleRun = false,
): RunStageDirective {
  const artifactUnit =
    unit === UNIT_NAME_PLACEHOLDER &&
      usesStageLevelPerUnitArtifacts(scope, stateContent)
      ? null
      : unit;
  const resolvedConsumes = resolveConsumes(
    node.consumes ?? [],
    node,
    projectType,
    artifactUnit,
    recordPrefix,
    codekbCtx,
    unitKind,
  );
  const { present, absent } = splitConsumesByPresence(
    resolvedConsumes,
    scope,
    codekbCtx,
    stateContent,
  );
  const depth = stateContent
    ? getField(stateContent, "Depth")
    : loadScopeMetadata()[scope]?.depth ?? null;
  const inlineContext = inlineContextRoster(node, codekbCtx, depth);
  const ruleEntries = codekbCtx
    ? rulesContentEntries(node, codekbCtx.projectDir, codekbCtx.space)
    : null;
  const directive: RunStageDirective = {
    kind: "run-stage",
    stage: node.slug,
    phase: node.phase,
    lead_agent: node.lead_agent,
    support_agents: node.support_agents ?? [],
    // The graph constrains mode to the active topologies
    // (inline|subagent|pipeline|mob); the directive's enum adds the reserved
    // agent-team. The node value always satisfies the contract; the validator
    // is the backstop if a future graph activates agent-team.
    mode: node.mode as RunStageDirective["mode"],
    inline_context_paths: inlineContext.paths,
    gate: computeGate(node, scope, stateContent),
    memory_path: memoryPathFor(node.phase, node.slug, recordPrefix),
    consumes: present,
    produces: resolveProduces(
      node,
      artifactUnit,
      recordPrefix,
      codekbCtx,
      unitKind,
    ),
    rules_in_context:
      ruleEntries?.map((entry) => entry.rel) ??
      (node.rules_in_context ?? []).map((r) => r.path),
    sensors_applicable: (node.sensors_applicable ?? []).map((s) => s.id),
    stage_file: stageFileFor(node.phase, node.slug),
  };
  if (node.mode === "pipeline" && codekbCtx) {
    const evidence = pipelineLinkEvidence(codekbCtx.projectDir, node, {
      singleRun,
    });
    directive.pipeline = {
      links: evidence.links,
      completed: evidence.completed,
    };
  }
  if (inlineContext.warnings.length > 0) {
    directive.context_warnings = inlineContext.warnings;
  }
  if (absent.length > 0) directive.consumes_absent = absent;
  // next_stage: the display name of the in-scope stage that follows this one, so
  // the approval gate's Approve option reads "Continue to <next_stage>" verbatim
  // instead of a guessed constant. Computed here at emit time: the gate is
  // presented and answered within the same forwarding beat, and any recompose
  // between emit and approval re-runs `next`, which re-emits with a fresh value.
  // nextInScopeStage honours the state file's EXECUTE/SKIP overrides + prior
  // [x]/[S] checkboxes, the same walk the post-approval advance uses, so the
  // named stage is the one the workflow will actually run next. null = this is
  // the final in-scope stage (the conductor renders "Complete workflow").
  const nextStage = nextInScopeStage(node.slug, scope, stateContent ?? undefined);
  directive.next_stage = nextStage ? nextStage.name : null;
  // Reviewer — include if the stage declares one (§12a) AND the effective
  // review class is not "none". The engine resolves the class here (stage
  // declaration, lowered by the scope's review_cap and any per-run Review
  // Override, low-wins) so the conductor never re-derives it: a "none"
  // resolution omits the whole reviewer block and the stage runs reviewless,
  // exactly like a stage that never declared a reviewer. Advisory pins the
  // iteration cap to 1 - a single pass is the contract, not a budget.
  if (node.reviewer) {
    const reviewClass = resolveReviewClass(
      node.review_class,
      scope,
      stateContent
    );
    if (reviewClass !== "none") {
      directive.reviewer = node.reviewer;
      directive.review_artifact = node.review_artifact;
      directive.review_class = reviewClass;
      directive.reviewer_max_iterations =
        reviewClass === "advisory" ? 1 : node.reviewer_max_iterations ?? 2;
    }
  }
  const protocolModules: ProtocolModule[] = [];
  if (directive.reviewer && directive.review_class) {
    protocolModules.push("reviewer");
  }
  if (
    node.mode === "subagent" ||
    node.mode === "pipeline" ||
    node.mode === "mob" ||
    (node.support_agents?.length ?? 0) > 0
  ) {
    protocolModules.push("ensemble");
  }
  if (node.phase === "construction") {
    protocolModules.push("construction");
  }
  if (protocolModules.length > 0) {
    directive.protocol_modules = protocolModules;
  }
  // Decision D-E: bake the conductor persona into the FIRST run-stage of the
  // workflow. The optional field is omitted on every later directive (the
  // persona persists in the session once delivered). A missing conductor.md is
  // best-effort — the directive stays well-formed without the field.
  // `forcePersona` covers the isolated single-stage runner, whose directive is
  // always the conductor's first of that run regardless of state - attached
  // HERE (not by the caller after build) so the final run-stage is complete.
  const firstOfWorkflow = isFirstRunStageOfWorkflow(stateContent, node);
  if (forcePersona || firstOfWorkflow) {
    const persona = readConductorPersona();
    if (persona !== null) directive.conductor_persona = persona;
  }
  // The spoken line for entering this stage. Attached here, where the scope and
  // first-of-workflow facts are in hand; emit() drops it again on a per-unit
  // iteration beat, because callers set `unit` after this builder returns.
  directive.narration =
    node.mode === "subagent" || node.mode === "pipeline"
      ? narrateSpecialistStage(node)
      : narrateStageEntry(node, scope, firstOfWorkflow, directive.gate);
  if (codekbCtx) {
    runStageRoutes.set(directive, {
      node,
      scope,
      stateAware: stateContent !== null,
      stateHash: stateContent === null ? null : sha256(stateContent),
      codekbCtx,
      unit,
      unitKind,
      forcePersona,
    });
  }
  bootstrapDirectiveMemory(directive.memory_path, codekbCtx);
  return directive;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

// Split a rule at Markdown heading boundaries first. Oversized sections are
// then divided at JavaScript code-point boundaries according to their actual
// JSON wire size, so escaping control characters cannot overflow a directive
// and no continuation can cut a multi-byte character.
function markdownSections(text: string): string[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const sections: string[] = [];
  let current = "";
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && current.length > 0) {
      sections.push(current);
      current = "";
    }
    current += line;
  }
  if (current.length > 0) sections.push(current);
  return sections.length > 0 ? sections : [text];
}

function ruleContentBytes(path: string, text: string): number {
  return Buffer.byteLength(JSON.stringify([{ path, text }]), "utf-8");
}

function splitRuleText(
  path: string,
  text: string,
  targetBytes: number,
): string[] {
  if (ruleContentBytes(path, text) <= targetBytes) return [text];

  const codePoints = Array.from(text);
  const parts: string[] = [];
  let start = 0;
  while (start < codePoints.length) {
    let low = start + 1;
    let high = codePoints.length;
    let fit = start;
    while (low <= high) {
      const end = Math.floor((low + high) / 2);
      const candidate = codePoints.slice(start, end).join("");
      if (ruleContentBytes(path, candidate) <= targetBytes) {
        fit = end;
        low = end + 1;
      } else {
        high = end - 1;
      }
    }
    if (fit === start) {
      // A filesystem path large enough to make one code point exceed the
      // target is not recoverable by text splitting. Preserve the character
      // so transportRunStage emits the explicit size error.
      fit = start + 1;
    }
    parts.push(codePoints.slice(start, fit).join(""));
    start = fit;
  }
  return parts;
}

function steeringPieces(content: RuleContent[]): RuleContent[] {
  const pieces: RuleContent[] = [];
  for (const rule of content) {
    for (const section of markdownSections(rule.text)) {
      for (const text of splitRuleText(
        rule.path,
        section,
        STEERING_TEXT_TARGET_BYTES,
      )) {
        pieces.push({ path: rule.path, text });
      }
    }
  }
  return pieces;
}

function steeringChunks(content: RuleContent[]): RuleContent[][] {
  const chunks: RuleContent[][] = [];
  let current: RuleContent[] = [];
  for (const piece of steeringPieces(content)) {
    const candidate = [...current, piece];
    const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf-8");
    if (current.length > 0 && bytes > STEERING_TEXT_TARGET_BYTES) {
      chunks.push(current);
      current = [piece];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

type SteeringTokenEnvelope = {
  p: SteeringTokenPayload;
  m: string;
  probe?: true;
};

const STEERING_TOKEN_KEY_BYTES = 32;
const STEERING_TOKEN_KEY_FILE = ".aidlc-steering-token-key";

type SteeringTokenKeyResult = {
  key: Buffer | null;
  error: string | null;
};

function steeringTokenKeyPath(projectDir: string): string {
  const statePath = engineStateFilePath(projectDir);
  if (existsSync(statePath)) {
    return join(dirname(statePath), STEERING_TOKEN_KEY_FILE);
  }
  return join(
    projectDir,
    "aidlc",
    ".aidlc-sessions",
    STEERING_TOKEN_KEY_FILE,
  );
}

// The MAC key is machine-local runtime state, not a project-derived value an
// untrusted continuation can recompute. It lives under the active intent's
// already-gitignored .aidlc-* family, or the clone-local session runtime before
// an intent exists, and is minted without changing workflow state. Repeated
// next calls in one checkout reuse the key, so their tokens remain deterministic.
function steeringTokenKey(
  projectDir: string,
  create: boolean,
): SteeringTokenKeyResult {
  const path = steeringTokenKeyPath(projectDir);
  const read = (): SteeringTokenKeyResult => {
    try {
      const encoded = readFileSync(path, "utf-8").trim();
      const key = Buffer.from(encoded, "base64url");
      if (
        key.length !== STEERING_TOKEN_KEY_BYTES ||
        key.toString("base64url") !== encoded
      ) {
        return {
          key: null,
          error:
            `The local key file at "${path}" is corrupt, so this stage's rules cannot be loaded safely. ` +
            "Delete that file and run a fresh `next`; a replacement is created automatically.",
        };
      }
      return { key, error: null };
    } catch (error) {
      return {
        key: null,
        error:
          `Cannot read the local key file at "${path}", so this stage's rules cannot be loaded ` +
          `(${errorMessage(error)}).`,
      };
    }
  };

  if (existsSync(path)) return read();
  if (!create) return { key: null, error: null };

  try {
    mkdirSync(dirname(path), { recursive: true });
    const key = randomBytes(STEERING_TOKEN_KEY_BYTES);
    writeFileSync(path, `${key.toString("base64url")}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    return { key, error: null };
  } catch (error) {
    // A concurrent first request may have won the exclusive create. Re-read
    // that key so every process converges on the same continuation chain.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return read();
    return {
      key: null,
      error:
        `Cannot create the local key file at "${path}", so this stage's rules cannot be loaded ` +
        `(${errorMessage(error)}). Fix the directory permissions, then run a fresh \`next\`.`,
    };
  }
}

function steeringTokenMac(
  payload: SteeringTokenPayload,
  key: Buffer,
): string {
  return createHmac("sha256", key)
    .update(JSON.stringify(payload), "utf-8")
    .digest("base64url");
}

function probeSteeringTokenKey(projectDir: string): Buffer {
  return createHash("sha256")
    .update(`aidlc-stop-probe:${resolve(projectDir)}`, "utf-8")
    .digest();
}

function encodeSteeringToken(
  payload: SteeringTokenPayload,
  projectDir: string,
): { token: string | null; error: string | null } {
  const probe = isTeamStopHookProbe(projectDir);
  const loaded = steeringTokenKey(projectDir, !probe);
  const key = probe
    ? (loaded.error === null ? probeSteeringTokenKey(projectDir) : null)
    : loaded.key;
  if (!key) return { token: null, error: loaded.error };
  const envelope: SteeringTokenEnvelope = {
    p: payload,
    m: steeringTokenMac(payload, key),
    ...(probe ? { probe: true } : {}),
  };
  return {
    token: Buffer.from(JSON.stringify(envelope), "utf-8").toString("base64url"),
    error: null,
  };
}

function decodeSteeringToken(
  token: string,
  projectDir: string,
): SteeringTokenPayload | null {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(token, "base64url").toString("utf-8"),
    );
    if (
      decoded === null ||
      typeof decoded !== "object" ||
      !("p" in decoded) ||
      !("m" in decoded) ||
      typeof (decoded as { m?: unknown }).m !== "string"
    ) {
      return null;
    }
    const envelope = decoded as { p: unknown; m: string; probe?: unknown };
    if (envelope.p === null || typeof envelope.p !== "object") return null;
    const probe = envelope.probe === true;
    if (envelope.probe !== undefined && !probe) return null;
    if (
      probe &&
      (
        !("i" in envelope.p) ||
        (envelope.p as { i?: unknown }).i !== 1
      )
    ) {
      return null;
    }
    const loaded = steeringTokenKey(projectDir, false);
    const key = probe ? probeSteeringTokenKey(projectDir) : loaded.key;
    if (!key) return null;
    const expected = Buffer.from(
      steeringTokenMac(envelope.p as SteeringTokenPayload, key),
      "base64url",
    );
    const actual = Buffer.from(envelope.m, "base64url");
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      return null;
    }
    const value = envelope.p;
    if (!("v" in value) || value.v !== 1) return null;
    const p = value as Partial<SteeringTokenPayload>;
    if (
      typeof p.s !== "string" ||
      typeof p.c !== "string" ||
      typeof p.i !== "number" ||
      !Number.isInteger(p.i) ||
      p.i < 1 ||
      typeof p.b !== "string" ||
      typeof p.d !== "string" ||
      typeof p.r !== "string" ||
      typeof p.a !== "boolean" ||
      (p.u !== null && typeof p.u !== "string") ||
      (p.k !== null && typeof p.k !== "string") ||
      typeof p.f !== "boolean" ||
      (typeof p.g !== "boolean" && p.g !== GATE_UNRESOLVED) ||
      (p.n !== undefined && p.n !== null && typeof p.n !== "string") ||
      typeof p.x !== "boolean" ||
      typeof p.p !== "boolean" ||
      typeof p.w !== "boolean" ||
      (p.z !== undefined && typeof p.z !== "boolean") ||
      (p.q !== undefined && p.q !== "per-stage" && p.q !== "unit-end") ||
      (p.h !== null && typeof p.h !== "string")
    ) {
      return null;
    }
    return p as SteeringTokenPayload;
  } catch {
    return null;
  }
}

function steeringTokenPayload(
  directive: RunStageDirective,
  route: RunStageRoute,
  bundle: string,
  directiveHash: string,
  nextPart: number,
): SteeringTokenPayload {
  return {
    v: 1,
    s: directive.stage,
    c: route.scope,
    i: nextPart,
    b: bundle,
    d: directiveHash,
    r: steeringRouteHash(route.node, route.scope),
    a: route.stateAware,
    u: directive.unit ?? route.unit,
    k: route.unitKind,
    f: route.forcePersona,
    g: directive.gate,
    n: directive.next_stage,
    x: directive.single === true,
    p: directive.unit !== undefined,
    w: directive.wave !== undefined,
    z: directive.swarm_settled === true,
    q: directive.unit_gate,
    h: route.stateHash,
  };
}

function steeringRouteHash(node: GraphStage, scope: string): string {
  return sha256(
    JSON.stringify({
      node,
      scopeStages: subgraphForScope(scope).map((stage) => stage.slug),
    }),
  );
}

function transportRunStage(
  directive: RunStageDirective,
  route: RunStageRoute,
): Directive {
  const loaded = readRuleBundle(
    rulesContentEntries(
      route.node,
      route.codekbCtx.projectDir,
      route.codekbCtx.space,
    ),
  );
  if (loaded.error) return errorDirective(loaded.error);

  directive.rules_in_context = [
    ...new Set(loaded.content.map((entry) => entry.path)),
  ];
  const bundle = `sha256:${sha256(JSON.stringify(loaded.content))}`;
  const directiveHash = sha256(JSON.stringify(directive));
  const chunks = steeringChunks(loaded.content);
  const requested = requestedSteeringContinuation;

  if (requested) {
    if (
      requested.s !== directive.stage ||
      requested.b !== bundle ||
      requested.d !== directiveHash
    ) {
      return errorDirective(
        "This stage or its rules changed while they were being loaded, so what has arrived so far is stale. Run a fresh `next` to restart delivery from part 1.",
      );
    }
    if (requested.i > chunks.length) {
      return errorDirective(
        "This request asks for a part of the stage rules that does not exist. Run a fresh `next` to restart delivery from part 1.",
      );
    }
    if (requested.i === chunks.length) return directive;
  } else if (chunks.length === 0) {
    return directive;
  }

  const index = requested?.i ?? 0;
  const payload = steeringTokenPayload(
    directive,
    route,
    bundle,
    directiveHash,
    index + 1,
  );
  const encoded = encodeSteeringToken(
    payload,
    route.codekbCtx.projectDir,
  );
  if (!encoded.token) {
    return errorDirective(
      encoded.error ??
        "This stage's rules cannot be loaded safely right now. Run a fresh `next` after repairing the local runtime files under `aidlc/`.",
    );
  }
  const load: LoadSteeringDirective = {
    kind: "load-steering",
    stage: directive.stage,
    bundle,
    part: index + 1,
    parts: chunks.length,
    rules_content: chunks[index],
    continue_token: encoded.token,
  };
  if (Buffer.byteLength(JSON.stringify(load), "utf-8") > DIRECTIVE_MAX_BYTES) {
    return errorDirective(
      "A rule section could not be split below the directive transport limit. Shorten the affected heading section, then run a fresh `next`.",
    );
  }
  return load;
}

// Find the graph node for a slug. Composes loadGraph() (the one cached read).
function nodeForSlug(slug: string): GraphStage | undefined {
  return loadGraph().find((s) => s.slug === slug);
}

// The `next` handler reads workflow state and emits exactly one directive. Rule
// transport may lazily mint its machine-local MAC key. Ordinary routing never
// mutates shared workflow state; `--single` adds only its synthetic audit start
// and cannot move the main workflow pointer.
function handleNext(args: string[], projectDir: string | undefined): void {
  activeStageValidityAdvisory = undefined;
  const flags = parseNextFlags(args);

  // Turn-shape marker: a `next` that ASKS FOR THE NEXT MOVE is engagement with
  // the forwarding loop even though it mutates nothing — and it emits no audit
  // event, which is precisely why the Stop hook's carve-out needs a marker
  // rather than the ledger (a conductor that ran `next` and then bailed is
  // invisible to the ledger but visible here). Read-only utility flags and the
  // workspace verbs are excluded: they carry no workflow intent, so a status
  // query stays a conversational turn.
  //
  // DELIBERATELY BEFORE Branch 0 (the roll-forward latch) below, so a `next` the
  // latch swallows as a no-op still counts as engagement. That is the correct
  // parity: on the transcript path a bare `next` counts too, latch or no latch —
  // isEngineToolCall reads the command, not its outcome. Moving this after the
  // latch would make the two predicates disagree about the same command. The
  // same reasoning keeps it before the flag-validation early returns: an
  // errored command still counted on the transcript path.
  if (!flags.readOnly && !flags.workspaceCommand) touchEngineMarker(projectDir);

  if (flags.parseError) {
    emit(errorDirective(flags.parseError));
    return;
  }

  // Review changes mutate workflow configuration. Compound modes that return
  // before the config branch cannot silently discard the flag; require callers
  // to apply the override first, then invoke the other mode separately.
  if (
    flags.review &&
    (
      flags.readOnly ||
      flags.workspaceCommand ||
      flags.compose ||
      flags.newScope ||
      flags.report ||
      flags.single ||
      flags.stage ||
      flags.phase ||
      flags.resume
    )
  ) {
    emit(errorDirective(
      "Cannot combine --review with read-only, workspace, compose, single-stage, jump, or resume modes. Apply /aidlc --review <class> first, then run the other command.",
    ));
    return;
  }

  if (flags.claim || flags.release) {
    if (flags.claim && flags.release) {
      emit(errorDirective("Cannot combine --claim and --release."));
      return;
    }
    const verb = flags.claim ? "claim" : "release";
    const unit = flags.claim ?? flags.release!;
    const teamArg = flags.claimTeam
      ? ` --team ${shellArg(flags.claimTeam)}`
      : "";
    const rhythmArg = flags.claimRhythm
      ? ` --rhythm ${shellArg(flags.claimRhythm)}`
      : "";
    emit(printDirective(
      `Run \`bun ${harnessDir()}/tools/aidlc-utility.ts ${verb} ${shellArg(unit)}${teamArg}${rhythmArg}\`, ` +
        "print its output verbatim, then stop. Re-run /aidlc after the claim registry changes.",
    ));
    return;
  }

  // Branch 0 — turn-scoped no-op-next guard (Kiro roll-forward defense). On Kiro
  // the userPromptSubmit seam handles a read-only/navigation command
  // deterministically off-band but CANNOT block the turn, so the conductor relays
  // the output AND may still fire a bare `next` (sometimes several times the same
  // turn), rolling the active workflow forward. The seam stamps
  // aidlc/.aidlc-readonly-latch with the CURRENT turn counter; here, BEFORE any
  // state inspection, a TRULY BARE advancing next (none of its own flags set)
  // checks the latch: when latch.turn === the current counter (the SAME turn) we
  // emit `done` instead of routing to a run-stage. Turn-scoped — a legitimate
  // advancing next in a LATER turn (counter bumped, latch now stale) is never
  // swallowed. Inert on Claude/Codex: the latch files are never written there (no
  // seam) → fresh is always false → falls through. Advisory: any failure fails
  // open to the normal `next`.
  if (!flags.readOnly && !flags.workspaceCommand && !flags.pluginCommand && !flags.knowledgeCommand && !flags.stage && !flags.phase &&
      !flags.scope && !flags.positionalScope && !flags.intent && !flags.resume &&
      !flags.depth && !flags.testStrategy && !flags.review &&
      !flags.single && !flags.compose && !flags.newScope && !flags.report &&
      !flags.claim && !flags.release) {
    try {
      const pdLatch = resolveProjectDir(projectDir);
      const latchPath = join(pdLatch, "aidlc", ".aidlc-readonly-latch");
      const counterPath = join(pdLatch, "aidlc", ".aidlc-turn-counter");
      let counter = -1;
      let latchTurn = -2;
      let label = "the read-only command";
      if (existsSync(counterPath)) {
        const n = Number.parseInt(readFileSync(counterPath, "utf-8").trim(), 10);
        if (Number.isFinite(n)) counter = n;
      }
      if (existsSync(latchPath)) {
        const lr = JSON.parse(readFileSync(latchPath, "utf-8")) as { turn?: number; flag?: string; source?: string };
        if (typeof lr.turn === "number") latchTurn = lr.turn;
        if (typeof lr.flag === "string") {
          // Read-only flags render with `--`; noun commands render as typed.
          const nounCommand = lr.source === "workspace-verb" || lr.source === "plugin-verb" ||
            lr.source === "knowledge-verb";
          label = nounCommand ? `\`${lr.flag}\`` : `--${lr.flag}`;
        }
      }
      if (counter >= 0 && latchTurn === counter) {
        emit({
          kind: "done",
          reason: `The read-only/navigation command (${label}) already ran this turn and its output was shown above. This was a read-only utility or a workspace switch, not workflow work — there is nothing to advance. The workflow is unchanged; if one is active it remains paused where it was. STOP.`,
        });
        return;
      }
    } catch { /* advisory: guard is best-effort, never blocks a real next */ }
  }

  // Branch 1 — read-only utility flags dispatch FIRST, before any state
  // inspection (SKILL.md absolute-precedence rule: --status/--help/--doctor/
  // --version run even when a state file exists). The engine names the move as
  // a print directive; the conductor runs the matching tool and prints its
  // stdout verbatim. The directive NAMES THE EXACT command (the flag maps 1:1 to
  // an aidlc-utility.ts subcommand by stripping the leading `--`: --status→status,
  // --doctor→doctor, --help→help, --version→version) and spells out the terminal
  // contract ("then stop … do NOT run `next`"). This mirrors the workspace-verb
  // branch (Branch 1b below) and exists because the earlier vague wording ("Run
  // the read-only utility for --doctor …") let a live conductor over an active
  // workflow mis-route to a bare `next` and roll forward into the active stage
  // instead of running the utility — a read-only command carries no workflow
  // work, so it must never advance an intent. The harness dir is resolved through
  // harnessDir() so the directive names the right tree on every harness.
  if (flags.readOnly) {
    const sub = flags.readOnly.replace(/^--/, "");
    // Carry the allowlisted trailing args (`--doctor --export [--output <dir>]`)
    // into the named command so the documented export surface reaches the tool
    // through the real routing path, not just a direct invocation.
    const extra = flags.readOnlyArgs && flags.readOnlyArgs.length > 0
      ? ` ${flags.readOnlyArgs.join(" ")}`
      : "";
    emit(printDirective(
      `Run \`bun ${harnessDir()}/tools/aidlc-utility.ts ${sub}${extra}\`, print its output verbatim, then stop. This is a read-only utility, NOT workflow work: do NOT run \`next\` and do NOT advance, resume, or run any workflow stage.`,
    ));
    return;
  }

  // Branch 1b — workspace commands (space/space-create/intent) dispatch
  // BEFORE any state inspection, mirroring Branch 1. This MUST precede
  // resolveProjectDir/loadState: a switch works whether or not a workflow is
  // active, and placing it later would let e.g. `space teamB` fall into the
  // happy-path branch and advance the WRONG intent. The shared parser decides
  // list/switch/create/creation/error semantics, then this adapter renders the
  // deterministic utility argv. Leading-token precedence is deliberate: a
  // `--status` after a workspace noun is that command's token, not a mode
  // switch. The harness dir is resolved through harnessDir() so the directive
  // names the right tree on every harness.
  if (flags.workspaceCommand) {
    const command = flags.workspaceCommand;
    if (command.kind === "error") {
      emit(errorDirective(command.message));
      return;
    }
    const argv = workspaceCommandUtilityArgv(command);
    if (argv === null) {
      emit(errorDirective("Invalid workspace command."));
      return;
    }
    const [verb, ...tail] = argv;
    const suffix = tail.length > 0 ? ` ${tail.map(shellArg).join(" ")}` : "";
    emit(printDirective(
      `Run \`bun ${harnessDir()}/tools/aidlc-utility.ts ${verb}${suffix}\`, print its output verbatim, then stop.`,
    ));
    return;
  }

  // Branch 1c - plugin utilities are terminal commands, never freeform intent
  // text. The shared parser also feeds the binary dispatcher and Kiro seam, so
  // every harness preserves the same list/sync/select argv and error grammar.
  if (flags.pluginCommand) {
    const command = flags.pluginCommand;
    if (command.kind === "error") {
      emit(errorDirective(command.message));
      return;
    }
    const argv = command.kind === "help" ? ["help"] : command.argv;
    const [verb, ...tail] = argv;
    const suffix = tail.length > 0 ? ` ${tail.map(shellArg).join(" ")}` : "";
    emit(printDirective(
      `Run \`bun ${harnessDir()}/tools/aidlc-utility.ts ${verb}${suffix}\`, print its output verbatim, then stop. This is a terminal utility, NOT workflow work: do NOT run \`next\` and do NOT advance, resume, or run any workflow stage.`,
    ));
    return;
  }

  // Branch 1d - DocumentKB verbs are terminal commands, never freeform intent
  // text. Same shape as 1c, but the directive names aidlc-knowledge.ts: this is
  // the first public noun whose verbs live in their own tool rather than in
  // aidlc-utility.ts, so the tool name is part of what each site must agree on.
  if (flags.knowledgeCommand) {
    const command = flags.knowledgeCommand;
    if (command.kind === "error") {
      emit(errorDirective(command.message));
      return;
    }
    const argv = command.kind === "help" ? ["help"] : command.argv;
    const [verb, ...tail] = argv;
    const suffix = tail.length > 0 ? ` ${tail.map(shellArg).join(" ")}` : "";
    emit(printDirective(
      `Run \`bun ${harnessDir()}/tools/aidlc-knowledge.ts ${verb}${suffix}\`, print its output verbatim, then stop. This is a terminal utility, NOT workflow work: do NOT run \`next\` and do NOT advance, resume, or run any workflow stage.`,
    ));
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
  // Runtime state-version guard (see staleStateVersionError): refuse to advance
  // a pre-v8 state up front rather than silently routing until it hits the
  // renamed/missing Inception rows. Fires after the workspace/plugin/compose
  // branches above (those are version-independent) and before any branch that
  // reads or advances the workflow cursor.
  // `!== null` (not truthiness): a PRESENT but zero-byte aidlc-state.md returns
  // "" and must still be refused (an empty version → missing/unparseable branch),
  // not skipped as if the file were absent.
  if (stateContent !== null) {
    const stale = staleStateVersionError(stateContent);
    if (stale) {
      emit(errorDirective(stale));
      return;
    }
  }
  // The active intent's RELATIVE record-dir prefix (aidlc/spaces/<sp>/intents/
  // <slug>-<id8>), threaded into every run-stage directive so the conductor's
  // artifact/diary paths resolve under the active intent. null → the flat legacy
  // `aidlc-docs` prefix (a pre-workspace project not yet migrated/created). Resolved
  // once here where projectDir is known; the resolvers themselves take no pd.
  const recordPrefix = engineRelativeRecordDir(pd);
  // The space-level codekb context, resolved on the SAME live projectDir as
  // recordPrefix and threaded down the same spine. Lets resolveArtifactPath
  // place a KNOWN_CODEKB_STAGES artifact under aidlc/spaces/<space>/codekb/
  // <repo>/ (dropping the intents/<slug> tail) without re-reading the disk in
  // the pure resolver. codekbRepoName is read-only (intentRepos never throws).
  const codekbCtx = codekbCtxFor(pd);
  const unitScope =
    stateContent && isTeamUnitOwnership(stateContent)
      ? readApplicableTeamUnitScopeStamp(pd, stateContent)
      : null;

  if (unitScope && (flags.stage || flags.phase)) {
    emit(errorDirective(
      `This checkout is scoped to Unit "${unitScope.unit}"; explicit stage/phase jumps are refused in a scoped Unit checkout.`,
    ));
    return;
  }

  if (
    unitScope &&
    !flags.resume &&
    !flags.stage &&
    !flags.phase &&
    existsSync(unitParkedPath(pd))
  ) {
    emit(parkedDirective(
      `Unit "${unitScope.unit}" is parked in this checkout. Resume with /aidlc --resume.`,
      getField(stateContent!, "Current Stage") ?? "functional-design",
    ));
    return;
  }
  if (
    unitScope &&
    flags.resume &&
    !flags.stage &&
    !flags.phase &&
    existsSync(unitParkedPath(pd))
  ) {
    emit(printDirective(
      `Run \`bun ${harnessDir()}/tools/aidlc-state.ts unpark\` to clear this checkout's Unit park marker, then re-run \`next --resume\`.`,
    ));
    return;
  }

  // Branch 2.5 - PARKED workflow (issue #367). The `park` subcommand persists a
  // `Parked` runtime field (via aidlc-state.ts park) without advancing any
  // stage; on a PLAIN `next` (no explicit re-entry flag) the engine emits a
  // terminal `parked` directive that the Stop hook honours as a clean turn-end,
  // so a long workflow can pause across sessions instead of rubber-stamping the
  // remaining stages to reach `done`. Two self-disabling conditions keep this
  // narrow:
  //   1. SELF-DISABLE on explicit re-entry - a `--resume` / `--stage` / `--phase`
  //      next is a deliberate continuation, handled by the unpark branch below
  //      (resume) or the jump path (stage/phase), so it never re-emits `parked`.
  //   2. STALE-BY-PROGRESS - only emit `parked` while `Parked At Stage` still
  //      equals `Current Stage`. If the workflow has advanced past the parked
  //      slug (a stale marker), ignore it and fall through to the normal route.
  if (
    stateContent &&
    !unitScope &&
    !flags.resume &&
    !flags.stage &&
    !flags.phase &&
    !flags.review &&
    !flags.newIntent &&
    (getField(stateContent, "Parked") ?? "").trim().length > 0
  ) {
    const parkedAt = (getField(stateContent, "Parked At Stage") ?? "").trim();
    const currentSlug = (getField(stateContent, "Current Stage") ?? "").trim();
    if (parkedAt.length > 0 && parkedAt === currentSlug) {
      emit(parkedDirective(
        `Workflow parked at "${parkedAt}". Resume with /aidlc --resume.`,
        parkedAt,
      ));
      return;
    }
  }

  // Branch 2.6 - unpark on RESUME (issue #367). A `--resume` over a parked
  // workflow must CLEAR the marker before continuing, else the next plain `next`
  // would re-park. Clearing is a MUTATION, so `next` NAMES the move (a
  // run-then-continue print) and the conductor runs the tool; `next` itself
  // writes nothing. Fires before normal continuation routing so the marker is
  // cleared first.
  if (
    stateContent &&
    !unitScope &&
    flags.resume &&
    !flags.stage &&
    !flags.phase &&
    (getField(stateContent, "Parked") ?? "").trim().length > 0
  ) {
    emit(printDirective(
      `This workflow is parked. Run \`bun ${harnessDir()}/tools/aidlc-state.ts unpark\` ` +
        "to clear the park marker, then re-run `next --resume` to continue.",
    ));
    return;
  }

  // (Branch 3 — the legacy `--init` flag — retired in P4. There is no longer a
  // user-facing `/aidlc --init`: the workspace shell ships in dist/ (SEED) and
  // the first intent is CREATED, not scaffolded. Creation flows through the
  // createPrintDirective seam below — Branch 7b/9a name the `intent-create` move
  // for a resolved scope on a fresh workspace; Branch 8 surfaces the freeform
  // scope-confirm `ask` first. No `--init`/`--force` flag reaches the engine.)

  // Resolve scope by the precedence ladder before any graph lookup.
  const { scope, source, error: scopeResolutionError } = resolveScope(stateContent, flags);

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

  if (source === "default" && scopeResolutionError) {
    emit(errorDirective(scopeResolutionError));
    return;
  }

  // An unresolvable (unknown) scope is a hard error — the engine cannot derive
  // a path through a scope it doesn't know. Mirrors the prose orchestrator's
  // verbatim "Unknown scope" error so downstream assertions hold.
  if (!validScopes().has(scope)) {
    const valid = [...validScopes()].join(", ");
    emit(errorDirective(`Unknown scope "${scope}". Valid scopes: ${valid}.`));
    return;
  }

  // Branch 4c - the COMPOSE surfaces (adaptive workflows). A leading `compose`
  // verb, `--new-scope`, or `--report <path>` each force the composer; the
  // engine NAMES the dispatch (print) and stays read-only. Deliberately NOT a
  // WORKSPACE_VERBS/classifyTerminalCommand entry (that would make the Kiro
  // verb-intercept hook run `compose` off-band as a terminal aidlc-utility
  // subcommand and arm the roll-forward latch - compose is workflow work the
  // conductor dispatches). Two modes split on the state file: no state = the
  // FRONT composer (propose a scope before creation); state present = the
  // IN-FLIGHT composer (propose pending-stage flips over the running
  // workflow), which is what keeps a bare mid-flow `compose` from falling
  // through to Branch 10 and silently advancing the current stage. Precedes
  // Branch 5 (scope/config-change) and Branch 7 (jump) so neither mutating
  // path swallows a compose request.
  if (flags.compose || flags.newScope || flags.report) {
    if (flags.stage || flags.phase) {
      emit(errorDirective(
        "Cannot combine compose with --stage/--phase. Compose re-shapes the plan; jump moves the cursor. Run them separately.",
      ));
      return;
    }
    emit(composeDispatchDirective(flags, stateContent !== null));
    return;
  }

  // Branch 4a — --new-intent: the conductor recognized NEW WORK alongside an
  // already-active intent, ran the SKILL.md offer (AskUserQuestion), and the human
  // confirmed. Rather than have the conductor CONSTRUCT the intent-create command
  // from SKILL.md prose — a weak signal the live model dropped the --label seam on
  // (the 2nd/3rd intents truncated where the 1st, driven by this directive, got a
  // clean LLM label) — the engine emits the SAME createPrintDirective the fresh-
  // start path (Branch 7b/9a) uses, so BOTH creation directives carry the --label
  // placeholder identically. The human-yes gate already happened conductor-side;
  // this is the
  // creation print that performs it. Unlike the fresh-start tail, the new-intent
  // directive tells the conductor to STOP after creation and hand off to a fresh
  // session (createPrintDirective branches on flags.newIntent): a second, unrelated
  // intent should not inherit the completed intent's session context. Precedes
  // every continuation branch so an active intent's state never routes new-work
  // intent creation to "advance the current stage". The freeform new-work text
  // rides in flags.intent (the same slot Branch 9a threads as the description).
  if (flags.newIntent) {
    const description = flags.intent?.trim();
    if (!description) {
      emit(errorDirective(
        "`next --new-intent` requires a nonblank new-work description after the confirmed scope.",
      ));
      return;
    }
    // Use the EXPLICIT --scope, not the precedence-ladder `scope` (which lets the
    // ACTIVE intent's state scope win — wrong for a brand-new intent: the offer
    // confirmed a scope for the NEW work, independent of what's in flight). Fall
    // back to the resolved scope only when no flag was passed. Both were already
    // validated above (Branch 3b validates flags.scope; the unknown-scope check
    // validates the resolved scope).
    emit(createPrintDirective(flags.scope ?? scope, flags, pd, description));
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
  // on whether a main workflow exists. This branch records STAGE_STARTED under a
  // synthetic workflow id before emitting work; `report --single` records only
  // STAGE_COMPLETED. Neither path dispatches advance/approve/complete-workflow, so
  // the main pointer is structurally untouchable from a single-stage run. This branch precedes Branch
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
    emitSingleRunStage(
      flags.stage,
      scope,
      projectType,
      recordPrefix,
      codekbCtx,
      codekbCtx.projectDir,
    );
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
      if (flags.review) parts.push(`--review ${flags.review}`);
      emit(printDirective(
        `Run \`bun ${harnessDir()}/tools/aidlc-utility.ts ${parts.join(" ")}\` to change scope, then print its output verbatim and stop.`,
      ));
      return;
    }
    // A depth / test-strategy / review modifier with no scope change is a
    // config-change. A same-as-current --scope is also config-only: dropping
    // it here would silently discard the modifiers and run the current stage.
    if (
      (!flags.scope || flags.scope === currentStateScope) &&
      (flags.depth || flags.testStrategy || flags.review)
    ) {
      const parts = ["config-change"];
      if (flags.depth) parts.push(`--depth ${flags.depth}`);
      if (flags.testStrategy) parts.push(`--test-strategy ${flags.testStrategy}`);
      if (flags.review) parts.push(`--review ${flags.review}`);
      emit(printDirective(
        `Run \`bun ${harnessDir()}/tools/aidlc-utility.ts ${parts.join(" ")}\` to update the configuration, then print its output verbatim and stop.`,
      ));
      return;
    }
  }

  // Branch 7 — explicit --phase / --stage jump. The conductor relays the
  // human's jump target; the engine SUPPLIES the resolved direction by shelling
  // out to `aidlc-jump.ts resolve` (a pure read) rather than re-deriving the
  // SKILL.md:191-193 forward/backward/redo comparison by hand. resolve also
  // owns the in-scope SKIP validation, so a jump to a stage the scope skips is
  // relayed as its VERBATIM `Stage "..." is skipped for scope "...".` error.
  // On success we surface the run-stage directive for the resolved target,
  // carrying resolved artifact paths (projectType feeds the conditional_on
  // filter for the jumped-to stage). An explicit target also wins when combined
  // with --resume: `next --resume --stage <slug>` reaches this jump branch.
  if (flags.phase || flags.stage) {
    emitJumpDirective(flags, scope, pd, projectType);
    return;
  }

  // Branch 7b — positional scope with no workflow yet. `/aidlc bugfix` and
  // `/aidlc bugfix Fix duplicate todos` both name a scope; the parser peels the
  // leading valid token into positionalScope and leaves any trailing prose in
  // flags.intent. Create an intent with the positional scope and preserve that prose as the
  // intent-create --arguments value. An explicit --scope outranks this branch
  // and reaches Branch 9a; a no-state --resume never creates.
  if (
    !stateContent &&
    flags.positionalScope &&
    !flags.scope &&
    !flags.resume
  ) {
    // Don't create a duplicate over a multi-intent workspace whose cursor is
    // unset (fresh clone) — prompt the human to pick an existing intent. null →
    // zero intents → creation as before.
    const pick = intentPickPromptIfRecordsExist(
      pd,
      flags.intent
        ? {
            description: flags.intent,
            proposedScope: flags.positionalScope,
          }
        : undefined,
    );
    if (pick) {
      emit(pick);
      return;
    }
    emit(createPrintDirective(flags.positionalScope, flags, pd, flags.intent));
    return;
  }

  // Branch 8 - freeform intent with no workflow yet (SKILL.md:355-362). The
  // user described what to build in prose rather than naming a scope. `next`
  // stays read-only and surfaces the routing question as an `ask` - the engine
  // never calls AskUserQuestion itself. A bare KNOWN-SCOPE positional was
  // already handled by Branch 7b above, so only genuine prose reaches here.
  //
  // Adaptive routing (replaces the old static default confirm, which
  // interpolated the precedence-ladder scope and silently defaulted rich prose):
  // keyword inference (inferScopeFromText, a pure read; the
  // audit-emitting detect-scope verb remains the conductor's recording move)
  // now drives the ask.
  //   - CLEAR KEYWORD HIT (source "keyword": matched a scope's keywords and
  //     is within the matcher's word bound): a one-line confirm naming the
  //     MATCHED scope, with "name another scope" and "compose" as outs.
  //   - NO HIT / RICH PROSE (source "freeform": no keyword matched, or the
  //     description is long enough that the match is likely incidental): the
  //     COMPOSE OFFER, never a silent default. The conductor renders
  //     it; on "compose" it re-runs `next compose "<text>"` to reach the
  //     Branch 4c dispatch.
  if (
    !stateContent &&
    flags.intent &&
    !flags.scope &&
    !flags.positionalScope
  ) {
    const inferred = inferScopeFromText(flags.intent);
    if (isKiroRoutingHarness()) {
      const pick = intentPickPromptIfRecordsExist(pd, {
        description: flags.intent,
        proposedScope: inferred.scope,
      });
      if (pick) {
        emit(pick);
        return;
      }
    }
    if (inferred.source === "keyword") {
      // Preview the ceremony the user is confirming: stage/gate counts from the
      // compiled grid (never estimates). Drop the clause if the scope does not
      // resolve (a fixture tree without it) rather than emit a broken preview.
      const clause = costClause(inferred.scope, pd);
      const cost = clause ? ` - ${clause}` : "";
      emit(askDirective(
        `This looks like "${inferred.scope}" work, so I'd run the "${inferred.scope}" plan for: "${flags.intent}"${cost}. ` +
          "Say go ahead, name a different plan, or say \"compose\" and I'll tailor one to this task.",
      ));
      return;
    }
    // Anchor the compose offer with the counts for the three named scopes so the
    // user calibrates the order-of-magnitude difference before deciding. Fall
    // back to bare names if any scope does not resolve.
    const express = effectiveScopeCostSummary("express", pd);
    const classic = effectiveScopeCostSummary("classic", pd);
    const feat = effectiveScopeCostSummary("feature", pd);
    const fallbackExamples = [...validScopes()].slice(0, 3).join(", ") || "an explicit scope";
    const examples = express && classic && feat
      ? `express = ${express.execute} of ${express.total} stages, classic = ${classic.execute}, feature = all ${feat.execute}`
      : fallbackExamples;
    emit(askDirective(
      `None of the ready-made plans is an obvious fit for: "${flags.intent}". ` +
        "I can work out a plan tailored to this task (recommended: reply \"compose\"), " +
        `or you can pick one directly (e.g. ${examples}; see /aidlc --help for the full list).`,
    ));
    return;
  }

  // Branch 9 — no state file. Two arms, split on whether the user EXPLICITLY
  // named a scope:
  //
  // 9a — an explicit `--scope <valid>` flag (source === "flag"; an invalid
  // flag already died at Branch 3b). Naming a scope on a fresh workspace is a
  // request to START a workflow - the same creation move as Branch 7b's
  // valid-scope positional, reached here because the flag passes Branch 3b
  // validation and no jump/init branch fired. Scaffolding is a
  // mutation, so the engine names the init move (run-then-continue print)
  // rather than performing it. A no-state `--resume` never creates: resuming
  // claims a workflow already exists, so it falls to the 9b error.
  if (!stateContent && source === "flag" && !flags.resume) {
    // Same fresh-clone guard as Branch 7b: if intents already exist in the
    // active space with no cursor set, prompt to pick one instead of creating a
    // duplicate. null → zero intents → creation as before.
    const pick = intentPickPromptIfRecordsExist(
      pd,
      flags.intent
        ? {
            description: flags.intent,
            proposedScope: scope,
          }
        : undefined,
    );
    if (pick) {
      emit(pick);
      return;
    }
    // flags.intent here is freeform feature text typed alongside an explicit
    // --scope (e.g. `/aidlc --scope feature "build the auth service"`) — thread
    // it as the created intent's description; a bare `--scope <s>` carries none.
    emit(createPrintDirective(scope, flags, pd, flags.intent));
    return;
  }
  //
  // 9b — no state and NO explicitly named scope (the resolved scope came from
  // env or the default - never a creation signal on its own). The engine cannot
  // read a position to advance from, and creating one is a mutation (init's
  // job). Emit a clear error rather than guessing — pure read. The message
  // names the two explicit moves that DO start a workflow; it must not imply
  // the user already made one (the pre-hardening wording told a user who had
  // just typed `/aidlc <scope>` to type exactly that — circular now that a
  // named scope creates).
  if (!stateContent) {
    emit(errorDirective(
      "No workflow state found (no active intent). " +
        "Start one by describing what to build (/aidlc \"build the auth service\") " +
        "or by naming a scope (/aidlc --scope <scope>).",
    ));
    return;
  }

  // A completed checkbox is historical execution state, not proof that the
  // result still matches the artifacts captured at completion. Project
  // validity before normal routing, but remain detection-only: the normal
  // directive kind still routes and carries a machine-readable advisory.
  // Untracked-only history stays in /aidlc --status because redoing work only
  // to mint a receipt is make-work. Drift and unavailable inspection stay
  // per-turn because they are actionable.
  activeStageValidityAdvisory = projectStageValidityAdvisory(pd, stateContent);

  // Branch 9c - freeform prose while a workflow is ACTIVE. Branch 8 gives
  // fresh-start prose a routing ask; mid-flow prose used to fall through to
  // Branch 10, which reads only the state file - the typed text contributed
  // NOTHING and the engine silently answered "advance the current stage".
  // That silent discard made the conductor's continue-vs-new-work judgment
  // skippable, and live conductors that skipped it poured new-work prose into
  // the active intent's stage. Detection is mechanical (prose arrived, no
  // routing flag, a workflow is active), so the engine surfaces the question
  // and stops - the classification stays with the human, the same split as
  // every other ask. Explicit forms are untouched: --scope'd prose, positional
  // scopes, jumps, compose, --new-intent, and --single returned in earlier
  // branches; --resume is excluded here and continues the current workflow.
  if (flags.intent && !flags.scope && !flags.positionalScope && !flags.resume) {
    const activeLabel =
      (getField(stateContent, "Project") ?? "").trim() ||
      (getField(stateContent, "Current Stage") ?? "").trim() ||
      "the active workflow";
    // Name the scope a confirmed new intent would get (the same pure
    // inference Branch 8 uses) so the single ask carries everything the offer
    // needs: active work, the new text, the proposed scope, and a "Yes"-led
    // affirmative. Once emitted, this question is the sole route authority.
    // inferScopeFromText always returns a deterministic scope, including its
    // selection-aware fallback for rich prose.
    const inferred = inferScopeFromText(flags.intent);
    emit(newWorkRoutingAskDirective(
      `Work is already in progress on: "${activeLabel}". You said: "${flags.intent}". ` +
        `Is this (1) part of that work - continue it; (2) a separate new piece of work - ` +
        `Yes, set it up alongside the current one as "${inferred.scope}" work without changing it; ` +
        "or (3) a change to how the remaining plan is shaped?",
      `**New work routing** — Work is already in progress on: "${activeLabel}". You said: "${flags.intent}". What should I do?\n\n` +
        "1. **Part of the active work** — Continue the current workflow\n" +
        `2. **Separate new piece of work** — Yes, set it up alongside the current one as "${inferred.scope}" work without changing it\n` +
        "3. **Reshape the active work** — Change how the remaining plan is shaped\n" +
        "4. **Other** — describe what you want instead\n\n" +
        "Reply with a number (or just tell me).",
      flags.intent,
      inferred.scope,
    ));
    return;
  }

  if (
    stateContent &&
    isTeamUnitOwnership(stateContent)
  ) {
    if (unitScope) {
      try {
        validateLiveUnitScope(pd, unitScope.unit);
      } catch (e) {
        emit(errorDirective(errorMessage(e)));
        return;
      }
    } else {
      try {
        const participant = existsSync(unitParticipantPath(pd));
        const mergeTransactions = unitMergeTransactions(pd);
        if (
          !participant &&
          !hasAnyUnitClaimRefs(pd) &&
          mergeTransactions.length === 0
        ) {
          // Exact claim-less team mode remains the increment-1 single-checkout
          // walk: no registry access and no fan-out directive.
          throw new Error("claimless-team-mode");
        }
        const readOnlyBoard =
          process.env.AIDLC_STOP_HOOK_PROBE === "1" ||
          process.env.AIDLC_ROUTE_CHECK === "1";
        const overview = cachedUnitClaimOverview(pd, {
          writeCache: !readOnlyBoard,
        });
        if (participant && overview.claimable.length > 0) {
          emit(unitClaimAskDirective(overview));
          return;
        }
        const board = buildTeamConstructionBoard(pd, stateContent, {
          readOnly: readOnlyBoard,
          overview,
        });
        if (board.fanoutActive) {
          emit(noticeDirective(
            renderTeamConstructionBoard(board, "dispatcher"),
          ));
          return;
        }
      } catch (e) {
        if (errorMessage(e) === "claimless-team-mode" || !existsSync(join(pd, ".git"))) {
          // Non-git deterministic fixtures and exact claim-less increment-1
          // projects retain the existing single-checkout team walk.
        } else {
          emit(noticeDirective(
            `Team Construction dispatcher could not compose its local board: ${errorMessage(e)} ` +
              "Refusing to route Unit work until the local state, DAG, claims, and merge journals are consistent.",
          ));
          return;
        }
      }
    }
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
  // awaiting-approval / revising), the next move is normally to run THAT stage
  // — the workflow has not yet completed it. A plan-SKIP mismatch is recovered
  // below instead. If it is already completed or skipped, walk to the next
  // EXECUTE stage for the scope (state-override aware).
  const currentIsInFlight =
    currentState === "pending" ||
    currentState === "in-progress" ||
    currentState === "awaiting-approval" ||
    currentState === "revising" ||
    currentState === undefined; // no checkbox row → treat as the active stage

  // A stale/corrupt cursor can still point at an in-flight row whose approved
  // plan suffix is SKIP. Never turn that mismatch into permission to run the
  // stage, regardless of the graph's ALWAYS|CONDITIONAL applicability axis.
  // `next` stays read-only: name the report-owned recovery transition, which
  // records the skip and routes to the next effective EXECUTE stage.
  if (
    currentIsInFlight &&
    effectivePlanAction(currentSlug, scope, stateContent) === "SKIP"
  ) {
    const currentNode = nodeForSlug(currentSlug);
    if (
      isTeamUnitOwnership(stateContent) &&
      currentNode?.phase === "construction" &&
      isPerUnit(currentNode)
    ) {
      emit(errorDirective(
        `Unit Ownership: team cannot route current stage "${currentSlug}": it is not in the active unskipped per-unit Construction block.`,
      ));
      return;
    }
    if (currentState !== "in-progress" && currentState !== "revising") {
      emit(errorDirective(
        `Stage "${currentSlug}" is SKIP in the approved workflow plan but its active cursor state is ` +
          `"${currentState ?? "missing"}". Refusing to emit run-stage; repair the inconsistent state before continuing.`,
      ));
      return;
    }
    const reason = "stage is SKIP in the approved workflow plan";
    emit(printDirective(
      `Stage "${currentSlug}" is SKIP in the approved workflow plan but is still the active cursor. ` +
        `Do not run this stage. Run \`bun ${harnessDir()}/tools/aidlc-orchestrate.ts report ` +
        `--stage ${shellArg(currentSlug)} --result skipped --reason ${shellArg(reason)}\` ` +
        "to recover the stale pointer, then re-run `next` to continue.",
    ));
    return;
  }

  if (currentIsInFlight) {
    // Under an autonomy grant, an eligible per-unit build stage fans out as a
    // swarm batch instead of a single run-stage. tryEmitSwarm advances the swarm
    // one batch per `next` (the first batch with an unconverged unit, then the
    // stage's settle gate once every batch has converged) and returns true only
    // when all trigger conditions hold; otherwise emitForSlug fires, which itself
    // drives the engine's per-unit for_each loop for a per-unit Construction stage
    // (one unit per `next`, gate suppressed on every uncovered unit with the real
    // gate only on the all-covered re-entry; issue #368) and emits a single
    // directive for every other stage.
    if (!tryEmitSwarm(currentSlug, scope, stateContent, pd, projectType, recordPrefix, codekbCtx)) {
      emitForSlug(currentSlug, projectType, scope, stateContent, recordPrefix, codekbCtx, pd);
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
      reason: `Workflow complete — no in-scope stage remains after ${currentSlug} (scope: ${scope}).${NEW_WORK_HINT}`,
      // The genuine end of the work. The other `done` emissions in this file are
      // loop bookkeeping (a report landed, a read-only command already ran) and
      // stay silent: the user did not ask about the round-trip.
      narration: "That is everything on the plan. Your work is finished and written up.",
    });
    return;
  }
  // Same swarm guard on the advance path: an eligible per-unit build stage
  // under autonomy fans out as a batch rather than a single run-stage. Off the
  // swarm path, emitForSlug drives the engine's per-unit for_each loop for a
  // per-unit Construction stage (issue #368) and emits a single directive
  // otherwise.
  if (!tryEmitSwarm(next.slug, scope, stateContent, pd, projectType, recordPrefix, codekbCtx)) {
    emitForSlug(next.slug, projectType, scope, stateContent, recordPrefix, codekbCtx, pd);
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

// Resolve the eligible autonomous swarm's batches, or null when any trigger
// condition is absent. Emission and report-side verification share the
// topology/state predicate below so a mode/autonomy pair cannot masquerade as
// a real swarm.
function eligibleAutonomousSwarmBatches(
  node: GraphStage,
  scope: string,
  stateContent: string | null,
  projectDir: string,
): string[][] | null {
  if (!isAutonomousSwarmCandidate(node, scope, stateContent)) return null;
  // Under unit-major iteration the WALK owns code-generation: each unit's
  // build is emitted inline in the walk and its coverage signal is DISK
  // (unitCovered on the main record tree). The swarm's completion signal is
  // SWARM_UNIT_CONVERGED audit rows, which walk-built units never write - an
  // autonomous swarm firing mid-walk would re-fan units the walk already
  // built. One owner and one coverage signal per stage, so unit-major
  // suppresses swarm EMISSION. Deliberately here and not in
  // isAutonomousSwarmCandidate: isSettledAutonomousSwarm must keep granting
  // the report-side approve exemption for units a PRIOR stage-major swarm
  // legitimately built in worktrees (their convergence and source-merge
  // authority remain the routing signal even though reviewed record artifacts
  // are copied back), even if the knob was flipped afterwards.
  if (readConstructionIteration(stateContent) === "unit-major") return null;
  const r = resolveBoltBatches(projectDir);
  if (r.state !== "ok" || r.batches.length === 0) return null;
  return r.batches;
}

// The topology/state half of swarm eligibility, shared by next-side fan-out and
// report-side settled-swarm verification. DAG existence and convergence are
// deliberately separate: a non-empty DAG proves work is planned, not finished.
function isAutonomousSwarmCandidate(
  node: GraphStage,
  scope: string,
  stateContent: string | null,
): boolean {
  if (node.phase !== "construction") return false;
  if (node.for_each !== SWARM_FOR_EACH || node.mode !== SWARM_MODE) return false;
  if (usesStageLevelPerUnitArtifacts(scope, stateContent)) return false;
  if (isSkeletonGateStage(node, scope)) return false;
  if (readAutonomyMode(stateContent) !== "autonomous") return false;
  return true;
}

// Report-side exemption for disk-backed approval guards. Swarm artifacts and
// collaborator contributions stay in Bolt worktrees, so the main checkout
// cannot prove them from disk. The audit ledger can: exemption is granted only
// after EVERY unit in a valid DAG has a current-run convergence row. An active,
// partially-converged swarm must refuse a stray report --approved, otherwise the
// state transition would complete the whole stage and skip later batches.
// Malformed/absent DAGs fail closed because the expected unit set is unknowable.
function isSettledAutonomousSwarm(
  node: GraphStage,
  scope: string,
  stateContent: string | null,
  projectDir: string,
  resolution?: BoltBatchesResolution,
): boolean {
  if (!isAutonomousSwarmCandidate(node, scope, stateContent)) return false;
  const r = resolution ?? resolveBoltBatches(projectDir);
  if (r.state !== "ok") return false;
  const liveUnits = r.batches.flat();
  const obligations = currentSwarmAttemptObligations(projectDir, node.slug);
  if (obligations.state === "invalid") return false;
  if (
    obligations.state === "ready" &&
    (liveUnits.length !== obligations.units.size ||
      liveUnits.some((unit) => !obligations.units.has(unit)))
  ) {
    return false;
  }
  const units =
    obligations.state === "ready" ? [...obligations.units] : liveUnits;
  if (units.length === 0) return false;
  const converged = swarmConvergedUnits(projectDir, node.slug);
  return units.every((unit) => converged.has(unit));
}

function applySettledSwarmShape(
  directive: RunStageDirective,
): RunStageDirective {
  delete directive.reviewer;
  delete directive.review_artifact;
  delete directive.review_class;
  delete directive.reviewer_max_iterations;
  directive.protocol_modules = ["construction", "swarm"];
  directive.swarm_settled = true;
  return directive;
}

// Try to handle an eligible autonomous swarm stage, returning true (and emitting)
// ONLY when every trigger condition holds:
//   - the slug resolves to a Construction stage that is the per-unit build stage
//     (for_each:unit-of-work + mode:subagent, code-generation today);
//   - the human granted autonomy at the walking-skeleton ladder
//     (Construction Autonomy Mode: autonomous);
//   - the compiled Bolt/unit DAG yields a non-empty batch.
// The swarm advances ONE Bolt BATCH per `next`: it walks the batches in
// topological order and selects the FIRST batch that still has an unconverged
// unit, emitting `{kind:"invoke-swarm", units: <that batch's unconverged units>}`
// so a batch with a partial pass (some units baton-returned) re-fans only the
// units still owed. Earlier batches are never re-emitted once every one of their
// units has converged, so the run climbs the DAG batch by batch instead of
// re-emitting batch 1 forever. The completion signal is the audit ledger
// (swarmConvergedUnits, the `SWARM_UNIT_CONVERGED` rows the referee writes back
// to the main checkout), NOT artifact presence: a swarm unit's produced files
// stay in its Bolt worktree, so the inline per-unit disk-coverage ledger never
// sees them (that is why this path owns its own signal).
//
// When EVERY unit in EVERY batch has converged, the stage is built: the engine
// emits the stage's settle directive (a run-stage for the last unit carrying the
// stage's computed gate, the SAME shape emitPerUnitRunStage's all-covered
// re-entry produces) so the conductor completes the stage and the workflow moves
// on, and returns true. It does NOT return false there: the caller's fallback
// (emitPerUnitRunStage) keys on disk coverage the swarm never lands in the main
// tree, so it would wrongly re-run unit one inline instead of settling.
//
// On any trigger miss it returns false and emits nothing, so the caller falls
// back to the normal run-stage emit (which keeps its computed gate, including the
// skeleton round-trip sentinel). The skeleton Bolt 1 is protected two ways:
// temporally (autonomy stays unset until the ladder fires after Bolt 1 ships) AND
// structurally: the isSkeletonGateStage guard below refuses to swarm the
// walking-skeleton gate stage regardless of autonomy state. The structural guard
// matters for scopes where the per-unit build stage (code-generation) IS the
// skeleton-gate stage (poc / bugfix / security-patch): there the skeleton's
// always-gated approval must never be bypassed by a stray autonomous setting, so
// the engine enforces it rather than trusting the conductor's ordering.
function tryEmitSwarm(
  slug: string,
  scope: string,
  stateContent: string | null,
  projectDir: string,
  projectType: "brownfield" | "greenfield" | null,
  recordPrefix: string | null,
  codekbCtx: CodekbCtx,
): boolean {
  const node = nodeForSlug(slug);
  if (!node) return false;
  const batches = eligibleAutonomousSwarmBatches(node, scope, stateContent, projectDir);
  if (batches === null) return false;

  // Select the first topological batch with an unconverged unit; emit only that
  // batch's still-owed units. Ledger signal = SWARM_UNIT_CONVERGED (see above),
  // floored at this stage's latest STAGE_STARTED so a jump-driven re-run never
  // reads a prior run's rows as coverage.
  const converged = swarmConvergedUnits(projectDir, slug);
  let pendingUnits: string[] | null = null;
  for (const batch of batches) {
    if (!Array.isArray(batch) || batch.length === 0) continue;
    const owed = batch.filter((u) => !converged.has(u));
    if (owed.length > 0) {
      pendingUnits = owed;
      break;
    }
  }

  // Every unit in every batch has converged (and the DAG had at least one unit):
  // the stage is fully built. Emit its settle directive, a run-stage for the
  // last unit carrying the stage's computed gate, so the conductor runs the
  // learnings ritual + single stage gate and `report --approved` advances the
  // workflow (the report-side per-unit coverage guard already exempts the
  // autonomous swarm, so the approve is not refused for the worktree-only
  // artifacts).
  if (pendingUnits === null) {
    const flatUnits = batches.flat();
    if (flatUnits.length === 0) return false;
    const lastUnit = flatUnits[flatUnits.length - 1];
    const directive = buildRunStageDirective(
      node, projectType, lastUnit, scope, stateContent, recordPrefix, codekbCtx,
    );
    directive.unit = lastUnit;
    // Gate-only resume surface: every Unit body and reviewer already converged
    // inside the swarm. Keep that fact explicit across fresh sessions and remove
    // the ordinary body/reviewer modules so settlement cannot repeat work.
    emit(applySettledSwarmShape(directive));
    return true;
  }

  // Thread the construction repo to the conductor when the engine can resolve it
  // DETERMINISTICALLY (read-only — intentRepos never throws; it returns [] for a
  // legacy/flat intent). NOT resolveConstructionRepo here: that THROWS on >1, and
  // the engine must stay non-throwing on the multi-repo path.
  //   - 0 repos (legacy / projectDir-is-the-repo): emit units UNCHANGED — no repo
  //     field. `prepare` with no --repo is today's behaviour for this case.
  //   - 1 repo: emit the lone sibling as `repo`; the conductor passes --repo.
  //   - >1 repos: emit WITHOUT a repo field. The engine cannot autonomously decide
  //     which sibling THIS batch targets — that is the conductor's knowledge call
  //     (the three-concerns tenet). The SKILL.md prose tells it to supply --repo
  //     from the intent's recorded set; `prepare` errors without it on a multi-repo
  //     intent, surfacing the choice rather than guessing.
  const repos = intentRepos(projectDir);
  // Autonomous swarm reviews are NOT subject to the scope review_cap or the
  // per-run Review Override: inside an invoke-swarm the reviewer is the ONLY
  // verification between a unit's convergence and its merge - there is no
  // downstream human gate for advisory findings to flow to, so lowering the
  // class here would remove the sole check rather than rebalance it. The
  // declared class (adversarial for every shipped construction stage) rides
  // along verbatim; review_class is emitted for observability.
  const declaredReviewClass = node.review_class ?? "adversarial";
  const reviewerFields = node.reviewer
    ? {
        stage: node.slug,
        stage_file: stageFileFor(node.phase, node.slug),
        reviewer: node.reviewer,
        review_artifact: node.review_artifact,
        review_class: declaredReviewClass,
        reviewer_max_iterations:
          declaredReviewClass === "advisory"
            ? 1
            : node.reviewer_max_iterations ?? 2,
      }
    : {};
  const protocolModules: ProtocolModule[] = [
    ...(node.reviewer ? (["reviewer"] as const) : []),
    "construction",
    "swarm",
  ];
  if (repos.length === 1) {
    const directive: Directive = {
      kind: "invoke-swarm",
      units: pendingUnits,
      ...reviewerFields,
      protocol_modules: protocolModules,
      repo: repos[0],
    };
    publicationContexts.set(directive, {
      projectDir,
      stateHash: sha256(stateContent ?? ""),
    });
    emit(directive);
  } else {
    const directive: Directive = {
      kind: "invoke-swarm",
      units: pendingUnits,
      ...reviewerFields,
      protocol_modules: protocolModules,
    };
    publicationContexts.set(directive, {
      projectDir,
      stateHash: sha256(stateContent ?? ""),
    });
    emit(directive);
  }
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
  scope: string = resolveDefaultScope(DEFAULT_SCOPE),
  stateContent: string | null = null,
  recordPrefix: string | null = null,
  codekbCtx?: CodekbCtx,
): void {
  const node = nodeForSlug(slug);
  if (!node) {
    emit({
      kind: "error",
      message: `Internal: stage "${slug}" resolved by routing but not found in the compiled graph.`,
    });
    return;
  }
  emit(buildRunStageDirective(node, projectType, UNIT_NAME_PLACEHOLDER, scope, stateContent, recordPrefix, codekbCtx));
}

// --- Per-unit iteration (issue #368): the engine drives the for_each loop ---
//
// A per-unit Construction stage (for_each: unit-of-work) runs ONCE PER Unit of
// Work, but the state file carries ONE checkbox row per stage slug (the engine
// never duplicates rows, verified). So a single checkbox cannot, on its own,
// track "stage done for 3 of 9 units". The COVERAGE LEDGER is the per-unit
// ARTIFACTS on disk: a unit is "covered" for this stage once all of the stage's
// produces[] exist under <recordPrefix>/construction/<unit>/<slug>/. The engine
// walks the ordered unit list (the compiled Bolt DAG, flattened to topo order),
// finds the FIRST uncovered unit, and emits a run-stage for THAT concrete unit,
// with the gate SUPPRESSED (false) on EVERY not-yet-covered unit. The conductor
// completes the unit's body, writes its artifacts, and re-runs `next` WITHOUT
// reporting; the single checkbox stays in-flight and the engine hands back the
// next uncovered unit. Once the LAST unit's artifacts land on disk, the next
// `next` re-enters with no uncovered units and presents the stage's real gate
// (see emitPerUnitRunStage's pick === null branch), so the human approves once
// (covering all units, only after every unit is built) and the checkbox flips.
// No unit DAG (a scope that SKIPs units-generation, or pre-compile) degrades to
// today's single {unit-name} directive, zero behaviour change.

// True when `unit` is COVERED for `node`: every APPLICABLE artifact in
// node.produces[] (the REQUIRED set) exists on disk under the resolved per-unit
// path (<recordPrefix>/construction/<unit>/<owner.slug>/<name>.md).
// node.optional_produces entries are DELIBERATELY not checked here - they are
// artifacts the unit MAY write (marked CONDITIONAL in the stage body), so their
// absence never blocks coverage. The resolved path
// is workspace-RELATIVE with forward slashes, so we re-root it absolutely under
// projectDir (splitting on "/" so the join is OS-correct).
//
// The empty-produces guard runs on the UNFILTERED required list: a stage that
// declares no required produces at all can never be proven-covered, so the
// engine never silently skips a unit it cannot prove it ran. But after that
// guard the required set is filtered by the unit's kind (produces_kinds): a
// kind to which NO required artifact applies filters to empty and is VACUOUSLY
// covered (the stage does not apply to that unit). `unitKind` null (untagged
// unit or no map) keeps the full list, so behaviour is unchanged off the kind
// path.
function unitCovered(
  projectDir: string,
  node: GraphStage,
  unit: string,
  recordPrefix: string | null,
  codekbCtx: CodekbCtx,
  unitKind: string | null,
): boolean {
  const names = node.produces ?? [];
  if (names.length === 0) return false;
  const applicable = applicableProduceNames(node, unitKind, false);
  for (const name of applicable) {
    const rel = resolveArtifactPath(name, node, unit, recordPrefix, codekbCtx);
    const abs = join(projectDir, ...rel.split("/"));
    if (!isRegularFile(abs)) return false;
  }
  return true;
}

// The per-stage unit-receipt ledger: the current attempt's UNIT_COMPLETED
// receipts plus whether the unit lifecycle has EVER been used for this stage.
// When in use, receipts become the
// completion authority and artifact existence degrades to evidence — a paused
// or partially-written unit has artifacts but no receipt and stays uncovered
// (issue: artifact presence was mistaken for completion). When NOT in use
// (a genuinely ledger-free legacy flow), coverage stays artifact-driven, so
// in-flight upgrades do not break until the stage adopts lifecycle receipts.
type UnitLedger = {
  receipts: Set<string>;
  checkpoint: ReturnType<typeof activeUnitCheckpoint>;
  inUse: boolean;
  mode: ReturnType<typeof currentUnitLifecycleMode>;
};
function unitLedgerFor(
  projectDir: string,
  slug: string,
  auditRows?: readonly AuditShardEvent[],
  stateContent?: string,
): UnitLedger {
  if (auditRows && stateContent) {
    return unitLifecycleSnapshot(projectDir, slug, auditRows, stateContent);
  }
  const receipts = unitCompletedReceipts(projectDir, slug);
  const checkpoint = activeUnitCheckpoint(projectDir, slug);
  return {
    receipts,
    checkpoint,
    inUse: unitLifecycleReceiptsInUse(projectDir, slug),
    mode: currentUnitLifecycleMode(projectDir, slug),
  };
}

function kindVacuous(node: GraphStage, unitKind: string | null): boolean {
  return (
    (node.produces ?? []).length > 0 &&
    applicableProduceNames(node, unitKind, false).length === 0
  );
}

// A unit is SETTLED when its artifacts exist AND, when the receipt ledger is
// in use, a current-attempt UNIT_COMPLETED receipt names it. Kind-vacuous
// units (required set filters to empty — the stage does not apply) never
// receive directives, so they can never earn receipts: they settle on the
// artifact rule alone, exactly as before.
function unitSettled(
  projectDir: string,
  node: GraphStage,
  unit: string,
  recordPrefix: string | null,
  codekbCtx: CodekbCtx,
  unitKind: string | null,
  ledger: UnitLedger,
): boolean {
  if (!unitCovered(projectDir, node, unit, recordPrefix, codekbCtx, unitKind)) return false;
  if (!ledger.inUse) return true;
  if (kindVacuous(node, unitKind)) {
    return true; // vacuous for this kind — no directive, no receipt to earn
  }
  return ledger.receipts.has(unit);
}

// Walk the ordered unit list and find the units that are not yet settled
// (artifacts missing, or — with the receipt ledger in use — no UNIT_COMPLETED
// receipt). Returns {unit, uncovered} where `unit` is the FIRST unsettled
// unit (the one the engine emits next) and `uncovered` is the full ordered list
// of not-yet-settled units (so the caller can name them without re-scanning the
// disk), or null when EVERY unit is already settled (the stage's per-unit work is
// complete; the caller then presents the final gate, see emitPerUnitRunStage).
// Order is the topo order from orderedUnits, so the engine produces unit
// dependencies before their dependents.
function nextUncoveredUnit(
  projectDir: string,
  node: GraphStage,
  units: string[],
  recordPrefix: string | null,
  codekbCtx: CodekbCtx,
  kinds: Map<string, string> | null,
  stateContent: string | null,
  ledger: UnitLedger,
): { unit: string; uncovered: string[] } | { error: string } | null {
  const uncovered: string[] = [];
  for (const unit of units) {
    if (
      !unitSettled(
        projectDir,
        node,
        unit,
        recordPrefix,
        codekbCtx,
        kinds?.get(unit) ?? null,
        ledger,
      )
    ) {
      uncovered.push(unit);
      continue;
    }
    // A kind-vacuous unit settles with no directive and owes no questions or
    // summary confirmation.
    if (kindVacuous(node, kinds?.get(unit) ?? null)) continue;
    const confirmation = checkSummaryConfirmationEvidence(projectDir, node, {
      stateContent,
      unit,
    });
    if (!confirmation.ok) return { error: confirmation.message };
  }
  if (uncovered.length === 0) return null;
  // An in-flight unit (UNIT_STARTED/RESUMED without a terminal receipt) routes
  // FIRST regardless of topo position: the single-active-unit invariant means
  // new work must not begin while one unit is open (a crashed session's active
  // unit is picked up before anything else).
  const active = ledger.checkpoint;
  if (active && uncovered.includes(active.unit)) {
    return { unit: active.unit, uncovered };
  }
  return { unit: uncovered[0], uncovered };
}

const WAVE_ELIGIBLE_STAGES: ReadonlySet<string> = new Set([
  "functional-design",
  "nfr-requirements",
  "nfr-design",
  "infrastructure-design",
]);

function waveEligible(node: GraphStage): boolean {
  return (
    WAVE_ELIGIBLE_STAGES.has(node.slug) &&
    node.phase === "construction" &&
    node.for_each === "unit-of-work" &&
    node.mode === "inline" &&
    node.workspace_requires !== true
  );
}

type ActiveWave =
  | { state: "active"; unit: string; wave: RunStageWave }
  | { state: "settled" }
  | { state: "error"; message: string };

function waveEntry(
  node: GraphStage,
  unit: string,
  unitKind: string | null,
  projectType: "brownfield" | "greenfield" | null,
  scope: string,
  stateContent: string | null,
  recordPrefix: string | null,
  codekbCtx: CodekbCtx,
  buildRequired: boolean,
  completionRequired: boolean,
  reviewState: RunStageWaveEntry["review_state"],
  reviewIteration: number | null,
): RunStageWaveEntry {
  const resolvedConsumes = resolveConsumes(
    node.consumes ?? [],
    node,
    projectType,
    unit,
    recordPrefix,
    codekbCtx,
    unitKind,
  );
  const { present, absent } = splitConsumesByPresence(
    resolvedConsumes,
    scope,
    codekbCtx,
    stateContent,
  );
  const entry: RunStageWaveEntry = {
    unit,
    unit_kind: unitKind,
    build_required: buildRequired,
    completion_required: completionRequired,
    review_state: reviewState,
    review_iteration: reviewIteration,
    unit_memory_path: unitMemoryPathFor(node.slug, unit, recordPrefix),
    consumes: present,
    consumes_absent: absent,
    produces: resolveProduces(
      node,
      unit,
      recordPrefix,
      codekbCtx,
      unitKind,
    ),
    required_produces: applicableProduceNames(node, unitKind, false).map(
      (name) =>
        resolveArtifactPath(
          name,
          node,
          unit,
          recordPrefix,
          codekbCtx,
        ),
    ),
  };
  return entry;
}

function attachBoundedWave(
  directive: RunStageDirective,
  wave: RunStageWave,
  codekbCtx: CodekbCtx,
): string | null {
  const entries: RunStageWaveEntry[] = [];
  for (const entry of wave.entries) {
    const candidate = {
      batch_index: wave.batch_index,
      entries: [...entries, entry],
    };
    directive.wave = candidate;
    // Leave room for the final transport's canonical rules_in_context paths
    // and JSON framing. A large batch degrades to deterministic same-batch
    // prefixes across successive next calls; it never spills into a dependent
    // batch merely to fit one directive.
    if (
      Buffer.byteLength(JSON.stringify(directive), "utf-8") >
      DIRECTIVE_MAX_BYTES - 1024
    ) {
      break;
    }
    entries.push(entry);
  }
  if (entries.length === 0) {
    delete directive.wave;
    return (
      `Cannot emit the active wave for stage "${directive.stage}" within the ` +
      `${DIRECTIVE_MAX_BYTES}-byte directive limit. Reduce the stage's path/context ` +
      "fan-out or process this workflow with a smaller unit batch."
    );
  }
  directive.wave = { batch_index: wave.batch_index, entries };
  for (const entry of entries) {
    bootstrapDirectiveMemory(entry.unit_memory_path, codekbCtx);
  }
  return null;
}

// Resolve the first unsettled Bolt-DAG batch from one healed snapshot. A batch
// stays active until each kind-applicable unit has both its required artifacts
// and a fresh terminal review receipt. This is the ordering boundary that keeps
// dependent units from consuming work whose review may still trigger revision.
function activePerUnitWave(
  projectDir: string,
  node: GraphStage,
  resolution: Extract<BoltBatchesResolution, { state: "ok" }>,
  projectType: "brownfield" | "greenfield" | null,
  scope: string,
  stateContent: string | null,
  recordPrefix: string | null,
  codekbCtx: CodekbCtx,
): ActiveWave {
  const reviewClass = node.reviewer
    ? resolveReviewClass(node.review_class ?? "adversarial", scope, stateContent)
    : "none";
  const reviewProgress = reviewClass !== "none"
    ? freshReviewReceipts(projectDir, stateContent ?? "", node, {
        boltDag: resolution,
        reviewClass,
      })
    : null;
  const ledger = unitLedgerFor(projectDir, node.slug);

  for (let batchIndex = 0; batchIndex < resolution.batches.length; batchIndex++) {
    const batch = resolution.batches[batchIndex];
    const entries: RunStageWaveEntry[] = [];
    let firstPendingIndex = -1;
    for (const unit of batch) {
      const unitKind = resolution.unitKinds?.get(unit) ?? null;
      // Match unitCovered and the approval guard: a kind with no applicable
      // required produce is vacuously covered and owes neither work nor review.
      if (applicableProduceNames(node, unitKind, false).length === 0) continue;

      const covered = unitCovered(
        projectDir,
        node,
        unit,
        recordPrefix,
        codekbCtx,
        unitKind,
      );
      if (covered) {
        const confirmation = checkSummaryConfirmationEvidence(projectDir, node, {
          stateContent,
          unit,
        });
        if (!confirmation.ok) return { state: "error", message: confirmation.message };
      }
      const terminalVerdict = reviewProgress?.unitVerdicts.get(unit);
      const pendingReview = reviewProgress?.unitPending.get(unit);
      const staleReview = reviewProgress?.unitStaleProgress.get(unit);
      const reviewState: RunStageWaveEntry["review_state"] = reviewClass === "none"
        ? "not-required"
        : terminalVerdict ??
          pendingReview?.state ??
          (staleReview
            ? staleReview.recoverySpent
              ? "escalation-required"
              : "recovery-required"
            : "outstanding");
      const reviewIteration = reviewClass === "none"
        ? null
        : terminalVerdict
          ? (reviewProgress?.unitIterations.get(unit) ?? null)
          : (pendingReview?.iteration ?? staleReview?.nextIteration ?? 1);
      const buildRequired = !covered;
      // Wave entries always settle through an explicit `unit complete --wave`
      // receipt. This is the parallel counterpart to the serial start/complete
      // lifecycle: the completion tool verifies this exact entry, fans its
      // memory into the parent diary, then emits UNIT_COMPLETED atomically.
      const completionRequired = !ledger.receipts.has(unit);
      if (
        buildRequired ||
        completionRequired ||
        reviewState === "outstanding" ||
        reviewState === "retry-required" ||
        reviewState === "repair-required" ||
        reviewState === "recovery-required" ||
        reviewState === "escalation-required"
      ) {
        entries.push(
          waveEntry(
            node,
            unit,
            unitKind,
            projectType,
            scope,
            stateContent,
            recordPrefix,
            codekbCtx,
            buildRequired,
            completionRequired,
            reviewState,
            reviewIteration,
          ),
        );
        if (firstPendingIndex === -1) {
          firstPendingIndex = entries.length - 1;
        }
      }
    }
    if (firstPendingIndex !== -1) {
      // Put the active unit first so the size-bounded prefix always contains
      // the parent directive's unit, then retain deterministic batch order.
      const ordered = [
        ...entries.slice(firstPendingIndex),
        ...entries.slice(0, firstPendingIndex),
      ];
      return {
        state: "active",
        unit: ordered[0].unit,
        wave: { batch_index: batchIndex, entries: ordered },
      };
    }
  }
  return { state: "settled" };
}

// Emit ONE iteration of a per-unit Construction stage. The engine owns the
// for_each loop here: it resolves the next uncovered unit, substitutes the real
// unit name for {unit-name} in every path, and suppresses the gate for EVERY
// not-yet-covered unit. The stage's real gate is presented exactly once, on the
// all-covered re-entry (pick === null), after the last unit's artifacts exist on
// disk. See the ledger note above emitRunStageForSlug's per-unit section.
function emitPerUnitRunStage(
  node: GraphStage,
  projectType: "brownfield" | "greenfield" | null,
  scope: string,
  stateContent: string | null,
  recordPrefix: string | null,
  codekbCtx: CodekbCtx,
  projectDir: string,
  resolution?: BoltBatchesResolution,
  allowWave = true,
): void {
  if (usesStageLevelPerUnitArtifacts(scope, stateContent)) {
    const directive = buildRunStageDirective(
      node,
      projectType,
      null,
      scope,
      stateContent,
      recordPrefix,
      codekbCtx,
    );
    directive.gate = true;
    emit(directive);
    return;
  }

  const r = resolution ?? resolveBoltBatches(projectDir);

  // GATE precedence: never iterate per-unit until the walking-skeleton gate is
  // RESOLVED when a real Unit DAG exists. If this is the skeleton-gate stage,
  // the DAG is present, and no stance is recorded yet,
  // buildRunStageDirective would emit gate:"unresolved" (the classify
  // round-trip). The conductor must classify the stance FIRST, there is no
  // per-unit work to do while the gate is undetermined, so emit the normal
  // single directive (with the {unit-name} placeholder + the unresolved gate)
  // and return. The follow-up `next` (after `report --skeleton-stance`) resolves
  // the gate and re-enters here to begin per-unit iteration.
  if (
    isSkeletonGateStage(node, scope) &&
    readSkeletonStance(stateContent) === null
  ) {
    emitRunStageForSlug(node.slug, projectType, scope, stateContent, recordPrefix, codekbCtx);
    return;
  }

  switch (r.state) {
    case "none":
      emitRunStageForSlug(
        node.slug,
        projectType,
        scope,
        stateContent,
        recordPrefix,
        codekbCtx,
      );
      return;
    case "malformed":
      emit({
        kind: "error",
        message:
          `Cannot iterate units for stage "${node.slug}": inception/units-generation/unit-of-work-dependency.md is authoritative for the unit set and is ${r.reason} (${r.detail}). Fix the fenced units block in that artifact, then run next again.`,
      });
      return;
    case "ok":
      break;
  }
  const units = r.batches.flat();
  const kinds = r.unitKinds;
  const ledger = unitLedgerFor(projectDir, node.slug);

  // The serial lifecycle owns any existing active/paused checkpoint. A fresh
  // wave has no single active Unit; every entry settles with `complete --wave`.
  if (ledger.checkpoint?.state === "paused") {
    const cp = ledger.checkpoint;
    emit(askDirective(
      `Unit "${cp.unit}" of stage "${node.slug}" is PAUSED (unit_state: paused)` +
        `${cp.reason ? ` — reason: ${cp.reason}` : ""}.` +
        `${cp.nextAction ? ` Recorded next action: ${cp.nextAction}.` : ""} ` +
        `Do not start other work. Resume this unit (bun ${harnessDir()}/tools/aidlc-state.ts unit resume ` +
        `--stage ${node.slug} --unit ${cp.unit}) and continue from the recorded next action, or ask ` +
        "the human how to proceed. STOP until the unit is explicitly resumed.",
    ));
    return;
  }

  if (
    allowWave &&
    ledger.checkpoint === null &&
    ledger.mode !== "serial" &&
    ledger.mode !== "mixed" &&
    waveEligible(node)
  ) {
    const wave = activePerUnitWave(
      projectDir,
      node,
      r,
      projectType,
      scope,
      stateContent,
      recordPrefix,
      codekbCtx,
    );
    if (wave.state === "error") {
      emit(errorDirective(wave.message));
      return;
    }
    if (wave.state === "active") {
      const unitKind = r.unitKinds?.get(wave.unit) ?? null;
      const directive = buildRunStageDirective(
        node,
        projectType,
        wave.unit,
        scope,
        stateContent,
        recordPrefix,
        codekbCtx,
        unitKind,
      );
      directive.gate = false;
      directive.unit = wave.unit;
      const waveError = attachBoundedWave(directive, wave.wave, codekbCtx);
      if (waveError !== null) {
        emit(errorDirective(waveError));
        return;
      }
      emit(directive);
      return;
    }
    // All applicable units have settled build + review evidence. Fall through
    // to the stock settle branch below, which presents the one stage gate.
  }

  const pick = nextUncoveredUnit(
    projectDir,
    node,
    units,
    recordPrefix,
    codekbCtx,
    kinds,
    stateContent,
    ledger,
  );
  if (pick !== null && "error" in pick) {
    emit(errorDirective(pick.error));
    return;
  }
  if (pick === null) {
    // Every unit is already covered, but the checkbox is still in-flight: the
    // conductor wrote the LAST unit's artifacts and re-ran `next` to settle the
    // stage. There is nothing left to PRODUCE, so present the stage gate now (its
    // REAL computed gate) on the last unit, so the human approves once and the
    // engine advances. This is the ONLY directive on which the gate fires, so the
    // approval is reached only after every unit's artifacts exist (closing the
    // last-unit hole: no unit, not even the final one, can be skipped). It is also
    // the re-entry after a "request changes" that re-ran a unit and then
    // everything is covered again.
    const lastUnit = units[units.length - 1];
    const directive = buildRunStageDirective(
      node, projectType, lastUnit, scope, stateContent, recordPrefix, codekbCtx,
      kinds?.get(lastUnit) ?? null,
    );
    directive.unit = lastUnit;
    emit(directive);
    return;
  }
  const directive = buildRunStageDirective(
    node, projectType, pick.unit, scope, stateContent, recordPrefix, codekbCtx,
    kinds?.get(pick.unit) ?? null,
  );
  // Suppress the gate on EVERY not-yet-settled unit. A per-unit directive with an
  // unsettled unit carries gate:false: the conductor completes the body, writes
  // the unit's artifacts, and re-runs `next` (NO report-approve), so the checkbox
  // stays in-flight and the engine emits the next unsettled unit. Once the LAST
  // unit settles, the next `next` takes the pick === null branch
  // above and presents the stage's real gate, so the single human approval covers
  // the whole stage only after all units are built. We override AFTER building so
  // the rest of the directive (paths, reviewer, persona) is unchanged.
  directive.gate = false;
  directive.unit = pick.unit;
  emit(directive);
}

// The in-scope, not-yet-settled per-unit Construction stages, in GRAPH order.
// This is the unit-major walk's inner list: functional-design,
// nfr-requirements, nfr-design, infrastructure-design, code-generation (each
// `for_each: unit-of-work`), minus any this scope SKIPs or the state has
// already completed/skipped. code-generation joins the walk (no mode filter):
// graph order puts it last per unit because it requires all four design
// stages, so each unit is designed and then BUILT before the next unit begins
// - the walk owns the build and the autonomous swarm is suppressed under
// unit-major (see eligibleAutonomousSwarmBatches). Graph order is preserved by
// filtering loadGraph() in place, and graph order respects `requires_stage`
// by the compile-time edge-direction invariant (aidlc-graph.ts), so a stage's
// per-unit dependency is honoured per unit by construction. Effective action
// uses the same state-override-wins rule as nextInScopeStage (state overrides
// beat scope-mapping); completed or skipped checkboxes are dropped, the same
// fresh-clone carve-out the report guard makes.
function constructionUnitMajorBlock(
  scope: string,
  stateContent: string | null,
  includeCompleted = false,
): GraphStage[] {
  if (!stateContent) return [];
  const active = new Set(
    unitMajorConstructionStageSlugs(scope, stateContent, includeCompleted),
  );
  return loadGraph().filter((stage) => active.has(stage.slug));
}

const UNIT_PROGRESS_MARKERS: Readonly<Record<CheckboxState, string>> = {
  pending: "[ ]",
  "in-progress": "[-]",
  "awaiting-approval": "[?]",
  revising: "[R]",
  completed: "[x]",
  skipped: "[S]",
};

export interface TeamUnitProgressModel {
  section: string;
  stageStates: Record<string, CheckboxState>;
  ledgers: Map<string, UnitLedger>;
  mergedUnits: Set<string>;
}

function teamUnitStageApplies(
  stage: GraphStage,
  unitKind: string | null,
): boolean {
  const names = stage.produces ?? [];
  return names.length > 0 &&
    applicableProduceNames(stage, unitKind, false).length > 0;
}

function unitProgressOwners(stateContent: string): Map<string, string> {
  const heading = /^## Unit Progress\r?$/m.exec(stateContent);
  if (!heading) return new Map();
  const after = heading.index + heading[0].length;
  const next = /^## /m.exec(stateContent.slice(after));
  const section = stateContent.slice(
    after,
    next ? after + next.index : stateContent.length,
  );
  const owners = new Map<string, string>();
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (
      cells.length < 2 ||
      cells[0].toLowerCase() === "unit" ||
      cells.every((cell) => /^-+$/.test(cell)) ||
      cells[1] === "-"
    ) {
      continue;
    }
    owners.set(cells[0], cells[1]);
  }
  return owners;
}

function teamUnitProgressModel(
  projectDir: string,
  stateContent: string,
  units: string[],
  block: GraphStage[],
  kinds: Map<string, string> | null,
  recordPrefix: string | null,
  codekbCtx: CodekbCtx,
  rhythm: UnitGateRhythm,
  auditRows: readonly AuditShardEvent[],
  owners: ReadonlyMap<string, string>,
  mergeTracking: boolean,
  mainOwnedUnits: ReadonlySet<string>,
  mergedUnitOverrides?: ReadonlySet<string>,
): TeamUnitProgressModel {
  const ledgers = new Map(
    block.map((stage) => [
      stage.slug,
      unitLedgerFor(projectDir, stage.slug, auditRows, stateContent),
    ]),
  );
  const finalStage = block[block.length - 1];
  const mergedUnits = mergeTracking
    ? unitMergedReceipts(projectDir, auditRows)
    : new Set<string>();
  for (const unit of mergedUnitOverrides ?? []) mergedUnits.add(unit);
  if (mergeTracking) {
    const reviewReceipts = new Map(
      block.map((stage) => {
        if (!stage.reviewer) return [stage.slug, null] as const;
        const reviewClass = resolveReviewClass(
          stage.review_class ?? "adversarial",
          getField(stateContent, "Scope") ?? "",
          stateContent,
        );
        return [
          stage.slug,
          reviewClass === "none"
            ? null
            : freshReviewReceipts(projectDir, stateContent, stage, {
                reviewClass,
              }),
        ] as const;
      }),
    );
    for (const unit of mainOwnedUnits) {
      const unitKind = kinds?.get(unit) ?? null;
      const applicableStages = block.filter((stage) =>
        teamUnitStageApplies(stage, unitKind)
      );
      const settled = applicableStages.every((stage) =>
        unitSettled(
          projectDir,
          stage,
          unit,
          recordPrefix,
          codekbCtx,
          unitKind,
          ledgers.get(stage.slug) ?? unitLedgerFor(projectDir, stage.slug),
        )
      );
      const reviewed = applicableStages.every((stage) => {
        const receipts = reviewReceipts.get(stage.slug);
        return receipts === null || receipts?.unitVerdicts.get(unit) === "READY";
      });
      const gated = rhythm === "unit-end"
        ? (
          !!finalStage &&
          unitGateStatus(
            projectDir,
            finalStage.slug,
            unit,
            "unit-end",
            auditRows,
          ) === "approved"
        )
        : applicableStages.every(
          (stage) =>
            unitGateStatus(
              projectDir,
              stage.slug,
              unit,
              "per-stage",
              auditRows,
            ) === "approved",
        );
      if (settled && reviewed && gated) mergedUnits.add(unit);
    }
  }
  const rows: string[] = [];
  const stageCells = new Map<string, CheckboxState[]>(
    block.map((stage) => [stage.slug, []]),
  );

  for (const unit of units) {
    const unitKind = kinds?.get(unit) ?? null;
    const cells: string[] = [];
    let anyProgress = false;
    let allSettled = true;
    let anyAwaiting = false;
    let anyRevising = false;
    let allStageGatesApproved = true;

    for (const stage of block) {
      const applies = teamUnitStageApplies(stage, unitKind);
      const ledger = ledgers.get(stage.slug) ?? unitLedgerFor(projectDir, stage.slug);
      const settled = !applies ||
        unitSettled(
          projectDir,
          stage,
          unit,
          recordPrefix,
          codekbCtx,
          unitKind,
          ledger,
        );
      const gate = unitGateStatus(
        projectDir,
        stage.slug,
        unit,
        "per-stage",
        auditRows,
      );
      let state: CheckboxState;
      if (!applies) state = "completed";
      else if (rhythm === "per-stage" && gate === "approved") state = "completed";
      else if (rhythm === "per-stage" && gate === "revising") state = "revising";
      else if (settled && rhythm === "per-stage") state = "awaiting-approval";
      else if (settled) state = "completed";
      else if (ledger.checkpoint?.unit === unit) state = "in-progress";
      else state = "pending";

      stageCells.get(stage.slug)?.push(state);
      cells.push(UNIT_PROGRESS_MARKERS[state]);
      if (state !== "pending") anyProgress = true;
      if (!settled) allSettled = false;
      if (state === "awaiting-approval") anyAwaiting = true;
      if (state === "revising") anyRevising = true;
      if (applies && gate !== "approved") allStageGatesApproved = false;
    }

    let gateState: CheckboxState = "pending";
    if (rhythm === "per-stage") {
      if (allStageGatesApproved) gateState = "completed";
      else if (anyRevising) gateState = "revising";
      else if (anyAwaiting) gateState = "awaiting-approval";
      else if (anyProgress) gateState = "in-progress";
    } else if (finalStage) {
      const gate = unitGateStatus(
        projectDir,
        finalStage.slug,
        unit,
        "unit-end",
        auditRows,
      );
      if (gate === "approved") gateState = "completed";
      else if (gate === "revising") gateState = "revising";
      else if (gate === "awaiting-approval" || allSettled) {
        gateState = "awaiting-approval";
      } else if (anyProgress) gateState = "in-progress";
    }
    if (
      mergeTracking &&
      mainOwnedUnits.has(unit) &&
      cells.every((cell) => cell === UNIT_PROGRESS_MARKERS.completed) &&
      gateState === "completed"
    ) {
      mergedUnits.add(unit);
    }
    rows.push(
      `| ${unit} | ${owners.get(unit) ?? "-"} | ${cells.join(" | ")} | ${UNIT_PROGRESS_MARKERS[gateState]} |` +
        (mergeTracking
          ? ` ${mergedUnits.has(unit) ? "[x]" : "[ ]"} |`
          : ""),
    );
  }

  const allUnitEndApproved =
    rhythm !== "unit-end" ||
    !finalStage ||
    units.every(
      (unit) =>
        unitGateStatus(
          projectDir,
          finalStage.slug,
          unit,
          "unit-end",
          auditRows,
        ) ===
        "approved",
    );
  const stageStates: Record<string, CheckboxState> = {};
  const allMerged =
    !mergeTracking || units.every((unit) => mergedUnits.has(unit));
  for (const stage of block) {
    const cells = stageCells.get(stage.slug) ?? [];
    if (
      cells.length > 0 &&
      cells.every((state) => state === "completed") &&
      allUnitEndApproved &&
      allMerged
    ) {
      stageStates[stage.slug] = "completed";
    } else if (cells.some((state) => state !== "pending")) {
      stageStates[stage.slug] = "in-progress";
    } else {
      stageStates[stage.slug] = "pending";
    }
  }

  const headers = block.map((stage) => stage.slug);
  const section = [
    "## Unit Progress",
    "<!-- Derived, engine-owned projection; routing ignores hand edits. -->",
    `| unit | owner | ${headers.join(" | ")} | gate |` +
      (mergeTracking ? " merged |" : ""),
    `| --- | --- | ${headers.map(() => "---").join(" | ")} | --- |` +
      (mergeTracking ? " --- |" : ""),
    ...rows,
  ].join("\n");
  return { section, stageStates, ledgers, mergedUnits };
}

export function deriveTeamUnitProgressModel(
  projectDir: string,
  stateContent: string,
  auditRows?: readonly AuditShardEvent[],
  mergedUnitOverrides?: ReadonlySet<string>,
  options: {
    readOnly?: boolean;
    ownerOverrides?: ReadonlyMap<string, string>;
  } = {},
): TeamUnitProgressModel {
  if (!isTeamUnitOwnership(stateContent)) {
    throw new Error("Unit Progress derivation requires Unit Ownership: team.");
  }
  if (getField(stateContent, "Construction Iteration")?.trim() !== "unit-major") {
    throw new Error(
      "Unit Progress derivation requires Construction Iteration: unit-major.",
    );
  }
  const scope = getField(stateContent, "Scope") ?? "";
  const resolution = resolveBoltBatches(projectDir);
  if (resolution.state !== "ok" || resolution.batches.flat().length === 0) {
    throw new Error(
      "Unit Progress derivation requires a valid non-empty authoritative Unit DAG.",
    );
  }
  const block = constructionUnitMajorBlock(scope, stateContent, true);
  if (block.length === 0) {
    throw new Error(
      "Unit Progress derivation found no active unskipped per-unit Construction stages.",
    );
  }
  const orderedAuditRows = auditRows ?? readAuditShardEvents(projectDir).sort(
    (a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp < b.timestamp ? -1 : 1;
      }
      if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
      return a.pos - b.pos;
    },
  );
  const mergedReceipts = unitMergedReceipts(projectDir, orderedAuditRows);
  const transactions = unitMergeTransactions(projectDir);
  const mergeTracking =
    transactions.length > 0 ||
    mergedReceipts.size > 0 ||
    (mergedUnitOverrides?.size ?? 0) > 0;
  const owners = mergeTracking
    ? unitProgressOwners(stateContent)
    : new Map<string, string>();
  const claimedUnits = new Set<string>();
  const transactionUnits = new Set(
    transactions.map((transaction) => transaction.unit),
  );
  if (hasAnyUnitClaimRefs(projectDir)) {
    const overview = cachedUnitClaimOverview(projectDir, {
      writeCache: options.readOnly !== true,
    });
    for (const claim of overview.claimed) {
      owners.set(claim.unit, claim.owner);
      claimedUnits.add(claim.unit);
    }
    if (mergeTracking) {
      for (const [unit, claim] of overview.claims) {
        if (
          claim.status === "released" &&
          !mergedReceipts.has(unit)
        ) {
          owners.delete(unit);
        }
      }
    }
  }
  for (const [unit, owner] of options.ownerOverrides ?? []) {
    owners.set(unit, owner);
  }
  const mainOwnedUnits = new Set(
    resolution.batches
      .flat()
      .filter(
        (unit) =>
          !claimedUnits.has(unit) &&
          !transactionUnits.has(unit) &&
          !mergedReceipts.has(unit),
      ),
  );
  for (const unit of mainOwnedUnits) {
    if (owners.get(unit) !== "main") owners.delete(unit);
  }
  return teamUnitProgressModel(
    projectDir,
    stateContent,
    resolution.batches.flat(),
    block,
    resolution.unitKinds,
    relativeRecordDirForSelection(resolveWorkflowSelection(projectDir)),
    codekbCtxFor(projectDir),
    effectiveUnitGateRhythm(projectDir, stateContent),
    orderedAuditRows,
    owners,
    mergeTracking,
    mainOwnedUnits,
    mergedUnitOverrides,
  );
}

function refreshTeamUnitProgress(
  projectDir: string,
  model: TeamUnitProgressModel,
): string {
  if (
    process.env.AIDLC_ROUTE_CHECK === "1" ||
    process.env.AIDLC_STOP_HOOK_PROBE === "1"
  ) {
    return readStateFile(projectDir);
  }
  const payload = Buffer.from(
    JSON.stringify({
      section: model.section,
      stage_states: model.stageStates,
    }),
    "utf-8",
  ).toString("base64url");
  const result = spawnState(projectDir, [
    "refresh-unit-progress",
    "--payload",
    payload,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Unit Progress refresh failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return readStateFile(projectDir);
}

function emitTeamUnitMajorRunStage(
  projectType: "brownfield" | "greenfield" | null,
  scope: string,
  stateContent: string,
  recordPrefix: string | null,
  codekbCtx: CodekbCtx,
  projectDir: string,
  resolution: Extract<BoltBatchesResolution, { state: "ok" }>,
  block: GraphStage[],
): void {
  const scopeStamp = readApplicableTeamUnitScopeStamp(projectDir, stateContent);
  if (scopeStamp) {
    try {
      validateLiveUnitScope(projectDir, scopeStamp.unit);
    } catch (e) {
      emit(errorDirective(errorMessage(e)));
      return;
    }
  }
  const units = scopeStamp ? [scopeStamp.unit] : resolution.batches.flat();
  const kinds = resolution.unitKinds;
  const rhythm = effectiveUnitGateRhythm(projectDir, stateContent);
  const auditRows = readAuditShardEvents(projectDir).sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
    return a.pos - b.pos;
  });
  let model: TeamUnitProgressModel | null = null;
  let refreshedState: string;
  try {
    if (
      process.env.AIDLC_STOP_HOOK_PROBE === "1" ||
      process.env.AIDLC_ROUTE_CHECK === "1"
    ) {
      refreshedState = stateContent;
    } else {
      model = deriveTeamUnitProgressModel(projectDir, stateContent, auditRows);
      refreshedState = refreshTeamUnitProgress(projectDir, model);
    }
  } catch (e) {
    emit(errorDirective(errorMessage(e)));
    return;
  }

  const ledgers =
    model?.ledgers ??
    new Map<string, UnitLedger>(
      block.map((stage) => [
        stage.slug,
        unitLedgerFor(projectDir, stage.slug, auditRows, stateContent),
      ]),
    );
  const syncScopedStage = (stage: string, unit: string): boolean => {
    if (
      !scopeStamp ||
      process.env.AIDLC_STOP_HOOK_PROBE === "1" ||
      process.env.AIDLC_ROUTE_CHECK === "1"
    ) {
      return true;
    }
    const synced = spawnState(projectDir, [
      "sync-unit-scope-stage",
      stage,
      "--unit",
      unit,
    ]);
    if (synced.exitCode !== 0) {
      emit(errorDirective(
        `Scoped Unit stage sync failed: ${(synced.stderr || synced.stdout).trim()}`,
      ));
      return false;
    }
    refreshedState = readStateFile(projectDir);
    return true;
  };
  for (const stage of block) {
    const checkpoint = ledgers.get(stage.slug)?.checkpoint;
    if (checkpoint?.state === "paused") {
      emit(askDirective(
        `Unit "${checkpoint.unit}" of stage "${stage.slug}" is PAUSED (unit_state: paused)` +
          `${checkpoint.reason ? ` — reason: ${checkpoint.reason}` : ""}.` +
          `${checkpoint.nextAction ? ` Recorded next action: ${checkpoint.nextAction}.` : ""} ` +
          `Do not start other work. Resume this unit (bun ${harnessDir()}/tools/aidlc-state.ts unit resume ` +
          `--stage ${stage.slug} --unit ${checkpoint.unit}) and continue from the recorded next action, or ask ` +
          "the human how to proceed. STOP until the unit is explicitly resumed.",
      ));
      return;
    }
  }

  const finalStage = block[block.length - 1];
  for (const unit of units) {
    if (model?.mergedUnits.has(unit)) continue;
    const unitKind = kinds?.get(unit) ?? null;
    for (const stage of block) {
      if (!teamUnitStageApplies(stage, unitKind)) continue;
      const ledger = ledgers.get(stage.slug) ?? unitLedgerFor(projectDir, stage.slug);
      if (
        !unitSettled(
          projectDir,
          stage,
          unit,
          recordPrefix,
          codekbCtx,
          unitKind,
          ledger,
        )
      ) {
        if (!syncScopedStage(stage.slug, unit)) return;
        const directive = buildRunStageDirective(
          stage,
          projectType,
          unit,
          scope,
          refreshedState,
          recordPrefix,
          codekbCtx,
          unitKind,
        );
        directive.gate = false;
        directive.unit = unit;
        emit(directive);
        return;
      }
      const confirmation = checkSummaryConfirmationEvidence(projectDir, stage, {
        stateContent: refreshedState,
        unit,
      });
      if (!confirmation.ok) {
        emit(errorDirective(confirmation.message));
        return;
      }
      if (
        rhythm === "per-stage" &&
        unitGateStatus(
          projectDir,
          stage.slug,
          unit,
          "per-stage",
          auditRows,
        ) !== "approved"
      ) {
        if (!syncScopedStage(stage.slug, unit)) return;
        const directive = buildRunStageDirective(
          stage,
          projectType,
          unit,
          scope,
          refreshedState,
          recordPrefix,
          codekbCtx,
          unitKind,
        );
        directive.gate = true;
        directive.unit = unit;
        directive.unit_gate = "per-stage";
        emit(directive);
        return;
      }
    }
    if (
      rhythm === "unit-end" &&
      finalStage &&
      unitGateStatus(
        projectDir,
        finalStage.slug,
        unit,
        "unit-end",
        auditRows,
      ) !== "approved"
    ) {
      if (!syncScopedStage(finalStage.slug, unit)) return;
      const directive = buildRunStageDirective(
        finalStage,
        projectType,
        unit,
        scope,
        refreshedState,
        recordPrefix,
        codekbCtx,
        unitKind,
      );
      directive.gate = true;
      directive.unit = unit;
      directive.unit_gate = "unit-end";
      emit(directive);
      return;
    }
  }

  if (!finalStage) {
    emit(errorDirective("Team unit-major mode has no active per-unit Construction stages."));
    return;
  }
  if (scopeStamp) {
    emit(noticeDirective(
      `Unit "${scopeStamp.unit}" is complete and approved in this checkout. ` +
        `Commit the completed candidate and run \`aidlc unit publish ${scopeStamp.unit}\`; ` +
        "unscoped main will pin, gate, and land it.",
    ));
    return;
  }
  const next = nextInScopeStage(finalStage.slug, scope, refreshedState);
  if (!next) {
    emit({
      kind: "done",
      reason: `Team-owned per-unit Construction work is complete (scope: ${scope}).${NEW_WORK_HINT}`,
    });
    return;
  }
  emitForSlug(
    next.slug,
    projectType,
    scope,
    refreshedState,
    recordPrefix,
    codekbCtx,
    projectDir,
  );
}

// Emit ONE iteration of the UNIT-MAJOR construction walk (opt-in via the
// `Construction Iteration: unit-major` state field). Where emitPerUnitRunStage
// is stage-outer / unit-inner (all units of the current stage before the next
// stage), this is unit-outer / stage-inner: it walks the ordered unit list
// (Bolt DAG topo order) OUTER and the per-unit construction block (graph
// order: the four design stages then code-generation) INNER, emitting the
// first uncovered (stage, unit) pair with the gate suppressed. So a unit's
// four design documents are authored consecutively and the unit is BUILT
// before the next unit begins - the first working code lands after ONE unit's
// design, not after every unit's (the deferred half of the original
// unit-major increment). code-generation's stage body still hard-stops at its
// per-unit Plan Approval before generating, so a human sees each unit's
// design -> plan -> code in sequence even though the stage-level gates come
// later. The per-stage gates are UNCHANGED in count and machinery: they fire
// late, in stage order, once the whole (stage x unit) grid is covered: the
// fully-covered walk delegates to emitPerUnitRunStage for the CURRENT slug,
// whose pick === null branch presents that stage's real gate on the last
// unit. `handleApprove` then advances Current Stage to the next block stage;
// its `next` re-enters here, finds the grid still fully covered, and presents
// ITS gate, so the gates cascade at the block's end, one per human turn (the
// presence guard enforces one resolution per turn). No gate/approve/audit
// machinery changes.
function emitUnitMajorRunStage(
  node: GraphStage,
  projectType: "brownfield" | "greenfield" | null,
  scope: string,
  stateContent: string | null,
  recordPrefix: string | null,
  codekbCtx: CodekbCtx,
  projectDir: string,
): void {
  if (usesStageLevelPerUnitArtifacts(scope, stateContent)) {
    emitPerUnitRunStage(
      node,
      projectType,
      scope,
      stateContent,
      recordPrefix,
      codekbCtx,
      projectDir,
      undefined,
      false,
    );
    return;
  }

  const teamOwnership = readUnitOwnership(stateContent) === "team";
  const resolution = resolveBoltBatches(projectDir);
  if (
    teamOwnership &&
    (resolution.state !== "ok" || resolution.batches.flat().length === 0)
  ) {
    const detail =
      resolution.state === "malformed"
        ? `${resolution.reason}: ${resolution.detail}`
        : "no non-empty authoritative Unit DAG is available";
    emit(errorDirective(
      `Unit Ownership: team requires a valid non-empty authoritative Unit DAG; ${detail}.`,
    ));
    return;
  }

  // Skeleton-gate precedence, exactly as emitPerUnitRunStage: never begin the
  // walk before the walking-skeleton stance is resolved. functional-design is
  // both the first block stage and the skeleton-gate stage for
  // feature/enterprise/mvp (nfr-requirements for infra); emit the classify
  // directive and return until the stance is recorded.
  if (isSkeletonGateStage(node, scope) && readSkeletonStance(stateContent) === null) {
    emitRunStageForSlug(node.slug, projectType, scope, stateContent, recordPrefix, codekbCtx);
    return;
  }

  // Resolve the DAG and kind map once. A stale graph can heal from the
  // dependency artifact; threading this immutable result through every
  // fallback prevents repeated reads/warnings and preserves healed unit kinds.
  if (resolution.state !== "ok" || resolution.batches.flat().length === 0) {
    emitPerUnitRunStage(
      node,
      projectType,
      scope,
      stateContent,
      recordPrefix,
      codekbCtx,
      projectDir,
      resolution,
      false,
    );
    return;
  }
  const units = resolution.batches.flat();

  const block = constructionUnitMajorBlock(scope, stateContent, teamOwnership);
  // Defensive: if the current node is not itself an active block stage (e.g. it
  // was completed between the read and here, or a scope with no per-unit
  // construction block routed here), fall back to the stage-major path for
  // this slug.
  if (!block.some((n) => n.slug === node.slug)) {
    if (teamOwnership) {
      emit(errorDirective(
        `Unit Ownership: team cannot route current stage "${node.slug}": it is not in the active unskipped per-unit Construction block.`,
      ));
      return;
    }
    emitPerUnitRunStage(
      node,
      projectType,
      scope,
      stateContent,
      recordPrefix,
      codekbCtx,
      projectDir,
      resolution,
      false,
    );
    return;
  }

  if (teamOwnership && stateContent) {
    emitTeamUnitMajorRunStage(
      projectType,
      scope,
      stateContent,
      recordPrefix,
      codekbCtx,
      projectDir,
      resolution,
      block,
    );
    return;
  }

  // Walk units OUTER (Bolt DAG topo order: dependencies before dependents),
  // block stages INNER (graph order, dependency-safe per unit by the compile
  // invariant). Emit the first unsettled (stage, unit) pair with the gate
  // suppressed, using the same post-build override pattern as
  // emitPerUnitRunStage (the conductor acts on directive.stage + directive.unit,
  // not on Current Stage, so an interleaved slug needs no protocol change).
  // Kinds read ONCE (the single-read pattern): coverage must see the same
  // kind-pruned artifact set the directive names, or a pruned unit never covers.
  // Ledgers read per block stage (each stage keeps its own receipt set); the
  // paused-unit hard stop mirrors emitPerUnitRunStage — a pause on ANY block
  // stage halts the walk before new (stage, unit) work.
  const kinds = resolution.unitKinds;
  const ledgers = new Map<string, UnitLedger>(
    block.map((k) => [k.slug, unitLedgerFor(projectDir, k.slug)]),
  );
  for (const k of block) {
    const cp = ledgers.get(k.slug)?.checkpoint;
    if (cp?.state === "paused") {
      emit(askDirective(
        `Unit "${cp.unit}" of stage "${k.slug}" is PAUSED (unit_state: paused)` +
          `${cp.reason ? ` — reason: ${cp.reason}` : ""}.` +
          `${cp.nextAction ? ` Recorded next action: ${cp.nextAction}.` : ""} ` +
          `Do not start other work. Resume this unit (bun ${harnessDir()}/tools/aidlc-state.ts unit resume ` +
          `--stage ${k.slug} --unit ${cp.unit}) and continue from the recorded next action, or ask ` +
          "the human how to proceed. STOP until the unit is explicitly resumed.",
      ));
      return;
    }
  }
  for (const u of units) {
    for (const k of block) {
      const ledger = ledgers.get(k.slug) ?? unitLedgerFor(projectDir, k.slug);
      if (!unitSettled(projectDir, k, u, recordPrefix, codekbCtx, kinds?.get(u) ?? null, ledger)) {
        const directive = buildRunStageDirective(
          k, projectType, u, scope, stateContent, recordPrefix, codekbCtx,
          kinds?.get(u) ?? null,
        );
        directive.gate = false;
        directive.unit = u;
        emit(directive);
        return;
      }
      if (kindVacuous(k, kinds?.get(u) ?? null)) continue;
      const confirmation = checkSummaryConfirmationEvidence(projectDir, k, {
        stateContent,
        unit: u,
      });
      if (!confirmation.ok) {
        emit(errorDirective(confirmation.message));
        return;
      }
    }
  }

  // The whole (stage x unit) grid is covered: delegate to the stage-major path
  // for the CURRENT slug, whose pick === null branch presents that stage's real
  // gate on the last unit. The per-stage gate cascade of the block then runs on
  // stock machinery.
  emitPerUnitRunStage(
    node,
    projectType,
    scope,
    stateContent,
    recordPrefix,
    codekbCtx,
    projectDir,
    resolution,
    false,
  );
}

// Route a slug to its emit path: a per-unit Construction stage drives the
// engine's for_each loop (emitPerUnitRunStage); every other stage emits the
// single {unit-name}-or-non-per-unit directive (emitRunStageForSlug). Called
// from BOTH handleNext sites AFTER tryEmitSwarm has returned false, so
// autonomous code-gen still swarms and only the non-swarm path reaches here.
function emitForSlug(
  slug: string,
  projectType: "brownfield" | "greenfield" | null,
  scope: string,
  stateContent: string | null,
  recordPrefix: string | null,
  codekbCtx: CodekbCtx,
  projectDir: string,
): void {
  const node = nodeForSlug(slug);
  if (node && isPerUnit(node)) {
    // Unit-major iteration (opt-in) covers EVERY per-unit Construction stage,
    // code-generation included (the swarm never fires under unit-major - see
    // eligibleAutonomousSwarmBatches - so this branch owns the build too).
    if (readConstructionIteration(stateContent) === "unit-major") {
      emitUnitMajorRunStage(node, projectType, scope, stateContent, recordPrefix, codekbCtx, projectDir);
      return;
    }
    emitPerUnitRunStage(node, projectType, scope, stateContent, recordPrefix, codekbCtx, projectDir);
    return;
  }
  emitRunStageForSlug(slug, projectType, scope, stateContent, recordPrefix, codekbCtx);
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
// directive stream is identical regardless of entry point). The emitted
// `single:true` marker gives the conductor a typed branch before ordinary gate
// handling; isolated runs have no main-workflow approval lifecycle.
const SINGLE_INIT_ERROR =
  "Cannot run an initialization stage with --single. Initialization is bootstrap (it creates the intent + state); it runs automatically when you start a workflow (describe what to build, e.g. /aidlc \"build the auth service\").";

function ensureSingleStageStarted(
  projectDir: string,
  node: GraphStage,
): string | null {
  if (singleStageAttemptIsOpen(projectDir, node.slug)) return null;
  return appendSingleStageAuditEvents(projectDir, [{
    eventType: "STAGE_STARTED",
    fields: {
      Stage: node.slug,
      Agent: node.lead_agent,
      Workflow: syntheticWorkflowId(node.slug),
    },
  }]);
}

function emitSingleRunStage(
  slug: string,
  scope: string,
  projectType: "brownfield" | "greenfield" | null,
  recordPrefix: string | null = null,
  codekbCtx: CodekbCtx,
  projectDir: string,
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
  const startError = ensureSingleStageStarted(projectDir, node);
  if (startError) {
    emit(errorDirective(
      `Failed to record the isolated start boundary for "${node.slug}": ${startError}`,
    ));
    return;
  }
  // Build the directive only after the synthetic start is durable. Steering
  // continuation tokens bind the current audit/state route; writing the start
  // after token construction would make the engine invalidate its own first
  // continuation as stale.
  const directive = buildRunStageDirective(
    node,
    projectType,
    UNIT_NAME_PLACEHOLDER,
    scope,
    null,
    recordPrefix,
    codekbCtx,
    null,
    true, // forcePersona: the single run's first (and only) directive
    true, // singleRun: resume only from isolated pipeline receipts
  );
  directive.single = true;
  directive.gate = false;
  directive.next_stage = null;
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
  "Cannot jump to initialization stages. The Initialization phase runs automatically when you start a workflow (describe what to build, e.g. /aidlc \"build the auth service\").";

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

  const hasState = existsSync(engineStateFilePath(projectDir));

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
    // right stages, emits STAGE_JUMPED, and pivots Current Stage. After the
    // conductor runs it, the NEXT `next` sees the pivoted state and emits the
    // run-stage for the now-current target.
    emit(printDirective(
      `Run \`bun ${harnessDir()}/tools/aidlc-jump.ts execute --target ${targetSlug} --direction ${direction} --scope ${scope}\` to perform the jump, then re-run \`next\` to continue from the jump target.`,
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
    // both correct, this is a degenerate "start here" before init). recordPrefix
    // resolves the active intent's relative dir (null on a fresh workspace). The
    // codekb ctx is computed from the same live projectDir (no handleNext-cached
    // value reaches this inline site), so a codekb stage jumped-to here still
    // resolves under aidlc/spaces/<space>/codekb/<repo>/.
    emitRunStageForSlug(first.slug, projectType, scope, null, engineRelativeRecordDir(projectDir), codekbCtxFor(projectDir));
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
  // codekb ctx computed off the same live projectDir as the inline recordPrefix
  // (same rationale as the --phase inline site above).
  emit(buildRunStageDirective(node, projectType, UNIT_NAME_PLACEHOLDER, scope, null, engineRelativeRecordDir(projectDir), codekbCtxFor(projectDir)));
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
const FORWARD_RESULTS = new Set(["approved", "completed", "complete", "done"]);
const GATE_RESULTS = new Set(["awaiting-approval", "rejected", "revised"]);
const RESUME_RESULTS = new Set(["resume", "resumed"]);
const SKIP_RESULT = "skipped";
const REPORT_RESULTS = new Set([
  ...FORWARD_RESULTS,
  ...GATE_RESULTS,
  ...RESUME_RESULTS,
  SKIP_RESULT,
]);

function isConcreteIsoInstant(value: string | null): boolean {
  if (!value) return false;
  const isoInstant =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  return isoInstant.test(value) && !Number.isNaN(Date.parse(value));
}

// Promotion owns a two-part receipt: the concrete state timestamp and a
// PRACTICES_AFFIRMED audit row in the current stage attempt AND after the
// stage's latest rejection/revision boundary. The timestamp alone is stale
// across a backward jump/re-run, and a receipt minted before a GATE_REJECTED
// authorizes drafts the human then revised — those revisions were never
// promoted. Order the relevant event classes together so same-second rows
// preserve append order, then require affirmation after the floor.
function hasFreshPracticesAffirmationReceipt(
  projectDir: string,
  stateContent: string,
): boolean {
  const affirmedTimestamp = getField(
    stateContent,
    "Practices Affirmed Timestamp",
  );
  if (!isConcreteIsoInstant(affirmedTimestamp)) return false;
  const audit = readAllAuditShards(projectDir);
  if (!audit) return false;
  const FLOOR_EVENTS = new Set([
    "STAGE_STARTED",
    "GATE_REJECTED",
    "STAGE_REVISING",
  ]);
  const events = audit
    .replace(/\r\n/g, "\n")
    .split(/\n---\n/)
    .map((block, position) => ({
      block,
      position,
      event: auditBlockField(block, "Event"),
      timestamp: auditBlockField(block, "Timestamp") ?? "",
      timestampMs: Date.parse(auditBlockField(block, "Timestamp") ?? ""),
    }))
    .filter(({ event }) =>
      (event !== null && FLOOR_EVENTS.has(event)) ||
      event === "PRACTICES_AFFIRMED"
    )
    .sort((a, b) => {
      if (a.timestampMs !== b.timestampMs) {
        return a.timestampMs - b.timestampMs;
      }
      return a.position - b.position;
    });

  let floor = -1;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.event === null || !FLOOR_EVENTS.has(event.event)) continue;
    if (auditBlockField(event.block, "Stage") !== "practices-discovery") {
      continue;
    }
    if (
      event.event === "STAGE_STARTED" &&
      auditBlockField(event.block, "Workflow")?.startsWith("single-stage:")
    ) {
      continue;
    }
    floor = i;
  }
  return floor >= 0 &&
    events
      .slice(floor + 1)
      .some((event) =>
        event.event === "PRACTICES_AFFIRMED" &&
        event.timestamp === affirmedTimestamp
      );
}

interface ReportFlags {
  result?: string;
  userInput?: string;
  reason?: string;
  rejectFindings?: string[];
  skeletonStance?: string; // the classify round-trip's classified stance
  single?: boolean; // --single: complete the synthetic attempt opened by next --single, never the main pointer
  stage?: string; // --stage <slug>: the acted stage (required under --single; preferred for main workflow reports)
  overrideBlockingSensors?: boolean;
  unit?: string; // --unit <name>: required for team-owned per-unit gates
}

// Extract report's flags. --result is the verdict; --user-input carries the
// exact offered choice, while --reason carries rejection feedback or an early
// completion reason.
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
    } else if (a === "--reject-finding" && i + 1 < args.length) {
      flags.rejectFindings ??= [];
      flags.rejectFindings.push(args[i + 1]);
      i++;
    } else if (a === "--skeleton-stance" && i + 1 < args.length) {
      flags.skeletonStance = args[i + 1];
      i++;
    } else if (a === "--stage" && i + 1 < args.length) {
      flags.stage = args[i + 1];
      i++;
    } else if (a === "--unit" && i + 1 < args.length) {
      flags.unit = args[i + 1];
      i++;
    } else if (a === "--single") {
      flags.single = true;
    } else if (a === "--override-blocking-sensors") {
      flags.overrideBlockingSensors = true;
    }
  }
  return flags;
}

// Run an aidlc-state.ts subcommand through the sibling source tool or the
// compiled dispatcher's `state` noun. Returns the child's exitCode + captured
// streams; a non-zero exitCode means aidlc-state.ts rejected the transition via
// error() and the engine surfaces that as an error directive.
function spawnState(
  projectDir: string,
  subArgs: string[],
): { exitCode: number; stdout: string; stderr: string } {
  const command = IS_COMPILED
    ? [process.execPath, "state", ...subArgs, "--project-dir", projectDir]
    : [
        process.execPath,
        fileURLToPath(new URL("./aidlc-state.ts", import.meta.url)),
        ...subArgs,
        "--project-dir",
        projectDir,
      ];
  const result = Bun.spawnSync({
    cmd: command,
    env: engineChildEnv({
      AIDLC_STATE_TRANSITION_OWNER: `orchestrate:${process.pid}`,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

// The synthetic single-stage owner uses the internal append route because
// STAGE_STARTED/STAGE_COMPLETED are protected lifecycle events.
// appendAuditEntries validates the requested boundary before touching disk and
// writes it under one lock. This remains audit-only and cannot mutate the main
// pointer.
function appendSingleStageAuditEvents(
  projectDir: string,
  entries: Array<{ eventType: string; fields: Record<string, string> }>,
): string | null {
  try {
    appendAuditEntries(entries, projectDir);
    return null;
  } catch (error) {
    return errorMessage(error);
  }
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
      "No active intent workflow state found (aidlc-state.md is absent) — nothing to record a skeleton stance for.",
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
// STAGE_STARTED/STAGE_COMPLETED boundaries in `audit.md` as belonging to an
// isolated single-stage run, never to the main workflow. The `<slug>` segment
// makes the provenance legible in the audit trail.
function syntheticWorkflowId(slug: string): string {
  return `single-stage:${slug}`;
}

type EnsembleEvidenceResult =
  | { ok: true }
  | { ok: false; message: string };

function checkSingleCodekbArtifacts(
  node: GraphStage,
  pd: string,
): EnsembleEvidenceResult {
  if (!KNOWN_CODEKB_STAGES.has(node.slug)) return { ok: true };
  const inspection = inspectRequiredArtifactInstances(pd, node);
  if (inspection.ok) return { ok: true };
  return {
    ok: false,
    message:
      `Stage "${node.slug}" cannot complete its isolated run: required CodeKB artifacts ` +
      `are missing, redirected, unreadable, or not regular files (${inspection.failures.map((failure) => failure.path).join(", ")}). ` +
      "Restore the canonical artifact set or rescan before reporting completion.",
  };
}

function requiresEnsembleEvidence(node: GraphStage): boolean {
  return node.mode === "mob" ||
    (node.mode === "subagent" && (node.support_agents ?? []).length > 0);
}

// Validate the structural completion evidence required by mob and
// subagent-with-supports stages. Per-unit stages carry one contribution set
// under every unit's stage directory; ordinary stages carry one set under the
// stage directory.
function checkEnsembleEvidence(
  node: GraphStage,
  slug: string,
  pd: string,
  recordPrefix: string | null,
  options: {
    singleRun?: boolean;
    settledSwarm?: boolean;
    stageLevelPerUnit?: boolean;
    boltBatches?: BoltBatchesResolution;
    unitKinds?: Map<string, string> | null;
  } = {},
): EnsembleEvidenceResult {
  const isGated = node.phase !== "initialization";
  if (
    !isGated ||
    !requiresEnsembleEvidence(node) ||
    options.settledSwarm === true ||
    process.env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE === "1"
  ) {
    return { ok: true };
  }

  const prefix = recordPrefix ?? relativeSpaceRecordPrefix();
  // A --single run executes ONE iteration outside the main workflow: its
  // directive never names a real unit (emitSingleRunStage emits the
  // {unit-name} placeholder with stateContent null), so demanding the MAIN
  // DAG's per-unit contribution sets would make a per-unit single stage
  // unapprovable. Evidence for a single run is checked at the stage level.
  const perUnit =
    !options.singleRun &&
    !options.stageLevelPerUnit &&
    isPerUnit(node);
  const resolution = perUnit
    ? (options.boltBatches ?? resolveBoltBatches(pd))
    : null;
  const units = resolution?.state === "ok" ? resolution.batches.flat() : [];
  const usesUnitDirs = units.length > 0;
  const kinds = usesUnitDirs
    ? (
        options.unitKinds === undefined
          ? (resolution?.state === "ok" ? resolution.unitKinds : null)
          : options.unitKinds
      )
    : null;
  const requiredProduces = node.produces ?? [];
  // Match the per-unit coverage ledger: a kind-pruned unit with zero
  // applicable required artifacts is vacuously covered, so no directive ever
  // dispatches its collaborators and it cannot owe contribution files.
  const evidenceUnits = units.filter((unit) =>
    requiredProduces.length === 0 ||
    applicableProduceNames(node, kinds?.get(unit) ?? null, false).length > 0
  );
  const contributionDirs: Array<{ path: string; unit: string | null }> = usesUnitDirs
    ? evidenceUnits.map((unit) => ({
        path: join(pd, prefix, "construction", unit, slug, "contributions"),
        unit,
      }))
    : [{
        path: join(pd, prefix, node.phase, slug, "contributions"),
        unit: null,
      }];
  const missing: string[] = [];
  for (const { path, unit } of contributionDirs) {
    for (const agent of node.support_agents ?? []) {
      const f = join(path, `${agent}.md`);
      const subject = unit === null ? agent : `${agent} for unit "${unit}"`;
      let firstLine = "";
      try {
        firstLine = readFileSync(f, "utf-8").split("\n", 1)[0].trim();
      } catch {
        missing.push(`${subject} (no contribution file)`);
        continue;
      }
      if (firstLine !== `**Collaborator:** ${agent}`) {
        missing.push(`${subject} (missing identity-marker first line)`);
      }
    }
  }
  if (missing.length === 0) return { ok: true };

  const contributionPath = usesUnitDirs
    ? `${prefix}/construction/<unit>/${slug}/contributions/<agent-slug>.md`
    : `${prefix}/${node.phase}/${slug}/contributions/<agent-slug>.md`;
  return {
    ok: false,
    message:
      `Cannot present "${slug}" for approval because collaborator notes are missing or ` +
      `incomplete: ${missing.join("; ")}. Ask each named collaborator to write ` +
      `${contributionPath} with **Collaborator:** <agent-slug> on the first line, then try again. ` +
      `Set AIDLC_DISABLE_ENSEMBLE_EVIDENCE=1 only to recover a legitimately-run stage whose files were lost.`,
  };
}

function checkPipelineLinkEvidence(
  node: GraphStage,
  slug: string,
  pd: string,
  options: { singleRun?: boolean } = {},
): EnsembleEvidenceResult {
  if (
    node.mode !== "pipeline" ||
    process.env.AIDLC_DISABLE_ENSEMBLE_EVIDENCE === "1"
  ) {
    return { ok: true };
  }
  const singleRun = options.singleRun === true;
  const evidence = pipelineLinkEvidence(pd, node, { singleRun });
  if (evidence.missing.length === 0) return { ok: true };
  const missing = evidence.missing.map(({ link, repo }) =>
    repo ? `${repo}:${link}` : link
  );
  const refusal = singleRun
    ? `Cannot complete an isolated run of "${slug}" because these pipeline handoffs have not been recorded for this isolated run`
    : `Cannot present "${slug}" for approval because these pipeline handoffs have not been recorded for the current run`;
  return {
    ok: false,
    message:
      `${refusal}: ${missing.join(", ")}. ` +
      `After each link returns, run \`bun ${harnessDir()}/tools/aidlc-log.ts link --stage ${slug} ` +
      `--link <agent>${evidence.repos.length > 0 ? " --repo <repo>" : ""}` +
      `${singleRun ? " --single" : ""}\`. ` +
      `Set AIDLC_DISABLE_ENSEMBLE_EVIDENCE=1 only to recover a legitimately-run in-flight pipeline.`,
  };
}

// The evidence required before a gated stage may either enter [?] or resolve
// approval. Sharing this check prevents gate-start, revised, and approved from
// disagreeing about whether per-unit work and collaborator dispatch completed.
function checkStageCompletionEvidence(
  node: GraphStage,
  slug: string,
  scope: string,
  stateContent: string,
  pd: string,
): EnsembleEvidenceResult {
  const stageLevelPerUnit =
    isPerUnit(node) &&
    usesStageLevelPerUnitArtifacts(scope, stateContent);
  const boltResolution =
    isPerUnit(node) && !stageLevelPerUnit ? resolveBoltBatches(pd) : null;
  const unitKinds =
    boltResolution?.state === "ok" ? boltResolution.unitKinds : null;
  const settledSwarm = isSettledAutonomousSwarm(
    node,
    scope,
    stateContent,
    pd,
    boltResolution ?? undefined,
  );

  const pipelineEvidence = checkPipelineLinkEvidence(node, slug, pd);
  if (!pipelineEvidence.ok) return pipelineEvidence;

  if (isPerUnit(node) && !stageLevelPerUnit && !settledSwarm) {
    const resolution = boltResolution ?? resolveBoltBatches(pd);
    if (resolution.state === "malformed") {
      return {
        ok: false,
        message:
          `Stage "${slug}" is per-unit (for_each: unit-of-work) but the unit list cannot be resolved: ` +
          `inception/units-generation/unit-of-work-dependency.md is ${resolution.reason} ` +
          `(${resolution.detail}). Fix the fenced units block before entering approval.`,
      };
    }
    if (resolution.state === "ok") {
      const units = resolution.batches.flat();
      const recordPrefix = engineRelativeRecordDir(pd);
      const ledger = unitLedgerFor(pd, slug);
      // A paused unit blocks approval outright: its work is not done and the
      // pause carries an explicit next action a gate must not paper over.
      if (ledger.checkpoint?.state === "paused") {
        const cp = ledger.checkpoint;
        return {
          ok: false,
          message:
            `Stage "${slug}" cannot enter approval: unit "${cp.unit}" is paused` +
            `${cp.reason ? ` (reason: ${cp.reason})` : ""}. Resume and complete it first ` +
            `(bun ${harnessDir()}/tools/aidlc-state.ts unit resume --stage ${slug} --unit ${cp.unit}).`,
        };
      }
      const pick = nextUncoveredUnit(
        pd,
        node,
        units,
        recordPrefix,
        codekbCtxFor(pd),
        unitKinds,
        stateContent,
        ledger,
      );
      if (pick !== null && "error" in pick) {
        return { ok: false, message: pick.error };
      }
      if (pick !== null) {
        return {
          ok: false,
          message:
            `Cannot present "${slug}" for approval because ${pick.uncovered.length} of ` +
            `${units.length} work items are not complete (${pick.uncovered.join(", ")}). ` +
            "Run `next` to finish the remaining work items, then try again.",
        };
      }
    }
  }

  return checkEnsembleEvidence(
    node,
    slug,
    pd,
    engineRelativeRecordDir(pd),
    {
      settledSwarm,
      stageLevelPerUnit,
      boltBatches: boltResolution ?? undefined,
      unitKinds,
    },
  );
}

// Handle `report --single --stage <slug> --result <outcome>`: complete the
// synthetic lifecycle whose STAGE_STARTED boundary was recorded by
// `next --single`, then emit `done`. This is the completion half of the
// stage-runner contract and carries the load-bearing pointer invariant:
//
//   A `--single` run NEVER touches the main state file's `Current Stage`.
//
// It is tool-enforced two ways. (1) STRUCTURAL: this path shells out ONLY to
// `aidlc-audit.ts append-batch` (which has no state write) — never to aidlc-state.ts
// advance / approve / complete-workflow, the only subcommands that pivot the main
// pointer. So a single-stage run is mechanically incapable of advancing the main
// workflow. (2) EXPLICIT: `--single` REQUIRES a `--stage <slug>` naming the stage
// that was run. A `report --single` with NO `--stage` is exactly an attempt to
// "advance the main workflow" (commit against whatever `Current Stage` points at)
// — and that returns an `error` directive rather than silently mutating. The two
// together make "advance the main workflow from a single run" unreachable.
//
// STAGE_COMPLETED carries Stage + Details + Workflow, matching the field shape
// aidlc-state.ts emits. A direct report without an open synthetic start is
// rejected, so pipeline receipts always have an authoritative attempt floor.
//
// The reviewer precondition is DELIBERATELY not engine-enforced here. It
// guards the four completing state transitions (aidlc-state.ts approve /
// advance / finalize / complete-workflow), none of which this path reaches —
// structurally, per invariant (1) above. An isolated run has no gate to
// protect; its reviewer step is prose-driven (SKILL.md single-runner branch),
// and its receipts are tagged `single-stage:<slug>` precisely so they can
// never satisfy the MAIN workflow's guard.
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
  if (!singleStageAttemptIsOpen(pd, node.slug)) {
    emit(errorDirective(
      `Cannot complete isolated stage "${node.slug}": no open ${wfId} STAGE_STARTED boundary exists. ` +
        `Run \`next --stage ${node.slug} --single\` first.`,
    ));
    return;
  }
  const summaryEvidence = checkSummaryConfirmationEvidence(pd, node, {
    workflow: wfId,
    stateContent: null,
  });
  if (!summaryEvidence.ok) {
    emit(errorDirective(summaryEvidence.message));
    return;
  }
  const artifactEvidence = checkSingleCodekbArtifacts(node, pd);
  if (!artifactEvidence.ok) {
    emit(errorDirective(artifactEvidence.message));
    return;
  }
  // Isolated reports never inherit the main workflow's scope, autonomy, or DAG.
  // Only an ensemble stage needs its record prefix for contribution evidence;
  // ordinary stages go straight to the synthetic audit pair.
  const pipelineEvidence = checkPipelineLinkEvidence(node, node.slug, pd, {
    singleRun: true,
  });
  if (!pipelineEvidence.ok) {
    emit(errorDirective(pipelineEvidence.message));
    return;
  }
  const recordPrefix = requiresEnsembleEvidence(node) ? engineRelativeRecordDir(pd) : null;
  const evidence = checkEnsembleEvidence(
    node,
    node.slug,
    pd,
    recordPrefix,
    { singleRun: true },
  );
  if (!evidence.ok) {
    emit(errorDirective(evidence.message));
    return;
  }
  const completionError = appendSingleStageAuditEvents(pd, [{
    eventType: "STAGE_COMPLETED",
    fields: {
      Stage: node.slug,
      Details: `Single-stage run of ${node.slug} completed`,
      Workflow: wfId,
    },
  }]);
  if (completionError) {
    emit(errorDirective(
      `Failed to record single-stage completion for "${node.slug}"` +
        `: ${completionError}`,
    ));
    return;
  }
  try { clearActiveDirectiveMarker(pd); }
  catch (e) { recordHookDrop(pd, "active-directive", errorMessage(e)); }

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
  if (flags.unit) args.push("--unit", flags.unit);
  return args;
}

// Complete the non-stage resume-choice round-trip by ROUTING the choice, not
// just accepting it. Resuming from the current checkpoint is read-only; the
// other three choices are mutations, so the directive NAMES the move (the
// existing verbs: jump execute --direction redo, next --stage, next
// --new-intent) and the conductor runs it — report itself never mutates. The
// keywords are matched against the engine's own Branch-6 question wording, so
// they are stable even though the rendered option labels are LLM-authored.
function handleResumeReport(
  flags: ReportFlags,
  projectDir: string | undefined,
): void {
  if (flags.stage?.trim()) {
    emit(errorDirective(
      "A resume-choice report is not a stage transition; omit --stage.",
    ));
    return;
  }
  if (!flags.userInput?.trim()) {
    emit(errorDirective(
      "report --result resumed requires --user-input with the human's resume choice.",
    ));
    return;
  }
  const pd = resolveProjectDir(projectDir);
  const stateContent = loadStateFileIfPresent(pd);
  if (!stateContent) {
    emit(errorDirective(
      "No active intent workflow state found (aidlc-state.md is absent) - nothing to resume.",
    ));
    return;
  }
  const slug = getField(stateContent, "Current Stage")?.trim();
  if (!slug) {
    emit(errorDirective(
      "State file has no Current Stage field - cannot resume from the last checkpoint.",
    ));
    return;
  }
  // Numbered-prose harnesses show this fixed menu as 1-4. Normalize an exact
  // visible response key before semantic matching so the engine, not the
  // conductor, owns that stable mapping.
  const numericChoices: Readonly<Record<string, string>> = {
    "1": "resume from last checkpoint",
    "2": "redo the current stage",
    "3": "jump to a stage",
    "4": "start fresh",
  };
  const rawChoice = flags.userInput.trim().toLowerCase();
  const choice = numericChoices[rawChoice] ?? rawChoice;
  if (choice.includes("redo")) {
    const scope = getField(stateContent, "Scope")?.trim() ?? "";
    emit(printDirective(
      `Redo accepted at "${slug}". Run \`bun ${harnessDir()}/tools/aidlc-jump.ts execute --target ${slug} --direction redo --scope ${scope}\` to reset the current stage, then re-run \`next\` to start it over.`,
    ));
    return;
  }
  if (choice.includes("jump")) {
    emit(printDirective(
      `Jump accepted. Ask the human which stage to jump to, then re-run \`next --stage <slug>\`; the direction and the target are worked out and checked for you.`,
    ));
    return;
  }
  if (choice.includes("fresh") || choice.includes("start over")) {
    emit(printDirective(
      "Start-fresh accepted. Confirm the new work's scope and description with the human, then run `next --new-intent --scope <scope> \"<description>\"` — the existing workflow stays in place and the new intent starts alongside it.",
    ));
    return;
  }
  if (
    choice.includes("resume") ||
    choice.includes("checkpoint") ||
    choice.includes("continue")
  ) {
    emit(printDirective(
      `Resume choice accepted at "${slug}". Re-run \`next\` to continue from the last checkpoint.`,
    ));
    return;
  }
  emit(errorDirective(
    `Unrecognized resume choice "${flags.userInput}". Accepted choices: 1/resume from last checkpoint, 2/redo the current stage, 3/jump to a stage, or 4/start fresh.`,
  ));
}

// The `report` handler. Reads the acted stage + scope from state, decides the
// committing subcommand(s) (gate status, then finality), shells out to the
// atomic state tool, and emits a terminal `done` directive on success or an
// `error` directive on a rejected transition. Mutation happens entirely inside
// the spawned subcommand(s) — the engine itself writes nothing.
function handleReport(args: string[], projectDir: string | undefined): void {
  const flags = parseReportFlags(args);

  // Turn-shape marker: a `report` is unambiguous workflow engagement (it commits
  // a transition), so it always disqualifies the turn from the Stop hook's
  // conversational carve-out. See touchEngineMarker.
  touchEngineMarker(projectDir);

  // Runtime state-version guard (see staleStateVersionError): `report` commits a
  // lifecycle transition, so a pre-v8 state must be refused here too — before any
  // report sub-branch mutates it. Covers every report path (result, skeleton
  // stance, single) via one early check.
  {
    const pd = resolveProjectDir(projectDir);
    const sc = loadStateFileIfPresent(pd);
    // `!== null` (not truthiness): a present but zero-byte state file returns ""
    // and must still be refused, not treated as an absent file.
    if (sc !== null) {
      const stale = staleStateVersionError(sc);
      if (stale) {
        emit(errorDirective(stale));
        return;
      }
    }
  }

  // Branch -1 — the --single stage-runner completion. A stage-runner reports
  // its lone stage via `report --single --stage <slug> --result <outcome>`; the
  // engine closes the synthetic attempt opened by `next --single` (audit only)
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

  // A resume ask has no stage and commits no lifecycle outcome. Accept the
  // natural verdict used by conductors, then return to next without mutation.
  if (flags.result && RESUME_RESULTS.has(flags.result)) {
    handleResumeReport(flags, projectDir);
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
        [...REPORT_RESULTS].join(", ") +
        " (the verdict for the stage just acted on).",
    });
    return;
  }
  if (!REPORT_RESULTS.has(flags.result)) {
    emit({
      kind: "error",
      message:
        `Unknown --result "${flags.result}". ` +
        `accepted outcomes: ${[...REPORT_RESULTS].join(", ")}.`,
    });
    return;
  }

  const pd = resolveProjectDir(projectDir);
  const stateContent = loadStateFileIfPresent(pd);
  if (!stateContent) {
    emit({
      kind: "error",
      message:
        "No active intent workflow state found (aidlc-state.md is absent) — nothing to report a transition for.",
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

  // A stage-authored conditional skip is a routed lifecycle outcome, not a
  // completion. Keep it ahead of artifact, per-unit, and ensemble guards: a
  // justified skip deliberately produces none of that completion evidence.
  // Unlike completion reports, skip must be explicit and pinned to the live
  // cursor so a stale stage body cannot skip whatever Current Stage became.
  if (flags.result === SKIP_RESULT) {
    if (!explicitStage) {
      emit(errorDirective(
        "report --result skipped requires an explicit nonblank --stage <slug>.",
      ));
      return;
    }
    const planAction = effectivePlanAction(slug, scope, stateContent);
    if (node.execution !== "CONDITIONAL" && planAction !== "SKIP") {
      emit(errorDirective(
        `Stage "${slug}" is execution: ${node.execution}; only a CONDITIONAL stage can report skipped.`,
      ));
      return;
    }
    const reason = flags.reason?.trim();
    if (!reason) {
      emit(errorDirective(
        "report --result skipped requires a nonblank --reason <text>.",
      ));
      return;
    }
    if (slug !== currentSlug) {
      emit(errorDirective(
        `Cannot skip stage "${slug}": Current Stage is "${currentSlug}". ` +
          "A skip report must name the active stage exactly.",
      ));
      return;
    }
    if (
      stageCheckbox.state !== "in-progress" &&
      stageCheckbox.state !== "revising" &&
      stageCheckbox.state !== "skipped"
    ) {
      emit(errorDirective(
        `Stage "${slug}" is ${stageCheckbox.state}; only an active, revising, or interrupted skipped stage can be routed as skipped.`,
      ));
      return;
    }

    const res = spawnState(pd, [
      "skip",
      slug,
      "--reason",
      reason,
      "--route",
    ]);
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      emit(errorDirective(
        `Could not skip "${slug}"${detail ? `: ${detail}` : ". Run /aidlc --doctor if the reason is unclear."}`,
      ));
      return;
    }
    emit({
      kind: "done",
      reason:
        `Committed skip for "${slug}" (scope: ${scope}). ` +
        "State routed forward; run next to continue.",
    });
    return;
  }

  if (
    isTeamUnitOwnership(stateContent) &&
    node.phase === "construction" &&
    isPerUnit(node)
  ) {
    const unit = flags.unit?.trim();
    if (
      flags.result === "awaiting-approval" ||
      flags.result === "rejected" ||
      flags.result === "revised" ||
      flags.result === "approved"
    ) {
      if (!unit) {
        emit(errorDirective(
          `Unit Ownership: team requires --unit <name> when reporting "${flags.result}" for "${slug}".`,
        ));
        return;
      }
      try {
        validateLiveUnitScope(pd, unit);
      } catch (e) {
        emit(errorDirective(errorMessage(e)));
        return;
      }
      const resolution = resolveBoltBatches(pd);
      if (resolution.state !== "ok" || !resolution.units.includes(unit)) {
        emit(errorDirective(`Unit "${unit}" is not in the authoritative unit DAG.`));
        return;
      }
      const rhythm = effectiveUnitGateRhythm(pd, stateContent);
      const gateScope = rhythm === "unit-end" ? "unit-end" : "per-stage";
      const block = constructionUnitMajorBlock(scope, stateContent, true);
      const finalStage = block[block.length - 1];
      if (gateScope === "unit-end" && finalStage?.slug !== slug) {
        emit(errorDirective(
          `Unit-end gate for "${unit}" must be reported against "${finalStage?.slug ?? "unknown"}", not "${slug}".`,
        ));
        return;
      }
      const status = unitGateStatus(pd, slug, unit, gateScope);
      const sequence: string[][] = [];
      if (flags.result === "awaiting-approval") {
        if (status === "awaiting-approval") {
          emit(printDirective(
            `Unit "${unit}" gate for "${slug}" is already awaiting approval.`,
          ));
          return;
        }
        sequence.push(["gate-start", slug, "--unit", unit]);
      } else if (flags.result === "rejected") {
        const feedback = (flags.userInput ?? flags.reason)?.trim();
        if (!feedback) {
          emit(errorDirective(
            `report --result rejected for unit "${unit}" of "${slug}" requires nonblank --user-input or --reason feedback.`,
          ));
          return;
        }
        const rejectArgs = ["reject", slug, "--feedback", feedback, "--unit", unit];
        for (const finding of flags.rejectFindings ?? []) {
          rejectArgs.push("--reject-finding", finding);
        }
        sequence.push(rejectArgs);
      } else if (flags.result === "revised") {
        sequence.push(["revise", slug, "--unit", unit]);
      } else {
        if (
          process.env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD !== "1" &&
          !flags.userInput?.trim()
        ) {
          emit(errorDirective(
            `report --result approved for unit "${unit}" of "${slug}" requires --user-input with the human's exact approval choice.`,
          ));
          return;
        }
        if (status !== "awaiting-approval") {
          sequence.push([
            "gate-start",
            slug,
            "--recovered",
            "--unit",
            unit,
          ]);
        }
        sequence.push(approveArgs(slug, flags));
      }
      const committed: string[] = [];
      for (const subArgs of sequence) {
        const res = spawnState(pd, subArgs);
        if (res.exitCode !== 0) {
          const detail = (res.stderr || res.stdout).trim();
          emit(errorDirective(
            `Transition rejected by aidlc-state.ts ${subArgs[0]} for unit "${unit}" of "${slug}"` +
              (detail ? `: ${detail}` : "."),
          ));
          return;
        }
        committed.push(subArgs[0]);
      }
      emit(
        flags.result === "approved"
          ? {
              kind: "done",
              reason:
                `Committed ${committed.join(" + ")} for unit "${unit}" of "${slug}". ` +
                "Run next to continue the unit-major walk.",
            }
          : printDirective(
              `Recorded ${flags.result} for unit "${unit}" of "${slug}".`,
            ),
      );
      return;
    }
    if (flags.unit) {
      emit(errorDirective(
        `--unit is supported only for team-owned gate outcomes, not "${flags.result}".`,
      ));
      return;
    }
  } else if (flags.unit) {
    emit(errorDirective("--unit gate reporting requires Unit Ownership: team."));
    return;
  }

  const isGated = node.phase !== "initialization";
  const protectedHumanGate =
    isGated &&
    stageCheckbox.state !== "completed" &&
    readAutonomyMode(stateContent) !== "autonomous" &&
    process.env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD !== "1";

  if (flags.overrideBlockingSensors) {
    if (
      flags.result !== "awaiting-approval" &&
      flags.result !== "revised"
    ) {
      emit(errorDirective(
        "--override-blocking-sensors is valid only while opening or re-entering a gate.",
      ));
      return;
    }
    if (readAutonomyMode(stateContent) === "autonomous") {
      emit(errorDirective(
        `Refusing blocking sensor override for "${slug}": Construction Autonomy Mode ` +
          "is autonomous. Unattended runs must halt on blocking sensor failures.",
      ));
      return;
    }
    if (flags.userInput?.trim() !== BLOCKING_SENSOR_OVERRIDE_CHOICE) {
      emit(errorDirective(
        `A blocking sensor override requires --user-input ` +
          `"${BLOCKING_SENSOR_OVERRIDE_CHOICE}", the exact choice offered to the human.`,
      ));
      return;
    }
  }

  if (protectedHumanGate && flags.result === "rejected") {
    if (flags.userInput?.trim() !== "Request Changes") {
      emit(errorDirective(
        `report --result rejected for "${slug}" received reply ` +
          `${formatReceivedReply(flags.userInput)} which did not match an offered choice at ` +
          "the held gate. Re-present the original held gate with every " +
          "offered choice and wait for the human to choose one.",
      ));
      return;
    }
    if (!flags.reason?.trim()) {
      emit(errorDirective(
        `report --result rejected for "${slug}" requires nonblank revision feedback in ` +
          "--reason, separate from --user-input \"Request Changes\".",
      ));
      return;
    }
  }

  if (
    protectedHumanGate &&
    FORWARD_RESULTS.has(flags.result ?? "")
  ) {
    const rawRevisionCount = getField(stateContent, "Revision Count");
    const parsedRevisionCount = rawRevisionCount ? parseInt(rawRevisionCount, 10) : 0;
    const revisionCount = Number.isFinite(parsedRevisionCount) ? parsedRevisionCount : 0;
    const approvalChoice = flags.userInput?.trim();
    const matchesOfferedApproval =
      approvalChoice === "Approve" ||
      (approvalChoice === "Accept as-is" && revisionCount >= 3);
    if (!matchesOfferedApproval) {
      emit(errorDirective(
        `report --result ${flags.result} for "${slug}" received reply ` +
          `${formatReceivedReply(approvalChoice)} which did not match an offered choice at ` +
          "the held gate. Re-present the original held gate with every offered " +
          "choice and wait for the human to choose one.",
      ));
      return;
    }
  }

  // Gate lifecycle reports keep every model-issued state transition behind the
  // engine boundary. They resolve before artifact/ensemble completion guards:
  // opening, rejecting, or re-entering a gate does not claim completion.
  if (GATE_RESULTS.has(flags.result)) {
    if (!isGated) {
      emit(errorDirective(
        `Stage "${slug}" is an ungated initialization stage; it cannot report ${flags.result}.`,
      ));
      return;
    }
    if (
      (flags.result === "awaiting-approval" || flags.result === "revised") &&
      stageCheckbox.state !== "completed"
    ) {
      const evidence = checkStageCompletionEvidence(
        node,
        slug,
        scope,
        stateContent,
        pd,
      );
      if (!evidence.ok) {
        emit(errorDirective(evidence.message));
        return;
      }
    }

    let subArgs: string[];
    let revalidatingOpenGate = false;
    if (flags.result === "awaiting-approval") {
      if (stageCheckbox.state === "awaiting-approval") {
        revalidatingOpenGate = true;
      }
      if (
        stageCheckbox.state !== "in-progress" &&
        stageCheckbox.state !== "awaiting-approval"
      ) {
        emit(errorDirective(
          `Stage "${slug}" is ${stageCheckbox.state}; only an in-progress or already-open stage can validate a gate.`,
        ));
        return;
      }
      subArgs = ["gate-start", slug];
      if (flags.overrideBlockingSensors) {
        subArgs.push(
          "--override-blocking-sensors",
          "--user-input",
          flags.userInput!,
        );
      }
    } else if (flags.result === "rejected") {
      if (
        stageCheckbox.state !== "in-progress" &&
        stageCheckbox.state !== "awaiting-approval"
      ) {
        emit(errorDirective(
          `Stage "${slug}" is ${stageCheckbox.state}; only an active or awaiting-approval stage can be rejected.`,
        ));
        return;
      }
      const feedback = flags.reason?.trim() ?? flags.userInput?.trim();
      if (!feedback) {
        emit(errorDirective(
          `report --result rejected for "${slug}" requires nonblank revision feedback.`,
        ));
        return;
      }
      subArgs = ["reject", slug, "--feedback", feedback];
      if (flags.userInput) subArgs.push("--user-input", flags.userInput);
      for (const finding of flags.rejectFindings ?? []) {
        subArgs.push("--reject-finding", finding);
      }
    } else {
      if (stageCheckbox.state !== "revising") {
        emit(errorDirective(
          `Stage "${slug}" is ${stageCheckbox.state}; only a revising stage can re-enter its gate.`,
        ));
        return;
      }
      subArgs = ["revise", slug];
      if (flags.overrideBlockingSensors) {
        subArgs.push(
          "--override-blocking-sensors",
          "--user-input",
          flags.userInput!,
        );
      }
    }

    const res = spawnState(pd, subArgs);
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      emit(errorDirective(
        `Could not update the approval status for "${slug}"` +
          (detail ? `: ${detail}` : ". Run /aidlc --doctor if the reason is unclear."),
      ));
      return;
    }
    emit(
      printDirective(
        revalidatingOpenGate
          ? `Stage "${slug}" is already awaiting approval; gate evidence revalidated.`
          : `Recorded ${flags.result} for "${slug}".`,
      ),
    );
    return;
  }

  if (stageCheckbox.state !== "completed") {
    const evidence = checkStageCompletionEvidence(
      node,
      slug,
      scope,
      stateContent,
      pd,
    );
    if (!evidence.ok) {
      emit(errorDirective(evidence.message));
      return;
    }
  }

  // Practices Discovery holds its human approval until practices-promote has
  // committed both memory targets and a fresh two-part receipt for this stage
  // attempt. Gate opening deliberately precedes promotion, so enforce the
  // receipt only on a forward approval of an unfinished stage.
  if (
    slug === "practices-discovery" &&
    stageCheckbox.state !== "completed" &&
    !hasFreshPracticesAffirmationReceipt(pd, stateContent)
  ) {
    emit(errorDirective(
      'Cannot approve "practices-discovery" because the approved practices have not been saved yet. ' +
        "Run aidlc-state.ts practices-promote after the human approves, then report " +
        '--result approved --user-input "<exact choice>".',
    ));
    return;
  }

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
            `Workflow is already completed at "${slug}" (scope: ${scope}); no transition was needed.${NEW_WORK_HINT}`,
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
            `Stage "${slug}" is still in progress. To approve it before its approval question ` +
            `has been recorded, retry the report with --stage "${slug}".`,
        });
        return;
      }
      // Backfilled gate — tag the row Recovered=true so audit consumers can
      // tell the engine-opened gate from an organic gate-start.
      sequence.push(["gate-start", slug, "--recovered"]);
    }
    // Reviewer precondition (§12a / RFC Track 1) is NOT enforced here. Like the
    // artifact, human-presence, and revision guards, it lives in
    // aidlc-state.ts handleApprove — the ONE seam every approve passes through
    // (report shells out to `state.ts approve`, but agents also call it directly
    // on recovery, so a report-only guard is bypassable, issue #366). See
    // verifyReviewerPrecondition in aidlc-state.ts.
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
          `Could not complete "${slug}"` +
          (detail ? `: ${detail}` : ". Run /aidlc --doctor if the reason is unclear."),
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

// The `park` handler (issue #367). Parks the workflow at the current inter-stage
// boundary: it shells out to `aidlc-state.ts park` (which persists the
// Parked/Parked At Stage runtime markers, emits WORKFLOW_PARKED, and refuses
// under autonomous Construction), then emits the terminal `parked` directive the
// Stop hook honours as a clean turn-end. Mutation lives entirely in the spawned
// subcommand - the engine itself writes nothing, mirroring report's discipline.
// A non-zero exit (e.g. the autonomy refusal, or an already-completed workflow)
// is relayed verbatim as an error directive.
function handlePark(_args: string[], projectDir: string | undefined): void {
  const pd = resolveProjectDir(projectDir);
  // Turn-shape marker: a `park` mutates workflow state, so it is engagement. See
  // touchEngineMarker. (The `parked` directive is a terminal allow in the Stop
  // hook anyway, so this is belt-and-braces rather than load-bearing.)
  touchEngineMarker(projectDir);
  const res = spawnState(pd, ["park"]);
  if (res.exitCode !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    emit(errorDirective(`Cannot park the workflow${detail ? `: ${detail}` : "."}`));
    return;
  }
  const stateContent = loadStateFileIfPresent(pd);
  const parkedAt = stateContent
    ? (getField(stateContent, "Parked At Stage") ?? "").trim()
    : "";
  emit(parkedDirective(
    `Workflow parked at "${parkedAt}". Resume with /aidlc --resume.`,
    parkedAt,
  ));
}

function handleTeamBoard(
  args: string[],
  projectDir: string | undefined,
): void {
  const requestedProjectDir = resolveProjectDir(projectDir);
  let pd = requestedProjectDir;
  if (readApplicableTeamUnitScopeStamp(requestedProjectDir)) {
    const top = Bun.spawnSync({
      cmd: ["git", "rev-parse", "--show-toplevel"],
      cwd: requestedProjectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const common = Bun.spawnSync({
      cmd: ["git", "rev-parse", "--git-common-dir"],
      cwd: requestedProjectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (top.exitCode === 0 && common.exitCode === 0) {
      const topPath = top.stdout.toString().trim();
      const mainPath = dirname(resolve(topPath, common.stdout.toString().trim()));
      if (existsSync(mainPath)) pd = mainPath;
    }
  }
  const flagValue = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(`team-board ${name} requires a value.`);
    }
    return value;
  };
  const explicitSpace = flagValue("--space");
  const defaultSelection = resolveWorkflowSelection(pd);
  const selectedSpace = explicitSpace ?? defaultSelection.space;
  const selectedIntent = flagValue("--intent");
  let stateContent: string;
  let board: TeamConstructionBoard;
  if (selectedIntent || explicitSpace) {
    const intents = listIntents(pd, selectedSpace);
    const matches = selectedIntent
      ? intents.filter(
      (intent) =>
        intent.dirName === selectedIntent ||
        intent.slug === selectedIntent ||
        intent.uuid === selectedIntent,
      )
      : intents.filter((intent) => intent.active);
    if (matches.length !== 1 || !matches[0].dirName || !matches[0].uuid) {
      throw new Error(
        selectedIntent
          ? `Cannot resolve exactly one intent "${selectedIntent}" in space "${selectedSpace}".`
          : `Space "${selectedSpace}" has no uniquely resolved active intent; pass --intent <intent>.`,
      );
    }
    const intent = matches[0];
    const intentDir = intent.dirName!;
    const intentUuid = intent.uuid;
    stateContent = readStateFile(pd, intentDir, selectedSpace);
    if (!isTeamUnitOwnership(stateContent)) {
      throw new Error("Team Construction board requires Unit Ownership: team.");
    }
    board =
      selectedSpace === defaultSelection.space &&
          intent.dirName === defaultSelection.intent
        ? buildTeamConstructionBoard(pd, stateContent, { readOnly: true })
        : buildTeamConstructionBoardForIntent(pd, stateContent, {
          space: selectedSpace,
          intentUuid,
          dependencyBody: readFileSync(
            unitDependencyPath(pd, intentDir, selectedSpace),
            "utf-8",
          ),
        });
  } else {
    stateContent = readStateFile(pd);
    if (!isTeamUnitOwnership(stateContent)) {
      throw new Error("Team Construction board requires Unit Ownership: team.");
    }
    board = buildTeamConstructionBoard(pd, stateContent, {
      readOnly: true,
    });
  }
  process.stdout.write(
    `${renderTeamConstructionBoard(
      board,
      args.includes("--snapshot") ? "snapshot" : "dispatcher",
    )}\n`,
  );
}

// Resume deterministic rule delivery without mutating workflow state. The
// token carries the route and hashes of both the run-stage directive and rule
// bundle. Rebuilding from current disk state makes stale or mixed deliveries
// fail with a restart instruction instead of combining old and new steering.
function handleContinue(args: string[], projectDir: string | undefined): void {
  const token = args[0] ?? "";
  const pd = resolveProjectDir(projectDir);
  const payload = decodeSteeringToken(token, pd);
  if (!payload || args.length !== 1) {
    emit(errorDirective(
      "Invalid steering continuation token: this stage's rules cannot be loaded from where they left off. Run a fresh `next` to restart delivery from part 1.",
    ));
    return;
  }
  const liveState = loadStateFileIfPresent(pd);
  const liveStateHash = liveState === null ? null : sha256(liveState);
  if (payload.a && payload.h !== liveStateHash) {
    emit(errorDirective(
      "The saved position moved on: the workflow state changed while this stage's rules were being loaded. Run a fresh `next` to restart delivery from part 1.",
    ));
    return;
  }
  const node = nodeForSlug(payload.s);
  if (!node) {
    emit(errorDirective(
      `Stage "${payload.s}" no longer exists. Run a fresh \`next\` after recompiling the stage graph.`,
    ));
    return;
  }
  if (payload.r !== steeringRouteHash(node, payload.c)) {
    emit(errorDirective(
      "Which stage runs next has changed: the stage route changed while its rules were being loaded. Run a fresh `next` to restart delivery from part 1.",
    ));
    return;
  }
  activeStageValidityAdvisory =
    payload.a && liveState !== null
      ? projectStageValidityAdvisory(pd, liveState)
      : undefined;
  const cursor = inspectContinuationCursor(pd, liveState);

  const directive = buildRunStageDirective(
    node,
    projectTypeFrom(liveState),
    payload.u,
    payload.c,
    payload.a ? liveState : null,
    engineRelativeRecordDir(pd),
    codekbCtxFor(pd),
    payload.k,
    payload.f,
    payload.x,
  );
  directive.gate = payload.g;
  if (payload.p && payload.u !== null) directive.unit = payload.u;
  if (payload.n === undefined) {
    delete directive.next_stage;
  } else {
    directive.next_stage = payload.n;
  }
  if (payload.x) directive.single = true;
  if (payload.z === true) applySettledSwarmShape(directive);
  if (payload.q !== undefined) directive.unit_gate = payload.q;
  if (payload.w) {
    const resolution = resolveBoltDag(pd);
    if (resolution.state === "ok") {
      const codekbCtx = codekbCtxFor(pd);
      const wave = activePerUnitWave(
        pd,
        node,
        resolution,
        projectTypeFrom(liveState),
        payload.c,
        payload.a ? liveState : null,
        engineRelativeRecordDir(pd),
        codekbCtx,
      );
      if (wave.state === "active" && wave.unit === payload.u) {
        const waveError = attachBoundedWave(directive, wave.wave, codekbCtx);
        if (waveError !== null) {
          emit(errorDirective(waveError));
          return;
        }
      }
    }
  }

  requestedSteeringContinuation = payload;
  const withLegacyOffer = attachLegacyKiroPlanApprovalChoices(
    prepareEmission(directive),
  );
  const prepared = withLegacyOffer.prepared;
  if (!prepared.marker) {
    writePrepared(prepared);
    return;
  }
  if (process.env.AIDLC_STOP_HOOK_PROBE === "1") {
    writePrepared(prepared);
    return;
  }
  try {
    const advanced = advanceContinuationCursor(
      cursor,
      token,
      prepared.marker,
      prepared.resultSha256,
      engineInvocation?.attemptId,
      withLegacyOffer.offer,
      withLegacyOffer.session,
    );
    if (advanced === "advanced") {
      writePrepared(prepared);
      return;
    }
    if (advanced === "legacy-plan-approval-owned") {
      writePrepared(prepareEmission(errorDirective(
        "Legacy Kiro Plan Approval is owned by another active IDE window. Continue the pending approval there; this call did not receive or rotate its protected choices.",
      )));
      return;
    }
    if (advanced === "legacy-plan-approval-recovery-required") {
      writePrepared(prepareEmission(legacyPlanApprovalRecoveryDirective()));
      return;
    }
    if (
      advanced === "legacy-plan-approval-reissued" ||
      advanced === "legacy-plan-approval-transport"
    ) {
      writePrepared(prepared);
      return;
    }
    const message = advanced === "superseded"
      ? "This continuation token is no longer current for this workflow. Run a fresh `next`; do not reuse an earlier token."
      : "The active workflow context changed while this continuation was prepared. Run a fresh `next`; do not use the prepared result.";
    writePrepared(prepareEmission(errorDirective(message)));
  } catch (error) {
    if (!(error instanceof ActiveDirectiveLockContendedError)) throw error;
    writePrepared(prepareEmission(errorDirective(
      "Continuation coordination is busy. This call did not commit a cursor change. Retry the current token; if it is reported superseded, run a fresh `next`.",
    )));
  }
}

// --- CLI entry point ---

export function main(argv: string[]): void {
  const rawArgs = argv;

  // Extract --project-dir (mirrors aidlc-jump.ts / aidlc-state.ts).
  let projectDir: string | undefined;
  let attemptId: string | undefined;
  let conflictingAttemptId = false;
  const filteredArgs: string[] = [];
  let literalArgs = false;
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--") {
      literalArgs = true;
      filteredArgs.push(rawArgs[i]);
    } else if (!literalArgs && rawArgs[i] === "--project-dir" && i + 1 < rawArgs.length) {
      projectDir = rawArgs[i + 1];
      i++;
    } else if (!literalArgs && rawArgs[i] === "--aidlc-attempt-id" && i + 1 < rawArgs.length) {
      const candidate = rawArgs[i + 1];
      if (/^[A-Za-z0-9._:-]{1,128}$/.test(candidate)) {
        if (attemptId !== undefined && attemptId !== candidate) conflictingAttemptId = true;
        attemptId = candidate;
      }
      i++;
    } else {
      filteredArgs.push(rawArgs[i]);
    }
  }

  const subcommand = filteredArgs[0];
  const subArgs = filteredArgs.slice(1);
  if (engineInvocation !== null) throw new Error("Nested aidlc-orchestrate dispatch is not supported");
  const resolvedProjectDir = resolveProjectDir(projectDir);
  const resolvedSelection = resolveWorkflowSelection(resolvedProjectDir);
  engineSessionId = resolvedSelection.sessionId ?? undefined;
  engineSelections.clear();
  engineSelections.set(resolvedProjectDir, resolvedSelection);
  const commandKind = (["next", "continue", "report", "park"] as const).find((kind) => kind === subcommand);
  if (commandKind) engineInvocation = {
    commandKind,
    commandSha256: sha256(
      JSON.stringify([
        commandKind,
        ...subArgs,
      ]),
    ),
    ...(!conflictingAttemptId && attemptId ? { attemptId } : {}),
  };
  try {
    switch (subcommand) {
      case "next":
        handleNext(subArgs, projectDir);
        break;
      case "continue":
        handleContinue(subArgs, projectDir);
        break;
      case "report":
        handleReport(subArgs, projectDir);
        break;
      case "park":
        handlePark(subArgs, projectDir);
        break;
      case "team-board":
        handleTeamBoard(subArgs, projectDir);
        break;
      default:
        // Unknown / missing subcommand — usage to stderr, exit 1. Matches the
        // stderr-only usage shape the sibling tools use for a bad subcommand.
        console.error(
          `Unknown subcommand: ${subcommand ?? "(none)"}. Valid: next, continue, report, park, team-board`,
        );
        process.exit(1);
    }
  } finally {
    engineInvocation = null;
    engineSessionId = undefined;
    engineSelections.clear();
    requestedSteeringContinuation = null;
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    // Any uncaught read error (missing graph, malformed state) surfaces as a
    // non-zero exit with the message on stderr — never a half-emitted
    // directive on stdout.
    console.error(`aidlc-orchestrate: ${errorMessage(e)}`);
    process.exit(1);
  }
}
