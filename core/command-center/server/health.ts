// "Needs fixing": every failure, refusal, guard bypass and stalled run AIDLC leaves on disk, per intent record and per
// workspace, as Issues. Read-only: every read is realpath-contained in the registered workspace's `aidlc/` folder (the
// opt-in transcript scan, in transcripts.ts, is contained in `~/.claude/projects/`). Nothing is written anywhere.
import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Found } from "./discovery";
import {
  checkpointState, classifyDrop, classifyError, DROP_META, guardRefusalState, heartbeatStates, noteHint, parseDrops,
  refusalRemedies, remedyText, sensorNotRun, stopCounterStalled,
} from "./health-classify";
import {
  COVERAGE_NOTE, countIssues, HEARTBEAT_HOOKS, hookPhaseOf, type HealthCounts, type HealthCoverage, type HealthPayload, type HookRow,
  type Issue, type IssueEvidence, type IssueGroup, type Recoverable, type ScopedIssue, type SupportingFile, type SupportingKind, type TranscriptCoverage, phasesLabel,
} from "./hooks-map";
import {
  checkpointCause, dropCause, errorCause, evidenceFrom, guardAskCause, guardRecordCause, hookNotRunningCause, sensorFailedCause, sensorNotRunCause, stallCause,
} from "./issue-cause";
import { recordDirOf, readContainedAudit } from "./model/intent";
import { readAuditDir } from "./parse/audit";
import { loadCatalog } from "./parse/stage-graph";
import { listIntents, safeDirName, type IntentRef } from "./parse/registry";
import { parseState } from "./parse/state";
import { contain, rewriteRecordedPath } from "./paths";
import type { AuditEvent } from "./types";
import { DEFAULT_PROJECTS_ROOT, scanTranscripts, transcriptTargets } from "./transcripts";

type TxStats = { status: TranscriptCoverage; runs: number; failures: number; reprompts: number };

export interface HealthOpts {
  /** The opt-in transcript scan (Settings → "Read hook failures from Claude Code transcripts"). */
  scanTranscripts?: boolean;
  projectsRoot?: string;
  /** `AIDLC_HOOK_TRACE_DIR` as the dashboard sees it; read only when it lies inside a registered workspace. */
  traceDir?: string | null;
}

/** The "Needs fixing" options the current config and environment call for. */
export function healthOptsOf(c: { config?: { settings?: { scanTranscripts: boolean } }; transcriptsRoot?: string; traceDir?: string | null }): HealthOpts {
  return { scanTranscripts: c.config?.settings?.scanTranscripts === true, projectsRoot: c.transcriptsRoot, traceDir: c.traceDir ?? null };
}

const MAX_FILE = 1024 * 1024;
/** Audit shards are re-read in full for evidence line numbers (as readAuditDir reads them); larger ones get none. */
const MAX_SHARD = 64 * 1024 * 1024;
const MAX_MSG = 4000;
const HOUR = 3_600_000;
const STALE_MARKERS: [rel: string, ttlMs: number][] = [["aidlc/.aidlc-compose-pending", 24 * HOUR], ["aidlc/.aidlc-subagent-inflight", 2 * HOUR]];
const DISPATCH_TTL = 6 * HOUR;

const hid = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const isoOf = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const clipMsg = (s: string) => (s.length > MAX_MSG ? `${s.slice(0, MAX_MSG - 1)}…` : s);
const hint = (text: string) => ({ text, source: "hint" as const });

/** Text of `p` when it realpath-resolves inside `base` and is a regular file (at most the last MAX_FILE bytes), else null. */
async function readIn(base: string, p: string): Promise<{ text: string; mtime: number; real: string } | null> {
  const q = await contain(base, p); if (!q) return null;
  try {
    const st = await stat(q); if (!st.isFile()) return null;
    return { text: await Bun.file(q).slice(Math.max(0, st.size - MAX_FILE), st.size).text(), mtime: st.mtimeMs, real: q };
  } catch { return null; }
}
async function listIn(base: string, dir: string): Promise<string[]> {
  const d = await contain(base, dir); if (!d) return [];
  try { return (await readdir(d)).sort(); } catch { return []; }
}
const realOf = (p: string) => realpath(p).catch(() => p);
const json = (t: string | undefined): unknown => { if (t === undefined) return null; try { return JSON.parse(t); } catch { return null; } };

/** Builds issues with the shared bookkeeping (ids, folding, needs-fixing). */
class Collector {
  issues: Issue[] = [];
  private folds = new Map<string, Issue>();
  /** `real`: the workspace's realpath, since contained paths come back realpath-resolved (macOS /tmp is /private/tmp). */
  constructor(readonly root: string, private real: string = root) {}
  private texts = new Map<string, Promise<string[] | null>>();
  /** Shard texts already read with the audit (by absolute path), so evidence does not read them again. */
  seed(dir: string, texts: Map<string, string>) { for (const [n, t] of texts) this.texts.set(join(dir, n), Promise.resolve(t.split("\n"))); }
  /** Every line of a file contained in `<root>/aidlc` (read once per build), or null. */
  linesOf(abs: string): Promise<string[] | null> {
    let p = this.texts.get(abs);
    if (!p) {
      p = (async () => {
        const q = await contain(join(this.root, "aidlc"), abs); if (!q) return null;
        try { const st = await stat(q); if (!st.isFile() || st.size > MAX_SHARD) return null; return (await Bun.file(q).text()).split("\n"); } catch { return null; }
      })();
      this.texts.set(abs, p);
    }
    return p;
  }
  /** The audit block of `e` with its shard line numbers, the heading line emphasised. */
  async auditEvidence(e: AuditEvent, auditDir: string, supporting: (SupportingFile | null)[] = []): Promise<IssueEvidence | null> {
    if (!e.line) return null;
    const abs = join(auditDir, e.shard); const lines = await this.linesOf(abs); if (!lines) return null;
    return evidenceFrom(this.rel(abs), lines, e.line, e.endLine ?? e.line, e.line, supporting.filter((x): x is SupportingFile => !!x));
  }
  /** Lines of a contained file as evidence: all of it (clipped), or `start`..`end`, emphasising `focus` (a line number or the first line matching). */
  async fileEvidence(abs: string, o: { start?: number; end?: number; focus?: number | RegExp | null } = {}, supporting: (SupportingFile | null)[] = []): Promise<IssueEvidence | null> {
    const cached = await this.linesOf(abs); if (!cached) return null;
    const lines = [...cached]; // the cache is shared: never trim it in place
    while (lines.length > 1 && lines.at(-1) === "") lines.pop();
    const focus = o.focus instanceof RegExp ? (() => { const i = lines.findIndex((l) => (o.focus as RegExp).test(l)); return i < 0 ? null : i + 1; })() : o.focus ?? null;
    return evidenceFrom(this.rel(abs), lines, o.start ?? 1, o.end ?? lines.length, focus, supporting.filter((x): x is SupportingFile => !!x));
  }
  /** A supporting file, when it is a regular file contained in `<root>/aidlc`. */
  async support(abs: string, label: string, kind: SupportingKind): Promise<SupportingFile | null> {
    const q = await contain(join(this.root, "aidlc"), abs); if (!q) return null;
    try { if (!(await stat(q)).isFile()) return null; } catch { return null; }
    return { path: this.rel(abs), label, kind };
  }
  rel(abs: string) {
    for (const base of [this.root, this.real]) { const r = relative(base, abs); if (r && !r.startsWith("..") && !isAbsolute(r)) return r.split("\\").join("/"); }
    return abs;
  }
  add(i: Omit<Issue, "id" | "count" | "needsFixing"> & { count?: number }, fold?: string): Issue {
    if (fold) {
      const f = this.folds.get(fold);
      if (f && !f.resolved) {
        f.count += i.count ?? 1;
        if (i.at && (!f.at || i.at >= f.at)) { f.at = i.at; if (i.detail) f.detail = i.detail; if (i.cause !== undefined) f.cause = i.cause; if (i.evidence !== undefined) f.evidence = i.evidence; }
        if (i.at && (!f.firstAt || i.at < f.firstAt)) f.firstAt = i.at;
        return f;
      }
    }
    const it: Issue = { cause: null, evidence: null, ...i, id: hid(`${fold ?? ""}|${i.source.file}|${i.source.line ?? ""}|${i.kind}|${i.message}|${i.at ?? ""}|${this.issues.length}`), count: i.count ?? 1, firstAt: i.at, needsFixing: false };
    this.issues.push(it); if (fold) this.folds.set(fold, it);
    return it;
  }
  remove(i: Issue) { this.issues = this.issues.filter((x) => x !== i); for (const [k, v] of this.folds) if (v === i) this.folds.delete(k); }
  finish(): Issue[] {
    for (const i of this.issues) {
      i.needsFixing = !i.resolved && (i.group === "hard-stop" || i.group === "failure" || (i.group === "refused" && (i.count >= 3 || i.kind.endsWith("(terminal)"))));
      if (i.firstAt === i.at) delete i.firstAt;
    }
    return this.issues;
  }
}

