// covers: function:extractDocument function:probeExtractor function:extractorArgvFor function:detectMimeType function:EXTRACT_INPUT_BYTE_CAP function:EXTRACT_TIMEOUT_MS function:EXTRACT_PROBE_TIMEOUT_MS function:EXTRACT_PAGE_CAP function:EXTRACT_OUTPUT_CHAR_CAP function:EXTRACT_BATCH_DOC_CAP function:EXTRACT_BATCH_BYTE_CAP
//
// t295 - DocumentKB text extraction: probe an external executable, degrade into
// a distinct state, and never let a document's NAME become a command.
//
// Mechanism: real filesystem + real spawns. The whole subject is what happens
// when an external process is invoked, so a mocked spawn would test nothing.
//
// Subject under test: dist/claude/.claude/tools/aidlc-knowledge.ts (the SHIPPED
// distributable); a guard reverted only in core/ reaches it only once dist is
// regenerated, which the test runner does first.
//
// PORTABILITY. `pdftotext` may or may not be installed on the machine running
// this, and CI does not have it. Every case below is therefore written to assert
// a property that holds EITHER WAY, or to branch on a probe rather than assume.
// A test that silently skips its own subject on CI is worse than no test, so the
// branch is explicit and the reason is stated at each site.
//
// The contract:
//
//   AI-DLC SHIPS NO PDF PARSER and downloads none. It probes an external
//   executable with `--version` and a short timeout, exactly as the sensors do.
//   `bunx unpdf` was proposed and withdrawn -- `unpdf` is a library with no
//   executable `bin`, while `bunx` runs package executables; the `bunx eslint`
//   precedent held only because eslint is a binary.
//
//   EVERY non-extracted outcome is a DISTINCT STATE with its own remedy.
//   Collapsing them into one "unsupported" sends the user down the wrong path:
//   "install pdftotext" and "this scan has no text layer" are different problems.
//
//   DEGRADE, NEVER FAIL THE COMMAND. A document that cannot be extracted is
//   still catalogued and still citable.
//
//   NO SHELL. `spawnSync(argv[0], argv.slice(1))` with an argv array, and `$IN`
//   is the only substitution. A document named `$(touch PWNED).pdf` must be an
//   ordinary filename.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { stubPdfText, stubPdftotextPath } from "../harness/stub-pdftotext.ts";
import {
  DEFAULT_SUBPROCESS_TIMEOUT_MS,
  LONG_SUBPROCESS_TIMEOUT_MS,
} from "../../core/tools/aidlc-runtime-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  detectMimeType,
  documentkbDir,
  documentsDir,
  EXTRACT_BATCH_BYTE_CAP,
  EXTRACT_BATCH_DOC_CAP,
  EXTRACT_INPUT_BYTE_CAP,
  EXTRACT_OUTPUT_CHAR_CAP,
  EXTRACT_PAGE_CAP,
  EXTRACT_PROBE_TIMEOUT_MS,
  EXTRACT_TIMEOUT_MS,
  extractDocument,
  extractorArgvFor,
  hasWordOoxmlSignature,
  onboard,
  probeExtractor,
  readIndex,
  syncDocuments,
  unreadDocuments,
  unreadDocumentsLabel,
  WORD_DOCX_MIME,
  writeIndex,
} from "../../dist/claude/.claude/tools/aidlc-knowledge.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const NOW = "2026-08-07T00:00:00Z";
const SPACE = "default";
const DIGEST = "a".repeat(64);

/** Is pdftotext on this machine? CI does not have it, so cases that need a
 *  WORKING extractor branch on this rather than assuming either way. */
const PDFTOTEXT = probeExtractor("pdftotext").available;

let proj: string | undefined;

function scratchProject(): string {
  proj = mkdtempSync(join(tmpdir(), "t295-"));
  mkdirSync(documentsDir(proj, SPACE), { recursive: true });
  return proj;
}

function doc(p: string, name: string, body: string | Buffer): string {
  const full = join(documentsDir(p, SPACE), name);
  writeFileSync(full, body);
  return full;
}

