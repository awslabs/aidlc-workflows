import type { Dirent, Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { AuditEvent, CatalogStage, Recorded, Tokens } from "./types";
import type { IntentRef } from "./parse/registry";
import { parseQuestions, type Question } from "./parse/questions";
import { parseEmbeddedReview, readReviewRecords, type Finding } from "./parse/reviews";
import { parseLearnings } from "./parse/learnings";
import { parseStageMemory } from "./parse/memory";
import { readContainedAudit, readContainedLedger, recordDirOf } from "./model/intent";
import { contain, rewriteRecordedPath } from "./paths";
import { tokenCount, tokenEvents } from "./model/story";

const MAX_ENTRIES = 20_000;
const MAX_BODY = 2 * 1024 * 1024;
const TOP_EXCLUDE = new Set(["audit", "aidlc-state.md", "runtime-graph.json"]);

export interface TreeEntry { path: string; dir: boolean; size: number; mtime: number; edits: number; stage: string | null; agent: string | null }
interface Walked { rel: string; abs: string; dir: boolean; size: number; mtime: number }

/** Record-relative walk; skips dotfiles, the audit dir, state and runtime graph, and never follows symlinks. */
async function walk(rec: string): Promise<Walked[] & { truncated?: boolean }> {
  const out: Walked[] & { truncated?: boolean } = []; out.truncated = false;
  async function go(dir: string, rel: string): Promise<void> {
    let ents: Dirent[]; try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (out.length >= MAX_ENTRIES) { out.truncated = true; return; }
      if (e.name.startsWith(".") || (!rel && TOP_EXCLUDE.has(e.name))) continue;
      if (!e.isDirectory() && !e.isFile()) continue; // symlinks, sockets, … are not listed
      const abs = join(dir, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      let st: Stats; try { st = await stat(abs); } catch { continue; }
      out.push({ rel: r, abs, dir: e.isDirectory(), size: e.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
      if (e.isDirectory()) await go(abs, r);
    }
  }
  await go(rec, ""); return out;
}

const segs = (rel: string) => rel.split("/");
/** `construction/<unit>/<stage>/…` only; `construction/<stage>/…` is stage-level. */
function unitOf(rel: string, catalog: CatalogStage[]): string | null {
  const s = segs(rel); return s[0] === "construction" && s.length >= 4 && catalog.some((c) => c.slug === s[2]) ? s[1]! : null;
}
function stageOf(rel: string, catalog: CatalogStage[]): string | null {
  const slugs = new Set(catalog.map((c) => c.slug));
  return segs(rel).find((s) => slugs.has(s)) ?? null;
}
const matches = (e: AuditEvent, stage: string, unit: string | null) => e.fields.Stage === stage && (unit === null || e.fields.Unit === unit);
function lastIdx(events: AuditEvent[], kinds: string[], stage: string, unit: string | null): number {
  for (let i = events.length - 1; i >= 0; i--) { const e = events[i]!; if (e.event !== null && kinds.includes(e.event) && matches(e, stage, unit)) return i; }
  return -1;
}
const lastOf = (events: AuditEvent[], kinds: string[], stage: string, unit: string | null) => events[lastIdx(events, kinds, stage, unit)] ?? null;
const agentOf = (stage: string | null, catalog: CatalogStage[]) => (stage ? catalog.find((c) => c.slug === stage)?.lead ?? null : null);
/** The group's closing event: the last GATE_*, unless a PLAN_APPROVAL_* for the same stage+unit comes after it. */
function closer(events: AuditEvent[], stage: string, unit: string | null): (AuditEvent & { kind: "gate" | "plan" }) | null {
  const g = lastIdx(events, ["GATE_APPROVED", "GATE_REJECTED"], stage, unit); const p = lastIdx(events, ["PLAN_APPROVAL_RECORDED", "PLAN_APPROVAL_OVERRIDDEN"], stage, unit);
  if (p > g) return { ...events[p]!, kind: "plan" };
  return g >= 0 ? { ...events[g]!, kind: "gate" } : null;
}

export interface LensCtx { root: string; ref: IntentRef; rec: string; catalog: CatalogStage[]; events: AuditEvent[] }
/** `rec` must already be realpath-contained in `<root>/aidlc` (see http resolveIntent). */
export async function lensCtx(root: string, ref: IntentRef, rec: string, catalog: CatalogStage[]): Promise<LensCtx> {
  const { events } = await readContainedAudit(root, rec);
  return { root, ref, rec, catalog, events };
}

export interface DecisionQuestion { id: string; title: string; options: string[]; answer: string[] | null; answerRaw: string | null }
export interface AgentDecision {
  ts: string; stage: string | null; unit: string | null; decision: string; answerText: string | null;
  /** Pieces of the recorded answer no question took — unknown or repeated `Q<n>`, or none at all. Kept verbatim. */
  unassigned: string[];
  /** An answer was recorded alongside this ask but could not be attributed to any single ask. */
  unresolved: boolean;
  /** Those answers, carried once per run (on its newest ask) so they are shown without being attributed. */
  strayAnswers: string[];
  questions: DecisionQuestion[];
}

/** One piece of a packed `Decision`/`Options`/`Details` cell: `Q3: …` or `Question 3 — …`. */
const QPIECE = /^(?:Question|Q)\s*(\d+)\s*[:.)—–-]\s*(.+)$/i;
/** `Questions 1-4: a, b, c, d` (or `Questions 8-10 and follow-ups 11-12: …`) — one comma-separated label per packed question. */
const QRANGE = /^Questions?\b[^:]*\d[^:]*:\s*(.+)$/i;
const pieces = (s: string) => s.split(";").map((p) => p.trim()).filter(Boolean);
/**
 * Lowercase, punctuation and brackets to spaces, whitespace collapsed — the only ground on which a recorded answer may
 * match an option, and the same ground for both, so `Coarse (6-8)` and `Coarse 6-8` are the one answer they look like.
 */
const normText = (s: string) => s.toLowerCase().replace(/[+,.\-–—()]/g, " ").replace(/\s+/g, " ").trim();
const MIN_LOOSE = 3; // shorter than this, only an exact match counts
const MIN_PREFIX = 8; // a cut-short option has to be at least this long…
const PREFIX_SHARE = 0.6; // …and this much of the option it cuts short

/**
 * The single option a recorded token names, or null. Three rules, each only when exactly one option satisfies it:
 * the same text; the option contains the token in whole words (the shorthand a person types for a longer option, so
 * "SQL" is not a shorthand for "NoSQL store"); or the token cuts the option short near its end ("Never deploy to prod"
 * for "Never deploy to production") — long enough and most of the option, so "SQL" never stands for "SQLite". The other
 * direction, an answer that merely mentions an option as in "Not Postgres, use DynamoDB", never counts.
 */
function matchOne(options: string[], token: string): string | null {
  const n = normText(token); if (!n) return null;
  const eq = options.filter((o) => normText(o) === n);
  if (eq.length) return eq.length === 1 ? eq[0]! : null;
  if (n.length < MIN_LOOSE) return null;
  const loose = options.filter((o) => ` ${normText(o)} `.includes(` ${n} `));
  if (loose.length) return loose.length === 1 ? loose[0]! : null;
  if (n.length < MIN_PREFIX) return null;
  const cut = options.filter((o) => { const no = normText(o); return no.startsWith(n) && n.length >= no.length * PREFIX_SHARE; });
  return cut.length === 1 ? cut[0]! : null;
}
/**
 * Which options a recorded answer chose, in three passes. The whole text as one option, but only word for word, so an
 * option that itself contains a comma ("Trunk-based, squash") is read as one answer without a longer option swallowing a
 * two-part one. Then commas as a multi-select, where every part has to land on exactly one option: a part that matches
 * nothing (a caveat, an extra rule of their own) drops the whole answer back. Only then the whole text again, this time
 * as a shorthand or a truncation. Nothing certain, nothing marked — the answer is shown verbatim instead.
 */
function matchAnswer(options: string[], raw: string): string[] | null {
  const n = normText(raw);
  const same = options.filter((o) => normText(o) === n);
  if (same.length) return same.length === 1 ? [same[0]!] : null;
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const hit = new Set<string>(); let every = true;
    for (const p of parts) { const m = matchOne(options, p); if (!m) { every = false; break; } hit.add(m); }
    const picked = options.filter((o) => hit.has(o));
    if (every && picked.length) return picked;
  }
  const whole = matchOne(options, raw);
  return whole ? [whole] : null;
}
/** `Q1: a / b; Q2: c / d` → one question per piece; anything else is one question titled by the decision itself. */
function packedQuestions(decision: string, options: string): DecisionQuestion[] {
  const labelled = pieces(options).map((p) => p.match(QPIECE)).filter((m): m is RegExpMatchArray => m !== null);
  if (labelled.length) return labelled.map((m) => ({ id: `Q${m[1]}`, title: "", options: m[2]!.split(/\s+\/\s+/).map((o) => o.trim()).filter(Boolean), answer: null, answerRaw: null }));
  return [{ id: "", title: decision, options: options.split(",").map((o) => o.trim()).filter(Boolean), answer: null, answerRaw: null }];
}
/** Titles from the `Decision` label — `Question 9: …; Question 10: …` by id, or `Questions 1-4: a, b, c, d` in order — used only when they count out. */
function applyTitles(decision: string, qs: DecisionQuestion[]): void {
  if (qs.length < 2) return; // a single question is already titled by the decision
  const byId = pieces(decision).map((p) => p.match(QPIECE)).filter((m): m is RegExpMatchArray => m !== null);
  if (byId.length === qs.length && byId.every((m) => qs.some((q) => q.id === `Q${m[1]}`))) {
    for (const m of byId) { const q = qs.find((x) => x.id === `Q${m[1]}`)!; q.title = m[2]!.trim(); }
    return;
  }
  const r = decision.match(QRANGE); if (!r) return;
  const labels = r[1]!.split(",").map((l) => l.trim()).filter(Boolean);
  if (labels.length === qs.length) qs.forEach((q, i) => { q.title = labels[i]!; });
}
/**
 * The recorded `Details`, split the same way: `Q<n>: …` pieces per question, the whole text for a lone question.
 * Returns every piece no question took — one for a question this ask never offered, a repeat of one it did, or text
 * that named no question at all — so the card can still show it verbatim.
 */
function applyAnswers(qs: DecisionQuestion[], details: string | null): string[] {
  if (!details?.trim()) return [];
  if (qs.length === 1 && !qs[0]!.id) { // the whole answer belongs to the one question
    const q = qs[0]!; q.answerRaw = details.trim(); q.answer = matchAnswer(q.options, q.answerRaw);
    return [];
  }
  const ps = pieces(details); const first = new Map<string, number>();
  ps.forEach((p, i) => { const m = p.match(QPIECE); if (m && !first.has(`Q${m[1]}`)) first.set(`Q${m[1]}`, i); });
  const taken = new Set<number>();
  for (const q of qs) {
    const i = q.id ? first.get(q.id) : undefined; if (i === undefined) continue;
    taken.add(i);
    q.answerRaw = ps[i]!.match(QPIECE)![2]!.trim(); q.answer = matchAnswer(q.options, q.answerRaw);
  }
  return ps.filter((_, i) => !taken.has(i));
}
/** Same stage, and the same unit — an answer that names no unit still belongs to the ask, one that names another never does. */
const sameScope = (e: AuditEvent, stage: string | null, unit: string | null) =>
  (e.fields.Stage ?? null) === stage && ((e.fields.Unit ?? null) === unit || (e.fields.Unit ?? null) === null);
const CLOSERS = ["GATE_APPROVED", "GATE_REJECTED", "STAGE_COMPLETED"];

/** Whether a recorded answer can be this ask's: it names one of its questions, or it lands on the options it offered. */
function fitsAsk(d: AgentDecision, text: string): boolean {
  const ids = d.questions.map((q) => q.id).filter(Boolean);
  if (ids.length) return pieces(text).some((p) => { const m = p.match(QPIECE); return m !== null && ids.includes(`Q${m[1]}`); });
  return matchAnswer(d.questions[0]?.options ?? [], text) !== null;
}
const setAnswer = (d: AgentDecision, text: string) => { d.answerText = text; d.unassigned = applyAnswers(d.questions, text); };
/**
 * Hands a run's answers to its asks. One answer each, in order, when there are at least as many answers as asks; any
 * beyond that — an amendment recorded after the answer — is kept as a stray rather than discarded. When there are fewer
 * answers than asks, an answer goes to an ask only when it fits that one ask and no other, judged against every ask
 * before any is given one, so the outcome does not depend on the order the answers were recorded. An answer that could
 * be more than one ask's, or none, is attributed to none of them: those asks are marked `unresolved`, and every stray
 * answer is carried on the run's newest ask so it is still shown, labelled as not matched to a specific ask.
 */
function assignRun(run: AgentDecision[], answers: string[]): void {
  if (!answers.length) return;
  const last = run[run.length - 1]!;
  if (answers.length >= run.length) {
    run.forEach((d, k) => { setAnswer(d, answers[k]!); });
    const extra = answers.slice(run.length);
    if (extra.length) last.strayAnswers = extra;
    return;
  }
  const plan = answers.map((text) => ({ text, fit: run.filter((d) => fitsAsk(d, text)) }));
  const taken = new Set<AgentDecision>(); const stray: string[] = [];
  for (const p of plan) {
    const only = p.fit.length === 1 ? p.fit[0]! : null;
    // Two answers that both fit only the same ask say nothing about which of them is that ask's.
    const contested = only !== null && plan.some((q) => q !== p && q.fit.length === 1 && q.fit[0] === only);
    if (only === null || contested) { stray.push(p.text); continue; }
    taken.add(only); setAnswer(only, p.text);
  }
  if (!stray.length) return;
  for (const d of run) if (!taken.has(d)) d.unresolved = true;
  last.strayAnswers = stray;
}
/**
 * Every DECISION_RECORDED as question cards: packed options split out, then the answers recorded after it matched to
 * them. Asks recorded back to back with no answer between them form one run, and the answers that follow the run (same
 * scope, before the stage closes) belong to that run; an empty `Details` is not an answer and takes no slot.
 */
function agentDecisionsOf(events: AuditEvent[]): AgentDecision[] {
  const asks = new Map<number, AgentDecision>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!; if (e.event !== "DECISION_RECORDED") continue;
    const decision = e.fields.Decision ?? "";
    const questions = packedQuestions(decision, e.fields.Options ?? "");
    applyTitles(decision, questions);
    asks.set(i, { ts: e.ts, stage: e.fields.Stage ?? null, unit: e.fields.Unit ?? null, decision, answerText: null, unassigned: [], unresolved: false, strayAnswers: [], questions });
  }
  const done = new Set<number>();
  for (const [i, first] of asks) {
    if (done.has(i)) continue;
    const run = [i]; const answers: string[] = [];
    for (let j = i + 1; j < events.length; j++) {
      const n = events[j]!; if (!sameScope(n, first.stage, first.unit)) continue;
      if (n.event !== null && CLOSERS.includes(n.event)) break;
      if (n.event === "DECISION_RECORDED") { if (answers.length) break; run.push(j); continue; }
      if (n.event === "QUESTION_ANSWERED") { const t = n.fields.Details?.trim(); if (t) answers.push(t); }
    }
    for (const idx of run) done.add(idx);
    assignRun(run.map((idx) => asks.get(idx)!), answers);
  }
  return [...asks.values()];
}

