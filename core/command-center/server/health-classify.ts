// Pure classification rules for "Needs fixing". Each rule keys on text AIDLC itself writes (drop reasons, ERROR_LOGGED
// markers, sensor notes, checkpoint fields); nothing here invents a cause. A fix is AIDLC's own remedy text when the
// record carries one (source "aidlc"), else a short documented hint (source "hint"), else null.
import type { IssueGroup, Recoverable } from "./hooks-map";

export type Fix = { text: string; source: "aidlc" | "hint" } | null;
const hint = (text: string): Fix => ({ text, source: "hint" });

// ─── Hook drops (`<hook>.drops`: `ISO\treason` per line) ────────────────────────────────────────────────

export type DropCategory = "audit-write-lost" | "lock-contention" | "unreadable" | "orphan-cleaned" | "subprocess" | "enforcement-skipped"
  | "stop-released" | "engine-probe" | "by-design" | "internal-error" | "other";

export const DROP_META: Record<DropCategory, { label: string; group: IssueGroup; recoverable: Recoverable; fix: Fix; benign?: string }> = {
  "audit-write-lost": { label: "audit write lost", group: "failure", recoverable: "no", fix: hint("The audit row is gone and cannot be recovered. If this repeats, another process is holding the audit lock or the audit folder is not writable.") },
  "lock-contention": { label: "lock contention", group: "failure", recoverable: "yes", fix: hint("Transient: another AIDLC process held the lock and the hook let the call through. Investigate only if it repeats.") },
  unreadable: { label: "unreadable or malformed record", group: "failure", recoverable: "needs-you", fix: hint("A record the hook needed could not be read; the hook skipped it. Inspect the file named in the message.") },
  "orphan-cleaned": { label: "orphan cleaned up", group: "failure", recoverable: "yes", fix: null, benign: "AIDLC cleaned it up" },
  subprocess: { label: "sensor or compile subprocess failed", group: "failure", recoverable: "yes", fix: hint("The check did not run this time; the next write re-runs it. Check that the sensor's tool is installed if it repeats.") },
  "enforcement-skipped": { label: "enforcement skipped", group: "failure", recoverable: "needs-you", fix: hint("A guard let a call through without enforcing. The message names the record it needed.") },
  "stop-released": { label: "stop released (stalled run)", group: "failure", recoverable: "needs-you", fix: hint("The Stop hook gave up re-prompting after its cap: the run stalled. Look at what the agent was waiting on, then resume.") },
  "engine-probe": { label: "engine probe failed", group: "failure", recoverable: "needs-you", fix: hint("The Stop hook could not read the engine's next step and let the turn end. Run the engine's next step by hand to see the error.") },
  "by-design": { label: "stop allowed by design", group: "failure", recoverable: "yes", fix: null, benign: "by design (a carve-out, not a failure)" },
  "internal-error": { label: "internal error caught", group: "failure", recoverable: "needs-you", fix: hint("A hook crashed and failed open. Report it with the message shown.") },
  other: { label: "other", group: "failure", recoverable: "needs-you", fix: null },
};

const JS_ERROR = /\b(TypeError|ReferenceError|RangeError|SyntaxError)\b|Cannot read properties of|is not a function|Unexpected token|JSON Parse error/;
const ERRNO = /\bE(NOENT|ACCES|PERM|EXIST|BUSY|ISDIR|NOTDIR|MFILE|NOSPC|ROFS)\b|no such file or directory|permission denied/i;

