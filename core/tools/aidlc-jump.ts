import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAuditEntry } from "./aidlc-audit.ts";
import { readReviewArtifactContexts } from "./aidlc-review-brief.ts";
import { DEFAULT_SUBPROCESS_TIMEOUT_MS } from "./aidlc-runtime-budget.ts";
import { isCompiledExecutable } from "./aidlc-runtime-paths.ts";
import { stageLabel } from "./aidlc-validity.ts";
import {
  addPendingPersonLines,
  type CheckboxState,
  countCheckboxes,
  emitError,
  errorMessage,
  extractMarkdownSection,
  findStageBySlug,
  firstInScopeStageOfPhase,
  getField,
  isPerUnitStage,
  isoTimestamp,
  loadScopeMapping,
  loadStageGraph,
  nextInScopeStage,
  PHASE_NUMBERS,
  PHASES,
  parseCheckboxes,
  parseStateStageSuffixes,
  readActiveDirectiveMarker,
  readStateFile,
  reviewArtifactEntries,
  resolveProjectDir,
  resolveStage,
  resolveWorkflowSelection,
  type StageEntry,
  setCheckbox,
  removeField,
  setField,
  setPhaseProgress,
  stageIndex,
  sourceBaselineAuditFields,
  toPosix,
  UNIT_NAME_REGEX,
  writeStateFile,
  REDO_REUSE_SOURCE,
  answerModeStageStartedFields,
  personsGateFeedback,
  resolveInvokingSessionId,
} from "./aidlc-lib.js";

// The EFFECTIVE per-stage action: the live state file's EXECUTE/SKIP suffix
// (a recomposed plan) wins over the static scope grid - the same resolution
// rule the router applies (nextInScopeStage's override seam). Every jump-side
// grid read goes through this so a jump and an advance can never disagree
// about which stages are on the plan.
function effectiveAction(
  suffixes: Map<string, "EXECUTE" | "SKIP">,
  scopeMapping: { stages: Record<string, string> },
  slug: string,
): string | undefined {
  return suffixes.get(slug) ?? scopeMapping.stages[slug];
}

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

// --- Audit emission helper ---
function emitAudit(
  pd: string,
  eventType: string,
  fields: Record<string, string>
): void {
  appendAuditEntry(eventType, fields, pd);
}

function stageArtifactPaths(pd: string, stage: StageEntry): string[] {
  const entries = reviewArtifactEntries(pd, stage) ?? [];
  return [...new Set(entries.map((entry) =>
    entry.path === null
      ? entry.logicalPath
      : toPosix(relative(pd, entry.path))
  ))].sort();
}

function existingStageArtifactPaths(pd: string, stage: StageEntry): string[] {
  return stageArtifactPaths(pd, stage).filter((path) =>
    existsSync(resolveProjectPath(pd, path))
  );
}

function resolveProjectPath(pd: string, path: string): string {
  return resolve(pd, path);
}

// The reviews a backward jump invalidates, named as `<artifact>#Review` where
// `<artifact>` is the reviewed artifact: the record-backed reviews the brief
// renders for the stage plus, for migration, any legacy embedded `## Review`
// section still sitting in a declared artifact.
function stageReviewPaths(pd: string, stage: StageEntry): string[] {
  const paths = new Set<string>();
  if (stage.reviewer) {
    try {
      for (const context of readReviewArtifactContexts(pd, stage)) {
        paths.add(`${context.artifact}#Review`);
      }
    } catch {
      // A malformed review is not a reason to refuse the jump; the embedded
      // scan below still names what it can.
    }
  }
  for (const path of existingStageArtifactPaths(pd, stage)) {
    try {
      if (
        extractMarkdownSection(
          readFileSync(resolveProjectPath(pd, path), "utf-8"),
          "## Review",
        ).length > 0
      ) {
        paths.add(`${path}#Review`);
      }
    } catch {
      // unreadable artifact: nothing to name
    }
  }
  return [...paths].sort();
}

// --- CLI entry point ---

let projectDir: string | undefined;