export async function decisionsLens(c: LensCtx) {
  const files = (await walk(c.rec)).filter((w) => !w.dir && w.rel.endsWith("-questions.md"));
  const groups: { stage: string; unit: string | null; file: string; when: string | null; context: string[]; questions: Question[]; gate: (AuditEvent & { kind: "gate" | "plan" }) | null }[] = [];
  for (const f of files) {
    let md: string; try { md = await Bun.file(f.abs).text(); } catch { continue; }
    const stage = basename(f.rel).slice(0, -"-questions.md".length); const unit = unitOf(f.rel, c.catalog);
    const { context, questions } = parseQuestions(md);
    groups.push({ stage, unit, file: f.rel, when: lastOf(c.events, ["QUESTION_ANSWERED"], stage, unit)?.ts ?? null, context, questions, gate: closer(c.events, stage, unit) });
  }
  groups.sort((a, b) => (a.when === b.when ? 0 : a.when === null ? 1 : b.when === null ? -1 : b.when.localeCompare(a.when)));
  return { groups, agentDecisions: agentDecisionsOf(c.events) };
}

/** Recorded paths are rewritten against the workspace path, so compare in that (non-realpathed) frame. */
function fileEvents(c: LensCtx, rel: string) {
  const want = join(recordDirOf(c.root, c.ref), rel);
  return c.events.filter((e) => (e.event === "ARTIFACT_CREATED" || e.event === "ARTIFACT_UPDATED") && e.fields.File && rewriteRecordedPath(e.fields.File, c.root) === want);
}

