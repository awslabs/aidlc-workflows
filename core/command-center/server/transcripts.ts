// Opt-in, read-only scan of Claude Code transcripts for hook failures only. AIDLC does not persist a hook crash (a
// crashing hook fails open and only writes stderr), but Claude Code records the failure in the session transcript.
//
// What is read: only the transcripts named by `<ws>/aidlc/.aidlc-sessions/*.transcript` pointer files (AIDLC writes the
// live transcript path there), and only when that path realpath-resolves to a `.jsonl` regular file inside
// `~/.claude/projects/`. Files are streamed line by line, at most the last MAX_BYTES of each. What is returned: the
// hook, its event, the timestamp and the error text of hook-failure records — never a user or assistant message.
import type { Stats } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { contain } from "./paths";

export const DEFAULT_PROJECTS_ROOT = join(homedir(), ".claude", "projects");
export const MAX_BYTES = 64 * 1024 * 1024;
const MAX_POINTER = 4096;
const MAX_ERROR = 2000;

export interface TranscriptHookFailure { hook: string; event: string | null; at: string | null; error: string; transcript: string; line: number }
export interface TranscriptScan {
  status: "on" | "unavailable" | "unrecognised"; failures: TranscriptHookFailure[]; read: number; refused: number; truncated: boolean;
  /** Hook runs seen (every `hook_*` attachment) and AIDLC Stop-hook re-prompts (by design, not counted as failures). */
  runs: number; reprompts: number;
}

/**
 * Claude Code records each hook run as an `attachment` entry whose `attachment.type` starts with `hook_`
 * (`hook_success` with an `exitCode`, `hook_blocking_error`, …) and sums Stop hooks in a `system` entry with
 * `subtype: "stop_hook_summary"` and `hookErrors`. A non-empty transcript with no `hook_*` attachment is not one we recognise.
 */

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const clipErr = (s: string) => (s.length > MAX_ERROR ? `${s.slice(0, MAX_ERROR - 1)}…` : s);
/** The AIDLC hook a hook command runs (the dispatcher's `engine hook <name>`), else the command's program name, else the harness label. */
export function hookNameOf(command: string | null, label: string | null): string {
  const m = command?.match(/\bengine\s+hook\s+([a-z][a-z-]*)/) ?? command?.match(/aidlc-([a-z][a-z-]*)\.ts\b/);
  if (m) return m[1]!;
  const prog = command?.trim().split(/\s+/)[0]?.split("/").at(-1);
  return prog || label || "unknown hook";
}
const eventOf = (explicit: unknown, label: string | null) => str(explicit) ?? (label ? label.split(":")[0]! : null);
/**
 * How AIDLC's Stop hook has begun the message it re-prompts the agent with — the current wordings from
 * `continuationReason()` in `core/hooks/aidlc-continue-workflow.ts` of the AIDLC repo, plus the earlier ones still
 * found in older transcripts. Used ONLY for a `stop_hook_summary` string, which names no hook and so cannot be judged
 * by its command; a `hook_blocking_error` is judged by its command and whether its text is crash-shaped, so new
 * wording never reads as a failure.
 */