/** First matching rule wins; the order puts the more specific outcome (a lost row, a guard not enforcing) first. */
export function classifyDrop(reason: string): DropCategory {
  const r = reason;
  if (/recursion guard released/i.test(r)) return "stop-released";
  if (/row dropped|row not recorded|emission failed/i.test(r)) return "audit-write-lost";
  if (/lock contended/i.test(r)) return "lock-contention";
  if (/orphaned\b.*cleaned it up|pruned \d+ orphaned/i.test(r)) return "orphan-cleaned";
  if (/engine next returned no parseable directive|unknown engine directive kind/i.test(r)) return "engine-probe";
  if (/enforcement skipped|refusing\b.*\bfallback/i.test(r)) return "enforcement-skipped";
  if (/\b(timed out|could not start|dispatcher exit|could not run)\b|killed by SIGTERM|\bexit \d+:/i.test(r)) return "subprocess";
  if (JS_ERROR.test(r)) return "internal-error";
  if (/malformed|unreadable|evidence unavailable|Unexpected end of JSON input/i.test(r) || ERRNO.test(r)) return "unreadable";
  // Only the Stop hook's named carve-outs are by design; anything else that lets a stop through is a failure.
  if (/carve-out|fresh-session handoff boundary|waiting on the human|declining the parked allow/i.test(r)) return "by-design";
  return "other";
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;
export function parseDrops(text: string): { at: string | null; reason: string; line: number }[] {
  const out: { at: string | null; reason: string; line: number }[] = [];
  text.split("\n").forEach((raw, i) => {
    const l = raw.replace(/\r$/, ""); if (!l.trim()) return;
    const tab = l.indexOf("\t"); const head = tab >= 0 ? l.slice(0, tab) : "";
    if (tab >= 0 && ISO.test(head)) out.push({ at: head, reason: l.slice(tab + 1), line: i + 1 });
    else out.push({ at: null, reason: l, line: i + 1 });
  });
  return out;
}

// ─── ERROR_LOGGED ───────────────────────────────────────────────────────────────────────────────

export interface Remedy { action: string; command?: string; requiresHuman: boolean; executableNow: boolean }
const remedyOf = (r: unknown): Remedy | null => {
  if (!r || typeof r !== "object") return null; const o = r as Record<string, unknown>;
  if (typeof o.action !== "string") return null;
  return { action: o.action, command: typeof o.command === "string" ? o.command : undefined, requiresHuman: o.requiresHuman === true, executableNow: o.executableNow === true };
};
const remedyText = (rs: Remedy[]) => rs.map((r) => (r.command ? `${r.action} (${r.command})` : r.action)).join(" · ");

export interface GuardAsk { question: string | null; stage: string | null; unit: string | null; reasonCodes: string[]; remedies: Remedy[]; terminal: boolean }
/** The typed guard-recovery ask AIDLC appends as the last JSON line of a refusal, or null. */
export function parseGuardAsk(error: string): GuardAsk | null {
  const at = error.lastIndexOf('{"kind"'); if (at < 0) return null;
  const tail = error.slice(at).trim();
  let o: unknown = null;
  // The audit stores newlines as `\n`, which the parser turns back into real newlines, also inside the JSON's strings.
  for (const t of [tail, tail.replace(/\n/g, "\\n")]) { try { o = JSON.parse(t); break; } catch { o = null; } }
  if (!o || typeof o !== "object") return null; const d = o as Record<string, unknown>;
  if (d.kind !== "ask" || d.ask_type !== "guard-recovery") return null;
  const remedies = (Array.isArray(d.remedies) ? d.remedies : []).map(remedyOf).filter((x): x is Remedy => x !== null);
  const codes = Array.isArray(d.reason_codes) ? d.reason_codes.filter((x): x is string => typeof x === "string") : [];
  const terminal = typeof d.state_signature === "string" && !remedies.some((r) => r.executableNow);
  return { question: typeof d.question === "string" ? d.question : null, stage: typeof d.stage === "string" ? d.stage : null, unit: typeof d.unit === "string" ? d.unit : null, reasonCodes: codes, remedies, terminal };
}

export interface ErrorClass { kind: string; group: IssueGroup; recoverable: Recoverable; fix: Fix; terminal?: boolean; detail?: string; askStage?: string | null; askUnit?: string | null }
const CRASH = /\b(ENOENT|EACCES|EPERM|EEXIST|EBUSY):|Audit emission failed:|\btimed out\b/;
const MISUSE = /^(Usage:|Unknown )|Missing --|Invalid --|requires --/;
const REFUSAL = /\bRefusing\b|(^|\.\s+)Cannot\b|\bis refused\b/;

export function classifyError(f: Record<string, string>): ErrorClass {
  const err = f.Error ?? "";
  const ask = parseGuardAsk(err);
  if (ask) {
    const human = ask.terminal || ask.remedies.some((r) => r.requiresHuman);
    return {
      kind: "Guard refusal", group: "refused", recoverable: human ? "needs-you" : "yes", terminal: ask.terminal, askStage: ask.stage, askUnit: ask.unit,
      fix: ask.remedies.length ? { text: remedyText(ask.remedies), source: "aidlc" } : hint("No remedy is available to the agent: a person has to decide how to proceed."),
      detail: [ask.reasonCodes.length ? `Reason codes: ${ask.reasonCodes.join(", ")}` : null, ask.terminal ? "Terminal: the same refusal repeated past its cap with nothing the agent can run." : null].filter(Boolean).join(" · ") || undefined,
    };
  }
  if (f.Source === "error-directive") return { kind: "Engine refusal", group: "refused", recoverable: "needs-you", fix: hint("The engine refused the step when the turn ended; its message says what it needs.") };
  if (/\[merge-succeeded:[0-9a-f]+\]|Do not retry/i.test(err)) return { kind: "Needs a person (do not retry)", group: "failure", recoverable: "needs-you", fix: hint("AIDLC says not to retry: the earlier step already took effect. A person has to reconcile what is left.") };
  if (CRASH.test(err) || JS_ERROR.test(err)) {
    const timeout = /\btimed out\b/.test(err) && !/\b(ENOENT|EACCES|EPERM|EEXIST|EBUSY):/.test(err) && !JS_ERROR.test(err);
    return { kind: "Internal error", group: "failure", recoverable: timeout ? "yes" : "needs-you", fix: hint(timeout ? "The command ran out of time; retrying usually works." : "A command crashed instead of refusing. Retry once; if it repeats, report it with the command shown.") };
  }
  if (MISUSE.test(err.trim())) return { kind: "Command misuse", group: "refused", recoverable: "yes", fix: hint("The agent called a command wrongly; AIDLC refused it and the agent corrects the call.") };
  if (REFUSAL.test(err)) return { kind: "Refused", group: "refused", recoverable: "yes", fix: hint("AIDLC refused this action as designed; the message says what it needs first.") };
  return { kind: "Error (unclassified)", group: "failure", recoverable: "needs-you", fix: null };
}

// ─── Sensors, checkpoints, guard-refusal records, recovery breadcrumb, Stop counter ─────────────────────

/** A SENSOR_PASSED that carries a `Note` did not run (tool-unavailable, script-error, …): it is not a pass. */
export const sensorNotRun = (f: Record<string, string>): string | null => (f.Note?.trim() ? f.Note.trim() : null);
export const SENSOR_NOTE_HINT: Record<string, string> = {
  "tool-unavailable": "The tool this sensor runs is not installed or not on PATH.",
  "script-error": "The sensor's script failed before it could judge the file.",
  "bad-output": "The sensor produced output AIDLC could not read.",
  "external-sigterm": "The sensor was killed from outside (for example a timeout).",
  "detail-write-failed": "The sensor ran but its detail file could not be written.",
};
export const noteHint = (note: string): Fix => {
  const k = note.split(":")[0]!.trim();
  const t = SENSOR_NOTE_HINT[k] ?? (/^exit-\d+$/.test(k) ? "The sensor exited with an error code." : /^signal-/.test(k) ? "The sensor was stopped by a signal." : null);
  return t ? hint(`${t} The check did not run; the next write re-runs it.`) : hint("The check did not run; the next write re-runs it.");
};

/** AIDLC kills a verification check after CHECK_TIMEOUT_MS (aidlc-construction-checkpoints.ts); a little slack on top. */
export const CHECK_TIMEOUT_MS = 120_000 + 30_000;
export type CheckpointState = "crashed" | "running" | "failed" | "non-idempotent" | "ok" | "unknown";
/** `finished_at: null` is a run in progress until it is older than the check timeout; after that it crashed. */
export function checkpointState(cp: unknown, now = Date.now()): CheckpointState {
  if (!cp || typeof cp !== "object") return "unknown"; const c = cp as Record<string, unknown>;
  if ("finished_at" in c && c.finished_at === null) {
    const t = typeof c.started_at === "string" ? Date.parse(c.started_at) : NaN;
    return Number.isFinite(t) && now - t <= CHECK_TIMEOUT_MS ? "running" : "crashed";
  }
  if (c.error === "CHECK_KEPT_CHANGING") return "non-idempotent";
  if (c.verified === true) return "ok";
  if (c.verified === false && typeof c.exit_code === "number" && c.exit_code !== 0) return "failed";
  if (c.verified === false && c.signal) return "failed";
  return "unknown";
}

export type RefusalState = "terminal" | "needs-human" | "recoverable";
/** `<eng>/guard-refusals/<sha>.json`: past the cap (count > 2) with no executable remedy is terminal. */
export function guardRefusalState(rec: unknown): RefusalState | null {
  if (!rec || typeof rec !== "object") return null; const r = rec as Record<string, unknown>;
  if (typeof r.count !== "number" || !r.refusal || typeof r.refusal !== "object") return null;
  const remedies = (Array.isArray((r.refusal as Record<string, unknown>).remedies) ? (r.refusal as { remedies: unknown[] }).remedies : []).map(remedyOf).filter((x): x is Remedy => x !== null);
  if (r.count > 2 && !remedies.some((x) => x.executableNow)) return "terminal";
  if (remedies.some((x) => x.requiresHuman)) return "needs-human";
  return "recoverable";
}
export const refusalRemedies = (rec: unknown): Remedy[] => {
  const ref = (rec as { refusal?: { remedies?: unknown } } | null)?.refusal;
  return (Array.isArray(ref?.remedies) ? ref.remedies : []).map(remedyOf).filter((x): x is Remedy => x !== null);
};
export { remedyText };

/** The validate-state breadcrumb is a failure only when it says the state file is INVALID. */
export function recoveryInvalid(md: string): string | null {
  const m = md.match(/INVALID\s+—\s+missing sections:[^\n]*/);
  return m ? m[0].trim() : null;
}

const AUTONOMOUS_CAP = 8;
/** `<eng>/stop-hook/block-count.json` at or over the autonomous cap is a stalled run; the interactive cap (2) hands back to a person. */
export function stopCounterStalled(rec: unknown, autonomous: boolean): { count: number; cap: number } | null {
  if (!autonomous || !rec || typeof rec !== "object") return null;
  const n = (rec as Record<string, unknown>).count;
  return typeof n === "number" && n >= AUTONOMOUS_CAP ? { count: n, cap: AUTONOMOUS_CAP } : null;
}

// ─── Heartbeats ─────────────────────────────────────────────────────────────────────────────────

export const STALE_SLACK_MS = 5 * 60_000;
export const FROZEN_MS = 24 * 3_600_000;
/**
 * `lasts`: hook → `.last` ISO text (the rate-limit marker `reviewer-scope.missing-record.last` already excluded).
 * Record state (AIDLC's own rule): stale when the newest heartbeat is more than 5 min older than the newest STAGE_/GATE_
 * row; never when there is none although such rows exist. Per hook: stale when the record is, frozen when that hook's
 * heartbeat is more than 24 h older than the newest STAGE_/GATE_ row (a warning; session hooks can be legitimately old).
 */
export function heartbeatStates(lasts: Record<string, string>, newestProgress: string | null, _hasDir: boolean): {
  record: "ok" | "stale" | "never"; newest: string | null; hooks: Record<string, "ok" | "stale" | "frozen">;
} {
  const prog = newestProgress ? Date.parse(newestProgress) : NaN;
  let newest: string | null = null; let newestMs = -Infinity;
  for (const v of Object.values(lasts)) { const t = Date.parse(v); if (Number.isFinite(t) && t > newestMs) { newestMs = t; newest = v; } }
  const record = newest === null ? (Number.isFinite(prog) ? "never" : "ok") : Number.isFinite(prog) && prog - newestMs > STALE_SLACK_MS ? "stale" : "ok";
  const hooks: Record<string, "ok" | "stale" | "frozen"> = {};
  for (const [h, v] of Object.entries(lasts)) {
    const t = Date.parse(v);
    hooks[h] = record === "stale" ? "stale" : Number.isFinite(prog) && Number.isFinite(t) && prog - t > FROZEN_MS ? "frozen" : "ok";
  }
  return { record, newest, hooks };
}