const stageOf = (e: AuditEvent) => e.fields.Stage ?? e.fields["Stage slug"] ?? null;
const unitOf = (e: AuditEvent) => e.fields.Unit ?? null;
const BLOCK_HOOK: Record<string, string> = { PLAN_APPROVAL_BLOCKED: "plan-approval-guard", REVIEW_FREEZE_BLOCKED: "review-freeze", REVIEWER_SCOPE_BLOCKED: "reviewer-scope" };
const observedHook = (by: string | undefined) => (by && /^aidlc-[a-z-]+$/.test(by) ? by.replace(/^aidlc-/, "") : undefined);

/** Audit-derived issues: errors, guard blocks and bypasses, sensors, Bolts and swarm units, practices, compaction. */
/** `eng`: the record's `.aidlc-engine` folder, where the supporting files (sensor details, guard-refusal records) live. */
async function fromEvents(c: Collector, events: AuditEvent[], auditDir: string, slugs: ReadonlySet<string> = new Set(), eng: string | null = null) {
  let cur: { stage: string | null; unit: string | null } = { stage: null, unit: null };
  const sensors = new Map<string, { failed: Issue | null; notRun: Issue | null }>();
  /** The latest `Gate effect` each sensor issue was recorded with (absent → advisory). */
  const effect = new Map<Issue, string>();
  /** Reset boundaries per stage+unit, computed once (guard-refusal folding and resolution both ask for them). */
  const resets = new Map<string, string[]>();
  const disabled = new Map<string, Issue>();
  const compactions: Issue[] = [];
  const practices: Issue[] = [];
  const bolts = new Map<string, Issue[]>();
  const src = (e: AuditEvent) => ({ file: c.rel(join(auditDir, e.shard)), ...(e.line ? { line: e.line } : {}) });
  const ev0 = (e: AuditEvent, supporting: (SupportingFile | null)[] = []) => c.auditEvidence(e, auditDir, supporting);
  for (const e of events) {
    const f = e.fields; const ev = e.event ?? "";
    if (ev === "STAGE_STARTED" && f.Stage) cur = { stage: f.Stage, unit: null };
    if ((ev === "UNIT_STARTED" || ev === "UNIT_RESUMED") && f.Stage) cur = { stage: f.Stage, unit: f.Unit ?? null };
    const named = stageOf(e);
    const where = named ? { stage: named, unit: unitOf(e) } : { stage: cur.stage, unit: cur.unit, inferred: cur.stage ? "stage inferred from timing: this entry names no stage" : null };
    switch (ev) {
      case "ERROR_LOGGED": {
        const k = classifyError(f); const hook = observedHook(f["Observed By"]);
        // A typed guard refusal ends in its JSON ask: the message is the sentence before it (the codes go in the detail).
        const raw = f.Error ?? ""; const cut = k.kind === "Guard refusal" ? raw.lastIndexOf('{"kind"') : -1;
        const message = (cut > 0 ? raw.slice(0, cut).trim() : raw) || "(no error text recorded)";
        const detail = [k.detail, f.Command ? `Command: ${f.Command.slice(0, 300)}` : null, f["Exit Code"] ? `exit ${f["Exit Code"]}` : null, f.Source ? `source ${f.Source}` : null].filter(Boolean).join(" · ") || undefined;
        const w = k.askStage ? { stage: k.askStage, unit: k.askUnit ?? null } : where;
        const guard = k.kind === "Guard refusal";
        const refusalFile = guard && eng && w.stage ? join(eng, "guard-refusals", `${createHash("sha256").update(`${w.stage}\0${w.unit ?? ""}`, "utf-8").digest("hex")}.json`) : null;
        const evidence = await ev0(e, [refusalFile ? await c.support(refusalFile, "the guard-refusal record for this stage", "guard-refusal") : null]);
        const cause = guard ? guardAskCause(raw, f) : errorCause(f);
        c.add({ group: k.group, resolved: null, at: e.ts, where: { ...w, tool: f.Tool, ...(hook ? { hook, hookPhase: hookPhaseOf(hook) } : {}) }, kind: k.terminal ? "Guard refusal (terminal)" : k.kind, message: clipMsg(message), detail, recoverable: k.recoverable, fix: k.fix, source: src(e), cause, evidence },
          `err|${k.kind}|${f.Tool ?? ""}|${w.stage ?? ""}|${w.unit ?? ""}|${f.Error ?? ""}|${k.kind === "Guard refusal" ? lastResetBefore(events, e.ts, w.stage ?? null, w.unit ?? null, resets) : ""}`);
        break;
      }
      case "PLAN_APPROVAL_BLOCKED": case "REVIEW_FREEZE_BLOCKED": case "REVIEWER_SCOPE_BLOCKED": {
        const hook = BLOCK_HOOK[ev]!;
        const message = f.Reason ?? f.Details ?? `${ev}: ${f.Tool ?? "a tool call"}${f.Target ? ` on ${f.Target}` : ""}`;
        c.add({ group: "refused", resolved: null, at: e.ts, where: { ...where, hook, hookPhase: "PreToolUse", tool: f.Tool }, kind: "Guard block", message: clipMsg(message), detail: f.Target ? `Target: ${f.Target}` : undefined, recoverable: "yes", fix: hint("The guard blocked the call as designed; the agent has to satisfy it first (the message says what is missing)."), source: src(e), evidence: await ev0(e) },
          `blk|${ev}|${f.Tool ?? ""}|${f.Target ?? ""}|${where.stage ?? ""}|${where.unit ?? ""}`);
        break;
      }
      case "GUARD_DISABLED": {
        const g = f.Guard ?? "a guard";
        const it = c.add({ group: "bypass", resolved: null, at: e.ts, where: { ...where, hook: f.Guard, hookPhase: hookPhaseOf(f.Guard), tool: f.Tool }, kind: "Bypass · guard disabled", message: clipMsg(f.Details ?? `${g} is switched off; calls pass without enforcement`), recoverable: "needs-you", fix: hint("Turn the guard back on when the reason for switching it off is gone."), source: src(e), evidence: await ev0(e) }, `gd|${g}`);
        disabled.set(g, it);
        break;
      }
      case "GUARD_RESTORED": { const it = disabled.get(f.Guard ?? "a guard"); if (it && !it.resolved) it.resolved = { by: "GUARD_RESTORED", at: e.ts }; disabled.delete(f.Guard ?? "a guard"); break; }
      case "GUARD_STOOD_ASIDE": {
        const grant = f.Grant && f.Grant !== "none" ? `: ${f.Grant}` : "";
        c.add({ group: "bypass", resolved: null, at: e.ts, where: { ...where, hook: f.Guard, hookPhase: hookPhaseOf(f.Guard), tool: f.Tool }, kind: "Bypass · guard stood aside", message: `${f.Guard ?? "A guard"} stood aside for the ${f.Actor ?? "caller"} on ${f.Authority ?? "an authority"}${grant}`, detail: f.Details ? clipMsg(f.Details) : undefined, recoverable: "yes", fix: null, source: src(e), evidence: await ev0(e) },
          `gsa|${f.Guard}|${f.Authority}|${f.Grant}|${f.Actor}|${f.Tool}`);
        break;
      }
      case "PLAN_APPROVAL_OVERRIDDEN":
        c.add({ group: "bypass", resolved: null, at: e.ts, where, kind: "Bypass · plan approval overridden", message: clipMsg(f.Reason ?? f.Details ?? "Plan approval was overridden"), recoverable: "yes", fix: null, source: src(e), evidence: await ev0(e) });
        break;
      case "SENSOR_FAILED": case "SENSOR_PASSED": case "SENSOR_BUDGET_OVERRIDE": {
        // Per output file, as AIDLC groups them (aidlc-dashboard-stage-detail.ts): a pass on another file is not a re-run.
        // A unit-less row on a per-unit file (`construction/<unit>/<stage>/…`) belongs to that unit, marked as inferred.
        const fromPath = !where.unit && named ? unitFromPath(f["Output path"], named, slugs) : null;
        const sw = fromPath ? { stage: named, unit: fromPath, inferred: "from the file path" } : where;
        const id = f["Sensor ID"] ?? f.Sensor ?? "sensor"; const key = `${id}|${sw.stage ?? ""}|${sw.unit ?? ""}|${f["Output path"] ?? ""}`;
        const s = sensors.get(key) ?? { failed: null, notRun: null }; sensors.set(key, s);
        const note = ev === "SENSOR_PASSED" ? sensorNotRun(f) : ev === "SENSOR_BUDGET_OVERRIDE" ? (f.Reason ?? "budget exceeded (timed out)") : null;
        if (ev === "SENSOR_PASSED" && !note) {
          for (const k of ["failed", "notRun"] as const) { const it = s[k]; if (it && !it.resolved) it.resolved = { by: "a later passing run of the same check", at: e.ts }; s[k] = null; }
          break;
        }
        if (ev === "SENSOR_FAILED") {
          const n = f["Findings count"]; const detailPath = f["Detail path"] ? rewriteDetail(f["Detail path"], c) : null;
          const detailAbs = detailPath && !isAbsolute(detailPath) ? join(c.root, detailPath) : null;
          const detail = detailAbs ? await readIn(join(c.root, "aidlc"), detailAbs) : null;
          const cause = sensorFailedCause(f, detail?.text ?? null);
          const evidence = await ev0(e, [detailAbs ? await c.support(detailAbs, `${id} findings (the sensor's detail file)`, "sensor-detail") : null]);
          const it = s.failed && !s.failed.resolved ? s.failed : null;
          if (it) { it.count++; it.at = e.ts; it.message = `${id} reported ${n ?? "some"} finding${n === "1" ? "" : "s"}`; if (detailPath) it.source = { file: detailPath }; it.cause = cause; it.evidence = evidence; effect.set(it, f["Gate effect"] ?? ""); break; }
          s.failed = c.add({ group: "failure", resolved: null, at: e.ts, where: sw, kind: "Check failed", message: `${id} reported ${n ?? "some"} finding${n === "1" ? "" : "s"}`, recoverable: "yes", fix: hint("Advisory: the agent sees the findings and revises. The detail file lists what was found."), source: detailPath ? { file: detailPath } : src(e), cause, evidence });
          effect.set(s.failed, f["Gate effect"] ?? "");
          break;
        }
        const cause = sensorNotRunCause(ev, f); const evidence = await ev0(e);
        const it = s.notRun && !s.notRun.resolved ? s.notRun : null;
        if (it) { it.count++; it.at = e.ts; it.message = `${id}: ${note}`; it.cause = cause; it.evidence = evidence; effect.set(it, f["Gate effect"] ?? ""); break; }
        s.notRun = c.add({ group: "failure", resolved: null, at: e.ts, where: sw, kind: "Check did not run", message: `${id}: ${note}`, detail: ev === "SENSOR_PASSED" ? "Recorded as SENSOR_PASSED with a Note: the check did not run, so it is not counted as a pass." : undefined, recoverable: "yes", fix: noteHint(note!), source: src(e), cause, evidence });
        effect.set(s.notRun, f["Gate effect"] ?? "");
        break;
      }
      case "BOLT_FAILED": case "SWARM_UNIT_FAILED": {
        const unit = f.Unit ?? f.Bolt ?? f["Bolt names"] ?? where.unit ?? null;
        const reason = f.Reason ?? "";
        const it = c.add({ group: "failure", resolved: null, at: e.ts, where: { ...where, unit }, kind: ev === "BOLT_FAILED" ? "Bolt failed" : `Swarm unit failed${reason ? ` · ${reason}` : ""}`, message: clipMsg(f.Details ?? f.Error ?? (reason || ev)), recoverable: "needs-you", fix: reason === "unsatisfiable" ? hint("The unit cannot be satisfied as specified; its design or plan has to change.") : /exhausted/.test(reason) ? hint("The unit ran out of attempts; review what it tried before granting more.") : null, source: src(e), evidence: await ev0(e) });
        if (unit) bolts.set(unit, [...(bolts.get(unit) ?? []), it]);
        break;
      }
      case "SWARM_UNIT_CONVERGED": case "WORKTREE_MERGED": case "WORKTREE_DISCARDED": {
        const unit = f.Unit ?? f.Bolt ?? f["Bolt names"] ?? null;
        for (const it of unit ? bolts.get(unit) ?? [] : []) if (!it.resolved) it.resolved = { by: ev, at: e.ts };
        break;
      }
      case "SWARM_BATON_RETURNED": case "SWARM_DEGRADED": case "MERGE_DISPATCH_FALLBACK": {
        const kind = ev === "SWARM_BATON_RETURNED" ? "Swarm baton returned" : ev === "SWARM_DEGRADED" ? "Swarm degraded" : "Merge dispatch fell back";
        c.add({ group: "failure", resolved: null, at: e.ts, where, kind, message: clipMsg(f.Reason ?? f.Details ?? ev), recoverable: "yes", fix: hint("Construction carried on in a reduced mode; check the reason if it keeps happening."), source: src(e), evidence: await ev0(e) }, `swarm|${ev}|${f.Reason ?? ""}`);
        break;
      }
      case "PRACTICES_OVERRIDE":
        if (/^write-failure/.test(f.Reason ?? "")) practices.push(c.add({ group: "failure", resolved: null, at: e.ts, where, kind: "Practices not saved", message: clipMsg(f.Details ?? f.Reason!), recoverable: "needs-you", fix: hint("Affirming the practices could not write the memory files; re-run practices affirmation once the file is writable."), source: src(e), evidence: await ev0(e) }));
        break;
      case "PRACTICES_AFFIRMED": for (const it of practices) if (!it.resolved) it.resolved = { by: "PRACTICES_AFFIRMED", at: e.ts }; break;
      case "SESSION_COMPACTED":
        if ((f["State Validity"] ?? "").trim().toLowerCase() === "invalid") compactions.push(c.add({ group: "failure", resolved: null, at: e.ts, where, kind: "Invalid state at compaction", message: `State Validity: ${f["State Validity"]}${f["Current Stage"] ? ` (current stage ${f["Current Stage"]})` : ""}`, recoverable: "needs-you", fix: hint("The state file was invalid when the context was compacted; resume the workflow so AI-DLC repairs it."), source: src(e), evidence: await ev0(e, []) }));
        break;
      case "RECOVERY_COMPLETED": for (const it of compactions) if (!it.resolved) it.resolved = { by: "RECOVERY_COMPLETED", at: e.ts }; break;
    }
    if (ev === "STAGE_COMPLETED" && f.Stage && f.Stage === cur.stage) cur = { stage: null, unit: null };
  }
  // A non-blocking check still failing (or not run) when its stage or unit passed its gate was accepted there: listed,
  // not counted. A later pass of the same check (above) wins; a blocking sensor keeps counting.
  for (const [it, eff] of effect) {
    if (it.resolved || !it.at || !it.where.stage || /^blocking$/i.test(eff.trim())) continue;
    const st = it.where.stage; const un = it.where.unit ?? null;
    const gate = events.find((e) => e.ts > it.at! && (e.fields.Stage ?? e.fields["Stage slug"]) === st && (
      (e.event === "GATE_APPROVED" && (!e.fields.Unit || e.fields.Unit === un)) || (e.event === "STAGE_COMPLETED" && !e.fields.Unit) || (e.event === "UNIT_COMPLETED" && !!un && e.fields.Unit === un)));
    if (!gate) continue;
    it.group = "accepted";
    it.detail = [`Accepted at gate: ${gate.event} at ${gate.ts} · not re-checked since`, it.detail].filter(Boolean).join(" · ");
  }
  for (const it of c.issues) {
    if (it.resolved || !it.kind.startsWith("Guard refusal") || !it.at) continue;
    const r = resetAfter(events, it.at, it.where.stage ?? null, it.where.unit ?? null);
    if (r) it.resolved = { by: r.event!, at: r.ts };
  }
}
/** Whether `e` starts a new situation for a guard refusal on `stage`/`unit` (AIDLC's guardRefusalResetToken), or completes it. */
function isReset(e: AuditEvent, stage: string | null, unit: string | null): boolean {
  const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const f = e.fields; const ev = e.event;
  if (ev === "SESSION_STARTED" || ev === "SESSION_RESUMED" || ev === "WORKFLOW_STARTED" || ev === "STAGE_JUMPED") return true;
  if (ev === "GATE_REJECTED") return !!stage && list(f["Gate Stages"] ?? f.Stage).includes(stage) && (!f.Unit || f.Unit === unit);
  if (ev === "BOLT_STARTED") return !!unit && list(f["Bolt names"]).includes(unit);
  if (ev === "STAGE_COMPLETED") return !!stage && f.Stage === stage;
  if (ev === "UNIT_COMPLETED") return !!stage && f.Stage === stage && !!unit && f.Unit === unit;
  return false;
}
/**
 * The first entry after `ts` that starts a new situation for a guard refusal on `stage`/`unit`: AIDLC's reset boundary
 * (guardRefusalResetToken in aidlc-lib.ts — a session start or resume, a workflow start, a jump, this stage's gate
 * rejection, a fresh Bolt for this unit) or this stage (and unit) completing.
 */
