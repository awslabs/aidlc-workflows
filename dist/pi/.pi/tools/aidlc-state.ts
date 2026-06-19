import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry, appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import {
  appendSlug,
  appendUnderHeading,
  auditFilePath,
  type CheckboxState,
  countCheckboxes,
  emitError,
  errorMessage,
  extractMarkdownSection,
  findStageBySlug,
  findAllEvents,
  firstInScopeStageOfPhase,
  getField,
  holdsAuditLock,
  isoTimestamp,
  loadScopeMapping,
  nextInScopeStage,
  PHASE_NUMBERS,
  PHASES,
  parseCheckboxes,
  parseRefsList,
  parseStateStageSuffixes,
  readStateFile,
  removeSlug,
  replaceSection,
  resolveProjectDir,
  resolveStage,
  setCheckbox,
  setField,
  setFieldStrict,
  setOrInsertField,
  stagesInScope,
  validScopes,
  withAuditLock,
  worktreePath,
  writeStateFile,
  harnessDir,
  rulesSubdir,
} from "./aidlc-lib.js";

// All valid checkbox states (lib.ts adds [?] awaiting-approval and [R] revising)
const VALID_CHECKBOX_STATES: CheckboxState[] = [
  "pending",
  "in-progress",
  "awaiting-approval",
  "revising",
  "completed",
  "skipped",
];

function isCheckboxState(s: string): s is CheckboxState {
  return (VALID_CHECKBOX_STATES as readonly string[]).includes(s);
}

// --- Audit emission helper ---
// Uses the throw-on-error appendAuditEntry (not handleAppend which writes JSON to stdout).
// Caller wraps in try/catch; a thrown exception is the signal that audit failed and
// the state write should not proceed.
//
// Lock-aware: when the caller is mid-transaction inside a withAuditLock (the
// C2b lost-update wrapping — every RMW handler below holds the lock across
// read→decide→emit→write), this process already owns the OS lock. Routing
// through appendAuditEntry (which calls the NON-reentrant acquireAuditLock)
// would self-deadlock and burn the 5s retry budget before throwing, so detect
// the held lock and use the unlocked append variant instead — exactly how
// handleFork/handleMerge emit (appendAuditEntryUnlocked) and how emitError
// branches in aidlc-lib.ts. Outside a held lock (no current caller, but kept
// safe for any future bare-emit site) it takes its own lock as before.
function emitAudit(
  projectDir: string,
  eventType: string,
  fields: Record<string, string>
): void {
  if (holdsAuditLock(projectDir)) {
    appendAuditEntryUnlocked(eventType, fields, projectDir);
  } else {
    appendAuditEntry(eventType, fields, projectDir);
  }
}

function auditField(block: string, fieldName: string): string | null {
  const prefix = `**${fieldName}**:`;
  for (const line of block.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

function hasStageAuditEvent(
  projectDir: string,
  eventType: string,
  stageSlug: string
): boolean {
  const path = auditFilePath(projectDir);
  if (!existsSync(path)) return false;
  const audit = readFileSync(path, "utf-8");
  const workflowStarts = findAllEvents(audit, "WORKFLOW_STARTED");
  const since = workflowStarts.length > 0
    ? workflowStarts[workflowStarts.length - 1].timestamp
    : "";
  return findAllEvents(audit, eventType).some((ev) => {
    if (since && ev.timestamp < since) return false;
    // Rows committed by a `--single` stage-runner run carry a synthetic
    // `Workflow: single-stage:<slug>` id and belong to no main workflow —
    // they must never satisfy a main-workflow dedup check (a single run's
    // STAGE_COMPLETED would otherwise suppress the main workflow's own
    // emission for the same slug). Main-workflow rows carry no Workflow field.
    if (auditField(ev.block, "Workflow")?.startsWith("single-stage:")) {
      return false;
    }
    return auditField(ev.block, "Stage") === stageSlug;
  });
}

// --- Slug + small helpers (used by fork/merge handlers below; declared
// before main() so they're initialised before dispatch fires) ---

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

function validateSlug(slug: string | undefined): string {
  if (!slug) errorWithSlug("(missing)", `Missing --slug <slug>`);
  if (!SLUG_RE.test(slug)) {
    errorWithSlug(slug, `Invalid --slug: "${slug}". Must be kebab-case (lowercase letter then [a-z0-9-]).`);
  }
  return slug;
}

function errorWithSlug(slug: string, msg: string): never {
  error(`[slug=${slug}] ${msg}`);
}

function sha256(buf: string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && i + 1 < args.length) {
      flags[a.slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

// --- CLI entry point ---

let projectDir: string | undefined;

function main(): void {
  const args = process.argv.slice(2);

  // Extract --project-dir flag
  const pdIdx = args.indexOf("--project-dir");
  if (pdIdx !== -1 && pdIdx + 1 < args.length) {
    projectDir = args[pdIdx + 1];
    args.splice(pdIdx, 2);
  }

  const subcommand = args[0];

  try {
    switch (subcommand) {
      case "get":
        handleGet(args.slice(1));
        break;
      case "set":
        handleSet(args.slice(1));
        break;
      case "set-skeleton-stance":
        handleSetSkeletonStance(args.slice(1));
        break;
      case "checkbox":
        handleCheckbox(args.slice(1));
        break;
      case "count":
        handleCount(args.slice(1));
        break;
      case "advance":
        handleAdvance(args.slice(1));
        break;
      case "finalize":
        handleFinalize(args.slice(1));
        break;
      case "complete-workflow":
        handleCompleteWorkflow(args.slice(1));
        break;
      case "gate-start":
        handleGateStart(args.slice(1));
        break;
      case "approve":
        handleApprove(args.slice(1));
        break;
      case "reject":
        handleReject(args.slice(1));
        break;
      case "revise":
        handleRevise(args.slice(1));
        break;
      case "skip":
        handleSkip(args.slice(1));
        break;
      case "resume":
        handleResume(args.slice(1));
        break;
      case "acknowledge-compaction":
        handleAcknowledgeCompaction(args.slice(1));
        break;
      case "reuse-artifact":
        handleReuseArtifact(args.slice(1));
        break;
      case "lookup":
        handleLookup(args.slice(1));
        break;
      case "practices-event":
        handlePracticesEvent(args.slice(1));
        break;
      case "practices-promote":
        handlePracticesPromote(args.slice(1));
        break;
      case "fork":
        handleFork(args.slice(1));
        break;
      case "merge":
        handleMerge(args.slice(1));
        break;
      default:
        error(
          `Unknown subcommand: ${subcommand}. Valid: get, set, set-skeleton-stance, checkbox, count, advance, finalize, complete-workflow, gate-start, approve, reject, revise, skip, resume, acknowledge-compaction, reuse-artifact, lookup, practices-event, practices-promote, fork, merge`
        );
    }
  } catch (e) {
    error(errorMessage(e));
  }
}

if (import.meta.main) {
  main();
}

// --- Subcommand handlers ---

function handleGet(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts get <field>");
  const field = args.join(" ");
  const pd = resolveProjectDir(projectDir);
  const content = readStateFile(pd);
  const value = getField(content, field);
  if (value === null) {
    error(`Field not found: ${field}`);
  }
  console.log(value);
}

function handleSet(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts set <field=value> ...");
  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: hold the audit lock across read→decide→write so
  // two concurrent `set`s of different fields can't clobber each other (A reads
  // V1, B reads V1, A writes V2, B writes V1.5 → A's field lost). The +1/-1
  // increment forms are especially exposed — they read-modify a counter.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  for (const pair of args) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx <= 0) error(`Invalid field=value pair: ${pair}`);
    const field = pair.slice(0, eqIdx);
    let value = pair.slice(eqIdx + 1);

    // Special values
    if (value === "NOW") {
      value = isoTimestamp();
    } else if (value === "+1") {
      const current = getField(content, field);
      const num = current ? parseInt(current, 10) : 0;
      value = String(num + 1);
    } else if (value === "-1") {
      const current = getField(content, field);
      const num = current ? parseInt(current, 10) : 0;
      value = String(Math.max(0, num - 1));
    }

    content = setField(content, field, value);
  }

  writeStateFile(pd, content);
  console.log(JSON.stringify({ updated: true, fields: args.length }));
  });
}

// set-skeleton-stance <on|off|scope-dependent> — record the conductor's
// classified walking-skeleton stance (the classify round-trip). The
// `Skeleton Stance` field is runtime metadata (like Revision Count): it is NOT
// in the base state template, so we use setOrInsertField to update-if-present /
// insert-under-`## Runtime State`-if-absent (mirrors aidlc-bolt.ts's Merge-Held
// pattern for a runtime-only field). No audit row — the stance is metadata the
// next `aidlc-orchestrate next` reads to resolve the deferred Construction
// Bolt-1 gate, not a state-machine transition; it rides no event, exactly like
// `set` itself. The orchestration engine shells out to THIS subcommand rather
// than writing state itself (the engine writes nothing).
function handleSetSkeletonStance(args: string[]): void {
  // Declared inside the handler: `main()` is invoked at module load before a
  // module-level const further down would initialise (TDZ), so the value set
  // lives here, where it is reached only when the subcommand runs.
  const skeletonStanceValues = ["on", "off", "scope-dependent"];
  if (args.length < 1) {
    error(
      `Usage: aidlc-state.ts set-skeleton-stance <${skeletonStanceValues.join("|")}>`,
    );
  }
  const stance = args[0];
  if (!skeletonStanceValues.includes(stance)) {
    error(
      `Invalid skeleton stance "${stance}". Valid: ${skeletonStanceValues.join(", ")}.`,
    );
  }
  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: read→write under one lock (a concurrent `set` of an
  // unrelated field must not lose this stance write, nor vice versa).
  withAuditLock(pd, () => {
  const content = readStateFile(pd);
  const updated = setOrInsertField(
    content,
    "## Runtime State",
    "Skeleton Stance",
    stance,
  );
  writeStateFile(pd, updated);
  console.log(JSON.stringify({ updated: true, skeleton_stance: stance }));
  });
}

function handleCheckbox(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts checkbox <slug=state> ...");
  const pd = resolveProjectDir(projectDir);

  // Parse + validate args BEFORE taking the lock — pure input checks that
  // touch no shared state, so they fail fast without holding the lock.
  const changes: Array<{ slug: string; state: CheckboxState }> = [];
  for (const pair of args) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx <= 0) error(`Invalid slug=state pair: ${pair}`);
    const slug = pair.slice(0, eqIdx);
    const stateStr = pair.slice(eqIdx + 1);
    if (!isCheckboxState(stateStr)) {
      error(`Invalid state: ${stateStr}. Valid: ${VALID_CHECKBOX_STATES.join(", ")}`);
    }
    changes.push({ slug, state: stateStr });
  }

  // C2b lost-update safety: read→apply→count→write under one lock so the
  // Completed counter resync sees a consistent snapshot (a concurrent checkbox
  // flip between our read and write would otherwise desync the count).
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  for (const { slug, state } of changes) {
    content = setCheckbox(content, slug, state);
  }

  // Sync Completed counter to actual [x] count
  const completedCount = countCheckboxes(content, "completed");
  content = setField(content, "Completed", String(completedCount));

  writeStateFile(pd, content);
  console.log(JSON.stringify({ updated: true, checkboxes: changes.length, completed_count: completedCount }));
  });
}

