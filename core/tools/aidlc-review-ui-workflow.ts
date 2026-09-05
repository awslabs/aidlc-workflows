import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import {
  artifactFilename,
  artifactFormat,
  artifactKind,
  type ArtifactFormat,
  type ArtifactKind,
} from "./aidlc-artifact-vocabulary.ts";
import {
  activeIntent,
  activeSpace,
  artifactFormatsFromState,
  auditBlockField,
  docsRoot,
  getField,
  humanTurnMarkerPath,
  listIntentDirs,
  loadScopeMapping,
  loadStageGraphAll,
  parseCheckboxes,
  parseStateStageSuffixes,
  readAuditShardEvents,
  readIntentRegistry,
  readStateFile,
  recordDir,
  recordDirMatches,
  spacesRoot,
  type AuditShardEvent,
  type IntentRegistryEntry,
  type StageEntry,
} from "./aidlc-lib.ts";
import { checkGuideArtifact } from "./aidlc-html.ts";
import {
  listFeedbackFiles,
  readConsumed,
  readCurrentPointer,
  readManifest,
  stageReviewUiDir,
  type CurrentPointer,
  type FeedbackRemarkKind,
  type ReviewManifest,
} from "./aidlc-review-ui-shared.ts";
import { parseQuestionsMarkdown } from "./aidlc-review-ui-render.ts";

export type WorkflowStageState = "done" | "current" | "skipped" | "next" | "conditional" | "pending";
export type WorkflowIntentStatus = "needs-you" | "in-progress" | "done" | "idle";

export interface WorkflowArtifact {
  name: string;
  path: string;
  exists: boolean;
  format: ArtifactFormat;
  kind: ArtifactKind;
  revision: number | null;
  threads: number;
  produces: boolean;
}

export interface WorkflowQuestions {
  file: string;
  answered: number;
  total: number;
  open: boolean;
  guide: boolean;
}

export interface WorkflowStage {
  slug: string;
  name: string;
  phase: string;
  state: WorkflowStageState;
  reason?: string;
  condition?: string;
  decided_at?: string;
  revision?: number;
  gate?: "awaiting-approval" | "revising" | "approved" | null;
  questions?: WorkflowQuestions;
  artifacts: WorkflowArtifact[];
  memory?: string;
}

export interface WorkflowPhase {
  name: string;
  stages: WorkflowStage[];
  skipped_by_scope: boolean;
  skipped_count?: number;
}

export interface WorkflowIntent {
  /** Record directory name — the identity `/api/state.intent` and every `intent=` parameter use. */
  slug: string;
  /** Registry label when it differs from the record name (display only). */
  label: string;
  status: WorkflowIntentStatus;
  scope: string | null;
  depth: string | null;
  phase: string | null;
  current_stage: string | null;
  needs: { kind: "gate" | "questions" | "sensor"; label: string } | null;
  updated_at: string | null;
}

export interface WorkflowPayload {
  space: string;
  spaces: string[];
  intent: string | null;
  intents: WorkflowIntent[];
  scope: string | null;
  depth: string | null;
  phase: string | null;
  stages_total: number;
  stages_done: number;
  phases: WorkflowPhase[];
  agent_status: "idle" | "writing" | "revising" | "waiting";
  daemon: { version: string; port: number };
}

export interface WorkflowSelection {
  space: string;
  intent: string | null;
  record: string;
  readOnly: boolean;
}

interface IntentRecord {
  entry: IntentRegistryEntry;
  recordName: string;
}

function posixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function regularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function availableSpaces(projectDir: string): string[] {
  try {
    return readdirSync(spacesRoot(projectDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function recordsForSpace(projectDir: string, space: string): IntentRecord[] {
  const registry = readIntentRegistry(projectDir, space);
  const dirs = listIntentDirs(projectDir, space);
  const matched = new Set<string>();
  const records: IntentRecord[] = [];
  for (const entry of registry) {
    const recordName = dirs.find((dir) => recordDirMatches(entry, dir));
    if (!recordName) continue;
    matched.add(recordName);
    records.push({ entry, recordName });
  }
  // Older versioned registries are tolerated by the library as empty. Preserve
  // every real record in that case rather than leaving the workflow selector blank.
  for (const recordName of dirs) {
    if (matched.has(recordName)) continue;
    records.push({
      entry: { uuid: recordName, slug: recordName, dirName: recordName, status: "active" },
      recordName,
    });
  }
  return records;
}

function selectedRecordName(projectDir: string, space: string, requested?: string): string | null {
  const active = activeIntent(projectDir, space);
  if (!requested) return active;
  const record = recordsForSpace(projectDir, space).find(
    ({ entry, recordName }) => entry.slug === requested || recordName === requested,
  );
  return record?.recordName ?? requested;
}

export function workflowSelection(
  projectDir: string,
  options: { intent?: string | null; space?: string | null } = {},
): WorkflowSelection {
  const selectedSpace = options.space?.trim() || activeSpace(projectDir);
  const activeRecord = activeIntent(projectDir, selectedSpace);
  const selectedIntent = selectedRecordName(projectDir, selectedSpace, options.intent?.trim() || undefined);
  const record = recordDir(projectDir, selectedIntent ?? undefined, selectedSpace)
    ?? docsRoot(projectDir, selectedIntent ?? undefined, selectedSpace);
  return {
    space: selectedSpace,
    intent: selectedIntent,
    record,
    readOnly: selectedSpace !== activeSpace(projectDir) || selectedIntent !== activeRecord,
  };
}

function safeState(projectDir: string, intent: string, space: string): string | null {
  try {
    return readStateFile(projectDir, intent, space);
  } catch {
    return null;
  }
}

function stateUpdatedAt(record: string): string | null {
  try {
    return statSync(join(record, "aidlc-state.md")).mtime.toISOString();
  } catch {
    return null;
  }
}

function sortedAudit(projectDir: string, intent: string, space: string): AuditShardEvent[] {
  try {
    return readAuditShardEvents(projectDir, intent, space).sort((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp.localeCompare(right.timestamp);
      if (left.shardIndex !== right.shardIndex) return left.shardIndex - right.shardIndex;
      return left.pos - right.pos;
    });
  } catch {
    return [];
  }
}

function stageAuditRows(rows: readonly AuditShardEvent[], stage: string, event: string): AuditShardEvent[] {
  return rows.filter(
    (row) => row.event === event && auditBlockField(row.block, "Stage") === stage,
  );
}

function skipReasonFromSuffix(suffix: string): string | null {
  const match = /\(([^()]*)\)\s*$/.exec(suffix);
  return match?.[1]?.trim() || null;
}

function shortCondition(stage: StageEntry): string {
  const raw = stage.condition?.trim();
  if (!raw) return "if applicable";
  const sentence = raw.split(/(?<=[.!?])\s/)[0]
    .replace(/^Execute\s+when\s+/i, "if ")
    .replace(/^Execute\s+after\s+/i, "after ")
    .replace(/^When\s+/i, "if ")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .trim();
  if (!sentence) return "if applicable";
  return sentence.length <= 80 ? sentence : `${sentence.slice(0, 77).trimEnd()}…`;
}

function questionsForStage(
  projectDir: string,
  record: string,
  stage: StageEntry,
): WorkflowQuestions | undefined {
  const stagePath = join(record, stage.phase, stage.slug);
  const questionsPath = join(stagePath, `${stage.slug}-questions.md`);
  if (!regularFile(questionsPath)) return undefined;
  let source: string;
  try {
    source = readFileSync(questionsPath, "utf-8");
  } catch {
    return undefined;
  }
  const questions = parseQuestionsMarkdown(source).filter((question) => !question.confirmation);
  const answered = questions.filter((question) => question.answer !== null && question.answer.trim() !== "").length;
  const guidePath = join(stagePath, `${stage.slug}-questions-guide.html`);
  let guide = false;
  if (regularFile(guidePath)) {
    try {
      guide = checkGuideArtifact(readFileSync(guidePath, "utf-8"), source, {
        name: `${stage.slug}-questions-guide`,
        stage: stage.slug,
      }).ok;
    } catch {
      guide = false;
    }
  }
  return {
    file: posixRelative(projectDir, questionsPath),
    answered,
    total: questions.length,
    open: answered < questions.length,
    guide,
  };
}

function feedbackThreads(stagePath: string): Map<string, number> {
  const counts = new Map<string, number>();
  const dir = join(stagePath, ".review-ui");
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => /^feedback-\d{3,}\.md$/.test(file));
  } catch {
    return counts;
  }
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    let artifact: string | null = null;
    let inFence = false;
    for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
      if (/^\s{0,3}(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        artifact = heading[1] === "General notes" ? null : basename(heading[1].trim());
        continue;
      }
      if (artifact && /^###\s+\S/.test(line)) {
        counts.set(artifact, (counts.get(artifact) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function artifactsForStage(
  projectDir: string,
  record: string,
  state: string,
  stage: StageEntry,
  current: CurrentPointer | null,
  currentManifest: ReviewManifest | null,
): WorkflowArtifact[] {
  const formats = artifactFormatsFromState(state);
  const stagePath = join(record, stage.phase, stage.slug);
  const threadCounts = feedbackThreads(stagePath);
  return (stage.produces ?? []).map((name) => {
    const manifestArtifact = current?.stage === stage.slug
      ? currentManifest?.artifacts.find((artifact) => artifact.name === name)
      : undefined;
    const filename = manifestArtifact ? basename(manifestArtifact.path) : artifactFilename(name, formats);
    const absolute = join(stagePath, filename);
    const path = manifestArtifact?.path ?? posixRelative(projectDir, absolute);
    const exists = manifestArtifact?.exists ?? regularFile(absolute);
    const extension = extname(filename).toLowerCase();
    const format = manifestArtifact?.format ?? (extension === ".html" || extension === ".htm"
      ? "html"
      : artifactFormat(name, formats));
    return {
      name,
      path,
      exists,
      format,
      kind: manifestArtifact?.kind ?? artifactKind(name) ?? "document",
      revision: current?.stage === stage.slug && currentManifest ? currentManifest.revision : null,
      threads: threadCounts.get(filename) ?? 0,
      produces: true,
    };
  });
}

function readPointerAndManifest(record: string, projectDir: string): {
  current: CurrentPointer | null;
  manifest: ReviewManifest | null;
} {
  const current = readCurrentPointer(record);
  if (!current?.stage_dir) return { current, manifest: null };
  try {
    const stagePath = realpathSync(join(projectDir, ...current.stage_dir.split("/")));
    const recordPath = realpathSync(record);
    const relativePath = relative(recordPath, stagePath);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) return { current, manifest: null };
    return { current, manifest: readManifest(stagePath) };
  } catch {
    return { current, manifest: null };
  }
}

function intentSummary(
  projectDir: string,
  space: string,
  recordName: string,
  slug: string,
): WorkflowIntent | null {
  const record = recordDir(projectDir, recordName, space);
  const state = safeState(projectDir, recordName, space);
  if (!record || state === null) return null;
  const checkboxes = parseCheckboxes(state);
  const currentStage = getField(state, "Current Stage");
  const current = currentStage ? checkboxes.find((entry) => entry.slug === currentStage) : undefined;
  const graph = loadStageGraphAll().filter((stage) => stage.enabled !== false);
  const graphStage = graph.find((stage) => stage.slug === currentStage);
  const questions = graphStage ? questionsForStage(projectDir, record, graphStage) : undefined;
  let status: WorkflowIntentStatus = "idle";
  let needs: WorkflowIntent["needs"] = null;
  if (current?.state === "awaiting-approval" || current?.state === "revising") {
    status = "needs-you";
    needs = { kind: "gate", label: current.state === "revising" ? "Review changes" : "Review approval gate" };
  } else if (current?.state === "in-progress" && questions?.open) {
    status = "needs-you";
    const open = Math.max(0, questions.total - questions.answered);
    needs = { kind: "questions", label: `${open} ${open === 1 ? "question" : "questions"}` };
  } else if (current?.state === "in-progress") {
    status = "in-progress";
  } else if (checkboxes.length > 0 && checkboxes.every((entry) => entry.state === "completed" || entry.state === "skipped")) {
    status = "done";
  }
  return {
    slug: recordName,
    label: slug,
    status,
    scope: getField(state, "Scope"),
    depth: getField(state, "Depth"),
    phase: getField(state, "Lifecycle Phase"),
    current_stage: currentStage,
    needs,
    updated_at: stateUpdatedAt(record),
  };
}

function integerField(state: string, field: string, fallback: number): number {
  const parsed = Number(getField(state, field));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function buildPhases(
  projectDir: string,
  selection: WorkflowSelection,
  state: string,
  scope: string | null,
): WorkflowPhase[] {
  const graph = loadStageGraphAll().filter((stage) => stage.enabled !== false);
  const checkboxes = new Map(parseCheckboxes(state).map((entry) => [entry.slug, entry]));
  const stateActions = parseStateStageSuffixes(state);
  let scopeStages: Record<string, "EXECUTE" | "SKIP"> = {};
  try {
    scopeStages = scope ? loadScopeMapping()[scope]?.stages ?? {} : {};
  } catch {
    scopeStages = {};
  }
  const audit = selection.intent ? sortedAudit(projectDir, selection.intent, selection.space) : [];
  const { current, manifest } = readPointerAndManifest(selection.record, projectDir);
  let nextAssigned = false;
  const grouped = new Map<string, StageEntry[]>();
  for (const stage of graph) {
    const stages = grouped.get(stage.phase) ?? [];
    stages.push(stage);
    grouped.set(stage.phase, stages);
  }
  const phases: WorkflowPhase[] = [];
  for (const [phase, stages] of grouped) {
    const workflowStages = stages.map((stage): WorkflowStage => {
      const checkbox = checkboxes.get(stage.slug);
      const action = stateActions.get(stage.slug) ?? scopeStages[stage.slug];
      let stageState: WorkflowStageState;
      if (checkbox?.state === "completed") stageState = "done";
      else if (
        checkbox?.state === "in-progress" ||
        checkbox?.state === "awaiting-approval" ||
        checkbox?.state === "revising"
      ) stageState = "current";
      else if (checkbox?.state === "skipped" || action === "SKIP") stageState = "skipped";
      else if (stage.execution === "CONDITIONAL") stageState = "conditional";
      else if (!nextAssigned) {
        stageState = "next";
        nextAssigned = true;
      } else stageState = "pending";

      const skipRows = stageAuditRows(audit, stage.slug, "STAGE_SKIPPED");
      const decisionRows = stageAuditRows(audit, stage.slug, "DECISION_RECORDED");
      const latestSkip = skipRows.at(-1);
      const latestDecision = decisionRows.at(-1);
      const reason = stageState === "skipped"
        ? skipReasonFromSuffix(checkbox?.suffix ?? "")
          ?? (latestSkip ? auditBlockField(latestSkip.block, "Reason") : null)
          ?? (scope ? `not in ${scope} scope` : "not in scope")
        : null;
      const questions = questionsForStage(projectDir, selection.record, stage);
      const memoryPath = join(selection.record, stage.phase, stage.slug, "memory.md");
      const result: WorkflowStage = {
        slug: stage.slug,
        name: stage.name,
        phase: stage.phase,
        state: stageState,
        artifacts: artifactsForStage(projectDir, selection.record, state, stage, current, manifest),
      };
      if (reason) result.reason = reason;
      if (stageState === "conditional") result.condition = shortCondition(stage);
      if (latestDecision) result.decided_at = latestDecision.timestamp;
      if (current?.stage === stage.slug) {
        result.revision = current.revision;
        result.gate = current.state === "none" ? null : current.state;
      }
      if (questions) result.questions = questions;
      if (regularFile(memoryPath)) result.memory = posixRelative(projectDir, memoryPath);
      return result;
    });
    const scopeSkipped = stages.filter((stage) => scopeStages[stage.slug] === "SKIP").length;
    const skippedByScope = stages.length > 0 && scopeSkipped === stages.length;
    phases.push({
      name: titleCase(phase),
      stages: workflowStages,
      skipped_by_scope: skippedByScope,
      ...(skippedByScope ? { skipped_count: scopeSkipped } : {}),
    });
  }
  return phases;
}

export function workflowPayload(
  projectDir: string,
  options: { intent?: string | null; space?: string | null; version: string; port: number },
): WorkflowPayload {
  const selection = workflowSelection(projectDir, options);
  const spaces = availableSpaces(projectDir);
  if (!spaces.includes(selection.space)) spaces.push(selection.space);
  spaces.sort();
  const records = recordsForSpace(projectDir, selection.space);
  const intents = records.flatMap(({ entry, recordName }) => {
    const summary = intentSummary(projectDir, selection.space, recordName, entry.slug);
    return summary ? [summary] : [];
  });
  // The payload's `intent` is the record directory name, exactly what
  // `/api/state.intent` reports and what `intent=` accepts; the registry
  // label rides along on each entry as `label`.
  const intentSlug = selection.intent;
  const state = selection.intent ? safeState(projectDir, selection.intent, selection.space) : null;
  if (state === null) {
    return {
      space: selection.space,
      spaces,
      intent: intentSlug,
      intents,
      scope: null,
      depth: null,
      phase: null,
      stages_total: 0,
      stages_done: 0,
      phases: [],
      agent_status: "idle",
      daemon: { version: options.version, port: options.port },
    };
  }
  const scope = getField(state, "Scope");
  const checkboxes = parseCheckboxes(state);
  const done = checkboxes.filter((entry) => entry.state === "completed").length;
  const phases = buildPhases(projectDir, selection, state, scope);
  const current = readCurrentPointer(selection.record);
  // The marker is deliberately only a presence hint. Pointer states are the
  // authoritative browser-visible agent states; without one, idle is safer than
  // claiming the agent is writing.
  try {
    if (selection.intent) lstatSync(humanTurnMarkerPath(projectDir, selection.intent, selection.space));
  } catch {
    // No marker is the ordinary case for older records.
  }
  const agentStatus: WorkflowPayload["agent_status"] = current?.state === "awaiting-approval"
    ? "waiting"
    : current?.state === "revising"
      ? "revising"
      : "idle";
  return {
    space: selection.space,
    spaces,
    intent: intentSlug,
    intents,
    scope,
    depth: getField(state, "Depth"),
    phase: getField(state, "Lifecycle Phase"),
    stages_total: integerField(state, "Total Stages", checkboxes.filter((entry) => entry.state !== "skipped").length),
    stages_done: integerField(state, "Completed", done),
    phases,
    agent_status: agentStatus,
    daemon: { version: options.version, port: options.port },
  };
}

export interface ReviewUiRemark {
  id: string;
  kind: FeedbackRemarkKind;
  artifact: string;
  heading_path: string[];
  quote: string | null;
  body: string | null;
  diff: string | null;
  /** The remark this one continues, when the reviewer replied to an earlier thread. */
  reply_to: string | null;
}

export interface ReviewUiRemarkFile {
  file: string;
  revision: number;
  decision_hint: "approve" | "request-changes" | "none";
  created: string;
  consumed: boolean;
  remarks: ReviewUiRemark[];
}

const REMARK_HEADING = /^### (Comment|Delete|Looks good|Label|Edit \(unified diff\))(?: · (a[1-9][0-9]*))?(?: · reply to (a[1-9][0-9]*))?(?: — (.*))?$/;

function remarkKind(label: string): FeedbackRemarkKind {
  if (label === "Looks good") return "looks-good";
  if (label === "Edit (unified diff)") return "edit";
  return label.toLowerCase() as Exclude<FeedbackRemarkKind, "looks-good" | "edit">;
}

function remarkHeadingPath(value: string): string[] {
  return value
    .replace(/\s+\(lines ~\d+-\d+\)$/, "")
    .replace(/\s+\(element: [^)]+\)$/, "")
    .split(" › ")
    .map((part) => part.trim())
    .filter(Boolean);
}

function remarkContent(lines: readonly string[], start: number, end: number): {
  quote: string | null;
  body: string | null;
  diff: string | null;
} {
  let cursor = start;
  while (cursor < end && lines[cursor].trim() === "") cursor++;
  const quote: string[] = [];
  while (cursor < end && lines[cursor].startsWith(">")) {
    quote.push(lines[cursor].replace(/^> ?/, ""));
    cursor++;
  }
  while (cursor < end && lines[cursor].trim() === "") cursor++;
  if (lines[cursor]?.trim() === "```diff") {
    const diff: string[] = [];
    cursor++;
    while (cursor < end && lines[cursor].trim() !== "```") diff.push(lines[cursor++]);
    return {
      quote: quote.length > 0 ? quote.join("\n") : null,
      body: null,
      diff: diff.length > 0 ? `${diff.join("\n")}\n` : "",
    };
  }
  const body = lines.slice(cursor, end).join("\n").trim();
  return {
    quote: quote.length > 0 ? quote.join("\n") : null,
    body: body || null,
    diff: null,
  };
}

export function parseReviewUiRemarks(body: string, legacyIdPrefix = "remark"): ReviewUiRemark[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const remarks: ReviewUiRemark[] = [];
  let artifact = "";
  let inFence = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const artifactHeading = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (artifactHeading) {
      artifact = basename(artifactHeading[1].trim());
      continue;
    }
    const heading = REMARK_HEADING.exec(line);
    if (!heading || !artifact) continue;
    let end = index + 1;
    let nestedFence = false;
    while (end < lines.length) {
      if (/^\s{0,3}(?:```|~~~)/.test(lines[end])) nestedFence = !nestedFence;
      if (!nestedFence && (/^###\s+/.test(lines[end]) || /^##\s+/.test(lines[end]))) break;
      end++;
    }
    const content = remarkContent(lines, index + 1, end);
    remarks.push({
      id: heading[2] ?? `${legacyIdPrefix}-${remarks.length + 1}`,
      kind: remarkKind(heading[1]),
      artifact,
      heading_path: remarkHeadingPath(heading[4] ?? ""),
      quote: content.quote,
      body: content.body,
      diff: content.diff,
      reply_to: heading[3] ?? null,
    });
    index = end - 1;
  }
  return remarks;
}

export function reviewUiRemarkFiles(stagePath: string): ReviewUiRemarkFile[] {
  const consumed = readConsumed(stagePath);
  const consumedNames = new Set(consumed.entries.map((entry) => entry.file));
  const reviewDir = stageReviewUiDir(stagePath);
  return listFeedbackFiles(stagePath).map((feedback) => {
    let source = feedback.body;
    try {
      source = readFileSync(join(reviewDir, feedback.file), "utf-8");
      const frontmatterEnd = source.indexOf("\n---", 4);
      if (frontmatterEnd >= 0) source = source.slice(source.indexOf("\n", frontmatterEnd + 4) + 1);
    } catch {
      // Parsed feedback body is the safe fallback if the file vanishes mid-read.
    }
    return {
      file: feedback.file,
      revision: feedback.frontmatter.revision,
      decision_hint: feedback.frontmatter.decision_hint,
      created: feedback.frontmatter.created,
      consumed: consumedNames.has(feedback.file),
      remarks: parseReviewUiRemarks(source, feedback.file.replace(/\.md$/, "")),
    };
  });
}