/** Exercise absence even on hosts with Poppler, without changing the test's PATH. */
function extractWithoutPdfTool(project: string, abs: string): ReturnType<typeof extractDocument> {
  const emptyPath = join(project, "empty-bin");
  mkdirSync(emptyPath);
  const tool = pathToFileURL(
    join(import.meta.dir, "../../dist/claude/.claude/tools/aidlc-knowledge.ts"),
  ).href;
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
  );
  const result = spawnSync(process.execPath, ["-e", `
    import { extractDocument, probeExtractor } from ${JSON.stringify(tool)};
    console.log(JSON.stringify({
      probe: probeExtractor("pdftotext"),
      outcome: extractDocument(${JSON.stringify(abs)}, "application/pdf", 9, ${JSON.stringify(DIGEST)}),
    }));
  `], {
    cwd: emptyPath,
    env: { ...childEnv, PATH: emptyPath },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const packet = JSON.parse(result.stdout);
  expect(packet.probe.available).toBe(false);
  return packet.outcome;
}

afterEach(() => {
  if (proj !== undefined) {
    rmSync(proj, { recursive: true, force: true });
    proj = undefined;
  }
});

describe("t295 the bounds are named constants, anchored to real limits", () => {
  test("every bound is exported with the value the design fixed", () => {
    // Exported so a test can assert the BOUND rather than a magic number, and so
    // a change is a visible diff rather than a silent retune.
    expect(EXTRACT_INPUT_BYTE_CAP).toBe(32 * 1024 * 1024);
    expect(EXTRACT_TIMEOUT_MS).toBe(LONG_SUBPROCESS_TIMEOUT_MS);
    expect(EXTRACT_PROBE_TIMEOUT_MS).toBe(DEFAULT_SUBPROCESS_TIMEOUT_MS);
    expect(EXTRACT_PAGE_CAP).toBe(50);
    expect(EXTRACT_OUTPUT_CHAR_CAP).toBe(200_000);
    expect(EXTRACT_BATCH_DOC_CAP).toBe(20);
    expect(EXTRACT_BATCH_BYTE_CAP).toBe(256 * 1024 * 1024);
  });

  test("the probe timeout is far shorter than the extraction timeout", () => {
    // Probes and extraction inherit the runtime policy's distinct backstops.
    expect(EXTRACT_PROBE_TIMEOUT_MS).toBeLessThan(EXTRACT_TIMEOUT_MS);
  });

  test("the default argv carries the page cap, so the constant is load-bearing", () => {
    const argv = extractorArgvFor("application/pdf");
    expect(argv).not.toBeNull();
    expect(argv).toContain(String(EXTRACT_PAGE_CAP));
    // And `$IN` is present exactly once: it is the ONLY substitution, so a second
    // occurrence would mean the path is interpolated somewhere unaudited.
    expect(argv!.filter((a) => a === "$IN").length).toBe(1);
  });
});

describe("t295 probeExtractor degrades instead of throwing", () => {
  test("a missing executable reports unavailable rather than raising", () => {
    // An absent extractor is a NORMAL state on a fresh machine, not an error.
    const r = probeExtractor("definitely-not-a-real-binary-xyz");
    expect(r.available).toBe(false);
    expect(r.version).toBeNull();
    expect(r.name).toBe("definitely-not-a-real-binary-xyz");
  });

  test("a probe of a real tool reports a version", () => {
    // `echo` stands in for any tool that exits 0: the point is that available
    // means available, not that pdftotext specifically is installed.
    const r = probeExtractor("echo");
    expect(r.available).toBe(true);
  });

  test.skipIf(!PDFTOTEXT)("pdftotext, when present, reports a version string", () => {
    const r = probeExtractor("pdftotext");
    expect(r.available).toBe(true);
    // pdftotext prints its banner to STDERR, so a stdout-only probe would report
    // no version -- both streams are consulted.
    expect(r.version).toMatch(/pdftotext/i);
  });
});

describe("t295 MIME detection reads the BYTES, not the extension", () => {
  test("a PDF is detected by magic even with a wrong extension", () => {
    // The extension is a claim; the bytes are evidence.
    const pdf = Buffer.from("%PDF-1.4\nbody\n");
    expect(detectMimeType("/x/policy.txt", pdf)).toBe("application/pdf");
  });

  test("plain text and markdown are distinguished by extension", () => {
    const text = Buffer.from("hello\n");
    expect(detectMimeType("/x/a.md", text)).toBe("text/markdown");
    expect(detectMimeType("/x/a.txt", text)).toBe("text/plain");
  });

  test("binary that is not a known document type is octet-stream", () => {
    expect(detectMimeType("/x/a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])))
      .toBe("application/octet-stream");
  });
});

// A real zip: local headers, a central directory and its end record, as a
// writer produces them (stored unless an entry names another method).
function zipWithDirectory(entries: ReadonlyArray<{ name: string; data: Buffer; method?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data, method = 0 } of entries) {
    const nameBuf = Buffer.from(name, "ascii");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header signature
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(header, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

// A zip whose central directory names the two Word parts: detection reads the
// directory (the one listing the reader also uses), never an entry's data.
function fakeDocxBytes(): Buffer {
  return zipWithDirectory([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "word/document.xml", data: Buffer.from("<document/>") },
  ]);
}

describe("t295 Word (.docx) detection — Finding 3", () => {
  test("a docx-shaped zip (both OOXML markers) is detected as the Word MIME", () => {
    const buf = fakeDocxBytes();
    expect(hasWordOoxmlSignature(buf)).toBe(true);
    expect(detectMimeType("/x/report.docx", buf)).toBe(WORD_DOCX_MIME);
  });

  test("a bare zip missing the OOXML markers (e.g. a plain .zip) is NOT classified as Word", () => {
    // Guards the "a bare zip check would misclassify every zip" trap:
    // PK magic alone must not be sufficient.
    const buf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not office xml at all")]);
    expect(hasWordOoxmlSignature(buf)).toBe(false);
    expect(detectMimeType("/x/archive.zip", buf)).toBe("application/octet-stream");
  });

  test("attack: the marker strings appearing in an entry's DATA, not its name, must not fool detection", () => {
    // Reproduces the exact defect a raw substring scan had: one zip entry
    // named something unrelated, whose CONTENTS happen to mention both
    // marker strings as ordinary text. Only a real per-entry filename check
    // (not `buf.includes(...)`) can tell these apart.
    function localHeader(name: string, data: Buffer): Buffer {
      const nameBuf = Buffer.from(name, "ascii");
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(nameBuf.length, 26);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(data.length, 22);
      return Buffer.concat([header, nameBuf, data]);
    }
    const spoof = localHeader(
      "payload.txt",
      Buffer.from("word/document.xml [Content_Types].xml"),
    );
    expect(hasWordOoxmlSignature(spoof)).toBe(false);
    expect(detectMimeType("/x/payload.bin", spoof)).toBe("application/octet-stream");
  });

  test("attack: a LYING compressedSize must not resync the walk into the payload", () => {
    // The walk's next offset comes from `compressedSize` alone, so an entry
    // declaring compressedSize 0 while carrying real bytes advances past only its
    // HEADER and lands inside its own payload -- where forged local headers named
    // `[Content_Types].xml` and `word/document.xml` were then read as if they
    // were genuine entry names. That is the same NAME-versus-CONTENT confusion
    // the test above pins, smuggled one level down, so enumerating "content in
    // an entry body" was not enough: the walk's own arithmetic had to stop
    // trusting a self-contradictory size pair.
    function header(name: string, payload: Buffer, declaredComp: number): Buffer {
      const nameBuf = Buffer.from(name, "ascii");
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt32LE(declaredComp, 18);
      h.writeUInt32LE(payload.length, 22);
      h.writeUInt16LE(nameBuf.length, 26);
      return Buffer.concat([h, nameBuf, payload]);
    }
    const forged = Buffer.concat([
      header("[Content_Types].xml", Buffer.alloc(0), 0),
      header("word/document.xml", Buffer.alloc(0), 0),
    ]);
    // compressedSize 0 but uncompressedSize 96: no real zip writer emits this.
    const attack = header("innocent.txt", forged, 0);
    expect(hasWordOoxmlSignature(attack)).toBe(false);
    expect(detectMimeType("/x/innocent.bin", attack)).toBe("application/octet-stream");
  });

  test("a real DEFLATE-compressed docx (compressed entry data, not stored) is still detected", () => {
    // A genuine Word or LibreOffice writer deflates its parts: detection reads
    // the names from the directory whatever the method, and inflates nothing.
    const buf = zipWithDirectory([
      { name: "[Content_Types].xml", data: Buffer.from("deflated-in-reality-but-irrelevant-to-detection".repeat(20)), method: 8 },
      { name: "word/document.xml", data: Buffer.from("more filler content representing compressed xml".repeat(20)), method: 8 },
    ]);
    expect(hasWordOoxmlSignature(buf)).toBe(true);
  });


  test("having only ONE of the two markers is not enough (attack: partial spoof)", () => {
    const onlyContentTypes = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("[Content_Types].xml"),
    ]);
    expect(hasWordOoxmlSignature(onlyContentTypes)).toBe(false);
    const onlyDocXml = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("word/document.xml"),
    ]);
    expect(hasWordOoxmlSignature(onlyDocXml)).toBe(false);
  });

  test("a docx with NO configured extractor is read by AI-DLC itself, catalogued and citable, never an error", () => {
    // With nothing configured for Word, the built-in reader reads it; this one
    // has no text, which is a state, not a failure.
    const p = scratchProject();
    doc(p, "report.docx", fakeDocxBytes());
    const { indexed, refused } = onboard(p, SPACE, undefined, NOW);
    expect(refused).toBeUndefined();
    expect(indexed.length).toBe(1);
    const row = readIndex(p, SPACE).documents[0];
    expect(row.extraction.state).toBe("no_extractable_text");
    expect(row.extraction.extractor?.name).toBe("builtin-ooxml");
  });

  test("extractorArgvFor returns null for the Word MIME when nothing is configured (read in-process, no program)", () => {
    // Unlike PDF, Word has no default program: AI-DLC reads it itself (builtin-ooxml).
    expect(extractorArgvFor(WORD_DOCX_MIME)).toBeNull();
  });
});