function handleCount(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts count <state>");
  const stateStr = args[0];
  if (!isCheckboxState(stateStr)) {
    error(`Invalid state: ${stateStr}. Valid: ${VALID_CHECKBOX_STATES.join(", ")}`);
  }
  const pd = resolveProjectDir(projectDir);
  const content = readStateFile(pd);
  console.log(countCheckboxes(content, stateStr));
}

function handleAdvance(args: string[]): void {
  if (args.length < 1)
    error("Usage: aidlc-state.ts advance <completed-slug> [<next-slug>]");
  const completedSlug = args[0];

  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: the whole read→decide→emit-audit→write critical
  // section runs under one audit lock so the next-stage derivation, the 5 audit
  // rows, and the state write all commit atomically against a single snapshot
  // (decide-inside-lock). emitAudit detects the held lock and uses the unlocked
  // append variant, so audit + state land together (audit-first). The replay
  // guard's early `return` exits the arrow cleanly; the lock releases in
  // withAuditLock's finally.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  // Look up stage data
  const completedStage = findStageBySlug(completedSlug);
  if (!completedStage) error(`Unknown stage: ${completedSlug}`);

  // Scope is authoritative for deriving next stage — refuse silent "feature"
  // fallback when the state file is missing or corrupted. Adversarial finding.
  const scope = getField(content, "Scope");
  if (!scope) {
    error(
      `State file has no Scope field. Refusing to advance — fix the state file first.`
    );
  }
  if (!validScopes().has(scope)) {
    error(
      `State file has invalid Scope "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }

  // Slug validation — `advance <slug>` is a post-gate-approval transition.
  // The caller must have just finished <completedSlug>. Silently accepting
  // any slug (even ones unrelated to the current state) would mutate
  // unrelated stages and emit bogus events.
  //
  // Accept two shapes cleanly:
  //   1. completedSlug matches `Current Stage` (normal post-approve flow);
  //   2. completedSlug is already `[x]` (idempotent replay / approve-first).
  // Anything else errors.
  const completedCbBefore = parseCheckboxes(content).find(
    (c) => c.slug === completedSlug
  );
  const currentStageField = getField(content, "Current Stage");
  const matchesCurrent = completedSlug === currentStageField;
  const alreadyMarkedCompleted = completedCbBefore?.state === "completed";
  const stageCompletedAlreadyAudited =
    alreadyMarkedCompleted && hasStageAuditEvent(pd, "STAGE_COMPLETED", completedSlug);
  if (!matchesCurrent && !alreadyMarkedCompleted) {
    error(
      `Cannot advance "${completedSlug}": Current Stage is "${currentStageField}" and "${completedSlug}" is ${
        completedCbBefore?.state ?? "unknown"
      }. Pass the slug that's actually active, or use 'skip' / 'complete-workflow'.`
    );
  }

  // If next-slug was not provided, derive it from the scope AND state file.
  // The state file's EXECUTE/SKIP suffix (set by handleInit with Greenfield
  // overrides) and per-stage checkbox state take precedence over the
  // scope-mapping.json defaults.
  let nextSlug: string;
  if (args.length >= 2) {
    nextSlug = args[1];
    // Validate the caller-supplied next slug is in scope AND not already
    // SKIP-stamped in the state file. Symmetric with single-arg form.
    const stateOverrides = parseStateStageSuffixes(content);
    const nextAction =
      stateOverrides.get(nextSlug) ??
      loadScopeMapping()[scope]?.stages[nextSlug];
    if (nextAction === "SKIP") {
      error(
        `Cannot advance to "${nextSlug}": stage is SKIP for scope "${scope}" (or state file). Pick the next EXECUTE stage or use 'skip'.`
      );
    }
  } else {
    const next = nextInScopeStage(completedSlug, scope, content);
    if (!next) {
      error(
        `No next in-scope stage after "${completedSlug}" for scope "${scope}". ` +
          `Use 'complete-workflow' if this was the final stage.`
      );
    }
    nextSlug = next.slug;
  }
  const nextStage = findStageBySlug(nextSlug);
  if (!nextStage) error(`Unknown stage: ${nextSlug}`);

  // Idempotency guard — if completedSlug is already [x] AND nextSlug has
  // already left pending with Current Stage pointing at it, this is a replay.
  // Skip the whole emission block and exit cleanly, rather than doubling
  // STAGE_STARTED / PHASE_COMPLETED / PHASE_VERIFIED / PHASE_STARTED.
  // Adversarial finding: the previous alreadyMarkedCompleted guard only
  // suppressed STAGE_COMPLETED; phase events still doubled.
  // The next stage counts as already-started in ANY of its post-start gate
  // states — in-progress, awaiting-approval, revising. Matching only
  // in-progress let a stale replay demote a gate-held `[?]`/`[R]` next stage
  // back to `[-]` and re-emit STAGE_STARTED.
  const nextCbBefore = parseCheckboxes(content).find(
    (c) => c.slug === nextSlug
  );
  const nextAlreadyStarted =
    nextCbBefore?.state === "in-progress" ||
    nextCbBefore?.state === "awaiting-approval" ||
    nextCbBefore?.state === "revising";
  const isReplay =
    alreadyMarkedCompleted &&
    stageCompletedAlreadyAudited &&
    nextAlreadyStarted &&
    currentStageField === nextSlug;
  if (isReplay) {
    console.log(
      JSON.stringify({
        completed: completedSlug,
        started: nextSlug,
        replay: true,
        timestamp: isoTimestamp(),
      })
    );
    return;
  }

  // Detect phase boundary (for PHASE_COMPLETED/VERIFIED/STARTED emissions)
  const crossesPhaseBoundary = completedStage.phase !== nextStage.phase;

  // 1. Mark completed-slug → [x] (idempotent)
  content = setCheckbox(content, completedSlug, "completed");

  // 2. Mark next-slug → [-]
  content = setCheckbox(content, nextSlug, "in-progress");

  // 3. Update fields
  const nextAfterNext = nextInScopeStage(nextSlug, scope, content);
  const timestamp = isoTimestamp();

  content = setField(content, "Current Stage", nextStage.slug);
  content = setField(content, "Lifecycle Phase", nextStage.phase.toUpperCase());
  content = setField(content, "Next Stage", nextAfterNext ? nextAfterNext.slug : "none");
  content = setField(content, "In Progress", nextStage.slug);
  content = setField(content, "Active Agent", nextStage.lead_agent);
  content = setField(content, "Status", "Running");
  content = setField(content, "Last Updated", timestamp);
  content = setField(content, "Last Completed Stage", completedSlug);
  content = setField(content, "Next Action", `Execute ${nextStage.name}`);

  // Sync Completed counter to actual [x] count
  const completedCount = countCheckboxes(content, "completed");
  content = setField(content, "Completed", String(completedCount));

  // 4. Atomic audit emission — audit-first, then state write.
  // If audit fails, throw before touching state (writeStateFile below is skipped).
  try {
    // Emit STAGE_COMPLETED only if approve didn't already emit it.
    if (!alreadyMarkedCompleted || !stageCompletedAlreadyAudited) {
      emitAudit(pd, "STAGE_COMPLETED", {
        Stage: completedSlug,
        Details: `Stage ${completedStage.name} completed`,
      });
    }
    if (crossesPhaseBoundary) {
      emitAudit(pd, "PHASE_COMPLETED", {
        "From phase": completedStage.phase,
        "To phase": nextStage.phase,
        "Stages completed": String(completedCount),
      });
      emitAudit(pd, "PHASE_VERIFIED", {
        "Phase boundary": `${completedStage.phase} → ${nextStage.phase}`,
      });
      emitAudit(pd, "PHASE_STARTED", {
        Phase: nextStage.phase,
        Scope: scope,
      });
    }
    emitAudit(pd, "STAGE_STARTED", {
      Stage: nextSlug,
      Agent: nextStage.lead_agent,
    });
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);

  console.log(
    JSON.stringify({
      completed: completedSlug,
      started: nextSlug,
      phase: nextStage.phase.toUpperCase(),
      phase_boundary: crossesPhaseBoundary,
      completed_count: completedCount,
      next_after: nextAfterNext ? nextAfterNext.slug : null,
      already_completed: alreadyMarkedCompleted,
      memory_path: `aidlc-docs/${nextStage.phase}/${nextStage.slug}/memory.md`,
      timestamp,
    })
  );
  });
}