export function main(argv: string[]): void {
  const rawArgs = [...argv];

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
      case "reopen":
        handleReopen(filteredArgs.slice(1));
        break;
      default:
        error(`Unknown subcommand: ${subcommand}. Valid: resolve, execute, reopen`);
    }
  } catch (e) {
    error(errorMessage(e));
  }
}

// A forward jump says, in the person's terms, what it passed over and how to
// come back: jumping back to where they were resets those stages again. The
// agent repeats this as written, so a plugin's stage is named by its slug,
// never by its own display text.
export function forwardJumpNotice(
  target: { slug: string; name: string; plugin?: string },
  skipped: readonly { slug: string; name: string; plugin?: string }[],
  cameFrom: string,
): string {
  const names = skipped
    .map((node) => stageLabel(node, node.slug))
    .filter((name): name is string => name !== null);
  const list = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Moved to ${stageLabel(target, target.slug) ?? "that stage"}${list ? `; skipped ${list}` : ""}. ` +
    `You can go back to ${stageLabel(stageOrNone(cameFrom), cameFrom) ?? "where you were"} any time.`;
}

// A stage by slug, or none when the graph cannot be read: the line then says
// the slug, as stageLabel does for a stage it does not know.
function stageOrNone(slug: string): { slug: string; name: string; plugin?: string } | undefined {
  try {
    return findStageBySlug(slug);
  } catch {
    return undefined;
  }
}

// A backward jump says where it moved and how to return: the forward jump back
// to the step the person was on. It rides the next step the agent speaks from,
// because the backward instruction stays as the guard recovery knows it.
export function backwardJumpNotice(
  target: { slug: string; name: string; plugin?: string },
  from: { slug: string; name: string; plugin?: string },
): string {
  return `Moved back to ${stageLabel(target, target.slug) ?? "that stage"}. ` +
    `You can return to ${stageLabel(from, from.slug) ?? "where you were"} any time.`;
}

if (import.meta.main) {
  main(process.argv.slice(2));
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

// --- Subcommand: reopen ---
//
// Reopen one per-unit stage for the named Units only (#1411). Construction that
// runs one unit at a time keeps Current Stage on the first per-unit stage, so a
// jump back to a stage a Unit already finished would be a stage-wide jump that
// starts every Unit's finished work over. Reopening writes, per Unit, the same
// Unit-scoped GATE_REJECTED a Unit checkpoint's Request Changes writes: a new
// attempt for exactly that Unit and stage, so the walk takes only that Unit
// through it again. Every other Unit keeps its finished, approved work. Inside
// the walk nothing else changes: no checkbox, no Current Stage, no files. Once
// the walk has moved on to a later stage, the work moves back to the target.
// `--via change` is the person's change at the open late question: the rows
// keep their words as the change.
// The active Unit's lifecycle mirror is dropped; the next `unit start` writes
// it again.

function handleReopen(args: string[]): void {
  const flags = parseFlags(args);
  const pd = resolveProjectDir(projectDir);
  let content = readStateFile(pd);
  const targetSlug = flags.target;
  const units = (flags.units ?? "").split(",").map((unit) => unit.trim()).filter(Boolean);
  if (!targetSlug || units.length === 0) {
    error("Usage: reopen --target <slug> [--stages <slug[,slug...]>] --units <unit[,unit...]> [--via redo|change] [--scope <scope>]");
  }
  // `--via redo`: the person asked to redo the step on re-entry, not a jump.
  // `--via change`: the person asked for a change at the open gate, and it
  // belongs to these Units' step.
  if (flags.via !== undefined && flags.via !== "redo" && flags.via !== "change") {
    error(`Unknown --via: ${flags.via} (only "redo" or "change")`);
  }
  const targetStage = findStageBySlug(targetSlug);
  if (!targetStage || !isPerUnitStage(targetStage)) error(`Not a per-unit stage: ${targetSlug}`);
  // The target and the later per-unit steps it reopens with it.
  const stages = (flags.stages ?? targetSlug).split(",").map((slug) => slug.trim()).filter(Boolean);
  if (stages[0] !== targetSlug) error(`--stages must start with the target "${targetSlug}"`);
  for (const slug of stages) {
    const stage = findStageBySlug(slug);
    if (!stage || !isPerUnitStage(stage)) error(`Not a per-unit stage: ${slug}`);
  }
  for (const unit of units) {
    if (!UNIT_NAME_REGEX.test(unit)) error(`Invalid Unit name: ${unit}`);
  }
  const stageName = targetStage.name ?? targetSlug;
  // A change is kept in the person's own words, from the gate they answered.
  const gateStage = getField(content, "Current Stage")?.trim() ?? targetSlug;
  const changeWords = flags.via === "change"
    ? personsGateFeedback(pd, resolveInvokingSessionId(pd), { stage: gateStage })
    : null;
  for (const unit of units) {
    emitAudit(pd, "GATE_REJECTED", {
      Stage: targetSlug,
      "Gate Stages": stages.join(", "),
      "Gate Scope": "unit-end",
      Unit: unit,
      // Marks the row as the person's redo or jump, or the change they asked
      // for at the gate.
      Reopen: flags.via ?? "jump",
      ...(flags.via === "change" ? { "User Input": "Request Changes" } : {}),
      Feedback: flags.via === "redo"
        ? `Redid ${stageName} for unit ${unit} at the person's request (redo on re-entry).`
        : flags.via === "change"
          ? changeWords ?? `Reopened ${stageName} for unit ${unit} for a change.`
          : `Reopened ${stageName} for unit ${unit} (/aidlc --stage ${targetSlug}).`,
    });
    // Redo is the person's answer to the re-use question for this Unit's step
    // too: recorded here, so the reopened step redoes it without asking again.
    if (flags.via === "redo") {
      emitAudit(pd, "ARTIFACT_REUSED", {
        Stage: targetSlug,
        Decision: "redo",
        Artifacts: `construction/${unit}/${targetSlug}/`,
        Unit: unit,
        Source: REDO_REUSE_SOURCE,
      });
    }
  }
  for (const field of ["Active Unit", "Unit Stage", "Unit State", "Unit Pause Reason", "Unit Next Action"]) {
    content = removeField(content, field);
  }
  content = setField(content, "Last Updated", isoTimestamp());
  // From a later stage of the same phase (Build and Test, say) the work moves
  // back to the target as a backward jump moves it, but with no STAGE_JUMPED:
  // only these Units start the step again.
  const current = getField(content, "Current Stage")?.trim() ?? "";
  const from = findStageBySlug(current);
  let stagesReset: string[] = [];
  if (from && !isPerUnitStage(from) && from.phase === targetStage.phase && stageIndex(current) > stageIndex(targetSlug)) {
    const scope = flags.scope || getField(content, "Scope") || "feature";
    const scopeMapping = loadScopeMapping()[scope];
    if (!scopeMapping) error(`Unknown scope: ${scope}`);
    const suffixes = scope === (getField(content, "Scope") || "")
      ? parseStateStageSuffixes(content)
      : new Map<string, "EXECUTE" | "SKIP">();
    const moved = movedState(content, targetSlug, targetStage, "backward", scope, suffixes, scopeMapping);
    content = moved.content;
    stagesReset = moved.stagesReset;
  }
  writeStateFile(pd, content);
  console.log(JSON.stringify({
    reopened: targetSlug, stages, units, ...(stagesReset.length > 0 ? { stages_reset: stagesReset } : {}),
    state_updated: true, audit_appended: true,
  }));
}

