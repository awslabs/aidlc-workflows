// aidlc-doctor-bundle.ts — the `/aidlc --doctor --export` diagnostic exporter.
//
// When a workflow misbehaves (a gate that will not open, a stage that will not
// advance, an approved report repeatedly refused) debugging today means asking
// the user for their whole project directory: huge, leaky (the record dir holds
// requirements/designs/decisions), and unmastigated (the maintainer hand-
// reconstructs the run from state + audit + markers + graph).
//
// This module produces the OPPOSITE: a small, redacted, self-diagnosing bundle.
// The value is the diagnosis, not raw file collection. It draws every finding
// from the SAME shared DoctorFinding model the live `--doctor` uses (the caller
// passes them in), so the command and the bundle can never develop separate
// diagnostic rules or remediation text.
//
// What it writes into a canonical bundle directory:
//   - report.md      — human-readable timeline + findings
//   - report.json    — machine-readable timeline + findings + summary
//   - manifest.json  — schema/versions, hashed intent id, included files,
//                      applied redactions, per-file checksums, truncations
//   - evidence/…     — NORMALIZED, allowlisted fields only (never raw files,
//                      never artifact/contribution/question/memory bodies)
//
// Packaging is best-effort and dependency-free: the canonical directory is the
// contract; a `.tar.gz` is produced when a system `tar` is available, else the
// directory is retained with manual-share instructions. No bespoke tar writer,
// no archive parser, no new package dependency.
//
// SAFETY: redaction runs before any file is written. Home → ~, project root →
// <project>, intent/unit ids → stable short hashes, and every emitted string is
// scanned for absolute paths and secret-like values. Symlinked inputs are
// refused — at the leaf AND via a realpath check that rejects any input whose
// real location escapes the project root through a symlinked parent dir;
// per-file and total size are capped; files are created owner-only where the
// platform supports it.

import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import {
  auditBlockField,
  auditShardDir,
  docsRoot,
  harnessDir,
  hooksHealthDir,
  isoTimestamp,
  listIntentDirs,
  listSpaces,
  parseCheckboxes,
  planFilePath,
  readAllAuditShards,
  recordDir,
  recoveryFilePath,
  relativeRecordDir,
  runtimeGraphPath,
  stateFilePath,
  stopHookDir,
} from "./aidlc-lib.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";

// The bundle format version — bumped when the report/manifest/evidence SHAPE
// changes so a maintainer reading an old bundle knows what to expect.
export const BUNDLE_SCHEMA_VERSION = "1";

// Caps. A diagnostic bundle should never approach the size of the thing it is
// meant to replace; a runaway audit or a pathological graph is truncated with a
// recorded notice rather than copied whole.
export const MAX_EVIDENCE_FILE_BYTES = 512 * 1024; // 512 KiB per emitted file
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024; // 8 MiB total

// A stage whose observed duration exceeds this is flagged "abnormally long" in
// the timeline. Advisory only — it never changes a finding severity.
export const LONG_STAGE_MS = 6 * 60 * 60 * 1000; // 6h

// ===========================================================================
// Shared diagnostic model
// ===========================================================================

export type Severity = "info" | "warning" | "error";

// The single structured finding shape shared by the live doctor report and the
// exported bundle (issue #575 "Shared Diagnostic Model"). `evidence` carries
// only structural, allowlisted facts — never file bodies or secret-bearing
// text. `safeToAutomate` is false for every recovery-bypass remedy.
export interface DoctorFinding {
  id: string;
  severity: Severity;
  summary: string;
  evidence: Record<string, unknown>;
  remedy: string;
  safeToAutomate: boolean;
}

// The legacy pass/label/fix row handleDoctor builds today. Kept as the live
// render's shape; adaptLegacyResult() lifts one into a DoctorFinding so the
// bundle and the live report share findings without rewriting every check.
export interface LegacyDoctorResult {
  pass: boolean;
  label: string;
  fix?: string;
}

// Derive a stable, slug-shaped finding id from a legacy label. The label's
// leading phrase (up to the first ":" / "(" / "—") names the check; we
// kebab-case it so ids are stable across runs and readable in the manifest.
export function findingIdFromLabel(label: string): string {
  const head = label.split(/[:(—]/)[0].trim().toLowerCase();
  const slug = head
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "check";
}

// Lift a legacy {pass,label,fix} row into the shared model. A failed row is an
// error; a passing row with an advisory "(advisory)" tag is a warning; every
// other passing row is info. A recovery-bypass remedy (names an
// AIDLC_DISABLE_* env or "archive your workspace") is never safe to automate.
export function adaptLegacyResult(r: LegacyDoctorResult): DoctorFinding {
  const advisory = /\(advisory\)/i.test(r.label);
  const severity: Severity = !r.pass ? "error" : advisory ? "warning" : "info";
  const remedy = r.fix ?? "";
  return {
    id: findingIdFromLabel(r.label),
    severity,
    summary: r.label,
    evidence: {},
    remedy,
    safeToAutomate: severity === "info" ? true : !isRecoveryBypass(remedy),
  };
}

// A remedy is a recovery bypass when it instructs the operator to skip a guard
// or discard state — it must always carry a warning and never be automated.
export function isRecoveryBypass(remedy: string): boolean {
  return (
    /AIDLC_DISABLE_[A-Z_]+/.test(remedy) ||
    /\barchive your workspace\b/i.test(remedy) ||
    /\bstart a fresh workflow\b/i.test(remedy)
  );
}

// ===========================================================================
// Redaction
// ===========================================================================

// A short, stable hash used to replace an identifying token (intent slug, unit
// id) so two occurrences of the same id stay correlatable in the bundle while
// the original value never appears.
export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export interface RedactionContext {
  projectDir: string;
  home: string;
  // Literal id → its stable short hash. Intent slugs and unit ids are seeded
  // here so filenames and inline references redact consistently.
  idHashes: Map<string, string>;
  // Names of the redaction rules actually applied (for the manifest).
  rulesApplied: Set<string>;
}

export function newRedactionContext(projectDir: string): RedactionContext {
  return {
    projectDir,
    home: homedir(),
    idHashes: new Map(),
    rulesApplied: new Set(),
  };
}

// Secret-like token shapes. Deliberately broad: AWS keys, bearer/JWT-ish
// blobs, generic `key=`/`token=`/`secret=`/`password=` assignments, and long
// hex/base64 runs. A false positive redacts a harmless string (acceptable); a
// miss leaks a secret (not). Applied to every emitted string.
const SECRET_PATTERNS: Array<{ rule: string; re: RegExp; replace: string }> = [
  { rule: "aws-access-key", re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: "<redacted-aws-key>" },
  { rule: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g, replace: "Bearer <redacted-token>" },
  { rule: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: "<redacted-jwt>" },
  {
    // Matches `password=hunter2`, JSON-shaped `"password": "hunter2"`, AND the
    // JSON-ESCAPED form `{\"password\":\"hunter2\"}` that arises when a secret
    // sits one nesting level down and buildBundle JSON.stringify-serializes it
    // BEFORE redaction — the escaping backslash then sits between the key and
    // the quote (Arden round-3 #4). The optional `\\?` before each optional
    // quote absorbs that backslash. The value class also includes common secret
    // punctuation (@#$%^&*!) so `password=p@ssw0rd!` is caught. Over-redaction
    // of a benign value is acceptable per this module's stated bias; a miss is
    // not. Whole JSON documents are redacted post-serialization.
    rule: "assignment-secret",
    // No trailing quote match: consuming a closing quote corrupted JSON when a
    // secret ended a string value (Arden r4 #2). JSON files now redact before
    // serialization (stageJson) so quotes never reach here for them; dropping
    // the trailing quote also keeps report.md prose intact. Leading `\\?['"]?`
    // still absorbs an opening/escaped quote so the JSON-quoted key form matches.
    re: /\b(api[_-]?key|secret|token|password|passwd|pwd)\b\\?['"]?\s*[:=]\s*\\?['"]?[A-Za-z0-9!@#$%^&*._~+/=-]{6,}/gi,
    replace: "$1=<redacted>",
  },
  { rule: "long-hex-or-b64", re: /\b[A-Fa-f0-9]{40,}\b/g, replace: "<redacted-hex>" },
];

// Redact one string: home dir → ~, project root → <project>, seeded ids → their
// hashes, then the secret scan. Order matters — path normalization first so a
// home-prefixed secret path is caught by both rules. Records which rules fired.
export function redactString(value: string, ctx: RedactionContext): string {
  let out = value;
  // Project root before home: the project dir is usually deeper than home, so
  // replacing it first avoids a half-replaced "~/.../project" fragment.
  if (ctx.projectDir && out.includes(ctx.projectDir)) {
    out = out.split(ctx.projectDir).join("<project>");
    ctx.rulesApplied.add("project-root");
  }
  if (ctx.home && out.includes(ctx.home)) {
    out = out.split(ctx.home).join("~");
    ctx.rulesApplied.add("home-dir");
  }
  // Seeded-id redaction by a SINGLE token scan. Seeded ids are all slug-shaped
  // (intent/stage/agent slugs: [A-Za-z0-9_-]), so we scan the content once for
  // slug tokens and look each up in idHashes — O(content), independent of the
  // number of seeded ids. An earlier per-id split/join loop was O(ids × bytes)
  // and a big alternation regex was O(branches × positions); both blew the
  // export budget on a project with thousands of custom ids (t242 test 17).
  // Matching whole tokens also preserves the longest-match property for free —
  // `build-auth-extra` is scanned as one token and looked up whole, never
  // half-replaced into `<id:hash>-extra`.
  if (ctx.idHashes.size > 0) {
    out = out.replace(/[A-Za-z0-9_-]{4,}/g, (tok) => {
      const hash = ctx.idHashes.get(tok);
      if (hash === undefined) return tok;
      ctx.rulesApplied.add("intent-id");
      return `<id:${hash}>`;
    });
  }
  for (const { rule, re, replace } of SECRET_PATTERNS) {
    if (re.test(out)) {
      ctx.rulesApplied.add(`secret:${rule}`);
      out = out.replace(re, replace);
    }
    re.lastIndex = 0;
  }
  return out;
}


// Deep-redact a JSON-able value: strings pass through redactString, arrays and
// plain objects recurse. Object KEYS are left intact (they are allowlisted
// field names, not user data); only values are scrubbed.
export function redactValue(value: unknown, ctx: RedactionContext): unknown {
  if (typeof value === "string") return redactString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, ctx);
    return out;
  }
  return value;
}