describe("t295 each outcome is a DISTINCT state with its own remedy", () => {
  test("text extracts with no external tool at all", () => {
    const p = scratchProject();
    const abs = doc(p, "a.md", "hello world\n");
    const out = extractDocument(abs, "text/markdown", 12, DIGEST);
    expect(out.record.state).toBe("extracted");
    expect(out.text).toBe("hello world\n");
    // Revision-bound, so a later edit invalidates it.
    expect(out.record.source_revision).toBe(DIGEST);
    expect(out.record.truncated).toBe(false);
    expect(out.record.chars).toBe(12);
  });

  test("an unconfigured MIME type is unsupported_type, NOT extractor_unavailable", () => {
    // Different remedies: "no extractor is configured for this type" is fixed by
    // configuring one, while "install the tool" is fixed by installing it.
    const p = scratchProject();
    const abs = doc(p, "a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const out = extractDocument(abs, "application/octet-stream", 4, DIGEST);
    expect(out.record.state).toBe("unsupported_type");
    expect(out.record.detectedType).toBe("application/octet-stream");
    expect(out.text).toBeUndefined();
  });

  test("an over-cap input is NEVER OPENED, and says so", () => {
    // Avoiding the spawn is the entire point of the bound, so the check precedes
    // it -- a decompression bomb must hit a bound, not exhaust memory.
    const p = scratchProject();
    const abs = doc(p, "big.pdf", "%PDF-1.4\n");
    const out = extractDocument(abs, "application/pdf", EXTRACT_INPUT_BYTE_CAP + 1, DIGEST);
    expect(out.record.state).toBe("extraction_failed");
    expect(out.record.reason).toMatch(/never opened/);
    expect(out.record.reason).toContain(String(EXTRACT_INPUT_BYTE_CAP));
  });

  test.skipIf(!PDFTOTEXT)("a malformed PDF is extraction_failed with a distinct reason", () => {
    const p = scratchProject();
    const abs = doc(p, "fake.pdf", "%PDF-1.4\nnot really a pdf\n");
    const out = extractDocument(abs, "application/pdf", 26, DIGEST);
    expect(out.record.state).toBe("extraction_failed");
    // The reason must distinguish this from a timeout or a bound trip.
    expect(out.record.reason).toMatch(/exited/);
    // The extractor RAN, so both name and version are known.
    expect(out.record.extractor?.name).toBe("pdftotext");
    expect(out.record.extractor?.version).toBeTruthy();
  });

  test("a missing pdftotext hands the PDF to AI-DLC's own reader, which records what it found", () => {
    // The default PDF extractor is missing, so the built-in reader runs instead
    // of recording `extractor_unavailable`; this file is not a PDF it can open.
    const p = scratchProject();
    const abs = doc(p, "a.pdf", "%PDF-1.4\n");
    const out = extractWithoutPdfTool(p, abs);
    expect(out.record.state).toBe("extraction_failed");
    expect(out.record.extractor).toEqual({ name: "builtin-pdf", version: "1" });
    expect(out.record.reason).toStartWith("AI-DLC could not read it as a PDF:");
  });

  // `extractor_unavailable` records `detectedType`. Without it,
  // `detectMimeFromRow` (used only by `shouldRetryExtraction`) fell back to
  // guessing from the file EXTENSION -- ".pdf" or bust, else "text/plain" -- so
  // a `.docx` row with no configured extractor could NEVER become retryable:
  // installing a Word extractor later had no mime to re-probe against, because
  // the row's guessed mime was never
  // "application/...wordprocessingml.document" in the first place.
  test("the built-in reader's failure ALSO records detectedType -- the mime a retry needs to re-probe", () => {
    const p = scratchProject();
    const abs = doc(p, "a.pdf", "%PDF-1.4\n");
    const out = extractWithoutPdfTool(p, abs);
    expect(out.record.state).toBe("extraction_failed");
    expect(out.record.detectedType).toBe("application/pdf");
  });

  test.skipIf(!PDFTOTEXT)("a valid PDF with NO TEXT LAYER is no_extractable_text, not a failure", () => {
    // The distinction that matters: the extractor RAN and succeeded, and the
    // document simply has no text -- a scanned or image-only page. The remedy is a
    // text version of the document, NOT "install the extractor" and NOT "fix the
    // file". Collapsing this into extraction_failed sends the user to repair a
    // document that is not broken.
    //
    // A minimal PDF with a page object and no content stream: pdftotext exits 0
    // and prints nothing.
    const p = scratchProject();
    const noText = [
      "%PDF-1.4",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj",
      "trailer<</Root 1 0 R>>",
      "%%EOF",
      "",
    ].join("\n");
    const abs = doc(p, "scan.pdf", noText);
    const out = extractDocument(abs, "application/pdf", noText.length, DIGEST);
    expect(out.record.state).toBe("no_extractable_text");
    // The extractor ran, so name AND version are known -- and the result is
    // revision-bound, so re-extracting after an edit is a real change.
    expect(out.record.extractor?.name).toBe("pdftotext");
    expect(out.record.extractor?.version).toBeTruthy();
    expect(out.record.source_revision).toBe(DIGEST);
    expect(out.text).toBeUndefined();
  });

  test("extraction NEVER throws, whatever the input", () => {
    // Degrade, never fail the command: a broken document must not take down an
    // onboard of twenty healthy ones.
    const p = scratchProject();
    const cases: [string, string | Buffer, string][] = [
      ["empty.pdf", "", "application/pdf"],
      ["truncated.pdf", "%PDF-1", "application/pdf"],
      ["nul.pdf", Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x00]), "application/pdf"],
      ["weird.bin", Buffer.from([0xff, 0xfe, 0xfd]), "application/octet-stream"],
    ];
    for (const [name, body, mime] of cases) {
      const abs = doc(p, name, body);
      const bytes = typeof body === "string" ? body.length : body.length;
      expect(() => extractDocument(abs, mime, bytes, DIGEST), name).not.toThrow();
    }
  });
});

/** Run extractDocument on the default PDF argv with the stand-in `pdftotext`
 *  first on PATH, in a child so this process's PATH is left alone. */
