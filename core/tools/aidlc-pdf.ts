// aidlc-pdf.ts - AI-DLC's own PDF reader, on Bun's built-ins only, for a machine without pdftotext (the knowledge
// index runs pdftotext first where it is installed). `pdfText` is pure: bytes in, text out. `readPdfMain` is the
// same reader as a child process, which the engine runs under the extraction timeout so a file that takes too long
// or too much never stalls the engine itself.
//
// Objects are found by scanning (the last definition wins, as after an incremental update) and inside object
// streams; streams decode FlateDecode, ASCIIHex and ASCII85; text comes from the page content streams and their
// form XObjects, mapped through each font's ToUnicode CMap or, for a simple font without one, its encoding and
// glyph names, and through marked-content ActualText. A gap between positioned glyphs becomes a space, a move to a
// new baseline a new line. The standard security handler is opened with the empty user password (RC4 and AES-128,
// revisions 2 to 4). Known limits: AES-256 (revision 6), LZW and RunLength streams, images (no OCR), a composite
// font without ToUnicode, word spacing in scripts with combining marks (Thai, Hindi), and reading order beyond the
// order the writer drew each column in.
import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { constants, inflateSync } from "node:zlib";

export class PdfError extends Error {}
export const PDF_STREAM_INFLATE_MAX = 64 * 1024 * 1024;
export const PDF_TOTAL_INFLATE_MAX = 256 * 1024 * 1024;
const FORM_DEPTH_MAX = 8;
const PAGE_TREE_DEPTH_MAX = 64;

class PName { constructor(readonly n: string) {} }
class PRef { constructor(readonly num: number, readonly gen: number) {} }
class POp { constructor(readonly op: string) {} }
type Val = number | boolean | null | Buffer | PName | PRef | POp | Val[] | Dict;
type Dict = Map<string, Val>;
interface Stream { dict: Dict; data: Buffer; num: number; gen: number }

// --- Lexing and parsing ---------------------------------------------------------------------------------------
const isWs = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c: number) => "()<>[]{}/%".includes(String.fromCharCode(c));

function skip(s: string, i: number): number {
  for (;;) {
    while (i < s.length && isWs(s.charCodeAt(i))) i++;
    if (s[i] !== "%") return i;
    while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++;
  }
}

function literal(s: string, i: number): [Buffer, number] {
  const out: number[] = [];
  let depth = 1;
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const n = s[i + 1];
      const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
      if (n in esc) { out.push(esc[n]); i += 2; continue; }
      if (n >= "0" && n <= "7") {
        let j = i + 1, v = 0;
        while (j < i + 4 && s[j] >= "0" && s[j] <= "7") v = v * 8 + (s.charCodeAt(j++) - 48);
        out.push(v & 255); i = j; continue;
      }
      if (n === "\r") { i += s[i + 2] === "\n" ? 3 : 2; continue; }
      if (n === "\n") { i += 2; continue; }
      i += 2; continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return [Buffer.from(out), i + 1];
    out.push(s.charCodeAt(i) & 255);
    i++;
  }
  return [Buffer.from(out), i];
}

function hex(s: string, i: number): [Buffer, number] {
  const end = s.indexOf(">", i);
  const stop = end < 0 ? s.length : end;
  let h = s.slice(i + 1, stop).replace(/[^0-9a-fA-F]/g, "");
  if (h.length % 2) h += "0";
  return [Buffer.from(h, "hex"), stop + 1];
}

const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)/y;
const REF_TAIL = /\s+(\d+)\s+R(?![^\0\t\n\f\r ()<>[\]{}/%])/y;

