// AI-DLC's own records: audit shards, workflow state, hook health, session folder.
// Only names, times, counts and AI-DLC's own vocabulary are kept; every field
// that can carry the person's words or the project's content is left out

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Prompt } from "./lib-transcripts.ts";
import type { AidlcTools, Intent } from "./lib-project.ts";

export type AuditRow = { ts: string; event: string; fields: Record<string, string>; intent: string };

// The session a row was recorded for (its Session field), kept beside the row and never in safe.json.
export const rowSession = new WeakMap<AuditRow, string>();

// Events that show something went wrong.
export const PROBLEM_EVENTS = new Set([
  "ERROR_LOGGED", "PLAN_APPROVAL_BLOCKED", "REVIEW_FREEZE_BLOCKED", "REVIEWER_SCOPE_BLOCKED", "GUARD_DISABLED",
  "GUARD_STOOD_ASIDE", "CHANGE_ACCEPTED", "GATE_REJECTED", "STAGE_REVISING", "STAGE_JUMPED", "STAGE_SKIPPED",
  "SENSOR_FAILED", "SENSOR_BUDGET_OVERRIDE", "BOLT_FAILED", "WORKTREE_DISCARDED", "SWARM_UNIT_FAILED", "SWARM_DEGRADED",
  "MERGE_DISPATCH_FALLBACK", "QUESTION_UNANSWERED", "SESSION_COMPACTED", "RECOVERY_COMPLETED", "PLAN_APPROVAL_SKIPPED",
  "PLAN_APPROVAL_OVERRIDDEN", "UNIT_PAUSED", "WORKFLOW_PARKED", "PRACTICES_SECTION_EMPTY", "MEMORY_EMPTY",
  "SUBAGENT_PROMPT_UNMATCHED", "COORDINATION_STOOD_ASIDE",
]);

// Fields safe to copy: AI-DLC vocabulary, numbers, stage/guard/sensor names.
// Unit and stage names are run through the dictionary later.
export const AUDIT_FIELDS = new Set([
  "Stage", "Stage slug", "Current Stage", "Next Stage", "Phase", "Lifecycle Phase", "Unit", "Tool", "Guard", "Sensor ID",
  "Direction", "Exit Code", "Error Fingerprint", "Findings count", "Revision count", "Revision Count", "State Validity",
  "Status", "Verdict", "Result", "Harness", "Cap layer", "Fallback driver", "Failed Bolt", "Checkpoint", "Source", "Target",
  "Scope",
]);
// Source/Target are stage slugs only for jumps; elsewhere Target is a file path. A guard switch's Source says who
// switched it (`you`, `command`, `team`).
const STAGE_ENDPOINT_EVENTS = new Set(["STAGE_JUMPED"]);
const GUARD_SWITCH_EVENTS = new Set(["GUARD_DISABLED", "GUARD_RESTORED", "GUARD_POLICY_SET"]);

// One field of a row, the first time it is written: AI-DLC's own auditBlockField when the install has it.
type FieldReader = (block: string, name: string) => string | null;
const ownField: FieldReader = (block, name) => {
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*(?:-\s+)?\*\*([^*]+)\*\*:\s*(.*)$/);
    if (m && m[1].trim() === name) return m[2].trim();
  }
  return null;
};