export function resetAfter(events: AuditEvent[], ts: string, stage: string | null, unit: string | null): AuditEvent | null {
  for (const e of events) if (e.ts > ts && isReset(e, stage, unit)) return e;
  return null;
}
/** Every reset boundary for one stage+unit, oldest first, computed once per scope (one pass over the entries). */
function resetTimes(events: AuditEvent[], stage: string | null, unit: string | null, memo: Map<string, string[]>): string[] {
  const key = `${stage ?? ""}\u0000${unit ?? ""}`;
  const hit = memo.get(key); if (hit) return hit;
  const out: string[] = [];
  for (const e of events) if (isReset(e, stage, unit)) out.push(e.ts);
  memo.set(key, out); return out;
}
/** The latest reset boundary before `ts`: guard refusals never fold across one. */
function lastResetBefore(events: AuditEvent[], ts: string, stage: string | null, unit: string | null, memo: Map<string, string[]>): string {
  const list = resetTimes(events, stage, unit, memo);
  let last = "";
  for (const t of list) { if (t >= ts) break; last = t; }
  return last;
}
/**
 * The unit a per-unit artifact path names: `…/construction/<unit>/<stage>/<file…>` (at least four segments from
 * `construction`), only when <stage> is the event's own stage and a catalog slug (when a catalog is known). As the lenses do.
 */
