// The issue log's pure parts: state, plain-word titles, filters, the CSV export (RFC 4180) and the plain-text report.
// Everything is built in the browser from the payload already on screen; nothing is written by the server.
import { GROUP_META, type Issue, type IssueGroup, type ScopedIssue, shortPhase } from "../../../../core/command-center/server/hooks-map";

export type AnyIssue = Issue | ScopedIssue;
export type IssueState = "open" | "resolved" | "accepted";
export const stateOf = (i: Issue): IssueState => (i.resolved ? "resolved" : i.group === "accepted" ? "accepted" : "open");
export const STATE_META: Record<IssueState, { glyph: string; label: string; cls: string; title: string }> = {
  open: { glyph: "○", label: "Open", cls: "il-st-open", title: "No later record shows this resolved" },
  resolved: { glyph: "✓", label: "Resolved", cls: "il-st-resolved", title: "A later record shows this resolved" },
  accepted: { glyph: "☑", label: "Accepted at gate", cls: "il-st-accepted", title: "A non-blocking check still failing (or not run) when its stage or unit passed its gate: listed, not counted" },
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The kind in plain words: a check names its sensor ("Traceability check failed"); everything else is the kind as recorded. */
export function titleOf(i: Issue): string {
  if (i.kind === "Check failed" || i.kind === "Check did not run") {
    const id = i.message.match(/^([A-Za-z0-9_.-]+)(?::| reported)/)?.[1];
    if (id) { const name = cap(id.replace(/[-_]/g, " ")); const check = /check$/i.test(name) ? name : `${name} check`; return `${check} ${i.kind === "Check failed" ? "failed" : "did not run"}`; }
  }
  return i.kind;
}
const hookLine = (i: Issue) => (i.where.hook ? `${i.where.hook}${i.where.hookPhase ? ` · ${shortPhase(i.where.hookPhase)}` : ""}` : "");
/** The row's sub-line: stage · unit, else hook · phase, else the tool. */
export function subOf(i: Issue): string {
  const su = [i.where.stage, i.where.unit].filter(Boolean).join(" · ");
  return su || hookLine(i) || i.where.tool || "";
}
export const wsLabel = (ws: string) => ws.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || ws;

export type Range = "24h" | "7d" | "30d" | "all";
export const RANGE_MS: Record<Exclude<Range, "all">, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
export type StateFilter = "all" | IssueState;
/** `chip`: "all", a group (its items not resolved) or "resolved". */
export type Chip = "all" | IssueGroup | "resolved";
export interface LogFilter { q: string; range: Range; ws: string; state: StateFilter; chip: Chip }
export const NO_FILTER: LogFilter = { q: "", range: "all", ws: "", state: "all", chip: "all" };

/** Search covers what the record says: the message, kind, stage, unit, hook and tool. */
export function matchesQuery(i: Issue, q: string): boolean {
  const t = q.trim().toLowerCase(); if (!t) return true;
  return [i.message, i.kind, titleOf(i), i.where.stage, i.where.unit, i.where.hook, i.where.tool].some((x) => !!x && x.toLowerCase().includes(t));
}
/** Search, time range and workspace: what the chip counts are taken over. */
export function baseFilter<T extends AnyIssue>(issues: T[], f: LogFilter, now: number): T[] {
  return issues.filter((i) => {
    if (!matchesQuery(i, f.q)) return false;
    if (f.ws && (i as ScopedIssue).workspace !== f.ws) return false;
    if (f.range !== "all") { const t = i.at ? Date.parse(i.at) : NaN; if (!Number.isFinite(t) || now - t > RANGE_MS[f.range]) return false; }
    return true;
  });
}
export const chipOf = (i: Issue, chip: Chip) => chip === "all" || (chip === "resolved" ? !!i.resolved : !i.resolved && i.group === chip);
export function applyFilter<T extends AnyIssue>(issues: T[], f: LogFilter, now: number): T[] {
  return baseFilter(issues, f, now).filter((i) => (f.state === "all" || stateOf(i) === f.state) && chipOf(i, f.chip));
}
export function chipCounts(issues: AnyIssue[]): Record<Chip, number> {
  const n: Record<Chip, number> = { all: issues.length, "hard-stop": 0, failure: 0, refused: 0, bypass: 0, accepted: 0, resolved: 0 };
  for (const i of issues) { if (i.resolved) n.resolved++; else n[i.group]++; }
  return n;
}
/** Newest first (or oldest first); entries without a time go last either way. */
export function sortByRecorded<T extends AnyIssue>(issues: T[], dir: "desc" | "asc"): T[] {
  return [...issues].sort((a, b) => {
    if (!a.at || !b.at) return a.at ? -1 : b.at ? 1 : 0;
    return dir === "desc" ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at);
  });
}