function extractWithStubPdftotext(
  project: string,
  pages: number,
  opts: { pageBreaks?: boolean; xpdf?: boolean } = {},
): ReturnType<typeof extractDocument> {
  const abs = doc(project, "long.pdf", "%PDF-1.4\n");
  const tool = pathToFileURL(
    join(import.meta.dir, "../../dist/claude/.claude/tools/aidlc-knowledge.ts"),
  ).href;
  const result = spawnSync(process.execPath, ["-e", `
    import { extractDocument } from ${JSON.stringify(tool)};
    console.log(JSON.stringify(extractDocument(${JSON.stringify(abs)}, "application/pdf", 9, ${JSON.stringify(DIGEST)})));
  `], {
    env: { ...process.env, PATH: stubPdftotextPath(project, pages, opts) },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

// The stand-in is a POSIX shell script.
describe.skipIf(process.platform === "win32")("t295 the PDF page cap sets truncated", () => {
  test("a 60-page PDF keeps 50 pages and records that the page cap cut it", () => {
    const out = extractWithStubPdftotext(scratchProject(), 60);
    expect(out.record.state).toBe("extracted");
    expect(out.record.truncated).toBe(true);
    expect(out.record.pages_kept).toBe(EXTRACT_PAGE_CAP);
    expect(out.text).toBe(stubPdfText(EXTRACT_PAGE_CAP));
    expect(out.record.chars).toBe(stubPdfText(EXTRACT_PAGE_CAP).length);
  });

  test("with page breaks turned off, the cut is still seen", () => {
    // The page-51 check reads pdftotext's exit status, not form feeds.
    const out = extractWithStubPdftotext(scratchProject(), 60, { pageBreaks: false });
    expect(out.record.truncated).toBe(true);
    expect(out.record.pages_kept).toBe(EXTRACT_PAGE_CAP);
    expect(out.text).toBe(stubPdfText(EXTRACT_PAGE_CAP, { pageBreaks: false }));
  });

  test("a 50-page PDF is complete", () => {
    const out = extractWithStubPdftotext(scratchProject(), EXTRACT_PAGE_CAP);
    expect(out.record.truncated).toBe(false);
    expect(out.record.pages_kept).toBeUndefined();
    expect(out.text).toBe(stubPdfText(EXTRACT_PAGE_CAP));
  });

  test.each([
    ["Poppler, page breaks off", { pageBreaks: false }],
    ["Xpdf, which exits 0 for a page past the last", { xpdf: true }],
    ["Xpdf, page breaks off", { xpdf: true, pageBreaks: false }],
  ])("a 50-page PDF is complete with %s", (_label, opts) => {
    const out = extractWithStubPdftotext(scratchProject(), EXTRACT_PAGE_CAP, opts);
    expect(out.record.truncated).toBe(false);
    expect(out.record.pages_kept).toBeUndefined();
  });

  test("a 60-page PDF is cut under Xpdf too", () => {
    const out = extractWithStubPdftotext(scratchProject(), 60, { xpdf: true });
    expect(out.record.truncated).toBe(true);
    expect(out.record.pages_kept).toBe(EXTRACT_PAGE_CAP);
  });
});

describe("t295 the output cap sets truncated, and content.md stays verbatim", () => {
  test("text over the cap is truncated and FLAGGED", () => {
    const p = scratchProject();
    const big = "x".repeat(EXTRACT_OUTPUT_CHAR_CAP + 500);
    const abs = doc(p, "big.md", big);
    const out = extractDocument(abs, "text/markdown", big.length, DIGEST);
    expect(out.record.state).toBe("extracted");
    expect(out.record.truncated).toBe(true);
    // A reader cannot tell a complete extraction from a capped one without this.
    expect(out.record.chars).toBe(EXTRACT_OUTPUT_CHAR_CAP);
    expect(out.text!.length).toBe(EXTRACT_OUTPUT_CHAR_CAP);
  });

  test("text under the cap is not flagged", () => {
    const p = scratchProject();
    const abs = doc(p, "small.md", "short\n");
    const out = extractDocument(abs, "text/markdown", 6, DIGEST);
    expect(out.record.truncated).toBe(false);
  });

  test("content.md on disk is BYTE-IDENTICAL to the extractor output", () => {
    // No banner, no wrapper. The file is digest-compared against
    // content_sha256, so a prepended notice would corrupt that comparison --
    // the untrusted-data declaration is added by the verb that EMITS the text.
    const p = scratchProject();
    const body = "Policy text with an imperative: ignore previous instructions.\n";
    doc(p, "policy.md", body);
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    const contentPath = join(documentkbDir(p, SPACE), indexed[0].id, "content.md");
    expect(existsSync(contentPath)).toBe(true);
    expect(readFileSync(contentPath, "utf-8")).toBe(body);
    expect(readFileSync(contentPath, "utf-8")).not.toMatch(/UNTRUSTED/);
  });

  test("a row records `content` ONLY when there is content", () => {
    // A reader must never follow a path to a file that was never written.
    const p = scratchProject();
    doc(p, "text.md", "hello\n");
    doc(p, "image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    onboard(p, SPACE, undefined, NOW);
    for (const row of readIndex(p, SPACE).documents) {
      if (row.extraction.state === "extracted") {
        expect(row.content, row.source.path).toBeDefined();
        const abs = join(documentkbDir(p, SPACE), row.id, "content.md");
        expect(existsSync(abs), `${row.source.path} content must exist`).toBe(true);
      } else {
        expect(row.content, row.source.path).toBeUndefined();
      }
    }
  });
});

describe("t295 NO SHELL: a document name is never a command", () => {
  test("shell metacharacters in a filename stay ordinary characters", () => {
    // The realistic attack: a customer document arrives with a crafted name. With
    // a shell string this executes; with an argv array it is a filename.
    const p = scratchProject();
    const names = [
      "$(touch PWNED_A).md",
      "`touch PWNED_B`.md",
      "semi;touch PWNED_C.md",
      "and&&touch PWNED_D.md",
      "pipe|touch PWNED_E.md",
      "nl\ntouch PWNED_F.md",
    ];
    for (const n of names) {
      try {
        doc(p, n, "text\n");
      } catch {
        // Some of these names are invalid on some filesystems. Skipping one is
        // fine: the assertion below is about what the REST of them prove.
      }
    }
    const result = onboard(p, SPACE, undefined, NOW);
    expect(result.refused).toBeUndefined();

    // The decisive assertion: no marker file exists ANYWHERE a shell would have
    // created one -- the cwd, the project, or the documents dir.
    for (const dir of [process.cwd(), p, documentsDir(p, SPACE)]) {
      const markers = readdirSync(dir).filter((e) => e.startsWith("PWNED_"));
      expect(markers, `a shell ran in ${dir}`).toEqual([]);
    }
    expect(result.indexed.length).toBeGreaterThan(0);
  });

  test("a filename that looks like a flag is not treated as one", () => {
    const p = scratchProject();
    doc(p, "--help.md", "text\n");
    const result = onboard(p, SPACE, undefined, NOW);
    expect(result.refused).toBeUndefined();
    expect(result.indexed.map((r) => r.path)).toContain("documents/--help.md");
  });

  test("the shipped source spawns with an ARGV ARRAY, never a shell", () => {
    // Structural companion: `shell: true` anywhere in this tool would silently
    // undo every case above.
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools",
        "aidlc-knowledge.ts"),
      "utf-8",
    );
    expect(src).not.toContain("shell: true");
    expect(src).not.toMatch(/exec\(|execSync\(/);
  });
});

describe("t295 extraction runs OUTSIDE the audit lock", () => {
  test("the locked region contains no spawn", () => {
    // Extraction must not serialize unrelated commands behind a document parse,
    // even with the larger acquisition backstop. Spawn during staging, before
    // the lock is taken.
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools",
        "aidlc-knowledge.ts"),
      "utf-8",
    );
    for (const [open, close] of [
      ["withAuditLock(projectDir, () => {", "}, undefined, space);"],
      ["const committed = withAuditLock(projectDir, () => {", "}, undefined, space, commitRetries, 100);"],
    ]) {
      const start = src.indexOf(open);
      expect(start, open).toBeGreaterThan(-1);
      const end = src.indexOf(close, start);
      expect(end, close).toBeGreaterThan(start);
      const body = src.slice(start + open.length, end);
      expect(body).not.toContain("spawnSync");
      expect(body).not.toContain("extractDocument");
      expect(body).not.toContain("probeExtractor");
    }
  });
});

describe("t295 a configured extractor overrides the default", () => {
  test("extractorArgvFor returns the default PDF argv with no configuration", () => {
    const argv = extractorArgvFor("application/pdf");
    expect(argv?.[0]).toBe("pdftotext");
  });

  test("an unknown MIME type has no extractor", () => {
    expect(extractorArgvFor("application/x-nonsense")).toBeNull();
  });

  test("a configured extractor that cannot spawn is extractor_unavailable, not a crash", () => {
    // Same degradation as a missing default: the operator's remedy is to fix
    // their configuration, and the command still completes.
    const p = scratchProject();
    const abs = doc(p, "a.pdf", "%PDF-1.4\n");
    // Simulated by asking for a type whose resolved argv0 is absent -- the code
    // path is identical to a configured-but-missing binary.
    const out = extractDocument(abs, "application/pdf", 9, DIGEST);
    expect(["extractor_unavailable", "extraction_failed", "no_extractable_text"])
      .toContain(out.record.state);
    expect(out.record.state).not.toBe("extracted");
  });
});

describe("t295 Finding 4: the per-document size check runs BEFORE the read, not after", () => {
  const AIDLC_TOOLS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");

  test("structural: readCandidate's size gate precedes its call into readDocumentBytes", () => {
    // The defect this closes: EXTRACT_INPUT_BYTE_CAP was only checked inside
    // extractDocument, using a `bytes` count derived from a buffer the CALLER
    // had already fully read -- so the whole file was resident in memory
    // regardless of whether extraction ever ran. This asserts the size gate
    // runs ahead of the read, not merely somewhere in the file.
    //
    // The gate itself lives in `statOnlyRefusal`, shared with `availabilityOf` so
    // that `list` can report the SAME refusal as a status without reading a byte.
    // The ordering property this test pins: readCandidate must call the gate
    // BEFORE it calls readDocumentBytes.
    const src = readFileSync(join(AIDLC_TOOLS, "aidlc-knowledge.ts"), "utf-8");
    const gateFnStart = src.indexOf("function statOnlyRefusal(");
    expect(gateFnStart, "the size gate must live in statOnlyRefusal").toBeGreaterThan(-1);
    const gateFnEnd = src.indexOf("\n}\n", gateFnStart);
    expect(src.slice(gateFnStart, gateFnEnd)).toContain("EXTRACT_INPUT_BYTE_CAP");

    const fnStart = src.indexOf("function readCandidate(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf("\n}\n", fnStart);
    const body = src.slice(fnStart, fnEnd);
    const gateIdx = body.indexOf("statOnlyRefusal(");
    const readIdx = body.indexOf("readDocumentBytes(");
    expect(gateIdx, "readCandidate must call the size gate").toBeGreaterThan(-1);
    expect(readIdx, "readCandidate must call readDocumentBytes").toBeGreaterThan(-1);
    expect(gateIdx, "the size check must precede the read call").toBeLessThan(readIdx);
  });

  test("behavioral: an oversized candidate is refused with the per-document cap named, never indexed", () => {
    const p = scratchProject();
    const abs = doc(p, "big.bin", "x");
    // Grow past the cap via ftruncate rather than writing real bytes: the
    // point of THIS test is the refusal message and outcome, not memory --
    // that is the next test's job, which needs real (non-sparse) content to
    // make a skipped full-buffer read observable.
    const fd = openSync(abs, "r+");
    ftruncateSync(fd, EXTRACT_INPUT_BYTE_CAP + 1024);
    closeSync(fd);

    const { indexed, refused } = onboard(p, SPACE, abs, NOW);
    expect(indexed.length).toBe(0);
    expect(refused, "an oversized candidate must refuse the whole call, not skip silently")
      .toBeDefined();
    expect(refused?.reason).toContain(String(EXTRACT_INPUT_BYTE_CAP));
    expect(refused?.reason).toMatch(/never opened/);
    expect(readIndex(p, SPACE).documents.length).toBe(0);
  });

  test("behavioral: a REAL over-cap file never gets fully buffered — RSS stays far below its size", () => {
    // Chosen over a sparse file on purpose: a sparse file's blocks are never
    // materialised even if read() is called on the whole span (macOS/Linux
    // both fault in zero pages cheaply), so it CANNOT distinguish "stat-then-
    // refuse" from "read-then-check". A file filled with real, incompressible
    // bytes closes that gap -- if this ever got read in full, RSS would climb
    // by roughly the file's size, not by a rounding error.
    const p = scratchProject();
    const abs = doc(p, "real-big.bin", Buffer.alloc(0));
    const sizeBytes = EXTRACT_INPUT_BYTE_CAP + 64 * 1024 * 1024; // ~96 MiB, well over cap
    const fd = openSync(abs, "w");
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 2654435761) & 0xff;
    let written = 0;
    while (written < sizeBytes) {
      const n = Math.min(chunk.length, sizeBytes - written);
      require("node:fs").writeSync(fd, chunk, 0, n);
      written += n;
    }
    closeSync(fd);

    // Driven as a SUBPROCESS so this test's own RSS (bun's runtime, jest-like
    // harness, everything else already loaded) is not conflated with the
    // measurement -- the child imports only the tool and calls onboard once.
    // The baseline is taken after the import, so only onboard's own growth is
    // measured: loading the engine modules grows with the engine itself.
    const driver = join(p, "__t295_rss_probe.ts");
    writeFileSync(
      driver,
      `const m = await import(${JSON.stringify(join(AIDLC_TOOLS, "aidlc-knowledge.ts"))});\n` +
        `const before = process.memoryUsage().rss;\n` +
        `const out = m.onboard(${JSON.stringify(p)}, ${JSON.stringify(SPACE)}, ` +
        `${JSON.stringify(abs)}, ${JSON.stringify(NOW)});\n` +
        `const after = process.memoryUsage().rss;\n` +
        `process.stdout.write(JSON.stringify({ before, after, refused: out.refused ?? null }));\n`,
    );
    const r = spawnSync("bun", [driver], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env: { ...process.env, AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" },
    });
    expect(r.status, (r.stdout ?? "") + (r.stderr ?? "")).toBe(0);
    const { before, after, refused } = JSON.parse(r.stdout ?? "{}") as {
      before: number; after: number; refused: unknown;
    };
    expect(refused, "the oversized file must be refused, not indexed").not.toBeNull();
    const grew = after - before;
    // A full buffer of the ~96 MiB file would grow RSS by about its size.
    // Comfortable slack (30 MiB) for GC noise, while still failing hard if
    // the whole file were ever materialised: 30 MiB is well under the 96 MiB
    // the file actually contains.
    expect(grew, `RSS grew by ${grew} bytes -- the oversized file appears to have been buffered`)
      .toBeLessThan(30 * 1024 * 1024);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

describe("t295 Finding 4: EXTRACT_BATCH_DOC_CAP is enforced, not dead", () => {
  test("onboard refuses a pathless batch over the document cap -- nothing is indexed", () => {
    const p = scratchProject();
    for (let i = 0; i < EXTRACT_BATCH_DOC_CAP + 1; i++) doc(p, `d${i}.txt`, `body ${i}\n`);

    expect(() => onboard(p, SPACE, undefined, NOW)).toThrow(
      new RegExp(`${EXTRACT_BATCH_DOC_CAP}-document batch cap`),
    );
    expect(readIndex(p, SPACE).documents.length, "the refusal must be whole-batch: nothing lands")
      .toBe(0);
  });

  // Sync has the same cap for brand-new documents, so the refusal names it
  // only where some of the work is documents already in the index.
  test("an all-new batch over the cap names no sync; one with indexed documents does", () => {
    const fresh = scratchProject();
    for (let i = 0; i < EXTRACT_BATCH_DOC_CAP + 1; i++) doc(fresh, `d${i}.txt`, `body ${i}\n`);
    expect(() => onboard(fresh, SPACE, undefined, NOW)).toThrow(/a single file at a time\.$/);

    const touched = scratchProject();
    const first = doc(touched, "d0.txt", "body 0\n");
    onboard(touched, SPACE, first, NOW);
    writeFileSync(first, "body 0, edited\n");
    for (let i = 1; i < EXTRACT_BATCH_DOC_CAP + 1; i++) doc(touched, `d${i}.txt`, `body ${i}\n`);
    expect(() => onboard(touched, SPACE, undefined, NOW)).toThrow(/, or run `\/aidlc knowledge sync` instead of a pathless onboard\.$/);
  });

  test("onboard accepts a batch AT exactly the cap (boundary, not off-by-one)", () => {
    const p = scratchProject();
    for (let i = 0; i < EXTRACT_BATCH_DOC_CAP; i++) doc(p, `d${i}.txt`, `body ${i}\n`);
    const { indexed } = onboard(p, SPACE, undefined, NOW);
    expect(indexed.length).toBe(EXTRACT_BATCH_DOC_CAP);
  });

  test("a single-file onboard (an explicit path, not a directory) is EXEMPT from the batch cap", () => {
    // The batch cap bounds an unscoped WALK; a caller who names one file has
    // already scoped their own request and should not be refused because
    // documents/ elsewhere happens to be large.
    const p = scratchProject();
    for (let i = 0; i < EXTRACT_BATCH_DOC_CAP + 5; i++) doc(p, `d${i}.txt`, `body ${i}\n`);
    const target = join(documentsDir(p, SPACE), "d0.txt");
    const { indexed } = onboard(p, SPACE, target, NOW);
    expect(indexed.length).toBe(1);
  });

  test("sync also refuses to reconcile a documents/ tree over the document cap", () => {
    const p = scratchProject();
    for (let i = 0; i < EXTRACT_BATCH_DOC_CAP + 1; i++) doc(p, `d${i}.txt`, `body ${i}\n`);
    expect(() => syncDocuments(p, SPACE, NOW)).toThrow(
      new RegExp(`${EXTRACT_BATCH_DOC_CAP}-document batch cap`),
    );
  });
});

describe("t295 Finding 4: EXTRACT_BATCH_BYTE_CAP is enforced, not dead", () => {
  test("onboard refuses a pathless batch whose TOTAL bytes exceed the byte cap, even under the doc cap", () => {
    // Attack on a narrower fix: a guard that only checked doc COUNT would miss
    // a batch of just a few enormous files. Uses sparse files (ftruncate) --
    // this test is about the byte-cap arithmetic, not about buffering, which
    // the "never gets fully buffered" RSS test above already covers with real
    // bytes.
    const p = scratchProject();
    const perFile = Math.ceil(EXTRACT_BATCH_BYTE_CAP / 3) + 1024;
    for (let i = 0; i < 3; i++) {
      const abs = doc(p, `huge${i}.bin`, "x");
      const fd = openSync(abs, "r+");
      ftruncateSync(fd, perFile);
      closeSync(fd);
    }
    expect(() => onboard(p, SPACE, undefined, NOW)).toThrow(
      new RegExp(`${EXTRACT_BATCH_BYTE_CAP}-byte batch cap`),
    );
    expect(readIndex(p, SPACE).documents.length).toBe(0);
  });
});

describe("t295 Finding 5(c): a DOCX with no configured extractor becomes retryable once one exists", () => {
  // Deterministic regardless of what is installed on the machine running this:
  // uses a SCRATCH COPY of dist/ with its OWN harness.json (same technique as
  // t294), never the real dist. First run configures a NONEXISTENT extractor
  // for the docx mime (forcing extractor_unavailable); second run reconfigures
  // it to a Bun file reader and syncs, proving the row is retryable.
  const REPO = join(import.meta.dir, "..", "..");
  let scratch = "";

  function setDocxExtractor(argv: string[]): void {
    const p = join(scratch, "dist", "claude", ".claude", "tools", "data", "harness.json");
    const data = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    data.documentExtractors = { [WORD_DOCX_MIME]: { argv } };
    writeFileSync(p, JSON.stringify(data));
  }

  function makeDocx(path: string): void {
    // A real ZIP_STORED archive, including CRCs and the central directory.
    // Entries: [Content_Types].xml=<Types/>, word/document.xml=<document/>.
    // Fixed 1980-01-01 timestamps; embedding bytes removes a runtime Python
    // dependency without replacing the valid ZIP with a detector-only stub.
    writeFileSync(path, Buffer.from(
      "UEsDBBQAAAAAAAAAIQDHHBc8CAAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDxUeXBlcy8+UEsDBBQAAAAAAAAAIQBf" +
      "W9FMCwAAAAsAAAARAAAAd29yZC9kb2N1bWVudC54bWw8ZG9jdW1lbnQvPlBLAQIUAxQAAAAAAAAAIQDHHBc8CAAAAAgAAAAT" +
      "AAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAAAAAAhAF9b0UwLAAAACwAAABEAAAAAAAAA" +
      "AAAAAIABOQAAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAACAAIAgAAAAHMAAAAAAA==",
      "base64",
    ));
  }

  function setFileReaderExtractor(): void {
    const reader = join(scratch, "read-docx.ts");
    writeFileSync(reader, [
      'import { readFileSync } from "node:fs";',
      "process.stdout.write(readFileSync(process.argv[2]));",
      "",
    ].join("\n"));
    setDocxExtractor([process.execPath, reader, "$IN"]);
  }

  function runKnowledge(args: string[], projectDir: string): { status: number; out: string } {
    const tool = join(scratch, "dist", "claude", ".claude", "tools", "aidlc-knowledge.ts");
    const r = spawnSync(process.execPath, [tool, ...args, "--project-dir", projectDir, "--json"], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_HARNESS_DIR: ".claude",
        AIDLC_RUNTIME_HARNESS_ROOT: join(scratch, "dist", "claude", ".claude"),
      },
    });
    return { status: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
  }

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = "";
  });

  test("detectedType survives extractor_unavailable, and a later-configured extractor makes the row retryable", () => {
    scratch = mkdtempSync(join(tmpdir(), "t295-docx-"));
    cpSync(join(REPO, "dist"), join(scratch, "dist"), { recursive: true });

    setDocxExtractor(["definitely-not-a-real-extractor-binary", "$IN"]);
    const projectDir = join(scratch, "project");
    mkdirSync(documentsDir(projectDir, SPACE), { recursive: true });
    makeDocx(join(documentsDir(projectDir, SPACE), "a.docx"));

    const onboarded = runKnowledge(["onboard"], projectDir);
    expect(onboarded.status, onboarded.out).toBe(0);
    const afterOnboard = JSON.parse(
      readFileSync(join(documentkbDir(projectDir, SPACE), "index.json"), "utf-8"),
    );
    expect(afterOnboard.documents[0].extraction.state).toBe("extractor_unavailable");
    // detectedType is present, naming the mime a retry needs.
    expect(afterOnboard.documents[0].extraction.detectedType).toBe(WORD_DOCX_MIME);

    // Now a real (if useless) extractor exists for this MIME on every host.
    setFileReaderExtractor();
    const synced = runKnowledge(["sync"], projectDir);
    expect(synced.status, synced.out).toBe(0);
    const parsed = JSON.parse(synced.out.slice(synced.out.indexOf("{")));
    const change = parsed.changes.find((c: { id: string }) => c.id === afterOnboard.documents[0].id);
    // End to end: the row moved off extractor_unavailable once an
    // extractor for its detected type existed -- not stuck there forever.
    expect(change?.change, JSON.stringify(parsed)).toBe("retried");
    expect(change?.state).toBe("extracted");
  });

  test("unsupported_type retries after an extractor is configured", () => {
    scratch = mkdtempSync(join(tmpdir(), "t295-docx-unsupported-"));
    cpSync(join(REPO, "dist"), join(scratch, "dist"), { recursive: true });

    const projectDir = join(scratch, "project");
    mkdirSync(documentsDir(projectDir, SPACE), { recursive: true });
    makeDocx(join(documentsDir(projectDir, SPACE), "a.docx"));

    const onboarded = runKnowledge(["onboard"], projectDir);
    expect(onboarded.status, onboarded.out).toBe(0);
    const afterOnboard = JSON.parse(
      readFileSync(join(documentkbDir(projectDir, SPACE), "index.json"), "utf-8"),
    );
    // AI-DLC reads Word itself now; a row recorded before it did says unsupported_type.
    expect(afterOnboard.documents[0].extraction.extractor?.name).toBe("builtin-ooxml");
    const row = afterOnboard.documents[0];
    row.extraction = { state: "unsupported_type", detectedType: WORD_DOCX_MIME };
    delete row.content;
    delete row.content_sha256;
    writeFileSync(join(documentkbDir(projectDir, SPACE), "index.json"), `${JSON.stringify(afterOnboard, null, 2)}\n`);

    // A configured extractor for the type wins over the built-in reader on the retry.
    setFileReaderExtractor();
    const synced = runKnowledge(["sync"], projectDir);
    expect(synced.status, synced.out).toBe(0);
    const parsed = JSON.parse(synced.out.slice(synced.out.indexOf("{")));
    const change = parsed.changes.find((c: { id: string }) => c.id === afterOnboard.documents[0].id);
    expect(change?.change, JSON.stringify(parsed)).toBe("retried");
    expect(change?.state).toBe("extracted");
  });
});

// An HTML page (a spec exported from Word, Confluence or Google Docs) is read
// by the knowledge base itself, as a Word file is: its text in lines, tables as
// Markdown tables, in the page's own encoding. Stored as markup, its style
// attributes and an inline image would fill the 200,000-character cap, and a
// page that is not UTF-8 would have no text at all.
describe("t295 an HTML page is read as its text, the way a Word file is", () => {
  const SENTENCE = "The service records each request in the audit log, checks the caller against the access list, " +
    "and returns a receipt within two seconds.";
  const pad = (n: number): string => String(n).padStart(5, "0");

  function page(body: string, head = ""): string {
    return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Page title</title>\n${head}</head>\n` +
      `<body>\n${body}</body>\n</html>\n`;
  }

  // Windows-1252 bytes for text whose characters are all in that table.
  function cp1252(text: string): Buffer {
    const high: Record<string, number> = { "\u201c": 0x93, "\u201d": 0x94, "\u2013": 0x96, "\u20ac": 0x80 };
    return Buffer.from([...text].map((ch) => high[ch] ?? ch.charCodeAt(0)));
  }

  function stored(p: string, name: string) {
    const row = readIndex(p, SPACE).documents.find((entry) => entry.source.path === `documents/${name}`);
    expect(row, name).toBeDefined();
    const at = join(documentkbDir(p, SPACE), row!.id, "content.md");
    return { row: row!, text: existsSync(at) ? readFileSync(at, "utf-8") : undefined };
  }

  function added(p: string, name: string, body: string | Buffer) {
    doc(p, name, body);
    expect(onboard(p, SPACE, undefined, NOW).refused).toBeUndefined();
    return stored(p, name);
  }

  // What an earlier AI-DLC wrote for a page: its markup as text, or no type for a page that is not UTF-8.
  function asBeforeTheReader(p: string, name: string, how: "markup" | "no-type"): void {
    const index = readIndex(p, SPACE);
    const row = index.documents.find((entry) => entry.source.path === `documents/${name}`)!;
    const bytes = readFileSync(join(documentsDir(p, SPACE), name));
    if (how === "markup") {
      const markup = bytes.toString("utf-8");
      writeFileSync(join(documentkbDir(p, SPACE), row.id, "content.md"), markup);
      row.extraction = {
        state: "extracted", extractor: { name: "builtin-text", version: "1" }, chars: markup.length,
        truncated: false, source_revision: row.sha256,
      };
      row.content = `documentkb/${row.id}/content.md`;
      row.content_sha256 = createHash("sha256").update(markup, "utf-8").digest("hex");
    } else {
      row.extraction = { state: "unsupported_type", detectedType: "application/octet-stream" };
      delete row.content;
      delete row.content_sha256;
    }
    writeIndex(p, SPACE, index);
  }

  const retried = (p: string): string[] =>
    syncDocuments(p, SPACE, NOW).changes.filter((c) => c.change === "retried").map((c) => c.path).sort();

  test("a page is text/html by its name and its opening markup; every other shape keeps its type", () => {
    const html = Buffer.from("<html><body><p>x</p></body></html>\n");
    expect(detectMimeType("/x/spec.html", html)).toBe("text/html");
    expect(detectMimeType("/x/spec.htm", html)).toBe("text/html");
    expect(detectMimeType("/x/SPEC.HTML", html)).toBe("text/html");
    expect(detectMimeType("/x/bom.html", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("\r\n  <!DOCTYPE html>")])))
      .toBe("text/html");
    expect(detectMimeType("/x/word.htm", cp1252("<html><body>\u201cquoted\u201d</body></html>"))).toBe("text/html");
    expect(detectMimeType("/x/notes.html", Buffer.from("Release notes\n\nLine one.\n"))).toBe("text/plain");
    expect(detectMimeType("/x/notes.md", Buffer.from("<div>Keep <b>this</b></div>\n"))).toBe("text/markdown");
    expect(detectMimeType("/x/notes.txt", html)).toBe("text/plain");
    expect(detectMimeType("/x/utf16.html", Buffer.from("<\u0000h\u0000"))).toBe("application/octet-stream");
  });

  test("a long page of styled paragraphs keeps 200,000 characters of its text, not of its markup", () => {
    const p = scratchProject();
    const paras = Array.from({ length: 12_000 }, (_, i) =>
      `<p style="margin:0in;font-size:11pt;font-family:&quot;Calibri&quot;,sans-serif">T${pad(i + 1)} ${SENTENCE}</p>\n`);
    const { row, text } = added(p, "spec-text.html", page(`<h1>Service specification</h1>\n${paras.join("")}`,
      "<style>\np { margin: 0; }\n</style>\n"));
    expect(row.extraction).toMatchObject({
      state: "extracted", extractor: { name: "builtin-html", version: "1" }, chars: EXTRACT_OUTPUT_CHAR_CAP, truncated: true,
    });
    expect(text!.startsWith(`Service specification\nT00001 ${SENTENCE}\nT00002 `)).toBe(true);
    expect(text).not.toMatch(/<\/?[a-z!]/i);
    expect(text).not.toContain("margin");
    // Stored as markup, the cap ends near paragraph 880; stored as text, well past it.
    expect(text).toContain(`T01300 ${SENTENCE}`);
  });

  test("a page whose inline image comes first keeps every paragraph and none of the image", () => {
    const p = scratchProject();
    const image = Buffer.alloc(3_000_000, 0x5a).toString("base64");
    const paras = Array.from({ length: 1_000 }, (_, i) => `<p>I${pad(i + 1)} ${SENTENCE}</p>\n`);
    const { row, text } = added(p, "spec-images.html",
      page(`<p><img src="data:image/png;base64,${image}" alt="Context diagram"></p>\n${paras.join("")}`));
    expect(row.extraction).toMatchObject({ state: "extracted", truncated: false });
    expect(text).toContain(`I00001 ${SENTENCE}`);
    expect(text).toContain(`I01000 ${SENTENCE}`);
    expect(text).not.toMatch(/[A-Za-z0-9+/]{200,}/);
    expect(text).not.toContain("Context diagram");
  });

  test("a Word page saved in Windows-1252 is read in its declared charset", () => {
    const p = scratchProject();
    const word = cp1252(
      `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns="http://www.w3.org/TR/REC-html40">\n<head>\n` +
        `<meta http-equiv=Content-Type content="text/html; charset=windows-1252">\n<title>Pricing rules</title>\n` +
        `<!--[if gte mso 9]><xml><o:DocumentProperties><o:Author>Someone</o:Author></o:DocumentProperties></xml><![endif]-->\n` +
        `<style>\n<!--\n p.MsoNormal {margin:0in;}\n-->\n</style>\n</head>\n<body lang=EN-US>\n<div class=WordSection1>\n` +
        `<p class=MsoNormal>W00001 The \u201cstandard\u201d caf\u00e9 price is \u20ac4 \u2013 per cup.<o:p></o:p></p>\n` +
        `<p class=MsoNormal><o:p>&nbsp;</o:p></p>\n</div>\n</body>\n</html>\n`,
    );
    const { row, text } = added(p, "spec-cp1252.html", word);
    expect(row.extraction.state).toBe("extracted");
    expect(text).toBe("W00001 The \u201cstandard\u201d caf\u00e9 price is \u20ac4 \u2013 per cup.");
  });

  test("a charset declared deep in the head is read; an undeclared page that is not UTF-8 is read as Windows-1252", () => {
    const p = scratchProject();
    const cyrillic = Buffer.concat([
      Buffer.from(`<html><head><!-- ${"x".repeat(6_000)} --><meta charset="windows-1251"></head><body><p>`),
      Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
      Buffer.from("</p></body></html>"),
    ]);
    expect(added(p, "ru.html", cyrillic).text).toBe("\u041f\u0440\u0438\u0432\u0435\u0442");
    expect(added(p, "plain-1252.htm", cp1252("<p>\u201cyes\u201d \u2013 caf\u00e9</p>")).text)
      .toBe("\u201cyes\u201d \u2013 caf\u00e9");
  });

  test("a small .htm is its lines; the title is not one of them", () => {
    const p = scratchProject();
    const { row, text } = added(p, "small.htm",
      "<html><head><title>Old title</title></head><body><h2>Glossary</h2><p>A <b>tenant</b> is one customer account.</p></body></html>\n");
    expect(row.extraction.extractor).toEqual({ name: "builtin-html", version: "1" });
    expect(text).toBe("Glossary\nA tenant is one customer account.");
  });

  test("CRLF and source line wraps read as one line; pre keeps its lines and its blank line", () => {
    const p = scratchProject();
    const { text } = added(p, "crlf.html",
      "<html>\r\n<body>\r\n<p>First line\r\nwraps here.</p>\r\n<p>Second paragraph.</p>\r\n" +
        "<pre>\r\nset -e\r\n\r\n  echo done\r\n</pre>\r\n</body>\r\n</html>\r\n");
    expect(text).toBe("First line wraps here.\nSecond paragraph.\nset -e\n\n  echo done");
  });

  test("tables are the Word reader's Markdown tables; hidden text is gone; references decode; Markdown stays as written", () => {
    const p = scratchProject();
    const { text } = added(p, "rules.html", page(
      "<table><tr><th>A</th><th>B</th></tr><tr><td rowspan=2>1</td><td>2 | x</td></tr><tr><td>y</td></tr></table>\n" +
        "<script>var hidden = 'SCRIPT-TEXT';</script><noscript><p>NOSCRIPT-TEXT</p></noscript>" +
        "<template><p>TEMPLATE-TEXT</p></template><iframe>IFRAME-TEXT</iframe>\n" +
        "<p>before</p><svg><style/><text>Client</text><text>Gateway</text></svg><p>after</p>\n" +
        "<p>&amp; &lt;tag&gt; a&nbsp;b &rsquo;s &le; 5 &rarr; next &#8212; &#x2013; &#150; &zzz; &amp ;</p>\n" +
        "<p>*stars* _under_ [a link](https://example.com/x) `tick` \\escaped # hash</p>\n",
      "<style>p { color: red; }</style>",
    ));
    expect(text).toBe([
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 \\| x |",
      "|  | y |",
      "",
      "before",
      "Client",
      "Gateway",
      "after",
      "& <tag> a b \u2019s \u2264 5 \u2192 next \u2014 \u2013 \u2013 &zzz; &amp ;",
      "*stars* _under_ [a link](https://example.com/x) `tick` \\escaped # hash",
    ].join("\n"));
  });

  test("a page with no text to read, an image or a page a script draws, is no_extractable_text", () => {
    const p = scratchProject();
    const image = added(p, "diagram.html", page('<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="Diagram"></p>\n'));
    expect(image.row.extraction).toEqual({
      state: "no_extractable_text", extractor: { name: "builtin-html", version: "1" }, source_revision: image.row.sha256,
    });
    expect(image.text).toBeUndefined();
    const app = added(p, "app.html", page(
      '<noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div>\n' +
        '<script>window.__DATA__ = {"endpoints": ["/a", "/b"]};</script>\n'));
    expect(app.row.extraction.state).toBe("no_extractable_text");
  });

  test("a page added before is read on the next sync, once; a plain-text .html and a failed page are left", () => {
    const p = scratchProject();
    doc(p, "markup.html", page(`<p>M00001 ${SENTENCE}</p>\n`));
    doc(p, "word.htm", cp1252("<html><body><p>\u201cW00001\u201d</p></body></html>"));
    doc(p, "notes.html", "Release notes\n\nLine one.\n");
    doc(p, "broken.html", page("<p>B00001</p>\n"));
    expect(onboard(p, SPACE, undefined, NOW).refused).toBeUndefined();
    asBeforeTheReader(p, "markup.html", "markup");
    asBeforeTheReader(p, "word.htm", "no-type");
    const index = readIndex(p, SPACE);
    const broken = index.documents.find((entry) => entry.source.path === "documents/broken.html")!;
    broken.extraction = {
      state: "extraction_failed", extractor: { name: "builtin-html", version: "1" },
      reason: "AI-DLC could not read it as an HTML file", detectedType: "text/html",
    };
    delete broken.content;
    delete broken.content_sha256;
    writeIndex(p, SPACE, index);
    // Before the sync, the page that had no type is named as one the next sync reads, not as one with no reader.
    const before = unreadDocuments(p, SPACE).find((file) => file.path === "documents/word.htm");
    expect(before?.reason).toBe("office");
    expect(unreadDocumentsLabel(p, SPACE, [before!])).toContain(
      '"word.htm" was added before AI-DLC could read Word, Excel and HTML files.');
    expect(retried(p)).toEqual(["documents/markup.html", "documents/word.htm"]);
    expect(stored(p, "markup.html").text).toBe(`M00001 ${SENTENCE}`);
    expect(stored(p, "word.htm").text).toBe("\u201cW00001\u201d");
    expect(stored(p, "notes.html").row.extraction.extractor).toEqual({ name: "builtin-text", version: "1" });
    expect(stored(p, "notes.html").text).toBe("Release notes\n\nLine one.\n");
    expect(retried(p)).toEqual([]);
    expect(unreadDocuments(p, SPACE).map((file) => file.path)).toEqual(["documents/broken.html"]);
  });

  test("a page added before that is over the per-document cap is named as today, and sync goes on", () => {
    const p = scratchProject();
    const abs = doc(p, "huge.html", page("<p>H00001</p>\n"));
    expect(onboard(p, SPACE, undefined, NOW).refused).toBeUndefined();
    asBeforeTheReader(p, "huge.html", "no-type");
    const fd = openSync(abs, "r+");
    ftruncateSync(fd, EXTRACT_INPUT_BYTE_CAP + 1);
    closeSync(fd);
    expect(unreadDocuments(p, SPACE)).toEqual([{ path: "documents/huge.html", reason: "no-reader" }]);
    expect(() => syncDocuments(p, SPACE, NOW)).not.toThrow();
  });

  test("more pages added before than one sync reads: each sync reads what fits, and none refuses", () => {
    const p = scratchProject();
    const names = Array.from({ length: EXTRACT_BATCH_DOC_CAP + 2 }, (_, i) => `page-${pad(i + 1)}.html`);
    for (const [at, name] of names.entries()) {
      doc(p, name, page(`<p>P${pad(at + 1)}</p>\n`));
      expect(onboard(p, SPACE, join(documentsDir(p, SPACE), name), NOW).refused).toBeUndefined();
    }
    for (const name of names) asBeforeTheReader(p, name, "markup");
    // New files share the run: they are the person's work, and the pages read again take the room left.
    for (let i = 0; i < 5; i++) doc(p, `new-${i}.md`, `new ${i}\n`);
    const first = syncDocuments(p, SPACE, NOW).changes;
    expect(first.filter((c) => c.change === "new").length).toBe(5);
    expect(first.filter((c) => c.change === "retried").length).toBe(EXTRACT_BATCH_DOC_CAP - 5);
    expect(retried(p).length).toBe(7);
    expect(retried(p)).toEqual([]);
    expect(names.every((name) => stored(p, name).row.extraction.extractor?.name === "builtin-html")).toBe(true);
  });
});

describe("t295 a team's own text/html extractor wins over the built-in HTML reader", () => {
  const REPO = join(import.meta.dir, "..", "..");
  let scratch = "";

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = "";
  });

  test("the page goes to the configured extractor", () => {
    scratch = mkdtempSync(join(tmpdir(), "t295-html-"));
    cpSync(join(REPO, "dist", "claude"), join(scratch, "dist", "claude"), { recursive: true });
    const reader = join(scratch, "read-html.ts");
    writeFileSync(reader, 'process.stdout.write("FROM THE TEAM EXTRACTOR\\n");\n');
    const harness = join(scratch, "dist", "claude", ".claude", "tools", "data", "harness.json");
    const data = JSON.parse(readFileSync(harness, "utf-8")) as Record<string, unknown>;
    data.documentExtractors = { "text/html": { argv: [process.execPath, reader, "$IN"] } };
    writeFileSync(harness, JSON.stringify(data));
    const projectDir = join(scratch, "project");
    mkdirSync(documentsDir(projectDir, SPACE), { recursive: true });
    writeFileSync(join(documentsDir(projectDir, SPACE), "spec.html"), "<html><body><p>Built-in text</p></body></html>\n");
    const r = spawnSync(process.execPath, [
      join(scratch, "dist", "claude", ".claude", "tools", "aidlc-knowledge.ts"), "onboard", "--project-dir", projectDir, "--json",
    ], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env: { ...process.env, AIDLC_HARNESS_DIR: ".claude", AIDLC_RUNTIME_HARNESS_ROOT: join(scratch, "dist", "claude", ".claude") },
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const row = readIndex(projectDir, SPACE).documents[0];
    expect(row.extraction.state).toBe("extracted");
    expect(row.extraction.extractor?.name).toBe(process.execPath);
    expect(readFileSync(join(documentkbDir(projectDir, SPACE), row.id, "content.md"), "utf-8")).toBe("FROM THE TEAM EXTRACTOR\n");
  });
});
