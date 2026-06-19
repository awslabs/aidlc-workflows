import { appendAuditEntry } from "./aidlc-audit.ts";
import {
  type CheckboxState,
  countCheckboxes,
  emitError,
  errorMessage,
  findStageBySlug,
  firstInScopeStageOfPhase,
  getField,
  isoTimestamp,
  loadScopeMapping,
  loadStageGraph,
  nextInScopeStage,
  PHASE_NUMBERS,
  PHASES,
  parseCheckboxes,
  readStateFile,
  resolveProjectDir,
  resolveStage,
  type StageEntry,
  setCheckbox,
  setField,
  stageIndex,
  writeStateFile,
} from "./aidlc-lib.js";

// --- Audit emission helper ---
function emitAudit(
  pd: string,
  eventType: string,
  fields: Record<string, string>
): void {
  appendAuditEntry(eventType, fields, pd);
}

// --- CLI entry point ---

let projectDir: string | undefined;

function main(): void {
  const rawArgs = process.argv.slice(2);

  // Extract --project-dir
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

  try {
    switch (subcommand) {
      case "resolve":
        handleResolve(filteredArgs.slice(1));
        break;
      case "execute":
        handleExecute(filteredArgs.slice(1));
        break;
      default:
        error(`Unknown subcommand: ${subcommand}. Valid: resolve, execute`);
    }
  } catch (e) {
    error(errorMessage(e));
  }
}

if (import.meta.main) {
  main();
}

// --- Parse named flags ---

function parseFlags(
  args: string[]
): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

// --- Subcommand: resolve ---

function handleResolve(args: string[]): void {
  const flags = parseFlags(args);
  const pd = resolveProjectDir(projectDir);
  const content = readStateFile(pd);

  // Determine scope
  const scope = flags.scope || getField(content, "Scope") || "feature";
  const scopeMapping = loadScopeMapping()[scope];
  if (!scopeMapping) error(`Unknown scope: ${scope}`);

  // Determine current position
  const currentSlug = getField(content, "Current Stage") || "state-init";
  const currentStage = resolveStage(currentSlug);
  if (!currentStage) error(`Cannot resolve current stage: ${currentSlug}`);

  // Resolve target
  let targetStage: StageEntry | null = null;

  if (flags.stage) {
    targetStage = resolveStage(flags.stage) || null;
    if (!targetStage) error(`Unknown stage: ${flags.stage}`);

    // Check if target is in scope
    if (scopeMapping.stages[targetStage.slug] === "SKIP") {
      error(
        `Stage "${targetStage.slug}" is skipped for scope "${scope}". Choose a different stage or change scope.`
      );
    }
  } else if (flags.phase) {
    const phaseInput = flags.phase.toLowerCase();
    const canonicalPhase =
      PHASE_NUMBERS[phaseInput] ||
      ((PHASES as readonly string[]).includes(phaseInput) ? phaseInput : null);
    if (!canonicalPhase) error(`Unknown phase: ${flags.phase}`);

    targetStage = firstInScopeStageOfPhase(canonicalPhase, scope);
    if (!targetStage) {
      error(
        `Phase "${canonicalPhase}" has no executable stages for scope "${scope}".`
      );
    }
  } else {
    error("Usage: resolve --stage <slug|#> or --phase <name|#> [--scope <scope>]");
  }

  // Determine direction
  const currentIdx = stageIndex(currentStage.slug);
  const targetIdx = stageIndex(targetStage.slug);

  let direction: "forward" | "backward" | "redo";
  if (targetIdx > currentIdx) direction = "forward";
  else if (targetIdx < currentIdx) direction = "backward";
  else direction = "redo";

  // Compute affected stages
  const graph = loadStageGraph();
  const affectedSlugs: string[] = [];

  if (direction === "forward") {
    // Stages between current (exclusive) and target (exclusive)
    for (let i = currentIdx + 1; i < targetIdx; i++) {
      if (scopeMapping.stages[graph[i].slug] === "EXECUTE") {
        affectedSlugs.push(graph[i].slug);
      }
    }
  } else if (direction === "backward") {
    // Target and all stages after (in scope)
    for (let i = targetIdx; i < graph.length; i++) {
      if (scopeMapping.stages[graph[i].slug] === "EXECUTE") {
        affectedSlugs.push(graph[i].slug);
      }
    }
  }
  // redo: only the target itself

  console.log(
    JSON.stringify({
      target_slug: targetStage.slug,
      target_phase: targetStage.phase.toUpperCase(),
      target_number: targetStage.number,
      target_name: targetStage.name,
      current_slug: currentStage.slug,
      current_number: currentStage.number,
      direction,
      affected_stages: affectedSlugs,
      valid: true,
    })
  );
}