/** Whether the record dir sits in a git work tree: a `.git` entry in it or any ancestor up to the workspace root (stat only). */
async function inGit(c: LensCtx): Promise<boolean> {
  let top: string; try { top = await realpath(c.root); } catch { return false; }
  for (let d = c.rec; ; d = dirname(d)) {
    try { await stat(join(d, ".git")); return true; } catch { /* none here */ }
    if (d === top || dirname(d) === d || !d.startsWith(top)) return false;
  }
}

export async function artifactsLens(c: LensCtx): Promise<{ tree: TreeEntry[]; truncated: boolean; isGit: boolean }> {
  const ws = await walk(c.rec);
  const tree = ws.map((w) => { const stage = stageOf(w.rel, c.catalog); return { path: w.rel, dir: w.dir, size: w.size, mtime: w.mtime, edits: w.dir ? 0 : fileEvents(c, w.rel).length, stage, agent: agentOf(stage, c.catalog) }; });
  return { tree, truncated: ws.truncated === true, isGit: await inGit(c) };
}

/** Returns null when the path is not a regular file contained in the record dir. */
export async function artifactLens(c: LensCtx, path: string) {
  if (!path || path.includes("\0")) return null;
  const abs = join(c.rec, path);
  const real = await contain(c.rec, abs); if (!real) return null;
  let st: Stats; try { st = await stat(real); } catch { return null; }
  if (!st.isFile()) return null;
  const rel = abs.slice(c.rec.length + 1).split("\\").join("/");
  const ext = extname(real).toLowerCase();
  const kind: "md" | "html" | "text" = ext === ".md" || ext === ".markdown" ? "md" : ext === ".html" || ext === ".htm" ? "html" : "text";
  const body = await Bun.file(real).slice(0, MAX_BODY).text();
  const evs = fileEvents(c, rel); const stage = stageOf(rel, c.catalog);
  return { path: rel, body, kind, truncated: st.size > MAX_BODY, provenance: { stage, agent: agentOf(stage, c.catalog), edits: evs.length, created: evs.find((e) => e.event === "ARTIFACT_CREATED")?.ts ?? null } };
}