export function unitFromPath(p: string | undefined, stage: string, slugs: ReadonlySet<string>): string | null {
  if (!p) return null;
  const segs = p.replace(/\\/g, "/").split("/");
  const i = segs.lastIndexOf("construction");
  if (i < 0 || segs.length - i < 4) return null;
  const unit = segs[i + 1]!; const st = segs[i + 2]!;
  if (st !== stage || (slugs.size && !slugs.has(st)) || !safeDirName(unit) || slugs.has(unit)) return null;
  return unit;
}
/** A recorded absolute detail path, as workspace-relative when it maps into `aidlc/`. */
function rewriteDetail(p: string, c: Collector): string {
  const r = rewriteRecordedPath(p, c.root);
  return r ? c.rel(r) : p.replace(/^.*\/aidlc\//, "aidlc/");
}

/** Heartbeats and drops in one hooks-health folder. Returns hook rows; adds hard-stop and drop issues. */
/**
 * `live`: this record is its workspace's active intent and not completed or archived. Only then are stale or missing
 * heartbeats a hard stop; elsewhere (other intents, a clone, another machine) the state is informational.
 */
async function fromHooks(c: Collector, base: string, eng: string, legacy: string, events: AuditEvent[], ws: string, intentKey: string | null, live: boolean): Promise<HookRow[]> {
  let dir = join(eng, "hooks-health");
  let names = await listIn(base, dir);
  if (!names.length && (await listIn(base, legacy)).length) { dir = legacy; names = await listIn(base, legacy); }
  const dirExists = !!(await contain(base, dir));
  const lasts: Record<string, string> = {}; const dropsBy: Record<string, { real: number; benign: number }> = {};
  for (const n of names) {
    if (n.endsWith(".last")) {
      const hook = n.slice(0, -5); if (!hook || hook.includes(".")) continue; // `<hook>.missing-record.last` is a rate-limit marker, not a heartbeat
      const r = await readIn(base, join(dir, n)); if (r) lasts[hook] = r.text.trim();
    } else if (n.endsWith(".drops")) {
      const hook = n.slice(0, -6); if (!hook || hook.includes(".")) continue;
      const r = await readIn(base, join(dir, n)); if (!r) continue;
      const counts = dropsBy[hook] ?? { real: 0, benign: 0 }; dropsBy[hook] = counts;
      const lines = r.text.split("\n"); const file = c.rel(join(dir, n));
      const beat = await c.support(join(dir, `${hook}.last`), `${hook}'s last heartbeat`, "hooks-health");
      for (const d of parseDrops(r.text)) {
        const cat = classifyDrop(d.reason); const meta = DROP_META[cat];
        if (cat === "by-design") { counts.benign++; continue; }
        counts.real++;
        const phase = hookPhaseOf(hook);
        c.add({ group: meta.group, resolved: meta.benign ? { by: meta.benign, at: d.at } : null, at: d.at, where: { hook, hookPhase: phase }, kind: `Hook drop · ${meta.label}`, message: clipMsg(d.reason),
          detail: "The hook swallowed this failure and let the call through (fail-open).", recoverable: meta.recoverable, fix: meta.fix, source: { file, line: d.line },
          cause: dropCause({ reason: d.reason, at: d.at, category: meta.label, hook, phase: phase ?? phasesLabel(hook), file, line: d.line }),
          evidence: evidenceFrom(file, lines, d.line - 2, d.line + 2, d.line, beat ? [beat] : []) },
          meta.benign ? undefined : `drop|${hook}|${d.reason}`);
      }
    }
  }
  const progress = events.filter((e) => e.event?.startsWith("STAGE_") || e.event?.startsWith("GATE_")).at(-1) ?? null;
  const hb = heartbeatStates(lasts, progress?.ts ?? null, dirExists);
  if (hb.record !== "ok" && progress && live) {
    const newestHook = Object.entries(lasts).find(([, v]) => v === hb.newest)?.[0] ?? null;
    const auditDir = join(dirname(eng), "audit");
    const evidence = progress.line ? await c.auditEvidence(progress, auditDir, [newestHook ? await c.support(join(dir, `${newestHook}.last`), `the newest heartbeat (${newestHook})`, "hooks-health") : null]) : null;
    const msg = hb.record === "stale"
      ? `Hooks last fired ${hb.newest}, but the workflow last advanced ${progress.ts}`
      : "No hook has recorded a heartbeat, although the workflow has stage and gate entries";
    c.add({ group: "hard-stop", resolved: null, at: progress.ts, where: { stage: stageOf(progress), unit: unitOf(progress) }, kind: "Hook not running", message: msg,
      detail: "AIDLC itself refuses to proceed while hooks are not firing.", recoverable: "needs-you",
      fix: hint("Repair the hook registration (or trust this folder) in your harness, then fully restart the harness; a /clear is not enough."), source: { file: c.rel(dir) },
      cause: hookNotRunningCause({ newestHook, newestAt: hb.newest, progressEvent: progress.event ?? "entry", progressAt: progress.ts, progressStage: stageOf(progress) }), evidence });
  }
  if (!dirExists && !progress) return [];
  const hooks = new Set<string>([...(progress ? HEARTBEAT_HOOKS : []), ...Object.keys(lasts), ...Object.keys(dropsBy)]);
  const note = live ? undefined : !Object.keys(lasts).length ? "no heartbeats here - normal for a clone or another machine" : hb.record === "stale" ? "not the active intent: informational" : undefined;
  return [...hooks].sort().map((hook) => ({
    workspace: ws, intentKey, hook, phase: phasesLabel(hook), lastAt: lasts[hook] ?? null,
    state: lasts[hook] ? hb.hooks[hook] ?? "ok" : "never", drops: dropsBy[hook]?.real ?? 0, benignDrops: dropsBy[hook]?.benign ?? 0, ...(note ? { note } : {}),
  }));
}

/** Engine files of one record: guard refusals, Stop counter, checkpoints, active directive, dispatch marker. */
async function fromEngine(c: Collector, base: string, rec: string, eng: string, events: AuditEvent[], now: number, stateMd: string | null) {
  for (const n of (await listIn(base, join(eng, "guard-refusals"))).filter((x) => x.endsWith(".json"))) {
    const r = await readIn(base, join(eng, "guard-refusals", n)); const d = json(r?.text) as Record<string, unknown> | null;
    const state = guardRefusalState(d); if (!r || !d || !state) continue;
    const remedies = refusalRemedies(d); const ref = d.refusal as Record<string, unknown>;
    const at = typeof d.updatedAt === "string" ? d.updatedAt : isoOf(r.mtime);
    const stage = typeof ref.stage === "string" ? ref.stage : null; const unit = typeof ref.unit === "string" ? ref.unit : null;
    const reset = resetAfter(events, at, stage, unit);
    // The same terminal situation logged as ERROR_LOGGED (at or before this record) is evidence, not a second issue.
    const logged = state === "terminal" ? c.issues.filter((i) => i.kind === "Guard refusal (terminal)" && i.source.file.includes("/audit/") && (i.where.stage ?? null) === stage && (i.where.unit ?? null) === unit && (i.at ?? "") <= at) : [];
    for (const i of logged) c.remove(i);
    const evidence = logged.length ? `Also logged as ERROR_LOGGED at ${logged.map((i) => i.at).join(", ")} (${logged[0]!.source.file})` : null;
    const recFile = join(eng, "guard-refusals", n);
    const recSupport = await c.support(recFile, "the guard-refusal record", "guard-refusal");
    // Logged too: the log entry is the evidence and this record a supporting file; otherwise the record itself.
    const loggedEv = logged.find((i) => i.evidence)?.evidence ?? null;
    const proof = loggedEv ? { ...loggedEv, supporting: [...loggedEv.supporting.filter((x) => x.path !== recSupport?.path), ...(recSupport ? [recSupport] : [])] } : await c.fileEvidence(recFile, { focus: /"userMessage"|"blockedAction"/ });
    c.add({ group: state === "terminal" ? "hard-stop" : "refused", resolved: reset ? { by: reset.event!, at: reset.ts } : null, at,
      where: { stage, unit }, kind: state === "terminal" ? "Guard refusal (terminal)" : "Guard refusal",
      message: clipMsg(typeof ref.userMessage === "string" ? ref.userMessage : String(ref.code ?? "refused")),
      detail: [typeof ref.blockedAction === "string" ? `Blocked: ${ref.blockedAction}` : null, Array.isArray(d.codes) && d.codes.length ? `codes ${d.codes.join(", ")}` : null, `refused ${d.count}×`, state === "terminal" ? "Terminal: past the cap with nothing the agent can run" : null, evidence].filter(Boolean).join(" · "),
      recoverable: state === "recoverable" ? "yes" : "needs-you", fix: remedies.length ? { text: remedyText(remedies), source: "aidlc" } : hint("No remedy is available to the agent: a person has to decide how to proceed."),
      source: { file: c.rel(join(eng, "guard-refusals", n)) }, count: typeof d.count === "number" ? d.count : undefined, cause: guardRecordCause(d), evidence: proof });
  }
  const sc = await readIn(base, join(eng, "stop-hook/block-count.json"));
  const autonomous = !!stateMd && parseState(stateMd).fields["Construction Autonomy Mode"] === "autonomous";
  const stall = sc ? stopCounterStalled(json(sc.text), autonomous) : null;
  const moved = sc ? events.find((e) => /^(STAGE_|GATE_|UNIT_)/.test(e.event ?? "") && Date.parse(e.ts) > sc.mtime) : undefined;
  if (sc && stall) {
    const rec0 = json(sc.text) as Record<string, unknown>;
    const drops = await c.support(join(eng, "hooks-health/continue-workflow.drops"), "the Stop hook's drops", "hooks-health");
    c.add({ group: "failure", resolved: moved ? { by: moved.event!, at: moved.ts } : null, at: isoOf(sc.mtime), where: { hook: "continue-workflow", hookPhase: "Stop" }, kind: "Stalled run", message: `The Stop hook blocked ${stall.count} times without progress (autonomous cap ${stall.cap})`, recoverable: "needs-you", fix: hint("The unattended run stopped making progress. Look at what the agent is waiting on, then resume it."), source: { file: c.rel(join(eng, "stop-hook/block-count.json")) },
      cause: stallCause(rec0, stall.cap), evidence: await c.fileEvidence(join(eng, "stop-hook/block-count.json"), { focus: /"count"/ }, [drops]) });
  }

  const cpDir = join(rec, ".aidlc-construction-checkpoints");
  for (const unit of await listIn(base, cpDir)) {
    if (!safeDirName(unit)) continue;
    for (const n of (await listIn(base, join(cpDir, unit))).filter((x) => x.endsWith(".json"))) {
      const r = await readIn(base, join(cpDir, unit, n)); const d = json(r?.text) as Record<string, unknown> | null; if (!r || !d) continue;
      const s = checkpointState(d, now); if (s === "ok" || s === "unknown" || s === "running") continue;
      const label = typeof d.command_label === "string" ? d.command_label : "the verification command";
      const tail = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().split("\n").slice(-6).join("\n") : null);
      const msg = s === "crashed" ? `${label} started ${d.started_at ?? "(time not recorded)"} and never finished`
        : s === "non-idempotent" ? `${label}: CHECK_KEPT_CHANGING` : `${label} exited ${d.exit_code ?? "?"}${d.signal ? ` (signal ${d.signal})` : ""}`;
      c.add({ group: "failure", resolved: null, at: typeof d.finished_at === "string" ? d.finished_at : typeof d.started_at === "string" ? d.started_at : isoOf(r.mtime), where: { unit }, kind: s === "crashed" ? "Checkpoint crashed" : s === "failed" ? "Checkpoint failed" : "Check kept changing",
        message: msg, detail: tail(d.stderr_tail) ?? tail(d.stdout_tail) ?? undefined, recoverable: "needs-you",
        fix: hint(s === "crashed" ? "The verification run was interrupted mid-run; run it again." : s === "failed" ? "The verification command failed; fix what it reports, then run it again." : "Two runs of the check disagreed: make the verification command deterministic."),
        source: { file: c.rel(join(cpDir, unit, n)) }, cause: checkpointCause(d, s),
        evidence: await c.fileEvidence(join(cpDir, unit, n), { focus: s === "crashed" ? /"finished_at"/ : s === "failed" ? /"exit_code"|"signal"/ : /"error"/ }) });
    }
  }
  const ad = await readIn(base, join(eng, "active-directive.json"));
  const dd = json(ad?.text) as Record<string, unknown> | null;
  if (ad && dd && dd.kind === "error" && ad.text.includes("out_of_date")) {
    c.add({ group: "failure", resolved: null, at: isoOf(ad.mtime), where: { stage: typeof dd.stage === "string" ? dd.stage : null, unit: typeof dd.unit === "string" ? dd.unit : null }, kind: "Active step out of date",
      message: clipMsg(typeof dd.message === "string" ? dd.message : typeof dd.error === "string" ? dd.error : "The active directive is an error: out_of_date"), recoverable: "yes", fix: hint("Run the engine's next step to refresh the active directive."), source: { file: c.rel(join(eng, "active-directive.json")) },
      evidence: await c.fileEvidence(join(eng, "active-directive.json"), { focus: /out_of_date/ }) });
  }
  const rd = await readIn(base, join(eng, "reviewer-dispatch.json"));
  if (rd && now - rd.mtime > DISPATCH_TTL) staleMarker(c, rd.mtime, join(eng, "reviewer-dispatch.json"), "6 h");
}
function staleMarker(c: Collector, mtime: number, abs: string, ttl: string) {
  c.add({ group: "failure", resolved: null, at: isoOf(mtime), where: {}, kind: "Stale marker", message: `${abs.split("/").at(-1)} is older than its ${ttl} freshness window`, recoverable: "yes",
    fix: hint("AIDLC ignores a marker past its window and cleans it up on the next run that reads it."), source: { file: c.rel(abs) } });
}