function handleFinalize(args: string[]): void {
  if (args.length < 1)
    error("Usage: aidlc-state.ts finalize <completed-slug>");
  const completedSlug = args[0];

  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: read→decide→write under one lock (no audit here).
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const completedStage = findStageBySlug(completedSlug);
  if (!completedStage) error(`Unknown stage: ${completedSlug}`);

  // 1. Mark completed
  content = setCheckbox(content, completedSlug, "completed");

  // 2. Sync Completed counter to actual [x] count
  const completedCount = countCheckboxes(content, "completed");
  content = setField(content, "Completed", String(completedCount));

  // 3. Look up next in-scope stage. Refuse silent fallback on missing/invalid
  // Scope — matches handleAdvance's stance. Adversarial: pre-Phase-11 code
  // silently used "feature" when Scope was absent, hiding state-file corruption.
  const scope = getField(content, "Scope");
  if (!scope) {
    error(
      `State file has no Scope field. Refusing to finalize — fix the state file first.`
    );
  }
  if (!validScopes().has(scope)) {
    error(
      `State file has invalid Scope "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }
  const nextStage = nextInScopeStage(completedSlug, scope);
  const nextAfterNext = nextStage ? nextInScopeStage(nextStage.slug, scope) : null;
  const timestamp = isoTimestamp();

  // 4. Update state fields (but do NOT mark next stage [-] or set In Progress)
  if (nextStage) {
    content = setField(content, "Current Stage", nextStage.slug);
    content = setField(content, "Next Stage", nextAfterNext ? nextAfterNext.slug : "none");
    content = setField(content, "Lifecycle Phase", nextStage.phase.toUpperCase());
    content = setField(content, "Active Agent", nextStage.lead_agent);
  } else {
    content = setField(content, "Current Stage", "none");
    content = setField(content, "Next Stage", "none");
    content = setField(content, "Status", "Completed");
    content = setField(content, "In Progress", "none");
  }
  content = setField(content, "Last Completed Stage", completedSlug);
  content = setField(content, "Last Updated", timestamp);
  content = setField(content, "Next Action", nextStage ? `Resume from ${nextStage.name}` : "Workflow complete");

  writeStateFile(pd, content);
  console.log(
    JSON.stringify({
      completed: completedSlug,
      completed_count: completedCount,
      next_stage: nextStage?.slug || "none",
      phase: nextStage?.phase.toUpperCase() || completedStage.phase.toUpperCase(),
      timestamp,
    })
  );
  });
}

function handleCompleteWorkflow(args: string[]): void {
  if (args.length < 1)
    error("Usage: aidlc-state.ts complete-workflow <completed-slug> [--reason <text>]");
  const completedSlug = args[0];

  // Optional --reason flag for test-run early stops
  let reason: string | undefined;
  const reasonIdx = args.indexOf("--reason");
  if (reasonIdx !== -1 && reasonIdx + 1 < args.length) {
    reason = args[reasonIdx + 1];
  }

  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: read→decide→emit-audit (4 rows)→write under one
  // lock so the 4 audit rows and the completion state commit atomically against
  // a single snapshot (audit-first / decide-inside-lock). emitAudit uses the
  // unlocked variant because the lock is held.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const completedStage = findStageBySlug(completedSlug);
  if (!completedStage) error(`Unknown stage: ${completedSlug}`);

  // If the slug is already [x], approve already emitted STAGE_COMPLETED —
  // skip re-emission to avoid duplicates. Matches handleAdvance's
  // alreadyMarkedCompleted guard.
  const alreadyMarkedCompleted =
    parseCheckboxes(content).find((c) => c.slug === completedSlug)?.state ===
    "completed";
  const stageCompletedAlreadyAudited =
    alreadyMarkedCompleted && hasStageAuditEvent(pd, "STAGE_COMPLETED", completedSlug);

  // 1. Mark completed
  content = setCheckbox(content, completedSlug, "completed");

  // 2. Sync Completed counter
  const completedCount = countCheckboxes(content, "completed");
  content = setField(content, "Completed", String(completedCount));

  // 3. Update all fields atomically for workflow completion
  const timestamp = isoTimestamp();
  content = setField(content, "Status", "Completed");
  content = setField(content, "Last Updated", timestamp);
  content = setField(content, "Last Completed Stage", completedSlug);
  content = setField(content, "In Progress", "none");
  content = setField(content, "Next Stage", "none");
  content = setField(content, "Next Action", "Workflow complete");

  // 4. Atomic audit emissions. Refuse silent fallback — matches handleAdvance.
  const scope = getField(content, "Scope");
  if (!scope) {
    error(
      `State file has no Scope field. Refusing to complete workflow — fix the state file first.`
    );
  }
  if (!validScopes().has(scope)) {
    error(
      `State file has invalid Scope "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }
  try {
    if (!alreadyMarkedCompleted || !stageCompletedAlreadyAudited) {
      emitAudit(pd, "STAGE_COMPLETED", {
        Stage: completedSlug,
        Details: `Final stage ${completedStage.name} completed`,
      });
    }
    emitAudit(pd, "PHASE_COMPLETED", {
      "From phase": completedStage.phase,
      "To phase": "(end)",
      "Stages completed": String(completedCount),
    });
    emitAudit(pd, "PHASE_VERIFIED", {
      "Phase boundary": `${completedStage.phase} → end`,
    });
    const workflowFields: Record<string, string> = {
      Scope: scope,
      Details: `Scope: ${scope}, ${completedCount} stages completed`,
    };
    if (reason) workflowFields.Reason = reason;
    emitAudit(pd, "WORKFLOW_COMPLETED", workflowFields);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);
  console.log(
    JSON.stringify({
      completed: completedSlug,
      completed_count: completedCount,
      status: "Completed",
      reason: reason || null,
      timestamp,
    })
  );
  });
}

// --- New gate/approve/reject/skip/revise/resume/reuse-artifact commands (state-machine refactor #50) ---

// Helper: get the current state of a specific slug
function getSlugState(content: string, slug: string): CheckboxState | null {
  const checkboxes = parseCheckboxes(content);
  const match = checkboxes.find((c) => c.slug === slug);
  return match ? match.state : null;
}

function validateSlugInState(
  content: string,
  slug: string,
  expected: CheckboxState | CheckboxState[]
): void {
  const actual = getSlugState(content, slug);
  if (actual === null) error(`Stage not found in state file: ${slug}`);
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(actual)) {
    error(
      `Stage ${slug} is in state '${actual}' but command requires one of: ${allowed.join(", ")}`
    );
  }
}

