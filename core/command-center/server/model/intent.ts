import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { AuditEvent, CatalogStage, IntentModel, Liveness, PhaseKey, StageView, StoryEvent, Tokens, Recorded } from "../types";
import { readAuditDir } from "../parse/audit";
import { parseState } from "../parse/state";
import type { IntentRef } from "../parse/registry";
import { readLedgerTokens } from "../parse/ledger";
import { phaseOf } from "../parse/stage-graph";
import { buildUnits, CONSTRUCTION } from "./units";
import { deriveNeeds } from "./needs";
import { contain } from "../paths";
import { HIDDEN_EVENTS, storyEvents, tokenCount, tokenEvents } from "./story";

export function recordDirOf(root: string, ref: IntentRef) { return join(root, "aidlc/spaces", ref.space, "intents", ref.dir); }

/** Text of `p` when it realpath-resolves inside `base`; throws "outside" when it exists but escapes, else "missing". */
async function readInside(base: string, p: string): Promise<string> {
  const q = await contain(base, p);
  if (!q) throw new Error(await lstat(p).then(() => "outside", () => "missing"));
  return Bun.file(q).text();
}

async function readDirective(rec: string, base: string): Promise<{ stage: string | null; unit: string | null; kind: string | null; mtime: string | null }> {
  for (const p of [".aidlc-engine/active-directive.json", ".aidlc-active-directive.json"]) {
    try {
      const q = await contain(base, join(rec, p)); if (!q) continue;
      const f = Bun.file(q); const d = JSON.parse(await f.text());
      return { stage: d.stage ?? null, unit: d.unit ?? (Array.isArray(d.units) ? d.units[0] ?? null : null), kind: typeof d.kind === "string" ? d.kind : null, mtime: new Date(f.lastModified).toISOString().replace(/\.\d+Z$/, "Z") };
    } catch { /* next */ }
  }
  return { stage: null, unit: null, kind: null, mtime: null };
}

const UNIT_HEAD = /^#{2,3}\s+(?:\d+\.\s+)?`?([a-z0-9][a-z0-9-]*)`?\s+—\s+kind\b/gm;
/** Planned units from units-generation's unit-of-work.md: rows of a `Unit ID` table, else distinct `name — kind` headings; null when absent or prose only. */
export function countPlannedUnits(md: string): number | null {
  const lines = md.split("\n"); const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]!) || !cells(lines[i]!).some((c) => /^unit id$/i.test(c))) continue;
    let n = 0;
    for (let j = i + 1; j < lines.length && /^\s*\|/.test(lines[j]!); j++) if (!cells(lines[j]!).every((c) => /^:?-+:?$/.test(c))) n++;
    return n || null;
  }
  const names = new Set([...md.matchAll(UNIT_HEAD)].map((m) => m[1]!));
  return names.size || null;
}
async function plannedUnits(rec: string, base: string): Promise<number | null> {
  try { return countPlannedUnits(await readInside(base, join(rec, "inception/units-generation/unit-of-work.md"))); } catch { return null; }
}
/** Audit events, read only when the audit dir realpath-resolves inside `<root>/aidlc`. */
export async function readContainedAudit(root: string, rec: string): Promise<{ events: AuditEvent[]; unparsed: number; texts: Map<string, string> }> {
  const d = await contain(join(root, "aidlc"), join(rec, "audit"));
  return d ? readAuditDir(d, join(root, "aidlc")) : { events: [], unparsed: 0, texts: new Map() };
}
/** Ledger tokens, treated as absent when the ledger realpath-resolves outside `<root>/aidlc`. */
export async function readContainedLedger(root: string, uuid: string | null): ReturnType<typeof readLedgerTokens> {
  const p = join(root, "aidlc/.aidlc-sessions/usage-ledger.json");
  if (!(await contain(join(root, "aidlc"), p)) && (await Bun.file(p).exists())) return { recorded: false, reason: "Usage ledger resolves outside the workspace; not read." };
  return readLedgerTokens(root, uuid);
}

/**
 * Builds the intent model. Every read is realpath-contained in `<root>/aidlc`: a record dir that exists but
 * resolves outside it throws (home reports the workspace as partial); escaping record files are treated as unreadable.
 */