// ===========================================================================
// Timeline reconstruction (from audit shards)
// ===========================================================================

// One parsed audit event: the event name plus its whole block (for field
// lookups) and the parsed timestamp in epoch ms (NaN when unparseable).
interface AuditEvent {
  event: string;
  timestampMs: number;
  timestampRaw: string;
  block: string;
}

// Split the merged audit buffer into events, sorted CHRONOLOGICALLY by
// **Timestamp** with the buffer (ledger) position as the tie-breaker. The
// merged buffer concatenates per-shard files (readAllAuditShards sorts shard
// FILENAMES, not events), and multi-host/worktree shards interleave in real
// time, so a timestamp sort is required for durations and gate outcomes to be
// correct. Events with an unparseable timestamp are sorted to the END (treated
// as +Infinity), preserving their relative ledger order among themselves, rather
// than being dropped.
export function parseAuditEvents(audit: string): AuditEvent[] {
  const events: Array<AuditEvent & { pos: number }> = [];
  if (!audit.trim()) return events;
  let pos = 0;
  for (const block of audit.split(/\n\s*\n/)) {
    const event = auditBlockField(block, "Event");
    if (!event) continue;
    const tsRaw = auditBlockField(block, "Timestamp") ?? "";
    const ms = tsRaw ? Date.parse(tsRaw) : NaN;
    events.push({ event, timestampMs: ms, timestampRaw: tsRaw, block, pos: pos++ });
  }
  events.sort((a, b) => {
    const am = Number.isFinite(a.timestampMs) ? a.timestampMs : Number.POSITIVE_INFINITY;
    const bm = Number.isFinite(b.timestampMs) ? b.timestampMs : Number.POSITIVE_INFINITY;
    if (am !== bm) return am - bm;
    return a.pos - b.pos; // ledger-position tie-break (stable within a timestamp)
  });
  return events.map(({ pos: _pos, ...e }) => e);
}

// A "?" literal is the report's honest representation of missing evidence —
// the timeline never infers an event that was not recorded.
export const UNKNOWN = "unknown";

export interface StageTimelineEntry {
  slug: string;
  startedRaw: string | typeof UNKNOWN;
  completedRaw: string | typeof UNKNOWN;
  durationMs: number | null; // null when either endpoint is unknown
  gate: "approved" | "rejected" | "unresolved" | "none";
  revisionCount: number | null;
  gapFromPrevMs: number | null; // time between previous stage's end and this start
  abnormal: string[]; // e.g. ["long-duration"], ["incomplete"]
}

export interface Timeline {
  stages: StageTimelineEntry[];
  workflowStartedRaw: string | typeof UNKNOWN;
  workflowStatus: string; // from state file, or "unknown"
  // True when the LATEST run (the scoped slice, not the whole buffer) recorded a
  // WORKFLOW_COMPLETED. Rule 3 (state/audit drift) reads this so it never fires
  // on an old completion left in the buffer by a completed-then-restarted run.
  workflowCompleted: boolean;
  notes: string[];
}

