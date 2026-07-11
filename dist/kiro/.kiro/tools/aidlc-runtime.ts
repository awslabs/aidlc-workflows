// Runtime-graph compile + read tool. Materialises a per-workflow
// runtime-graph.json from audit.md + per-stage memory.md files; the
// data-plane mirror of stage-graph.json (which is structural truth).
//
// Subcommands:
//   compile                       Walk audit + memory, write runtime-graph.json
//   read    <stage-slug>          Print one stage row from runtime-graph.json
//
// The compile subcommand is invoked by the PostToolUse Bash hook
// (aidlc-runtime-compile.ts) on every transition-class audit emit. Pure
// observer — never mutates state.md, never asks the user, only reads the
// audit log + memory.md files and writes runtime-graph.json + emits
// MEMORY_EMPTY rows for zero-entry approved stages.
//
// Schema is locked in docs/reference/13-runtime-graph.md and pinned by
// the test suite. Changing the shape requires bumping every consumer
// (Bolt fork/merge, gate ritual, lifecycle, doctor) in the same change.
//
// Determinism: re-running compile against the same audit log produces a
// byte-equivalent runtime-graph.json. Emitted MEMORY_EMPTY rows are
// re-emitted on re-compile (append-only audit, no row de-duplication);
// the doctor de-duplicates by (Stage, ISO-second) tuple when computing
// the MEMORY_EMPTY-rate metric.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import {
  errorMessage,
  activeIntent,
  findAllEvents,
  getField,
  loadStageGraph,
  memoryFilePath,
  parseBoltDag,
  parseCheckboxes,
  parseMemoryHeadings,
  parseStateStageSuffixes,
  readAllAuditShards,
  activeSpace,
  readStateFile,
  relativeMemoryPath,
  relativeRecordDir,
  resolveProjectDir,
  runtimeGraphPath,
  stateFilePath,
  unitDependencyPath,
  validateBoltSlug,
  withAuditLock,
  worktreePath,
  worktreeRuntimeGraphPath,
  writeFileAtomic,
} from "./aidlc-lib.ts";

// --- Schema (must match docs/reference/13-runtime-graph.md exactly) ---

interface MemoryBreakdown {
  interpretations: number;
  deviations: number;
  tradeoffs: number;
  open_questions: number;
}

interface SensorFiring {
  id: string;
  fire_id: string; // 8-hex correlator emitted by the sensor dispatcher on every row
  result: "passed" | "failed" | "budget-override" | "incomplete"; // 4-state: the dispatcher's three terminals + the orphan "incomplete"
  ts: string; // FIRED row's timestamp
  detail_path?: string;
}

interface BoltInstance {
  bolt: string;
  worktree: string;
  started_at: string;
  completed_at: string | null;
  memory_path: string;
  memory_entries: number | null;
  memory_breakdown: MemoryBreakdown | null;
  sensor_firings: SensorFiring[];
  outcome: "approved" | "failed" | "pending";
}

interface RuntimeStage {
  stage_slug: string;
  // Single-instance fields (started_at, completed_at, agent, memory_path,
  // memory_entries, memory_breakdown) are NULL when `instances` is present —
  // those values sit on each BoltInstance instead. memory_path stays populated
  // even on instance-bearing rows (it's the parent stage's path).
  started_at: string | null;
  completed_at: string | null;
  agent: string | null;
  memory_path: string;
  memory_entries: number | null;
  memory_breakdown: MemoryBreakdown | null;
  sensor_firings: SensorFiring[];
  outcome: "approved" | "failed" | "pending";
  learnings_captured: {
    from_orchestrator: number;
    from_user_addition: number;
  } | null;
  instances?: BoltInstance[];
}

// The Bolt/unit dependency DAG, parsed from units-generation's
// unit-of-work-dependency.md fenced edge block. `batches` are topological
// levels — each is a set of units whose dependencies are all satisfied by
// prior batches, so the units in one batch can fan out in parallel (the
// swarm reads this shape; "the DAG is the permission"). Present only once a
// valid edge block exists on disk; absent/malformed/cyclic blocks omit the
// node entirely (the gate-time required-sections sensor flags those upstream).
interface BoltDag {
  units: { name: string; depends_on: string[]; kind?: string }[];
  batches: string[][];
}

interface RuntimeGraph {
  workflow_id: string;
  scope: string;
  started_at: string;
  stages: RuntimeStage[];
  bolt_dag?: BoltDag;
}

// --- Path helpers ---
//
// The aidlc-docs data-path helpers (runtimeGraphPath, memoryFilePath,
// unitDependencyPath, relativeMemoryPath, worktreeRuntimeGraphPath) are imported
// from aidlc-lib.ts — the single chokepoint for the aidlc-docs tree. memoryPath
// here is memoryFilePath; the per-row relative form is relativeMemoryPath.

// --- Compile ---

interface CompileOptions {
  projectDir: string;
}

// Walk the audit log chronologically and build a per-slug map of
// {started_at, completed_at, agent}. Pairing rule: STARTED@T1 with
// later COMPLETED@T2 → approved (completed_at = T2). STARTED with no
// later COMPLETED for that slug → pending. A re-jump that re-emits
// STAGE_STARTED for an already-completed slug resets the entry, so
// the latest STAGE_STARTED wins (the row reflects current intent).
//
// One row per slug. Sub-second timestamp collisions resolve via
// findAllEvents source-line order (deterministic per CRLF-normalised
// audit walk).
interface PairingEntry {
  started_at: string;
  completed_at: string | null;
  agent: string;
  // Source-position index of this slug's latest STAGE_STARTED in the merged
  // chronological stream. Used as the tie-breaker when two stages share an
  // ISO-second started_at, so the row ordering remains deterministic.
  startedIndex: number;
}

// A `--single` stage-runner run commits its STAGE_STARTED/STAGE_COMPLETED
// pair under a synthetic `**Workflow**: single-stage:<slug>` id (see
// aidlc-orchestrate.ts handleSingleReport). Those rows belong to no main
// workflow and must never pair into the main runtime graph — a single run
// "never advances your main workflow", and that includes its compiled
// mirror. Main-workflow STAGE_* rows (emitted by aidlc-state.ts /
// aidlc-utility.ts / aidlc-jump.ts) carry NO Workflow field, so absence
// means main-workflow and the row is kept.
const SINGLE_STAGE_WORKFLOW_RE = /^\*\*Workflow\*\*:\s*single-stage:/m;

function isSingleStageRow(block: string): boolean {
  return SINGLE_STAGE_WORKFLOW_RE.test(block);
}

