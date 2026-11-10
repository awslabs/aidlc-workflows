// AI-DLC's own records: audit shards, workflow state, hook health, session folder. Each row keeps every field
// (rowEntries) for lib-rows.ts to shape; what reaches safe.json is decided there.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Prompt } from "./lib-transcripts.ts";
import type { AidlcTools, Intent } from "./lib-project.ts";

export type AuditRow = { ts: string; event: string; fields: Record<string, string>; intent: string };

// The session a row was recorded for (its Session field), kept beside the row and never in safe.json.
export const rowSession = new WeakMap<AuditRow, string>();
// Every field of a row in the order the record writes them, each read the way AI-DLC reads it (its first
// occurrence); lib-rows.ts shapes them for safe.json.
export const rowEntries = new WeakMap<AuditRow, [string, string][]>();
const FIELD_LINE = /^\s*(?:-\s+)?\*\*([^*\n]{1,80})\*\*:/gm;

// The fields the collector itself reads off a row (the Units for the dictionary, a guard switch's scope); safe.json
// carries every field of every row through lib-rows.ts instead.
export const AUDIT_FIELDS = new Set([
  "Stage", "Stage slug", "Current Stage", "Next Stage", "Phase", "Lifecycle Phase", "Unit", "Tool", "Guard", "Sensor ID",
  "Direction", "Exit Code", "Error Fingerprint", "Findings count", "Revision count", "Revision Count", "State Validity",
  "Status", "Verdict", "Result", "Harness", "Cap layer", "Fallback driver", "Failed Bolt", "Checkpoint", "Source", "Target",
  "Scope",
]);

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
      safe[k] = v.slice(0, 120);
    }
    const row: AuditRow = { ts, event, fields: safe, intent };
    if (fields.Session) rowSession.set(row, fields.Session);
    const entries: [string, string][] = [];
    const seen = new Set<string>();
    for (const m of block.matchAll(FIELD_LINE)) {
      const name = m[1].trim();
      if (seen.has(name)) continue;
      seen.add(name);
      const value = field(block, name);
      if (value !== null) entries.push([name, value]);
    }
    rowEntries.set(row, entries);
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
  if (days !== asked && givenSince === null) notes.push("--days was not a number of days from 1 to 366; left out, so the window is 7 days");
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

// The HUMAN_TURN rows AI-DLC's prompt hook wrote while this report was made are the report's, not the run's. In a
// session a report message names, every row of that session from two seconds before its first report message on (the
// part of the session the chat-log readers count as the report's too). A row with no session, or a report message
// with none, is read by time only: a row from two seconds before to ten seconds after such a message (another chat's
// turns later on stay the run's), except a row of a session the run's own replies name. A Kiro message carries its
// session folder's name (`sessionLoose`), which the Kiro IDE adapter may not record as the row's Session
// (aidlc-kiro-adapter.ts terminalSessionId): when no HUMAN_TURN row names it, it is read by time only. Which reply took
// which row is not decided here: replies and rows both keep their time and session label for the reader.
export function withoutReportTurns(rows: AuditRow[], prompts: Prompt[]): AuditRow[] {
  const turns = rows.filter((r) => r.event === "HUMAN_TURN");
  const named = new Set(turns.map((r) => rowSession.get(r)).filter(Boolean));
  const starts = new Map<string, number>();
  const loose: number[] = [];
  const all: number[] = [];
  // A reply with no time of its own (Kiro CLI v2) carries its session's last write, which says nothing about its turn.
  for (const p of prompts) {
    if (!p.report || p.inherited || p.noTime) continue;
    const t = Date.parse(p.ts);
    all.push(t);
    if (p.session && (!p.sessionLoose || named.has(p.session))) {
      if (t < (starts.get(p.session) ?? Number.POSITIVE_INFINITY)) starts.set(p.session, t);
    } else loose.push(t);
  }
  if (!all.length) return rows;
  const runChats = new Set(prompts.filter((p) => !p.report && p.session).map((p) => p.session));
  const near = (t: number, at: number[]) => at.some((m) => t >= m - 2_000 && t <= m + 10_000);
  const drop = new Set(
    turns.filter((r) => {
      const t = Date.parse(r.ts);
      const session = rowSession.get(r);
      if (!session) return near(t, all);
      const own = starts.get(session);
      return (own !== undefined && t >= own - 2_000) || (!runChats.has(session) && near(t, loose));
    }),
  );
  return rows.filter((r) => !drop.has(r));
}