export interface RecordHealth { issues: Issue[]; hooks: HookRow[] }

/** One intent record (`rec` already contained in `<root>/aidlc`). */
const DONE = /^(complete|completed|archived|done)$/i;
/** The intent `<space>/intents/active-intent` names, when it is a listed intent. */
async function activeDir(root: string, space: string): Promise<string | null> {
  const r = await readIn(join(root, "aidlc"), join(root, "aidlc/spaces", space, "intents/active-intent"));
  return r?.text.trim() || null;
}
/** Whether `ref` is its space's active intent and still running: only then do missing or stale heartbeats stop AIDLC. */
async function isLive(root: string, ref: IntentRef): Promise<boolean> {
  return !DONE.test(ref.status) && (await activeDir(root, ref.space)) === ref.dir;
}

export async function intentHealth(root: string, ref: IntentRef, rec: string, now: Date, events?: AuditEvent[]): Promise<RecordHealth> {
  const base = join(root, "aidlc"); const c = new Collector(root, await realOf(root));
  let evs = events;
  if (!evs) { const a = await readContainedAudit(root, rec); evs = a.events; c.seed(join(rec, "audit"), a.texts); }
  const eng = join(rec, ".aidlc-engine");
  const state = await readIn(base, join(rec, "aidlc-state.md"));
  const slugs = new Set((await loadCatalog(root)).stages.map((x) => x.slug));
  await fromEvents(c, evs, join(rec, "audit"), slugs, eng);
  const hooks = await fromHooks(c, base, eng, join(rec, ".aidlc-hooks-health"), evs, root, `${ref.space}/${ref.dir}`, await isLive(root, ref));
  await fromEngine(c, base, rec, eng, evs, now.getTime(), state?.text ?? null);
  return { issues: c.finish(), hooks };
}

