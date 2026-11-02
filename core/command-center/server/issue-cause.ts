// "Cause (from the records)": what AIDLC itself recorded about why an issue happened, as a short summary and labelled
// points. Pure functions over text and fields AIDLC wrote; every value is copied from the record (clipped, never
// reworded), and anything without such a record gets no cause (null), never a guess. No Node imports.
import type { IssueCause, IssueEvidence } from "./hooks-map";

const MAX_POINTS = 10;
const MAX_VALUE = 600;
const clip = (s: string, n = MAX_VALUE) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";
type Point = IssueCause["points"][number];
const pt = (label: string, value: unknown): Point | null => {
  if (value === null || value === undefined) return null;
  const v = typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
  return v ? { label, value: clip(v) } : null;
};
const pts = (...xs: (Point | null)[]) => xs.filter((x): x is Point => x !== null);
const cause = (summary: string, points: Point[]): IssueCause => ({ summary: clip(summary, 400), points, source: "aidlc" });

// ─── Sensors ─────────────────────────────────────────────────────────────────────────────────────

/** The JSON object under `## Findings` in a sensor detail file (aidlc-sensor.ts buildDetailBody), or null. */
export function parseSensorDetail(md: string): Record<string, unknown> | null {
  const at = md.search(/^## Findings\s*$/m); if (at < 0) return null;
  const m = md.slice(at).match(/```json\s*\n([\s\S]*?)\n```/); if (!m) return null;
  try { const o = JSON.parse(m[1]!); return o && typeof o === "object" && !Array.isArray(o) ? o as Record<string, unknown> : null; } catch { return null; }
}
/** `missing_from_table` → "missing from table". */
const human = (k: string) => k.replace(/_/g, " ");
const SKIP_KEYS = new Set(["pass", "findings_count", "scanned_files", "headings", "consumes", "questions_file", "h2_count", "template", "template_expected", "edge_block", "errorCount", "warningCount"]);
/** A string-array key as the label of one item: `gaps` → "gap", `missing_from_table` → "missing from table". */
const singular = (k: string) => { const h = human(k); return /ies$/.test(h) ? h.replace(/ies$/, "y") : /[^s]s$/.test(h) ? h.slice(0, -1) : h; };
/**
 * The first findings a sensor's own JSON lists, as points: string items under their key ("gaps → FR-3"), objects
 * by their rule, section or id ("no-unused-vars → 'x' is unused", with file:line when given), then its `reason`.
 */
export function sensorFindingPoints(o: Record<string, unknown>, max = MAX_POINTS): Point[] {
  const out: Point[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (SKIP_KEYS.has(k) || !Array.isArray(v)) continue;
    for (const item of v) {
      if (out.length >= max) return out;
      if (typeof item === "string" || typeof item === "number") { const p = pt(singular(k), String(item)); if (p) out.push(p); continue; }
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const label = [it.rule, it.section, it.heading, it.id, it.code].find((x) => typeof x === "string" && x.trim()) as string | undefined;
      const where = typeof it.file === "string" ? `${it.file}${typeof it.line === "number" ? `:${it.line}${typeof it.column === "number" ? `:${it.column}` : ""}` : ""}` : null;
      const msg = [it.message, it.finding, it.detail, it.status].find((x) => typeof x === "string" && x.trim()) as string | undefined;
      // Without a rule or section, the location is the label (type-check: {file, line, column, message}).
      const p = label ? pt(label, [msg, where ? `(${where})` : null].filter(Boolean).join(" ")) : where ? pt(where, msg ?? JSON.stringify(it)) : pt(singular(k), msg ?? JSON.stringify(it));
      if (p) out.push(p);
    }
  }
  // required-sections judges by how many `##` sections the file has: that count is its finding.
  if (typeof o.h2_count === "number" && out.length < max) { const p = pt("H2 sections found", o.h2_count); if (p) out.push(p); }
  if (typeof o.reason === "string" && out.length < max) { const p = pt("reason", o.reason); if (p) out.push(p); }
  return out;
}
/** SENSOR_FAILED: the findings in its detail file (when readable), plus the audit row's Sensor ID and Output path. */
export function sensorFailedCause(f: Record<string, string>, detailMd: string | null): IssueCause {
  const id = f["Sensor ID"] ?? f.Sensor ?? "sensor";
  const o = detailMd ? parseSensorDetail(detailMd) : null;
  const finds = o ? sensorFindingPoints(o) : [];
  const n = f["Findings count"];
  const summary = o
    ? `${id} recorded ${n ?? finds.length} finding${n === "1" ? "" : "s"}${f["Output path"] ? ` on ${f["Output path"]}` : ""}${finds.length ? "; the first are listed below" : ""}.`
    : `${id} recorded ${n ?? "some"} finding${n === "1" ? "" : "s"}${f["Output path"] ? ` on ${f["Output path"]}` : ""}; ${detailMd === null ? "its detail file is not readable here (missing, or outside the workspace)" : "its detail file lists no findings block"}.`;
  return cause(summary, [...finds, ...pts(pt("Sensor ID", id), pt("Output path", f["Output path"]), pt("Gate effect", f["Gate effect"]), pt("Fire id", f["Fire id"]))]);
}
/** A check that did not run: SENSOR_PASSED with a Note, or SENSOR_BUDGET_OVERRIDE with its cap and observed time. */
export function sensorNotRunCause(event: string, f: Record<string, string>): IssueCause {
  const id = f["Sensor ID"] ?? f.Sensor ?? "sensor";
  if (event === "SENSOR_BUDGET_OVERRIDE") {
    const cap = f["Cap value"]; const obs = f["Observed value"];
    return cause(`${id} ran past its time budget${cap ? ` (cap ${cap} s` : ""}${cap && obs ? `, observed ${obs} s)` : cap ? ")" : ""}, so its result was not recorded.`,
      pts(pt("Cap value", cap && `${cap} s`), pt("Observed value", obs && `${obs} s`), pt("Cap layer", f["Cap layer"]), pt("Reason", f.Reason), pt("Sensor ID", id), pt("Output path", f["Output path"])));
  }
  return cause(`${id} recorded the note "${f.Note?.trim() ?? ""}" instead of a result.`, pts(pt("Note", f.Note), pt("Sensor ID", id), pt("Output path", f["Output path"]), pt("Duration", f["Duration ms"] && `${f["Duration ms"]} ms`)));
}

// ─── Guard refusals ──────────────────────────────────────────────────────────────────────────────

const remedyPoints = (rs: unknown): Point[] => (Array.isArray(rs) ? rs : []).flatMap((r, i) => {
  if (!r || typeof r !== "object") return [];
  const o = r as Record<string, unknown>; if (typeof o.action !== "string") return [];
  const tags = [o.requiresHuman === true ? "needs a person" : null, o.executableNow === true ? "the agent can run it now" : o.executableNow === false ? "not runnable now" : null].filter(Boolean);
  return pts(pt(`Remedy ${i + 1}`, `${o.action}${typeof o.command === "string" ? ` (${o.command})` : ""}${tags.length ? ` · ${tags.join(", ")}` : ""}`));
});
/** `<eng>/guard-refusals/<sha>.json` (GuardRefusalRecord): what was blocked, the invariant, codes, state and remedies. */
export function guardRecordCause(d: Record<string, unknown>): IssueCause | null {
  const r = d.refusal; if (!r || typeof r !== "object") return null;
  const ref = r as Record<string, unknown>;
  const codes = Array.isArray(d.codes) ? d.codes.filter((x) => typeof x === "string").join(", ") : null;
  const blocked = typeof ref.blockedAction === "string" ? ref.blockedAction : null;
  const summary = `${blocked ? `AIDLC refused to ${blocked}` : "AIDLC refused the action"}${typeof ref.invariant === "string" ? `: ${ref.invariant}` : ""}${typeof d.count === "number" ? ` (refused ${d.count}×)` : ""}.`;
  return cause(summary, [...pts(pt("Blocked action", blocked), pt("Invariant", ref.invariant), pt("Reason codes", codes || ref.code), pt("State", ref.state), pt("Stage", ref.stage), pt("Unit", ref.unit),
    pt("Refused", typeof d.count === "number" ? `${d.count}×` : null), pt("Last refused", d.updatedAt)), ...remedyPoints(ref.remedies)]);
}
/** The guard-recovery JSON ask at the end of an ERROR_LOGGED: its question, reason codes, remedies and signature. */
export function guardAskCause(error: string, f: Record<string, string>): IssueCause | null {
  const at = error.lastIndexOf('{"kind"'); if (at < 0) return null;
  const tail = error.slice(at).trim(); let o: Record<string, unknown> | null = null;
  for (const t of [tail, tail.replace(/\n/g, "\\n")]) { try { const v = JSON.parse(t); if (v && typeof v === "object") { o = v as Record<string, unknown>; break; } } catch { /* next */ } }
  if (o?.ask_type !== "guard-recovery") return null;
  const codes = Array.isArray(o.reason_codes) ? o.reason_codes.filter((x) => typeof x === "string").join(", ") : null;
  const sentence = firstLine(error.slice(0, at));
  return cause(sentence || (typeof o.question === "string" ? o.question : "AIDLC refused the action and asked how to proceed."),
    [...pts(pt("Question", o.question), pt("Reason codes", codes), pt("Stage", o.stage), pt("Unit", o.unit), pt("State signature", o.state_signature), pt("Tool", f.Tool), pt("Command", f.Command && clip(f.Command, 300))), ...remedyPoints(o.remedies)]);
}

// ─── Errors and checkpoints ─────────────────────────────────────────────────────────────────────

const ERRNO_RE = /\b(ENOENT|EACCES|EPERM|EEXIST|EBUSY|EISDIR|ENOTDIR|EMFILE|ENOSPC|EROFS|ETIMEDOUT|ECONNREFUSED)\b/;
const JS_CLASS_RE = /\b(TypeError|ReferenceError|RangeError|SyntaxError)\b/;
/** ERROR_LOGGED (not a guard ask): Tool, Command (clipped), the error's first line, and the errno or error class it names. */
export function errorCause(f: Record<string, string>): IssueCause {
  const err = f.Error ?? ""; const line = firstLine(err);
  const errno = err.match(ERRNO_RE)?.[1] ?? null; const cls = err.match(JS_CLASS_RE)?.[1] ?? null;
  const timeout = /\btimed out\b/.test(err) ? "timed out" : null;
  return cause(line ? `ERROR_LOGGED recorded${f.Tool ? ` for ${f.Tool}` : ""}: ${line}` : "The entry records no error text.",
    pts(pt("Tool", f.Tool), pt("Command", f.Command && clip(f.Command, 300)), pt("Error", line), pt("Errno", errno), pt("Error class", cls), pt("Crash shape", !errno && !cls ? timeout : null),
      pt("Exit code", f["Exit Code"]), pt("Source", f.Source), pt("Observed by", f["Observed By"])));
}
const tailOf = (v: unknown, n = 6) => (typeof v === "string" && v.trim() ? v.trimEnd().split("\n").slice(-n).join("\n") : null);
/** A verification checkpoint record: exit code, signal, error, the last lines of its stderr and stdout tails, its times. */
export function checkpointCause(d: Record<string, unknown>, state: "crashed" | "failed" | "non-idempotent"): IssueCause {
  const label = typeof d.command_label === "string" ? d.command_label : "the verification command";
  const summary = state === "crashed" ? `${label} started${typeof d.started_at === "string" ? ` ${d.started_at}` : ""} and its record has no finish time.`
    : state === "non-idempotent" ? `${label}: the record's error is ${String(d.error)}.`
    : `${label} finished with exit code ${d.exit_code ?? "(none)"}${d.signal ? ` and signal ${d.signal}` : ""}.`;
  return cause(summary, pts(pt("Command", label), pt("Exit code", d.exit_code), pt("Signal", d.signal), pt("Error code", d.error), pt("Verified", d.verified),
    pt("stderr (last lines)", tailOf(d.stderr_tail)), pt("stdout (last lines)", tailOf(d.stdout_tail)), pt("Started", d.started_at), pt("Finished", d.finished_at === null ? "not recorded" : d.finished_at)));
}

// ─── Hooks ──────────────────────────────────────────────────────────────────────────────────────

/** A `<hook>.drops` line: the line itself, its category, the hook and its phase. */
export function dropCause(o: { reason: string; at: string | null; category: string; hook: string; phase: string | null; file: string; line: number }): IssueCause {
  return cause(`The ${o.hook} hook recorded a drop: ${firstLine(o.reason)}`, pts(pt("Drop line", o.reason), pt("Category", o.category), pt("Hook", o.hook), pt("Phase", o.phase), pt("Recorded at", o.at), pt("File", `${o.file}:${o.line}`)));
}
/** Hooks not running: the newest heartbeat against the newest stage or gate row. */
export function hookNotRunningCause(o: { newestHook: string | null; newestAt: string | null; progressEvent: string; progressAt: string; progressStage: string | null }): IssueCause {
  const gap = o.newestAt ? Math.round((Date.parse(o.progressAt) - Date.parse(o.newestAt)) / 60_000) : null;
  return cause(o.newestAt ? `The newest hook heartbeat (${o.newestAt}) is ${gap} min older than the newest stage or gate entry (${o.progressAt}).` : `No hook heartbeat is recorded, but the audit has a ${o.progressEvent} at ${o.progressAt}.`,
    pts(pt("Newest heartbeat", o.newestAt ? `${o.newestHook ?? "a hook"} · ${o.newestAt}` : "none recorded"), pt("Newest stage/gate entry", `${o.progressEvent}${o.progressStage ? ` · ${o.progressStage}` : ""} · ${o.progressAt}`),
      pt("Gap", gap === null ? null : `${gap} min`), pt("Dashboard threshold", "5 min")));
}
/** The Stop hook's no-progress counter at or over the autonomous cap. The signature starts with the stage it saw. */
export function stallCause(rec: Record<string, unknown>, cap: number): IssueCause {
  const sig = typeof rec.signature === "string" ? rec.signature : null;
  const stage = sig?.includes("::") ? sig.split("::")[0] || null : null;
  return cause(`block-count.json records ${String(rec.count)} no-progress blocks against a cap of ${cap}${stage ? ` while the state named ${stage}` : ""}.`,
    pts(pt("Block count", rec.count), pt("Cap", cap), pt("Stage in the signature", stage), pt("Signature", sig && clip(sig, 120))));
}

// ─── Evidence ───────────────────────────────────────────────────────────────────────────────────

const MAX_EVIDENCE_LINES = 60;
/**
 * Lines `start`..`end` (1-based, inclusive) of a file's text as evidence, clipped to MAX_EVIDENCE_LINES around
 * `focus`. `file` is workspace-relative.
 */
export function evidenceFrom(file: string, lines: string[], start: number, end: number, focus: number | null, supporting: IssueEvidence["supporting"] = []): IssueEvidence {
  let n = lines.length; while (n > 1 && !lines[n - 1]!.replace(/\r$/, "")) n--; // a trailing newline is not a line
  let s = Math.max(1, Math.min(start, n)); let e = Math.min(n, Math.max(s, end));
  if (e - s + 1 > MAX_EVIDENCE_LINES) {
    const f = focus && focus >= s && focus <= e ? focus : s;
    s = Math.max(s, f - 10); e = Math.min(e, s + MAX_EVIDENCE_LINES - 1);
  }
  return { auditFile: file, startLine: s, lines: lines.slice(s - 1, e).map((l) => clip(l.replace(/\r$/, ""), 2000)), focusLine: focus, supporting };
}