// ─── Export ───────────────────────────────────────────────────────────────────────────────────

export const CSV_COLUMNS = ["recorded_at", "group", "state", "kind", "workspace", "intent", "stage", "unit", "hook", "phase", "count", "first_recorded", "last_recorded",
  "recoverable", "message", "cause_summary", "remedy", "remedy_source", "resolved_by", "resolved_at", "audit_file", "audit_line"] as const;
/**
 * RFC 4180: a field is quoted when it holds a comma, a double quote, CR or LF (quotes doubled); records end in CRLF.
 * A text value starting with = + - @, a tab or CR is prefixed with `'` so a spreadsheet never runs it as a formula.
 */
export function csvField(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function row(i: AnyIssue): (string | number | null)[] {
  const s = i as Partial<ScopedIssue>;
  const ev = i.evidence;
  return [i.at, GROUP_META[i.group].label, STATE_META[stateOf(i)].label, i.kind, s.workspace ?? "", s.intentKey ? s.intentName ?? "" : s.intentName === "workspace" ? "(workspace)" : "",
    i.where.stage ?? "", i.where.unit ?? "", i.where.hook ?? "", i.where.hookPhase ?? "", i.count, i.firstAt ?? i.at, i.at, i.recoverable, i.message,
    i.cause?.summary ?? "", i.fix?.text ?? "", i.fix?.source ?? "", i.resolved?.by ?? "", i.resolved?.at ?? "",
    ev?.auditFile ?? i.source.file, ev ? ev.focusLine ?? ev.startLine : i.source.line ?? ""];
}
export function issuesCsv(issues: AnyIssue[]): string {
  return [CSV_COLUMNS.join(","), ...issues.map((i) => row(i).map(csvField).join(","))].join("\r\n") + "\r\n";
}

/** One issue as readable plain text, with its cause, remedy, resolution and the evidence lines. */
export function issueText(i: AnyIssue): string {
  const s = i as Partial<ScopedIssue>; const L: string[] = [];
  L.push(`${titleOf(i)} [${GROUP_META[i.group].label} · ${STATE_META[stateOf(i)].label}]`);
  if (s.workspace) L.push(`Workspace: ${s.workspace}`);
  if (s.intentName) L.push(`Intent: ${s.intentKey ? s.intentName : "(workspace level)"}`);
  const su = [i.where.stage, i.where.unit].filter(Boolean).join(" · "); if (su) L.push(`Stage / unit: ${su}${i.where.inferred ? ` (inferred: ${i.where.inferred})` : ""}`);
  if (i.where.hook) L.push(`Hook / phase: ${hookLine(i)}`);
  if (i.where.tool) L.push(`Tool: ${i.where.tool}`);
  L.push(`Recorded: ${i.count} occurrence${i.count === 1 ? "" : "s"}${i.at ? `, ${i.firstAt && i.firstAt !== i.at ? `first ${i.firstAt}, last ${i.at}` : i.at}` : ", no time recorded"}`);
  L.push(`Recoverable: ${i.recoverable}`);
  L.push("Message:", ...i.message.split("\n").map((l) => `  ${l}`));
  if (i.detail) L.push(`Detail: ${i.detail}`);
  if (i.cause) { L.push(`Cause (from the records): ${i.cause.summary}`); for (const p of i.cause.points) L.push(`  - ${p.label}: ${p.value.replace(/\n/g, "\n    ")}`); }
  else L.push("Cause: No cause recorded — AIDLC wrote only the message above.");
  L.push(i.fix ? `Remedy (${i.fix.source === "aidlc" ? "AIDLC" : "Hint"}): ${i.fix.text}` : "Remedy: none recorded");
  L.push(i.resolved ? `Resolution: resolved by ${i.resolved.by}${i.resolved.at ? ` at ${i.resolved.at}` : ""}` : "Resolution: No resolution recorded.");
  const ev = i.evidence;
  if (ev) {
    L.push(`Evidence: ${ev.auditFile}`);
    ev.lines.forEach((l, k) => { const n = ev.startLine + k; L.push(`${n === ev.focusLine ? ">" : " "}${String(n).padStart(6)}  ${l}`); });
    for (const f of ev.supporting) L.push(`Supporting file: ${f.path} (${f.label})`);
  } else L.push(`Source: ${i.source.file}${i.source.line ? `:${i.source.line}` : ""}`);
  return L.join("\n");
}
export function issuesReport(issues: AnyIssue[], generatedAt: string): string {
  return [`AIDLC issue report · ${issues.length} entr${issues.length === 1 ? "y" : "ies"} · generated ${generatedAt}`, ...issues.map((i, k) => `\n#${k + 1} ${issueText(i)}`)].join("\n") + "\n";
}