export const AIDLC_REPROMPT_PREFIXES = [
  "The AIDLC workflow has a pending step",
  "The delivered AIDLC steering part",
  "The exact delivered AIDLC run-stage",
  "AI-DLC coordination evidence is missing",
  "The AIDLC workflow still",
  "The AI-DLC workflow is",
  "The AIDLC workflow returned an error diagnostic",
  "AI-DLC is carrying on",
  "The last AI-DLC step stopped on a problem",
  "Stop hook feedback:",
] as const;
export const isRepromptText = (t: string) => AIDLC_REPROMPT_PREFIXES.some((p) => t.trimStart().startsWith(p));
/** Exactly the native dispatcher's `engine hook continue-workflow`, with at most a leading path; nothing chained, substituted or added. */
// `[ ]` is one literal space, the same match as before; it keeps this file free of the
// native command spelling that copy-channel files must not carry (t238).
const CONTINUE_WORKFLOW = /^(\S*\/)?aidlc[ ]engine hook continue-workflow\s*$/;
const SHELL_META = /&&|\|\||[;|`]|\$\(/;
/** Text that is a crash, not a re-prompt: an errno prefix, a JS error, an exit code, or a stack-trace line. */
const CRASH_TEXT = /\b(ENOENT|EACCES|EPERM|EEXIST|EBUSY):|\b(TypeError|ReferenceError|SyntaxError)\b|Cannot read properties of|is not a function|Unexpected token|JSON Parse error|exit code|(^|\n) {4}at /;
/** By design only when all three hold: a Stop event, exactly AIDLC's continue-workflow command, and text that is not a crash. */
const isAidlcReprompt = (event: string | null, command: string | null, text: string) => {
  const c = command?.trim() ?? "";
  return event === "Stop" && !SHELL_META.test(c) && CONTINUE_WORKFLOW.test(c) && !CRASH_TEXT.test(text);
};
const UNNAMED_STOP = "Stop hook (unnamed)";
/** Within a transcript, blocking-error texts already counted (with when), so a Stop summary repeating one is not counted twice. */
export interface ScanCtx { blocking: { text: string; at: number; tool: string | null }[] }
const SAME_STOP_MS = 60_000;
const CTX_KEEP = 64;

export interface EntryHooks { run: boolean; reprompts: number; failures: Omit<TranscriptHookFailure, "transcript" | "line">[] }
/**
 * What one transcript entry says about hooks. Only `attachment` and `system` entries are looked at — never `user` or
 * `assistant` entries — and of a run only the hook, event, time, exit code and stderr (or the blocking error) are kept:
 * never stdout or content.
 */
export function hookEntry(o: Record<string, unknown>, ctx: ScanCtx = { blocking: [] }): EntryHooks {
  const out: EntryHooks = { run: false, reprompts: 0, failures: [] };
  const at = str(o.timestamp);
  if (o.type === "attachment" && o.attachment && typeof o.attachment === "object") {
    const a = o.attachment as Record<string, unknown>;
    if (typeof a.type !== "string" || !a.type.startsWith("hook_")) return out;
    out.run = true;
    const label = str(a.hookName); const event = eventOf(a.hookEvent, label);
    if (a.type === "hook_success") {
      if (typeof a.exitCode === "number" && a.exitCode !== 0) {
        const hook = hookNameOf(str(a.command), label); const err = str(a.stderr);
        out.failures.push({ hook, event, at, error: clipErr(`exit ${a.exitCode}${err ? `: ${err.trim()}` : ""}`) });
      }
      return out;
    }
    if (a.type === "hook_blocking_error") {
      const be = a.blockingError && typeof a.blockingError === "object" ? (a.blockingError as Record<string, unknown>) : null;
      const command = str(be?.command) ?? str(a.command); const hook = hookNameOf(command, label);
      const text = str(be?.blockingError) ?? "blocking error";
      const byDesign = isAidlcReprompt(event, command, text);
      // Only a Stop entry can account for a Stop summary string, and only when it was itself by design.
      if (event === "Stop" && byDesign) {
        ctx.blocking.push({ text: text.trim(), at: at ? Date.parse(at) : NaN, tool: str(o.toolUseID) });
        if (ctx.blocking.length > CTX_KEEP) ctx.blocking.splice(0, ctx.blocking.length - CTX_KEEP);
      }
      if (byDesign) { out.reprompts++; return out; }
      out.failures.push({ hook, event, at, error: clipErr(text) });
      return out;
    }
    if (a.type === "hook_non_blocking_error" || a.type === "hook_error_during_execution" || a.type === "hook_cancelled") {
      const command = str(a.command); const hook = hookNameOf(command, label);
      const exit = typeof a.exitCode === "number" ? `exit ${a.exitCode}` : null; const err = str(a.stderr);
      out.failures.push({ hook, event, at, error: clipErr([exit, err?.trim()].filter(Boolean).join(": ") || a.type.replace(/_/g, " ")) });
    }
    return out;
  }
  // `hookErrors` are plain strings that name no hook: they are never paired with `hookInfos` by index.
  if (o.type === "system" && o.subtype === "stop_hook_summary" && Array.isArray(o.hookErrors)) {
    const t = at ? Date.parse(at) : NaN; const tool = str(o.toolUseID);
    for (const e of o.hookErrors) {
      if (typeof e !== "string" || !e.trim()) continue;
      // Drop entries too old to match anything still to come, so the list stays short on a long transcript.
      if (Number.isFinite(t)) for (let k = ctx.blocking.length - 1; k >= 0; k--) { const b = ctx.blocking[k]!; if (Number.isFinite(b.at) && t - b.at > SAME_STOP_MS) ctx.blocking.splice(k, 1); }
      const seen = ctx.blocking.findIndex((b) => b.text === e.trim() && ((tool && b.tool === tool) || (Number.isFinite(t) && Number.isFinite(b.at) && Math.abs(t - b.at) <= SAME_STOP_MS)));
      if (seen >= 0) { ctx.blocking.splice(seen, 1); continue; } // already counted from its by-design Stop blocking error
      if (isRepromptText(e)) { out.reprompts++; continue; }
      out.failures.push({ hook: UNNAMED_STOP, event: "Stop", at, error: clipErr(e) });
    }
  }
  return out;
}

type Parsed = { recognised: boolean; empty: boolean; runs: number; reprompts: number; failures: Omit<TranscriptHookFailure, "transcript">[]; truncated: boolean };
const cache = new Map<string, { sig: string; parsed: Parsed }>();

/** Streams the last MAX_BYTES of `path` line by line; only lines that mention a hook are parsed at all. */
async function parseFile(path: string, size: number, maxBytes: number): Promise<Parsed> {
  const start = Math.max(0, size - maxBytes);
  const reader = Bun.file(path).slice(start, size).stream().getReader();
  const dec = new TextDecoder(); let buf = ""; let n = 0; let skipFirst = start > 0;
  const out: Parsed = { recognised: false, empty: true, runs: 0, reprompts: 0, failures: [], truncated: start > 0 };
  const ctx: ScanCtx = { blocking: [] };
  const take = (line: string) => {
    n++;
    if (skipFirst) { skipFirst = false; return; } // the cut landed mid-line
    const t = line.trim(); if (!t) return;
    out.empty = false;
    if (!t.startsWith("{") || !/"(hook_|stop_hook_summary)/.test(t)) return;
    let o: unknown; try { o = JSON.parse(t); } catch { return; }
    if (!o || typeof o !== "object" || Array.isArray(o)) return;
    const h = hookEntry(o as Record<string, unknown>, ctx);
    const rec = o as Record<string, unknown>;
    if (h.run) out.runs++;
    if (h.run || (rec.type === "system" && rec.subtype === "stop_hook_summary")) out.recognised = true;
    out.reprompts += h.reprompts;
    for (const f of h.failures) out.failures.push({ ...f, line: n });
  };
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    for (i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) { take(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  buf += dec.decode(); if (buf) take(buf);
  return out;
}

/** The transcript files a workspace's pointer files name, each realpath-contained in `projectsRoot`; `refused` counts the rest. */
export async function transcriptTargets(wsRoot: string, projectsRoot: string): Promise<{ targets: string[]; refused: number }> {
  const base = join(wsRoot, "aidlc");
  const dir = await contain(base, join(base, ".aidlc-sessions")); if (!dir) return { targets: [], refused: 0 };
  let names: string[] = []; try { names = (await readdir(dir)).filter((n) => n.endsWith(".transcript")).sort(); } catch { return { targets: [], refused: 0 }; }
  const targets = new Set<string>(); let refused = 0;
  for (const n of names) {
    const p = await contain(base, join(dir, n)); if (!p) { refused++; continue; }
    let raw: string; try { if (!(await stat(p)).isFile()) continue; raw = (await Bun.file(p).slice(0, MAX_POINTER).text()).trim(); } catch { continue; }
    if (!raw || raw.includes("\0") || !isAbsolute(raw)) { refused++; continue; }
    const real = await contain(projectsRoot, raw);
    if (!real?.endsWith(".jsonl")) { refused++; continue; }
    try { if (!(await lstat(real)).isFile()) { refused++; continue; } } catch { continue; }
    targets.add(real);
  }
  return { targets: [...targets].sort(), refused };
}

export async function scanTranscripts(wsRoot: string, projectsRoot = DEFAULT_PROJECTS_ROOT, maxBytes = MAX_BYTES): Promise<TranscriptScan> {
  const { targets, refused } = await transcriptTargets(wsRoot, projectsRoot);
  const res: TranscriptScan = { status: "unavailable", failures: [], read: 0, refused, truncated: false, runs: 0, reprompts: 0 };
  let recognised = 0;
  for (const t of targets) {
    let st: Stats; try { st = await stat(t); } catch { continue; }
    const sig = `${st.size}:${st.mtimeMs}:${maxBytes}`;
    let parsed = cache.get(t)?.sig === sig ? cache.get(t)!.parsed : null;
    if (!parsed) {
      try { parsed = await parseFile(t, st.size, maxBytes); } catch { continue; }
      cache.set(t, { sig, parsed });
    }
    res.read++;
    if (parsed.truncated) res.truncated = true;
    // An empty transcript is a session with nothing in it yet, not an unknown format.
    if (!parsed.recognised && !parsed.empty) continue;
    recognised++; res.runs += parsed.runs; res.reprompts += parsed.reprompts;
    for (const f of parsed.failures) res.failures.push({ ...f, transcript: basename(t) });
  }
  res.status = recognised ? "on" : res.read ? "unrecognised" : "unavailable";
  return res;
}