// Reconstruct the stage timeline from the audit events + the state checkboxes.
// Every field that was not recorded is `unknown`/null — the report must not
// invent transitions. `stateContent` supplies the current status and the
// checkbox for a stage whose STAGE_COMPLETED never landed (incomplete).
export function reconstructTimeline(audit: string, stateContent: string): Timeline {
  const allEvents = parseAuditEvents(audit);
  const notes: string[] = [];

  // Scope to the LATEST workflow run: a restarted/replayed workflow records a
  // fresh WORKFLOW_STARTED, and grouping across runs would let an old stage's
  // start or an old gate resolution corrupt the current picture. Slice from the
  // last WORKFLOW_STARTED onward (timestamp-sorted above). No WORKFLOW_STARTED
  // → keep all events (a partial/legacy trail is better than an empty report).
  let startIdx = -1;
  for (let i = allEvents.length - 1; i >= 0; i--) {
    if (allEvents[i].event === "WORKFLOW_STARTED") {
      startIdx = i;
      break;
    }
  }
  const priorRuns = allEvents.slice(0, Math.max(0, startIdx)).filter((e) => e.event === "WORKFLOW_STARTED").length;
  const events = startIdx >= 0 ? allEvents.slice(startIdx) : allEvents;
  if (priorRuns > 0) {
    notes.push(`Scoped to the latest of ${priorRuns + 1} recorded workflow runs; earlier runs are omitted.`);
  }

  const workflowStarted = events.find((e) => e.event === "WORKFLOW_STARTED");
  const status = stateContent ? extractStatus(stateContent) : UNKNOWN;

  // Group events by stage slug (the **Stage** field, or **Slug** on some
  // events). Order-preserving so first-STARTED / last-COMPLETED are stable.
  const byStage = new Map<string, AuditEvent[]>();
  const stageOrder: string[] = [];
  for (const e of events) {
    const slug = auditBlockField(e.block, "Stage") ?? auditBlockField(e.block, "Slug");
    if (!slug) continue;
    if (!byStage.has(slug)) {
      byStage.set(slug, []);
      stageOrder.push(slug);
    }
    byStage.get(slug)!.push(e);
  }

  const checkboxes = stateContent ? parseCheckboxes(stateContent) : [];
  const checkboxBySlug = new Map(checkboxes.map((c) => [c.slug, c]));

  // Render in CURRENT-ATTEMPT chronological order, not first-seen order. A stage
  // jumped back to (alpha → beta → alpha) has its latest attempt start LATER
  // than beta's; first-seen order would list that alpha attempt before beta and
  // compute beta's gapFromPrevMs against alpha's later completion → a negative
  // gap (Arden round-3 #8). Sorting by the current attempt's start keeps the
  // rendered order and the gap arithmetic consistent. Ties (equal/absent starts)
  // fall back to first-seen order via the stableOrder index.
  const attemptStartMs = (slug: string): number => {
    const i = lastEventIndex(byStage.get(slug)!, "STAGE_STARTED");
    const ms = i >= 0 ? byStage.get(slug)![i].timestampMs : NaN;
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  };
  const orderIndex = new Map(stageOrder.map((s, i) => [s, i]));
  const renderOrder = [...stageOrder].sort((a, b) => {
    const d = attemptStartMs(a) - attemptStartMs(b);
    return d !== 0 ? d : orderIndex.get(a)! - orderIndex.get(b)!;
  });

  const stages: StageTimelineEntry[] = [];
  let prevEndMs: number | null = null;
  for (const slug of renderOrder) {
    const evs = byStage.get(slug)!;
    // Pair CHRONOLOGICALLY, scoped to the CURRENT attempt: a stage jumped back
    // to (aidlc-jump re-emits STAGE_STARTED after a completion) must not read as
    // completed with a stale duration. The current attempt begins at the LAST
    // STAGE_STARTED; it is complete only if a STAGE_COMPLETED follows that start
    // (events are timestamp-sorted with ledger tie-break above). A completion
    // that predates the latest start belongs to an earlier attempt and is
    // ignored, so a re-worked stage correctly reads incomplete/in-progress.
    const startIdx = lastEventIndex(evs, "STAGE_STARTED");
    const started = startIdx >= 0 ? evs[startIdx] : undefined;
    const completed =
      startIdx >= 0
        ? evs.slice(startIdx).find((e) => e.event === "STAGE_COMPLETED")
        : lastEvent(evs, "STAGE_COMPLETED");
    const startedMs = started?.timestampMs ?? NaN;
    const completedMs = completed?.timestampMs ?? NaN;

    const durationMs =
      Number.isFinite(startedMs) && Number.isFinite(completedMs)
        ? completedMs - startedMs
        : null;

    // Gate: the last gate-resolution event for this stage, else "unresolved"
    // when the stage started but never completed and its checkbox is awaiting
    // approval, else "none".
    const gate = gateOutcome(evs, checkboxBySlug.get(slug)?.state);

    // Revision count: STAGE_REVISING occurrences, or the state field when the
    // stage is the current one. Null when neither is available.
    const revisions = evs.filter((e) => e.event === "STAGE_REVISING").length;
    const revisionCount = revisions > 0 ? revisions : completed || started ? 0 : null;

    const gapFromPrevMs =
      prevEndMs !== null && Number.isFinite(startedMs) ? startedMs - prevEndMs : null;

    const abnormal: string[] = [];
    if (durationMs !== null && durationMs > LONG_STAGE_MS) abnormal.push("long-duration");
    if (started && !completed) abnormal.push("incomplete");

    stages.push({
      slug,
      startedRaw: started?.timestampRaw ?? UNKNOWN,
      completedRaw: completed?.timestampRaw ?? UNKNOWN,
      durationMs,
      gate,
      revisionCount,
      gapFromPrevMs,
      abnormal,
    });

    if (Number.isFinite(completedMs)) prevEndMs = completedMs;
  }

  if (events.length === 0) notes.push("No audit events found — timeline is empty.");
  if (stateContent === "") notes.push("No state file — status and checkbox cross-checks skipped.");

  return {
    stages,
    workflowStartedRaw: workflowStarted?.timestampRaw ?? UNKNOWN,
    workflowStatus: status,
    workflowCompleted: events.some((e) => e.event === "WORKFLOW_COMPLETED"),
    notes,
  };
}

function lastEvent(evs: AuditEvent[], name: string): AuditEvent | undefined {
  for (let i = evs.length - 1; i >= 0; i--) if (evs[i].event === name) return evs[i];
  return undefined;
}
function lastEventIndex(evs: AuditEvent[], name: string): number {
  for (let i = evs.length - 1; i >= 0; i--) if (evs[i].event === name) return i;
  return -1;
}

function extractStatus(stateContent: string): string {
  const m = stateContent.match(/^- \*\*Status\*\*:\s*(\S+)/m);
  return m ? m[1] : UNKNOWN;
}

// Gate outcome for a stage: the LATEST gate event wins, honouring order. `evs`
// is timestamp-sorted (parseAuditEvents) and scoped to one run, so a re-opened
// gate — an STAGE_AWAITING_APPROVAL recorded AFTER an earlier GATE_APPROVED —
// correctly reads "unresolved", and an older approval can never resolve a newer
// open gate. When no gate event fired but the checkbox is awaiting approval,
// the gate is unresolved; otherwise "none".
function gateOutcome(
  evs: AuditEvent[],
  checkboxState: string | undefined,
): StageTimelineEntry["gate"] {
  let latest: "approved" | "rejected" | "awaiting" | null = null;
  for (const e of evs) {
    if (e.event === "GATE_APPROVED") latest = "approved";
    else if (e.event === "GATE_REJECTED") latest = "rejected";
    else if (e.event === "STAGE_AWAITING_APPROVAL") latest = "awaiting";
  }
  if (latest === "approved") return "approved";
  if (latest === "rejected") return "rejected";
  if (latest === "awaiting" || checkboxState === "awaiting-approval") return "unresolved";
  return "none";
}

// ===========================================================================
// Deterministic diagnosis (fixed condition → remedy rules; NO LLM)
// ===========================================================================
//
// Each rule inspects the reconstructed timeline + on-disk evidence and, when
// its condition holds, emits a DoctorFinding with a FIXED remedy string. The
// rules are versioned by BUNDLE_SCHEMA_VERSION; adding/changing one is a
// deliberate, reviewed edit — never model-generated text at runtime.

// Inputs a diagnosis rule may read. Everything here is already redaction-safe
// to summarize structurally (ids are hashed before display; no bodies).
export interface DiagnosisInput {
  projectDir: string;
  timeline: Timeline;
  stateContent: string;
  audit: string;
  graphStages: GraphStageLite[]; // from runtime-graph.json (or [] when absent)
  recordAbsDir: string | null; // for structural contribution-file checks
  hooksHealth: HookHealthSnapshot;
  runtimeGraphExists: boolean;
  runtimeGraphMtimeMs: number | null;
  authoredInputsNewestMtimeMs: number | null; // newest stage-source mtime
  markers: MarkerSnapshot;
}

export interface GraphStageLite {
  slug: string;
  phase: string;
  mode: string;
  lead_agent: string;
  support_agents: string[];
}

export interface HookHealthSnapshot {
  dirExists: boolean;
  heartbeats: Array<{ hook: string; timestampRaw: string; ageMs: number | null }>;
  degradedDrops: Array<{ hook: string; count: number }>;
}

export interface MarkerSnapshot {
  planExists: boolean;
  planParseable: boolean | null; // null when absent
  recoveryExists: boolean;
  stopHookDirExists: boolean;
}

// Freshness window past which a heartbeat is "frozen" relative to the newest
// recorded audit activity. A hook that has not fired since well before the last
// stage transition is the cold-hook signal (#571's runtime-compile case).
export const FROZEN_HEARTBEAT_MS = 24 * 60 * 60 * 1000;