function parseAuditBlocks(blocks: string[], intent: string, field: FieldReader): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const raw of blocks) {
    // A record written on Windows ends its lines with CRLF.
    const block = raw.replace(/\r\n?/g, "\n");
    const fields: Record<string, string> = {};
    for (const name of ["Event", "Timestamp", "Error", "Session", ...AUDIT_FIELDS]) {
      const v = field(block, name);
      if (v !== null) fields[name] = v;
    }
    const event = fields.Event;
    const ts = fields.Timestamp;
    if (!event || !ts) continue;
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (!AUDIT_FIELDS.has(k)) continue;
      if (k === "Target" && !STAGE_ENDPOINT_EVENTS.has(event)) continue;
      if (k === "Source" && !STAGE_ENDPOINT_EVENTS.has(event) && !GUARD_SWITCH_EVENTS.has(event)) continue;
      safe[k] = v.slice(0, 120);
    }
    // Two ERROR_LOGGED rows are "the same error" when their error text matches
    // once numbers and quoted words are taken out; only a short hash is kept.
    if (event === "ERROR_LOGGED" && fields.Error) {
      const norm = fields.Error.toLowerCase()
        // a quoted span ("x", “x”, 'x'), but not an apostrophe inside a word (can't)
        .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu, "")
        .replace(/[0-9]+/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 160);
      safe["Error Group"] = createHash("sha256").update(norm).digest("hex").slice(0, 8);
    }
    const row: AuditRow = { ts, event, fields: safe, intent };
    if (fields.Session) rowSession.set(row, fields.Session);
    rows.push(row);
  }
  return rows;
}

function mdFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f));
}

// One audit folder's shard files. A copied shard file's rows are read once, by AI-DLC's own rule when the
// install has it (lib-project.ts importAidlcTools).
function readAuditFolder(dir: string, intent: string, tools?: AidlcTools): AuditRow[] {
  const shards = mdFilesUnder(dir).map((shard) => ({ shard, content: readFileSync(shard, "utf8") }));
  const copies = tools?.auditCopies;
  const copied = copies ? copies.copied(shards) : shards.map(() => new Set<number>());
  return shards.flatMap(({ content }, i) => {
    const blocks = copies ? copies.blocks(content) : content.replace(/\r\n?/g, "\n").split(/\n-{3,}\s*\n/);
    return parseAuditBlocks(blocks.filter((_, pos) => !copied[i].has(pos)), intent, tools?.auditField ?? ownField);
  });
}

export function readAudit(project: string, intents: Intent[], tools?: AidlcTools): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const it of intents) rows.push(...readAuditFolder(join(it.path, "audit"), it.dir, tools));
  const spacesDir = join(project, "aidlc", "spaces");
  if (existsSync(spacesDir)) {
    for (const space of readdirSync(spacesDir)) rows.push(...readAuditFolder(join(spacesDir, space, "intents", "audit"), "(space)", tools));
  }
  // By time, not by text: a Timestamp may carry an offset or no milliseconds.
  const at = (r: AuditRow) => {
    const t = Date.parse(r.ts);
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  // Two unreadable times compare equal (Infinity - Infinity would be NaN).
  rows.sort((a, b) => {
    const x = at(a);
    const y = at(b);
    return x === y ? 0 : x < y ? -1 : 1;
  });
  return rows;
}

// Signals from what is missing.
export function absenceSignals(rows: AuditRow[]): { kind: string; ts: string; stage: string | null; intent: string }[] {
  const out: { kind: string; ts: string; stage: string | null; intent: string }[] = [];
  // An approval gate still open is doctor's to say ("Approval gate pending"), by the engine's own
  // reading of the record; a second reading here would disagree with it.
  const byIntent = new Map<string, AuditRow[]>();
  for (const r of rows) {
    const list = byIntent.get(r.intent);
    if (list) list.push(r);
    else byIntent.set(r.intent, [r]);
  }
  for (const [intent, list] of byIntent) {
    const gates = list.filter((r) => r.event.startsWith("GATE_")).length;
    const turns = list.filter((r) => r.event === "HUMAN_TURN").length;
    if (gates > 0 && turns === 0) out.push({ kind: "no-human-turn-recorded", ts: list[list.length - 1].ts, stage: null, intent });
  }
  const errors = new Map<string, AuditRow[]>();
  for (const r of rows.filter((r) => r.event === "ERROR_LOGGED")) {
    const k = `${r.intent}|${r.fields.Tool ?? ""}|${r.fields["Error Fingerprint"] ?? r.fields["Error Group"] ?? r.fields["Exit Code"] ?? ""}`;
    const list = errors.get(k);
    if (list) list.push(r);
    else errors.set(k, [r]);
  }
  for (const list of errors.values()) {
    if (list.length >= 2) out.push({ kind: `same-error-repeated x${list.length} (${list[0].fields.Tool ?? "?"})`, ts: list[0].ts, stage: list[0].fields.Stage ?? null, intent: list[0].intent });
  }
  return out;
}

