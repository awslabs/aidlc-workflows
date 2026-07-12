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

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import { memoryDirFor } from "./aidlc-graph.ts";
import {
  appendUnderHeading,
  errorMessage,
  findAllEvents,
  getField,
  isoTimestamp,
  parseMemoryEntries,
  readAllAuditShards,
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
function priorAuditRow(
  auditContent: string,
  event: "RULE_LEARNED" | "SENSOR_PROPOSED",
  slug: string,
  candidateId: string
): boolean {
  const rows = findAllEvents(auditContent, event);
  const stageRe = new RegExp(`^\\*\\*Stage\\*\\*:\\s*${escapeRegex(slug)}\\s*$`, "m");
  const cidRe = new RegExp(`^\\*\\*Candidate-ID\\*\\*:\\s*${escapeRegex(candidateId)}\\s*$`, "m");
  return rows.some((r) => stageRe.test(r.block) && cidRe.test(r.block));
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

// cid marker — stable, date-/text-independent idempotency key per written
// line. Keyed on (stage slug, candidate id) so a same-day re-run of the
// same selection is a no-op rather than a double-append.
function cidMarker(slug: string, candidateId: string): string {
  return `<!-- cid:${slug}:${candidateId} -->`;
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

      // Bucket destination files; load (or template) each once. ensureFile
      // returns { path, content } so callers never re-fetch from the Map.
      const fileContent = new Map<string, string>();
      const ensureFile = (scope: "project" | "team"): { path: string; content: string } => {
        const path = practiceFilePath(projectDir, scope);
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
        const bucket = ensureFile(sel.scope);
        const path = bucket.path;
        let content = bucket.content;
        const marker = cidMarker(stageSlug, sel.candidate_id);
        const today = isoTimestamp().slice(0, 10);
        const source = sel.source ?? "orchestrator";
        // The orchestrator routes the learning to the fitting practice heading
        // (KNOWLEDGE); normalise + ensure-exists it before the append.
        const heading = practiceHeading(sel.heading);

        const hasRow = priorAuditRow(auditContent, "RULE_LEARNED", stageSlug, sel.candidate_id);
        const hasLine = content.includes(marker);

        // no-op: audit row AND line both present.
        if (hasRow && hasLine) continue;

        // Write the line unless it is already present (recovery: row exists,
        // line missing → write only; fresh: neither → write + emit). Create the
        // routed heading first when the method file doesn't carry it.
        if (!hasLine) {
          content = ensureHeading(content, heading);
          const line = `- ${sel.text} (learned ${today}) ${marker}\n`;
          content = appendUnderHeading(content, heading, line);
          fileContent.set(path, content);
        }

        // Emit only when this is fresh (no prior audit row).
        if (!hasRow) {
          appendAuditEntryUnlocked(
            "RULE_LEARNED",
            {
              Stage: stageSlug,
              "Candidate-ID": sel.candidate_id,
              Destination: path,
              Heading: heading,
              Source: source,
            },
            projectDir
          );
          ruleLearned++;
        }
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

        const hasRow = priorAuditRow(
          auditContent,
          "SENSOR_PROPOSED",
          stageSlug,
          sel.candidate_id
        );
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