/** Workspace-level items: space-level hooks-health, plugin compose drops, stale markers, trace and transcript failures. */
async function workspaceLevel(root: string, refs: IntentRef[], now: Date, opts: HealthOpts): Promise<RecordHealth & { transcripts: TxStats | null; trace: boolean; activeKey: string | null }> {
  const base = join(root, "aidlc"); const c = new Collector(root, await realOf(root)); const hooks: HookRow[] = [];
  for (const sp of [...new Set(refs.map((r) => r.space))]) {
    const idir = join(base, "spaces", sp, "intents");
    const audit = await contain(base, join(idir, "audit"));
    const a = audit ? await readAuditDir(audit, base) : null; const events = a?.events ?? [];
    if (a) c.seed(join(idir, "audit"), a.texts);
    hooks.push(...await fromHooks(c, base, join(idir, ".aidlc-engine"), join(idir, ".aidlc-hooks-health"), events, root, null, false));
  }
  for (const n of (await listIn(base, base)).filter((x) => /^plugin-compose-.+\.drops$/.test(x))) {
    const r = await readIn(base, join(base, n)); if (!r) continue;
    const lines = r.text.split("\n"); const file = c.rel(join(base, n));
    for (const d of parseDrops(r.text)) if (d.reason.includes("[degraded]"))
      c.add({ group: "failure", resolved: null, at: d.at, where: {}, kind: "Plugin compose degraded", message: clipMsg(d.reason), recoverable: "needs-you", fix: hint("A plugin could not be composed into this install; re-run plugin selection after fixing what the message names."), source: { file, line: d.line },
        evidence: evidenceFrom(file, lines, d.line - 2, d.line + 2, d.line) }, `pc|${n}|${d.reason}`);
  }
  for (const [rel, ttl] of STALE_MARKERS) {
    const r = await readIn(base, join(root, rel));
    if (r && now.getTime() - r.mtime > ttl) staleMarker(c, r.mtime, join(root, rel), `${ttl / HOUR} h`);
  }
  // The intent transcript and trace failures belong to: the active-intent cursor, when it names a listed intent.
  let activeKey: string | null = null;
  for (const sp of [...new Set(refs.map((r) => r.space))]) {
    const cur = await readIn(base, join(base, "spaces", sp, "intents/active-intent"));
    const dir = cur?.text.trim(); const ref = dir ? refs.find((r) => r.space === sp && r.dir === dir) : undefined;
    if (ref) { activeKey = `${ref.space}/${ref.dir}`; break; }
  }
  const inferred = activeKey ? "intent inferred from the active-intent cursor" : null;
  let trace = false;
  if (opts.traceDir && isAbsolute(opts.traceDir)) {
    const td = await contain(root, opts.traceDir);
    if (td) {
      trace = true;
      for (const n of (await listIn(root, td)).filter((x) => /^hook-\d+\.ndjson$/.test(x))) {
        const r = await readIn(root, join(td, n)); if (!r) continue;
        r.text.split("\n").forEach((l, i) => {
          if (!l.includes("dispatcher-error")) return;
          const o = json(l) as Record<string, unknown> | null; if (o?.phase !== "dispatcher-error") return;
          c.add({ group: "failure", resolved: null, at: typeof o.at === "string" ? o.at : null, where: { inferred }, kind: "Hook crash (trace)", message: clipMsg(typeof o.message === "string" ? o.message : "dispatcher error"), detail: `pid ${o.pid ?? "?"}`, recoverable: "needs-you", fix: hint("The hook dispatcher crashed and the hook failed open. Report it with the message shown."), source: { file: c.rel(join(td, n)), line: i + 1 } });
        });
      }
    }
  }
  let transcripts: TxStats | null = null;
  if (opts.scanTranscripts) {
    const s = await scanTranscripts(root, opts.projectsRoot ?? DEFAULT_PROJECTS_ROOT);
    transcripts = { status: s.status, runs: s.runs, failures: s.failures.length, reprompts: s.reprompts };
    for (const f of s.failures) {
      const phase = f.event && ["PreToolUse", "PostToolUse", "Stop", "SessionStart", "SessionEnd", "SubagentStop", "PreCompact", "UserPromptSubmit"].includes(f.event) ? f.event as Issue["where"]["hookPhase"] : hookPhaseOf(f.hook);
      c.add({ group: "failure", resolved: null, at: f.at, where: { hook: f.hook, hookPhase: phase, inferred }, kind: "Hook failure (transcript)", message: clipMsg(f.error), detail: s.truncated ? "Read from the end of a large transcript only." : undefined, recoverable: "needs-you",
        fix: hint("The hook failed and Claude Code carried on (fail-open). Fix what the error names; if it is a crash, report it."), source: { file: `~/.claude/projects/…/${f.transcript}`, line: f.line } }, `tx|${f.hook}|${f.event}|${f.error}`);
    }
  }
  return { issues: c.finish(), hooks, transcripts, trace, activeKey };
}

