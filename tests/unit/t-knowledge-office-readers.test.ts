// covers: file:tools/aidlc-ooxml.ts, function:officeText, function:listZip, function:readParts, function:extractDocument, function:shouldRetryExtraction, function:detectMimeType
//
// A person who adds a Word spec or an Excel mapping to the knowledge base used
// to get `unsupported_type` and no text: no stage could use it, and the
// harnesses' own agents asked for a shell command to open it. The knowledge
// index now reads both itself with Bun's built-ins (both are zipped XML), so
// `show` and the stages get the text. A configured extractor still wins, a
// document added before is read on the next sync, and a file it cannot open is
// recorded once as not readable, with the reason.
//
// The fixtures under tests/fixtures/documents/ are synthetic: made with
// xlsxwriter and python-docx from invented text only (no record or workshop
// file went into them). mapping-streamed.xlsx is the same workbook rewritten
// through Python's ZipFile over a non-seekable stream, so every part carries a
// data descriptor (bit 3), as Java, Apache POI and Go write zips.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { cleanupTestProject, createTestProject, DEFAULT_SPACE, FIXTURES_DIR, resetAidlcEnv } from "../harness/fixtures.ts";
import {
  detectMimeType,
  documentsDir,
  onboard,
  readIndex,
  showDocument,
  syncDocuments,
  WORD_DOCX_MIME,
  writeIndex,
  XLSX_MIME,
} from "../../core/tools/aidlc-knowledge.ts";
import { listZip, officeText, OoxmlError, readParts } from "../../core/tools/aidlc-ooxml.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const DOCS = join(FIXTURES_DIR, "documents");
const NOW = "2026-11-05T00:00:00.000Z";
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) cleanupTestProject(dir);
});

function project(): string {
  resetAidlcEnv();
  const proj = createTestProject();
  made.push(proj);
  return proj;
}