// aidlc-state.md: current position and lowered checks.
// `getField`: AI-DLC's own state-field reader, from the install (lib-project.ts importAidlcTools). Without it, a field
// is read on its own line only, so an empty one is empty, never the next line.
export function readState(it: Intent, getField?: (content: string, field: string) => string | null) {
  const path = join(it.path, "aidlc-state.md");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
  const field = (name: string) => {
    const v = getField ? getField(text, name) : (text.match(new RegExp(`^\\s*(?:-\\s+)?\\*\\*${name}\\*\\*:[ \\t]*(.*)$`, "m"))?.[1] ?? null);
    return v?.trim() ? v.trim().slice(0, 80) : null;
  };
  const stages: Record<string, string> = {};
  for (const m of text.matchAll(/^\s*-\s*\[([ xX\-?RS])\]\s*([a-z0-9-]+)/gm)) stages[m[2]] = m[1] === " " ? "todo" : m[1];
  return {
    intent: it.dir,
    phase: field("Lifecycle Phase"),
    currentStage: field("Current Stage"),
    nextStage: field("Next Stage"),
    status: field("Status"),
    lastUpdated: field("Last Updated"),
    revisionCount: field("Revision Count"),
    scope: field("Scope"),
    depth: field("Depth"),
    testStrategy: field("Test Strategy"),
    totalStages: field("Total Stages"),
    completed: field("Completed"),
    inProgress: field("In Progress"),
    guardPolicy: field("Guard Policy"),
    guardsOn: field("Guards On"),
    guardsOff: field("Guards Off"),
    sensors: field("Sensors"),
    planApproval: field("Plan Approval"),
    stages,
  };
}

// <record>/.aidlc-engine/hooks-health/ (and the legacy .aidlc-hooks-health/).
// .drops keep only the reason up to its first colon (doctor's own rule);
// .trace lines are normal decisions and are skipped; old releases wrote
// Stop-hook carve-outs into continue-workflow.drops, which look like traces.
const TRACE_LIKE = /(let the turn end|carve-out|pending[- ]question|human[- ]wait|waiting for the person)/i;

export function readHooksHealth(dirs: string[], sinceMs: number, untilMs = Number.POSITIVE_INFINITY) {
  const last: Record<string, string> = {};
  const drops: { ts: string; hook: string; reason: string; degraded: boolean }[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const path = join(dir, f);
      let file = false;
      try {
        file = statSync(path).isFile();
      } catch {
        // a dangling link: nothing to read
      }
      if (!file) continue;
      if (f.endsWith(".last")) {
        const hook = f.slice(0, -5);
        const ts = readFileSync(path, "utf8").trim().slice(0, 40);
        if (!last[hook] || ts > last[hook]) last[hook] = ts;
      } else if (f.endsWith(".drops")) {
        const hook = f.slice(0, -6);
        for (const line of readFileSync(path, "utf8").split("\n")) {
          const [ts, ...rest] = line.split("\t");
          const reasonFull = rest.join("\t").trim();
          const at = Date.parse(ts);
          // A line whose time does not parse cannot be placed in the window, so it is not counted in it.
          if (!ts || !reasonFull || Number.isNaN(at) || at < sinceMs || at > untilMs) continue;
          if (TRACE_LIKE.test(reasonFull)) continue;
          const reason = reasonFull.split(":")[0].slice(0, 100);
          drops.push({ ts, hook, reason, degraded: /\[degraded\]/i.test(reasonFull) });
        }
      }
    }
  }
  drops.sort((a, b) => a.ts.localeCompare(b.ts));
  return { last, drops };
}