// --- Subcommand: resolve ---

function handleResolve(args: string[]): void {
  // --allow-skipped: resolve a --stage target the plan skips instead of
  // refusing it, marked target_skipped, so the engine can put it back on the
  // plan before the jump (the person asked for that stage by name).
  const allowSkipped = args.includes("--allow-skipped");
  const flags = parseFlags(args.filter((arg) => arg !== "--allow-skipped"));
  const pd = resolveProjectDir(projectDir);
  const content = readStateFile(pd);

  // Determine scope
  const scope = flags.scope || getField(content, "Scope") || "feature";
  const scopeMapping = loadScopeMapping()[scope];
  if (!scopeMapping) error(`Unknown scope: ${scope}`);
  // The live plan's per-stage suffix overrides (a recomposed plan) - every
  // grid read below resolves through effectiveAction so a suffix-promoted
  // stage is jumpable and a suffix-SKIPped one is refused, matching the
  // router's own resolution. ONLY when the resolved scope IS the state's own
  // scope: an explicit `--scope <other>` asks about a DIFFERENT scope's plan,
  // and the state's suffixes describe the current plan, not that one.
  const suffixes =
    scope === (getField(content, "Scope") || "")
      ? parseStateStageSuffixes(content)
      : new Map<string, "EXECUTE" | "SKIP">();

  // Determine current position
  const currentSlug = getField(content, "Current Stage") || "state-init";
  const currentStage = resolveStage(currentSlug);
  if (!currentStage) error(`Cannot resolve current stage: ${currentSlug}`);

  // Resolve target
  let targetStage: StageEntry | null = null;
  let targetSkipped = false;

  if (flags.stage) {
    targetStage = resolveStage(flags.stage) || null;
    if (!targetStage) error(`Unknown stage: ${flags.stage}`);

    // Check if target is on the EFFECTIVE plan (suffix override wins).
    if (effectiveAction(suffixes, scopeMapping, targetStage.slug) === "SKIP") {
      if (!allowSkipped) {
        error(
          `Stage "${targetStage.slug}" is skipped for scope "${scope}". Use \`next --stage ${targetStage.slug}\`, which handles a stage the plan skips.`
        );
      }
      targetSkipped = true;
    }
  } else if (flags.phase) {
    const phaseInput = flags.phase.toLowerCase();
    const canonicalPhase =
      PHASE_NUMBERS[phaseInput] ||
      ((PHASES as readonly string[]).includes(phaseInput) ? phaseInput : null);
    if (!canonicalPhase) error(`Unknown phase: ${flags.phase}`);

    // The first EFFECTIVE-EXECUTE stage of the phase: walk the full graph in
    // order applying the suffix override, so a recomposed plan targets the
    // stage the router would actually run first. Falls back to the static
    // firstInScopeStageOfPhase result when no suffix touches the phase (the
    // two agree on an unrecomposed plan).
    const graphForPhase = loadStageGraph();
    targetStage =
      graphForPhase.find(
        (s) =>
          s.phase === canonicalPhase &&
          effectiveAction(suffixes, scopeMapping, s.slug) === "EXECUTE",
      ) ?? firstInScopeStageOfPhase(canonicalPhase, scope);
    if (!targetStage) {
      error(
        `Phase "${canonicalPhase}" has no executable stages for scope "${scope}".`
      );
    }
  } else {
    error("Usage: resolve --stage <slug|#> [--allow-skipped] or --phase <name|#> [--scope <scope>]");
  }

  // Determine direction
  const currentIdx = stageIndex(currentStage.slug);
  const targetIdx = stageIndex(targetStage.slug);

  let direction: "forward" | "backward" | "redo";
  if (targetIdx > currentIdx) direction = "forward";
  else if (targetIdx < currentIdx) direction = "backward";
  else direction = "redo";

  // Compute affected stages (against the EFFECTIVE plan, not the static grid)
  const graph = loadStageGraph();
  const affectedSlugs: string[] = [];

  if (direction === "forward") {
    // Stages between current (exclusive) and target (exclusive)
    for (let i = currentIdx + 1; i < targetIdx; i++) {
      if (effectiveAction(suffixes, scopeMapping, graph[i].slug) === "EXECUTE") {
        affectedSlugs.push(graph[i].slug);
      }
    }
  } else if (direction === "backward") {
    // Target and all stages after (on the effective plan)
    for (let i = targetIdx; i < graph.length; i++) {
      if (effectiveAction(suffixes, scopeMapping, graph[i].slug) === "EXECUTE") {
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
      ...(targetSkipped ? { target_skipped: true } : {}),
      valid: true,
    })
  );
}