// Run every diagnosis rule. Order is severity-stable (errors first) only after
// sorting in the caller; here rules append in a fixed, readable order.
export function runDiagnosis(input: DiagnosisInput): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const {
    timeline,
    graphStages,
    recordAbsDir,
    hooksHealth,
    runtimeGraphExists,
    runtimeGraphMtimeMs,
    authoredInputsNewestMtimeMs,
    markers,
    stateContent,
  } = input;

  // Rule 1 — open / unresolved gates. A stage whose gate never resolved is the
  // single most common "it will not advance" cause.
  const unresolved = timeline.stages.filter((s) => s.gate === "unresolved");
  for (const s of unresolved) {
    findings.push({
      id: "gate-unresolved",
      severity: "error",
      summary: `Stage "${hashSlugForDisplay(s.slug)}" has an unresolved approval gate.`,
      evidence: {
        stage: hashSlugForDisplay(s.slug),
        gate: s.gate,
        startedAt: s.startedRaw,
        completed: s.completedRaw,
      },
      remedy:
        "The workflow is waiting at an approval gate. Resolve it with `/aidlc` " +
        "(answer the open question / approve or reject the stage), then continue.",
      safeToAutomate: false,
    });
  }

  // Rule 2 — ensemble evidence missing/malformed. STRUCTURAL ONLY: for every
  // graph stage that is a mob (or subagent-with-supports), check each declared
  // collaborator's contribution file for existence + identity-marker match.
  // Never reads or reports the file body or its first line's content.
  //
  // GATED on the contributions/ directory actually existing for the stage. The
  // collaborator-evidence mechanism (contributions/<agent>.md + `**Collaborator:**`
  // marker) ships in PR #568 and is absent on this base — no code writes those
  // files. Firing on their absence would false-error every valid workflow that
  // ran a subagent-with-supports stage (the shipped graph has exactly one:
  // reverse-engineering). Treating "no contributions/ dir at all" as "mechanism
  // not in use" keeps the rule inert here and correct once #568 lands.
  if (recordAbsDir) {
    for (const stage of graphStages) {
      const needs =
        stage.mode === "mob" ||
        (stage.mode === "subagent" && stage.support_agents.length > 0);
      if (!needs) continue;
      // Only diagnose a stage the run actually reached (started in the audit or
      // has a checkbox) — a not-yet-run ensemble stage is not a fault.
      const tl = timeline.stages.find((t) => t.slug === stage.slug);
      if (!tl) continue;
      const contribDir = join(recordAbsDir, stage.phase, stage.slug, "contributions");
      // Mechanism not in use on this project — no contributions/ dir was ever
      // written for this stage, so there is no evidence contract to enforce.
      if (!existsSync(contribDir)) continue;
      const problems: Array<Record<string, unknown>> = [];
      for (const agent of stage.support_agents) {
        const file = join(contribDir, `${agent}.md`);
        const st = safeLstat(file);
        if (!st || !st.isFile()) {
          problems.push({ collaborator: agent, exists: false, markerMatches: false });
          continue;
        }
        const markerMatches = firstLineIsMarker(file, agent);
        if (!markerMatches) {
          problems.push({
            collaborator: agent,
            exists: true,
            markerMatches: false,
            sizeBytes: st.size,
            mtime: new Date(st.mtimeMs).toISOString(),
          });
        }
      }
      if (problems.length > 0) {
        findings.push({
          id: "ensemble-evidence-missing",
          severity: "error",
          summary: `Ensemble stage "${hashSlugForDisplay(stage.slug)}" is missing or has malformed collaborator evidence.`,
          evidence: { stage: hashSlugForDisplay(stage.slug), mode: stage.mode, collaborators: problems },
          remedy:
            "Each declared collaborator must write its contribution file with the " +
            "identity-marker first line before approval. Dispatch the missing " +
            "collaborator(s) to write their contribution, then re-report.",
          safeToAutomate: false,
        });
      }
    }
  }

  // Rule 3 — state / audit disagreement. Audit says the workflow completed but
  // the state file does not (a torn write). Scoped to the LATEST run via
  // timeline.workflowCompleted — a whole-buffer scan would match an old
  // WORKFLOW_COMPLETED left by a completed-then-restarted workflow and
  // false-error a run that is legitimately still in progress (the exact case
  // reconstructTimeline's latest-run scoping guards against).
  if (timeline.workflowCompleted && stateContent) {
    const status = extractStatus(stateContent);
    if (status !== "Completed" && status !== UNKNOWN) {
      findings.push({
        id: "state-audit-drift",
        severity: "error",
        summary: `Audit recorded WORKFLOW_COMPLETED but state Status=${status}.`,
        evidence: { auditEvent: "WORKFLOW_COMPLETED", stateStatus: status },
        remedy:
          "A state write was lost after the audit event landed. Set Status=Completed " +
          "in aidlc-state.md, or restart the workflow if the state is otherwise inconsistent.",
        safeToAutomate: false,
      });
    }
  }

  // Rule 4 — runtime graph older than its authored inputs. A stale graph means
  // a recompile did not run (the #571 cold-hook downstream). Only when both
  // mtimes are known.
  if (
    runtimeGraphExists &&
    runtimeGraphMtimeMs !== null &&
    authoredInputsNewestMtimeMs !== null &&
    authoredInputsNewestMtimeMs > runtimeGraphMtimeMs
  ) {
    findings.push({
      id: "runtime-graph-stale",
      severity: "warning",
      summary: "runtime-graph.json is older than its authored stage inputs.",
      evidence: {
        runtimeGraphMtime: new Date(runtimeGraphMtimeMs).toISOString(),
        authoredInputsNewestMtime: new Date(authoredInputsNewestMtimeMs).toISOString(),
      },
      remedy:
        "The compiled runtime graph is out of date. Re-run `bun " +
        "<harness>/tools/aidlc-graph.ts compile`; if this recurs, the " +
        "runtime-compile hook may not be firing on this harness (check hook heartbeats).",
      safeToAutomate: true,
    });
  } else if (
    !runtimeGraphExists &&
    (stateContent !== "" ||
      timeline.stages.length > 0 ||
      timeline.workflowStartedRaw !== UNKNOWN)
  ) {
    // Only warn about a missing runtime graph when a workflow actually exists.
    // A fresh install (no intent, no state, empty timeline) has no graph to
    // compile yet, so the warning would be a false alarm (Arden round-3 #7).
    findings.push({
      id: "runtime-graph-missing",
      severity: "warning",
      summary: "runtime-graph.json is missing for the active workflow.",
      evidence: { runtimeGraphExists: false },
      remedy:
        "No compiled runtime graph. Re-run `bun <harness>/tools/aidlc-graph.ts compile`. " +
        "If it never appears, the runtime-compile hook is not firing on this harness.",
      safeToAutomate: true,
    });
  }

  // Rule 5 — frozen / missing hook heartbeats. A registered hook that has not
  // fired since well before the latest audit activity is cold.
  if (!hooksHealth.dirExists) {
    findings.push({
      id: "hooks-never-fired",
      severity: "info",
      summary: "No hook heartbeats yet (fresh install or hooks not registered).",
      evidence: { healthDirExists: false },
      remedy: "If a workflow has run, verify hooks are registered in the harness wiring config.",
      safeToAutomate: true,
    });
  } else {
    for (const hb of hooksHealth.heartbeats) {
      if (hb.ageMs !== null && hb.ageMs > FROZEN_HEARTBEAT_MS) {
        findings.push({
          id: "hook-heartbeat-frozen",
          severity: "warning",
          summary: `Hook "${hb.hook}" has not fired in over ${Math.floor(hb.ageMs / (60 * 60 * 1000))}h.`,
          evidence: { hook: hb.hook, lastFired: hb.timestampRaw, ageMs: hb.ageMs },
          remedy:
            "A cold hook silently skips its side effects (audit, sensors, runtime " +
            "compile). Verify the hook is wired and firing on this harness.",
          safeToAutomate: true,
        });
      }
    }
    for (const d of hooksHealth.degradedDrops) {
      findings.push({
        id: "hook-degraded",
        severity: "error",
        summary: `Hook "${d.hook}" recorded ${d.count} degraded drop(s).`,
        evidence: { hook: d.hook, degradedCount: d.count },
        remedy:
          "A hook silently half-applied something (a dropped contribution or a failed " +
          "recompile). Inspect the hook's .drops file, fix the cause, and re-compose.",
        safeToAutomate: false,
      });
    }
  }

  // Rule 6 — missing / malformed runtime markers. A resolve output that cannot
  // be parsed will misroute the next `next`.
  if (markers.planExists && markers.planParseable === false) {
    findings.push({
      id: "plan-marker-malformed",
      severity: "error",
      summary: ".aidlc-plan.json is present but not parseable.",
      evidence: { planExists: true, planParseable: false },
      remedy:
        "The resolve output is corrupt. Re-run the resolve step (`/aidlc` will " +
        "recompute the plan), or remove .aidlc-plan.json to force a fresh resolve.",
      safeToAutomate: false,
    });
  }

  // NOTE: a reviewer-loop-incomplete rule was intentionally dropped here. It
  // depended on **Review** / **Review Iterations** audit fields that no emitter
  // on this base writes (the reviewer verdict lives in a `## Review` section on
  // the primary artifact and the iteration counter lives only in conductor
  // context — see stage-protocol.md), so the rule was unreachable dead code.
  // Reinstate it only alongside a real audit emission for the reviewer verdict.

  return findings;
}