export function hookHealthDirs(project: string, intents: Intent[]): string[] {
  const dirs = intents.flatMap((it) => [join(it.path, ".aidlc-engine", "hooks-health"), join(it.path, ".aidlc-hooks-health")]);
  const spacesDir = join(project, "aidlc", "spaces");
  if (existsSync(spacesDir)) for (const s of readdirSync(spacesDir)) dirs.push(join(spacesDir, s, "intents", ".aidlc-engine", "hooks-health"));
  return dirs;
}

// aidlc/.aidlc-sessions/: counts only, never the bodies.
export function readSessionsFolder(project: string) {
  const base = join(project, "aidlc", ".aidlc-sessions");
  const count = (sub: string) => (existsSync(join(base, sub)) ? readdirSync(join(base, sub)).filter((f) => !f.startsWith(".")).length : 0);
  let unboundApprovals = 0;
  const pa = join(base, "plan-approval");
  if (existsSync(pa)) {
    for (const f of readdirSync(pa).filter((f) => f.startsWith("ask-") && f.endsWith(".json"))) {
      try {
        const j = JSON.parse(readFileSync(join(pa, f), "utf8"));
        if (j.bound === false) unboundApprovals++;
      } catch {
        // unreadable ask: not counted
      }
    }
  }
  let ledger: { cursors?: Record<string, unknown> } | null = null;
  try {
    ledger = JSON.parse(readFileSync(join(base, "usage-ledger.json"), "utf8")) as { cursors?: Record<string, unknown> };
  } catch {
    ledger = null;
  }
  // The cursor keys are absolute chat-log paths (their folder names are the
  // person's); only how many there are and which tool wrote them leaves here.
  const cursorPaths = ledger?.cursors ? Object.keys(ledger.cursors) : [];
  const toolOf = (p: string) =>
    /[\\/]\.claude[\\/]/.test(p) ? "claude" : /[\\/]\.codex[\\/]/.test(p) ? "codex" : "other";
  return {
    exists: existsSync(base),
    openQuestions: count("questions"),
    unboundApprovals,
    kiroIdePending: count("kiro-ide-pending"),
    transcriptCursors: { count: cursorPaths.length, tools: [...new Set(cursorPaths.map(toolOf))].sort() },
  };
}

// The rows a doctor run writes about itself, not the run's activity; AI-DLC's own DOCTOR_RUN_AUDIT_EVENTS when the
// install has it.
const DOCTOR_RUN_EVENTS: ReadonlySet<string> = new Set(["GUARDRAIL_LOADED", "HEALTH_CHECKED"]);

