// Pure, client-side derivations for the focused-intent view (no React, no fetch) — unit-tested in tests/intent-derive.test.ts.
import type { IntentModel, Liveness, PhaseKey, StageView, StoryEvent, UnitRow } from "../../../../core/command-center/server/types";
import { fmtAgo } from "../format";

export type LensName = "Story" | "Decisions" | "Artifacts" | "Reviews" | "Issues" | "Units" | "Learnings" | "Timeline" | "Tokens";
export const LENSES: LensName[] = ["Story", "Decisions", "Artifacts", "Reviews", "Issues", "Units", "Learnings", "Timeline", "Tokens"];
/** `#/i/…/<slug>` ↔ lens; the slug is the lower-cased name ("learnings"). */
export const lensFromSlug = (s: string | null): LensName => LENSES.find((l) => l.toLowerCase() === (s ?? "").toLowerCase()) ?? "Story";
export const FIVE: Exclude<PhaseKey, "unknown">[] = ["initialization", "ideation", "inception", "construction", "operation"];
export const CONSTRUCTION = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation", "build-and-test", "ci-pipeline"];
/** Short column labels for the core per-unit stages; any other stage falls back to `unitLabel`. */
export const CSHORT: Record<string, string> = { "functional-design": "FD", "nfr-requirements": "NFR-req", "nfr-design": "NFR-design", "infrastructure-design": "Infra", "code-generation": "Code-gen", "build-and-test": "Build & test", "ci-pipeline": "CI" };

/** A unit-matrix column label: the short core label, else the stage's catalog name, else its slug. */
export const unitLabel = (slug: string, stages: readonly { slug: string; name: string }[]) =>
  CSHORT[slug] ?? stages.find((s) => s.slug === slug)?.name ?? slug;

const HOUR = 3_600_000;
export const GAP_MS = 2 * HOUR;

/** "1h 04m" · "45m" · "30s" · "2d 3h". */
export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000); if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const t = (iso: string) => Date.parse(iso);