function parse(s: string, i: number, depth = 0): [Val, number] {
  if (depth > 256) throw new PdfError("it is damaged (nested too deep)");
  i = skip(s, i);
  const c = s[i];
  if (c === "/") {
    let j = i + 1;
    while (j < s.length && !isWs(s.charCodeAt(j)) && !isDelim(s.charCodeAt(j))) j++;
    const raw = s.slice(i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
    return [new PName(raw), j];
  }
  if (c === "(") return literal(s, i);
  if (c === "<" && s[i + 1] === "<") {
    const d: Dict = new Map();
    i += 2;
    for (;;) {
      i = skip(s, i);
      if (i >= s.length) return [d, i];
      if (s[i] === ">" && s[i + 1] === ">") return [d, i + 2];
      const [k, j] = parse(s, i, depth + 1);
      if (!(k instanceof PName)) { i = j; continue; }
      const [v, j2] = parse(s, j, depth + 1);
      d.set(k.n, v);
      i = j2;
    }
  }
  if (c === "<") return hex(s, i);
  if (c === "[") {
    const a: Val[] = [];
    i++;
    for (;;) {
      i = skip(s, i);
      if (i >= s.length || s[i] === "]") return [a, i + 1];
      const [v, j] = parse(s, i, depth + 1);
      if (j <= i) return [a, i + 1];
      a.push(v);
      i = j;
    }
  }
  NUM.lastIndex = i;
  const m = NUM.exec(s);
  if (m) {
    const n = Number(m[0]);
    const after = i + m[0].length;
    if (/^\d+$/.test(m[0])) {
      REF_TAIL.lastIndex = after;
      const r = REF_TAIL.exec(s);
      if (r) return [new PRef(n, Number(r[1])), after + r[0].length];
    }
    return [n, after];
  }
  let j = i;
  while (j < s.length && !isWs(s.charCodeAt(j)) && !isDelim(s.charCodeAt(j))) j++;
  if (j === i) return [new POp(s[i] ?? ""), i + 1];
  const w = s.slice(i, j);
  return [w === "true" ? true : w === "false" ? false : w === "null" ? null : new POp(w), j];
}

// --- Decoding ---------------------------------------------------------------------------------------------------
function a85(b: Buffer): Buffer {
  const t = b.toString("latin1").replace(/^\s*<~/, "").replace(/~>[\s\S]*$/, "").replace(/\s+/g, "");
  const out: number[] = [];
  let g: number[] = [];
  const flush = (k: number) => {
    let n = 0;
    for (const d of g) n = n * 85 + d;
    out.push(...[(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].slice(0, k));
  };
  for (const ch of t) {
    if (ch === "z" && g.length === 0) { out.push(0, 0, 0, 0); continue; }
    g.push(ch.charCodeAt(0) - 33);
    if (g.length === 5) { flush(4); g = []; }
  }
  if (g.length > 1) { const k = g.length - 1; while (g.length < 5) g.push(84); flush(k); }
  return Buffer.from(out);
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + S[i]) & 255;
    [S[i], S[j]] = [S[j], S[i]];
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}
const md5 = (...parts: Buffer[]) => createHash("md5").update(Buffer.concat(parts)).digest();
const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");

// --- The document -----------------------------------------------------------------------------------------------
class Doc {
  readonly s: string;
  private offsets = new Map<number, number>();
  private gens = new Map<number, number>();
  private cache = new Map<number, Val | Stream>();
  private inStream: Map<number, [number, number]> | null = null;
  private budget = PDF_TOTAL_INFLATE_MAX;
  private crypt: { key: Buffer; aes: boolean } | null = null;
  trailer: Dict = new Map();
  failedStreams = 0;

  constructor(readonly buf: Buffer) {
    this.s = buf.toString("latin1");
    if (!/%PDF-/.test(this.s.slice(0, 1024))) throw new PdfError("it is not a PDF");
    for (const m of this.s.matchAll(/(?<![\d.])(\d+)\s+(\d+)\s+obj\b/g)) {
      this.offsets.set(Number(m[1]), m.index! + m[0].length);
      this.gens.set(Number(m[1]), Number(m[2]));
    }
    if (this.offsets.size === 0) throw new PdfError("it is damaged (no objects)");
    // The trailer: every classic trailer and every cross-reference stream, later ones winning.
    for (const m of this.s.matchAll(/trailer\s*<</g)) for (const [k, v] of parse(this.s, m.index! + 7)[0] as Dict) this.trailer.set(k, v);
    for (const [num] of this.offsets) {
      const head = this.s.slice(this.offsets.get(num)!, this.offsets.get(num)! + 400);
      if (/\/Type\s*\/XRef/.test(head)) {
        const d = parse(this.s, this.offsets.get(num)!)[0];
        if (d instanceof Map) for (const k of ["Root", "Encrypt", "ID", "Info"]) if (d.has(k)) this.trailer.set(k, d.get(k)!);
      }
    }
    const enc = this.trailer.get("Encrypt");
    if (enc !== undefined) this.openCrypt(this.resolve(enc) as Dict);
  }

  private openCrypt(enc: Dict): void {
    if (!(enc instanceof Map)) throw new PdfError("it is encrypted in a way AI-DLC cannot read");
    const filter = enc.get("Filter");
    if (!(filter instanceof PName) || filter.n !== "Standard") throw new PdfError("it is encrypted with a handler AI-DLC does not read");
    const R = Number(enc.get("R") ?? 0);
    const V = Number(enc.get("V") ?? 0);
    if (R >= 5) throw new PdfError("it is encrypted with AES-256, which this reader does not open");
    const n = R === 2 ? 5 : Number(enc.get("Length") ?? 40) / 8;
    const O = enc.get("O") as Buffer;
    const U = enc.get("U") as Buffer;
    const P = Buffer.alloc(4);
    P.writeInt32LE(Number(enc.get("P") ?? 0) | 0);
    const ids = this.resolve(this.trailer.get("ID") ?? []) as Val[];
    const id0 = (Array.isArray(ids) && ids[0] instanceof Buffer ? ids[0] : Buffer.alloc(0)) as Buffer;
    const noMeta = R >= 4 && enc.get("EncryptMetadata") === false ? Buffer.from([255, 255, 255, 255]) : Buffer.alloc(0);
    let h = md5(PAD, O, P, id0, noMeta);
    if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
    const key = h.subarray(0, n);
    let ok: boolean;
    if (R === 2) ok = rc4(key, PAD).equals(U.subarray(0, 32));
    else {
      let x = rc4(key, md5(PAD, id0));
      for (let i = 1; i <= 19; i++) x = rc4(Buffer.from(key.map((b) => b ^ i)), x);
      ok = x.equals(U.subarray(0, 16));
    }
    if (!ok) throw new PdfError("it is protected by a password");
    const cf = (this.resolve(enc.get("CF") ?? new Map()) as Dict)?.get?.("StdCF");
    const cfm = cf instanceof Map ? cf.get("CFM") : undefined;
    this.crypt = { key, aes: V === 4 && cfm instanceof PName && cfm.n === "AESV2" };
  }

  private decrypt(data: Buffer, num: number, gen: number): Buffer {
    if (this.crypt === null) return data;
    const { key, aes } = this.crypt;
    const ext = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
    const k = md5(key, ext, aes ? Buffer.from("sAlT") : Buffer.alloc(0)).subarray(0, Math.min(key.length + 5, 16));
    if (!aes) return rc4(k, data);
    if (data.length < 32) return Buffer.alloc(0);
    const d = createDecipheriv("aes-128-cbc", k, data.subarray(0, 16));
    return Buffer.concat([d.update(data.subarray(16)), d.final()]);
  }

  resolve(v: Val | undefined, depth = 0): Val | undefined {
    while (v instanceof PRef && depth++ < 32) {
      const o = this.obj(v.num);
      v = o !== null && typeof o === "object" && "data" in o && "dict" in o && !(o instanceof Map) ? (o as Stream).dict : (o as Val);
    }
    return v;
  }

  stream(v: Val | undefined): Stream | null {
    if (!(v instanceof PRef)) return null;
    const o = this.obj(v.num);
    return o !== null && typeof o === "object" && !(o instanceof Map) && !Array.isArray(o) && "data" in o ? (o as Stream) : null;
  }

  obj(num: number): Val | Stream | null {
    if (this.cache.has(num)) return this.cache.get(num)!;
    this.cache.set(num, null);
    let v: Val | Stream | null = null;
    const at = this.offsets.get(num);
    if (at !== undefined) v = this.direct(num, at);
    else v = this.packed(num);
    this.cache.set(num, v);
    return v;
  }

  private direct(num: number, at: number): Val | Stream | null {
    const [v, j] = parse(this.s, at);
    if (!(v instanceof Map)) return v;
    const k = skip(this.s, j);
    if (!this.s.startsWith("stream", k)) return v;
    let start = k + 6;
    if (this.s[start] === "\r") start++;
    if (this.s[start] === "\n") start++;
    const len = this.resolve(v.get("Length"));
    let end = typeof len === "number" ? start + len : -1;
    if (end < 0 || end > this.buf.length || !/^\s*endstream/.test(this.s.slice(end, end + 32))) {
      end = this.s.indexOf("endstream", start);
      if (end < 0) end = this.buf.length;
      while (end > start && (this.s[end - 1] === "\n" || this.s[end - 1] === "\r")) end--;
    }
    const gen = this.gens.get(num) ?? 0;
    const type = v.get("Type");
    // An image holds no text: its data is never decrypted or inflated, so it never counts against the caps.
    const subtype = v.get("Subtype");
    if (subtype instanceof PName && subtype.n === "Image") return { dict: v, data: Buffer.alloc(0), num, gen };
    const raw = this.buf.subarray(start, end);
    let data: Buffer;
    try {
      const plain = type instanceof PName && type.n === "XRef" ? raw : this.decrypt(raw, num, gen);
      data = this.decode(v, plain);
    } catch (e) {
      // A stream it cannot decode at all fails the file, with the reason; damaged Flate or AES data is skipped.
      if (e instanceof PdfError) throw e;
      this.failedStreams++;
      data = Buffer.alloc(0);
    }
    return { dict: v, data, num, gen };
  }

  private packed(num: number): Val | null {
    if (this.inStream === null) {
      this.inStream = new Map();
      for (const [n, at] of this.offsets) {
        if (!/\/Type\s*\/ObjStm/.test(this.s.slice(at, at + 400))) continue;
        const st = this.stream(new PRef(n, 0));
        if (st === null) continue;
        const count = Number(st.dict.get("N") ?? 0);
        const head = st.data.toString("latin1", 0, Number(st.dict.get("First") ?? 0)).trim().split(/\s+/).map(Number);
        for (let i = 0; i < count && 2 * i + 1 < head.length; i++) if (!this.inStream.has(head[2 * i])) this.inStream.set(head[2 * i], [n, i]);
      }
    }
    const where = this.inStream.get(num);
    if (where === undefined) return null;
    const st = this.stream(new PRef(where[0], 0))!;
    const first = Number(st.dict.get("First") ?? 0);
    const text = st.data.toString("latin1");
    const head = text.slice(0, first).trim().split(/\s+/).map(Number);
    return parse(text, first + head[2 * where[1] + 1])[0];
  }

  decode(dict: Dict, raw: Buffer): Buffer {
    const f = this.resolve(dict.get("Filter"));
    const filters = (Array.isArray(f) ? f : f === undefined ? [] : [f]).map((x) => (x instanceof PName ? x.n : ""));
    let data = raw;
    for (const name of filters) {
      if (name === "FlateDecode" || name === "Fl") {
        const max = Math.min(PDF_STREAM_INFLATE_MAX, this.budget);
        try {
          data = inflateSync(data, { maxOutputLength: max });
        } catch (e) {
          if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new PdfError("it is too large to read");
          // A stream cut short still gives what it holds.
          data = inflateSync(data, { maxOutputLength: max, finishFlush: constants.Z_SYNC_FLUSH });
        }
        this.budget -= data.length;
      } else if (name === "ASCIIHexDecode" || name === "AHx") data = hex(`<${data.toString("latin1")}`, 0)[0];
      else if (name === "ASCII85Decode" || name === "A85") data = a85(data);
      else if (name === "Crypt") continue;
      // Image codecs: such a stream holds no text.
      else if (["DCTDecode", "DCT", "JPXDecode", "CCITTFaxDecode", "CCF", "JBIG2Decode"].includes(name)) return Buffer.alloc(0);
      else throw new PdfError(`it is compressed with ${name}, which AI-DLC's reader does not decode (pdftotext does)`);
    }
    return data;
  }
}

/** A PDF text string: UTF-16BE after its byte order mark, else PDFDocEncoding (Latin-1 is close enough here). */
function textString(b: Buffer): string {
  return b[0] === 0xfe && b[1] === 0xff ? utf16be(b.subarray(2)) : b.toString("latin1");
}

// --- Fonts ------------------------------------------------------------------------------------------------------
interface Font {
  exact: boolean; // the widths are the font's own, not a guess
  map: (code: number) => string;
  width: (code: number) => number; // in text space units per unit of font size
  split: (b: Buffer) => number[][]; // [code, byte length] pairs
}

// WinAnsi's 0x80 to 0x9f, as code points: this is a decode table, not text AI-DLC prints.
const WIN_HIGH = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd, 0x017d, 0xfffd, 0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
].map((c) => String.fromCharCode(c));
function winAnsi(code: number): string {
  if (code >= 0x80 && code <= 0x9f) return WIN_HIGH[code - 0x80];
  return String.fromCharCode(code);
}
const GLYPHS: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&",
  quotesingle: "'", quoteright: "\u2019", quoteleft: "\u2018", parenleft: "(", parenright: ")", asterisk: "*",
  plus: "+", comma: ",", hyphen: "-", period: ".", slash: "/", colon: ":", semicolon: ";", less: "<", equal: "=",
  greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^",
  underscore: "_", grave: "`", braceleft: "{", bar: "|", braceright: "}", asciitilde: "~", quotedblleft: "\u201c",
  quotedblright: "\u201d", endash: String.fromCharCode(0x2013), emdash: String.fromCharCode(0x2014), bullet: "\u2022", ellipsis: "\u2026", fi: "fi",
  fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl", minus: "\u2212", zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9", germandbls: "\u00df", ae: "\u00e6", AE: "\u00c6",
  oe: "\u0153", OE: "\u0152", oslash: "\u00f8", Oslash: "\u00d8", dotlessi: "\u0131", degree: "\u00b0",
  copyright: "\u00a9", registered: "\u00ae", trademark: "\u2122", section: "\u00a7", paragraph: "\u00b6",
  periodcentered: "\u00b7", quotesinglbase: "\u201a", quotedblbase: "\u201e", guillemotleft: "\u00ab",
  guillemotright: "\u00bb", nbspace: "\u00a0", sterling: "\u00a3", yen: "\u00a5", Euro: "\u20ac", euro: "\u20ac",
};
const ACCENTS: Record<string, string> = {
  acute: "\u0301", grave: "\u0300", circumflex: "\u0302", dieresis: "\u0308", tilde: "\u0303", ring: "\u030a",
  cedilla: "\u0327", caron: "\u030c", macron: "\u0304", breve: "\u0306", ogonek: "\u0328", dotaccent: "\u0307",
  hungarumlaut: "\u030b",
};
function glyphName(name: string): string {
  if (name in GLYPHS) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  const base = name.split(".")[0];
  if (base !== name) return glyphName(base);
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(name);
  if (m) return m[1].match(/.{4}/g)!.map((h) => String.fromCharCode(Number.parseInt(h, 16))).join("");
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(Number.parseInt(m[1], 16));
  m = /^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|ring|cedilla|caron|macron|breve|ogonek|dotaccent|hungarumlaut)$/.exec(name);
  if (m) return (m[1] + ACCENTS[m[2]]).normalize("NFC");
  return "";
}