export async function buildIntent(root: string, ref: IntentRef, catalog: CatalogStage[], now = new Date()): Promise<IntentModel> {
  const base = join(root, "aidlc"); const rec = recordDirOf(root, ref); const notes: string[] = [];
  if ((await lstat(rec).then(() => true, () => false)) && !(await contain(base, rec))) throw new Error(`record dir ${ref.space}/${ref.dir} resolves outside the workspace`);
  let stateMd = ""; try { stateMd = await readInside(base, join(rec, "aidlc-state.md")); } catch (e) { notes.push((e as Error).message === "outside" ? "aidlc-state.md resolves outside the workspace; not read" : "aidlc-state.md could not be read"); }
  const state = parseState(stateMd);
  const { events, unparsed } = await readContainedAudit(root, rec);
  const completed = new Set(events.filter((e) => e.event === "STAGE_COMPLETED").map((e) => e.fields.Stage));
  const firstStart = new Map<string, string>(); const done = new Map<string, string>(); const redos = new Map<string, number>();
  for (const e of events) {
    const s = e.fields.Stage;
    if (e.event === "STAGE_STARTED" && s && !firstStart.has(s)) firstStart.set(s, e.ts);
    if (e.event === "STAGE_COMPLETED" && s) done.set(s, e.ts);
    if (e.event === "STAGE_JUMPED" && e.fields.Target) redos.set(e.fields.Target, (redos.get(e.fields.Target) ?? 0) + 1);
  }
  const dir = await readDirective(rec, base);
  const lastStart = [...events].reverse().find((e) => e.event === "UNIT_STARTED" || e.event === "STAGE_STARTED");
  const current = { stage: dir.stage ?? lastStart?.fields.Stage ?? null, unit: dir.unit ?? lastStart?.fields.Unit ?? null };
  const stateCur = state.fields["Current Stage"];
  if (stateCur && current.stage && stateCur !== current.stage) notes.push(`state file lags the audit (state says ${stateCur}, audit shows ${current.stage})`);

  const planSlugs = state.plan.length ? state.plan.map((p) => p.slug) : catalog.map((c) => c.slug);
  const phaseDirOf = (s: string) => phaseOf(catalog, s);
  const needs = await deriveNeeds(rec, events, current, phaseDirOf, dir, base);
  const unitInfo = buildUnits(events, current);
  const stages: StageView[] = planSlugs.map((slug) => {
    const p = state.plan.find((x) => x.slug === slug); const c = catalog.find((x) => x.slug === slug);
    const skip = p?.disposition === "SKIP"; const isDone = p?.mark === "x" || completed.has(slug);
    const unitActive = CONSTRUCTION.includes(slug) && unitInfo.units.some((u) => ["running", "done", "inferred", "paused"].includes(u.cells[slug] ?? ""));
    let st: StageView["state"] = skip ? "skip" : isDone ? "done" : current.stage === slug || unitActive ? "running" : "todo";
    if (st === "running" && needs.some((n) => n.stage === slug)) st = "waiting";
    return { slug, name: c?.name ?? slug, phase: c?.phase ?? "unknown", lead: c?.lead ?? "orchestrator", state: st, firstStart: firstStart.get(slug) ?? null, completed: done.get(slug) ?? null, redos: redos.get(slug) ?? 0, planned: !skip };
  });
  const planned = stages.filter((s) => s.planned); const doneCount = planned.filter((s) => s.state === "done").length;

  const last = events.at(-1)?.ts ?? null;
  const lastSession = [...events].reverse().find((e) => e.event?.startsWith("SESSION_"));
  const liveness: Liveness = last && now.getTime() - Date.parse(last) <= 120_000 ? "active" : lastSession?.event === "SESSION_ENDED" && lastSession === events.at(-1) ? "ended" : "idle";

  const ledger = await readContainedLedger(root, ref.uuid);
  let tokens: Recorded<Tokens>;
  if (ledger.recorded) tokens = { recorded: true, value: ledger.value.totals };
  else {
    const sc = tokenEvents(events);
    tokens = sc.length ? { recorded: true, value: { input: sc.reduce((a, e) => a + tokenCount(e.fields["Tokens In"])!, 0), output: sc.reduce((a, e) => a + (tokenCount(e.fields["Tokens Out"]) ?? 0), 0), cacheRead: 0, cacheWrite: 0 } } : { recorded: false, reason: ledger.reason };
  }

  const story: StoryEvent[] = storyEvents(events);
  const hiddenCounts: IntentModel["hiddenCounts"] = {};
  for (const e of events) {
    if (!e.event || !HIDDEN_EVENTS.has(e.event)) continue;
    const hk = e.fields.Stage ?? e.fields["Stage slug"] ?? "_"; const c = hiddenCounts[hk] ?? { sensorPassed: 0, sensorFired: 0, humanTurns: 0 }; hiddenCounts[hk] = c;
    if (e.event === "SENSOR_PASSED") { if (e.fields.Note?.trim()) c.sensorNotRun = (c.sensorNotRun ?? 0) + 1; else c.sensorPassed++; } else if (e.event === "SENSOR_FIRED") c.sensorFired++; else c.humanTurns++;
  }
  const reviews = events.filter((e) => e.event === "REVIEW_COMPLETED");
  const curPhase: PhaseKey = current.stage ? phaseOf(catalog, current.stage) : "unknown";
  return {
    key: `${ref.space}/${ref.dir}`, workspace: root, space: ref.space, dir: ref.dir, uuid: ref.uuid,
    name: ref.slug, title: state.fields.Project && !/^\[.*\]$/.test(state.fields.Project) ? state.fields.Project.slice(0, 140) : null,
    scope: ref.scope ?? state.fields.Scope ?? null, depth: state.fields.Depth ?? null, started: state.fields["Start Date"] ?? firstStart.values().next().value ?? null,
    status: ref.status, stages, plannedCount: planned.length, doneCount, skippedCount: stages.length - planned.length,
    current: { ...current, phase: curPhase }, units: unitInfo.units, unitsPlanned: (await plannedUnits(rec, base)) ?? unitInfo.planned, unitsDone: unitInfo.done,
    needs, liveness, lastEventTs: last, tokens, reviews: { ready: reviews.filter((e) => e.fields.Verdict === "READY").length, notReady: reviews.filter((e) => e.fields.Verdict === "NOT-READY").length },
    events: story, notes, unparsed, hiddenCounts,
  };
}
