// Learning-gate tool — the tool-as-actor half of stage-protocol §13's
// Learnings Ritual. Two subcommands:
//
//   surface --slug <stage-slug> [--project-dir <path>]
//       Read-only. Reads the just-approved stage's memory.md (via
//       parseMemoryEntries), partitions entries into keep-candidates
//       (Interpretations / Deviations / Tradeoffs) and parked open
//       questions, and emits a structured JSON candidate set on stdout.
//       Carries NO AskUserQuestion field names — the orchestrator renders
//       the AUQ, runs the single-line admission conflict-check (KNOWLEDGE),
//       and the user decides keep/heading/scope (JUDGEMENT).
//       ALSO binds the space + intent active AT SURFACE TIME into the
//       output (LOCAL FIX, #735 follow-up / PR #747 review) — see
//       "Provenance binding" below.
//
//   persist --slug <stage-slug> --selections-json <path> [--project-dir <path>]
//       The deterministic WRITER. Reads the post-AUQ selections-json
//       (conflict-clear / user-escalated only — persist never judges),
//       and inside ONE withAuditLock body (decide-inside-lock): re-reads
//       the audit fresh, dedups per (Stage, Content-Hash) against the
//       fresh audit + an in-memory cid-marker content-presence check,
//       writes a confirmed learning as a PRACTICE under the orchestrator-
//       routed heading in {project,team}.md (the relocated method files the
//       resolver reads — a learning IS a practice, vision §6; the heading is
//       ensure-exists so an absent target is created, never a throw), or
//       scaffolds + two-write-binds a project-tier sensor manifest, then
//       emits RULE_LEARNED / SENSOR_PROPOSED.
//
// --- Provenance binding + content-addressed dedup (#735 follow-up, PR #747
//     review) ---
// Twelve findings from PR #747's five review rounds, fixed here:
//   1. Candidate ids restart at c1 on EVERY surface() call, so a later run
//      of the same stage in the SAME intent reused c1 for a completely
//      different learning and the old (intent, stage, candidate-id) marker
//      treated it as an idempotent retry, silently dropping the write.
//      Fixed by keying the marker/audit-match on a content hash of the
//      learning's own text instead of the positional candidate id.
//   2. `persist` re-resolved the active intent live at execution time, so a
//      surface-under-A / switch-to-B / persist sequence wrote under B's
//      marker instead of A's. Fixed by binding space+intent at surface()
//      time and threading that SAME value through persist's audit read,
//      audit write, and lock identity — never re-resolved from the live
//      cursor inside persist.
//   3. The (intent, stage, candidate-id) marker/row shape this file has
//      shipped before, the original pre-#735 (stage, candidate-id) shape,
//      and the earlier PR revision's truncated content hash are recognized
//      as legacy-compatible dedup matches so a post-upgrade retry does not
//      duplicate an already-persisted learning under the full-hash marker.
//   4. Ambiguous intent resolution (multiple intent records, no valid
//      cursor) must fail closed rather than silently degrading to the same
//      shared "unscoped" identity finding #1 exists to avoid — see
//      resolveSurfaceIntent().
//   5. The lock identity and audit read/write were pinned to the
//      surface-time space (finding #2), but practiceFilePath still called
//      memoryDirFor(projectDir) with no space argument — falling back to
//      whatever space happened to be LIVE-active when persist ran, not the
//      one the selection was surfaced under. Fixed by threading the pinned
//      space through practiceFilePath into memoryDirFor.
//   6. The sensor branch's own dedup (priorSensorProposedRow, formerly
//      priorAuditRow) still keyed on (stage, candidate_id) — the same
//      unstable-key defect class finding #1 fixed for learnings, recurring
//      for sensors: a later surface() run proposing the SAME sensor id
//      under a different candidate id re-emitted a duplicate
//      SENSOR_PROPOSED. Fixed by keying on (stage, the sensor's own stable
//      manifest id) instead of (stage, candidate_id) — stage stays in the
//      key because binding is legitimately per-stage even though the
//      manifest itself is a per-project singleton; dropping stage entirely
//      would make the no-op branch global and block a second, unrelated
//      stage from ever binding a sensor another stage had already proposed.
//   7. A legacy-marker match (finding #3) was recognized by candidate_id
//      alone, so a genuinely DIFFERENT learning landing on the same
//      positional candidate_id post-upgrade was mistaken for a retry of the
//      original and silently dropped — "two different learnings landing on
//      the same positional candidate id never collide" does not hold across
//      the upgrade boundary. Fixed by gating a legacy match on the marked
//      line's own text equalling the current selection's text
//      (legacyLineMatchesText).
//   8. `intent: null` is a real surface-time provenance value, but persist
//      converted it to `undefined`, whose audit-path meaning is "resolve the
//      live/lone intent." If an intent was created between surface and replay,
//      the unscoped learning was therefore audited under that later intent.
//      Fixed by failing closed inside the lock when an unscoped selections
//      file is replayed after any intent record appears; the user must
//      re-run surface and regenerate the selections file.
//   9. Truncating SHA-256 to 8 hex characters made collisions practical for
//      a persisted correctness identity, silently dropping different text.
//      Fixed by retaining the full digest.
//  10. The audit snapshot is intentionally read once inside the lock, but
//      rows emitted earlier in the same selections batch were not reflected
//      in it. Fixed by tracking hashes emitted during the transaction.
//  11. Provenance validation checked only path-safe syntax, so a valid-looking
//      missing space or intent could create a partial record. Fixed by
//      requiring the pinned records to still exist inside the lock.
//  12. A caller-provided --slug could override selections.stage_slug and
//      misattribute the marker and audit row. Fixed by rejecting a mismatch.
//
// The conflict COMPARISON is the orchestrator-LLM's job (the "single-line
// variant" of the §5 gate model); persist receives only conflict-clear or
// user-escalated selections and never judges. See docs/reference/
// 07-sensor-system.md "Gate-ritual handoff" for the round-trip.
//
// Three-concerns split (explainer §6:712): detection + surfacing +
// routing + writing are deterministic (this tool); the conflict-check
// comparison is knowledge (orchestrator-LLM); revise/skip/escalate is
// judgement (user). No LLM call lives in this tool.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import { memoryDirFor } from "./aidlc-graph.ts";
import {
  activeIntent,
  appendUnderHeading,
  errorMessage,
  findAllEvents,
  getField,
  isoTimestamp,
  intentsDir,
  listIntentDirs,
  parseMemoryEntries,
  readAllAuditShards,
  readStateFile,
  resolveProjectDir,
  resolveWorkflowSelection,
  runtimeGraphPath,
  spacesRoot,
  validSpaceFlag,
  withAuditLock,
  writeFileAtomic,
  harnessDir,
} from "./aidlc-lib.ts";