export async function reviewsLens(c: LensCtx) {
  const verdicts = c.events.filter((e) => e.event === "REVIEW_COMPLETED");
  const findings: (Finding & { stage: string | null; unit: string | null; file: string | null })[] = [];
  const records = (await contain(join(c.root, "aidlc"), join(c.rec, ".aidlc-engine/reviews"))) ? await readReviewRecords(c.rec) : [];
  if (records.length) for (const r of records) for (const f of r.findings) findings.push({ ...f, stage: r.stage ?? null, unit: r.unit, file: null });
  else for (const w of await walk(c.rec)) {
    if (w.dir || !w.rel.endsWith(".md")) continue;
    let md: string; try { md = await Bun.file(w.abs).text(); } catch { continue; }
    const rv = parseEmbeddedReview(md); if (!rv) continue;
    for (const f of rv.findings) findings.push({ ...f, stage: stageOf(w.rel, c.catalog), unit: unitOf(w.rel, c.catalog), file: w.rel });
  }
  return { verdicts, findings };
}

/**
 * Affirmed practices in a memory file: inside `## Forbidden` / `## Mandated`, every non-blank line that starts with
 * NEVER / ALWAYS (any case) or `- `, with `<!-- … -->` comments removed. A section ends at a `---` line or the next `##`.
 */