function put(proj: string, name: string, data: Buffer | string): void {
  const path = join(documentsDir(proj, DEFAULT_SPACE), name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function fixture(name: string): Buffer {
  return readFileSync(join(DOCS, name));
}

function row(proj: string, name: string) {
  const found = readIndex(proj, DEFAULT_SPACE).documents.find((entry) => entry.source.path === `documents/${name}`);
  expect(found, name).toBeDefined();
  return found!;
}

function text(proj: string, name: string): string {
  return showDocument(proj, DEFAULT_SPACE, row(proj, name).id).content ?? "";
}

// A zip with a real central directory, for parts written in the test; a part marked true is deflated.
function zipOf(parts: ReadonlyArray<readonly [string, string | Buffer, boolean?]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body, deflate] of parts) {
    const nameBuf = Buffer.from(name, "utf-8");
    const plain = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");
    const data = deflate ? deflateRawSync(plain) : plain;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

describe("t-knowledge-office-readers: the knowledge index reads Word and Excel files itself", () => {
  test("an Excel workbook is read: every sheet in order, shared strings, a formula's result, a multi-line cell", () => {
    const proj = project();
    put(proj, "mapping.xlsx", fixture("mapping.xlsx"));
    expect(onboard(proj, DEFAULT_SPACE, undefined, NOW).refused).toBeUndefined();
    const r = row(proj, "mapping.xlsx");
    expect(r.extraction.state).toBe("extracted");
    expect(r.extraction.extractor).toEqual({ name: "builtin-ooxml", version: "1" });
    const t = text(proj, "mapping.xlsx");
    expect(t.indexOf("## Rules")).toBeGreaterThanOrEqual(0);
    expect(t.indexOf("## Rules")).toBeLessThan(t.indexOf("## Codes"));
    for (const token of ["QUOKKA-7731", "NUMBAT-5519", "MARMOT-2284", "Refund window is 14 days"]) expect(t).toContain(token);
    expect(t).toContain("| Total weight | 17 |");
  });

  test("a Word document is read: its paragraphs, and its table as rows", () => {
    const proj = project();
    put(proj, "spec.docx", fixture("spec.docx"));
    expect(onboard(proj, DEFAULT_SPACE, undefined, NOW).refused).toBeUndefined();
    expect(row(proj, "spec.docx").extraction.state).toBe("extracted");
    const t = text(proj, "spec.docx");
    expect(t).toContain("Paragraph token WOMBAT-3306.");
    expect(t).toContain("| Legacy field | New field | Rule |");
    expect(t).toContain("| AMT_CENTS | amount | table token DINGO-8842 |");
  });

  test("a workbook written as a streamed zip (data descriptors) is recognised and read", () => {
    const buf = fixture("mapping-streamed.xlsx");
    expect(buf.readUInt16LE(6) & 0x0008).toBe(0x0008);
    expect(detectMimeType("/x/mapping-streamed.xlsx", buf)).toBe(XLSX_MIME);
    expect(officeText(buf, "excel")).toContain("QUOKKA-7731");
  });

  test("a document added before is read on the next sync, once", () => {
    const proj = project();
    put(proj, "spec.docx", fixture("spec.docx"));
    put(proj, "mapping.xlsx", fixture("mapping.xlsx"));
    expect(onboard(proj, DEFAULT_SPACE, undefined, NOW).refused).toBeUndefined();
    // What the index held for these before: Word recognised but not read, Excel not even recognised.
    const index = readIndex(proj, DEFAULT_SPACE);
    for (const entry of index.documents) {
      const docx = entry.source.path.endsWith(".docx");
      entry.extraction = { state: "unsupported_type", detectedType: docx ? WORD_DOCX_MIME : "application/octet-stream" };
      delete entry.content;
      delete entry.content_sha256;
    }
    writeIndex(proj, DEFAULT_SPACE, index);
    const first = syncDocuments(proj, DEFAULT_SPACE, NOW).changes;
    expect(first.filter((change) => change.change === "retried").map((change) => change.path).sort())
      .toEqual(["documents/mapping.xlsx", "documents/spec.docx"]);
    expect(row(proj, "spec.docx").extraction.state).toBe("extracted");
    expect(row(proj, "mapping.xlsx").extraction.state).toBe("extracted");
    expect(text(proj, "mapping.xlsx")).toContain("NUMBAT-5519");
    const second = syncDocuments(proj, DEFAULT_SPACE, NOW).changes;
    expect(second.some((change) => change.change === "retried")).toBe(false);
  });

  test("an .xlsx that is not an Office zip is recorded once as not readable, and the next sync leaves it", () => {
    const proj = project();
    // An OLE compound file header: what a password-protected workbook is.
    put(proj, "locked.xlsx", Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]));
    put(proj, "rules.md", "# Rules\n");
    expect(onboard(proj, DEFAULT_SPACE, undefined, NOW).refused).toBeUndefined();
    const r = row(proj, "locked.xlsx");
    expect(r.extraction.state).toBe("extraction_failed");
    expect(r.extraction.reason).toContain("password-protected");
    expect(row(proj, "rules.md").extraction.state).toBe("extracted");
    expect(syncDocuments(proj, DEFAULT_SPACE, NOW).changes.some((change) => change.change === "retried")).toBe(false);
  });

  test("a damaged part is not readable and the rest of the batch is indexed", () => {
    const proj = project();
    const buf = Buffer.from(fixture("mapping.xlsx"));
    const sheet = listZip(buf).find((entry) => entry.name === "xl/worksheets/sheet1.xml")!;
    const dataAt = sheet.localOffset + 30 + buf.readUInt16LE(sheet.localOffset + 26) + buf.readUInt16LE(sheet.localOffset + 28);
    buf.fill(0xff, dataAt, dataAt + Math.min(64, sheet.compressedSize));
    put(proj, "broken.xlsx", buf);
    put(proj, "spec.docx", fixture("spec.docx"));
    expect(onboard(proj, DEFAULT_SPACE, undefined, NOW).refused).toBeUndefined();
    const r = row(proj, "broken.xlsx");
    expect(r.extraction.state).toBe("extraction_failed");
    expect(r.extraction.reason).toContain("AI-DLC could not read it as an Excel file");
    expect(row(proj, "spec.docx").extraction.state).toBe("extracted");
  });

  test("a part that inflates past the cap is refused, not read", () => {
    const archive = zipOf([["[Content_Types].xml", "<Types/>"], ["word/document.xml", Buffer.alloc(2_000_000), true]]);
    const word = (n: string) => n === "word/document.xml";
    expect(() => readParts(archive, word, { entryMax: 1_000_000 })).toThrow(OoxmlError);
    expect(() => readParts(archive, word, { entryMax: 1_000_000 })).toThrow(/too large to read/);
    expect(() => readParts(archive, word, { totalMax: 1_000_000 })).toThrow(/too large to read/);
    expect(readParts(archive, word).get("word/document.xml")?.length).toBe(2_000_000);
  });

  test("a zip whose directory lies about its offsets is refused, not followed", () => {
    const archive = Buffer.from(zipOf([["[Content_Types].xml", "<Types/>"], ["word/document.xml", "<w:document/>"]]));
    archive.writeUInt32LE(archive.length * 2, archive.length - 22 + 16);
    expect(() => listZip(archive)).toThrow(OoxmlError);
    expect(detectMimeType("/x/a.docx", archive)).toBe("application/octet-stream");
  });

  test("a sheet written with a namespace prefix, cells with no reference, and inline strings are read", () => {
    const workbook = zipOf([
      ["[Content_Types].xml", "<Types/>"],
      ["xl/workbook.xml", '<x:workbook xmlns:x="m" xmlns:r="r"><x:sheets><x:sheet name="Mapping &amp; rules" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>'],
      ["xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Type="t" Target="/xl/sheets/first.xml"/></Relationships>'],
      ["xl/sheets/first.xml", '<x:worksheet><x:sheetData><x:row r="1"><x:c t="inlineStr"><x:is><x:t>Field</x:t></x:is></x:c><x:c t="inlineStr"><x:is><x:r><x:t>Ru</x:t></x:r><x:r><x:t>le</x:t></x:r></x:is></x:c></x:row><x:row r="2"><x:c r="A2" t="b"><x:v>1</x:v></x:c><x:c r="C2"><x:v>42</x:v></x:c></x:row></x:sheetData></x:worksheet>'],
    ]);
    expect(detectMimeType("/x/w.xlsx", workbook)).toBe(XLSX_MIME);
    const t = officeText(workbook, "excel");
    expect(t).toContain("## Mapping & rules");
    expect(t).toContain("| Field | Rule |");
    expect(t).toContain("| TRUE |  | 42 |");
  });
});