async function workspaceHealth(f: Found, now: Date, opts: HealthOpts): Promise<{ issues: ScopedIssue[]; hooks: HookRow[]; transcripts: TxStats | null; trace: boolean }> {
  const root = f.path; const base = join(root, "aidlc");
  const refs = await listIntents(root);
  const out: ScopedIssue[] = []; const hooks: HookRow[] = [];
  for (const ref of refs) {
    const rec = await contain(base, recordDirOf(root, ref)); if (!rec) continue;
    try {
      const h = await intentHealth(root, ref, rec, now);
      out.push(...h.issues.map((i) => ({ ...i, workspace: root, intentKey: `${ref.space}/${ref.dir}`, intentName: ref.slug })));
      hooks.push(...h.hooks);
    } catch (e) { console.error(`[command-center] health of ${ref.space}/${ref.dir} could not be read:`, e); }
  }
  const w = await workspaceLevel(root, refs, now, opts);
  const active = w.activeKey ? refs.find((r) => `${r.space}/${r.dir}` === w.activeKey) : undefined;
  for (const i of w.issues) {
    const own = active && (i.kind === "Hook failure (transcript)" || i.kind === "Hook crash (trace)");
    out.push({ ...i, workspace: root, intentKey: own ? w.activeKey : null, intentName: own ? active!.slug : "workspace" });
  }
  hooks.push(...w.hooks);
  return { issues: out, hooks, transcripts: w.transcripts, trace: w.trace };
}