function pairStartedCompleted(
  audit: string,
  sinceTimestamp: string
): Map<string, PairingEntry> {
  // findAllEvents returns blocks chronologically (timestamp-sorted, ties broken
  // by buffer position). sinceTimestamp filters out rows from prior workflows on
  // the same audit log (the `--init --force` re-init case appends without
  // truncating). Synthetic single-stage rows are excluded regardless of timestamp.
  const startedEvents = findAllEvents(audit, "STAGE_STARTED").filter(
    (e) => e.timestamp >= sinceTimestamp && !isSingleStageRow(e.block)
  );
  const completedEvents = findAllEvents(audit, "STAGE_COMPLETED").filter(
    (e) => e.timestamp >= sinceTimestamp && !isSingleStageRow(e.block)
  );

  // Merge into a single chronological stream. ISO timestamps sort
  // lexicographically; ties broken by source-position by tagging each
  // event with its index in findAllEvents output (which is already
  // source-position-ordered).
  const stream: Array<{
    kind: "STARTED" | "COMPLETED";
    timestamp: string;
    block: string;
    index: number;
  }> = [];
  startedEvents.forEach((e, i) => {
    stream.push({ kind: "STARTED", timestamp: e.timestamp, block: e.block, index: i });
  });
  completedEvents.forEach((e, i) => {
    stream.push({ kind: "COMPLETED", timestamp: e.timestamp, block: e.block, index: i + 100000 });
  });
  stream.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    return a.index - b.index;
  });

  const map = new Map<string, PairingEntry>();
  let sourceIndex = 0;
  for (const ev of stream) {
    const stageMatch = ev.block.match(/^\*\*Stage\*\*:\s*(\S+)/m);
    if (!stageMatch) continue;
    const slug = stageMatch[1].trim();

    if (ev.kind === "STARTED") {
      const agentMatch = ev.block.match(/^\*\*Agent\*\*:\s*(.+)$/m);
      const agent = agentMatch ? agentMatch[1].trim() : "";
      map.set(slug, {
        started_at: ev.timestamp,
        completed_at: null,
        agent,
        startedIndex: sourceIndex++,
      });
    } else {
      const entry = map.get(slug);
      if (entry && entry.completed_at === null) {
        entry.completed_at = ev.timestamp;
      }
    }
  }
  return map;
}

// Build the workflow-level fields (workflow_id, scope, started_at) from
// audit + state. workflow_id is the LATEST WORKFLOW_STARTED timestamp —
// `--init --force` re-init appends a new WORKFLOW_STARTED without
// truncating audit.md, and the live workflow is the latest one. Using
// the first row would identify a dead workflow.
function buildWorkflowHeader(
  audit: string,
  stateContent: string | null
): { workflow_id: string; scope: string; started_at: string } | null {
  const started = findAllEvents(audit, "WORKFLOW_STARTED");
  if (started.length === 0) return null;
  const latest = started[started.length - 1];
  const scopeFromAudit = latest.block.match(/^\*\*Scope\*\*:\s*(.+)$/m);
  const scopeFromState = stateContent ? getField(stateContent, "Scope") : null;
  const scope = scopeFromState || (scopeFromAudit ? scopeFromAudit[1].trim() : "");
  return {
    workflow_id: latest.timestamp,
    scope,
    started_at: latest.timestamp,
  };
}

// Build a phase-by-slug lookup from stage-graph.json. Reuses the
// in-memory cache; no per-compile re-parse.
function buildPhaseMap(): Map<string, { phase: string; agent: string }> {
  const stages = loadStageGraph();
  const map = new Map<string, { phase: string; agent: string }>();
  for (const s of stages) {
    map.set(s.slug, { phase: s.phase, agent: s.lead_agent });
  }
  return map;
}