function utf16be(b: Buffer): string {
  let s = "";
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i));
  return s;
}
function codeOf(b: Buffer): number {
  let n = 0;
  for (const x of b) n = n * 256 + x;
  return n;
}

interface CMap { ranges: [number, number, number][]; map: Map<number, string> }
function parseCMap(text: string): CMap {
  const ranges: [number, number, number][] = [];
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) ranges.push([m[1].length / 2, Number.parseInt(m[1], 16), Number.parseInt(m[2], 16)]);
  }
  const map = new Map<number, string>();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(Number.parseInt(m[1], 16), utf16be(Buffer.from(m[2], "hex")));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = Number.parseInt(m[1], 16);
      const hi = Math.min(Number.parseInt(m[2], 16), lo + 65535);
      if (m[3].startsWith("[")) {
        [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].forEach((d, k) => {
          map.set(lo + k, utf16be(Buffer.from(d[1], "hex")));
        });
        continue;
      }
      const base = Buffer.from(m[3].slice(1, -1), "hex");
      if (base.length < 2) continue;
      for (let c = lo; c <= hi; c++) {
        const b = Buffer.from(base);
        b.writeUInt16BE((b.readUInt16BE(b.length - 2) + (c - lo)) & 0xffff, b.length - 2);
        map.set(c, utf16be(b));
      }
    }
  }
  return { ranges, map };
}