// gate-start <slug> — transition [-] → [?], emit STAGE_AWAITING_APPROVAL.
// --recovered marks a BACKFILLED gate row (the engine opening a gate the
// conductor skipped, e.g. report's explicit-stage recovery) with
// Recovered=true so audit consumers can tell backfills from organic opens.
function handleGateStart(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts gate-start <slug> [--artifacts <csv>] [--recovered]");
  const slug = args[0];
  let artifacts: string | undefined;
  const artifactsIdx = args.indexOf("--artifacts");
  if (artifactsIdx !== -1 && artifactsIdx + 1 < args.length) {
    artifacts = args[artifactsIdx + 1];
  }
  const recovered = args.includes("--recovered");

  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: validate→transition→emit-audit→write under one
  // lock (the state-precondition check and the write see one snapshot).
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);
  validateSlugInState(content, slug, "in-progress");

  content = setCheckbox(content, slug, "awaiting-approval");
  const timestamp = isoTimestamp();
  content = setField(content, "Last Updated", timestamp);

  try {
    const fields: Record<string, string> = { Stage: slug };
    if (artifacts) fields.Artifacts = artifacts;
    if (recovered) fields.Recovered = "true";
    emitAudit(pd, "STAGE_AWAITING_APPROVAL", fields);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);
  console.log(JSON.stringify({ slug, new_state: "awaiting-approval", timestamp }));
  });
}

// approve <slug> [--user-input <text>] [--test-run]
// Transition: [?] → [x] AND auto-advance to the next in-scope stage (or
// complete the workflow if this was the final stage). Human judgment ends
// at the gate response; everything after is deterministic bookkeeping, so
// approve owns it end-to-end. Emits GATE_APPROVED + STAGE_COMPLETED, then
// delegates to handleAdvance or handleCompleteWorkflow for the remaining
// transitions. Eliminates the t59-class bug where the orchestrator approved
// but forgot to call advance, leaving Current Stage pointing at a [x] slug.
function handleApprove(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts approve <slug> [--user-input <text>] [--test-run]");
  const slug = args[0];
  const { userInput, testRun } = parseApproveFlags(args.slice(1));

  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: the ENTIRE approve transaction — including the
  // nested handleAdvance / handleCompleteWorkflow calls below — runs under one
  // outer lock. withAuditLock is REENTRANT (per-pd depth counter): the nested
  // handlers' own withAuditLock calls bump depth 1→2→1 and run inline without
  // re-acquiring the OS lock, so approve+advance commit as one atomic unit and
  // no concurrent writer can interleave between approve's write and the
  // advance's re-read. The original ordering is preserved: approve writes its
  // own state (slug → [x]) BEFORE delegating, so the nested re-read sees it.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);
  validateSlugInState(content, slug, "awaiting-approval");

  const timestamp = isoTimestamp();

  content = setCheckbox(content, slug, "completed");
  content = setField(content, "Last Updated", timestamp);
  const completedCount = countCheckboxes(content, "completed");
  content = setField(content, "Completed", String(completedCount));
  content = setField(content, "Last Completed Stage", slug);

  // Atomic audit emissions (audit-first). GATE_APPROVED records the human
  // decision; STAGE_COMPLETED records the state transition the approval
  // implies. Both emit here so the audit trail is correct even if the
  // downstream advance/complete-workflow fails.
  try {
    const gateFields: Record<string, string> = { Stage: slug };
    if (userInput) gateFields["User Input"] = userInput;
    if (testRun) gateFields["Test-Run"] = "true";
    emitAudit(pd, "GATE_APPROVED", gateFields);

    emitAudit(pd, "STAGE_COMPLETED", {
      Stage: slug,
      Details: `Stage ${stage.name} approved by gate`,
    });
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);

  // Auto-advance or complete-workflow. Scope is required for next-stage
  // derivation; refuse silent fallback (matches handleAdvance/handleCompleteWorkflow).
  const scope = getField(content, "Scope");
  if (!scope) {
    error(
      `State file has no Scope field. Refusing to advance after approve — fix the state file first.`
    );
  }
  if (!validScopes().has(scope)) {
    error(
      `State file has invalid Scope "${scope}". Valid scopes: ${[...validScopes()].join(", ")}.`
    );
  }

  const next = nextInScopeStage(slug, scope, content);
  if (next) {
    // Delegate to handleAdvance. The slug is now [x], so handleAdvance takes
    // the alreadyMarkedCompleted path and skips re-emitting STAGE_COMPLETED.
    // Reentrant call — runs under the depth-2 lock without re-acquire.
    handleAdvance([slug]);
  } else {
    // Final stage — complete the workflow. handleCompleteWorkflow re-sets
    // the checkbox to [x] (idempotent) and emits PHASE_COMPLETED +
    // PHASE_VERIFIED + WORKFLOW_COMPLETED. Reentrant call — see above.
    handleCompleteWorkflow([slug]);
  }
  });
}

// Look up a flag's value while guarding against value-starting-with-"--"
// ambiguity. If the user forgets to provide a value (e.g. `--user-input
// --test-run`), indexOf+slice would consume the next flag as the value —
// silently wrong. This helper errors cleanly when the value starts with "--".
// Returns undefined if the flag is absent.
function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  if (idx + 1 >= args.length) {
    error(`${flag} expects a value, got end of arguments.`);
  }
  const val = args[idx + 1];
  if (val.startsWith("--")) {
    error(`${flag} expects a value, got another flag: "${val}". Did you forget the value?`);
  }
  return val;
}

// Flag parser for approve — handles --user-input (value) and --test-run (boolean).
function parseApproveFlags(args: string[]): { userInput?: string; testRun: boolean } {
  return {
    userInput: getFlagValue(args, "--user-input"),
    testRun: args.includes("--test-run"),
  };
}

// reject <slug> [--feedback <text>] — transition [?] → [R], emit GATE_REJECTED + STAGE_REVISING, increment Revision Count.
// Also accepts [-]: gate-start is optional before the human prompt, so a
// rejection may arrive with no open gate. The reject self-heals by emitting
// the missing STAGE_AWAITING_APPROVAL (tagged Recovered=true) ahead of the
// rejection pair — mirroring report's approve-side gate backfill.
function handleReject(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts reject <slug> [--feedback <text>]");
  const slug = args[0];
  const feedback = getFlagValue(args.slice(1), "--feedback");

  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: validate→increment Revision Count→emit-audit→write
  // under one lock. The Revision Count read-modify-write is the exposed bit —
  // two concurrent rejects must not both read N and both write N+1 (one
  // increment lost). emit-then-write stays idempotent on retry: the lock
  // serialises, and re-running the same input recomputes from the locked
  // snapshot rather than double-incrementing a stale value.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);
  validateSlugInState(content, slug, ["awaiting-approval", "in-progress"]);
  const gateWasMissing = getSlugState(content, slug) === "in-progress";

  // Increment Revision Count. Guard against non-numeric values (missing field,
  // manual edits, legacy state files) by coercing non-integers to 0.
  const current = getField(content, "Revision Count");
  const parsed = current ? parseInt(current, 10) : 0;
  const revCount = (Number.isFinite(parsed) ? parsed : 0) + 1;
  content = setField(content, "Revision Count", String(revCount));

  content = setCheckbox(content, slug, "revising");
  const timestamp = isoTimestamp();
  content = setField(content, "Last Updated", timestamp);

  try {
    if (gateWasMissing) {
      // Backfill the gate row the optional gate-start would have written, so
      // the audit trail keeps its STAGE_AWAITING_APPROVAL → GATE_REJECTED
      // order. The intermediate [?] never needs to hit disk — one state write
      // below lands the final [R].
      emitAudit(pd, "STAGE_AWAITING_APPROVAL", {
        Stage: slug,
        Recovered: "true",
      });
    }
    const rejFields: Record<string, string> = { Stage: slug };
    if (feedback) rejFields.Feedback = feedback;
    emitAudit(pd, "GATE_REJECTED", rejFields);
    emitAudit(pd, "STAGE_REVISING", {
      Stage: slug,
      "Revision count": String(revCount),
      ...(feedback ? { Feedback: feedback } : {}),
    });
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);
  console.log(JSON.stringify({ slug, new_state: "revising", revision_count: revCount, timestamp }));
  });
}

// revise <slug> — transition [R] → [?] (re-enter gate after revision work)
function handleRevise(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts revise <slug>");
  const slug = args[0];

  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: validate→transition→emit-audit→write under one lock.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);
  validateSlugInState(content, slug, "revising");

  content = setCheckbox(content, slug, "awaiting-approval");
  const timestamp = isoTimestamp();
  content = setField(content, "Last Updated", timestamp);

  try {
    emitAudit(pd, "STAGE_AWAITING_APPROVAL", {
      Stage: slug,
      Details: "Re-entering gate after revision",
    });
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);
  console.log(JSON.stringify({ slug, new_state: "awaiting-approval", timestamp }));
  });
}

