import { lstat, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AuditEvent } from "../types";
import { contain } from "../paths";

const TS = /^\*\*Timestamp\*\*:\s*(\S+)/m;
const FIELD = /^\*\*([A-Za-z][A-Za-z0-9 ._()/-]*)\*\*:\s?(.*)$/;

export interface ParseResult { events: AuditEvent[]; unparsed: number; tailHeld: number }

/**
 * `lineStart`: the 1-based shard line `text` starts on (an incremental read passes where it left off). Each event
 * carries `line`/`endLine`, the shard lines of its block from its first to its last non-blank line (the header excluded).
 */
export function parseAuditText(text: string, shard: string, seqStart = 0, lineStart: number | null = 1): ParseResult {
  // LF or CRLF: a Windows checkout of a committed shard has CRLF line ends.
  const parts = text.split(/\r?\n---\r?\n/);
  const tail = parts.pop() ?? "";
  const events: AuditEvent[] = [];
  let unparsed = 0;
  let seq = seqStart;
  let at = lineStart ?? 1; // the shard line each part starts on (null: unknown, so no line numbers are given)
  for (const part of parts) {
    const raw = part.replace(/\r\n/g, "\n");
    const partStart = at; const rawLines = raw.split("\n");
    at += rawLines.length + 1; // the part's own lines, then the `---` separator line
    const body = raw.trim();
    if (!body || /^# AI-DLC Audit Log\s*$/.test(body)) continue;
    const lines = body.split("\n").filter((l) => !/^# AI-DLC Audit Log/.test(l));
    const heading = (lines.find((l) => l.startsWith("## ")) ?? "## ").slice(3).trim();
    const tsm = lines.join("\n").match(TS);
    if (!tsm) { unparsed++; continue; }
    const fields: Record<string, string> = {};
    let event: string | null = null;
    for (const l of lines) {
      const m = l.match(FIELD);
      if (!m) continue;
      const key = m[1]!; const val = m[2]!.replace(/\\n/g, "\n");
      if (key === "Timestamp") continue;
      if (key === "Event") { event = val.trim(); continue; }
      if (!(key in fields)) fields[key] = val;
    }
    let first = -1; let last = -1;
    rawLines.forEach((l, i) => { if (l.trim() && !/^# AI-DLC Audit Log/.test(l)) { if (first < 0) first = i; last = i; } });
    events.push({ ts: tsm[1]!, event, heading, fields, shard, seq: seq++, ...(lineStart !== null ? { line: partStart + first, endLine: partStart + last } : {}) });
  }
  return { events, unparsed, tailHeld: tail.trim() ? tail.length : 0 };
}

export function mergeShards(lists: AuditEvent[][]): AuditEvent[] {
  return lists.flat().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.shard === b.shard ? a.seq - b.seq : a.shard < b.shard ? -1 : 1));
}

/**
 * Every `*.md` shard in `dir`, merged. `dir` must already be contained in `root`; a shard that is not a
 * plain file (e.g. a symlink) is read only when it realpath-resolves inside `root`, else it is skipped.
 */
export async function readAuditDir(dir: string, root: string): Promise<{ events: AuditEvent[]; unparsed: number; texts: Map<string, string> }> {
  let names: string[] = []; const texts = new Map<string, string>();
  try { names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort(); } catch { return { events: [], unparsed: 0, texts }; }
  const lists: AuditEvent[][] = []; let unparsed = 0;
  for (const n of names) {
    const plain = await lstat(join(dir, n)).then((x) => x.isFile(), () => false);
    const p = plain ? join(dir, n) : await contain(root, join(dir, n));
    if (!p) continue;
    const text = await Bun.file(p).text(); texts.set(n, text);
    const r = parseAuditText(text, n);
    lists.push(r.events); unparsed += r.unparsed;
  }
  /** `texts`: each shard's text by file name, so evidence can quote its lines without reading it again. */
  return { events: mergeShards(lists), unparsed, texts };
}

/** `line`: the shard line the next read starts on; absent when it is not known (a cursor primed from the file size), and then entries read through this cursor carry no line numbers. */
export interface AuditCursor { path: string; offset: number; size: number; seq: number; line?: number }

export async function readAuditIncremental(path: string, cursor: AuditCursor | null): Promise<{ events: AuditEvent[]; cursor: AuditCursor; reset: boolean; unparsed: number }> {
  const s = await stat(path);
  const shard = basename(path);
  const reset = cursor !== null && s.size < cursor.offset;
  const start = cursor && !reset ? cursor.offset : 0;
  const text = await Bun.file(path).slice(start, s.size).text();
  const line = cursor && !reset ? cursor.line ?? null : 1;
  const r = parseAuditText(text, shard, cursor && !reset ? cursor.seq : 0, line);
  const consumed = text.length - r.tailHeld; // chars held back as tail; the cursor advances by the UTF-8 byte length of the consumed part
  const done = text.slice(0, consumed); const bytes = Buffer.byteLength(done, "utf8");
  let nl = 0; for (let i = done.indexOf("\n"); i >= 0; i = done.indexOf("\n", i + 1)) nl++;
  return { events: r.events, unparsed: r.unparsed, reset, cursor: { path, offset: start + bytes, size: s.size, seq: (cursor && !reset ? cursor.seq : 0) + r.events.length, ...(line !== null ? { line: line + nl } : {}) } };
}