function splitter(ranges: [number, number, number][], fallback: number): (b: Buffer) => number[][] {
  return (b) => {
    const out: number[][] = [];
    for (let i = 0; i < b.length;) {
      let len = 0;
      for (const [n, lo, hi] of ranges) {
        if (i + n > b.length) continue;
        const c = codeOf(b.subarray(i, i + n));
        if (c >= lo && c <= hi) { len = n; break; }
      }
      if (len === 0) len = Math.min(fallback, b.length - i);
      out.push([codeOf(b.subarray(i, i + len)), len]);
      i += len;
    }
    return out;
  };
}

function loadFont(doc: Doc, fd: Dict): Font {
  const sub = (doc.resolve(fd.get("Subtype")) as PName)?.n;
  const tu = doc.stream(fd.get("ToUnicode"));
  const cmap = tu ? parseCMap(tu.data.toString("latin1")) : null;
  if (sub === "Type0") {
    const desc = ((doc.resolve(fd.get("DescendantFonts")) as Val[]) ?? []).map((v) => doc.resolve(v))[0] as Dict | undefined;
    const dw = Number(desc?.get("DW") ?? 1000);
    const widths = new Map<number, number>();
    const W = (doc.resolve(desc?.get("W")) as Val[]) ?? [];
    for (let i = 0; i < W.length;) {
      const c = Number(doc.resolve(W[i]));
      const next = doc.resolve(W[i + 1]);
      if (Array.isArray(next)) { next.forEach((w, k) => {
        widths.set(c + k, Number(doc.resolve(w)));
      }); i += 2; }
      else { const hi = Number(next); const w = Number(doc.resolve(W[i + 2])); for (let k = c; k <= hi && k - c < 65536; k++) widths.set(k, w); i += 3; }
    }
    const enc = doc.stream(fd.get("Encoding"));
    const ranges = enc ? parseCMap(enc.data.toString("latin1")).ranges : cmap?.ranges.length ? cmap.ranges : [[2, 0, 0xffff] as [number, number, number]];
    return { exact: W.length > 0 || desc?.has("DW") === true, map: (c) => cmap?.map.get(c) ?? "", width: (c) => (widths.get(c) ?? dw) / 1000, split: splitter(ranges, 2) };
  }
  const first = Number(doc.resolve(fd.get("FirstChar")) ?? 0);
  const ws = ((doc.resolve(fd.get("Widths")) as Val[]) ?? []).map((w) => Number(doc.resolve(w)));
  const descr = doc.resolve(fd.get("FontDescriptor")) as Dict | undefined;
  const missing = Number(descr instanceof Map ? descr.get("MissingWidth") ?? 0 : 0);
  const fm = (doc.resolve(fd.get("FontMatrix")) as Val[] | undefined)?.map((x) => Number(doc.resolve(x)));
  const scale = sub === "Type3" && fm ? fm[0] : 0.001;
  const table: string[] = Array.from({ length: 256 }, (_, c) => winAnsi(c));
  const enc = doc.resolve(fd.get("Encoding"));
  if (enc instanceof PName && enc.n === "MacRomanEncoding") {
    const MAC = "\u00c4\u00c5\u00c7\u00c9\u00d1\u00d6\u00dc\u00e1\u00e0\u00e2\u00e4\u00e3\u00e5\u00e7\u00e9\u00e8\u00ea\u00eb\u00ed\u00ec\u00ee\u00ef\u00f1\u00f3\u00f2\u00f4\u00f6\u00f5\u00fa\u00f9\u00fb\u00fc";
    for (let c = 0x80; c < 0xa0; c++) table[c] = MAC[c - 0x80];
  }
  if (enc instanceof Map) {
    const diffs = (doc.resolve(enc.get("Differences")) as Val[]) ?? [];
    let code = 0;
    for (const d of diffs) {
      const v = doc.resolve(d);
      if (typeof v === "number") code = v;
      else if (v instanceof PName) { if (code < 256) table[code] = glyphName(v.n); code++; }
    }
  }
  return {
    exact: ws.length > 0,
    map: (c) => (cmap?.map.has(c) ? cmap.map.get(c)! : table[c] ?? ""),
    width: (c) => {
      const w = ws[c - first];
      return (w !== undefined && Number.isFinite(w) ? w : missing || (scale === 0.001 ? 500 : 0)) * scale;
    },
    split: (b) => [...b].map((c) => [c, 1]),
  };
}