// Stage-slug handling is now UNIFORM: every finding/evidence field carries the
// RAW slug, and the single redaction pass (redactString) hashes it to
// `<id:hash>` iff it was seeded as a custom id in runDoctorAnalysis — core
// slugs are never seeded, so they render readable, and custom slugs are hashed
// in BOTH the Markdown and the JSON (Arden #2: no id escapes structurally).
// setCoreSlugs is retained as a no-op shim so callers/tests need no change; the
// core/custom decision now lives entirely in the seeding step.
export function setCoreSlugs(_slugs: Iterable<string>): void {
  /* no-op: redaction seeding in runDoctorAnalysis owns core-vs-custom now */
}
export function hashSlugForDisplay(slug: string): string {
  return slug; // raw; redactString hashes seeded custom ids uniformly
}

function safeLstat(path: string): Stats | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return null; // never follow symlinks
    return st;
  } catch {
    return null;
  }
}

// Structural check ONLY: does the file's first line equal the collaborator
// identity marker? Returns a boolean — the content itself never leaves this
// function. Refuses a symlinked leaf or a path whose real location escapes the
// project root (same containment guard as safeRead), so this marker-match
// oracle cannot be pointed at a file outside the tree (Arden round-3 #9).
function firstLineIsMarker(file: string, agent: string): boolean {
  try {
    if (lstatSync(file).isSymbolicLink()) return false;
    if (!withinProjectRoot(file)) return false;
    // Read only enough to cover the marker line, not the whole file (a
    // contribution body can be large). A 4 KiB prefix comfortably holds the
    // first line; the fd is closed before we split.
    const fd = openSync(file, "r");
    let firstLine: string;
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, buf.length, 0);
      firstLine = buf.toString("utf-8", 0, n).split("\n", 1)[0].trim();
    } finally {
      closeSync(fd);
    }
    return firstLine === `**Collaborator:** ${agent}`;
  } catch {
    return false;
  }
}

// ===========================================================================
// Normalized evidence extraction (allowlisted fields — never raw files)
// ===========================================================================
//
// The evidence set is a set of small JSON documents built from ALLOWLISTED
// fields, not copies of the source files. Raw aidlc-state.md, audit shards,
// runtime-graph.json, and every artifact/contribution/question/memory body are
// EXPLICITLY excluded. Everything here is redacted before it is written.

// Selected state fields needed for routing + gate diagnosis. Naming these
// explicitly is the allowlist — a field not listed here never leaves the box.
const STATE_ALLOWLIST = [
  "State Version",
  "Status",
  "Scope",
  "Lifecycle Phase",
  "Current Stage",
  "Last Completed Stage",
  "Next Stage",
  "Active Agent",
  "Revision Count",
  "Parked",
  "Parked At Stage",
] as const;

// Audit event types that carry routing/gate signal. Other event types (and all
// free-text Details/Request fields) are dropped.
const AUDIT_EVENT_ALLOWLIST = new Set([
  "WORKFLOW_STARTED",
  "WORKFLOW_COMPLETED",
  "WORKFLOW_PARKED",
  "WORKFLOW_UNPARKED",
  "STAGE_STARTED",
  "STAGE_COMPLETED",
  "STAGE_AWAITING_APPROVAL",
  "STAGE_REVISING",
  "STAGE_SKIPPED",
  "GATE_APPROVED",
  "GATE_REJECTED",
  "HUMAN_TURN",
  "PHASE_STARTED",
  "PHASE_COMPLETED",
  "SCOPE_DETECTED",
  "SCOPE_CHANGED",
  "RECOMPOSED",
]);

// Audit block fields kept per event (structural only — no Details/Request/
// Reason free text, which can carry paths or decisions).
const AUDIT_FIELD_ALLOWLIST = ["Event", "Timestamp", "Stage", "Slug", "Phase"];

export interface NormalizedEvidence {
  state: Record<string, string>;
  auditEvents: Array<Record<string, string>>;
  graph: { stageCount: number; stages: GraphStageLite[] } | null;
  hooks: HookHealthSnapshot;
  markers: MarkerSnapshot & { turnCounter: string | null; readonlyLatch: boolean };
  timeline: Timeline;
}

// Extract state fields on the allowlist. Values are redacted by the caller.
export function extractStateFields(stateContent: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of STATE_ALLOWLIST) {
    const re = new RegExp(`^- \\*\\*${field.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\*\\*:\\s*(.*)$`, "m");
    const m = stateContent.match(re);
    if (m) out[field] = m[1].trim();
  }
  return out;
}

// Extract allowlisted audit events with allowlisted fields only.
export function extractAuditEvents(audit: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const e of parseAuditEvents(audit)) {
    if (!AUDIT_EVENT_ALLOWLIST.has(e.event)) continue;
    const row: Record<string, string> = {};
    for (const f of AUDIT_FIELD_ALLOWLIST) {
      const v = auditBlockField(e.block, f);
      if (v !== null) row[f] = v;
    }
    out.push(row);
  }
  return out;
}

// ===========================================================================
// Bundle assembly
// ===========================================================================

export interface BundleResult {
  bundleDir: string;
  archivePath: string | null; // .tar.gz when packaging succeeded, else null
  findings: DoctorFinding[];
  manualShareNote: string | null; // set when archiving was unavailable/failed
}

// A file staged for the bundle, with its redacted content. Written all at once
// after the size budget is checked so a truncation is recorded, not silent.
interface StagedFile {
  relPath: string;
  content: string;
  truncated: boolean;
}

// The single fresh doctor analysis, shared by the LIVE `--doctor` render and
// the `--export` writer (issue #575, Arden #3): one read of state/audit/graph,
// one timeline, one diagnosis. The caller (handleDoctor) renders the legacy
// environment/config checks and these structured findings live (the diagnosis
// advisory-only, never touching the exit code), and for `--export` it merges
// the legacy checks into `findings` via mergeFindings(results.map(adaptLegacyResult), …)
// before handing the object to buildBundle — so the exported report.md/report.json
// carry BOTH the environment failures and the workflow diagnosis, and the export
// can never silently drop a failing env check the live report showed.
export interface DoctorAnalysis {
  ctx: RedactionContext;
  intentHash: string;
  findings: DoctorFinding[]; // the structured diagnosis findings (explicit ids/severities)
  timeline: Timeline;
  evidence: NormalizedEvidence;
}