// Read memory.md for a stage and return entries + breakdown. Returns
// null/null when the file does not exist (backfill rule for stages
// that completed before memory.md tracking shipped); zero counts when
// the file exists but has no entries.
function readMemory(
  projectDir: string,
  phase: string,
  stageSlug: string
): { memory_entries: number | null; memory_breakdown: MemoryBreakdown | null } {
  const path = memoryFilePath(projectDir, phase, stageSlug);
  if (!existsSync(path)) {
    return { memory_entries: null, memory_breakdown: null };
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = parseMemoryHeadings(raw);
  return {
    memory_entries: parsed.total,
    memory_breakdown: {
      interpretations: parsed.interpretations,
      deviations: parsed.deviations,
      tradeoffs: parsed.tradeoffs,
      open_questions: parsed.open_questions,
    },
  };
}

// Read units-generation's unit-of-work-dependency.md and compute the
// Bolt/unit batch DAG. Returns undefined (node omitted) when the artifact
// is absent, or when its edge block is absent / malformed / cyclic — those
// failures are surfaced at the 2.7 gate by the required-sections sensor, not
// silently encoded into a wrong-but-valid DAG. The parse is pure data (no
// model call), so a re-compile is byte-identical.
function computeBoltDag(projectDir: string): BoltDag | undefined {
  const path = unitDependencyPath(projectDir);
  if (!existsSync(path)) return undefined;
  const body = readFileSync(path, "utf-8");
  const parsed = parseBoltDag(body);
  if (!parsed.ok) {
    process.stderr.write(
      `runtime-compile: unit-of-work-dependency.md edge block ${parsed.reason} ` +
        `(${parsed.detail}); bolt_dag node omitted\n`
    );
    return undefined;
  }
  return { units: parsed.units, batches: parsed.batches };
}

// --- Compile core ---

function compile(opts: CompileOptions): { skipped?: string; written?: string } {
  const { projectDir } = opts;

  // Env-misconfig fallback per plan §97-102.
  const statePath = stateFilePath(projectDir);
  if (!existsSync(statePath)) {
    process.stderr.write(
      "runtime-compile: no aidlc-state.md, skipping (likely pre-init)\n"
    );
    return { skipped: "no-state" };
  }
  // Read across every per-clone audit shard (single shard in the common case).
  const audit = readAllAuditShards(projectDir);
  if (audit.length === 0) {
    // No audit yet — write an empty graph anchored to state cursor only,
    // mirroring the "fresh init, no transitions" case.
    return writeEmptyGraph(projectDir);
  }

  const stateContent = readStateFile(projectDir);

  const header = buildWorkflowHeader(audit, stateContent);
  if (!header) {
    return writeEmptyGraph(projectDir);
  }

  const pairing = pairStartedCompleted(audit, header.started_at);
  const phaseMap = buildPhaseMap();

  // Build stage rows in chronological order (sorted by started_at, ties
  // broken by source-position to keep ordering deterministic across runs).
  const slugsByStartTime = [...pairing.entries()].sort((a, b) => {
    if (a[1].started_at !== b[1].started_at) {
      return a[1].started_at < b[1].started_at ? -1 : 1;
    }
    return a[1].startedIndex - b[1].startedIndex;
  });

  const stages: RuntimeStage[] = [];
  const zeroEntryApprovedStages: { slug: string; completed_at: string }[] = [];

  // The active intent's RELATIVE record-dir prefix (aidlc/spaces/<sp>/intents/
  // <slug>-<id8>), so each row's memory_path resolves under the active intent
  // rather than the bare space prefix. null -> the bare space record prefix (a
  // pre-birth shell with no intent). Resolved once: the active intent is stable
  // across a single compile.
  const recordPrefix = relativeRecordDir(projectDir);

  for (const [slug, entry] of slugsByStartTime) {
    const phaseInfo = phaseMap.get(slug);
    if (!phaseInfo) continue; // unknown slug — skip rather than fail

    const memory = readMemory(projectDir, phaseInfo.phase, slug);
    const outcome: RuntimeStage["outcome"] =
      entry.completed_at !== null ? "approved" : "pending";

    stages.push({
      stage_slug: slug,
      started_at: entry.started_at,
      completed_at: entry.completed_at,
      agent: entry.agent || phaseInfo.agent,
      memory_path: relativeMemoryPath(phaseInfo.phase, slug, recordPrefix),
      memory_entries: memory.memory_entries,
      memory_breakdown: memory.memory_breakdown,
      sensor_firings: [],
      outcome,
      learnings_captured:
        outcome === "approved"
          ? { from_orchestrator: 0, from_user_addition: 0 }
          : null,
    });

    // MEMORY_EMPTY emit applies to approved rows only with memory_entries === 0.
    // We capture the slug's completed_at so the locked section can suppress
    // re-emits — exactly one MEMORY_EMPTY per (slug, gate-completion) tuple.
    // Re-jump + re-approve produces a new completed_at, so a still-empty
    // stage on re-approval emits again (the suppression check is "since
    // THIS approval's completed_at", not "ever"). The condition checks
    // entry.completed_at !== null directly (rather than the derived
    // `outcome === "approved"`) so TypeScript narrows the union and we
    // can pass the field without a non-null assertion.
    if (entry.completed_at !== null && memory.memory_entries === 0) {
      zeroEntryApprovedStages.push({ slug, completed_at: entry.completed_at });
    }
  }

  // --- BoltInstance[] populator (parallel-Bolt detection) ----------------
  //
  // For each Construction-phase stage row, detect parallel-Bolt audit
  // footprint and (when ≥ 2 distinct slugs are present in the stage's
  // window) replace the parent's single-instance fields with a populated
  // `instances[]` array. Single-Bolt stages stay single-instance — the
  // schema reserves `instances?` as optional.
  //
  // Detection rule: a stage row gets `instances[]` when audit contains ≥ 2
  // distinct `Bolt slug` values whose STATE_FORKED rows fall within the
  // stage's [stage.started_at, stage.completed_at OR now) window AND the
  // stage's phase is `construction`. The window's started_at is the
  // LATEST STAGE_STARTED for that slug: re-jumps reset the window so
  // prior-cycle Bolts don't bleed into the new cycle's instances[].
  // pairing.entries() already gives us the latest per stage-slug.
  //
  // Per-instance pairing:
  //   - bolt: STATE_FORKED's `Bolt slug` field
  //   - worktree: STATE_FORKED's `Worktree path` field
  //   - started_at: STATE_FORKED.Timestamp
  //   - completed_at: STATE_MERGED.Timestamp for the same slug, or null
  //   - outcome: STATE_MERGED present → "approved";
  //              else BOLT_FAILED for slug → "failed";
  //              else "pending"
  //   - memory_path: parent stage's memory_path (per-Bolt memory.md is a
  //                  forward-noted gap)
  //   - memory_entries / memory_breakdown: null (forward-noted)
  //   - sensor_firings: [] (forward-noted; per-instance attribution waits
  //                     for the sensor_firings populator that also fixes
  //                     the parent stage's hardcode)
  //
  // Ordering: alphabetical by Bolt slug. Stable across re-compiles
  // because audit timestamps don't influence ordering.
  //
  // Parent-stage null-out: when instances is non-empty, null `started_at`,
  // `completed_at`, `agent`, `memory_entries`, `memory_breakdown`.
  // memory_path STAYS populated (it's the parent stage's path, not a
  // per-Bolt one). sensor_firings stays []. Parent outcome derives from
  // the rollup table (all approved → approved; any failed → failed;
  // otherwise → pending).
  const allStateForkedEvents = findAllEvents(audit, "STATE_FORKED");
  const allStateMergedEvents = findAllEvents(audit, "STATE_MERGED");
  const allBoltFailedEvents = findAllEvents(audit, "BOLT_FAILED");

  // Helper: read a field's value from an audit row block. Mirrors
  // getField's discipline at aidlc-lib.ts:184-194 (single-line match,
  // [ \t]* not \s*) without the dynamic-regexp pattern — callers pass
  // hard-coded field names but the helper is line-scanned to keep ReDoS
  // surface zero. Block format: lines of `**FieldName**: value`.
  const fieldFromBlock = (block: string, fieldName: string): string | null => {
    const prefix = `**${fieldName}**:`;
    for (const line of block.split("\n")) {
      if (line.startsWith(prefix)) {
        return line.slice(prefix.length).trim();
      }
    }
    return null;
  };

  for (const stage of stages) {
    const phaseInfo = phaseMap.get(stage.stage_slug);
    if (phaseInfo?.phase !== "construction") continue;

    const windowStart = stage.started_at;
    const windowEnd = stage.completed_at; // null → unbounded above (mid-flight)
    if (windowStart === null) continue; // shouldn't happen pre-instances pass

    // Group STATE_FORKED rows in the stage's window by Bolt slug. Latest
    // STATE_FORKED for the same slug wins (re-fork edge case, mirrors
    // pairStartedCompleted's latest-wins rule).
    const slugsInWindow = new Map<
      string,
      { worktree: string; started_at: string }
    >();
    for (const ev of allStateForkedEvents) {
      if (ev.timestamp < windowStart) continue;
      if (windowEnd !== null && ev.timestamp >= windowEnd) continue;
      const slug = fieldFromBlock(ev.block, "Bolt slug");
      const wt = fieldFromBlock(ev.block, "Worktree path");
      if (!slug) continue;
      slugsInWindow.set(slug, {
        worktree: wt ?? "",
        started_at: ev.timestamp,
      });
    }

    if (slugsInWindow.size < 2) continue; // single-Bolt stays single-instance

    // Sort slugsInWindow's entries() alphabetically by slug, then map
    // each (slug, fork) pair to a BoltInstance. Iterating entries() lets
    // us destructure both fields without a separate map lookup (which
    // would need a non-null assertion since the slug came from .keys()).
    const instances: BoltInstance[] = [...slugsInWindow.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([slug, fork]) => {
        // Find STATE_MERGED for this slug at-or-after the fork timestamp
        // and within the stage window. "At-or-after" because STATE_MERGED
        // for an earlier same-slug fork shouldn't leak in (latest-fork wins).
        const merged = allStateMergedEvents.find((ev) => {
          if (ev.timestamp < fork.started_at) return false;
          if (windowEnd !== null && ev.timestamp >= windowEnd) return false;
          return fieldFromBlock(ev.block, "Bolt slug") === slug;
        });

        // Find BOLT_FAILED for this slug after the fork timestamp.
        const failed = allBoltFailedEvents.find((ev) => {
          if (ev.timestamp < fork.started_at) return false;
          if (windowEnd !== null && ev.timestamp >= windowEnd) return false;
          return fieldFromBlock(ev.block, "Bolt slug") === slug;
        });

        const instOutcome: BoltInstance["outcome"] = merged
          ? "approved"
          : failed
            ? "failed"
            : "pending";

        return {
          bolt: slug,
          worktree: fork.worktree,
          started_at: fork.started_at,
          completed_at: merged ? merged.timestamp : null,
          memory_path: stage.memory_path,
          memory_entries: null, // per-Bolt memory.md is a forward-noted gap
          memory_breakdown: null,
          sensor_firings: [], // per-instance attribution is a forward-noted gap
          outcome: instOutcome,
        };
      });

    // Parent rollup: all approved → approved; any failed → failed;
    // otherwise (any pending, no failures) → pending.
    const anyFailed = instances.some((i) => i.outcome === "failed");
    const anyPending = instances.some((i) => i.outcome === "pending");
    const parentOutcome: RuntimeStage["outcome"] = anyFailed
      ? "failed"
      : anyPending
        ? "pending"
        : "approved";

    // Mutate parent stage row: null per-Bolt fields + attach instances[].
    // memory_path STAYS populated (parent path); sensor_firings stays [].
    // learnings_captured follows the schema invariant `null on non-approved
    // rows` — when the rollup flips outcome to pending or failed, the
    // approved-only `{from_orchestrator, from_user_addition}` shape from the
    // single-instance row builder above (lines 324-327) becomes inconsistent
    // and must be nulled. Gate-ritual surfaces that want per-Bolt provenance
    // attach it independently, not via this rollup.
    stage.started_at = null;
    stage.completed_at = null;
    stage.agent = null;
    stage.memory_entries = null;
    stage.memory_breakdown = null;
    stage.outcome = parentOutcome;
    if (parentOutcome !== "approved") {
      stage.learnings_captured = null;
    }
    stage.instances = instances;
  }

  // --- sensor_firings[] + learnings_captured populator ---------------------
  //
  // Walk the audit's SENSOR_* and RULE_LEARNED/SENSOR_PROPOSED rows and
  // attach them to each stage row / BoltInstance window. Pairing is by the
  // 8-hex `Fire id` correlator (NOT positional — the PostToolUse hook fans a
  // single Write out to 4 parallel sensor fires whose terminal rows interleave
  // by spawn duration). Orphan FIRED rows (no terminal) become `incomplete`
  // immediately in a closed stage window, or after a deterministic 60s cutoff
  // (DEFAULT_TIMEOUT_SECONDS, a non-exported const at aidlc-sensor.ts:44) in an
  // open window — measured against `baseline_ts` (max audit timestamp), never
  // `Date.now()`, so re-compile is byte-equal.
  const firedRows = findAllEvents(audit, "SENSOR_FIRED");
  const passedRows = findAllEvents(audit, "SENSOR_PASSED");
  const failedRows = findAllEvents(audit, "SENSOR_FAILED");
  const budgetRows = findAllEvents(audit, "SENSOR_BUDGET_OVERRIDE");
  const ruleLearnedRows = findAllEvents(audit, "RULE_LEARNED");
  const sensorProposedRows = findAllEvents(audit, "SENSOR_PROPOSED");

  // Map fire_id → terminal row. Duplicate fire_id across two terminals →
  // latest-ts wins (log to stderr). The literal terminal result is carried
  // alongside so the per-stage pairing reads it without re-deriving.
  type TerminalKind = "passed" | "failed" | "budget-override";
  const terminalByFireId = new Map<
    string,
    { kind: TerminalKind; ts: string; detail_path?: string }
  >();
  const recordTerminal = (
    rows: { timestamp: string; block: string }[],
    kind: TerminalKind
  ) => {
    for (const ev of rows) {
      const fireId = fieldFromBlock(ev.block, "Fire id");
      if (!fireId) continue;
      const detail = fieldFromBlock(ev.block, "Detail path");
      const existing = terminalByFireId.get(fireId);
      if (existing && existing.ts >= ev.timestamp) {
        process.stderr.write(
          `runtime-compile: duplicate terminal for Fire id ${fireId} (keeping latest-ts)\n`
        );
        continue;
      }
      if (existing) {
        process.stderr.write(
          `runtime-compile: duplicate terminal for Fire id ${fireId} (keeping latest-ts)\n`
        );
      }
      terminalByFireId.set(fireId, {
        kind,
        ts: ev.timestamp,
        ...(kind === "failed" && detail ? { detail_path: detail } : {}),
      });
    }
  };
  recordTerminal(passedRows, "passed");
  recordTerminal(failedRows, "failed");
  recordTerminal(budgetRows, "budget-override");

  // baseline_ts = MAX timestamp across all audit rows in this compile.
  // Used as the deterministic "now" for the open-window orphan cutoff.
  let baselineTs = "";
  for (const ev of findAllEvents(audit, "STAGE_STARTED")) {
    if (ev.timestamp > baselineTs) baselineTs = ev.timestamp;
  }
  for (const rows of [firedRows, passedRows, failedRows, budgetRows]) {
    for (const ev of rows) {
      if (ev.timestamp > baselineTs) baselineTs = ev.timestamp;
    }
  }

  const ORPHAN_CUTOFF_SECONDS = 60; // = DEFAULT_TIMEOUT_SECONDS (aidlc-sensor.ts:44, not exported)

  // Pair the FIRED rows that fall in a [start, end) window and match the
  // stage slug (and, for instances, an output path under the worktree) into
  // SensorFiring[]. `outputUnderWorktree` is null for the parent pass.
  const pairFirings = (
    slug: string,
    windowStart: string,
    windowEnd: string | null,
    outputUnderWorktree: ((outputPath: string) => boolean) | null
  ): SensorFiring[] => {
    const firings: SensorFiring[] = [];
    for (const ev of firedRows) {
      if (ev.timestamp < windowStart) continue;
      if (windowEnd !== null && ev.timestamp >= windowEnd) continue;
      if (fieldFromBlock(ev.block, "Stage slug") !== slug) continue;
      if (outputUnderWorktree !== null) {
        const out = fieldFromBlock(ev.block, "Output path") ?? "";
        if (!outputUnderWorktree(out)) continue;
      }
      const fireId = fieldFromBlock(ev.block, "Fire id");
      const sensorId = fieldFromBlock(ev.block, "Sensor ID");
      if (!fireId || !sensorId) continue;
      const terminal = terminalByFireId.get(fireId);
      if (terminal) {
        firings.push({
          id: sensorId,
          fire_id: fireId,
          result: terminal.kind,
          ts: ev.timestamp,
          ...(terminal.detail_path ? { detail_path: terminal.detail_path } : {}),
        });
        continue;
      }
      // Orphan: no terminal row paired by fire_id.
      if (windowEnd !== null) {
        // Closed window — window-end IS the cutoff; orphan is incomplete.
        firings.push({ id: sensorId, fire_id: fireId, result: "incomplete", ts: ev.timestamp });
      } else {
        // Open window — incomplete only once baseline_ts has advanced ≥60s
        // past the FIRED ts; younger orphans are omitted (no 5th "pending").
        const ageSeconds =
          (Date.parse(baselineTs) - Date.parse(ev.timestamp)) / 1000;
        if (ageSeconds >= ORPHAN_CUTOFF_SECONDS) {
          firings.push({ id: sensorId, fire_id: fireId, result: "incomplete", ts: ev.timestamp });
        }
      }
    }
    firings.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return firings;
  };

  // Count RULE_LEARNED/SENSOR_PROPOSED rows in a window, split by Source.
  const countLearnings = (
    slug: string,
    windowStart: string,
    windowEnd: string | null
  ): { from_orchestrator: number; from_user_addition: number } => {
    let fromOrchestrator = 0;
    let fromUserAddition = 0;
    for (const ev of [...ruleLearnedRows, ...sensorProposedRows]) {
      if (ev.timestamp < windowStart) continue;
      if (windowEnd !== null && ev.timestamp >= windowEnd) continue;
      if (fieldFromBlock(ev.block, "Stage") !== slug) continue;
      const source = fieldFromBlock(ev.block, "Source");
      if (source === "user_addition") fromUserAddition++;
      else fromOrchestrator++;
    }
    return { from_orchestrator: fromOrchestrator, from_user_addition: fromUserAddition };
  };

  for (const stage of stages) {
    if (stage.instances && stage.instances.length > 0) {
      // Instance-bearing parent: each instance gets its own worktree-scoped
      // firings; the parent holds only firings NOT under any worktree.
      const worktrees = stage.instances.map((i) => i.worktree);
      for (const inst of stage.instances) {
        inst.sensor_firings = pairFirings(
          stage.stage_slug,
          inst.started_at,
          inst.completed_at,
          (out) => inst.worktree !== "" && out.startsWith(inst.worktree)
        );
      }
      // Parent window spans the earliest instance start to the latest
      // instance end (or open if any instance is still open).
      const parentStart = stage.instances
        .map((i) => i.started_at)
        .reduce((a, b) => (a < b ? a : b));
      const completedTimes: string[] = [];
      let anyOpen = false;
      for (const inst of stage.instances) {
        if (inst.completed_at === null) {
          anyOpen = true;
        } else {
          completedTimes.push(inst.completed_at);
        }
      }
      const parentEnd =
        anyOpen || completedTimes.length === 0
          ? null
          : completedTimes.reduce((a, b) => (a > b ? a : b));
      stage.sensor_firings = pairFirings(
        stage.stage_slug,
        parentStart,
        parentEnd,
        (out) => !worktrees.some((wt) => wt !== "" && out.startsWith(wt))
      );
      // learnings_captured stays as the rollup left it (null on non-approved).
    } else if (stage.started_at !== null) {
      stage.sensor_firings = pairFirings(
        stage.stage_slug,
        stage.started_at,
        stage.completed_at,
        null
      );
      if (stage.outcome === "approved") {
        stage.learnings_captured = countLearnings(
          stage.stage_slug,
          stage.started_at,
          stage.completed_at
        );
      }
    }
  }

  const graph: RuntimeGraph = {
    workflow_id: header.workflow_id,
    scope: header.scope,
    started_at: header.started_at,
    stages,
  };

  // Bolt/unit batch DAG — append only when a valid edge block exists, so the
  // key order stays {…, stages, bolt_dag} and the absent case is byte-identical
  // to the pre-milestone-15 envelope (no empty-node noise).
  const boltDag = computeBoltDag(projectDir);
  if (boltDag) {
    graph.bolt_dag = boltDag;
  }

  // Audit-first inside ONE locked section: emit MEMORY_EMPTY rows first,
  // then write the artefact. Re-emit suppression: re-read audit inside the
  // lock and skip any (slug) that already has a MEMORY_EMPTY row whose
  // Timestamp >= the slug's current completed_at — gives exactly one
  // MEMORY_EMPTY per (slug, gate-completion) tuple, so doctor's rate
  // metric is honest under N-compile-per-workflow re-fires.
  withAuditLock(projectDir, () => {
    const auditNow = readAllAuditShards(projectDir);
    const existingEmpties = findAllEvents(auditNow, "MEMORY_EMPTY");

    for (const ze of zeroEntryApprovedStages) {
      // Skip if any MEMORY_EMPTY for this slug already lies at or after
      // this approval's completed_at — we've already recorded the skip
      // for this gate-completion.
      const alreadyEmitted = existingEmpties.some((ev) => {
        const stageMatch = ev.block.match(/^\*\*Stage\*\*:\s*(\S+)/m);
        if (!stageMatch || stageMatch[1].trim() !== ze.slug) return false;
        return ev.timestamp >= ze.completed_at;
      });
      if (alreadyEmitted) continue;

      const fields: Record<string, string> = { Stage: ze.slug };
      appendAuditEntryUnlocked("MEMORY_EMPTY", fields, projectDir);
    }
    writeFileAtomic(runtimeGraphPath(projectDir), `${JSON.stringify(graph, null, 2)}\n`);
  });

  return { written: runtimeGraphPath(projectDir) };
}

// Empty-graph short-circuit for the "state exists, no audit / no
// WORKFLOW_STARTED" cases. Writes a valid graph with empty stages array
// so downstream readers don't have to special-case absence.
//
// The optional `acquireLock` opts arg controls whether the write happens
// inside `withAuditLock`. Default `true` preserves compile's existing
// call-sites (it races other compile invocations against main and needs
// the lock). The fragment-fork source-absent path passes `false` because
// (a) it writes to a worktree-local path no other writer touches, and
// (b) fragment-fork stays out of the audit-lock regime entirely (no audit
// emit, no source-of-truth mutation).
function writeEmptyGraph(
  projectDir: string,
  opts?: { acquireLock?: boolean },
  intent?: string,
  space?: string
): { written: string } {
  const acquireLock = opts?.acquireLock ?? true;
  const stateContent = readStateFile(projectDir, intent, space);
  const scope = getField(stateContent, "Scope") || "";
  const graph: RuntimeGraph = {
    workflow_id: "",
    scope,
    started_at: "",
    stages: [],
  };
  const writer = () => {
    writeFileAtomic(runtimeGraphPath(projectDir, intent, space), `${JSON.stringify(graph, null, 2)}\n`);
  };
  if (acquireLock) {
    withAuditLock(projectDir, writer, intent, space);
  } else {
    writer();
  }
  return { written: runtimeGraphPath(projectDir, intent, space) };
}

// --- Read subcommand ---

function readStage(stageSlug: string, projectDir: string): RuntimeStage | null {
  const path = runtimeGraphPath(projectDir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const graph: RuntimeGraph = JSON.parse(raw);
  return graph.stages.find((s) => s.stage_slug === stageSlug) || null;
}

// --- Summary subcommand ---
//
// Deterministic aggregate view over runtime-graph.json. Reads the
// materialised snapshot only — never re-walks audit — so the output is a
// pure function of the graph (no LLM-side counting, no token heuristics).
// Read-only skills (session-cost, replay, outcomes-pack) consume the
// --json shape for every number they render.
//
// instances[] flattening: when a stage runs per-Bolt, its stage-level
// fields are null and the real data sits on each BoltInstance. Aggregation
// counts each instance as its own outcome/memory unit; a single-instance
// stage counts as one unit. The parent row is never double-counted.

interface SummaryUnit {
  outcome: "approved" | "failed" | "pending";
  memory_entries: number | null;
  memory_breakdown: MemoryBreakdown | null;
  sensor_firings: SensorFiring[];
}

function unitsForStage(s: RuntimeStage): SummaryUnit[] {
  if (s.instances && s.instances.length > 0) {
    return s.instances.map((i) => ({
      outcome: i.outcome,
      memory_entries: i.memory_entries,
      memory_breakdown: i.memory_breakdown,
      sensor_firings: i.sensor_firings,
    }));
  }
  return [
    {
      outcome: s.outcome,
      memory_entries: s.memory_entries,
      memory_breakdown: s.memory_breakdown,
      sensor_firings: s.sensor_firings,
    },
  ];
}

interface RuntimeSummary {
  workflow_id: string;
  scope: string;
  started_at: string;
  duration_minutes: number | null;
  stages: { total: number; approved: number; failed: number; pending: number };
  by_phase: Record<
    string,
    { total: number; approved: number; failed: number; pending: number }
  >;
  memory: {
    total: number;
    interpretations: number;
    deviations: number;
    tradeoffs: number;
    open_questions: number;
  };
  sensors: {
    total: number;
    passed: number;
    failed: number;
    budget_override: number;
    incomplete: number;
  };
  learnings: { from_orchestrator: number; from_user_addition: number };
}

type SummaryOutcome = "approved" | "failed" | "pending";

function completedStateOverlay(projectDir: string): Map<string, SummaryOutcome> | null {
  const path = stateFilePath(projectDir);
  if (!existsSync(path)) return null;
  const state = readStateFile(projectDir);
  if (getField(state, "Status") !== "Completed") return null;

  const suffixes = parseStateStageSuffixes(state);
  const outcomes = new Map<string, SummaryOutcome>();
  for (const cb of parseCheckboxes(state)) {
    if (suffixes.get(cb.slug) !== "EXECUTE") continue;
    if (cb.state === "completed") {
      outcomes.set(cb.slug, "approved");
    } else if (cb.state !== "skipped") {
      outcomes.set(cb.slug, "pending");
    }
  }
  return outcomes;
}

function summarize(projectDir: string): RuntimeSummary | null {
  const path = runtimeGraphPath(projectDir);
  if (!existsSync(path)) return null;
  const graph: RuntimeGraph = JSON.parse(readFileSync(path, "utf-8"));
  const phaseMap = buildPhaseMap();
  const stateOverlay = completedStateOverlay(projectDir);

  const stages = { total: 0, approved: 0, failed: 0, pending: 0 };
  const byPhase: RuntimeSummary["by_phase"] = {};
  const memory = {
    total: 0,
    interpretations: 0,
    deviations: 0,
    tradeoffs: 0,
    open_questions: 0,
  };
  const sensors = {
    total: 0,
    passed: 0,
    failed: 0,
    budget_override: 0,
    incomplete: 0,
  };
  const learnings = { from_orchestrator: 0, from_user_addition: 0 };

  let latestCompleted: string | null = null;
  const seenStageSlugs = new Set<string>();

  const ensurePhase = (phase: string): void => {
    if (!byPhase[phase]) {
      byPhase[phase] = { total: 0, approved: 0, failed: 0, pending: 0 };
    }
  };

  for (const s of graph.stages) {
    seenStageSlugs.add(s.stage_slug);
    const phase = phaseMap.get(s.stage_slug)?.phase ?? "unknown";
    ensurePhase(phase);
    if (s.learnings_captured) {
      learnings.from_orchestrator += s.learnings_captured.from_orchestrator;
      learnings.from_user_addition += s.learnings_captured.from_user_addition;
    }
    const completedAt = s.completed_at ?? maxInstanceCompletedAt(s);
    if (completedAt && (latestCompleted === null || completedAt > latestCompleted)) {
      latestCompleted = completedAt;
    }
    const overlayOutcome = stateOverlay?.get(s.stage_slug);
    const hasInstances = (s.instances?.length ?? 0) > 0;
    for (const baseUnit of unitsForStage(s)) {
      const u = overlayOutcome && !hasInstances
        ? { ...baseUnit, outcome: overlayOutcome }
        : baseUnit;
      stages.total++;
      byPhase[phase].total++;
      stages[u.outcome]++;
      byPhase[phase][u.outcome]++;
      if (u.memory_breakdown) {
        memory.total += u.memory_entries ?? 0;
        memory.interpretations += u.memory_breakdown.interpretations;
        memory.deviations += u.memory_breakdown.deviations;
        memory.tradeoffs += u.memory_breakdown.tradeoffs;
        memory.open_questions += u.memory_breakdown.open_questions;
      }
      for (const f of u.sensor_firings) {
        sensors.total++;
        if (f.result === "passed") sensors.passed++;
        else if (f.result === "failed") sensors.failed++;
        else if (f.result === "budget-override") sensors.budget_override++;
        else sensors.incomplete++;
      }
    }
  }

  if (stateOverlay) {
    for (const [slug, outcome] of stateOverlay.entries()) {
      if (seenStageSlugs.has(slug)) continue;
      const phase = phaseMap.get(slug)?.phase ?? "unknown";
      ensurePhase(phase);
      stages.total++;
      byPhase[phase].total++;
      stages[outcome]++;
      byPhase[phase][outcome]++;
    }
  }

  return {
    workflow_id: graph.workflow_id,
    scope: graph.scope,
    started_at: graph.started_at,
    duration_minutes: durationMinutes(graph.started_at, latestCompleted),
    stages,
    by_phase: byPhase,
    memory,
    sensors,
    learnings,
  };
}

function maxInstanceCompletedAt(s: RuntimeStage): string | null {
  if (!s.instances || s.instances.length === 0) return null;
  let max: string | null = null;
  for (const i of s.instances) {
    if (i.completed_at && (max === null || i.completed_at > max)) {
      max = i.completed_at;
    }
  }
  return max;
}

function durationMinutes(start: string, end: string | null): number | null {
  if (!end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  if (Number.isNaN(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}

function renderSummary(s: RuntimeSummary): string {
  const dur = s.duration_minutes === null ? "in progress" : `${s.duration_minutes} min`;
  const phaseLines = Object.entries(s.by_phase)
    .map(
      ([phase, c]) =>
        `  ${phase.padEnd(14)} ${c.approved}/${c.total} approved` +
        (c.failed ? `, ${c.failed} failed` : "") +
        (c.pending ? `, ${c.pending} pending` : "")
    )
    .join("\n");
  return `Session Summary
===============

Workflow:   ${s.workflow_id}
Scope:      ${s.scope}
Duration:   ${dur}

Stages
  Total:      ${s.stages.total}
  Approved:   ${s.stages.approved}
  Failed:     ${s.stages.failed}
  Pending:    ${s.stages.pending}

By phase
${phaseLines || "  (none)"}

Memory entries
  Total:            ${s.memory.total}
  Interpretations:  ${s.memory.interpretations}
  Deviations:       ${s.memory.deviations}
  Trade-offs:       ${s.memory.tradeoffs}
  Open questions:   ${s.memory.open_questions}

Sensors
  Fired:            ${s.sensors.total}
  Passed:           ${s.sensors.passed}
  Failed:           ${s.sensors.failed}
  Budget-override:  ${s.sensors.budget_override}
  Incomplete:       ${s.sensors.incomplete}

Learnings captured
  From orchestrator:    ${s.learnings.from_orchestrator}
  From user additions:  ${s.learnings.from_user_addition}`;
}

// --- Fragment fork/merge primitives ---
//
// The runtime-graph fragment lifecycle mirrors the audit-fork +
// state-fork pattern. fragment-fork byte-copies main's runtime-graph.json
// into a Bolt's worktree at <wt>/aidlc-docs/runtime-graph.json on Bolt
// start; fragment-merge removes the worktree fragment on Bolt complete.
//
// No new audit events: the fork boundary is already triple-attested by
// BOLT_STARTED + STATE_FORKED + AUDIT_FORKED, the merge boundary by
// BOLT_COMPLETED + STATE_MERGED + AUDIT_MERGED. Fragment lifecycle rides
// on the existing boundaries.
//
// No content-merge in fragment-merge: main's runtime-graph.json is rebuilt
// event-source from main audit by the post-Bash hook (AUDIT_MERGED is in
// the transition regex per aidlc-runtime-compile.ts:87). Content-merge
// would compete with compile.

// fragment-fork --slug <slug> [--project-dir <path>]
//
// Pre-emit guards:
//   - worktree directory exists (mirrors audit-fork:354-358)
//   - fragment does not already exist (mirrors audit-fork:359-363; one-shot)
//
// Single-read protocol (G5): readFileSync once, writeFileSync from buffer,
// hash same buffer. Closes the byte-copy / hash race against a concurrent
// compile rewriting main runtime-graph.json mid-fork.
//
// Source-absent fallback: when main has no runtime-graph.json yet (pre-milestone-8
// state, or fresh init), write an empty graph to the worktree fragment
// path via the refactored writeEmptyGraph(wtPath, { acquireLock: false }).
// fragment-fork takes no audit lock anywhere (L9 — no audit emit).
function handleFragmentFork(rest: string[], projectDir: string): void {
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--slug" && i + 1 < rest.length) {
      flags.slug = rest[i + 1];
      i++;
    } else if (a === "--intent" && i + 1 < rest.length) {
      flags.intent = rest[i + 1];
      i++;
    } else if (a === "--space" && i + 1 < rest.length) {
      flags.space = rest[i + 1];
      i++;
    }
  }
  if (!flags.slug) {
    process.stderr.write(
      "aidlc-runtime fragment-fork: --slug <slug> required\n"
    );
    process.exit(1);
  }
  const slugErr = validateBoltSlug(flags.slug);
  if (slugErr !== null) {
    process.stderr.write(`aidlc-runtime fragment-fork: ${slugErr}\n`);
    process.exit(1);
  }

  // Pin the worktree runtime-graph mirror AND the main read to ONE intent
  // (vision §5). recordPrefix -> the worktree mirror's relative record dir
  // (null -> flat); wtRecord -> the record-dir NAME the worktree fragment lives
  // under (null -> flat). Resolved on the MAIN side so fork and merge agree.
  const intent = flags.intent;
  // Resolve the SPACE segment ONCE against the MAIN cursor and pass it
  // EXPLICITLY everywhere below. Without this, the source-absent write path
  // (writeEmptyGraph -> runtimeGraphPath -> recordDir) would fall through to
  // activeSpace(wtPath) — the WORKTREE's own cursor — while recordPrefix /
  // wtFragmentPath interpolate activeSpace(projectDir) (the MAIN cursor). If the
  // two cursors differ, the empty graph is written under the worktree-space path
  // but re-read under the main-space path → ENOENT, fragment-fork exits 1 despite
  // a successful write. One resolved space keeps both sides on the same segment.
  const space = flags.space ?? activeSpace(projectDir);
  const recordPrefix = relativeRecordDir(projectDir, intent, space);
  const wtRecord = activeIntent(projectDir, space, intent) ?? undefined;

  const wtPath = worktreePath(projectDir, flags.slug);
  const wtFragmentPath = worktreeRuntimeGraphPath(wtPath, recordPrefix);
  const mainPath = runtimeGraphPath(projectDir, intent, space);

  if (!existsSync(wtPath)) {
    process.stderr.write(
      `aidlc-runtime fragment-fork: worktree directory not found at ${wtPath}; run aidlc-worktree create first\n`
    );
    process.exit(1);
  }
  if (existsSync(wtFragmentPath)) {
    process.stderr.write(
      `aidlc-runtime fragment-fork: fragment already exists at ${wtFragmentPath}; refusing to overwrite (fragment-fork is one-shot)\n`
    );
    process.exit(1);
  }

  let sourceHash: string;
  let sourcePresent: boolean;

  if (existsSync(mainPath)) {
    // Single-read protocol (G5): one read, two consumers (write + hash).
    const buf = readFileSync(mainPath);
    writeFileSync(wtFragmentPath, buf);
    sourceHash = createHash("sha256").update(buf).digest("hex");
    sourcePresent = true;
  } else {
    // Source-absent: write empty graph to the worktree path. Pass
    // acquireLock: false because fragment-fork takes no audit lock
    // (decision L9), and the worktree-local path has no concurrent writer.
    writeEmptyGraph(wtPath, { acquireLock: false }, wtRecord, space);
    // Re-read the just-written bytes so the source-hash reflects the
    // empty-graph fragment exactly.
    const buf = readFileSync(wtFragmentPath);
    sourceHash = createHash("sha256").update(buf).digest("hex");
    sourcePresent = false;
  }

  console.log(
    JSON.stringify({
      status: "fragment-forked",
      slug: flags.slug,
      source_runtime_graph_hash: sourceHash,
      fragment_path: wtFragmentPath,
      source_present: sourcePresent,
    })
  );
}

// fragment-merge --slug <slug> [--project-dir <path>]
//
// Idempotent: if the worktree fragment is absent (re-run after merge, or
// against a Bolt whose fragment-fork step failed), exit 0 with
// status: "fragment-absent". Mirrors state-merge's "already merged"
// precedent in spirit (state-merge errors because it has Bolt Refs to
// protect; fragment-merge no-ops because it's unbacked by any registry).
//
// No content-merge: main's runtime-graph.json is rebuilt by compile via
// the post-Bash hook on AUDIT_MERGED, which fires AFTER this subcommand
// returns (the hook is on the parent Bash invocation that called
// aidlc-bolt complete --merge).
function handleFragmentMerge(rest: string[], projectDir: string): void {
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--slug" && i + 1 < rest.length) {
      flags.slug = rest[i + 1];
      i++;
    } else if (a === "--intent" && i + 1 < rest.length) {
      flags.intent = rest[i + 1];
      i++;
    } else if (a === "--space" && i + 1 < rest.length) {
      flags.space = rest[i + 1];
      i++;
    }
  }
  if (!flags.slug) {
    process.stderr.write(
      "aidlc-runtime fragment-merge: --slug <slug> required\n"
    );
    process.exit(1);
  }
  const slugErr = validateBoltSlug(flags.slug);
  if (slugErr !== null) {
    process.stderr.write(`aidlc-runtime fragment-merge: ${slugErr}\n`);
    process.exit(1);
  }

  // Same selector the fork used -> the SAME intent record (vision §5).
  const recordPrefix = relativeRecordDir(projectDir, flags.intent, flags.space);

  const wtPath = worktreePath(projectDir, flags.slug);
  const wtFragmentPath = worktreeRuntimeGraphPath(wtPath, recordPrefix);

  if (!existsSync(wtFragmentPath)) {
    // Fragment-absent: clean no-op. Covers (a) re-run after a successful
    // prior merge, (b) Bolt whose fragment-fork step failed (state-fork +
    // audit-fork were emitted but fragment-fork crashed), (c) worktree dir
    // already removed by aidlc-worktree merge / discard.
    console.log(
      JSON.stringify({
        status: "fragment-absent",
        slug: flags.slug,
      })
    );
    return;
  }

  // Hash before unlink for stdout observability.
  const buf = readFileSync(wtFragmentPath);
  const fragmentHash = createHash("sha256").update(buf).digest("hex");
  unlinkSync(wtFragmentPath);

  console.log(
    JSON.stringify({
      status: "fragment-merged",
      slug: flags.slug,
      fragment_runtime_graph_hash: fragmentHash,
    })
  );
}

// --- CLI ---

function printHelp(): void {
  console.log(`Usage: aidlc-runtime <subcommand>

Subcommands:
  compile                           Walk audit + memory, write runtime-graph.json
  read <stage-slug>                 Print one stage row from runtime-graph.json
  summary [--json]                  Print deterministic aggregates over runtime-graph.json
                                    (stage/phase outcomes, memory, sensors, learnings,
                                    duration). Read-only; consumed by session skills.
  fragment-fork --slug <slug>       Byte-copy main runtime-graph.json into a Bolt's
                                    worktree at <worktree>/aidlc-docs/runtime-graph.json.
                                    One-shot. Called by aidlc-bolt start --worktree.
  fragment-merge --slug <slug>      Remove the worktree fragment file. Idempotent.
                                    Called by aidlc-bolt complete --merge.
  --help, -h                        Show this message

The compile subcommand is invoked automatically by the PostToolUse Bash
hook (aidlc-runtime-compile.ts) on every transition-class audit emit.
Manual invocation is a debug surface.

fragment-fork / fragment-merge are invoked by aidlc-bolt.ts during the
per-Bolt worktree fork/merge dance and emit no audit events of their own
(the BOLT_STARTED + STATE_FORKED + AUDIT_FORKED triad already attests the
fork boundary; BOLT_COMPLETED + STATE_MERGED + AUDIT_MERGED attests merge).

All subcommands accept --project-dir <path> to override project-dir
resolution; otherwise CWD-based resolution applies.`);
}

// Per-subcommand handler signature: receives the post-strip rest-args
// (already without `--project-dir <path>`) and the resolved projectDir.
// Each handler is responsible for its own usage validation, success
// stdout, and process.exit.
type SubcommandHandler = (rest: string[], projectDir: string) => void;

// Wrap a handler with uniform stderr + exit-1 on thrown errors. Keeps
// the per-subcommand bodies focused on success-path logic.
function tryRun(label: string, handler: SubcommandHandler): SubcommandHandler {
  return (rest, projectDir) => {
    try {
      handler(rest, projectDir);
    } catch (err) {
      process.stderr.write(`aidlc-runtime ${label}: ${errorMessage(err)}\n`);
      process.exit(1);
    }
  };
}

const handleCompile: SubcommandHandler = (_rest, projectDir) => {
  const result = compile({ projectDir });
  if (result.skipped) {
    process.exit(0);
  }
  console.log(JSON.stringify(result));
};

const handleRead: SubcommandHandler = (rest, projectDir) => {
  const stageSlug = rest[0];
  if (!stageSlug) {
    process.stderr.write("aidlc-runtime read: stage slug required\n");
    process.exit(1);
  }
  const row = readStage(stageSlug, projectDir);
  if (!row) {
    process.stderr.write(`aidlc-runtime read: no row for slug "${stageSlug}"\n`);
    process.exit(1);
  }
  console.log(JSON.stringify(row, null, 2));
};

const handleSummary: SubcommandHandler = (rest, projectDir) => {
  const summary = summarize(projectDir);
  if (!summary) {
    process.stderr.write(
      "aidlc-runtime summary: no runtime-graph.json found — run a workflow first\n"
    );
    process.exit(1);
  }
  if (rest.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(renderSummary(summary));
  }
};

// Subcommand dispatch table. New subcommands attach here without
// touching main()'s control flow — keeps the entry-point's cyclomatic
// complexity flat as the surface grows.
const SUBCOMMANDS: Record<string, SubcommandHandler> = {
  compile: tryRun("compile", handleCompile),
  read: tryRun("read", handleRead),
  summary: tryRun("summary", handleSummary),
  "fragment-fork": tryRun("fragment-fork", handleFragmentFork),
  "fragment-merge": tryRun("fragment-merge", handleFragmentMerge),
};

// Pre-strip --project-dir <path> from argv. Mirrors
// aidlc-state.ts:101-106 / aidlc-audit.ts:616-624. Required because
// aidlc-bolt.ts's spawnSibling invokes us as
//   bun run <tool> --project-dir <pd> <subcommand> ...
// — without this pre-strip, `cmd === "--project-dir"` and dispatch fails.
// Existing flag-less callers (the post-Bash compile hook, direct user
// invocations) still work via resolveProjectDir's cwd-based fallback.
function stripProjectDir(args: string[]): { projectDirArg: string | undefined; rest: string[] } {
  const out = [...args];
  const pdIdx = out.indexOf("--project-dir");
  if (pdIdx !== -1 && pdIdx + 1 < out.length) {
    const projectDirArg = out[pdIdx + 1];
    out.splice(pdIdx, 2);
    return { projectDirArg, rest: out };
  }
  return { projectDirArg: undefined, rest: out };
}

export function main(argv: string[]): void {
  const { projectDirArg, rest: argsAfterStrip } = stripProjectDir(argv);

  const [cmd, ...subargs] = argsAfterStrip;
  if (cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === undefined) {
    process.stderr.write(
      "Usage: aidlc-runtime <subcommand>. Valid: compile, read, summary, fragment-fork, fragment-merge. Run with --help for detail.\n"
    );
    process.exit(1);
  }

  const handler = SUBCOMMANDS[cmd];
  if (!handler) {
    process.stderr.write(`Unknown subcommand: ${cmd}. Run aidlc-runtime --help for usage.\n`);
    process.exit(1);
  }

  handler(subargs, resolveProjectDir(projectDirArg));
}

if (import.meta.main) main(process.argv.slice(2));