// --- Content streams --------------------------------------------------------------------------------------------
type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const ID: M = [1, 0, 0, 1, 0, 0];

// Glyphs are kept in tight runs (a jump of half an em starts a new run) and each run joins a recent line on its
// baseline. A line is read by its runs' x order; where runs overlap (a writer that draws one font's glyphs first
// and another's later in between) and every width is the font's own, by each glyph's x.
interface G { ch: string; x0: number; x1: number; size: number }
interface Run { x0: number; x1: number; y: number; size: number; glyphs: G[]; exact: boolean }
interface Line { y: number; size: number; runs: Run[] }
const RTL = /[\u0591-\u05f4\u0600-\u065f\u066a-\u06ef\u06fa-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]+(?:[ \u0640]+[\u0591-\u05f4\u0600-\u065f\u066a-\u06ef\u06fa-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]+)*/g;
const WORD_GAP = 0.12;

class TextSink {
  private lines: Line[] = [];
  private run: Run | null = null;
  glyph(ch: string, x0: number, y: number, x1: number, size: number, exact: boolean): void {
    const r = this.run;
    const g: G = { ch, x0, x1: Math.max(x0, x1), size };
    if (r !== null && Math.abs(r.y - y) <= Math.max(r.size, size) * 0.35 && x0 - r.x1 > -size * 0.5 && x0 - r.x1 < size * 0.5) {
      if (ch !== "") r.glyphs.push(g);
      r.x1 = Math.max(r.x1, g.x1);
      r.exact &&= exact;
      return;
    }
    if (ch === "") return;
    // Only the last few lines: a writer draws a column at a time, so the next column's line at the same height
    // comes much later and starts a line of its own.
    let line: Line | undefined;
    for (let k = this.lines.length - 1; k >= Math.max(0, this.lines.length - 4); k--) {
      const L = this.lines[k];
      if (Math.abs(L.y - y) <= Math.max(L.size, size) * 0.35) { line = L; break; }
    }
    if (line === undefined) { line = { y, size, runs: [] }; this.lines.push(line); }
    const run: Run = { x0, x1: g.x1, y, size, glyphs: [g], exact };
    line.runs.push(run);
    this.run = run;
  }
  text(): string {
    const out: string[] = [];
    for (const L of this.lines) {
      const runs = [...L.runs].sort((a, b) => a.x0 - b.x0);
      const overlap = runs.some((r, k) => k > 0 && r.x0 < runs[k - 1].x1 - 0.1 * r.size);
      const glyphs = runs.flatMap((r) => r.glyphs);
      if (overlap && runs.every((r) => r.exact)) glyphs.sort((a, b) => a.x0 - b.x0);
      let s = "";
      let prev: G | null = null;
      for (const g of glyphs) {
        if (prev !== null) {
          // The same glyph drawn twice at the same place (a bold made by overprinting) is read once.
          if (g.ch === prev.ch && Math.abs(g.x0 - prev.x0) < g.size * 0.2) continue;
          const gap = g.x0 - prev.x1;
          const em = Math.min(g.size, prev.size);
          const jump = Math.abs(g.size - prev.size) > 0.25 * Math.max(g.size, prev.size);
          if (!s.endsWith(" ") && g.ch !== " " && (gap > em * WORD_GAP || (jump && gap > em * 0.05))) s += " ";
        }
        s += g.ch;
        prev = g;
      }
      // Right-to-left runs come out in visual order; read them back in logical order.
      s = s.replace(RTL, (m) => [...m].reverse().join("")).replace(/\s+/g, " ").trim();
      if (s) out.push(s);
    }
    // A word broken at a line end with a hyphen, and a lowercase letter starting the next line, is joined.
    for (let k = out.length - 2; k >= 0; k--) {
      if (/[A-Za-z\u00c0-\u024f]-$/.test(out[k]) && /^[a-z\u00df-\u00ff]/.test(out[k + 1])) {
        out[k] = out[k].slice(0, -1) + out[k + 1];
        out.splice(k + 1, 1);
      }
    }
    return out.join("\n");
  }
}