// Seed EVERY custom (non-core) identifier the report will serialize into the
// redaction context so it is hashed before any JSON is written — not just the
// active intent slug (Arden #2). Core stage/agent slugs identify framework
// behavior and stay readable; anything else (custom stage/unit/artifact slugs,
// every intent dir name across spaces, non-core agent names) is hashed.
function seedCustomIdentifiers(
  ctx: RedactionContext,
  projectDir: string,
  coreSlugs: Set<string>,
  coreAgents: Set<string>,
  graphStages: GraphStageLite[],
  timeline: Timeline,
): void {
  const seed = (id: string): void => {
    // Defense-in-depth: a corrupt graph (valid JSON, wrong element types) can
    // hand a non-string here; shortHash/createHash would throw. Ignore it —
    // a non-string is not an identifying value and was never redactable.
    if (typeof id !== "string") return;
    if (id.length < 4) return; // too short to redact safely (would eat substrings)
    if (coreSlugs.has(id) || coreAgents.has(id)) return; // framework-known, keep readable
    if (!ctx.idHashes.has(id)) {
      ctx.idHashes.set(id, shortHash(id));
      ctx.rulesApplied.add("custom-id");
    }
  };
  // Every intent dir across every space (filenames + inline references).
  try {
    for (const sp of listSpaces(projectDir)) {
      for (const rec of listIntentDirs(projectDir, sp.name)) seed(rec);
    }
  } catch {
    /* registry read best-effort */
  }
  // Custom stage slugs + non-core lead/support agents seen in the graph. A
  // plugin- or adaptive-workflow-supplied lead_agent is non-core and would
  // otherwise serialize raw into evidence/normalized.json (seed() keeps core
  // agents readable since they are in coreAgents).
  for (const s of graphStages) {
    seed(s.slug);
    seed(s.lead_agent);
    for (const a of s.support_agents) seed(a);
  }
  // Any stage slug the timeline surfaced (covers audit-only slugs not in graph).
  for (const s of timeline.stages) seed(s.slug);
}

// Run the fresh analysis. Reads through symlink-rejecting safeRead; seeds all
// custom ids; runs the timeline + deterministic diagnosis; builds normalized
// evidence. Pure of any file WRITE — buildBundle does the writing.
export function runDoctorAnalysis(projectDir: string): DoctorAnalysis {
  const ctx = newRedactionContext(projectDir);
  // Anchor the realpath'd project root so every safeRead rejects an input whose
  // real location escapes the tree through a symlinked parent directory.
  setBundleRoot(projectDir);

  const relRec = relativeRecordDir(projectDir);
  const intentSlug = relRec ? basename(relRec) : null;
  const intentHash = intentSlug ? shortHash(intentSlug) : "no-intent";

  // Read sources (never emitted raw; symlinked inputs are refused by safeRead).
  const stateContent = safeRead(stateFilePath(projectDir));
  const audit = readAuditSafely(projectDir);

  const rgPath = runtimeGraphPath(projectDir);
  const runtimeGraphExists = existsSync(rgPath) && !isSymlink(rgPath);
  const runtimeGraphMtimeMs = runtimeGraphExists ? safeMtime(rgPath) : null;
  const graphStages = runtimeGraphExists ? readGraphStages(rgPath) : [];

  // Core allowlists from the SHIPPED graph (always present) — the stale/missing
  // runtime graph is the very thing we diagnose, so never seed core ids from it.
  const shippedStages = readShippedStageGraph(projectDir);
  const coreSlugs = new Set(shippedStages.map((s) => s.slug));
  const coreAgents = new Set<string>();
  for (const s of shippedStages) {
    coreAgents.add(s.lead_agent);
    for (const a of s.support_agents) coreAgents.add(a);
  }
  const stagesForDiagnosis = graphStages.length > 0 ? graphStages : shippedStages;
  setCoreSlugs(coreSlugs);

  const authoredNewest = newestStageSourceMtime(projectDir);
  const hooksHealth = readHookHealth(projectDir, audit);
  const markers = readMarkers(projectDir);
  const timeline = reconstructTimeline(audit, stateContent);

  // Seed the active intent + every other custom id BEFORE serialization.
  if (intentSlug) {
    ctx.idHashes.set(intentSlug, intentHash);
    ctx.rulesApplied.add("intent-id");
  }
  seedCustomIdentifiers(ctx, projectDir, coreSlugs, coreAgents, stagesForDiagnosis, timeline);

  const findings = runDiagnosis({
    projectDir,
    timeline,
    stateContent,
    audit,
    graphStages: stagesForDiagnosis,
    recordAbsDir: recordDir(projectDir),
    hooksHealth,
    runtimeGraphExists,
    runtimeGraphMtimeMs,
    authoredInputsNewestMtimeMs: authoredNewest,
    markers,
  });

  const evidence: NormalizedEvidence = {
    state: extractStateFields(stateContent),
    auditEvents: extractAuditEvents(audit),
    graph: runtimeGraphExists ? { stageCount: graphStages.length, stages: graphStages } : null,
    hooks: hooksHealth,
    markers,
    timeline,
  };

  return { ctx, intentHash, findings, timeline, evidence };
}

// Build the full export from a pre-computed analysis (issue #575). `tsToken` is
// a filesystem-safe timestamp the CALLER stamps. Returns the report dir +
// archive path + findings. Every staged string is redacted (custom ids already
// seeded into the analysis context) before it is written.
export function buildBundle(
  outParentDir: string,
  analysis: DoctorAnalysis,
  tsToken: string,
): BundleResult {
  const { ctx, intentHash, findings, timeline, evidence } = analysis;

  // Stage every file with redacted content. Custom stage/unit/artifact/agent
  // ids and every intent id were seeded into ctx by runDoctorAnalysis, so the
  // structured `timeline`/`graph` JSON is scrubbed here too — not only the
  // Markdown render.
  const staged: StagedFile[] = [];
  staged.push(stage("report.md", renderReportMd(timeline, findings, intentHash), ctx));
  // JSON files redact-then-serialize (stageJson) so a secret-scan replacement
  // can never corrupt JSON syntax; report.md stays serialize-then-redact (prose,
  // no structural contract).
  staged.push(stageJson("report.json", { schemaVersion: BUNDLE_SCHEMA_VERSION, timeline, findings }, ctx));
  staged.push(stageJson(join("evidence", "normalized.json"), evidence, ctx));

  // Enforce the total-size budget across staged content, recording truncation.
  enforceTotalBudget(staged);

  // Manifest last — it checksums the OTHER files' final (redacted, truncated)
  // content. It is NOT re-redacted: its only strings are allowlisted field
  // names, the hashed intent id, and SHA-256 checksums (which the secret-scan
  // would otherwise mangle as "long hex"). Redaction already ran on every file
  // the manifest describes.
  const manifest = buildManifest(staged, ctx, intentHash);
  staged.push({ relPath: "manifest.json", content: JSON.stringify(manifest, null, 2), truncated: false });

  // Write the canonical directory (owner-only).
  const bundleDir = join(outParentDir, `aidlc-diagnostic-report-${tsToken}-${intentHash}`);
  writeBundleDir(bundleDir, staged);

  // Best-effort archive.
  const { archivePath, manualShareNote } = tryArchive(bundleDir, outParentDir, tsToken, intentHash);

  return { bundleDir, archivePath, findings, manualShareNote };
}

// --- staging + redaction + budget ------------------------------------------

// Replace an over-budget file's content with a size-recording placeholder that
// PRESERVES the file's format. A `.json` file must stay parseable, so it becomes
// a valid JSON object carrying the truncation reason (a byte-sliced JSON blob is
// useless to a maintainer's tooling); a `.md`/other file gets a prose notice.
// The manifest independently records the truncation (buildManifest reads
// `truncated`), so the placeholder is the whole surviving content.
function truncatePlaceholder(relPath: string, originalBytes: number, reason: string): string {
  if (relPath.endsWith(".json")) {
    return JSON.stringify({ truncated: true, reason, originalBytes }, null, 2);
  }
  return `[TRUNCATED: ${reason} — original ${originalBytes} bytes]\n`;
}

function stage(relPath: string, rawContent: string, ctx: RedactionContext): StagedFile {
  return stageContent(relPath, redactString(rawContent, ctx));
}