// skip <slug> [--reason <text>] — transition [ ]/[-]/[R] → [S], emit STAGE_SKIPPED
function handleSkip(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts skip <slug> [--reason <text>]");
  const slug = args[0];
  const reason = getFlagValue(args.slice(1), "--reason");

  const pd = resolveProjectDir(projectDir);
  // C2b lost-update safety: validate→transition→emit-audit→write under one lock.
  withAuditLock(pd, () => {
  let content = readStateFile(pd);

  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);
  validateSlugInState(content, slug, ["pending", "in-progress", "revising"]);

  content = setCheckbox(content, slug, "skipped");
  const timestamp = isoTimestamp();
  content = setField(content, "Last Updated", timestamp);

  try {
    const fields: Record<string, string> = { Stage: slug };
    if (reason) fields.Reason = reason;
    emitAudit(pd, "STAGE_SKIPPED", fields);
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  writeStateFile(pd, content);
  console.log(JSON.stringify({ slug, new_state: "skipped", timestamp }));
  });
}

// resume — read-only re-entry marker used by the orchestrator's resume path.
// Returns structured JSON the orchestrator can branch on, including compaction
// detection (was the most recent audit event SESSION_COMPACTED without any
// subsequent stage activity?). Session-level SESSION_RESUMED emission is the
// SessionStart hook's job, NOT this tool — this is a pure reader.
function handleResume(_args: string[]): void {
  const pd = resolveProjectDir(projectDir);
  const content = readStateFile(pd);
  const currentStage = getField(content, "Current Stage") || "unknown";
  const status = getField(content, "Status") || "unknown";
  const phase = getField(content, "Lifecycle Phase") || "unknown";
  const scope = getField(content, "Scope") || "unknown";
  const activeAgent = getField(content, "Active Agent") || "unknown";
  const nextStage = getField(content, "Next Stage") || "none";

  // Stage-level gate awareness — tells the orchestrator whether the user is
  // the blocker on this stage (awaiting approval / revising).
  const checkboxes = parseCheckboxes(content);
  const currentCb = checkboxes.find((c) => c.slug === currentStage);
  const gateState = currentCb?.state ?? "unknown";

  // Compaction detection — scan the tail of audit.md for a SESSION_COMPACTED
  // event that has no subsequent stage activity. The orchestrator uses this
  // to surface the compaction-awareness prompt without a fragile shell pipeline.
  let compactionPending = false;
  try {
    const auditPath = join(pd, "aidlc-docs", "audit.md");
    if (existsSync(auditPath)) {
      // Read last ~400 lines (enough to cover ~30 events' worth of blocks)
      const raw = readFileSync(auditPath, "utf-8");
      const tailLines = raw.split("\n").slice(-400);
      const tail = tailLines.join("\n");
      // Find the index of the last SESSION_COMPACTED event
      const lastCompactIdx = tail.lastIndexOf("**Event**: SESSION_COMPACTED");
      if (lastCompactIdx !== -1) {
        const after = tail.slice(lastCompactIdx);
        // Any stage activity OR explicit recovery after the compaction?
        // STAGE_STARTED / STAGE_COMPLETED / GATE_APPROVED / SESSION_RESUMED
        // are normal progress; RECOVERY_COMPLETED is the explicit "user saw
        // the compaction prompt and chose how to proceed" signal.
        const hasActivity =
          /\*\*Event\*\*: (STAGE_STARTED|STAGE_COMPLETED|GATE_APPROVED|SESSION_RESUMED|RECOVERY_COMPLETED)/.test(
            after
          );
        compactionPending = !hasActivity;
      }
    }
  } catch {
    // Audit read failures are non-fatal — default to false, orchestrator
    // will use the standard resume flow.
  }

  console.log(
    JSON.stringify({
      resumed: true,
      current_stage: currentStage,
      phase,
      status,
      scope,
      active_agent: activeAgent,
      next_stage: nextStage,
      gate_state: gateState,
      compaction_pending: compactionPending,
    })
  );
}

// acknowledge-compaction --choice <continue|review|restart>
//
// Called by the orchestrator's compaction-awareness flow AFTER the user picks
// Continue / Review / Restart in response to a pending SESSION_COMPACTED event.
// Emits RECOVERY_COMPLETED to record that the user was presented with the
// prompt and made a choice — closing the "compaction detected but not yet
// handled" window. Refuses if `handleResume` would report compaction_pending=false,
// so the event is only emitted when the flow is genuinely recovering.
function handleAcknowledgeCompaction(args: string[]): void {
  const pd = resolveProjectDir(projectDir);
  let choice = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--choice" && i + 1 < args.length) {
      choice = args[i + 1];
      i++;
    }
  }
  if (!choice) {
    error(
      "Usage: aidlc-state.ts acknowledge-compaction --choice <continue|review|restart>"
    );
  }
  if (!["continue", "review", "restart"].includes(choice)) {
    error(`Invalid --choice: ${choice}. Valid: continue, review, restart`);
  }

  const content = readStateFile(pd);
  const currentStage = getField(content, "Current Stage") || "unknown";

  // Only emit if compaction is pending. This prevents spurious
  // RECOVERY_COMPLETED events when the orchestrator calls acknowledge unnecessarily.
  let compactionPending = false;
  try {
    const auditPath = join(pd, "aidlc-docs", "audit.md");
    if (existsSync(auditPath)) {
      const raw = readFileSync(auditPath, "utf-8");
      const tail = raw.split("\n").slice(-400).join("\n");
      const lastCompactIdx = tail.lastIndexOf("**Event**: SESSION_COMPACTED");
      if (lastCompactIdx !== -1) {
        const after = tail.slice(lastCompactIdx);
        compactionPending =
          !/\*\*Event\*\*: (STAGE_STARTED|STAGE_COMPLETED|GATE_APPROVED|SESSION_RESUMED|RECOVERY_COMPLETED)/.test(
            after
          );
      }
    }
  } catch {
    // Audit unreadable — nothing to recover.
  }

  if (!compactionPending) {
    error(
      "No pending compaction to acknowledge (latest SESSION_COMPACTED already followed by stage activity or recovery)."
    );
  }

  emitAudit(pd, "RECOVERY_COMPLETED", {
    Choice: choice,
    "Current Stage": currentStage,
  });

  console.log(
    JSON.stringify({ acknowledged: true, choice, current_stage: currentStage })
  );
}

// practices-event --type <discovered|affirmed|override> [--field "K: V"]...
// Emits a PRACTICES_* audit event from tool code (not stage prose).
// Required by the audit-first invariant: every audit event must originate
// in .ts code so t48's emitter-pairing check passes. Called by the
// practices-discovery stage at Step 4 (discovered), Step 7 (affirmed), and
// Step 6 on write failure (override).
function handlePracticesEvent(args: string[]): void {
  const pd = resolveProjectDir(projectDir);
  let eventTypeArg = "";
  const fields: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type" && i + 1 < args.length) {
      eventTypeArg = args[i + 1];
      i++;
    } else if (args[i] === "--field" && i + 1 < args.length) {
      const kv = args[i + 1];
      const idx = kv.indexOf(":");
      if (idx > 0) {
        const key = kv.slice(0, idx).trim();
        const value = kv.slice(idx + 1).trim();
        fields[key] = value;
      }
      i++;
    }
  }
  if (!eventTypeArg) {
    error(
      'Usage: aidlc-state.ts practices-event --type <discovered|affirmed|override|empty> [--field "Key: Value"]...'
    );
  }
  // Explicit literal-string emitAudit calls per --type so t48's
  // emitter-pairing check (which scans for `emitAudit(... "EVENT_NAME")`
  // literals) finds each event at a real call site.
  //
  // --type empty handles the orchestrator's layer-3 fallback path (when
  // extractMarkdownSection returns "" and the orchestrator falls back to
  // scope-hardcoded defaults). Advisory-only — does not block execution.
  // The `override` case is reused by the orchestrator with --field "Reason:
  // bolt-plan-marker-conflict" + --field "Practices Stance: ..." +
  // --field "Bolt-Plan Marker: ..." + --field "Bolt slug: ..." for the
  // orchestrator-overrides-bolt-plan-marker semantic. The write-failure path
  // uses --field "Reason: write-failure-..." — same event, distinct Reason
  // field (discriminator-field disambiguation, no
  // audit-count bump).
  let emittedEvent: string;
  switch (eventTypeArg) {
    case "discovered":
      emitAudit(pd, "PRACTICES_DISCOVERED", fields);
      emittedEvent = "PRACTICES_DISCOVERED";
      break;
    case "affirmed":
      emitAudit(pd, "PRACTICES_AFFIRMED", fields);
      emittedEvent = "PRACTICES_AFFIRMED";
      break;
    case "override":
      emitAudit(pd, "PRACTICES_OVERRIDE", fields);
      emittedEvent = "PRACTICES_OVERRIDE";
      break;
    case "empty":
      emitAudit(pd, "PRACTICES_SECTION_EMPTY", fields);
      emittedEvent = "PRACTICES_SECTION_EMPTY";
      break;
    default:
      error(
        `Invalid --type: ${eventTypeArg}. Must be discovered, affirmed, override, or empty.`
      );
      return;
  }
  console.log(
    JSON.stringify({ emitted: emittedEvent, fields_count: Object.keys(fields).length })
  );
}