function runContent(doc: Doc, data: Buffer, res: Dict | undefined, ctm0: M, sink: TextSink, depth: number, seen: Set<number>): void {
  const s = data.toString("latin1");
  const fonts = new Map<string, Font | null>();
  const fontRes = doc.resolve(res?.get("Font")) as Dict | undefined;
  const xobjs = doc.resolve(res?.get("XObject")) as Dict | undefined;
  const font = (name: string): Font | null => {
    if (!fonts.has(name)) {
      const fd = fontRes instanceof Map ? doc.resolve(fontRes.get(name)) : undefined;
      fonts.set(name, fd instanceof Map ? loadFont(doc, fd) : null);
    }
    return fonts.get(name)!;
  };
  const stack: { ctm: M; f: Font | null; size: number; Tc: number; Tw: number; Th: number; TL: number; rise: number }[] = [];
  let g = { ctm: ctm0, f: null as Font | null, size: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, rise: 0 };
  let Tm: M = ID, Tlm: M = ID;
  const ops: Val[] = [];
  // Marked content: a span's ActualText stands for the glyphs inside it (LibreOffice writes text it has no font
  // for this way).
  const marks: ({ text: string; used: boolean } | null)[] = [];
  const props = doc.resolve(res?.get("Properties")) as Dict | undefined;
  const show = (b: Buffer) => {
    if (!g.f) return;
    for (const [code, len] of g.f.split(b)) {
      const trm = mul([g.size * g.Th, 0, 0, g.size, 0, g.rise], mul(Tm, g.ctm));
      const w0 = g.f.width(code);
      const tx = (w0 * g.size + g.Tc + (len === 1 && code === 32 ? g.Tw : 0)) * g.Th;
      Tm = mul([1, 0, 0, 1, tx, 0], Tm);
      const end = mul([g.size * g.Th, 0, 0, g.size, 0, g.rise], mul(Tm, g.ctm));
      const size = Math.hypot(trm[2], trm[3]);
      const actual = marks.findLast((m) => m !== null);
      let ch = g.f.map(code);
      if (actual) { ch = actual.used ? "" : actual.text; actual.used = true; }
      sink.glyph(ch, trm[4], trm[5], end[4], size, g.f.exact);
    }
  };
  const nextLine = (tx: number, ty: number) => { Tlm = mul([1, 0, 0, 1, tx, ty], Tlm); Tm = Tlm; };
  for (let i = 0; i < s.length;) {
    const [v, j] = parse(s, i);
    if (j <= i) break;
    i = j;
    if (!(v instanceof POp)) { ops.push(v); continue; }
    const op = v.op;
    const n = (k: number) => Number(ops[ops.length - k] ?? 0);
    switch (op) {
      case "q": stack.push({ ...g }); break;
      case "Q": g = stack.pop() ?? g; break;
      case "cm": g.ctm = mul([n(6), n(5), n(4), n(3), n(2), n(1)], g.ctm); break;
      case "BT": Tm = ID; Tlm = ID; break;
      case "ET": break;
      case "Tf": { const nm = ops[ops.length - 2]; g.f = nm instanceof PName ? font(nm.n) : null; g.size = n(1); break; }
      case "Tc": g.Tc = n(1); break;
      case "Tw": g.Tw = n(1); break;
      case "Tz": g.Th = n(1) / 100; break;
      case "TL": g.TL = n(1); break;
      case "Ts": g.rise = n(1); break;
      case "Td": nextLine(n(2), n(1)); break;
      case "TD": g.TL = -n(1); nextLine(n(2), n(1)); break;
      case "Tm": Tlm = Tm = [n(6), n(5), n(4), n(3), n(2), n(1)]; break;
      case "T*": nextLine(0, -g.TL); break;
      case "Tj": if (ops[ops.length - 1] instanceof Buffer) show(ops[ops.length - 1] as Buffer); break;
      case "'": nextLine(0, -g.TL); if (ops[ops.length - 1] instanceof Buffer) show(ops[ops.length - 1] as Buffer); break;
      case '"': g.Tw = n(3); g.Tc = n(2); nextLine(0, -g.TL); if (ops[ops.length - 1] instanceof Buffer) show(ops[ops.length - 1] as Buffer); break;
      case "TJ": {
        const arr = ops[ops.length - 1];
        if (Array.isArray(arr)) for (const e of arr) {
          if (e instanceof Buffer) show(e);
          else if (typeof e === "number") Tm = mul([1, 0, 0, 1, (-e / 1000) * g.size * g.Th, 0], Tm);
        }
        break;
      }
      case "Do": {
        const nm = ops[ops.length - 1];
        if (!(nm instanceof PName) || !(xobjs instanceof Map) || depth >= FORM_DEPTH_MAX) break;
        const ref = xobjs.get(nm.n);
        const st = doc.stream(ref);
        if (!st || seen.has(st.num)) break;
        const subtype = doc.resolve(st.dict.get("Subtype"));
        if (!(subtype instanceof PName) || subtype.n !== "Form") break;
        const mx = ((doc.resolve(st.dict.get("Matrix")) as Val[]) ?? [1, 0, 0, 1, 0, 0]).map((x) => Number(doc.resolve(x))) as M;
        seen.add(st.num);
        runContent(doc, st.data, (doc.resolve(st.dict.get("Resources")) as Dict) ?? res, mul(mx, g.ctm), sink, depth + 1, seen);
        seen.delete(st.num);
        break;
      }
      case "BMC": marks.push(null); break;
      case "BDC": {
        let p = doc.resolve(ops[ops.length - 1]);
        if (p instanceof PName && props instanceof Map) p = doc.resolve(props.get(p.n));
        const at = p instanceof Map ? doc.resolve(p.get("ActualText")) : undefined;
        marks.push(at instanceof Buffer ? { text: textString(at), used: false } : null);
        break;
      }
      case "EMC": marks.pop(); break;
      case "BI": {
        // An inline image: skip its parameters and binary data up to EI.
        const id = s.indexOf("ID", i);
        const k = id < 0 ? s.length : id + 3;
        const m = /\sEI(?=[\s]|$)/g;
        m.lastIndex = k;
        const e = m.exec(s);
        i = e ? e.index + e[0].length : s.length;
        break;
      }
    }
    ops.length = 0;
  }
}