// Stage a JSON-able OBJECT: redact each string VALUE (redactValue recurses;
// object keys are allowlisted field names, left intact) and THEN serialize.
// Redacting before serialization makes JSON-syntax corruption structurally
// impossible — a secret-scan replacement can never eat a string's closing quote
// because it never sees the quotes (Arden r4 #2). The serialized result is
// already fully redacted, so it is NOT re-run through redactString.
function stageJson(relPath: string, value: unknown, ctx: RedactionContext): StagedFile {
  return stageContent(relPath, JSON.stringify(redactValue(value, ctx), null, 2));
}

// Shared tail: apply the per-file size cap (format-preserving placeholder) to
// already-redacted content.
function stageContent(relPath: string, content: string): StagedFile {
  let truncated = false;
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_EVIDENCE_FILE_BYTES) {
    content = truncatePlaceholder(relPath, bytes, `file exceeded ${MAX_EVIDENCE_FILE_BYTES} bytes`);
    truncated = true;
  }
  return { relPath, content, truncated };
}

// Trim staged files from the largest down until the total fits the budget,
// recording each truncation. report.md/manifest are never dropped (they carry
// the notices), so only oversized evidence content is trimmed. A trimmed file
// is replaced by a format-preserving placeholder (valid JSON for .json), never
// a byte slice, so the machine-readable artifacts always parse.
function enforceTotalBudget(staged: StagedFile[]): void {
  const total = () => staged.reduce((n, f) => n + Buffer.byteLength(f.content, "utf-8"), 0);
  if (total() <= MAX_BUNDLE_BYTES) return;
  const bySize = [...staged].sort(
    (a, b) => Buffer.byteLength(b.content, "utf-8") - Buffer.byteLength(a.content, "utf-8"),
  );
  for (const f of bySize) {
    if (total() <= MAX_BUNDLE_BYTES) break;
    if (f.relPath === "report.md") continue;
    const bytes = Buffer.byteLength(f.content, "utf-8");
    f.content = truncatePlaceholder(f.relPath, bytes, "total-bundle budget exceeded");
    f.truncated = true;
  }
}

// --- manifest ---------------------------------------------------------------

interface Manifest {
  bundleSchemaVersion: string;
  aidlcVersion: string;
  harness: string;
  createdAt: string;
  intentIdHash: string;
  files: Array<{ path: string; sha256: string; bytes: number; truncated: boolean }>;
  redactionsApplied: string[];
  truncationNotices: string[];
  excluded: string[];
}

function buildManifest(staged: StagedFile[], ctx: RedactionContext, intentHash: string): Manifest {
  return {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    aidlcVersion: AIDLC_VERSION,
    harness: harnessDir(),
    createdAt: safeIso(),
    intentIdHash: intentHash,
    files: staged.map((f) => ({
      path: f.relPath,
      sha256: createHash("sha256").update(f.content, "utf-8").digest("hex"),
      bytes: Buffer.byteLength(f.content, "utf-8"),
      truncated: f.truncated,
    })),
    redactionsApplied: [...ctx.rulesApplied].sort(),
    truncationNotices: staged.filter((f) => f.truncated).map((f) => `${f.relPath} was truncated`),
    excluded: [
      "aidlc-state.md (raw)",
      "audit shards (raw)",
      "runtime-graph.json (raw)",
      "artifact bodies",
      "contribution bodies",
      "question/answer bodies",
      "memory files",
      "environment variables",
      "command output",
    ],
  };
}

// --- filesystem write (owner-only) -----------------------------------------

function writeBundleDir(bundleDir: string, staged: StagedFile[]): void {
  if (existsSync(bundleDir)) rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });
  tryChmod(bundleDir, 0o700);
  for (const f of staged) {
    const abs = join(bundleDir, f.relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, f.content, "utf-8");
    tryChmod(abs, 0o600);
  }
}

// --- archive (best-effort, dependency-free) --------------------------------

// Package the canonical dir as a .tar.gz using the system tar (present on
// macOS/Linux, and Windows 10+ ships bsdtar). No bespoke tar writer, no
// package dependency. On any failure the directory is retained and a manual-
// share note is returned instead.
function tryArchive(
  bundleDir: string,
  outParentDir: string,
  tsToken: string,
  intentHash: string,
): { archivePath: string | null; manualShareNote: string | null } {
  const archiveName = `aidlc-diagnostic-report-${tsToken}-${intentHash}.tar.gz`;
  const archivePath = join(outParentDir, archiveName);
  try {
    const dirName = basename(bundleDir);
    const res = Bun.spawnSync(["tar", "-czf", archivePath, "-C", outParentDir, dirName], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if (res.exitCode === 0 && existsSync(archivePath)) {
      tryChmod(archivePath, 0o600);
      return { archivePath, manualShareNote: null };
    }
  } catch {
    // fall through to the directory-retained path
  }
  return {
    archivePath: null,
    manualShareNote:
      `Archiving is unavailable on this system. The diagnostic report directory was kept at:\n  ${bundleDir}\n` +
      `Compress it yourself (zip or tar) before sharing.`,
  };
}

// --- report.md --------------------------------------------------------------

function renderReportMd(timeline: Timeline, findings: DoctorFinding[], intentHash: string): string {
  const L: string[] = [];
  L.push(`# AI-DLC Diagnostic Report`);
  L.push("");
  L.push(`- Bundle schema: ${BUNDLE_SCHEMA_VERSION}`);
  L.push(`- AI-DLC version: ${AIDLC_VERSION}`);
  L.push(`- Harness: ${harnessDir()}`);
  L.push(`- Intent (hashed): ${intentHash}`);
  L.push(`- Workflow status: ${timeline.workflowStatus}`);
  L.push(`- Workflow started: ${timeline.workflowStartedRaw}`);
  L.push("");
  L.push(`No source files or artifact bodies are included. Identifiers are hashed and paths are redacted.`);
  L.push("");

  L.push(`## Findings`);
  L.push("");
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  if (errors.length === 0 && warnings.length === 0) {
    L.push(`No errors or warnings.`);
  } else {
    for (const f of [...errors, ...warnings]) {
      L.push(`### ${f.severity.toUpperCase()} ${f.id}`);
      L.push("");
      L.push(f.summary);
      L.push("");
      if (f.remedy) {
        L.push(`Remedy: ${f.remedy}`);
        if (!f.safeToAutomate) L.push(`(Not safe to automate — run this yourself after confirming.)`);
        L.push("");
      }
    }
  }

  L.push(`## Timeline`);
  L.push("");
  if (timeline.stages.length === 0) {
    L.push(`No stages recorded.`);
  } else {
    L.push(`| Stage | Started | Completed | Duration | Gate | Rev | Gap | Flags |`);
    L.push(`|---|---|---|---|---|---|---|---|`);
    for (const s of timeline.stages) {
      L.push(
        `| ${hashSlugForDisplay(s.slug)} | ${s.startedRaw} | ${s.completedRaw} | ${fmtMs(s.durationMs)} | ${s.gate} | ${s.revisionCount ?? UNKNOWN} | ${fmtMs(s.gapFromPrevMs)} | ${s.abnormal.join(",") || "-"} |`,
      );
    }
  }
  for (const n of timeline.notes) {
    L.push("");
    L.push(`> ${n}`);
  }
  L.push("");
  return L.join("\n");
}

function fmtMs(ms: number | null): string {
  if (ms === null) return UNKNOWN;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round((m / 60) * 10) / 10}h`;
}

// --- finding merge ----------------------------------------------------------

// Merge live-doctor findings with bundle diagnosis, dedup by id+summary, sort
// errors → warnings → info (stable within a bucket).
export function mergeFindings(live: DoctorFinding[], diagnosis: DoctorFinding[]): DoctorFinding[] {
  const seen = new Set<string>();
  const merged: DoctorFinding[] = [];
  for (const f of [...diagnosis, ...live]) {
    const key = `${f.id}::${f.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(f);
  }
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return merged.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// --- source readers (structural only) --------------------------------------

// The shipped, always-present compiled stage graph (harness tree
// tools/data/stage-graph.json). Used to seed the core-slug allowlist and as
// the ensemble-mode source when the per-intent runtime graph is absent.
function readShippedStageGraph(projectDir: string): GraphStageLite[] {
  const p = join(projectDir, harnessDir(), "tools", "data", "stage-graph.json");
  if (!existsSync(p)) return [];
  return readGraphStages(p);
}

function readGraphStages(rgPath: string): GraphStageLite[] {
  try {
    const parsed = JSON.parse(safeRead(rgPath)) as unknown;
    const stages = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { stages?: unknown }).stages)
        ? (parsed as { stages: unknown[] }).stages
        : [];
    return (stages as Array<Record<string, unknown>>).map((s) => ({
      slug: typeof s.slug === "string" ? s.slug : "",
      phase: typeof s.phase === "string" ? s.phase : "",
      mode: typeof s.mode === "string" ? s.mode : "inline",
      lead_agent: typeof s.lead_agent === "string" ? s.lead_agent : "",
      support_agents: Array.isArray(s.support_agents)
        ? s.support_agents.filter((a): a is string => typeof a === "string")
        : [],
    })).filter((s) => s.slug !== "");
  } catch {
    return [];
  }
}