// practices-promote --team-practices <path> --discovered-rules <path>
//                   [--affirming-user <name>] [--target-dir <path>]
//
// Cross-row promotion of affirmed practices into team-authored harness config.
// Reads two draft files from aidlc-docs/inception/practices-discovery/ and
// applies them deterministically to the live .claude/ files:
//
//   .claude/rules/aidlc-team.md ........... replaceSection × 5 (Way of Working,
//                                            Walking Skeleton, Testing Posture,
//                                            Deployment, Code Style)
//   .claude/rules/aidlc-project.md ........ appendUnderHeading × 2 (Mandated,
//                                            Forbidden), each rule stamped
//                                            with `(affirmed YYYY-MM-DD)`
//
// Atomicity:
//   1. Read both drafts (fail closed before any write).
//   2. Read both targets (fail closed if either missing).
//   3. Build new contents in memory.
//   4. Write aidlc-project.md first (smaller, more constrained).
//   5. Write aidlc-team.md second.
//   6. On success → emit PRACTICES_AFFIRMED.
//   7. On any failure → emit PRACTICES_OVERRIDE with the failure reason
//      and rethrow so the caller halts the gate.
//
// Why this exists: when stage prose tells the LLM to write to
// .claude/rules/, the LLM (running non-interactively under `claude -p`)
// hallucinates a sensitive-file permission policy that does not actually
// exist. The orchestrator then halts at "awaiting-approval" and emits
// PRACTICES_OVERRIDE without ever attempting the write — the workflow
// bricks. Routing the writes through a tool subcommand removes the LLM's
// judgment from the path: the path is never the LLM's write target, so the
// hallucinated policy never fires.
function handlePracticesPromote(args: string[]): void {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && i + 1 < args.length) {
      flags[a.slice(2)] = args[i + 1];
      i++;
    }
  }
  if (!flags["team-practices"] || !flags["discovered-rules"]) {
    error(
      'Usage: aidlc-state.ts practices-promote --team-practices <path> --discovered-rules <path> [--affirming-user <name>] [--target-dir <path>]'
    );
  }

  const pd = resolveProjectDir(projectDir);
  // target-dir lets tests point the writes at a fixture .claude/ tree.
  // Defaults to the project's .claude/ directory.
  const targetRoot = flags["target-dir"] ?? join(pd, harnessDir());
  const teamMdPath = join(targetRoot, rulesSubdir(), "aidlc-team.md");
  const guardrailsPath = join(targetRoot, rulesSubdir(), "aidlc-project.md");

  const today = isoTimestamp().slice(0, 10);
  const sectionsWritten: string[] = [];
  const rulesAppended = { mandated: 0, forbidden: 0 };

  const fail = (reason: string): never => {
    try {
      emitAudit(pd, "PRACTICES_OVERRIDE", {
        Reason: reason,
        Timestamp: isoTimestamp(),
      });
    } catch {
      // If audit emission itself fails, surface the original reason.
    }
    error(`practices-promote failed: ${reason}`);
    throw new Error(reason); // unreachable; error() exits, but TS needs this
  };

  // Step 1: Read both drafts.
  const teamPracticesPath = flags["team-practices"];
  const discoveredRulesPath = flags["discovered-rules"];
  if (!existsSync(teamPracticesPath))
    fail(`team-practices draft not found: ${teamPracticesPath}`);
  if (!existsSync(discoveredRulesPath))
    fail(`discovered-rules draft not found: ${discoveredRulesPath}`);

  let teamPracticesDraft: string;
  let discoveredRulesDraft: string;
  try {
    teamPracticesDraft = readFileSync(teamPracticesPath, "utf-8");
    discoveredRulesDraft = readFileSync(discoveredRulesPath, "utf-8");
  } catch (e) {
    fail(`could not read drafts: ${errorMessage(e)}`);
    return;
  }

  // Step 2: Read both target files. Fail closed if either is missing.
  if (!existsSync(teamMdPath)) fail(`aidlc-team.md not found at ${teamMdPath}`);
  if (!existsSync(guardrailsPath))
    fail(`aidlc-project.md not found at ${guardrailsPath}`);

  let teamMd: string;
  let guardrailsMd: string;
  try {
    teamMd = readFileSync(teamMdPath, "utf-8");
    guardrailsMd = readFileSync(guardrailsPath, "utf-8");
  } catch (e) {
    fail(`could not read targets: ${errorMessage(e)}`);
    return;
  }

  // Step 3a: Build new aidlc-team.md by section-replacing each of the five
  // sections. aidlc-team.md uses Title Case headings; the draft mirrors that
  // shape.
  const TEAM_SECTIONS = [
    "## Way of Working",
    "## Walking Skeleton",
    "## Testing Posture",
    "## Deployment",
    "## Code Style",
  ];
  let newTeamMd = teamMd;
  for (const heading of TEAM_SECTIONS) {
    const draftSection = extractMarkdownSection(teamPracticesDraft, heading);
    if (draftSection === "") {
      // Section absent from draft → leave the live file's section alone.
      // Useful for partial re-runs that only change one practice area.
      continue;
    }
    try {
      newTeamMd = replaceSection(newTeamMd, heading, draftSection);
      sectionsWritten.push(heading.slice(3));
    } catch (e) {
      fail(
        `replaceSection failed on aidlc-team.md for "${heading}": ${errorMessage(e)}`
      );
      return;
    }
  }

  // Step 3b: Build new project-guardrails.md by appending each rule under the
  // matching heading with a date stamp. Rules are one-per-line in the draft;
  // empty/blank lines and comment lines are skipped.
  const parseRules = (sectionContent: string): string[] => {
    return sectionContent
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("<!--") && !l.startsWith("#"));
  };
  const mandatedDraft = extractMarkdownSection(
    discoveredRulesDraft,
    "## Mandated"
  );
  const forbiddenDraft = extractMarkdownSection(
    discoveredRulesDraft,
    "## Forbidden"
  );
  const mandatedRules = parseRules(mandatedDraft);
  const forbiddenRules = parseRules(forbiddenDraft);

  let newGuardrailsMd = guardrailsMd;
  for (const rule of mandatedRules) {
    const stamped = `${rule} (affirmed ${today})\n`;
    try {
      newGuardrailsMd = appendUnderHeading(
        newGuardrailsMd,
        "## Mandated",
        stamped
      );
      rulesAppended.mandated++;
    } catch (e) {
      fail(`appendUnderHeading failed on Mandated: ${errorMessage(e)}`);
      return;
    }
  }
  for (const rule of forbiddenRules) {
    const stamped = `${rule} (affirmed ${today})\n`;
    try {
      newGuardrailsMd = appendUnderHeading(
        newGuardrailsMd,
        "## Forbidden",
        stamped
      );
      rulesAppended.forbidden++;
    } catch (e) {
      fail(`appendUnderHeading failed on Forbidden: ${errorMessage(e)}`);
      return;
    }
  }

  // Step 4 & 5: Write aidlc-project.md first, then aidlc-team.md.
  // If the project write fails, aidlc-team.md is untouched. If the team write
  // fails after project succeeded, we surface that as PRACTICES_OVERRIDE —
  // the user re-enters the gate; the duplicate-rule case is mitigated because
  // re-running parses the same rule list and appendUnderHeading is idempotent
  // only on the draft contents, not on ALL prior runs. Operators should treat
  // a mid-promotion failure as a recovery scenario.
  try {
    writeFileSync(guardrailsPath, newGuardrailsMd, "utf-8");
  } catch (e) {
    fail(`writing aidlc-project.md failed: ${errorMessage(e)}`);
    return;
  }
  try {
    writeFileSync(teamMdPath, newTeamMd, "utf-8");
  } catch (e) {
    fail(
      `writing aidlc-team.md failed AFTER aidlc-project.md was written: ${errorMessage(e)}`
    );
    return;
  }

  // Step 6: Emit PRACTICES_AFFIRMED.
  try {
    emitAudit(pd, "PRACTICES_AFFIRMED", {
      "Affirming User": flags["affirming-user"] ?? "unknown",
      "Sections Written": sectionsWritten.join(", "),
      "Mandated Rules Appended": String(rulesAppended.mandated),
      "Forbidden Rules Appended": String(rulesAppended.forbidden),
      Timestamp: isoTimestamp(),
    });
  } catch (e) {
    fail(
      `audit emission failed AFTER both files were written: ${errorMessage(e)}`
    );
    return;
  }

  console.log(
    JSON.stringify({
      emitted: "PRACTICES_AFFIRMED",
      sections_written: sectionsWritten,
      mandated_appended: rulesAppended.mandated,
      forbidden_appended: rulesAppended.forbidden,
      team_md: teamMdPath,
      project_guardrails: guardrailsPath,
    })
  );
}

