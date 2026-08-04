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
//
//   persist --slug <stage-slug> --selections-json <path> [--project-dir <path>]
//       The deterministic WRITER. Reads the post-AUQ selections-json
//       (conflict-clear / user-escalated only — persist never judges),
//       and inside ONE withAuditLock body (decide-inside-lock): re-reads
//       the audit fresh, dedups per (Stage, Candidate-ID) against the
//       fresh audit + an in-memory cid-marker content-presence check,
//       writes a confirmed learning as a PRACTICE under the orchestrator-
//       routed heading in {project,team}.md (the relocated method files the
//       resolver reads — a learning IS a practice, vision §6; the heading is
//       ensure-exists so an absent target is created, never a throw), or
//       scaffolds + two-write-binds a project-tier sensor manifest, then
//       emits RULE_LEARNED / SENSOR_PROPOSED.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { appendAuditEntryUnlocked, appendPreWorkflowAuditEntryUnlocked } from "./aidlc-audit.ts";
import { memoryDirFor } from "./aidlc-graph.ts";
import {
  appendUnderHeading,
  errorMessage,
  findAllEvents,
  getField,
  isoTimestamp,
  parseMemoryEntries,
  readAllAuditShards,
  readPreWorkflowAuditSurface,
  readStateFile,
  resolveProjectDir,
  runtimeGraphPath,
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
function practiceFilePath(projectDir: string, scope: "project" | "team"): string {
  return join(memoryDirFor(projectDir), `${scope}.md`);
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
  memory_entries_total: number;
  candidates: SurfaceCandidate[];
  parked_open_questions: SurfaceParkedQuestion[];
}

interface RuntimeStageRow {
  stage_slug: string;
  memory_path?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function readRuntimeStageRow(projectDir: string, slug: string): RuntimeStageRow {
  const path = runtimeGraphPath(projectDir);
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

  let stateContent: string;
  try {
    stateContent = readStateFile(projectDir);
  } catch (e) {
    fail(`could not read state: ${errorMessage(e)}`, 1);
  }

  assertActiveStage(stateContent, slug);

  const row = readRuntimeStageRow(projectDir, slug);
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
    fail("selections-json is malformed: expected { stage_slug, selections[] }", 1);
  }
  const selectionsRaw: unknown = parsed.selections;
  if (!Array.isArray(selectionsRaw)) {
    fail("selections-json is malformed: expected { stage_slug, selections[] }", 1);
  }
  const rawSelections: unknown[] = selectionsRaw;
  return {
    stage_slug: parsed.stage_slug,
    selections: rawSelections.map(narrowSelection),
  };
}

// A prior RULE_LEARNED / SENSOR_PROPOSED row for this (Stage, Candidate-ID)?
//
// `destination` narrows the match to rows that landed in ONE practice file.
// Without it the audit dedup is GLOBAL while the practice-line dedup checks only
// the requested destination, so persisting one cid to `project` and then to
// `team` writes both files but reports the second call as already-done and
// leaves the team.md line with no audit row. Both checks have to be scoped the
// same way, and per-destination is the scope that matches the question actually
// being asked: "is this rule already in THIS file?"
//
// `destination` must be the PROJECT-RELATIVE path — an absolute one makes the key
// machine-specific and a clone/move re-emits. A row written by an EARLIER build
// stored an absolute Destination; those still dedup because
// legacyDestinationMatches compares the workspace-relative TAIL of both sides, so
// an upgrade does not double-emit even after the project moves.
// A raw (non-bulleted) `**Field**: value` line inside an audit block.
// getField() requires a leading `- ` bullet, which an audit block never has.
function getRawField(block: string, field: string): string | null {
  const m = block.match(new RegExp(`^\\*\\*${escapeRegex(field)}\\*\\*:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

function priorAuditRow(
  auditContent: string,
  event: "RULE_LEARNED" | "SENSOR_PROPOSED",
  slug: string,
  candidateId: string,
  destination?: string,
  // The incoming rule text's digest (see sha256Hex). Only RULE_LEARNED callers
  // that care about text identity pass this — see `digestConfirmed` below.
  textDigest?: string
): { found: boolean; exact: boolean; legacyOnly: boolean; digestConfirmed: boolean } {
  const rows = findAllEvents(auditContent, event);
  const stageRe = new RegExp(`^\\*\\*Stage\\*\\*:\\s*${escapeRegex(slug)}\\s*$`, "m");
  const cidRe = new RegExp(`^\\*\\*Candidate-ID\\*\\*:\\s*${escapeRegex(candidateId)}\\s*$`, "m");
  const destRes: RegExp[] = [];
  if (destination !== undefined) {
    destRes.push(new RegExp(`^\\*\\*Destination\\*\\*:\\s*${escapeRegex(destination)}\\s*$`, "m"));
  }
  // Report HOW the row matched, not just whether. An exact Destination match is
  // certain; a legacy tail match is a heuristic (two unrelated projects share the
  // same workspace-relative tail by construction), and the caller needs to know
  // the difference before it decides that an event already exists.
  let exact = false;
  let legacyOnly = false;
  // Whether an EXACT-destination matching row also carries a Text-Digest field
  // equal to `textDigest`. Undefined `textDigest` means the caller has no text
  // to confirm (SENSOR_PROPOSED dedup) — reported confirmed so it never blocks
  // that path. Deliberately NOT checked against a legacy-tail match: a
  // legacy-tail row is already a heuristic the caller treats as "probably an
  // unrelated project, write fresh regardless" (see the emit-decision comment
  // in writeRulePractice), so gating it on digest too would refuse a write the
  // existing legacy-tail contract already commits to allowing.
  let digestConfirmed = textDigest === undefined;
  for (const r of rows) {
    if (!stageRe.test(r.block) || !cidRe.test(r.block)) continue;
    if (destination === undefined || destRes.some((re) => re.test(r.block))) {
      exact = true;
      if (textDigest !== undefined && getRawField(r.block, "Text-Digest") === textDigest) {
        digestConfirmed = true;
      }
      break;
    }
    if (legacyDestinationMatches(r.block, destination)) legacyOnly = true;
  }
  return { found: exact || legacyOnly, exact, legacyOnly: legacyOnly && !exact, digestConfirmed };
}

// Stable content-address for a rule's text, trimmed the same way the writer
// itself trims before comparing/storing (see writeRulePractice). Recorded in
// the audit row as `Text-Digest` so a FUTURE read of that row — after the
// practice line it was written for has been deleted — can prove what text the
// row was actually for, not merely which candidate id it claims.
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

// Does this row's Destination denote the SAME FILE as `absPath`, allowing for a
// legacy absolute value recorded under a different spelling of the same path?
//
// A raw string compare is not enough, and that is the whole bug this closes.
// `resolveProjectDir` never canonicalises its input, so the same real project
// reached through a symlink, a trailing slash, or another mount alias yields a
// different absolute string — and an old row written under one spelling then
// fails to match a recomputation under another, re-emitting the event and
// reporting the contradiction `rule_learned: 1` with `already_present: true`.
// So the comparison is made on the CANONICAL real path of both sides.
function legacyDestinationMatches(
  block: string,
  relDestination: string | undefined
): boolean {
  if (relDestination === undefined) return false;
  // An audit row's field is `**Destination**: <value>` with NO leading bullet, so
  // getField() (which requires `- **Field**:`) does not apply to an audit block.
  const m = block.match(/^\*\*Destination\*\*:[ \t]*(.*)$/m);
  if (m === null) return false;
  const stated = m[1].trim();
  // Only absolute values are legacy rows; a relative one is handled by destRes.
  //
  // Absoluteness is judged CROSS-PLATFORM, not with the host's isAbsolute(). An
  // audit ledger is committed, so a row written on Windows is read on Linux and
  // vice versa. Host-native isAbsolute() called on the raw string says `false` for
  // `C:\…\aidlc\…` on Linux (and for `/…/aidlc/…` on Windows), so the legacy row
  // was rejected here — BEFORE the separator normalisation that would have made it
  // comparable — and the event re-emitted a duplicate on the other platform.
  if (stated.length === 0 || !isAbsoluteCrossPlatform(stated)) return false;
  // Compare the PROJECT-RELATIVE TAIL, not the absolute path.
  //
  // Comparing canonical absolute paths only reconciles different SPELLINGS of the
  // same physical location (a symlink alias, a trailing slash). It cannot survive
  // the case this whole change exists for: the project genuinely COPIED or MOVED
  // to a new path, where the old row's absolute prefix no longer exists anywhere.
  // The invariant under a move is the workspace-relative tail
  // (`aidlc/spaces/<space>/memory/<scope>.md`), so that is what is compared —
  // anchored at the `aidlc/` workspace root so a suffix match cannot be satisfied
  // by an unrelated path that merely ends in the same filename.
  // NOTE: the tail alone cannot distinguish "this project at its old path" from "a
  // different project entirely" — every AIDLC workspace ends in the same
  // `aidlc/spaces/<space>/memory/<scope>.md`, so the tails are equal by
  // construction, and no content of the row can tell a copied row from a planted
  // one. Rather than guess at project identity here, the caller enforces the
  // invariant that actually matters: a freshly WRITTEN practice line always gets an
  // event (see writeRulePractice). That makes a false tail match unable to suppress
  // a real emission, while keeping the backward-compatible dedup for a moved or
  // copied project whose practice line is already present.
  const statedTail = workspaceRelativeTail(stated);
  return statedTail !== null && statedTail === workspaceRelativeTail(relDestination);
}

// The `aidlc/...` tail of a destination, or null when there is none. Anchored on
// the LAST `aidlc/` segment boundary so a nested checkout still resolves to the
// innermost workspace. Posix-normalised so a Windows-authored row compares equal.
// Is this path absolute on EITHER platform? A POSIX root (`/…`), a Windows drive
// (`C:\…` / `C:/…`), or a UNC / Windows-style rooted path (`\\server\share`,
// `\dir`). Deliberately host-independent: the ledger it reads is committed and
// travels between platforms, so the host's own path semantics are the wrong
// question to ask of a stored value.
function isAbsoluteCrossPlatform(p: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(p);
}

function workspaceRelativeTail(p: string): string | null {
  const posix = p.split(sep).join("/").replace(/\\/g, "/");
  const idx = posix.lastIndexOf("/aidlc/");
  if (idx !== -1) return posix.slice(idx + 1);
  return posix.startsWith("aidlc/") ? posix : null;
}

// realpath where possible, plain normalisation otherwise.
//
// A destination file — or any directory on its way down — may legitimately not
// exist yet (a fresh practice file in a space that has no memory/ dir), and
// realpathSync throws on the first missing component. So walk UP to the deepest
// ancestor that does resolve and re-attach the remainder. Resolving only the
// immediate parent is not enough: it silently fell back to resolvePath() for a
// not-yet-created memory/ dir, which left the project dir canonicalised while the
// destination was not, so relative() escaped and the "portable" Destination was
// written absolute again.
function canonicalPath(p: string): string {
  const abs = resolvePath(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(cur) : join(realpathSync(cur), ...tail);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // reached the filesystem root, nothing resolved
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

// The portable form of a destination for the audit row: relative to the project
// dir, posix slashes. Falls back to the input when it is not under projectDir
// (nothing in-tree should hit that, but a fabricated path must not throw).
// Computed from the CANONICAL project dir so the recorded value does not vary
// with the path spelling the caller happened to pass to --project-dir.
function auditDestination(projectDir: string, absPath: string): string {
  const rel = relative(canonicalPath(projectDir), canonicalPath(absPath));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return absPath;
  return rel.split(sep).join("/");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// The BODY of a routed heading after stripping any leading `## `/`#`
// decoration — shared by practiceHeading() (which builds the final `## `
// line) and headingRejection() (which validates BEFORE the line is built).
// A single function, called by both, is what makes P2c's fix actually hold:
// validating a hand-rolled COPY of this stripping logic let the copy drift
// from what practiceHeading() does at write time, so a raw value that
// LOOKED non-empty to the validator could still normalise to an empty title
// once practiceHeading() ran its own (different) strip.
function normalizeHeadingBody(raw: string): string {
  const t = raw.trim();
  return t.startsWith("## ") ? t.slice(3) : t.replace(/^#+\s*/, "");
}

// Normalise the orchestrator-routed destination to a `## ` heading. A bare
// "Corrections" and a fully-formed "## Corrections" both resolve to the same
// heading line; an empty/whitespace pick falls back to the default.
function practiceHeading(routed: string | undefined): string {
  const body = normalizeHeadingBody(routed ?? "");
  if (body.trim() === "") return DEFAULT_PRACTICE_HEADING;
  return `## ${body}`;
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

// cid marker — stable, date-/text-independent idempotency key per written
// line. Keyed on (stage slug, candidate id) so a same-day re-run of the
// same selection is a no-op rather than a double-append.
function cidMarker(slug: string, candidateId: string): string {
  return `<!-- cid:${slug}:${candidateId} -->`;
}

// The full trailing annotation this writer appends: the cid marker with the
// learned date carried INSIDE it.
//
// The date used to sit in the visible rule text as `(learned <date>)`, which meant
// reading a stored rule back required guessing where this writer's bookkeeping
// ended and the customer's rule began. Every guess lost, because a practice file is
// hand-editable and a document can produce any shape:
//   * matching our exact template missed hand-authored lines entirely;
//   * stripping any trailing `(...)` ate real parentheticals;
//   * stripping a date-SHAPED `(...)` still ate a rule that genuinely ends in a
//     date in parentheses ("… retained for 90 days (learned 2025-01-15)") — a
//     plausible line to copy out of a policy document.
// Each iteration moved the trigger and kept the bug: a byte-identical replay
// refused, and a genuinely narrower approved rule silently dropped.
//
// So the bookkeeping moves OUT of the rule text and into the HTML comment, which is
// already this writer's private structure. `parsePracticeLine` then splits on the
// marker's own `<!-- cid:` delimiter — a position, not a pattern — and the visible
// rule text is never parsed, guessed at, or stripped. That removes the whole class
// rather than narrowing the trigger again.
function cidAnnotation(slug: string, candidateId: string, learnedDate: string): string {
  return `<!-- cid:${slug}:${candidateId}; learned:${learnedDate} -->`;
}

// Read back the rule text stored on the practice line carrying `marker`.
//
// Marker PRESENCE is not the same question as "is this rule already recorded": two
// different rules arriving under one candidate id look identical to a presence
// check, and the second is then silently dropped at a human approval gate.
//
// PARSED BY POSITION, NEVER BY PATTERN. The rule text is everything between the
// leading `- ` bullet and the start of this writer's own `<!-- cid:` comment. Both
// are delimiters this writer controls, so the customer's rule text is never
// stripped, guessed at, or shape-matched — see cidAnnotation for the three
// successive pattern-matching attempts this replaces, each of which moved the bug
// to a narrower input instead of removing it.
//
// `found: false` means no line carries the marker. `found: true` with `text: null`
// means the line exists but has no readable rule text, which is NOT permission to
// proceed (see the caller).
// INVARIANT: a candidate id match requires the id to end at a real delimiter
// (`;` or whitespace before ` -->`), never merely to be a string prefix of a
// longer stored id. `<slug>:<id>` is followed on every line THIS WRITER emits
// by either `;` (current annotation) or a space then `-->` (legacy
// annotation) — never by another id character — so requiring the next
// character to be `;` or whitespace is sufficient in BOTH directions: a short
// id (`doc-1`) probing a longer stored id (`doc-10`) fails the boundary check,
// and a long id (`doc-10`) probing a shorter stored id (`doc-1`) fails it too
// (`doc-1` line's next char after the full `doc-10` search string would not
// even occur, since the substring itself is absent). A plain
// `.includes(markerStart)` — the bug this closes — matched `doc-1` against a
// stored `doc-10` line, silently dropping the doc-1 candidate.
function markerLineRegex(markerCoreStr: string): RegExp {
  return new RegExp(`<!-- cid:${escapeRegex(markerCoreStr)}(?=[;\\s])`);
}

function findMarkerLine(content: string, markerCoreStr: string): string | undefined {
  const re = markerLineRegex(markerCoreStr);
  return content.split("\n").find((l) => re.test(l) && l.trimStart().startsWith("- "));
}

// The exact trailing-date bookkeeping shape the PRE-UPGRADE writer appended.
// Shared by the read-back below and by the strip performed once an audit row
// confirms it is bookkeeping, so the two can never drift apart.
const LEGACY_LEARNED_SUFFIX_RE = /\s*\(learned \d{4}-\d{2}-\d{2}\)\s*$/;

// `writerConfirmed` is the extra evidence that resolves the ambiguity a bare
// legacy line cannot: an EXACT prior RULE_LEARNED row for this same
// (namespace, candidate id, destination) can only exist if THIS writer
// already recorded an emission for this exact candidate at this exact file —
// the collision guard below refuses every write whose incoming text disagrees
// with what is on disk, so a row's presence is inseparable from "the line
// carrying this marker is the line that row was written for." A hand-edited
// line that happens to carry someone else's candidate id and a coincidental
// trailing date, with NO matching audit row, gets no such confirmation and
// still fails closed exactly as before — this only resolves the case the
// audit trail can actually prove.
function storedPracticeText(
  content: string,
  marker: string,
  writerConfirmed: boolean
): { found: boolean; text: string | null } {
  const markerCoreStr = markerBody(marker);
  const line = findMarkerLine(content, markerCoreStr);
  if (line === undefined) return { found: false, text: null };
  const markerStart = `<!-- cid:${markerCoreStr}`;
  const body = line
    .slice(0, line.indexOf(markerStart))
    .trimStart()
    .replace(/^-\s*/, "")
    .trim();

  // A line in the CURRENT format carries `; learned:` inside the annotation, so its
  // rule text is exactly `body` and is returned verbatim.
  if (line.slice(line.indexOf(markerStart)).includes("; learned:")) {
    return { found: true, text: body.length > 0 ? body : null };
  }

  // A line in the LEGACY format (bare `<!-- cid:… -->`) may carry a trailing
  // `(learned <ISO date>)` that was this writer's bookkeeping — or a date in
  // parentheses that is genuinely part of the rule. Nothing ON THE LINE ITSELF
  // distinguishes them: both are `… (learned 2026-07-01) <!-- cid:… -->` byte for
  // byte. I tried stripping it unconditionally, and that is precisely how the
  // false no-op came back — a narrower approved rule compared equal to the
  // stored one and was dropped. And refusing it unconditionally breaks every
  // pre-upgrade installation's idempotent replay — the format EVERY existing
  // install has on disk, for the ordinary learning-loop `persist` path as much
  // as onboard's.
  //
  // The audit trail is the evidence the line alone lacks: `writerConfirmed`
  // (an exact prior row for this candidate at this destination) proves this
  // writer produced this line, so the trailing date is bookkeeping, and it is
  // stripped rather than refused.
  if (LEGACY_LEARNED_SUFFIX_RE.test(body)) {
    if (writerConfirmed) {
      const stripped = body.replace(LEGACY_LEARNED_SUFFIX_RE, "").trim();
      return { found: true, text: stripped.length > 0 ? stripped : null };
    }
    // No confirming row: the ambiguity this guard cannot resolve is exactly
    // what `text: null` is for. The caller refuses with the "could not be
    // read" remedy, so the operator re-runs with a distinct id or repairs the
    // line. A refusal costs one message; guessing costs an approved rule.
    // Legacy lines WITHOUT a trailing date are unambiguous and compare
    // normally either way, so this only affects the genuinely undecidable case.
    return { found: true, text: null };
  }
  return { found: true, text: body.length > 0 ? body : null };
}

// The `<slug>:<id>` core of a marker, without the comment wrapper or any trailing
// `; learned:<date>`. Lets a lookup match a line whichever annotation form wrote it.
function markerBody(marker: string): string {
  const m = marker.match(/<!-- cid:([^;]*?)\s*(?:;|-->)/);
  return m === null ? marker : m[1].trim();
}

// The Gap-A stage-optional namespace: onboard has no workflow stage, so its
// dedup marker + RULE_LEARNED "Stage" field use this fixed sentinel instead
// of a real stage slug. No shipped stage file is named "aidlc-onboard"
// (core/aidlc-common/stages/), so this can never collide with a genuine
// per-stage learnings_captured aggregation (aidlc-runtime.ts compile groups
// RULE_LEARNED rows by the Stage field verbatim — it never validates the
// value against the stage graph).
export const ONBOARD_RULE_NAMESPACE = "aidlc-onboard";

interface RulePracticeInput {
  // The stage slug for a learning-loop selection, or ONBOARD_RULE_NAMESPACE
  // for a stage-optional onboard rule. Threads into the cid marker + the
  // priorAuditRow lookup + the RULE_LEARNED "Stage" field — the SAME dedup
  // mechanism (cidMarker + namespace), unchanged, per both call sites.
  namespace: string;
  candidateId: string;
  scope: "project" | "team";
  // True for a PRE-WORKFLOW write (onboard): the RULE_LEARNED row is emitted to
  // the SPACE-level audit shard rather than through the active-intent cursor, so
  // the event's identity does not move when the cursor does. See
  // preWorkflowAuditFilePath.
  preWorkflow?: boolean;
  headingRaw: string | undefined;
  text: string;
  source: string;
}

// The Gap-A stage-optional persist CORE — extracted from handlePersist's
// former inline loop body. Writes (or no-ops) one rule practice line into
// practiceFilePath(scope) and emits RULE_LEARNED on a fresh write. Shared,
// unweakened, by both the learning-loop's `persist` (namespace = the
// required stage_slug) and onboard's `persist-rule` (namespace =
// ONBOARD_RULE_NAMESPACE) — practiceFilePath()/cidMarker()/priorAuditRow()
// are the SAME writer + dedup mechanism either way; only the namespace and
// the caller's INPUT SHAPE (stage-coupled selections-json vs. stage-optional
// flags) differ. Must run INSIDE the caller's withAuditLock body — reads
// `auditContent` fresh, mutates the caller's `fileContent` accumulator, and
// calls appendAuditEntryUnlocked (never re-acquires the lock).
// PENDING_ATOMICITY (P1f): the caller commits `auditFields` — via
// appendAuditEntryUnlocked/appendPreWorkflowAuditEntryUnlocked — ONLY after
// every selection in the batch has been validated and computed with no
// throw. writeRulePractice itself is now pure with respect to the audit
// ledger: it never writes to disk. It DOES mutate the caller's `fileContent`
// in-memory accumulator (never the disk), which is what lets several
// selections destined for the SAME practice file see each other's freshly
// appended lines within one batch — see handlePersist's `fileContent` map.
//
// This is the fix for the batch-atomicity gap: a prior version called
// appendAuditEntryUnlocked from INSIDE this function, immediately, while the
// practice FILE flush happened only once after the whole loop. A later
// selection's throw (a genuine candidate-id/text collision, or any other
// validation failure surfaced above) then stranded an EARLIER selection's
// audit row on disk with no corresponding file write ever flushed — the
// audit ledger and the practice file diverged. Returning the audit fields
// instead of writing them means every fallible check for the whole batch
// runs to completion (or throws) BEFORE either side effect touches disk;
// the two commit loops in handlePersist/handlePersistRun that follow can only
// run once nothing is left that could still throw.
function writeRulePractice(
  projectDir: string,
  auditContent: string,
  fileContent: Map<string, string>,
  input: RulePracticeInput
): {
  emitted: boolean;
  alreadyPresent: boolean;
  auditBackfilled: boolean;
  // True iff a NEW practice line was actually appended to the practice file
  // in this call (fresh write, or the recovery re-write of a deleted line).
  // False for a byte-identical no-op replay (the line was already there and
  // is left exactly as it was) and false for an audit-only backfill (the
  // line was already there; only the ledger row was missing). Distinct from
  // `emitted`, which counts the AUDIT event, not the file write — see
  // rule_learned vs. rule_written on the CLI reply (P2e).
  wroteLine: boolean;
  path: string;
  heading: string;
  // The RULE_LEARNED fields to append, or null when no event should be
  // emitted for this selection (no-op / suppressed-by-recovery). The CALLER
  // appends this — after every selection in the batch has been validated —
  // never this function.
  auditFields: Record<string, string> | null;
} {
  const path = practiceFilePath(projectDir, input.scope);
  let content = fileContent.get(path);
  if (content === undefined) {
    content = existsSync(path) ? readFileSync(path, "utf-8") : practiceFileTemplate(input.scope);
  }
  const marker = cidMarker(input.namespace, input.candidateId);
  const today = isoTimestamp().slice(0, 10);
  // The orchestrator (learning-loop) or the onboard gate (onboard) routes the
  // rule to the fitting practice heading (KNOWLEDGE); normalise +
  // ensure-exists it before the append.
  const heading = practiceHeading(input.headingRaw);

  // Scoped to THIS destination so the audit dedup and the practice-line dedup
  // ask the same question — see priorAuditRow.
  // Match on the PROJECT-RELATIVE destination. An absolute path makes the dedup
  // key machine-specific, so a clone or move re-emits the event — the exact
  // portability this feature is about. The committed fixture
  // (tests/fixtures/v05-mr12-learnings/audit-learnings-captured.md) already
  // records the relative form, so this is the established shape.
  const relDestination = auditDestination(projectDir, path);
  const incomingDigest = sha256Hex(input.text.trim());
  const priorRow = priorAuditRow(
    auditContent,
    "RULE_LEARNED",
    input.namespace,
    input.candidateId,
    relDestination, // also used to tail-match an older row's absolute Destination
    incomingDigest
  );
  // Presence is tested on the `<slug>:<id>` core, so a line written by EITHER
  // annotation form counts — an older `<!-- cid:… -->` alongside a visible
  // `(learned <date>)`, or the current `<!-- cid:…; learned:<date> -->`. Testing the
  // full new annotation would read every previously-written line as absent and
  // append a duplicate.
  //
  // Boundary-checked, not a bare substring test — see markerLineRegex. A plain
  // `.includes()` here matched a SHORT candidate id (`doc-1`) against a
  // longer stored one (`doc-10`) and silently dropped the shorter candidate's
  // approved write, which is exactly the class this shares with
  // storedPracticeText's own lookup below.
  const hasLine = findMarkerLine(content, markerBody(marker)) !== undefined;

  // A marker that already exists must carry the SAME rule text, or this write is
  // not the idempotent re-run it looks like — it is a DIFFERENT rule arriving
  // under a colliding id, and continuing would drop it.
  //
  // Candidate ids are assigned by the caller (onboard's recipe is
  // `<manifest-id>-<n>`, an ordinal over an LLM-produced candidate list), so a
  // rerun that reorders or revises candidates can legitimately reuse `-1` for a
  // different rule. Checking only marker presence then reports `rule_learned: 0,
  // already_present: true` — a success shape — while the approved rule is never
  // written. That is silent data loss at a HUMAN APPROVAL gate: the operator saw
  // the rule, approved it, and the tool said fine. Refusing loudly is the only
  // safe answer; the caller re-runs with a distinct id.
  //
  // FAIL CLOSED WHEN THE STORED TEXT CANNOT BE ESTABLISHED. "I could not parse
  // the existing line" is the same epistemic state as "the existing line says
  // something else" — in both cases this write cannot be shown to be the
  // idempotent re-run it would report itself as. Treating unparseable as
  // permission-to-proceed reintroduced the exact drop this guard prevents, for
  // every hand-edited or older-template line in a committed, human-editable file.
  if (hasLine) {
    // A prior audit row for this (namespace, candidate id, destination) —
    // `exact` OR the backward-compatible `legacyOnly` tail match — is the
    // evidence that THIS writer produced the line: see storedPracticeText's
    // `writerConfirmed` parameter. A row written by the BASE (pre-upgrade)
    // writer stores an absolute Destination, which only ever matches via the
    // legacy tail heuristic, never `exact` — so `exact` alone would leave every
    // pre-upgrade install unable to replay. `.found` covers both.
    const stored = storedPracticeText(content, marker, priorRow.found);
    if (stored.text === null) {
      throw new Error(
        `Candidate id "${input.candidateId}" already appears in ${auditDestination(projectDir, path)}, ` +
          `but its existing rule text could not be read (the line may have been hand-edited).\n` +
          `  incoming:  ${input.text}\n` +
          `Refusing to write: this cannot be confirmed as a re-run of the same rule, and reporting ` +
          `success would drop the incoming rule. Re-run with a candidate id unique to this rule text, ` +
          `or repair that line in the practice file.`
      );
    }
    // Compared TRIMMED. `storedPracticeText` already trims what it reads back, and
    // the writer's own append is surrounded by literal spaces, so leading/trailing
    // whitespace on the incoming text is a transport artefact (a `--text-file` ending
    // in a space) rather than a different rule. Comparing untrimmed refused a replay
    // that differed only by that. Interior whitespace is NOT normalised — "Rule  A"
    // and "Rule A" are different text and are treated as such.
    if (stored.text !== input.text.trim()) {
      throw new Error(
        `Candidate id "${input.candidateId}" is already recorded in ${auditDestination(projectDir, path)} ` +
          `with DIFFERENT text.\n  stored:    ${stored.text}\n  incoming:  ${input.text}\n` +
          `Refusing to write: continuing would report success while dropping the incoming rule. ` +
          `Re-run with a candidate id that is unique to this rule text.`
      );
    }
  } else if (priorRow.exact && !priorRow.digestConfirmed) {
    // INVARIANT: a candidate id's audit identity is bound to the TEXT it was
    // written for, not merely to the id. The comparison above only runs
    // `if (hasLine)` — when the practice LINE is missing (deleted, or never
    // written) but an EXACT prior row still claims this destination, this is
    // the other half of the SAME collision the `hasLine` branch guards: a
    // caller can present ANY text under a candidate id whose row survives with
    // no line to compare against, and the old code wrote it with NO new audit
    // row (the exact-match branch below suppresses a second emission,
    // reading this as "recovery"). That is silent data loss at a human
    // approval gate with no trace in the ledger — worse than the `hasLine`
    // case, because there the collision at least surfaces on stdout.
    //
    // `Text-Digest` on the row is the extra evidence a bare marker can never
    // carry once its line is gone: it proves what text the row was originally
    // emitted for. An exact-destination row whose digest does not match the
    // incoming text (including a PRE-DIGEST row that carries no Text-Digest
    // field at all — an unconfirmable claim is not confirmation) fails closed.
    // A row that DOES match is the legitimate recovery case t97 pins: the
    // line is rewritten below with NO second audit row.
    throw new Error(
      `Candidate id "${input.candidateId}" already has a RULE_LEARNED row recorded at ` +
        `${auditDestination(projectDir, path)}, but its practice line is missing and the row's ` +
        `recorded text does not match the incoming text (or the row predates text tracking).\n` +
        `  incoming:  ${input.text}\n` +
        `Refusing to write: this cannot be confirmed as a re-write of the row's original rule, and ` +
        `writing it would leave no matching audit event. Re-run with a candidate id unique to this ` +
        `rule text, or restore the original practice line before retrying.`
    );
  }

  // Write the line unless it is already present (recovery: row exists, line
  // missing → write only; fresh: neither → write + emit; no-op: both present
  // → the flush below re-writes byte-identical content).
  if (!hasLine) {
    content = ensureHeading(content, heading);
    // Trimmed, matching the comparison above. Writing untrimmed text would store a
    // line whose read-back (which trims) could never equal its own input on replay.
    // The learned date rides INSIDE the annotation, so the visible rule text is
    // exactly what was approved and nothing has to be stripped to read it back.
    const line = `- ${input.text.trim()} ${cidAnnotation(input.namespace, input.candidateId, today)}\n`;
    content = appendUnderHeading(content, heading, line);
  }
  fileContent.set(path, content);

  let emitted = false;
  let auditFields: Record<string, string> | null = null;
  // Emit when no prior row was found, OR when the only thing that matched was the
  // LEGACY TAIL HEURISTIC and this call actually wrote a new line.
  //
  // The second clause closes a silent ledger gap. A legacy-destination match is
  // necessarily a guess: every AIDLC workspace ends in the same
  // `aidlc/spaces/<space>/memory/<scope>.md`, so an unrelated project's row matches
  // this project's tail. When that false positive coincided with a genuinely NEW
  // practice line, the line was written and NO event recorded — a rule missing from
  // the audit trail, which is the one thing that trail exists to prevent. A
  // duplicate row is recoverable; a missing row is not.
  //
  // Scoped to `legacyOnly` on purpose. An EXACT destination match plus a missing
  // line is the legitimate RECOVERY case (the row is provably ours, the line was
  // deleted): re-write the line, do NOT emit a second row. t97 pins that.
  //
  // The mirror case — line already present, NO audit row at all — is an audit
  // BACKFILL: a hand-authored practice line carrying a cid marker that the ledger
  // never recorded. Emitting is right (a rule with no ledger row is the
  // unrecoverable direction), and it converges: the row exists from then on, so
  // subsequent runs are clean no-ops. `audit_backfilled` below reports it as its
  // own state so it is not confused with the collision bug, whose signature is the
  // same two flags.
  //
  // NOT APPENDED HERE (see the PENDING_ATOMICITY comment above the function
  // signature) — only COMPUTED and returned. The caller appends it only after
  // the whole batch is known to complete without a throw, so an earlier
  // selection's event can never be stranded on disk by a later selection's
  // refusal.
  if (!priorRow.found || (priorRow.legacyOnly && !hasLine)) {
    auditFields = {
      Stage: input.namespace,
      "Candidate-ID": input.candidateId,
      Destination: relDestination,
      Heading: heading,
      Source: input.source,
      // Recorded so a FUTURE read — after this line may have been deleted —
      // can prove what text this row was written for (see the
      // `priorRow.digestConfirmed` check above). A row with no Text-Digest
      // (every row an EARLIER build wrote) is treated as unconfirmable, never
      // as a wildcard match — see priorAuditRow's `digestConfirmed` default.
      "Text-Digest": incomingDigest,
    };
    emitted = true;
  }
  // `alreadyPresent` lets a caller tell "this rule was already in this file" from
  // "a fresh line was written" — a no-op that reports like a success is
  // indistinguishable from silent data loss at the gate.
  //
  // `auditBackfilled` disambiguates the one combination that would otherwise read
  // as that data-loss signature: an event emitted for a line that was ALREADY
  // there. That is a ledger backfill for a hand-authored line, not a dropped rule.
  return {
    emitted,
    alreadyPresent: hasLine,
    auditBackfilled: emitted && hasLine,
    wroteLine: !hasLine,
    path,
    heading,
    auditFields,
  };
}

// Commit the audit fields writeRulePractice computed but did not append.
// Called by the CALLER once every selection in a batch has succeeded — see
// the PENDING_ATOMICITY comment on writeRulePractice.
function commitRuleAudit(
  projectDir: string,
  preWorkflow: boolean | undefined,
  fields: Record<string, string>
): void {
  // A pre-workflow row is pinned to the space-level shard so its identity does
  // not follow the active-intent cursor; a learning-loop row belongs to the
  // stage's intent and resolves normally.
  if (preWorkflow === true) {
    appendPreWorkflowAuditEntryUnlocked("RULE_LEARNED", fields, projectDir);
  } else {
    appendAuditEntryUnlocked("RULE_LEARNED", fields, projectDir);
  }
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
  const stageSlug = slug ?? selFile.stage_slug;

  // ONE withAuditLock body — decide-inside-lock (plan §0.4). Re-read the
  // audit fresh INSIDE the lock; never reuse a pre-lock read.
  let lockResult: { rule_learned: number; sensor_proposed: number; bound_stages: string[] };
  try {
    lockResult = withAuditLock(projectDir, () => {
      // Read across every per-clone audit shard (single shard in the common case).
      const auditContent = readAllAuditShards(projectDir);

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

      // INVARIANT: within one persist call, the audit rows this call appends
      // and the practice lines it writes land TOGETHER or not at all -- never
      // a partial batch where an earlier selection's audit row exists with no
      // matching line, or two rows exist for one line.
      //
      // TWO INDEPENDENT ways for a batch to reach that state, and both must
      // be closed -- closing only one still leaves the other open:
      //
      //   (a) an IN-BATCH duplicate candidate id. `auditContent` is read ONCE
      //       before the loop, so writeRulePractice's own duplicate-id
      //       detection (which reads audit rows to decide "already emitted")
      //       is blind to a row this SAME BATCH would append two iterations
      //       later. Closed below by validating uniqueness (per destination)
      //       BEFORE any selection in the batch is even computed -- same
      //       discipline as capture's "reject the whole batch" invariant.
      //
      //   (b) a collision against a PRE-EXISTING row (a candidate id already
      //       recorded from an EARLIER persist call, now reused in this batch
      //       for different text). Rejecting (a) does not touch this case: no
      //       id repeats WITHIN this selections-json, yet writeRulePractice
      //       still throws on the colliding selection. If any EARLIER
      //       selection in the loop had already committed its audit row to
      //       disk by that point, that row would be stranded with no
      //       practice-file write ever flushed behind it -- even though every
      //       id in the batch was locally unique.
      //
      // The fix for (b) is a TRANSACTION, not another pre-check: run every
      // selection's writeRulePractice call to completion (validating,
      // computing, accumulating in-memory) with the audit-ledger fields
      // RETURNED rather than appended -- see writeRulePractice's
      // PENDING_ATOMICITY comment. Only once the ENTIRE loop below has
      // finished with no throw are the practice files flushed and the
      // collected audit fields committed, in that order, both still inside
      // this same withAuditLock body. A throw partway through the collection
      // loop leaves nothing on disk at all: no file flushed, no audit row
      // appended, because both commit loops run strictly AFTER it.
      const seenDestKeys = new Map<string, string>();
      for (const sel of learnings) {
        const destKey = `${sel.scope} ${sel.candidate_id}`;
        const prior = seenDestKeys.get(destKey);
        if (prior !== undefined) {
          fail(
            `persist batch rejected: candidate id "${sel.candidate_id}" (scope: ${sel.scope}) ` +
              `appears more than once in this selections-json. A repeated candidate id in one batch ` +
              `cannot be committed atomically -- split it into a distinct id per rule, or remove the ` +
              `duplicate, and re-run.`,
            1
          );
        }
        seenDestKeys.set(destKey, sel.candidate_id);
      }

      // Bucket destination files; the SHARED Gap-A writer (writeRulePractice)
      // loads (or templates) each destination once via this accumulator and
      // flushes it below.
      const fileContent = new Map<string, string>();
      // Audit fields collected across the loop, committed only after every
      // selection has succeeded -- see the INVARIANT comment above.
      const pendingAuditFields: Record<string, string>[] = [];

      for (const sel of learnings) {
        const { emitted, auditFields } = writeRulePractice(projectDir, auditContent, fileContent, {
          namespace: stageSlug,
          candidateId: sel.candidate_id,
          scope: sel.scope,
          headingRaw: sel.heading,
          text: sel.text,
          source: sel.source ?? "orchestrator",
        });
        if (emitted && auditFields !== null) {
          pendingAuditFields.push(auditFields);
          ruleLearned++;
        }
      }

      // Flush each method file once (atomic), THEN commit the audit rows --
      // both only after the whole loop above completed with no throw.
      for (const [path, content] of fileContent) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileAtomic(path, content);
      }
      for (const fields of pendingAuditFields) {
        commitRuleAudit(projectDir, false, fields);
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

        const priorSensorRow = priorAuditRow(
          auditContent,
          "SENSOR_PROPOSED",
          stageSlug,
          sel.candidate_id
        );
        const hasManifest = existsSync(manifestPath);

        if (priorSensorRow.found && hasManifest) {
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

        if (!priorSensorRow.found) {
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
            projectDir
          );
          sensorProposed++;
        }
      }

      return {
        rule_learned: ruleLearned,
        sensor_proposed: sensorProposed,
        bound_stages: boundStages,
      };
    });
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

// --- persist-rule (the stage-optional rule entry) -------------------------
//
// persist-rule --scope <project|team> --candidate-id <id> --text <text>
//   [--heading <heading>] [--source <str>] [--project-dir <path>]
//
// The STAGE-OPTIONAL sibling of `persist`: no `stage_slug` anywhere on this
// path (no selections-json, no --slug flag) — onboard is pre-workflow, so
// there is no active stage to require. Reuses the SAME writer
// (writeRulePractice → practiceFilePath()) and the SAME dedup mechanism
// (cidMarker + priorAuditRow) as the learning loop, namespaced under
// ONBOARD_RULE_NAMESPACE instead of a stage slug. Scope is project/team
// ONLY — no org tier (stage-protocol.md "no org tier, no widen-to-org path");
// an org (or any other) value is a hard argument-validation failure, not a
// silent coercion.
//
// INPUT VALIDATION IS LOAD-BEARING HERE. The learning loop's `--text` comes
// from the conductor; onboard's comes from a customer-supplied document, so this
// entry point takes untrusted text even though it shares the writer. Both
// injections below are validated at this boundary, not deeper:
//   * a newline in --text splits one approved rule into two practice bullets,
//     the first carrying no cid marker — invisible to dedup and not undoable by
//     re-running;
//   * document text containing a `<!-- cid:… -->` marker pre-suppresses that
//     candidate id, so a later legitimate write emits its audit row and writes
//     nothing.
// A candidate id becomes part of that marker, so it is held to a bare
// identifier shape.
//
// THE SHELL IS THE OTHER BOUNDARY, AND VALIDATION HERE CANNOT DEFEND IT. When a
// harness runs `persist-rule --text "<document text>"`, the shell expands
// `$(…)` and backticks in that text BEFORE this process starts — no check
// inside the tool can see, let alone stop, that. `--text-file <path>` is the
// answer: the caller writes the ONE approved rule line with its file-write tool
// (never a shell heredoc) and passes only the PATH, so untrusted bytes reach
// this tool through a file read, where they are inert. Same single-rule shape
// either way — only the transport differs.
const CANDIDATE_ID_REGEX = /^[A-Za-z0-9._-]+$/;
const CID_MARKER_PREFIX = "<!-- cid:";

// A practice heading is a short markdown title, optionally with a leading `## `.
// SKILL.md routes it from what the customer's DOCUMENT "clearly names", so it is
// document-influenced content and must be validated — but validated against what
// can actually cause harm, which is narrower than it first appears:
//
//   * the value reaches this tool through `--heading-file`, so the shell never
//     expands it;
//   * ensureHeading()/appendUnderHeading() regex-ESCAPE it before it enters a
//     pattern, so regex metacharacters are inert;
//   * it is written into a markdown file, where the only structural hazards are a
//     line break (which could forge a second heading or an untracked bullet) and
//     the cid marker syntax (which would pre-suppress a candidate id).
//
// An ASCII allowlist over-rejected: it refused `Security: IAM` (a colon) and every
// non-ASCII heading such as `Sécurité`, so a legitimate rule was filed under the
// wrong heading or not at all. The replacement is a DENYLIST of the genuine
// hazards plus a length cap — Unicode letters, marks and ordinary punctuation pass.
//
// SHELL-METACHARACTER PAYLOADS ARE STILL REFUSED, deliberately. File transport
// means the shell never expands them here, so this is not the control that
// prevents execution — but a heading is a short human title, and a value carrying
// a command substitution is either an attack or a mistake. Both deserve a loud
// refusal rather than a heading that quietly carries a payload into a COMMITTED
// file that other tools read (defence in depth, not the primary boundary).
const HEADING_MAX_LENGTH = 120;

// The SUBSTITUTION/CHAINING metacharacters only — the ones that could turn a
// heading into a command if some downstream consumer ever interpolated it. Kept
// deliberately narrow: `&`, `()` and `/` are ordinary in real headings
// (`Data & Privacy`, `Testing (CI)`, `CI/CD`) and cannot substitute or chain on
// their own, and the old allowlist already permitted them. Refusing those was
// the same over-rejection this change exists to remove.
const HEADING_SHELL_METACHARS = /[`$\\|;<>"']/;

// The validated `body` is computed by the SAME normalizeHeadingBody()
// practiceHeading() itself calls at write time — not a hand-rolled copy of
// the stripping logic — or a raw value that LOOKS non-empty here can still
// normalise to an empty title there. This is what closed P2c: the previous
// `body` here only stripped a literal leading `"## "`, so `--heading '###'`
// (three hashes, no space) fell through untouched, passed every check below,
// and only THEN reached practiceHeading()'s OWN strip
// (`replace(/^#+\s*/, "")`), which removes every leading `#` and following
// whitespace and leaves an empty title (`heading: "## "` on the reply). The
// symmetric case is a bare `"##"` with no space at all. Sharing one function
// between validation and the write is what makes "must not be empty"
// actually reachable for every input that normalises to nothing.
function headingRejection(raw: string): string | null {
  const body = normalizeHeadingBody(raw);
  if (body.trim() === "") return "must not be empty";
  if (body.length > HEADING_MAX_LENGTH) {
    return `must be at most ${HEADING_MAX_LENGTH} characters (got ${body.length})`;
  }
  // Control characters — a newline/CR would split one heading into two lines and
  // let the second forge a heading or an untracked bullet.
  // Tested by CODEPOINT rather than a character class: a regex holding literal
  // control characters is both unreadable and a lint error.
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return "must not contain control characters or line breaks";
    }
  }
  if (body.includes(CID_MARKER_PREFIX)) {
    return `must not contain "${CID_MARKER_PREFIX}" (the dedup marker syntax)`;
  }
  if (HEADING_SHELL_METACHARS.test(body)) {
    return "must not contain the shell substitution characters ` $ \\ | ; < > \" '";
  }
  // A leading list marker would render the heading as a list item.
  if (/^[-*+]/.test(body.trim())) return "must not begin with a markdown list marker";
  return null;
}

// Read a single-line value from a file. Trailing newlines are stripped (a file
// written by an editor or a file-write tool almost always ends in one, and that
// is not the author asking for two bullets); an INTERIOR newline in rule text is
// still rejected below, because it would split one approved rule into two.
function readValueFile(flag: string, path: string): string {
  if (!existsSync(path)) fail(`${flag} not found: ${path}`, 1);
  try {
    return readFileSync(path, "utf-8").replace(/\r?\n+$/, "");
  } catch (e) {
    fail(`could not read ${flag}: ${errorMessage(e)}`, 1);
  }
}

function handlePersistRule(args: string[], projectDir: string): void {
  const flags = parseFlags(args);
  const scopeRaw = flags.scope;
  // --candidate-id is built from the manifest's sha256 id, which is a
  // committed, network-borne value. Same file-transport discipline as text/
  // source/heading: if a value comes from a committed ledger, it does not go on
  // a command line. CANDIDATE_ID_REGEX is defence in depth for the file path.
  const cidFile = flags["candidate-id-file"];
  if (flags["candidate-id"] !== undefined && cidFile !== undefined) {
    fail("persist-rule takes EITHER --candidate-id OR --candidate-id-file, not both.", 2);
  }
  const candidateId = cidFile !== undefined ? readValueFile("--candidate-id-file", cidFile) : flags["candidate-id"];
  const textFile = flags["text-file"];
  if (flags.text !== undefined && textFile !== undefined) {
    fail("persist-rule takes EITHER --text OR --text-file, not both.", 2);
  }
  const text = textFile !== undefined ? readValueFile("--text-file", textFile) : flags.text;
  // `--source` is provenance for the audit row, and for onboard its value is a
  // captured file's PATH — which is just as unsafe to interpolate as the text
  // was. A POSIX filename may contain a single quote, so `--source '<path>'`
  // is not escaped by the quotes: the quote closes and the rest of the filename
  // becomes shell. `--source-file` gives paths the same file-borne transport
  // `--text-file` gives text, so nothing untrusted reaches a command line.
  const sourceFile = flags["source-file"];
  if (flags.source !== undefined && sourceFile !== undefined) {
    fail("persist-rule takes EITHER --source OR --source-file, not both.", 2);
  }
  // `--heading` is document-influenced too (SKILL.md routes it from the content),
  // so it gets the same file transport as the text and the source path. Closing
  // one flag at a time is what turned this into five review rounds — every value
  // the skill derives from a document must have a way to travel that is not argv.
  const headingFile = flags["heading-file"];
  if (flags.heading !== undefined && headingFile !== undefined) {
    fail("persist-rule takes EITHER --heading OR --heading-file, not both.", 2);
  }
  const heading =
    headingFile !== undefined ? readValueFile("--heading-file", headingFile) : flags.heading;
  if (heading !== undefined) {
    const rejection = headingRejection(heading);
    if (rejection !== null) {
      fail(
        `Invalid heading ${JSON.stringify(heading)}: a practice heading ${rejection}. ` +
          `Pass a short markdown title, optionally prefixed "## ".`,
        2
      );
    }
  }
  if (!scopeRaw || !candidateId || !text) {
    fail(
      "Usage: aidlc-learnings.ts persist-rule --scope <project|team> (--candidate-id <id> | --candidate-id-file <path>) (--text <text> | --text-file <path>) [--heading <h> | --heading-file <path>] [--source <str> | --source-file <path>] [--project-dir <path>]\n" +
        "Use the *-file variants for any document-derived or ledger-derived value: none puts untrusted bytes on a shell command line.",
      1
    );
  }
  if (scopeRaw !== "project" && scopeRaw !== "team") {
    fail(`Invalid --scope "${scopeRaw}": must be "project" or "team" (no org tier for onboard rules)`, 2);
  }
  if (!CANDIDATE_ID_REGEX.test(candidateId)) {
    fail(
      `Invalid --candidate-id "${candidateId}": must match ${CANDIDATE_ID_REGEX.source} (it becomes part of the dedup marker).`,
      2
    );
  }
  if (/[\r\n]/.test(text)) {
    fail(
      "Invalid rule text: a rule is ONE practice line, so it must not contain a newline (a newline would split it into two bullets, the second untracked by dedup).",
      2
    );
  }
  // Validated on the NORMALIZED (trimmed) text, the same trim writeRulePractice
  // itself applies before storing (`input.text.trim()`). `!text` above only
  // catches a literally EMPTY string — a `--text-file` holding whitespace-only
  // bytes ("   ", or a lone blank line) is truthy and fell through untouched,
  // so the write proceeded and stored a bullet with no rule text at all
  // (`-  <!-- cid:… -->`). That empty line could then never be replayed: its
  // read-back text is null, which storedPracticeText treats as unparseable and
  // the P1b/P1c guard refuses every future write under that candidate id. Fail
  // BEFORE any write, on the same normalisation the writer performs, so this
  // state can never reach disk.
  if (text.trim() === "") {
    fail("Invalid rule text: must not be empty or whitespace-only.", 2);
  }
  if (text.includes(CID_MARKER_PREFIX)) {
    fail(
      `Invalid rule text: must not contain "${CID_MARKER_PREFIX}" (the dedup marker syntax) — that would suppress a future candidate id.`,
      2
    );
  }
  // `--space` is not threaded on this path: the practice file follows the
  // ACTIVE-SPACE cursor (practiceFilePath → memoryDirFor). Absorbing the flag
  // silently would land an `--space acme` rule in `default`, so it is rejected
  // with the remedy rather than ignored.
  if (flags.space !== undefined) {
    fail(
      "persist-rule does not accept --space: the rule lands in the ACTIVE space (memoryDirFor follows the active-space cursor). Switch spaces first (/aidlc space <name>), then persist.",
      2
    );
  }
  const scope: "project" | "team" = scopeRaw;
  const source =
    sourceFile !== undefined
      ? readValueFile("--source-file", sourceFile)
      : (flags.source ?? "onboard");

  let result: {
    emitted: boolean;
    alreadyPresent: boolean;
    auditBackfilled: boolean;
    wroteLine: boolean;
    path: string;
    heading: string;
  };
  try {
    result = withAuditLock(projectDir, () => {
      const auditContent = readPreWorkflowAuditSurface(projectDir);
      const fileContent = new Map<string, string>();
      const written = writeRulePractice(projectDir, auditContent, fileContent, {
        namespace: ONBOARD_RULE_NAMESPACE,
        candidateId,
        scope,
        preWorkflow: true,
        headingRaw: heading,
        text,
        source,
      });
      // Flush the practice file BEFORE committing the audit row — same
      // ordering discipline as handlePersist's batch, even though a single
      // persist-rule call has no in-batch collision to strand. Skipped
      // entirely on a throw above: writeRulePractice never appends to disk
      // itself (see its PENDING_ATOMICITY comment), so a validation failure
      // here leaves neither side effect behind.
      for (const [path, content] of fileContent) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileAtomic(path, content);
      }
      if (written.auditFields !== null) {
        commitRuleAudit(projectDir, true, written.auditFields);
      }
      return written;
    });
  } catch (e) {
    const msg = errorMessage(e);
    if (/Failed to acquire audit lock/.test(msg)) {
      fail(
        `${msg}. The audit lock dir may be orphaned by a hard-killed run; ` +
          `remove it manually (look under the system temp dir for the aidlc audit lock) and retry.`,
        1
      );
    }
    // A candidate-id collision is a caller-input problem with a specific remedy,
    // so it reports as an argument failure (exit 2) with its own message intact
    // rather than being flattened into the generic runtime wrapper.
    if (
      /is already recorded in .* with DIFFERENT text/s.test(msg) ||
      /existing rule text could not be read/s.test(msg) ||
      /practice line is missing and the row's recorded text does not match/s.test(msg)
    ) {
      fail(msg, 2);
    }
    fail(`persist-rule failed: ${msg}`, 1);
  }

  console.log(
    JSON.stringify({
      scope,
      candidate_id: candidateId,
      destination: result.path,
      heading: result.heading,
      // `rule_learned` counts the AUDIT EVENT — it has ALWAYS meant "a
      // RULE_LEARNED row was appended this call", not "a line was written".
      // That is why a ledger BACKFILL (the line pre-existed; only the row was
      // missing) reports `rule_learned: 1` even though no line changed, and
      // why the legitimate RECOVERY re-write of a deleted line (t97) reports
      // `rule_learned: 0` even though the line WAS rewritten — the exact row
      // already exists, so re-emitting it would duplicate the ledger, not
      // repair it. `rule_written` (below) is the answer to the OTHER
      // question — "did a practice line change on disk this call" — which
      // `rule_learned` was never able to answer on its own. See the state
      // table in core/skills/aidlc-onboard/SKILL.md Step 5.
      rule_learned: result.emitted ? 1 : 0,
      // 1 iff a practice line was actually appended/rewritten in THIS call:
      // 1 on a fresh write and on the recovery re-write of a deleted line;
      // 0 on a byte-identical no-op replay and on an audit-only backfill
      // (the line was already there; only the ledger row was missing).
      rule_written: result.wroteLine ? 1 : 0,
      // Distinguishes an idempotent re-run from a fresh write so the caller can
      // report the difference instead of treating a no-op as a success.
      already_present: result.alreadyPresent,
      // True only for a ledger BACKFILL: the practice line already existed (a
      // hand-authored rule carrying a cid marker) and this call recorded the
      // missing RULE_LEARNED for it. Without this field, `rule_learned: 1` with
      // `already_present: true` is indistinguishable from the candidate-id
      // collision bug, whose signature is exactly those two flags.
      audit_backfilled: result.auditBackfilled,
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
    path.includes(join("dist", "opencode", ".aidlc", "sensors"))
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
      "  persist-rule --scope <project|team>",
      "      (--candidate-id <id> | --candidate-id-file <path>)",
      "      (--text <text> | --text-file <path>)",
      "      [--heading <h> | --heading-file <path>]",
      "      [--source <str> | --source-file <path>]",
      "      [--project-dir <path>]",
      "      Stage-optional entry: write ONE rule practice line with no",
      "      stage_slug (the /aidlc-onboard caller). Same writer + dedup as",
      "      persist, namespaced under ONBOARD_RULE_NAMESPACE. project/team",
      "      scope only — no org tier. Use the *-file variants for any",
      "      document-derived value (text, source path, heading): only a path",
      "      reaches the command line, so the shell never expands untrusted bytes.",
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
    fail("Usage: aidlc-learnings.ts <surface|persist|persist-rule|--help>", 2);
  }

  const projectDir = resolveProjectDir(projectDirArg);

  switch (cmd) {
    case "surface":
      handleSurface(subargs, projectDir);
      break;
    case "persist":
      handlePersist(subargs, projectDir);
      break;
    case "persist-rule":
      handlePersistRule(subargs, projectDir);
      break;
    default:
      fail(`Unknown subcommand: ${cmd}. Run aidlc-learnings.ts --help for usage.`, 2);
  }
}

if (import.meta.main) main(process.argv.slice(2));
