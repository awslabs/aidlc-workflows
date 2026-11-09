// aidlc-ooxml.ts - the text of a Word (.docx) or Excel (.xlsx) file for the
// knowledge index, read with Bun's built-ins only. Both are zip archives of
// XML. Bytes in, text out, no I/O.
//
// Every size, offset and count the file states is the author's to choose, so
// each is checked against the buffer before it is used, and the reader fails
// closed (an error) rather than guessing. The central directory is the one
// listing used, for detection and for reading: its sizes are real even in a
// streamed zip (bit 3, as Java, Apache POI and Go write them), where a local
// header carries zeros.
import { inflateRawSync } from "node:zlib";

export const OOXML_ENTRIES_MAX = 4096;
export const OOXML_ENTRY_INFLATE_MAX = 64 * 1024 * 1024;
export const OOXML_TOTAL_INFLATE_MAX = 128 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_MARK = 0xffffffff;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export class OoxmlError extends Error {}

/** The archive's entries from its central directory (names only, nothing inflated). Throws on anything it cannot trust. */
export function listZip(buf: Buffer, entriesMax = OOXML_ENTRIES_MAX): ZipEntry[] {
  if (buf.length < 22) throw new OoxmlError("it is not a zip archive");
  let eocd = -1;
  for (let at = buf.length - 22, stop = Math.max(0, buf.length - 22 - 0xffff); at >= stop; at--) {
    if (buf.readUInt32LE(at) === EOCD_SIG) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new OoxmlError("it is not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirAt = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirSize === ZIP64_MARK || dirAt === ZIP64_MARK) throw new OoxmlError("it is a zip64 archive");
  if (count > entriesMax) throw new OoxmlError(`it holds more than ${entriesMax} parts`);
  if (dirAt + dirSize > eocd) throw new OoxmlError("its zip directory is damaged");
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let at = dirAt;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || buf.readUInt32LE(at) !== CENTRAL_SIG) throw new OoxmlError("its zip directory is damaged");
    const nameLen = buf.readUInt16LE(at + 28);
    const end = at + 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    if (end > eocd) throw new OoxmlError("its zip directory is damaged");
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const localOffset = buf.readUInt32LE(at + 42);
    if (compressedSize === ZIP64_MARK || size === ZIP64_MARK || localOffset === ZIP64_MARK) {
      throw new OoxmlError("it is a zip64 archive");
    }
    const name = buf.toString("utf-8", at + 46, at + 46 + nameLen);
    // The first of a repeated name is the part; a second copy is never read.
    if (!seen.has(name)) {
      seen.add(name);
      entries.push({ name, method: buf.readUInt16LE(at + 10), compressedSize, size, localOffset });
    }
    at = end;
  }
  return entries;
}

/** Word, Excel, or neither, from the archive's part names alone. */
export function ooxmlKind(buf: Buffer): "word" | "excel" | null {
  let names: Set<string>;
  try {
    names = new Set(listZip(buf).map((entry) => entry.name));
  } catch {
    return null;
  }
  if (!names.has("[Content_Types].xml")) return null;
  if (names.has("word/document.xml")) return "word";
  if (names.has("xl/workbook.xml")) return "excel";
  return null;
}

interface Budget {
  left: number;
}

function entryBytes(buf: Buffer, entry: ZipEntry, budget: Budget, entryMax: number): Buffer {
  const at = entry.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL_SIG) throw new OoxmlError(`its part ${entry.name} is damaged`);
  const dataAt = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  if (dataAt + entry.compressedSize > buf.length) throw new OoxmlError(`its part ${entry.name} is damaged`);
  const raw = buf.subarray(dataAt, dataAt + entry.compressedSize);
  const max = Math.min(entryMax, budget.left);
  let out: Buffer;
  if (entry.method === 0) {
    if (raw.length > max) throw new OoxmlError(`its part ${entry.name} is too large to read`);
    out = raw;
  } else if (entry.method === 8) {
    try {
      out = inflateRawSync(raw, { maxOutputLength: max });
    } catch (e) {
      const tooLarge = (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE";
      throw new OoxmlError(tooLarge ? `its part ${entry.name} is too large to read` : `its part ${entry.name} is damaged`);
    }
  } else {
    throw new OoxmlError(`its part ${entry.name} uses a compression AI-DLC does not read`);
  }
  budget.left -= out.length;
  return out;
}

/** Reads the named parts (and only those), as UTF-8 text; a part that is not there is absent from the map. */
export function readParts(
  buf: Buffer,
  wanted: (name: string) => boolean,
  caps: { entriesMax?: number; entryMax?: number; totalMax?: number } = {},
): Map<string, string> {
  const budget = { left: caps.totalMax ?? OOXML_TOTAL_INFLATE_MAX };
  const parts = new Map<string, string>();
  for (const entry of listZip(buf, caps.entriesMax)) {
    if (!wanted(entry.name)) continue;
    parts.set(entry.name, entryBytes(buf, entry, budget, caps.entryMax ?? OOXML_ENTRY_INFLATE_MAX).toString("utf-8"));
  }
  return parts;
}

// --- XML ---------------------------------------------------------------------
// Element names are matched without their prefix: Word writes w:p, the Open XML
// SDK may write x:c where Excel writes c.

function decode(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-fA-F]+|#[0-9]+);/g, (whole, name: string) => {
    if (name === "lt") return "<";
    if (name === "gt") return ">";
    if (name === "quot") return '"';
    if (name === "apos") return "'";
    if (name === "amp") return "&";
    const code = name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? decode(m[1]) : undefined;
}