function pages(doc: Doc): { dict: Dict; res: Dict | undefined }[] {
  const out: { dict: Dict; res: Dict | undefined }[] = [];
  const root = doc.resolve(doc.trailer.get("Root")) as Dict | undefined;
  const seen = new Set<Dict>();
  const walk = (node: Val | undefined, res: Dict | undefined, depth: number) => {
    const d = doc.resolve(node);
    if (!(d instanceof Map) || seen.has(d) || depth > PAGE_TREE_DEPTH_MAX) return;
    seen.add(d);
    const r = (doc.resolve(d.get("Resources")) as Dict | undefined) ?? res;
    const kids = doc.resolve(d.get("Kids"));
    if (Array.isArray(kids)) for (const k of kids) walk(k, r, depth + 1);
    else out.push({ dict: d, res: r });
  };
  if (root instanceof Map) walk(root.get("Pages"), undefined, 0);
  return out;
}

/** The text of a PDF, its page count, and whether pages past `pageMax` were left out. Throws a PdfError, in the person's terms, for a file it cannot open. */
export function pdfText(buf: Buffer, pageMax = Number.POSITIVE_INFINITY): { text: string; pages: number; truncated: boolean; failedStreams: number } {
  const doc = new Doc(buf);
  const list = pages(doc);
  if (list.length === 0) throw new PdfError("it is damaged (no pages)");
  const parts: string[] = [];
  for (const p of list.slice(0, pageMax)) {
    const sink = new TextSink();
    const c = doc.resolve(p.dict.get("Contents"));
    const refs = Array.isArray(c) ? c : [p.dict.get("Contents")];
    const data = Buffer.concat(refs.map((r) => doc.stream(r as Val)?.data ?? Buffer.alloc(0)).flatMap((b) => [b, Buffer.from("\n")]));
    runContent(doc, data, p.res, ID, sink, 0, new Set());
    parts.push(sink.text());
  }
  // Each page ends with a form feed, as pdftotext ends them.
  return { text: parts.map((page) => `${page}\n\f`).join(""), pages: list.length, truncated: list.length > pageMax, failedStreams: doc.failedStreams };
}

/** The reader as its own process: the PDF's bytes on stdin, its text on stdout, `{"pages":N}` as the last line of
 *  stderr. A file it cannot open exits 2 with the reason on stderr, in the person's terms. */
export function readPdfMain(argv: string[]): number {
  const at = argv.indexOf("--page-cap");
  const cap = at >= 0 ? Number(argv[at + 1]) : Number.POSITIVE_INFINITY;
  let r: ReturnType<typeof pdfText>;
  try {
    r = pdfText(readFileSync(0), Number.isFinite(cap) && cap > 0 ? cap : Number.POSITIVE_INFINITY);
  } catch (e) {
    process.stderr.write(`${e instanceof PdfError ? e.message : "it is damaged"}\n`);
    return 2;
  }
  process.stdout.write(r.text);
  process.stderr.write(`${JSON.stringify({ pages: r.pages })}\n`);
  return 0;
}

if (import.meta.main) process.exitCode = readPdfMain(process.argv.slice(2));