// The stretch of time collect.ts reads: what the person named, else from 7 days
// before the last AI-DLC activity up to now. The end is now, not the last audit
// row: when the hooks stopped writing (the trouble itself), the record ends
// before the trouble while the chat logs go on. This skill's own doctor run
// leaves its own rows, which are not the run's activity.
export function timeWindow(o: { since?: string; until?: string; days?: string; rows: AuditRow[]; now: number; doctorRunEvents?: ReadonlySet<string> }): {
  since: number;
  until: number;
  lastActivity: string | null;
  notes: string[];
} {
  const DAY_MS = 86_400_000;
  const HOUR_MS = 3_600_000;
  const notes: string[] = [];
  const parse = (name: string, value: string | undefined): number | null => {
    if (value === undefined) return null;
    const t = Date.parse(value);
    if (Number.isNaN(t)) {
      notes.push(`--${name} was not a time (ISO with Z, e.g. 2026-10-17T08:00:00Z); left out`);
      return null;
    }
    return t;
  };
  const doctorRun = o.doctorRunEvents ?? DOCTOR_RUN_EVENTS;
  // The run's last activity: not doctor's own rows, and not the HUMAN_TURN rows at the very end, which are the person
  // asking for this report (the window then still reaches to now, so a run that ended on a reply keeps it).
  const timed = o.rows.filter((r) => !doctorRun.has(r.event) && Number.isFinite(Date.parse(r.ts)));
  let last = timed.length - 1;
  while (last >= 0 && timed[last].event === "HUMAN_TURN") last--;
  // With nothing but HUMAN_TURN rows, the last of them is the last activity.
  const lastActivity = (last >= 0 ? timed[last] : timed.at(-1))?.ts ?? null;
  const givenSince = parse("since", o.since);
  const givenUntil = parse("until", o.until);
  const asked = Number(o.days ?? 7);
  const days = Number.isFinite(asked) && asked > 0 && asked <= 366 ? asked : 7;
  let until = givenUntil ?? o.now;
  // Without --since, the window reaches back from the last AI-DLC activity, or from --until when that is
  // earlier: the days before the end the person gave.
  const end = lastActivity ? Math.min(Date.parse(lastActivity), until) : until;
  let since = givenSince ?? end - days * DAY_MS - 2 * HOUR_MS;
  if (since > until) {
    [since, until] = [until, since];
    notes.push("the end was before the start; the two were swapped");
  }
  return { since, until, lastActivity, notes };
}

// The HUMAN_TURN rows AI-DLC's prompt hook wrote for this report's own messages are the report's, not the run's: they
// would stand in for the replies the run did not record.
export function withoutReportTurns(rows: AuditRow[], prompts: Prompt[]): AuditRow[] {
  const reportTimes = prompts.filter((p) => p.report).map((p) => Date.parse(p.ts));
  return rows.filter((r) => r.event !== "HUMAN_TURN" || !reportTimes.some((t) => Math.abs(Date.parse(r.ts) - t) <= 10_000));
}

// Did each reply the person typed reach AI-DLC's record? Each one typed after the first HUMAN_TURN should
// have its own HUMAN_TURN a few seconds around it, from the same session when both name one (a second chat
// open at the same time cannot answer for it). A reply without one is listed with how it reached the tool
// (Codex: inside a turn still running, the same text as the reply before it) — times and flags only.
export function matchReplies(prompts: Prompt[], rows: AuditRow[]) {
  const turns = rows
    .filter((r) => r.event === "HUMAN_TURN")
    .map((r) => ({ t: Date.parse(r.ts), session: rowSession.get(r) }))
    .sort((a, b) => a.t - b.t);
  const typed = prompts
    // A reply after which no AI-DLC command ran was not about the work, and AI-DLC's prompt hook records
    // only those that were; where the reader cannot tell (engineAfter undefined), the reply is checked.
    // Replies are checked from the first HUMAN_TURN on (before it the prompt hook may not have been set up); with
    // none at all in the window, every reply an AI-DLC command followed is checked, since the hook then recorded none.
    .filter(
      (p) =>
        !p.inherited &&
        !p.report &&
        p.engineAfter !== false &&
        (turns.length ? Date.parse(p.ts) >= turns[0].t - 10_000 : p.engineAfter === true),
    )
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const used = new Set<number>();
  const notRecorded: object[] = [];
  for (const p of typed) {
    const t = Date.parse(p.ts);
    const k = turns.findIndex(
      (h, i) => !used.has(i) && Math.abs(h.t - t) <= 10_000 && (!h.session || !p.session || h.session === p.session),
    );
    if (k >= 0) used.add(k);
    else notRecorded.push({ ts: p.ts, tool: p.tool, ...(p.turn ? { inRunningTurn: p.inRunningTurn, sameAsBeforeInTurn: p.sameAsBeforeInTurn } : {}) });
  }
  return {
    checked: typed.length,
    recorded: typed.length - notRecorded.length,
    notRecorded,
    inRunningTurn: typed.filter((p) => p.inRunningTurn).length,
  };
}