// Newest mtime across the authored stage source (aidlc-common/stages/**.md) —
// the "authored inputs" the runtime graph is compiled from.
function newestStageSourceMtime(projectDir: string): number | null {
  const root = join(projectDir, harnessDir(), "aidlc-common", "stages");
  let newest: number | null = null;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e);
      const st = safeLstat(abs);
      if (!st) continue;
      if (st.isDirectory()) walk(abs);
      else if (e.endsWith(".md") && (newest === null || st.mtimeMs > newest)) newest = st.mtimeMs;
    }
  };
  walk(root);
  return newest;
}

function readHookHealth(projectDir: string, audit: string): HookHealthSnapshot {
  const dir = hooksHealthDir(projectDir);
  const dirExists = existsSync(dir);
  const heartbeats: HookHealthSnapshot["heartbeats"] = [];
  const degradedDrops: HookHealthSnapshot["degradedDrops"] = [];
  // Age is measured against the newest audit timestamp (the run's own clock),
  // not wall-clock — a bundle produced days later must not flag every hook.
  const latestAudit = newestAuditMs(audit);
  if (dirExists) {
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      return { dirExists, heartbeats, degradedDrops };
    }
    for (const f of files.filter((x) => x.endsWith(".last"))) {
      const tsRaw = safeRead(join(dir, f)).trim();
      const ms = tsRaw ? Date.parse(tsRaw) : NaN;
      const ageMs =
        Number.isFinite(ms) && latestAudit !== null ? Math.max(0, latestAudit - ms) : null;
      heartbeats.push({ hook: f.replace(/\.last$/, ""), timestampRaw: tsRaw || UNKNOWN, ageMs });
    }
    for (const f of files.filter((x) => x.endsWith(".drops"))) {
      const lines = safeRead(join(dir, f)).split("\n").filter((l) => l.includes("[degraded]"));
      if (lines.length > 0) degradedDrops.push({ hook: f.replace(/\.drops$/, ""), count: lines.length });
    }
  }
  return { dirExists, heartbeats, degradedDrops };
}

function readMarkers(projectDir: string): NormalizedEvidence["markers"] {
  const planPath = planFilePath(projectDir);
  const planExists = existsSync(planPath);
  let planParseable: boolean | null = null;
  if (planExists) {
    try {
      JSON.parse(safeRead(planPath));
      planParseable = true;
    } catch {
      planParseable = false;
    }
  }
  const stopDir = stopHookDir(projectDir);
  const turnCounterPath = join(docsRoot(projectDir), ".aidlc-turn-counter");
  const latchPath = join(docsRoot(projectDir), ".aidlc-readonly-latch");
  return {
    planExists,
    planParseable,
    recoveryExists: existsSync(recoveryFilePath(projectDir)),
    stopHookDirExists: existsSync(stopDir),
    turnCounter: existsSync(turnCounterPath) ? safeRead(turnCounterPath).trim() : null,
    readonlyLatch: existsSync(latchPath),
  };
}

function newestAuditMs(audit: string): number | null {
  let newest: number | null = null;
  for (const e of parseAuditEvents(audit)) {
    if (Number.isFinite(e.timestampMs) && (newest === null || e.timestampMs > newest)) {
      newest = e.timestampMs;
    }
  }
  return newest;
}

// --- small safe helpers -----------------------------------------------------

// The realpath'd project root for the active analysis. Set once at the top of
// runDoctorAnalysis; used to reject inputs whose REAL location escapes the
// project tree via a symlinked PARENT directory (not just a symlinked leaf).
let bundleRealRoot: string | null = null;
function setBundleRoot(projectDir: string): void {
  try {
    bundleRealRoot = realpathSync(projectDir);
  } catch {
    bundleRealRoot = null;
  }
}

// True when `path`'s real (symlink-resolved) location is inside the project
// root — i.e. no component along the way is a symlink pointing outside the tree.
// realpathSync resolves EVERY component, so a symlinked parent dir is caught,
// not only a symlinked leaf. Unresolvable path (missing / broken link) → false.
function withinProjectRoot(path: string): boolean {
  if (!bundleRealRoot) return true; // root unknown → fall back to leaf-only guard
  try {
    const real = realpathSync(path);
    // Use the platform separator, not a hardcoded "/": realpathSync returns
    // backslash-separated paths on Windows, so a "/" boundary would fail every
    // nested input there and silently empty the analysis. sep is "/" on POSIX
    // (byte-identical to the prior behaviour) and "\\" on Windows.
    return real === bundleRealRoot || real.startsWith(`${bundleRealRoot}${sep}`);
  } catch {
    return false;
  }
}

// Read a bundle INPUT, refusing to follow a symlink at the leaf OR any parent
// component. Every source the exporter reads (state, runtime graph, plan,
// markers, hook health) goes through here, so a symlink planted at any input
// path — e.g. aidlc-state.md → /etc/passwd, or a symlinked audit/ dir — is
// rejected rather than read and (partially) copied into the report. lstat
// catches a leaf symlink; withinProjectRoot (realpath) catches a symlinked
// parent that escapes the tree. A symlink (or any read error) yields "".
function safeRead(path: string): string {
  try {
    if (lstatSync(path).isSymbolicLink()) return "";
    if (!withinProjectRoot(path)) return "";
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function safeMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// Read the audit trail, refusing symlinked shard files. readAllAuditShards uses
// readFileSync and would follow a symlinked shard, so we gate on the shard dir:
// if ANY entry under it is a symlink, we refuse the whole trail rather than
// leak a redirected file's normalized fields into the report. Audit content is
// otherwise only surfaced through the allowlisted extractAuditEvents.
function readAuditSafely(projectDir: string): string {
  const dir = auditShardDir(projectDir);
  if (dir && existsSync(dir)) {
    // Refuse a symlinked audit/ dir itself (existsSync/readdirSync traverse a
    // symlinked directory happily) or a real dir that escapes the project root,
    // then refuse any symlinked shard file inside it.
    if (isSymlink(dir) || !withinProjectRoot(dir)) return "";
    try {
      for (const e of readdirSync(dir)) {
        if (isSymlink(join(dir, e))) return "";
      }
    } catch {
      return "";
    }
  }
  return readAllAuditShards(projectDir);
}

function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Platforms without POSIX perms (Windows) — owner-only is best-effort.
  }
}

// isoTimestamp() reads a monotonic clock in the lib; safe to call at bundle
// time. Wrapped so a future clock-guard change has one call site.
function safeIso(): string {
  try {
    return isoTimestamp();
  } catch {
    return "unknown";
  }
}