// reuse-artifact <slug> --decision <keep|modify|redo> --artifacts <csv>
function handleReuseArtifact(args: string[]): void {
  if (args.length < 1)
    error("Usage: aidlc-state.ts reuse-artifact <slug> --decision <keep|modify|redo> --artifacts <csv>");
  const slug = args[0];
  const rest = args.slice(1);
  const decision = getFlagValue(rest, "--decision");
  const artifacts = getFlagValue(rest, "--artifacts");
  if (!decision) error("Missing --decision <keep|modify|redo>");
  if (!artifacts) error("Missing --artifacts <csv>");

  if (!["keep", "modify", "redo"].includes(decision)) {
    error(`Invalid decision: ${decision}. Must be keep, modify, or redo.`);
  }

  // Validate stage exists in graph (adversarial finding C: reuse-artifact
  // was accepting any slug). This prevents orphan ARTIFACT_REUSED emissions
  // against non-existent stages.
  const stage = findStageBySlug(slug);
  if (!stage) error(`Unknown stage: ${slug}`);

  const pd = resolveProjectDir(projectDir);

  try {
    emitAudit(pd, "ARTIFACT_REUSED", {
      Stage: slug,
      Decision: decision,
      Artifacts: artifacts,
    });
  } catch (e) {
    error(`Audit emission failed: ${errorMessage(e)}`);
  }

  console.log(JSON.stringify({ slug, decision, artifacts, emitted: "ARTIFACT_REUSED" }));
}

function handleLookup(args: string[]): void {
  if (args.length < 1) error("Usage: aidlc-state.ts lookup <subcommand> [args...]");
  const sub = args[0];
  const subArgs = args.slice(1);

  switch (sub) {
    case "phase-of": {
      if (subArgs.length < 1) error("Usage: lookup phase-of <slug>");
      const stage = resolveStage(subArgs[0]);
      if (!stage) error(`Unknown stage: ${subArgs[0]}`);
      console.log(stage.phase);
      break;
    }
    case "next-stage": {
      if (subArgs.length < 2) error("Usage: lookup next-stage <slug> <scope>");
      const next = nextInScopeStage(subArgs[0], subArgs[1]);
      console.log(next ? next.slug : "none");
      break;
    }
    case "agent-for": {
      if (subArgs.length < 1) error("Usage: lookup agent-for <slug>");
      const stage = resolveStage(subArgs[0]);
      if (!stage) error(`Unknown stage: ${subArgs[0]}`);
      console.log(stage.lead_agent);
      break;
    }
    case "number-of": {
      if (subArgs.length < 1) error("Usage: lookup number-of <slug>");
      const stage = resolveStage(subArgs[0]);
      if (!stage) error(`Unknown stage: ${subArgs[0]}`);
      console.log(stage.number);
      break;
    }
    case "stages-in-scope": {
      if (subArgs.length < 1) error("Usage: lookup stages-in-scope <scope>");
      const stages = stagesInScope(subArgs[0]);
      if (stages.length === 0) error(`Unknown scope: ${subArgs[0]}`);
      console.log(JSON.stringify(stages));
      break;
    }
    case "first-in-phase": {
      if (subArgs.length < 2) error("Usage: lookup first-in-phase <phase> <scope>");
      const stage = firstInScopeStageOfPhase(subArgs[0], subArgs[1]);
      console.log(stage ? stage.slug : "none");
      break;
    }
    case "validate-stage": {
      if (subArgs.length < 1) error("Usage: lookup validate-stage <slug-or-number>");
      const stage = resolveStage(subArgs[0]);
      if (!stage) {
        console.log(JSON.stringify({ valid: false, input: subArgs[0] }));
      } else {
        console.log(
          JSON.stringify({
            valid: true,
            slug: stage.slug,
            number: stage.number,
            name: stage.name,
            phase: stage.phase,
            lead_agent: stage.lead_agent,
          })
        );
      }
      break;
    }
    case "validate-phase": {
      if (subArgs.length < 1) error("Usage: lookup validate-phase <phase-or-number>");
      const input = subArgs[0].toLowerCase();
      const phase =
        PHASE_NUMBERS[input] ||
        ((PHASES as readonly string[]).includes(input) ? input : null);
      if (!phase) {
        console.log(JSON.stringify({ valid: false, input: subArgs[0] }));
      } else {
        const phaseNumber = Object.entries(PHASE_NUMBERS).find(([_, v]) => v === phase)?.[0];
        console.log(
          JSON.stringify({
            valid: true,
            canonical: phase,
            number: phaseNumber,
            display: phase.toUpperCase(),
          })
        );
      }
      break;
    }
    default:
      error(
        `Unknown lookup subcommand: ${sub}. Valid: phase-of, next-stage, agent-for, number-of, stages-in-scope, first-in-phase, validate-stage, validate-phase`
      );
  }
}

// --- State fork/merge ---
//
// Per-Bolt state isolation for Construction worktrees. fork copies main state
// to <worktreePath>/aidlc-docs/aidlc-state.md on Bolt start; merge copies it
// back on gate approval. Strict audit-first per docs/reference/12-state-machine.md
// — the audit-of-intent exception at line 322 is bounded to the three
// WORKTREE_* events because git worktree add has no idempotent re-run path
// under kill-9; state fork/merge are idempotent (re-reading and re-writing a
// file is repeatable), so strict audit-first applies.
//
// Conflict resolution by alphabetical-slug is defence-in-depth, not load-bearing:
// the v7 schema has workflow-level singletons, not per-(Bolt, stage) cells.
// Realistic per-Bolt contention is rare; main wins on workflow-level fields,
// alphabetical-slug only fires as a tiebreak on the artificial case of two
// worktrees flipping the same Construction Stage Progress cell to different
// values.
//
// (SLUG_RE, validateSlug, errorWithSlug, sha256, parseFlags are declared
// near the top of the file so main() can reach them — handlers live below.)