export function countPractices(md: string): { mandated: number; forbidden: number } {
  let cur: "mandated" | "forbidden" | null = null; const n = { mandated: 0, forbidden: 0 };
  for (const raw of md.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const line = raw.trim();
    const h = line.match(/^##\s+(.*)$/);
    if (h) { const t = h[1]!.trim().toLowerCase(); cur = t.startsWith("mandated") ? "mandated" : t.startsWith("forbidden") ? "forbidden" : null; continue; }
    if (/^---/.test(line)) { cur = null; continue; }
    if (cur && (/^(never|always)\b/i.test(line) || line.startsWith("- "))) n[cur]++;
  }
  return n;
}

export async function learningsLens(c: LensCtx) {
  const mem = join(c.root, "aidlc/spaces", c.ref.space, "memory"); const files: Record<string, string> = {};
  for (const f of ["org.md", "team.md", "project.md"]) {
    const p = await contain(join(c.root, "aidlc"), join(mem, f)); if (!p) continue;
    try { files[f] = await Bun.file(p).text(); } catch { /* none */ }
  }
  const rules = parseLearnings(files);
  const perStage: Record<string, number> = {};
  for (const r of rules) perStage[r.stage] = (perStage[r.stage] ?? 0) + 1;
  const notes: { stage: string; memory: ReturnType<typeof parseStageMemory> }[] = [];
  for (const w of await walk(c.rec)) {
    if (w.dir || basename(w.rel) !== "memory.md") continue;
    const s = segs(w.rel); if (s.length < 2) continue;
    try { notes.push({ stage: s[s.length - 2]!, memory: parseStageMemory(await Bun.file(w.abs).text()) }); } catch { /* skip */ }
  }
  const practices = { mandated: 0, forbidden: 0 };
  for (const f of ["project.md", "team.md"]) { const n = countPractices(files[f] ?? ""); practices.mandated += n.mandated; practices.forbidden += n.forbidden; }
  return { rules, perStage, notes, practices };
}

type Breakdown = { totals: Tokens; byStage: Record<string, Tokens>; byModel: Record<string, Tokens>; byAgent: Record<string, Tokens> };
export async function tokensLens(c: LensCtx): Promise<Recorded<Breakdown> & { source?: "ledger" | "audit" }> {
  const ledger = await readContainedLedger(c.root, c.ref.uuid);
  if (ledger.recorded) return { ...ledger, source: "ledger" };
  const sc = tokenEvents(c.events);
  if (!sc.length) return ledger;
  const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const totals = zero(); const byStage: Record<string, Tokens> = {};
  for (const e of sc) {
    const i = tokenCount(e.fields["Tokens In"])!; const o = tokenCount(e.fields["Tokens Out"]) ?? 0;
    totals.input += i; totals.output += o;
    if (e.fields.Stage) { const s = byStage[e.fields.Stage] ?? zero(); byStage[e.fields.Stage] = s; s.input += i; s.output += o; }
  }
  return { recorded: true, value: { totals, byStage, byModel: {}, byAgent: {} }, source: "audit" };
}