/** `/…/intents/<dir>/ideation/intent-capture/x.md` → `ideation/intent-capture/x.md` (record-relative); otherwise the input. */
export function recordRel(path: string, dir: string): string {
  const k = `/intents/${dir}/`; const ix = path.lastIndexOf(k);
  return ix >= 0 ? path.slice(ix + k.length) : path.replace(/^.*\/aidlc\//, "aidlc/");
}
const fileOf = (e: StoryEvent) => e.raw?.fields?.File ?? null;

export type AttrHow = "event" | "file" | "jump" | "park" | "timing";
/** `unitInferred`: the entry names no unit; `aUnit` is the unit running at that moment. */
export interface AEvent extends StoryEvent { idx: number; aStage: string | null; aUnit: string | null; how: AttrHow | null; unitInferred: boolean }

/**
 * Gives every event the stage (and unit) it belongs to. The audit names a stage on most events; for the rest:
 * artifacts → the record path (`<phase>/<stage>/…`, `construction/<unit>/<stage>/…`); STAGE_JUMPED → its Target;
 * WORKFLOW_UNPARKED → the stage that parked; anything else → the stage (and unit) running at that moment ("timing").
 */
export function attribute(m: Pick<IntentModel, "events" | "stages" | "dir"> & { unitStages?: string[] }): AEvent[] {
  const slugs = new Set(m.stages.map((s) => s.slug));
  const perUnit = m.unitStages ?? CONSTRUCTION;
  let cur: { stage: string | null; unit: string | null } = { stage: null, unit: null };
  let parked: { stage: string | null; unit: string | null } | null = null;
  return m.events.map((e, idx) => {
    let aStage = e.stage; let aUnit = e.unit; let how: AttrHow | null = e.stage ? "event" : null; let unitInferred = false;
    if (!aStage && e.kind.startsWith("ARTIFACT_") && fileOf(e)) {
      const seg = recordRel(fileOf(e)!, m.dir).split("/");
      if (seg[0] === "construction" && seg[2] && slugs.has(seg[2])) { aStage = seg[2]; aUnit = seg[1]!; how = "file"; }
      else if (seg[1] && slugs.has(seg[1])) { aStage = seg[1]; how = "file"; }
    }
    if (!aStage && e.kind === "STAGE_JUMPED" && e.raw?.fields?.Target) { aStage = e.raw.fields.Target; how = "jump"; }
    if (!aStage && e.kind === "WORKFLOW_UNPARKED" && parked?.stage) { aStage = parked.stage; aUnit = parked.unit; how = "park"; }
    if (!aStage && cur.stage) { aStage = cur.stage; aUnit = cur.unit; how = "timing"; unitInferred = !!cur.unit; }
    else if (aStage && !aUnit && cur.unit && aStage === cur.stage && perUnit.includes(aStage) && e.kind !== "STAGE_STARTED") { aUnit = cur.unit; unitInferred = true; }
    if (e.kind === "STAGE_STARTED" && e.stage) cur = { stage: e.stage, unit: null };
    if ((e.kind === "UNIT_STARTED" || e.kind === "UNIT_RESUMED") && e.stage) cur = { stage: e.stage, unit: e.unit };
    if (e.kind === "STAGE_COMPLETED" && e.stage && e.stage === cur.stage) cur = { stage: null, unit: null };
    if (e.kind === "WORKFLOW_PARKED") parked = { stage: aStage, unit: aUnit };
    return { ...e, idx, aStage, aUnit, how, unitInferred };
  });
}

/** [start, end) spans the workflow was parked (WORKFLOW_PARKED → next WORKFLOW_UNPARKED; an open park runs to `now`). */
export function parkedSpans(events: StoryEvent[], now = Date.now()): [number, number][] {
  const out: [number, number][] = []; let open: number | null = null;
  for (const e of events) {
    if (e.kind === "WORKFLOW_PARKED" && open === null) open = t(e.ts);
    else if (e.kind === "WORKFLOW_UNPARKED" && open !== null) { out.push([open, t(e.ts)]); open = null; }
  }
  if (open !== null) out.push([open, now]);
  return out;
}
const overlap = (a: number, b: number, spans: [number, number][]) => spans.reduce((acc, [s, e]) => acc + Math.max(0, Math.min(b, e) - Math.max(a, s)), 0);

export interface Timed { calendarMs: number; parkedMs: number; agentMs: number }
export function timeSpan(start: string | null, end: string | null, spans: [number, number][]): Timed | null {
  if (!start || !end) return null;
  const a = t(start); const b = t(end); if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  const parkedMs = overlap(a, b, spans);
  return { calendarMs: b - a, parkedMs, agentMs: b - a - parkedMs };
}
/** Header "Stage time (unparked)": elapsed, not agent working time; the sum over stages with both a first start and a completion, minus parked spans. */
export function agentTime(m: Pick<IntentModel, "stages" | "events">, now = Date.now()): { ms: number; stages: number } | null {
  const spans = parkedSpans(m.events, now); let ms = 0; let n = 0;
  for (const s of m.stages) { const x = timeSpan(s.firstStart, s.completed, spans); if (x) { ms += x.agentMs; n++; } }
  return n ? { ms, stages: n } : null;
}

export type PhaseState = "done" | "running" | "waiting" | "todo" | "skip";
export function phaseCounts(stages: StageView[], p: PhaseKey): { done: number; planned: number; skipped: number; state: PhaseState } {
  const all = stages.filter((s) => s.phase === p); const pl = all.filter((s) => s.planned);
  const done = pl.filter((s) => s.state === "done").length; const skipped = all.length - pl.length;
  const state: PhaseState = pl.some((s) => s.state === "waiting") ? "waiting" : pl.some((s) => s.state === "running") ? "running"
    : pl.length && done === pl.length ? "done" : !pl.length && skipped ? "skip" : "todo";
  return { done, planned: pl.length, skipped, state };
}

export type UnitGlyph = "waiting" | "running" | "paused" | "done" | "todo";
/** A unit's rail state; done matches the server's unitsDone rule (code-generation done or inferred). */
export function unitState(u: UnitRow): UnitGlyph {
  const c = Object.values(u.cells);
  if (c.includes("waiting")) return "waiting";
  if (c.includes("running")) return "running";
  if (c.includes("paused")) return "paused";
  if (u.cells["code-generation"] === "done" || u.cells["code-generation"] === "inferred") return "done";
  return "todo";
}
export const sortUnits = (us: UnitRow[]) => [...us].sort((a, b) => (a.batch ?? 1e9) - (b.batch ?? 1e9));

/** Events for a stage (+unit), cut at `replayAt` when replaying. */
export function storyEvents(all: AEvent[], stage: string | null, unit: string | null, replayAt: string | null): AEvent[] {
  const cut = replayAt ? t(replayAt) : Infinity;
  return all.filter((e) => e.aStage === stage && (!unit || e.aUnit === unit) && t(e.ts) <= cut);
}

/**
 * A rendered Story row: one event, or a fold. Folds are anchored at their first member and gather, across the whole
 * selection (not only consecutive entries): every SENSOR_FAILED into one row, and every write/edit of one file into one row.
 */
export interface Row { e: AEvent; count: number; file: string | null; last: AEvent; members: AEvent[] }
export function fold(evs: AEvent[], dir: string): Row[] {
  const out: Row[] = []; const byFile = new Map<string, Row>(); let sensors: Row | null = null;
  for (const e of evs) {
    const f = e.kind.startsWith("ARTIFACT_C") || e.kind.startsWith("ARTIFACT_U") ? (fileOf(e) ? recordRel(fileOf(e)!, dir) : null) : null;
    const into = f ? byFile.get(f) : e.kind === "SENSOR_FAILED" ? sensors : null;
    if (into) { into.count++; into.last = e; into.members.push(e); continue; }
    const r: Row = { e, count: 1, file: f, last: e, members: [e] };
    out.push(r);
    if (f) byFile.set(f, r); else if (e.kind === "SENSOR_FAILED") sensors = r;
  }
  return out;
}

/** Liveness as of `now`: the server's value decays on the client — active only within 2 min of the newest event; ended stays ended. */
export const ACTIVE_MS = 120_000;
export function liveNow(liveness: Liveness, lastEventTs: string | null, now: number): Liveness {
  if (liveness === "ended") return "ended";
  const last = lastEventTs ? t(lastEventTs) : NaN;
  return Number.isFinite(last) && now - last <= ACTIVE_MS ? "active" : "idle";
}
/** "■ ENDED · last event 3h 2m ago" / "◌ IDLE · last event …" (null when active). */
export function restLabel(l: Liveness, lastEventTs: string | null, now: number): string | null {
  if (l === "active") return null;
  return `${l === "ended" ? "■ ENDED" : "◌ IDLE"} · last event ${lastEventTs ? fmtAgo(lastEventTs, now) : "not recorded"}`;
}

export type Group = "Artifacts" | "Decisions" | "Review" | "Errors" | "Other";
export const GROUPS: Group[] = ["Artifacts", "Decisions", "Review", "Errors", "Other"];
export function groupOf(kind: string): Group {
  if (kind.startsWith("ARTIFACT_")) return "Artifacts";
  if (/^(DECISION_RECORDED|QUESTION_ANSWERED|GATE_|STAGE_AWAITING_APPROVAL|SUMMARY_CONFIRMATION|PLAN_APPROVAL)/.test(kind)) return "Decisions";
  if (kind.startsWith("REVIEW")) return "Review";
  if (kind === "ERROR_LOGGED" || kind === "SENSOR_FAILED") return "Errors";
  return "Other";
}

/** Index of the last event at or before `ts` (for the scrubber head). */
export function indexAt(events: StoryEvent[], ts: string): number {
  const c = t(ts); let ix = 0;
  events.forEach((e, i) => { if (t(e.ts) <= c) ix = i; });
  return ix;
}
export const phaseOfStage = (stages: StageView[], slug: string | null): PhaseKey => stages.find((s) => s.slug === slug)?.phase ?? "unknown";
/** "aidlc-product-agent" → "product agent". */
export const leadLabel = (lead: string) => lead === "orchestrator" ? "orchestrator" : `${lead.replace(/^aidlc-/, "").replace(/-agent$/, "")} agent`;