// --- Exit-code convention (plan §2) ---
//   0 success
//   1 missing/malformed state, missing memory.md, runtime-graph absent,
//     slug mismatch, framework-tier sensor path, lock-acquire failure
//   2 unknown subcommand / argument validation
function fail(message: string, code: 1 | 2): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

// --- Path helpers ---

// A confirmed learning IS a practice (vision §6). It lands in the relocated
// method file the resolver reads — team.md / project.md under
// aidlc/spaces/<space>/memory/ (neutral names, no `aidlc-` prefix) — NOT a
// parallel dated `*-learnings.md` log. memoryDirFor() derives the path from
// the SAME MEMORY_SEGMENTS loadRules()/the packager use, so the writer can
// never drift from the reader root (P5 relocated the reader; P6 closes the
// seam by pointing the writer at the same place).
// `space` MUST be the space PINNED at surface() time (PR #747 review, round
// 2) — memoryDirFor's own space arg is optional and falls back to the LIVE
// active-space cursor when omitted, which is exactly the bug: the lock and
// audit read/write were already pinned to the surfaced space, but this path
// alone kept reading whatever space happened to be active when persist ran.
function practiceFilePath(projectDir: string, scope: "project" | "team", space: string): string {
  return join(memoryDirFor(projectDir, space), `${scope}.md`);
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRealFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

// Project-tier sensor manifest path. The learning loop scaffolds to the
// PROJECT's .claude/sensors/, never the framework distribution (plan
// sanctioned deviation 3.4).
function sensorManifestPath(projectDir: string, sensorId: string): string {
  return join(projectDir, harnessDir(), "sensors", `aidlc-${sensorId}.md`);
}

// Resolve a stage's authored .md file path from its slug. The frontmatter
// edit (two-write sensor bind) lands here. AIDLC_STAGES_DIR mirrors the
// graph resolver's seam so tests can point at a fixture stage tree.
function stagesDir(projectDir: string): string {
  return process.env.AIDLC_STAGES_DIR ?? join(projectDir, harnessDir(), "aidlc-common", "stages");
}

// --- surface ---

interface SurfaceCandidate {
  id: string;
  source_heading: "Interpretations" | "Deviations" | "Tradeoffs";
  ts: string;
  summary: string;
  context: string;
  default_scope: "project";
}

interface SurfaceParkedQuestion {
  ts: string;
  summary: string;
}

interface SurfaceOutput {
  schema_version: 1;
  stage_slug: string;
  phase: string;
  space: string;
  intent: string | null;
  memory_entries_total: number;
  candidates: SurfaceCandidate[];
  parked_open_questions: SurfaceParkedQuestion[];
}

// Resolve the (space, intent) provenance to bind at SURFACE time. Two
// legitimate outcomes: no intent records exist at all (a flat/pre-init
// workspace — intent: null is genuinely safe), or activeIntent() resolves
// one (a live cursor, or the lone-record fallback). A THIRD case — multiple
// records exist but no cursor names a valid one — is genuine ambiguity, not
// a legacy shape, and must fail rather than silently degrade to the same
// shared "unscoped" identity the #735 fix exists to avoid colliding under.
function resolveSurfaceIntent(projectDir: string, space: string): string | null {
  if (listIntentDirs(projectDir, space).length === 0) return null;
  const resolved = activeIntent(projectDir, space);
  if (resolved !== null) return resolved;
  fail(
    `cannot resolve the active intent unambiguously in space "${space}": multiple intent ` +
      `records exist with no valid active-intent cursor. Set aidlc/spaces/${space}/intents/` +
      `active-intent to the intended record, then retry.`,
    1
  );
}

interface RuntimeStageRow {
  stage_slug: string;
  memory_path?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function readRuntimeStageRow(
  projectDir: string,
  slug: string,
  intent?: string,
  space?: string
): RuntimeStageRow {
  const path = runtimeGraphPath(projectDir, intent, space);
  if (!existsSync(path)) {
    fail(`runtime-graph.json not found: ${path}`, 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    fail(`runtime-graph.json is malformed: ${errorMessage(e)}`, 1);
  }
  if (!isRecord(parsed)) {
    fail("runtime-graph.json is malformed: missing stages array", 1);
  }
  const stagesRaw: unknown = parsed.stages;
  if (!Array.isArray(stagesRaw)) {
    fail("runtime-graph.json is malformed: missing stages array", 1);
  }
  const stages: unknown[] = stagesRaw;
  for (const raw of stages) {
    if (isRecord(raw) && raw.stage_slug === slug) {
      const memoryPath = typeof raw.memory_path === "string" ? raw.memory_path : undefined;
      return { stage_slug: slug, memory_path: memoryPath };
    }
  }
  fail(`stage "${slug}" not found in runtime-graph.json`, 1);
}

// The §13 ritual runs while the just-completed stage is still the Active
// (Current Stage) row at the approval gate. Reject a slug that isn't the
// active one — the orchestrator must surface the stage it just ran.
function assertActiveStage(stateContent: string, slug: string): void {
  const current = getField(stateContent, "Current Stage");
  if (current === null) {
    fail("state file has no Current Stage field", 1);
  }
  if (current !== slug) {
    fail(`slug mismatch: requested "${slug}" but Current Stage is "${current}"`, 1);
  }
}

function handleSurface(args: string[], projectDir: string): void {
  const flags = parseFlags(args);
  const slug = flags.slug;
  if (!slug) {
    fail("Usage: aidlc-learnings.ts surface --slug <stage-slug> [--project-dir <path>]", 1);
  }

  // LOCAL FIX (#747 review): resolve space/intent FIRST, before touching any
  // per-intent path. A genuinely ambiguous workspace (multiple intent
  // records, no valid cursor) must fail here with a clear message — not
  // fall through to readStateFile()'s OWN internal resolution, which (given
  // the same ambiguity) resolves to the bare/legacy path and fails with an
  // unrelated-looking "state file not found" instead.
  const selection = resolveWorkflowSelection(projectDir);
  const space = selection.space;
  const intent = selection.binding
    ? selection.intent
    : resolveSurfaceIntent(projectDir, space);
  const pinnedIntent = intent ?? undefined;

  let stateContent: string;
  try {
    stateContent = readStateFile(projectDir, pinnedIntent, space);
  } catch (e) {
    fail(`could not read state: ${errorMessage(e)}`, 1);
  }

  assertActiveStage(stateContent, slug);

  const row = readRuntimeStageRow(projectDir, slug, pinnedIntent, space);
  const memRel = row.memory_path;
  if (!memRel) {
    fail(`stage "${slug}" has no memory_path in runtime-graph.json`, 1);
  }
  const memAbs = join(projectDir, memRel);

  // memory.md may be absent (the per-stage lifecycle owns deterministic
  // creation; if a stage ran without it, surface zero candidates rather than
  // failing the gate).
  const raw = existsSync(memAbs) ? readFileSync(memAbs, "utf-8") : "";
  const entries = parseMemoryEntries(raw);

  // memory_path always ends `<prefix>/<phase>/<stageSlug>/memory.md` (see
  // relativeMemoryPath), so the phase is the third-from-last segment regardless
  // of prefix shape: the per-intent record dir, the bare space prefix, or the
  // legacy flat `aidlc-docs` root all share that tail. Indexing from the front
  // assumed the flat layout and yielded "spaces" under the workspace prefix.
  const segs = memRel.split("/");
  const phase = segs.at(-3) ?? "";

  const candidates: SurfaceCandidate[] = [];
  const parked: SurfaceParkedQuestion[] = [];
  let seq = 0;
  for (const e of entries) {
    if (e.heading === "Open questions") {
      parked.push({ ts: e.ts, summary: e.summary });
      continue;
    }
    seq++;
    candidates.push({
      id: `c${seq}`,
      source_heading: e.heading,
      ts: e.ts,
      summary: e.summary,
      context: e.context,
      default_scope: "project",
    });
  }

  const out: SurfaceOutput = {
    schema_version: 1,
    stage_slug: slug,
    phase,
    space,
    intent,
    memory_entries_total: entries.length,
    candidates,
    parked_open_questions: parked,
  };
  console.log(JSON.stringify(out));
}

// --- persist ---

type LearningSelection = {
  candidate_id: string;
  type: "learning";
  scope: "project" | "team";
  heading: string;
  text: string;
  source?: "orchestrator" | "user_addition";
};

type SensorManifestFields = {
  id: string;
  kind: string;
  command: string;
  default_severity: string;
  description: string;
  matches: string;
  timeout_seconds?: number;
  category?: string;
};

type SensorSelection = {
  candidate_id: string;
  type: "sensor";
  origin_stage: string;
  manifest_fields: SensorManifestFields;
  source?: "orchestrator" | "user_addition";
};

type Selection = LearningSelection | SensorSelection;

interface SelectionsFile {
  stage_slug: string;
  // Provenance pinned at surface() time (LOCAL FIX, #747 review) — persist
  // uses these, never re-resolving the live active-intent cursor itself.
  space: string;
  intent: string | null;
  selections: Selection[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function narrowSelection(raw: unknown): Selection {
  if (!isRecord(raw)) {
    fail("selections-json malformed: each selection must be an object", 1);
  }
  const candidateId = str(raw.candidate_id);
  if (candidateId === undefined) {
    fail("selections-json malformed: selection missing candidate_id", 1);
  }
  const source = raw.source === "user_addition" ? "user_addition" : raw.source === "orchestrator" ? "orchestrator" : undefined;

  if (raw.type === "sensor") {
    const originStage = str(raw.origin_stage);
    if (originStage === undefined || !isRecord(raw.manifest_fields)) {
      fail("selections-json malformed: sensor selection needs origin_stage + manifest_fields", 1);
    }
    const mf = raw.manifest_fields;
    const required = ["id", "kind", "command", "default_severity", "description", "matches"] as const;
    const fields: Record<string, string> = {};
    for (const k of required) {
      const v = str(mf[k]);
      if (v === undefined) {
        fail(`selections-json malformed: manifest_fields.${k} must be a string`, 1);
      }
      fields[k] = v;
    }
    const manifestFields: SensorManifestFields = {
      id: fields.id,
      kind: fields.kind,
      command: fields.command,
      default_severity: fields.default_severity,
      description: fields.description,
      matches: fields.matches,
      timeout_seconds: typeof mf.timeout_seconds === "number" ? mf.timeout_seconds : undefined,
      category: str(mf.category),
    };
    return { candidate_id: candidateId, type: "sensor", origin_stage: originStage, manifest_fields: manifestFields, source };
  }

  // Default to a learning selection.
  const scope = raw.scope === "team" ? "team" : "project";
  const heading = str(raw.heading);
  const text = str(raw.text);
  if (heading === undefined || text === undefined) {
    fail("selections-json malformed: learning selection needs heading + text", 1);
  }
  return { candidate_id: candidateId, type: "learning", scope, heading, text, source };
}

function parseSelectionsFile(path: string): SelectionsFile {
  if (!existsSync(path)) {
    fail(`selections-json not found: ${path}`, 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    fail(`selections-json is malformed: ${errorMessage(e)}`, 1);
  }
  if (!isRecord(parsed) || typeof parsed.stage_slug !== "string") {
    fail("selections-json is malformed: expected { stage_slug, space, intent, selections[] }", 1);
  }
  // Provenance pinned at surface() time — required, not inferred here.
  // (LOCAL FIX, #747 review: re-deriving it in persist is the exact defect
  // this fix removes.)
  if (typeof parsed.space !== "string") {
    fail("selections-json is malformed: missing or non-string space (bind it from surface's output)", 1);
  }
  if (validSpaceFlag(parsed.space) === null) {
    fail(
      "selections-json is malformed: space must be a lowercase slug beginning with a letter " +
        "and containing only lowercase letters, digits, or hyphens (bind it from surface's output)",
      1
    );
  }
  if (parsed.intent !== null && typeof parsed.intent !== "string") {
    fail("selections-json is malformed: intent must be a string or null (bind it from surface's output)", 1);
  }
  if (
    typeof parsed.intent === "string" &&
    (parsed.intent === "" ||
      parsed.intent === "." ||
      parsed.intent.includes("..") ||
      parsed.intent.includes("/") ||
      parsed.intent.includes("\\"))
  ) {
    fail(
      "selections-json is malformed: intent must be a non-empty record-directory name without " +
        'path separators or ".." (bind it from surface\'s output)',
      1
    );
  }
  const selectionsRaw: unknown = parsed.selections;
  if (!Array.isArray(selectionsRaw)) {
    fail("selections-json is malformed: expected { stage_slug, space, intent, selections[] }", 1);
  }
  const rawSelections: unknown[] = selectionsRaw;
  return {
    stage_slug: parsed.stage_slug,
    space: parsed.space,
    intent: parsed.intent,
    selections: rawSelections.map(narrowSelection),
  };
}

// A prior SENSOR_PROPOSED row for this (origin stage, sensor id)? Keyed on
// the sensor's own stable manifest id, not the positional candidate_id (PR
// #747 review, round 2): candidate ids restart at c1 on every surface()
// call, so a later run of the SAME stage proposing the SAME sensor id under
// a different candidate id would miss a (stage, candidate_id) match and
// re-emit a duplicate SENSOR_PROPOSED for a sensor already proposed by that
// stage — the same unstable-key defect class #735's own fix closed for
// RULE_LEARNED, recurring here in the sensor branch.
//
// Stage stays IN the key, though: a sensor manifest is a per-project
// singleton (sensorManifestPath), but BINDING it to a stage's frontmatter is
// legitimately per-stage (Destinations is an array for exactly this reason
// -- two unrelated stages can each independently recommend the same sensor
// and each needs its own frontmatter bind). Dropping stage from the key
// entirely (an earlier version of this fix) made the no-op branch global:
// once ANY stage had proposed a sensor, no OTHER stage could ever bind that
// same sensor to its own frontmatter again. `stage` here is the SAME value
// the SENSOR_PROPOSED audit row's own Stage field is written from (the
// persist call's top-level stageSlug, not sel.origin_stage), so the read
// side matches exactly what the write side stored. The two coincide in
// every real invocation (surface() only ever proposes a sensor for the
// stage whose Learnings Ritual is currently running, i.e. the same stage
// persist is being invoked for).
function priorSensorProposedRow(auditContent: string, stage: string, sensorId: string): boolean {
  const rows = findAllEvents(auditContent, "SENSOR_PROPOSED");
  const stageRe = new RegExp(`^\\*\\*Stage\\*\\*:\\s*${escapeRegex(stage)}\\s*$`, "m");
  const sensorIdRe = new RegExp(`^\\*\\*Sensor ID\\*\\*:\\s*${escapeRegex(sensorId)}\\s*$`, "m");
  return rows.some((r) => stageRe.test(r.block) && sensorIdRe.test(r.block));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The STABLE learnings idempotency check (content-hash, not candidate-id —
// see cidMarker's comment).
function priorAuditRowByHash(auditContent: string, slug: string, hash: string): boolean {
  const rows = findAllEvents(auditContent, "RULE_LEARNED");
  const stageRe = new RegExp(`^\\*\\*Stage\\*\\*:\\s*${escapeRegex(slug)}\\s*$`, "m");
  const hashRe = new RegExp(`^\\*\\*Content-Hash\\*\\*:\\s*${escapeRegex(hash)}\\s*$`, "m");
  return rows.some((r) => stageRe.test(r.block) && hashRe.test(r.block));
}

// Compatibility for PR revisions that persisted only the first 8 hex chars
// of SHA-256. Require the exact short hash field and a text-gated marker match
// at the call site so a 32-bit collision cannot suppress different content.
function priorTruncatedHashAuditRow(auditContent: string, slug: string, hash: string): boolean {
  return priorAuditRowByHash(auditContent, slug, hash.slice(0, 8));
}

// Legacy-compat match ONLY: a row written before this fix ever shipped
// (Candidate-ID present, Content-Hash ABSENT). The Content-Hash absence
// check is load-bearing, not decorative — without it, a row the NEW code
// itself wrote for a genuinely different learning that happens to reuse the
// same candidate_id (candidate ids restart at c1 every run) would be
// mistaken for the same legacy retry this exists to catch, silently
// reintroducing finding #1's collision. A row missing Content-Hash can only
// have been written by code older than this fix.
const CONTENT_HASH_FIELD_RE = /^\*\*Content-Hash\*\*:/m;
function priorLegacyAuditRow(auditContent: string, slug: string, candidateId: string): boolean {
  const rows = findAllEvents(auditContent, "RULE_LEARNED");
  const stageRe = new RegExp(`^\\*\\*Stage\\*\\*:\\s*${escapeRegex(slug)}\\s*$`, "m");
  const cidRe = new RegExp(`^\\*\\*Candidate-ID\\*\\*:\\s*${escapeRegex(candidateId)}\\s*$`, "m");
  return rows.some(
    (r) => stageRe.test(r.block) && cidRe.test(r.block) && !CONTENT_HASH_FIELD_RE.test(r.block)
  );
}

// The §13 default destination heading when the orchestrator routes a learning
// to no more-specific section. A learning IS a practice (vision §6): it lands
// under a topical practice heading in the method file, defaulting to the
// self-learning-loop section `## Corrections` (which org/team/project.md all
// ship). The orchestrator may route to a more fitting heading (testing →
// `## Testing Posture`, prohibition → `## Forbidden`); whatever it names is
// ensure-exists before the append (appendUnderHeading throws on an absent
// heading, so the tool creates the heading first when needed).
const DEFAULT_PRACTICE_HEADING = "## Corrections";

// Header template for the method file's FIRST creation. The relocated
// org/team/project.md always ship with all eight practice headings, so this
// only fires for a fresh/fixture workspace that ships no method file yet —
// it provides the minimal scaffold the ensure-exists append can land into.
function practiceFileTemplate(scope: "project" | "team"): string {
  const tier = scope === "project" ? "Project" : "Team";
  return `# ${tier}-Level Rules\n`;
}

// Normalise the orchestrator-routed destination to a `## ` heading. A bare
// "Corrections" and a fully-formed "## Corrections" both resolve to the same
// heading line; an empty/whitespace pick falls back to the default.
function practiceHeading(routed: string | undefined): string {
  const t = (routed ?? "").trim();
  if (t === "") return DEFAULT_PRACTICE_HEADING;
  return t.startsWith("## ") ? t : `## ${t.replace(/^#+\s*/, "")}`;
}

// Ensure-exists a `## ` heading in a method file. appendUnderHeading throws
// when the heading is absent (DETERMINISM safety net, aidlc-lib.ts), so the
// orchestrator may name a heading the shipped file doesn't carry — append it
// (with a leading blank line when the file already has content) so the
// subsequent appendUnderHeading lands cleanly.
function ensureHeading(content: string, heading: string): string {
  const headingRe = new RegExp(`^${escapeRegex(heading)}[ \\t]*$`, "m");
  if (headingRe.test(content)) return content;
  const sep = content === "" ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${sep}${heading}\n`;
}

// cid marker — stable, content-addressed idempotency key per written line.
//
// LOCAL FIX (#735 follow-up, PR #747 review): keying on candidate_id (even
// scoped by intent, as this file's first #735 fix did) is not stable —
// candidate ids restart at c1 on EVERY surface() call, so a later run of
// the same stage in the SAME intent reuses c1 for a completely different
// learning. The old scheme treated that as the same idempotency key and
// silently dropped the second write (reviewer-reproduced: two differently
// worded c1 selections in one intent, second persist reports
// rule_learned: 0). The key's third component is now a hash of the
// learning's own text — the actually-stable identity: an exact retry
// (crash recovery) still hashes identically and dedups; two DIFFERENT
// texts landing on the same positional candidate_id never collide.
function cidMarker(intentSlug: string, slug: string, hash: string): string {
  return `<!-- cid:${intentSlug}:${slug}:${hash} -->`;
}

// Full SHA-256 content hash. This is a persisted correctness identity, not a
// display token: truncating it to 8 hex characters admits practical birthday
// collisions that silently drop a different learning as an idempotent retry.
function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

// Legacy marker shapes this tool has ever written. Kept ONLY so a
// post-upgrade retry of an already-persisted learning is recognized and
// not duplicated under the new marker (PR #747 review: "existing markers
// are duplicated after upgrade") — never written going forward.
function legacyMarkerPreIntentScope(slug: string, candidateId: string): string {
  return `<!-- cid:${slug}:${candidateId} -->`; // pre-#735
}
function legacyMarkerCandidateIdScoped(intentSlug: string, slug: string, candidateId: string): string {
  return `<!-- cid:${intentSlug}:${slug}:${candidateId} -->`; // #735's own first fix (PR #747 head)
}

// A legacy marker match is a genuine retry ONLY when the marked line's own
// text equals the current selection's text (PR #747 review, round 2):
// "two different learnings landing on the same positional candidate id
// never collide" does not hold across the upgrade boundary — a legacy
// marker is keyed on candidate_id alone (no content hash), so a DIFFERENT
// learning that happens to land on the same positional candidate_id
// post-upgrade would otherwise be silently dropped as a false "retry" of
// the original. Matches the exact line shape persist itself writes:
// `- <text> (learned <date>) <marker>`.
function legacyLineMatchesText(content: string, marker: string, text: string): boolean {
  const re = new RegExp(
    `^- ${escapeRegex(text)} \\(learned \\d{4}-\\d{2}-\\d{2}\\) ${escapeRegex(marker)}\\s*$`,
    "m"
  );
  return re.test(content);
}

function handlePersist(args: string[], projectDir: string): void {
  const flags = parseFlags(args);
  const slug = flags.slug;
  const selectionsJson = flags["selections-json"];
  if (!selectionsJson) {
    fail(
      "Usage: aidlc-learnings.ts persist --slug <stage-slug> --selections-json <path> [--project-dir <path>]",
      1
    );
  }

  const selFile = parseSelectionsFile(selectionsJson);
  if (slug !== undefined && slug !== selFile.stage_slug) {
    fail(
      `slug mismatch: selections were surfaced for "${selFile.stage_slug}" but persist requested "${slug}"`,
      1
    );
  }
  const stageSlug = selFile.stage_slug;
  // LOCAL FIX (#747 review): bound at surface() time (selFile.space/.intent),
  // NOT re-resolved here against the live active-intent cursor. Re-resolving
  // live let a surface-under-A / switch-to-B / persist sequence write under
  // B's marker instead of A's ("selections are not bound to their
  // originating intent"). null is the legitimate flat/unscoped case
  // established at surface time — not "couldn't figure it out now."
  const pinnedSpace = selFile.space;
  const pinnedIntent = selFile.intent ?? undefined;
  const intentSlug = selFile.intent ?? "unscoped";

  // ONE withAuditLock body — decide-inside-lock (plan §0.4). Re-read the
  // audit fresh INSIDE the lock; never reuse a pre-lock read. Lock identity
  // and the audit read below are both pinned to the SAME surface-time
  // space/intent so the audit row and the practice line can never land
  // under different intents (PR #747 review note).
  let lockResult: { rule_learned: number; sensor_proposed: number; bound_stages: string[] };
  try {
    lockResult = withAuditLock(projectDir, () => {
      if (!isRealDirectory(join(spacesRoot(projectDir), pinnedSpace))) {
        fail(
          `cannot persist selections for missing space "${pinnedSpace}". ` +
            "Re-run the stage's surface step and regenerate the selections file, then retry.",
          1
        );
      }
      const intentDirs = listIntentDirs(projectDir, pinnedSpace);
      if (selFile.intent === null && intentDirs.length > 0) {
        fail(
          `cannot persist an unscoped selections replay in space "${pinnedSpace}": the selections ` +
            "file was surfaced when the space had no intent records, but intent records now exist. " +
            "Re-run the stage's surface step and regenerate the selections file, then retry.",
          1
        );
      }
      const pinnedIntentDir =
        selFile.intent === null ? null : join(intentsDir(projectDir, pinnedSpace), selFile.intent);
      if (
        selFile.intent !== null &&
        (!intentDirs.includes(selFile.intent) ||
          pinnedIntentDir === null ||
          !isRealDirectory(pinnedIntentDir) ||
          !isRealFile(join(pinnedIntentDir, "aidlc-state.md")))
      ) {
        fail(
          `cannot persist selections for missing intent record "${selFile.intent}" in space ` +
            `"${pinnedSpace}". Re-run the stage's surface step and regenerate the selections ` +
            "file, then retry.",
          1
        );
      }
      // Read across every per-clone audit shard of the PINNED intent (single
      // shard in the common case).
      const auditContent = readAllAuditShards(projectDir, pinnedIntent, pinnedSpace);
      const batchRuleHashes = new Set<string>();

      let ruleLearned = 0;
      let sensorProposed = 0;
      const boundStages: string[] = [];

      // --- Learnings-as-practices: group by destination method file, read
      // once, thread the append through accumulating in-memory content
      // (mirrors handlePracticesPromote's same-file write-and-emit
      // precedent). A confirmed learning is appended as a PRACTICE under the
      // orchestrator-routed heading in {project,team}.md — the relocated
      // files the resolver reads. ---
      const learnings = selFile.selections.filter(
        (s): s is LearningSelection => s.type === "learning"
      );

      // Bucket destination files; load (or template) each once. ensureFile
      // returns { path, content } so callers never re-fetch from the Map.
      const fileContent = new Map<string, string>();
      const ensureFile = (scope: "project" | "team"): { path: string; content: string } => {
        const path = practiceFilePath(projectDir, scope, pinnedSpace);
        const existing = fileContent.get(path);
        if (existing !== undefined) {
          return { path, content: existing };
        }
        const initial = existsSync(path)
          ? readFileSync(path, "utf-8")
          : practiceFileTemplate(scope);
        fileContent.set(path, initial);
        return { path, content: initial };
      };

      for (const sel of learnings) {
        const hash = contentHash(sel.text);
        if (batchRuleHashes.has(hash)) continue;

        const bucket = ensureFile(sel.scope);
        const path = bucket.path;
        let content = bucket.content;
        const marker = cidMarker(intentSlug, stageSlug, hash);
        const truncatedHashMarker = cidMarker(intentSlug, stageSlug, hash.slice(0, 8));
        const today = isoTimestamp().slice(0, 10);
        const source = sel.source ?? "orchestrator";
        // The orchestrator routes the learning to the fitting practice heading
        // (KNOWLEDGE); normalise + ensure-exists it before the append.
        const heading = practiceHeading(sel.heading);

        // Content-hash match is the stable check; the legacy candidate-id
        // match is the upgrade-compat fallback for rows/lines written before
        // this fix shipped. A legacy match is gated on the marked LINE's own
        // text equalling sel.text (PR #747 review, round 2) — see
        // legacyLineMatchesText's own comment for why candidate_id alone is
        // not a safe legacy-retry key. priorLegacyAuditRow itself additionally
        // requires Content-Hash's ABSENCE so it can never mistake a fresh,
        // different-content row for a legacy retry — see its own comment.
        const legacyLineMatch =
          legacyLineMatchesText(
            content,
            legacyMarkerCandidateIdScoped(intentSlug, stageSlug, sel.candidate_id),
            sel.text
          ) || legacyLineMatchesText(content, legacyMarkerPreIntentScope(stageSlug, sel.candidate_id), sel.text);
        const truncatedHashLineMatch = legacyLineMatchesText(
          content,
          truncatedHashMarker,
          sel.text
        );
        const hasRow =
          priorAuditRowByHash(auditContent, stageSlug, hash) ||
          (truncatedHashLineMatch && priorTruncatedHashAuditRow(auditContent, stageSlug, hash)) ||
          (legacyLineMatch && priorLegacyAuditRow(auditContent, stageSlug, sel.candidate_id));
        const hasLine = content.includes(marker) || truncatedHashLineMatch || legacyLineMatch;

        // no-op: audit row AND line both present.
        if (hasRow && hasLine) {
          batchRuleHashes.add(hash);
          continue;
        }

        // Write the line unless it is already present (recovery: row exists,
        // line missing → write only; fresh: neither → write + emit). Create the
        // routed heading first when the method file doesn't carry it.
        if (!hasLine) {
          content = ensureHeading(content, heading);
          const line = `- ${sel.text} (learned ${today}) ${marker}\n`;
          content = appendUnderHeading(content, heading, line);
          fileContent.set(path, content);
        }

        // Emit only when this is fresh (no prior audit row). Candidate-ID is
        // kept for human audit-trail readability (which numbered candidate
        // in that surface batch this was); Content-Hash is the actual dedup
        // identity going forward.
        if (!hasRow) {
          appendAuditEntryUnlocked(
            "RULE_LEARNED",
            {
              Stage: stageSlug,
              "Candidate-ID": sel.candidate_id,
              "Content-Hash": hash,
              Destination: path,
              Heading: heading,
              Source: source,
            },
            projectDir,
            pinnedIntent,
            pinnedSpace
          );
          ruleLearned++;
        }
        batchRuleHashes.add(hash);
      }

      // Flush each method file once (atomic).
      for (const [path, content] of fileContent) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileAtomic(path, content);
      }

      // --- Sensors: two-write atomic bind (manifest + stage frontmatter). ---
      const sensors = selFile.selections.filter(
        (s): s is SensorSelection => s.type === "sensor"
      );
      for (const sel of sensors) {
        const sensorId = sel.manifest_fields.id;
        const manifestPath = sensorManifestPath(projectDir, sensorId);

        // Reject framework-distribution paths — a per-project learning loop
        // must not mutate the shipped framework (plan deviation 3.4).
        if (isFrameworkDistributionPath(manifestPath)) {
          fail(`refusing to scaffold a sensor manifest under the framework distribution: ${manifestPath}`, 1);
        }

        const hasRow = priorSensorProposedRow(auditContent, stageSlug, sensorId);
        const hasManifest = existsSync(manifestPath);

        if (hasRow && hasManifest) {
          // no-op
          boundStages.push(sel.origin_stage);
          continue;
        }

        // Write 1: the manifest (project-tier).
        if (!hasManifest) {
          mkdirSync(dirname(manifestPath), { recursive: true });
          writeFileAtomic(manifestPath, renderSensorManifest(sel.manifest_fields));
        }

        // Write 2: append the id to the originating stage's sensors:
        // frontmatter (the pull-authoring two-write install).
        const bound = bindSensorToStage(projectDir, sel.origin_stage, sensorId);
        if (bound) boundStages.push(sel.origin_stage);

        if (!hasRow) {
          appendAuditEntryUnlocked(
            "SENSOR_PROPOSED",
            {
              Stage: stageSlug,
              "Candidate-ID": sel.candidate_id,
              "Sensor ID": sensorId,
              "Manifest path": manifestPath,
              Matches: sel.manifest_fields.matches,
              // Plural array field to match the frozen destinations[]
              // contract name under the explainer's single-origin model.
              Destinations: JSON.stringify([sel.origin_stage]),
              Source: sel.source ?? "orchestrator",
            },
            projectDir,
            pinnedIntent,
            pinnedSpace
          );
          sensorProposed++;
        }
      }

      return {
        rule_learned: ruleLearned,
        sensor_proposed: sensorProposed,
        bound_stages: boundStages,
      };
    }, pinnedIntent, pinnedSpace);
  } catch (e) {
    // Lock-acquire failure (or any in-lock throw) — name the lock path +
    // manual remedy so a hard-killed predecessor's orphaned lock is
    // recoverable by hand (plan §0.19b).
    const msg = errorMessage(e);
    if (/Failed to acquire audit lock/.test(msg)) {
      fail(
        `${msg}. The audit lock dir may be orphaned by a hard-killed run; ` +
          `remove it manually (look under the system temp dir for the aidlc audit lock) and retry.`,
        1
      );
    }
    fail(`persist failed: ${msg}`, 1);
  }

  const notes: string[] = [];
  if (lockResult.bound_stages.length > 0) {
    const uniq = [...new Set(lockResult.bound_stages)];
    notes.push(
      `manifest created + bound to ${uniq.join(", ")}; fires from next compile`
    );
  }
  console.log(
    JSON.stringify({
      stage_slug: stageSlug,
      rule_learned: lockResult.rule_learned,
      sensor_proposed: lockResult.sensor_proposed,
      notes,
    })
  );
}

// Render a sensor manifest .md body from the scaffolded fields. Mirrors the
// shipped manifest shape (dist/claude/.claude/sensors/aidlc-linter.md).
function renderSensorManifest(f: SensorManifestFields): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${f.id}`);
  lines.push(`kind: ${f.kind}`);
  lines.push(`command: ${f.command}`);
  lines.push(`default_severity: ${f.default_severity}`);
  lines.push(`description: ${f.description}`);
  if (f.category !== undefined) lines.push(`category: ${f.category}`);
  lines.push(`matches: "${f.matches}"`);
  if (f.timeout_seconds !== undefined) lines.push(`timeout_seconds: ${f.timeout_seconds}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${f.id} sensor`);
  lines.push("");
  lines.push(f.description);
  lines.push("");
  lines.push("Scaffolded by the §13 learning gate (project-tier).");
  lines.push("");
  return lines.join("\n");
}

// Refuse to write a manifest into the framework distribution tree
// (dist/claude/.claude/sensors). A learning loop scaffolds to the
// PROJECT's .claude/sensors only (plan deviation 3.4).
function isFrameworkDistributionPath(path: string): boolean {
  return (
    path.includes(join("dist", "claude", ".claude", "sensors")) ||
    path.includes(join("dist", "kiro", ".kiro", "sensors")) ||
    path.includes(join("dist", "codex", ".codex", "sensors")) ||
    path.includes(join("dist", "opencode", ".aidlc", "sensors")) ||
    path.includes(join("dist", "cursor", ".cursor", "sensors"))
  );
}

// Resolve the stage .md file for a slug by walking the stages tree's phase
// subdirectories. Returns null when the stage file can't be located.
function findStageFile(projectDir: string, slug: string): string | null {
  const root = stagesDir(projectDir);
  if (!existsSync(root)) return null;
  // Stage files live at <root>/<phase>/<slug>.md.
  for (const phase of readdirSync(root)) {
    const phaseDir = join(root, phase);
    let isDir = false;
    try {
      isDir = statSync(phaseDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const candidate = join(phaseDir, `${slug}.md`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Append a sensor id to a stage file's `sensors:` frontmatter list, in
// place. The immutable ## Steps / ## Sensors / ## Learn body is untouched —
// only the authored frontmatter import list grows (explainer §6:1049
// "stage frontmatter is immutable in shape, not in contents"). Returns true
// when the id was newly added (or already present); false when the stage
// file could not be located.
function bindSensorToStage(projectDir: string, slug: string, sensorId: string): boolean {
  const stageFile = findStageFile(projectDir, slug);
  if (!stageFile) return false;
  const raw = readFileSync(stageFile, "utf-8");

  const fmMatch = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) return false;
  const fmBody = fmMatch[2];

  // Already bound? Idempotent.
  const sensorsBlock = fmBody.match(/^sensors:\s*\n((?:[ \t]+-[ \t]+.*\n?)*)/m);
  if (sensorsBlock) {
    const already = new RegExp(`^[ \\t]+-[ \\t]+${escapeRegex(sensorId)}\\s*$`, "m").test(
      sensorsBlock[1]
    );
    if (already) {
      writeFileAtomic(stageFile, raw); // no-op rewrite keeps semantics uniform
      return true;
    }
    // Insert the new id as a list item at the end of the existing block,
    // matching the block's indentation.
    const indentMatch = sensorsBlock[1].match(/^([ \t]+)-/);
    const indent = indentMatch ? indentMatch[1] : "  ";
    // Find the end of the sensors block within the raw string.
    const blockText = sensorsBlock[0];
    const insertPoint = raw.indexOf(blockText) + blockText.length;
    const trailing = blockText.endsWith("\n") ? "" : "\n";
    const newItem = `${trailing}${indent}- ${sensorId}\n`;
    const newRaw = raw.slice(0, insertPoint) + newItem + raw.slice(insertPoint);
    writeFileAtomic(stageFile, newRaw);
    return true;
  }

  // No sensors: block — add one right after the frontmatter opening, as the
  // last frontmatter key before the closing ---.
  const closeIdx = raw.indexOf(fmMatch[3]);
  const insert = `sensors:\n  - ${sensorId}\n`;
  const newRaw = raw.slice(0, closeIdx) + insert + raw.slice(closeIdx);
  writeFileAtomic(stageFile, newRaw);
  return true;
}

// --- arg parsing ---

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

function printHelp(): void {
  process.stdout.write(
    [
      "aidlc-learnings.ts — §13 learning-gate tool (tool-as-actor).",
      "",
      "Subcommands:",
      "  surface --slug <stage-slug> [--project-dir <path>]",
      "      Read memory.md for the active stage; emit structured candidates",
      "      (Interpretations/Deviations/Tradeoffs) + parked open questions.",
      "  persist --slug <stage-slug> --selections-json <path> [--project-dir <path>]",
      "      Write confirmed learnings as practices under the routed heading in",
      "      {project,team}.md (the relocated method files) and/or scaffold + bind",
      "      a project-tier sensor manifest; emit RULE_LEARNED / SENSOR_PROPOSED",
      "      under one withAuditLock.",
      "  --help",
      "",
    ].join("\n")
  );
}

export function main(argv: string[]): void {
  const { projectDirArg, rest } = stripProjectDir(argv);
  const [cmd, ...subargs] = rest;

  if (cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === undefined) {
    fail("Usage: aidlc-learnings.ts <surface|persist|--help>", 2);
  }

  const projectDir = resolveProjectDir(projectDirArg);

  switch (cmd) {
    case "surface":
      handleSurface(subargs, projectDir);
      break;
    case "persist":
      handlePersist(subargs, projectDir);
      break;
    default:
      fail(`Unknown subcommand: ${cmd}. Run aidlc-learnings.ts --help for usage.`, 2);
  }
}

if (import.meta.main) main(process.argv.slice(2));