// The state a jump to `targetSlug` leaves: the stages it skips (forward) or
// resets (backward: the target and every later stage on the effective plan),
// the target in progress, and Current Stage with its projections on the
// target. `execute` writes it with its STAGE_JUMPED; a reopen from a later
// stage writes it with the Units' own rejections instead.
function movedState(
  content: string,
  targetSlug: string,
  targetStage: StageEntry,
  direction: "forward" | "backward" | "redo",
  scope: string,
  suffixes: Map<string, "EXECUTE" | "SKIP">,
  scopeMapping: { stages: Record<string, string> },
): {
  content: string;
  stagesSkipped: string[];
  stagesReset: string[];
  currentSlug: string;
  currentStageForPhase: StageEntry | undefined;
  crossesPhaseBoundary: boolean;
  completedCount: number;
  timestamp: string;
} {
  const graph = loadStageGraph();
  const targetIdx = stageIndex(targetSlug);
  const checkboxes = parseCheckboxes(content);

  // Build a lookup of current checkbox states
  const checkboxMap = new Map(checkboxes.map((c) => [c.slug, c.state]));

  const stagesSkipped: string[] = [];
  const stagesReset: string[] = [];

  const currentSlug = getField(content, "Current Stage") || "state-init";

  // States that count as "in-flight" (skip on forward jump, reset on backward jump)
  const IN_FLIGHT_STATES: CheckboxState[] = [
    "pending",
    "in-progress",
    "awaiting-approval",
    "revising",
  ];

  if (direction === "forward") {
    // Mark intermediate in-flight stages → [S], leave [x] alone. Gate on the
    // EFFECTIVE plan so a recompose-ADDed stage (grid SKIP, suffix EXECUTE)
    // is marked [S] like any other on-plan stage, and a recompose-SKIPped one
    // is passed over.
    const currentIdx = stageIndex(currentSlug);
    for (let i = currentIdx + 1; i < targetIdx; i++) {
      const slug = graph[i].slug;
      if (effectiveAction(suffixes, scopeMapping, slug) !== "EXECUTE") continue;
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
      // Effective plan again: a recompose-ADDed stage's [x] is reset by a
      // backward jump like any on-plan stage (ADD-then-jump consistency).
      if (effectiveAction(suffixes, scopeMapping, slug) !== "EXECUTE") continue;
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

  // Update state fields. Thread the (post-edit) state content so the Next
  // Stage projection honours suffix overrides + checkboxes - the advance
  // precedent's threading, applied to the jump path.
  const nextAfterTarget = nextInScopeStage(targetSlug, scope, content);
  const timestamp = isoTimestamp();

  content = setField(content, "Lifecycle Phase", targetStage.phase.toUpperCase());
  content = setField(content, "Current Stage", targetSlug);
  // The active Unit's lifecycle mirror describes the step the jump left: its
  // STAGE_JUMPED starts a new attempt, and the next `unit start` writes the
  // mirror again, so a new chat and --status never name the abandoned step.
  for (const field of ["Active Unit", "Unit Stage", "Unit State", "Unit Pause Reason", "Unit Next Action"]) {
    content = removeField(content, field);
  }
  content = setField(content, "Next Stage", nextAfterTarget ? nextAfterTarget.slug : "none");
  content = setField(content, "Active Agent", targetStage.lead_agent);
  content = setField(content, "Status", "Running");
  content = setField(content, "Last Updated", timestamp);
  content = setField(content, "In Progress", targetSlug);
  content = setField(content, "Next Action", `Execute ${targetStage.name}`);

  // Count [x] checkboxes for Completed field
  const completedCount = countCheckboxes(content, "completed");
  content = setField(content, "Completed", String(completedCount));

  // Phase Progress rows track the boundary crossing the audit trio below
  // records. Forward: the source phase's remaining work was force-[S]'d and
  // PHASE_VERIFIED is emitted, so its row reads Verified; any phase jumped
  // over entirely reads Skipped. Backward (or a caller-mis-specified redo
  // that crosses a boundary): every phase after the target just had its
  // EXECUTE stages reset to pending above, so those rows return to Pending,
  // leaving zero-EXECUTE phases in their initial Skipped state. Either way the
  // target's phase is now the active one.
  if (crossesPhaseBoundary && currentStageForPhase) {
    const phaseIdx = (p: string): number =>
      (PHASES as readonly string[]).indexOf(p);
    if (direction === "forward") {
      content = setPhaseProgress(content, currentStageForPhase.phase, "Verified");
      for (
        let i = phaseIdx(currentStageForPhase.phase) + 1;
        i < phaseIdx(targetStage.phase);
        i++
      ) {
        content = setPhaseProgress(content, PHASES[i], "Skipped");
      }
    } else {
      for (let i = phaseIdx(targetStage.phase) + 1; i < PHASES.length; i++) {
        const p = PHASES[i];
        const hasExecute = graph.some(
          (s) =>
            s.phase === p &&
            effectiveAction(suffixes, scopeMapping, s.slug) === "EXECUTE"
        );
        if (hasExecute) content = setPhaseProgress(content, p, "Pending");
      }
    }
    content = setPhaseProgress(content, targetStage.phase, "Active");
  }

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
  return {
    content, stagesSkipped, stagesReset, currentSlug, currentStageForPhase,
    crossesPhaseBoundary, completedCount, timestamp,
  };
}

// --- Subcommand: execute ---

function handleExecute(args: string[]): void {
  const flags = parseFlags(args);
  const pd = resolveProjectDir(projectDir);
  let content = readStateFile(pd);

  const targetSlug = flags.target;
  if (!targetSlug) error("Usage: execute --target <slug> --direction <forward|backward|redo> [--units <unit[,unit...]> [--stages <slug[,slug...]>]] [--scope <scope>]");

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
  // The live plan's suffix overrides - execute resolves the same EFFECTIVE
  // plan resolve does (see effectiveAction), so a recomposed stage is
  // reachable and a recompose-SKIPped one refused here too. Same
  // scope-matches-state guard as resolve: a foreign --scope consults the
  // static grid only.
  const suffixes =
    scope === (getField(content, "Scope") || "")
      ? parseStateStageSuffixes(content)
      : new Map<string, "EXECUTE" | "SKIP">();

  const targetStage = findStageBySlug(targetSlug);
  if (!targetStage) error(`Unknown stage: ${targetSlug}`);

  // Scope validation - target must be EXECUTE on the EFFECTIVE plan (mirrors
  // resolve). Without this, an orchestrator bypassing resolve can land the
  // workflow on a stage the plan says should be skipped.
  if (effectiveAction(suffixes, scopeMapping, targetSlug) === "SKIP") {
    error(
      `Stage "${targetSlug}" is skipped for scope "${scope}". Use \`next --stage ${targetSlug}\`, which handles a stage the plan skips.`
    );
  }

  if (flags.units !== undefined) {
    executeUnitsForward(pd, flags, targetStage, direction);
    return;
  }

  const graph = loadStageGraph();
  // Get current stage for audit
  const currentSlug = getField(content, "Current Stage") || "state-init";
  // Where the person was: the active Unit's own step in a unit-at-a-time walk,
  // which Current Stage does not name, or else the step the engine last put to
  // them (a Unit's code plan, say) while it still matches this state.
  const unitStage = getField(content, "Unit Stage")?.trim() ?? "";
  const shownStage = readActiveDirectiveMarker(pd, content)?.stage?.trim() ?? "";
  const cameFrom = graph.some((node) => node.slug === unitStage)
    ? unitStage
    : shownStage !== targetSlug && graph.some((node) => node.slug === shownStage) ? shownStage : currentSlug;
  const moved = movedState(content, targetSlug, targetStage, direction, scope, suffixes, scopeMapping);
  content = moved.content;
  const { stagesSkipped, stagesReset, currentStageForPhase, crossesPhaseBoundary, completedCount, timestamp } = moved;

  // One content-addressed snapshot is shared by both rows in the jump
  // transition. The companion STAGE_STARTED repeats the SAME authority rather
  // than creating a competing snapshot or clearing the jump boundary.
  const jumpSourceBaseline = sourceBaselineAuditFields(
    pd,
    "code-generation",
  );
  const changedUpstreamArtifacts =
    direction === "backward" ? stageArtifactPaths(pd, targetStage) : [];
  const downstreamStages = direction === "backward"
    ? stagesReset
      .filter((slug) => slug !== targetSlug)
      .map((slug) => findStageBySlug(slug))
      .filter((stage): stage is StageEntry => stage !== undefined)
    : [];
  const invalidatedDownstreamArtifacts = [
    ...new Set(
      downstreamStages.flatMap((stage) =>
        existingStageArtifactPaths(pd, stage)
      ),
    ),
  ].sort();
  const invalidatedDownstreamReviews = [
    ...new Set(downstreamStages.flatMap((stage) => stageReviewPaths(pd, stage))),
  ].sort();

  // Atomic audit emissions (audit-first — throws before writeStateFile if any fail)
  try {
    // Per-stage STAGE_SKIPPED for every skipped stage (one event per [S] transition)
    for (const skippedSlug of stagesSkipped) {
      emitAudit(pd, "STAGE_SKIPPED", {
        Stage: skippedSlug,
        Reason: `Skipped by jump to ${targetSlug} (${direction})`,
        "Skip Kind": "jump",
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

    // The jump boundary owns the baseline. Its companion STAGE_STARTED repeats
    // this exact field so stage-major consumers see one stable transition.
    emitAudit(pd, "STAGE_JUMPED", {
      Direction: direction.toUpperCase(),
      Source: currentSlug,
      Target: targetSlug,
      Scope: scope,
      Details: `${direction.toUpperCase()} jump from ${currentSlug} to ${targetSlug} (${targetStage.number}). Scope: ${scope}.`,
      ...(direction === "backward"
        ? {
            "Changed Upstream Artifacts":
              JSON.stringify(changedUpstreamArtifacts),
            "Invalidated Downstream Artifacts":
              JSON.stringify(invalidatedDownstreamArtifacts),
            "Invalidated Downstream Reviews":
              JSON.stringify(invalidatedDownstreamReviews),
          }
        : {}),
      ...jumpSourceBaseline,
    });

    // Target enters Active state — emit STAGE_STARTED so audit reflects the
    // stage transition symmetric with advance's STAGE_STARTED emission.
    emitAudit(pd, "STAGE_STARTED", {
      Stage: targetSlug,
      Agent: targetStage.lead_agent,
      ...answerModeStageStartedFields(pd),
      ...jumpSourceBaseline,
    });
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);

  // The jump is done, so the way back can never fail it. When no chat can
  // hold the line for the next step, it rides the tool's output instead.
  const from = graph.find((node) => node.slug === cameFrom);
  let backNotice: string | undefined;
  if (direction === "backward" && from) {
    backNotice = backwardJumpNotice(targetStage, from);
    try {
      const session = resolveWorkflowSelection(pd).sessionId;
      if (session && addPendingPersonLines(pd, session, [backNotice])) backNotice = undefined;
    } catch {
      // No chat to hold it: the output carries it.
    }
  }
  const notice = direction === "forward"
    ? forwardJumpNotice(targetStage, graph.filter((node) => stagesSkipped.includes(node.slug)), cameFrom)
    : backNotice;

  console.log(
    JSON.stringify({
      direction,
      target: targetSlug,
      target_phase: targetStage.phase.toUpperCase(),
      ...(notice ? { notice } : {}),
      stages_skipped: stagesSkipped,
      stages_reset: stagesReset,
      state_updated: true,
      audit_appended: true,
      completed_count: completedCount,
      workflow_stopped: false,
      timestamp,
    })
  );
}

// `execute --units`: a forward jump in Construction that runs one unit at a
// time moves only the named Units on (#1411). Each named step is skipped for
// those Units with the state tool's own one-Unit skip, so every other Unit
// keeps its finished work, reviews, Plan Approvals and checkpoint approvals:
// no STAGE_JUMPED, no checkbox the other Units still owe, no Current Stage
// move. The engine names the steps (the ones the walk would stop these Units
// at before the target), and stages_skipped is exactly those steps.
function executeUnitsForward(
  pd: string,
  flags: Record<string, string>,
  targetStage: StageEntry,
  direction: string,
): void {
  const units = flags.units.split(",").map((unit) => unit.trim()).filter(Boolean);
  if (direction !== "forward" || units.length === 0 || !isPerUnitStage(targetStage)) {
    error(
      "execute --units moves Units forward to a per-unit stage: " +
        "--direction forward --units <unit[,unit...]> [--stages <slug[,slug...]>]",
    );
  }
  for (const unit of units) {
    if (!UNIT_NAME_REGEX.test(unit)) error(`Invalid Unit name: ${unit}`);
  }
  const stages = (flags.stages ?? "").split(",").map((slug) => slug.trim()).filter(Boolean);
  for (const slug of stages) {
    const stage = findStageBySlug(slug);
    if (!stage || !isPerUnitStage(stage) || stageIndex(slug) >= stageIndex(targetStage.slug)) {
      error(`Not a per-unit stage before ${targetStage.slug}: ${slug}`);
    }
  }
  for (const slug of stages) {
    for (const unit of units) {
      const run = runStateTool(pd, [
        "skip", slug, "--unit", unit, "--reason", `Skipped by jump to ${targetStage.slug} (${direction})`,
      ]);
      if (!run.ok) error(toolError(run));
    }
  }
  // The active Unit's lifecycle mirror describes the step it left; the next
  // `unit start` writes it again.
  let content = readStateFile(pd);
  if (units.includes(getField(content, "Active Unit")?.trim() ?? "")) {
    for (const field of ["Active Unit", "Unit Stage", "Unit State", "Unit Pause Reason", "Unit Next Action"]) {
      content = removeField(content, field);
    }
  }
  const timestamp = isoTimestamp();
  content = setField(content, "Last Updated", timestamp);
  writeStateFile(pd, content);
  console.log(
    JSON.stringify({
      direction,
      target: targetStage.slug,
      target_phase: targetStage.phase.toUpperCase(),
      units,
      stages_skipped: stages,
      stages_reset: [],
      state_updated: true,
      audit_appended: stages.length > 0,
      completed_count: countCheckboxes(content, "completed"),
      workflow_stopped: false,
      timestamp,
    })
  );
}

// The state tool, run as its own command: it owns the one-Unit skip, and
// accepts it from this process only (the token names this PID). The child is
// the state tool this jump tool ships with, never one an environment variable
// names, because it carries that token.
function runStateTool(pd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const command = isCompiledExecutable()
    ? [process.execPath, "engine", "state", ...args, "--project-dir", pd]
    : [process.execPath, join(TOOLS_DIR, "aidlc-state.ts"), ...args, "--project-dir", pd];
  const result = spawnSync(command[0], command.slice(1), {
    encoding: "utf-8",
    cwd: pd,
    timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS,
    env: { ...process.env, AIDLC_PROJECT_DIR: pd, AIDLC_STATE_TRANSITION_OWNER: `jump:${process.pid}` },
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// The message of a tool's `{"error": ...}` envelope, or its raw stderr.
function toolError(run: { stderr: string }): string {
  const raw = run.stderr.trim();
  try {
    const parsed = JSON.parse(raw.split(/\r?\n/).find((line) => line.startsWith("{")) ?? raw) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not the envelope: the raw text below.
  }
  return raw || "the state tool failed";
}

// --- Utility ---

function error(msg: string): never {
  const pd = resolveProjectDir(projectDir);
  const command = `aidlc-jump ${process.argv.slice(2).join(" ")}`.trim();
  emitError(pd, "aidlc-jump", command, msg);
}