const order = (a: ScopedIssue, b: ScopedIssue) => (a.resolved ? 1 : 0) - (b.resolved ? 1 : 0) || GROUP_RANK[a.group] - GROUP_RANK[b.group] || (b.at ?? "").localeCompare(a.at ?? "");
const GROUP_RANK: Record<IssueGroup, number> = { "hard-stop": 0, failure: 1, refused: 2, bypass: 3, accepted: 4 };

function coverageOf(opts: HealthOpts, tx: (TxStats | null)[], trace: boolean): HealthCoverage {
  const ts = tx.map((t) => t?.status ?? null);
  const transcripts: TranscriptCoverage = !opts.scanTranscripts ? "off" : ts.includes("on") ? "on" : ts.includes("unrecognised") ? "unrecognised" : "unavailable";
  const note = transcripts === "on" || trace ? null
    : transcripts === "unrecognised" ? "The transcript format was not recognised, so hook crashes could not be read from it. Hook crashes are not recorded by AIDLC."
    : transcripts === "unavailable" ? "No Claude Code transcript could be read for these workspaces (none named, or outside ~/.claude/projects). Hook crashes are not recorded by AIDLC; set AIDLC_HOOK_TRACE_DIR before starting your harness to trace them."
    : COVERAGE_NOTE;
  const on = tx.filter((t): t is TxStats => !!t && t.status === "on");
  const sum = (k: "runs" | "failures" | "reprompts") => on.reduce((a, t) => a + t[k], 0);
  return { transcripts, trace, note, ...(transcripts === "on" ? { transcriptRuns: sum("runs"), transcriptFailures: sum("failures"), transcriptReprompts: sum("reprompts") } : {}) };
}

/** `GET /api/health`: every registered, existing workspace. */
export async function buildHealth(found: Found[], now: Date, opts: HealthOpts = {}): Promise<HealthPayload> {
  const issues: ScopedIssue[] = []; const hooks: HookRow[] = []; const ts: (TxStats | null)[] = []; let trace = false;
  for (const f of found) {
    if (!f.exists) continue;
    const w = await workspaceHealth(f, now, opts);
    issues.push(...w.issues); hooks.push(...w.hooks); ts.push(w.transcripts); trace ||= w.trace;
  }
  return { issues: issues.sort(order), hooks, coverage: coverageOf(opts, ts, trace), generatedAt: now.toISOString() };
}

/** `GET /api/lens/issues`: one intent, plus the workspace-level items attributed to it. */
export async function issuesLens(f: Found, ref: IntentRef, now: Date, opts: HealthOpts = {}): Promise<HealthPayload> {
  const w = await workspaceHealth(f, now, opts); const key = `${ref.space}/${ref.dir}`;
  return { issues: w.issues.filter((i) => i.intentKey === key).sort(order), hooks: w.hooks.filter((h) => h.intentKey === key), coverage: coverageOf(opts, [w.transcripts], w.trace), generatedAt: now.toISOString() };
}

export const healthCounts = (p: HealthPayload): HealthCounts => countIssues(p.issues);

const HOME_TTL_MS = 5_000;
const HOME_KEEP = 8;
const homeCache = new Map<string, { at: number; fp: string; payload: HealthPayload }>();
const building = new Map<string, Promise<HealthPayload>>();
/** `name:size:mtime` of every entry in a contained folder (one level), or of a single contained file. Stats only. */
async function statDir(base: string, dir: string, out: string[], depth = 0): Promise<void> {
  const d = await contain(base, dir); if (!d) return;
  let names: string[] = []; try { names = (await readdir(d)).sort(); } catch { return; }
  for (const n of names) {
    try {
      const st = await stat(join(d, n)); out.push(`${dir}/${n}:${st.size}:${st.mtimeMs}`);
      if (st.isDirectory() && depth > 0) await statDir(base, join(dir, n), out, depth - 1);
    } catch { /* gone */ }
  }
}
async function statFile(base: string, p: string, out: string[]): Promise<void> {
  const q = await contain(base, p); if (!q) return;
  try { const st = await stat(q); out.push(`${p}:${st.size}:${st.mtimeMs}`); } catch { /* gone */ }
}
/**
 * Everything `buildHealth` reads that AIDLC changes, as stats only (no reads): audit shards, hooks-health, guard
 * refusals, the Stop counter, verification checkpoints, the active directive and dispatch
 * marker, the registry and active-intent cursors, workspace markers, and — with the scan on — transcript pointers
 * and their targets.
 */
async function fingerprint(found: Found[], opts: HealthOpts): Promise<string> {
  const parts: string[] = [];
  for (const f of found) {
    if (!f.exists) continue;
    const base = join(f.path, "aidlc");
    const refs = await listIntents(f.path);
    for (const sp of new Set(refs.map((r) => r.space))) {
      const idir = join(base, "spaces", sp, "intents");
      await statFile(base, join(idir, "intents.json"), parts); await statFile(base, join(idir, "active-intent"), parts);
      await statDir(base, join(idir, ".aidlc-engine/hooks-health"), parts);
    }
    for (const ref of refs) {
      const rec = recordDirOf(f.path, ref); const eng = join(rec, ".aidlc-engine");
      for (const d of ["audit", ".aidlc-engine/hooks-health", ".aidlc-hooks-health", ".aidlc-engine/guard-refusals"]) await statDir(base, join(rec, d), parts);
      await statDir(base, join(rec, ".aidlc-construction-checkpoints"), parts, 1);
      for (const p of ["stop-hook/block-count.json", "active-directive.json", "reviewer-dispatch.json"]) await statFile(base, join(eng, p), parts);
      await statFile(base, join(rec, "aidlc-state.md"), parts);
    }
    await statDir(base, base, parts); // plugin compose drops and stale markers at the top of aidlc/
    if (opts.scanTranscripts) {
      const { targets } = await transcriptTargets(f.path, opts.projectsRoot ?? DEFAULT_PROJECTS_ROOT);
      await statDir(base, join(base, ".aidlc-sessions"), parts);
      for (const t of targets) { try { const st = await stat(t); parts.push(`${t}:${st.size}:${st.mtimeMs}`); } catch { /* gone */ } }
    }
  }
  return parts.join("|");
}
/**
 * `buildHealth` for the home payload, which is rebuilt on every live change: reused while nothing it reads changed
 * (by the stat fingerprint) and for at most 5 s; concurrent calls share one build; the last 8 keys are kept.
 */
export async function cachedHealth(found: Found[], now: Date, opts: HealthOpts = {}): Promise<HealthPayload> {
  const key = JSON.stringify([found.map((f) => [f.path, f.exists]), opts]);
  const fp = await fingerprint(found, opts); const hit = homeCache.get(key);
  if (hit && hit.fp === fp && Date.now() - hit.at < HOME_TTL_MS) return hit.payload;
  const bk = `${key}\u0000${fp}`;
  const running = building.get(bk); if (running) return running;
  const p = buildHealth(found, now, opts).then((payload) => {
    homeCache.delete(key); homeCache.set(key, { at: Date.now(), fp, payload });
    while (homeCache.size > HOME_KEEP) homeCache.delete(homeCache.keys().next().value!);
    return payload;
  }).finally(() => building.delete(bk));
  building.set(bk, p);
  return p;
}
export type { Issue, Recoverable };