// fork --slug <slug> [--target-dir <path>]
//
// Forks main's aidlc-state.md to <worktreePath>/aidlc-docs/aidlc-state.md.
// Adds slug to main's Bolt Refs list. Decorative Worktree Path on the
// worktree-side state file (recoverable from cwd; debugging breadcrumb only).
function handleFork(args: string[]): void {
  const flags = parseFlags(args);
  const slug = validateSlug(flags.slug);
  const pd = resolveProjectDir(projectDir);

  // target-dir lets tests point fork at a fixture worktree-parent. Defaults
  // to the project's .aidlc/worktrees/bolt-<slug>/ via worktreePath().
  const wtPath = flags["target-dir"] ?? worktreePath(pd, slug);

  if (!existsSync(wtPath)) {
    errorWithSlug(slug, `worktree directory does not exist: ${wtPath}. Run aidlc-worktree create first.`);
  }

  // mkdir BEFORE acquiring the lock. A read-only-fs mkdir failure must not
  // leave a phantom STATE_FORKED row, and acquiring the lock for a doomed
  // operation just delays the failure.
  const wtDocsDir = join(wtPath, "aidlc-docs");
  try {
    mkdirSync(wtDocsDir, { recursive: true });
  } catch (e) {
    errorWithSlug(slug, `failed to create ${wtDocsDir}: ${errorMessage(e)}`);
  }

  // Hold the audit lock across the whole transaction so:
  //   - the dedup-check / emit / write are atomic against concurrent forks
  //     (no two forks for the same slug can both pass the dedup check);
  //   - the audit row only emits when we know the write will land cleanly
  //     (no phantom STATE_FORKED on duplicate-slug or stale-state failures);
  //   - process.exit() inside the body still releases the lock dir via
  //     withAuditLock's exit-handler safety net (Bun's process.exit skips
  //     `finally`, which would otherwise poison the project for ~5s).
  let srcSha: string;
  try {
    srcSha = withAuditLock(pd, () => {
    let mainContent: string;
    try {
      mainContent = readStateFile(pd);
    } catch (e) {
      errorWithSlug(slug, `failed to read main state: ${errorMessage(e)}`);
      return ""; // unreachable
    }
    const sha = sha256(mainContent);

    // Dedup BEFORE emit: if the slug is already in Bolt Refs, fail without
    // emitting a phantom audit row. Recovery from a stale ref entry is the
    // caller's responsibility (see SKILL.md Step 0.6 recovery seam — discard
    // + re-fork is supported because the next fork sees the slug already
    // present and exits without poisoning audit).
    const currentRefs = getField(mainContent, "Bolt Refs") ?? "";
    if (parseRefsList(currentRefs).includes(slug)) {
      errorWithSlug(slug, `slug already in Bolt Refs (current: ${currentRefs.trim()}). If a prior fork failed mid-operation, run 'aidlc-worktree discard --slug ${slug}' and 'aidlc-state.ts merge --slug ${slug}' (which will exit "already merged" cleanly) or remove the stale entry from main state, then retry.`);
    }

    // Append slug to main's Bolt Refs first (the side effect that "registers"
    // the fork). If this fails, no audit, no worktree state — clean recovery.
    let mainNow = mainContent;
    try {
      mainNow = setFieldStrict(mainNow, "Bolt Refs", appendSlug(currentRefs, slug));
    } catch (e) {
      errorWithSlug(slug, `failed to compute updated Bolt Refs: ${errorMessage(e)}`);
    }

    // Audit-first within the locked critical section. Use the unlocked
    // variant since we already hold the lock.
    try {
      appendAuditEntryUnlocked("STATE_FORKED", {
        "Bolt slug": slug,
        "Worktree path": wtPath,
        "Source state hash": sha,
        "Target state hash": sha, // fork = byte-identical copy
      }, pd);
    } catch (e) {
      errorWithSlug(slug, `audit emission failed: ${errorMessage(e)}`);
    }

    // Write main state with updated Bolt Refs.
    try {
      writeStateFile(pd, mainNow);
    } catch (e) {
      errorWithSlug(slug, `failed to write main state with updated Bolt Refs: ${errorMessage(e)}`);
    }

    // Write worktree state with the decorative Worktree Path breadcrumb.
    // Done last so a write failure here leaves a recoverable surface: main's
    // Bolt Refs has the slug, audit has the row, but the worktree's state
    // file is missing — doctor reconciles by checking
    // `<worktreePath>/aidlc-docs/aidlc-state.md` existence against Bolt Refs.
    let wtContent = mainContent;
    try {
      wtContent = setFieldStrict(wtContent, "Worktree Path", wtPath);
    } catch (e) {
      errorWithSlug(slug, `failed to set Worktree Path on worktree state: ${errorMessage(e)}`);
    }
    try {
      writeStateFile(wtPath, wtContent);
    } catch (e) {
      errorWithSlug(slug, `failed to write worktree state at ${wtPath}: ${errorMessage(e)}`);
    }

    return sha;
    });
  } catch (e) {
    // Slug-tag any error from the locked block (most commonly: lock-acquire
    // timeout when a peer tool holds the lock across the retry budget).
    errorWithSlug(slug, errorMessage(e));
    return; // unreachable
  }

  process.stdout.write(
    `${JSON.stringify({
      status: "forked",
      slug,
      worktree_path: wtPath,
      source_state_hash: srcSha,
    })}\n`
  );
}

// merge --slug <slug> [--target-dir <path>]
//
// Merges <worktreePath>/aidlc-docs/aidlc-state.md back to main. Workflow-level
// singletons are kept from main (untouched); Construction Stage Progress cells
// merge from the worktree; alphabetical-slug tiebreak as defence-in-depth.
// Idempotent: re-running for an already-merged slug exits non-zero with a
// clear "already merged" error and emits no second STATE_MERGED row.
function handleMerge(args: string[]): void {
  const flags = parseFlags(args);
  const slug = validateSlug(flags.slug);
  const pd = resolveProjectDir(projectDir);

  const wtPath = flags["target-dir"] ?? worktreePath(pd, slug);
  if (!existsSync(wtPath)) {
    errorWithSlug(slug, `worktree directory does not exist: ${wtPath}.`);
  }
  const wtStatePath = join(wtPath, "aidlc-docs", "aidlc-state.md");
  if (!existsSync(wtStatePath)) {
    errorWithSlug(slug, `worktree state file does not exist: ${wtStatePath}. Was fork run?`);
  }

  // Read worktree state outside the lock — its file isn't shared with peers
  // (each Bolt owns its own worktree state file), so it doesn't need the
  // audit lock for consistency.
  const wtContent = readStateFile(wtPath);
  const wtSha = sha256(wtContent);
  const wtCheckboxes = parseCheckboxes(wtContent);

  // Hold the audit lock across the entire decide-emit-write transaction so
  // conflict-resolution decisions, the audit Target state hash, and the
  // actual main state write are all consistent with the SAME view of main.
  // Without this, a third concurrent merge landing between our snapshot and
  // our write would cause: (a) the audit Target hash to disagree with the
  // actual post-write SHA, (b) stale Bolt Refs being used to compute the
  // alphabetical tiebreak, and (c) one merge clobbering another's writes.
  let result: { postMergeSha: string; conflictResolutionField: string };
  try {
    result = withAuditLock(pd, () => {
    const mainContent = readStateFile(pd);

    // Idempotency: if slug is not in main's Bolt Refs, this is a re-run after
    // a prior successful merge (or a never-forked slug). Either way, no work
    // to do; emit no second audit row.
    const currentRefs = getField(mainContent, "Bolt Refs") ?? "";
    const refsList = parseRefsList(currentRefs);
    if (!refsList.includes(slug)) {
      errorWithSlug(slug, `already merged: not in Bolt Refs (current: ${currentRefs.trim()})`);
    }

    // Per-field merge rule, computed against the LOCKED snapshot:
    //  - Workflow-level singletons (Project, Project Type, Scope, Start Date,
    //    State Version, Active Agent, Practices Affirmed Timestamp): main
    //    wins. These come straight from `mainContent` untouched.
    //  - Construction Stage Progress checkboxes: take the worktree's value
    //    when the worktree advanced past main's, IF this slug is the
    //    alphabetically-lowest active ref. Workflow-level fields stay from
    //    main automatically because we start from mainContent and only
    //    overwrite the per-stage cells.
    //  - Tiebreak (alphabetical-slug, defence-in-depth): if multiple slugs
    //    in Bolt Refs would compete for the same cell, the lower
    //    alphabetical slug wins.
    let merged = mainContent;
    const conflictResolution: string[] = [];
    const mainCheckboxes = parseCheckboxes(mainContent);
    const mainStateMap = new Map(mainCheckboxes.map((c) => [c.slug, c.state]));
    const candidateSlugs = [...refsList].sort();
    const winningSlug = candidateSlugs[0];

    for (const wtCb of wtCheckboxes) {
      const mainCbState = mainStateMap.get(wtCb.slug);
      if (!mainCbState) continue;
      if (mainCbState === wtCb.state) continue;

      if (winningSlug === slug) {
        merged = setCheckbox(merged, wtCb.slug, wtCb.state);
        if (refsList.length > 1) {
          conflictResolution.push(`${wtCb.slug}:slug-precedence:${slug}`);
        }
      } else {
        conflictResolution.push(`${wtCb.slug}:deferred-to:${winningSlug}`);
      }
    }

    // Remove slug from Bolt Refs.
    merged = setFieldStrict(merged, "Bolt Refs", removeSlug(currentRefs, slug));

    const conflictResolutionField =
      conflictResolution.length === 0 ? "clean" : conflictResolution.join("; ");
    // Target hash matches the actual post-write content — computed inside the
    // lock against the final `merged` value so doctor can verify by
    // re-hashing the file at observation time.
    const postMergeSha = sha256(merged);

    // Strict audit-first within the locked critical section.
    try {
      appendAuditEntryUnlocked("STATE_MERGED", {
        "Bolt slug": slug,
        "Worktree path": wtPath,
        "Source state hash": wtSha,
        "Target state hash": postMergeSha,
        "Conflict resolution": conflictResolutionField,
      }, pd);
    } catch (e) {
      errorWithSlug(slug, `audit emission failed: ${errorMessage(e)}`);
    }

    writeStateFile(pd, merged);

    return { postMergeSha, conflictResolutionField };
    });
  } catch (e) {
    // Slug-tag any error from the locked block (most commonly: lock-acquire
    // timeout when a peer tool holds the lock across the retry budget).
    errorWithSlug(slug, errorMessage(e));
    return; // unreachable
  }

  process.stdout.write(
    `${JSON.stringify({
      status: "merged",
      slug,
      worktree_path: wtPath,
      source_state_hash: wtSha,
      target_state_hash: result.postMergeSha,
      conflict_resolution: result.conflictResolutionField,
    })}\n`
  );
}

// --- Utility ---

function error(msg: string): never {
  // Honor module-level projectDir (set from --project-dir in main) so test
  // fixtures and explicit overrides propagate to ERROR_LOGGED.
  const pd = resolveProjectDir(projectDir);
  const command = `aidlc-state ${process.argv.slice(2).join(" ")}`.trim();
  emitError(pd, "aidlc-state", command, msg);
}