// --- Subcommand: execute ---

function handleExecute(args: string[]): void {
  const flags = parseFlags(args);
  const pd = resolveProjectDir(projectDir);
  let content = readStateFile(pd);

  const targetSlug = flags.target;
  if (!targetSlug) error("Usage: execute --target <slug> --direction <forward|backward|redo> [--scope <scope>]");

  const direction = flags.direction;
  if (
    direction !== "forward" &&
    direction !== "backward" &&
    direction !== "redo"
  ) {
    error(`Invalid direction: ${flags.direction}. Valid: forward, backward, redo`);
  }

  const scope = flags.scope || getField(content, "Scope") || "feature";
  const scopeMapping = loadScopeMapping()[scope];
  if (!scopeMapping) error(`Unknown scope: ${scope}`);

  const targetStage = findStageBySlug(targetSlug);
  if (!targetStage) error(`Unknown stage: ${targetSlug}`);

  // Scope validation — target must be EXECUTE for this scope (mirrors resolve handler).
  // Without this, an orchestrator bypassing resolve can land the workflow on a stage
  // that scope says should be skipped.
  if (scopeMapping.stages[targetSlug] === "SKIP") {
    error(
      `Stage "${targetSlug}" is skipped for scope "${scope}". Choose a different target or change scope.`
    );
  }

  const graph = loadStageGraph();
  const targetIdx = stageIndex(targetSlug);
  const checkboxes = parseCheckboxes(content);

  // Build a lookup of current checkbox states
  const checkboxMap = new Map(checkboxes.map((c) => [c.slug, c.state]));

  const stagesSkipped: string[] = [];
  const stagesReset: string[] = [];

  // Detect test-run mode (persisted in state file by aidlc-utility enable-test-run)
  const testRunMode = (getField(content, "Test Run Mode") || "").toLowerCase() === "true";

  // Get current stage for audit
  const currentSlug = getField(content, "Current Stage") || "state-init";

  // States that count as "in-flight" (skip on forward jump, reset on backward jump)
  const IN_FLIGHT_STATES: CheckboxState[] = [
    "pending",
    "in-progress",
    "awaiting-approval",
    "revising",
  ];

  if (direction === "forward") {
    // Mark intermediate in-flight stages → [S], leave [x] alone
    const currentIdx = stageIndex(currentSlug);
    for (let i = currentIdx + 1; i < targetIdx; i++) {
      const slug = graph[i].slug;
      if (scopeMapping.stages[slug] !== "EXECUTE") continue;
      const state = checkboxMap.get(slug);
      if (state && IN_FLIGHT_STATES.includes(state)) {
        content = setCheckbox(content, slug, "skipped");
        stagesSkipped.push(slug);
      }
    }
    // Also mark the current stage if it's in-flight AND the target is further
    // forward (target !== current). When target === current, direction is "redo"
    // not "forward" — but guard explicitly in case caller mis-specifies.
    if (currentSlug !== targetSlug) {
      const currentState = checkboxMap.get(currentSlug);
      if (
        currentState &&
        currentState !== "pending" &&
        IN_FLIGHT_STATES.includes(currentState)
      ) {
        content = setCheckbox(content, currentSlug, "skipped");
        stagesSkipped.push(currentSlug);
      }
    }
  } else if (direction === "backward") {
    // Reset target + downstream [x]/[-]/[?]/[R]/[S] → [ ]
    const RESETTABLE: CheckboxState[] = [
      "completed",
      "in-progress",
      "awaiting-approval",
      "revising",
      "skipped",
    ];
    for (let i = targetIdx; i < graph.length; i++) {
      const slug = graph[i].slug;
      if (scopeMapping.stages[slug] !== "EXECUTE") continue;
      const state = checkboxMap.get(slug);
      if (state && RESETTABLE.includes(state)) {
        content = setCheckbox(content, slug, "pending");
        stagesReset.push(slug);
      }
    }
  } else {
    // redo: reset target only → [ ]
    content = setCheckbox(content, targetSlug, "pending");
    stagesReset.push(targetSlug);
  }

  // Mark target [-] so state and checkbox agree. This was missing before the
  // refactor — jump set Current Stage=target but left the checkbox at [ ]/[S]/
  // pending, causing an orchestrator to see an inconsistent state.
  content = setCheckbox(content, targetSlug, "in-progress");

  // Detect phase-boundary crossing. Jump asymmetry was a MAJOR finding —
  // advance emits PHASE_COMPLETED/VERIFIED/STARTED when crossing phases,
  // but jump did not. Now it does, matching the state machine contract.
  const currentStageForPhase = findStageBySlug(currentSlug);
  const crossesPhaseBoundary =
    !!currentStageForPhase && currentStageForPhase.phase !== targetStage.phase;

  // Update state fields
  const nextAfterTarget = nextInScopeStage(targetSlug, scope);
  const timestamp = isoTimestamp();

  // Determine terminal Status — test-run forward jumps to a named target end
  // the workflow; all other jumps leave it Running.
  const willTerminate = testRunMode && direction === "forward";

  content = setField(content, "Lifecycle Phase", targetStage.phase.toUpperCase());
  content = setField(content, "Current Stage", targetSlug);
  content = setField(content, "Next Stage", nextAfterTarget ? nextAfterTarget.slug : "none");
  content = setField(content, "Active Agent", targetStage.lead_agent);
  content = setField(content, "Status", willTerminate ? "Completed" : "Running");
  content = setField(content, "Last Updated", timestamp);
  content = setField(
    content,
    "In Progress",
    willTerminate ? "none" : targetSlug
  );
  content = setField(
    content,
    "Next Action",
    willTerminate ? `Test-run stopped at ${targetSlug}` : `Execute ${targetStage.name}`
  );

  // Count [x] checkboxes for Completed field
  const completedCount = countCheckboxes(content, "completed");
  content = setField(content, "Completed", String(completedCount));

  // Find last completed stage before target
  const allCheckboxes = parseCheckboxes(content);
  let lastCompleted = "state-init";
  for (let i = targetIdx - 1; i >= 0; i--) {
    const cb = allCheckboxes.find((c) => c.slug === graph[i].slug);
    if (cb && cb.state === "completed") {
      lastCompleted = graph[i].slug;
      break;
    }
  }
  content = setField(content, "Last Completed Stage", lastCompleted);

  // Atomic audit emissions (audit-first — throws before writeStateFile if any fail)
  try {
    // Per-stage STAGE_SKIPPED for every skipped stage (one event per [S] transition)
    for (const skippedSlug of stagesSkipped) {
      emitAudit(pd, "STAGE_SKIPPED", {
        Stage: skippedSlug,
        Reason: `Skipped by jump to ${targetSlug} (${direction})`,
      });
    }

    // Phase boundary events (if crossing phases — matches advance's contract)
    if (crossesPhaseBoundary && currentStageForPhase) {
      emitAudit(pd, "PHASE_COMPLETED", {
        "From phase": currentStageForPhase.phase,
        "To phase": targetStage.phase,
        "Stages completed": String(completedCount),
        Details: `Phase boundary crossed via ${direction} jump`,
      });
      emitAudit(pd, "PHASE_VERIFIED", {
        "Phase boundary": `${currentStageForPhase.phase} → ${targetStage.phase}`,
        Details: "Traceability verification on jump",
      });
      emitAudit(pd, "PHASE_STARTED", {
        Phase: targetStage.phase,
        Scope: scope,
      });
    }

    // The canonical STAGE_JUMPED event for the target itself
    emitAudit(pd, "STAGE_JUMPED", {
      Direction: direction.toUpperCase(),
      Source: currentSlug,
      Target: targetSlug,
      Scope: scope,
      Details: `${direction.toUpperCase()} jump from ${currentSlug} to ${targetSlug} (${targetStage.number}). Scope: ${scope}.`,
    });

    // Target enters Active state — emit STAGE_STARTED so audit reflects the
    // stage transition symmetric with advance's STAGE_STARTED emission.
    // Exception: test-run terminal case, where the workflow ends instead of
    // continuing into the target stage.
    if (!willTerminate) {
      emitAudit(pd, "STAGE_STARTED", {
        Stage: targetSlug,
        Agent: targetStage.lead_agent,
      });
    } else {
      // Test-run terminal — emit WORKFLOW_COMPLETED with reason instead
      emitAudit(pd, "WORKFLOW_COMPLETED", {
        Scope: scope,
        Details: `Test-run jump terminated at ${targetSlug}`,
        Reason: `test-run-stopped-at-${targetSlug}`,
      });
    }
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);
  const workflowStopped = willTerminate;

  console.log(
    JSON.stringify({
      direction,
      target: targetSlug,
      target_phase: targetStage.phase.toUpperCase(),
      stages_skipped: stagesSkipped,
      stages_reset: stagesReset,
      state_updated: true,
      audit_appended: true,
      completed_count: completedCount,
      workflow_stopped: workflowStopped,
      test_run_mode: testRunMode,
      timestamp,
    })
  );
}

// --- Utility ---

function error(msg: string): never {
  const pd = resolveProjectDir(projectDir);
  const command = `aidlc-jump ${process.argv.slice(2).join(" ")}`.trim();
  emitError(pd, "aidlc-jump", command, msg);
}