// mc:AlternateContent carries the same content twice (Choice, then Fallback): only the Choice is read.
function dropFallbacks(xml: string): string {
  return xml.replace(/<(?:[\w.-]+:)?Fallback\b[\s\S]*?<\/(?:[\w.-]+:)?Fallback>/g, "");
}

function cell(text: string): string {
  return text.replace(/\s*\n\s*/g, " / ").replace(/\|/g, "\\|").trim();
}

function table(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(row[i] ?? "")).join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)];
}

/** A Word document's text: paragraphs as lines, tables as Markdown tables. */
export function docxText(parts: Map<string, string>): string {
  const xml = parts.get("word/document.xml");
  if (xml === undefined) throw new OoxmlError("it has no document part");
  const out: string[] = [];
  let para = "";
  let inText = false;
  let depth = 0;
  let rows: string[][] = [];
  let row: string[] = [];
  let cellParas: string[] = [];
  for (const m of dropFallbacks(xml).matchAll(/<(\/?)(?:[\w.-]+:)?([\w.-]+)\b[^>]*?(\/?)>|([^<]+)/g)) {
    const [, closing, name, selfClosing, text] = m;
    if (text !== undefined) {
      if (inText) para += decode(text);
      continue;
    }
    if (name === "t") inText = closing !== "/" && selfClosing !== "/";
    else if (name === "tab" && closing !== "/") para += "\t";
    else if ((name === "br" || name === "cr") && closing !== "/") para += "\n";
    else if (name === "p" && closing === "/") {
      if (depth > 0) cellParas.push(para);
      else out.push(para);
      para = "";
    } else if (name === "p" && selfClosing === "/") {
      if (depth === 0) out.push("");
    } else if (name === "tbl") {
      if (closing !== "/") {
        depth++;
        if (depth === 1) rows = [];
      } else if (--depth === 0) {
        out.push(...table(rows), "");
      }
    } else if (name === "tr" && depth === 1) {
      if (closing !== "/") row = [];
      else rows.push(row);
    } else if (name === "tc" && depth === 1) {
      if (closing !== "/") cellParas = [];
      else row.push(cellParas.join("\n"));
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function columnIndex(ref: string): number | null {
  const letters = /^([A-Za-z]+)/.exec(ref)?.[1];
  if (letters === undefined) return null;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function runsText(xml: string): string {
  return [...xml.replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh>/g, "")
    .matchAll(/<(?:[\w.-]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?t>/g)]
    .map((t) => decode(t[1])).join("");
}

/** An Excel workbook's text: each sheet, in workbook order, as a "## <name>" section and a Markdown table. */
export function xlsxText(parts: Map<string, string>): string {
  const workbook = parts.get("xl/workbook.xml");
  if (workbook === undefined) throw new OoxmlError("it has no workbook part");
  const rels = new Map<string, string>();
  for (const m of (parts.get("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*)>/g)) {
    const id = attr(m[1], "Id");
    const target = attr(m[1], "Target");
    if (id !== undefined && target !== undefined) {
      rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
    }
  }
  const shared = [...(parts.get("xl/sharedStrings.xml") ?? "").matchAll(/<(?:[\w.-]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?si>/g)]
    .map((si) => runsText(si[1]));
  const out: string[] = [];
  for (const m of workbook.matchAll(/<(?:[\w.-]+:)?sheet\b([^>]*?)\/?>/g)) {
    const name = attr(m[1], "name") ?? "Sheet";
    const path = rels.get(attr(m[1], "id") ?? "");
    const xml = path === undefined ? undefined : parts.get(path);
    if (xml === undefined) continue;
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<(?:[\w.-]+:)?row\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?row>)/g)) {
      const cells: string[] = [];
      let next = 0;
      for (const c of (r[1] ?? "").matchAll(/<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/g)) {
        const at = columnIndex(attr(c[1], "r") ?? "") ?? next;
        const body = c[2] ?? "";
        const type = attr(c[1], "t");
        const v = /<(?:[\w.-]+:)?v>([\s\S]*?)<\/(?:[\w.-]+:)?v>/.exec(body)?.[1];
        const value = type === "s" && v !== undefined
          ? (shared[Number(v)] ?? "")
          : type === "inlineStr"
          ? runsText(body)
          : type === "b" && v !== undefined
          ? (v.trim() === "1" ? "TRUE" : "FALSE")
          : decode(v ?? "");
        while (cells.length < at) cells.push("");
        cells[at] = value;
        next = at + 1;
      }
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
      if (cells.length > 0) rows.push(cells);
    }
    out.push(`## ${name}`, "", ...table(rows), "");
  }
  return out.join("\n").trim();
}

/** The text of a Word or Excel file. Throws an OoxmlError, in the person's terms, for one it cannot read. */
export function officeText(buf: Buffer, kind: "word" | "excel"): string {
  if (kind === "word") return docxText(readParts(buf, (name) => name === "word/document.xml"));
  // The workbook and its relationships first, then exactly the parts they name: a sheet may live anywhere.
  const head = readParts(buf, (name) => name === "xl/workbook.xml" || name === "xl/_rels/workbook.xml.rels");
  const used = [...head.values()].reduce((total, text) => total + Buffer.byteLength(text), 0);
  const targets = new Set(
    [...(head.get("xl/_rels/workbook.xml.rels") ?? "").matchAll(/\sTarget\s*=\s*"([^"]*)"/g)]
      .map((m) => decode(m[1])).map((target) => target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`),
  );
  const rest = readParts(buf, (name) => name === "xl/sharedStrings.xml" || targets.has(name), {
    totalMax: OOXML_TOTAL_INFLATE_MAX - used,
  });
  return xlsxText(new Map([...head, ...rest]));
}
