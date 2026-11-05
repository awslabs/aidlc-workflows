// covers: file:tools/aidlc-pdf.ts, function:pdfText, function:readPdfMain, function:extractDocument, function:shouldRetryExtraction
//
// A PDF on a machine without pdftotext (Windows, macOS, a Linux server image) was recorded
// `extractor_unavailable`, so no stage got its text. The knowledge index now reads it with AI-DLC's own reader on
// Bun's built-ins, as a child process under the extraction timeout: pdftotext still runs first where it is
// installed, a configured extractor that is missing stays missing, and a PDF AI-DLC read itself is read again by
// pdftotext once the person installs it.
//
// The fixtures tests/fixtures/documents/pdf-*.pdf are synthetic: made with LibreOffice 26.8.2, tectonic (LaTeX)
// and reportlab from invented text only (no record or workshop file went into them).

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { stubPdftotextPath } from "../harness/stub-pdftotext.ts";
import { cleanupTestProject, createTestProject, DEFAULT_SPACE, FIXTURES_DIR, resetAidlcEnv } from "../harness/fixtures.ts";
import { documentsDir, EXTRACT_PAGE_CAP, onboard, readIndex, shouldRetryExtraction, syncDocuments } from "../../core/tools/aidlc-knowledge.ts";
import { PDF_STREAM_INFLATE_MAX, PdfError, pdfText } from "../../core/tools/aidlc-pdf.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const DOCS = join(FIXTURES_DIR, "documents");
const DIGEST = "a".repeat(64);
const NOW = "2026-11-05T00:00:00.000Z";
const DIST = join(import.meta.dir, "../../dist/claude/.claude/tools");
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) cleanupTestProject(dir);
});

function project(): string {
  resetAidlcEnv();
  const p = createTestProject();
  made.push(p);
  return p;
}

function fixture(name: string): Buffer {
  return readFileSync(join(DOCS, name));
}

function put(p: string, name: string, data: Buffer | string): string {
  const abs = join(documentsDir(p, DEFAULT_SPACE), name);
  mkdirSync(documentsDir(p, DEFAULT_SPACE), { recursive: true });
  writeFileSync(abs, data);
  return abs;
}

/** A PDF of one standard-font line per page, written here: no fixture needed. With `image`, every page also
 *  draws one Flate-compressed image of that many raw bytes; with `filter`, each page's content stream names it. */
function minimalPdf(pages: string[], image?: number, filter?: string): Buffer {
  const objs: string[] = [];
  const kids: number[] = [];
  const first = 5;
  const xobject = image === undefined ? "" : " /XObject << /Im1 4 0 R >>";
  pages.forEach((line, k) => {
    const draw = image === undefined ? "" : "q 612 0 0 792 0 0 cm /Im1 Do Q ";
    const content = line === "" ? draw : `${draw}BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
    objs[first + 2 * k] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >>${xobject} >> /Contents ${first + 2 * k + 1} 0 R >>`;
    objs[first + 2 * k + 1] = `<< /Length ${content.length}${filter ? ` /Filter /${filter}` : ""} >>\nstream\n${content}\nendstream`;
    kids.push(first + 2 * k);
  });
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  for (let n = 1; n < objs.length; n++) {
    if (n === 4) {
      if (image === undefined) continue;
      const data = deflateSync(Buffer.alloc(image));
      parts.push(Buffer.from(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image} /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1"));
      continue;
    }
    parts.push(Buffer.from(`${n} 0 obj\n${objs[n]}\nendobj\n`, "latin1"));
  }
  parts.push(Buffer.from(`trailer\n<< /Root 1 0 R /Size ${objs.length} >>\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

/** Runs `body` (with the knowledge module as `kb`) in a child whose PATH is empty, so no pdftotext is on it on
 *  any machine; returns what `body` returns. */
function withoutPdftotext<T>(p: string, body: string, extraEnv: Record<string, string> = {}): T {
  const empty = join(p, "empty-bin");
  mkdirSync(empty, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  const kb = pathToFileURL(join(DIST, "aidlc-knowledge.ts")).href;
  const r = spawnSync(process.execPath, ["-e", `import * as kb from ${JSON.stringify(kb)};
if (kb.probeExtractor("pdftotext").available) throw new Error("pdftotext is on the empty PATH");
const out = (() => { ${body} })();
console.log(JSON.stringify(out));`], {
    cwd: empty,
    env: { ...env, ...extraEnv, PATH: empty },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "null") as T;
}

interface Outcome {
  record: { state: string; extractor?: unknown; reason?: string; truncated?: boolean; pages_kept?: number; detectedType?: string };
  text?: string;
}

function extractWithout(p: string, abs: string): Outcome {
  return withoutPdftotext<Outcome>(p, `return kb.extractDocument(${JSON.stringify(abs)}, "application/pdf", ${statSync(abs).size}, ${JSON.stringify(DIGEST)});`);
}

describe("t-knowledge-pdf-fallback: a PDF is read where pdftotext is missing", () => {
  test("a LibreOffice PDF is read by AI-DLC's own reader: its headings, table rows and list", () => {
    const p = project();
    const out = extractWithout(p, put(p, "handbook.pdf", fixture("pdf-libreoffice.pdf")));
    expect(out.record.state).toBe("extracted");
    expect(out.record.extractor).toEqual({ name: "builtin-pdf", version: "1" });
    expect(out.record.truncated).toBe(false);
    for (const line of ["Settlement handbook", "Writer token OKAPI-1180 closes the first section.", "Legacy field New field Rule", "POST_DT posted_at UTC, token GECKO-7127", "Third step: report token LEMUR-3391."]) {
      expect(out.text).toContain(line);
    }
    // Each page ends with a form feed, as pdftotext ends them.
    expect(out.text?.endsWith("\n\f")).toBe(true);
  });

  test("a file with only an owner password is read; one with an open password is recorded once, with the reason", () => {
    const p = project();
    const open = extractWithout(p, put(p, "memo.pdf", fixture("pdf-rc4-owner-password.pdf")));
    expect(open.record.state).toBe("extracted");
    expect(open.text).toContain("NUMBAT-7741");
    const locked = extractWithout(p, put(p, "locked.pdf", fixture("pdf-rc4-open-password.pdf")));
    expect(locked.record.state).toBe("extraction_failed");
    expect(locked.record.extractor).toEqual({ name: "builtin-pdf", version: "1" });
    expect(locked.record.reason).toBe("AI-DLC could not read it as a PDF: it is protected by a password");
    expect(locked.record.detectedType).toBe("application/pdf");
  });

  test("a PDF with no text is no_extractable_text, a damaged one extraction_failed, and neither stops the batch", () => {
    const p = project();
    const blank = extractWithout(p, put(p, "blank.pdf", minimalPdf([""])));
    expect(blank.record.state).toBe("no_extractable_text");
    expect(blank.record.extractor).toEqual({ name: "builtin-pdf", version: "1" });
    const broken = extractWithout(p, put(p, "broken.pdf", "%PDF-1.4\n"));
    expect(broken.record.state).toBe("extraction_failed");
    expect(broken.record.reason).toStartWith("AI-DLC could not read it as a PDF: it is damaged");
  });

  test("text in a compression the reader does not decode is recorded as not read, not as a scan", () => {
    const p = project();
    const out = extractWithout(p, put(p, "old.pdf", minimalPdf(["Old page text"], undefined, "LZWDecode")));
    expect(out.record.state).toBe("extraction_failed");
    expect(out.record.reason).toContain("LZWDecode");
    expect(out.record.reason).toContain("pdftotext");
  });

  test("the page cap holds: pages past it are left out and the row says so", () => {
    const p = project();
    const abs = put(p, "long.pdf", minimalPdf(Array.from({ length: EXTRACT_PAGE_CAP + 1 }, (_, k) => `Page ${k + 1} text`)));
    const out = extractWithout(p, abs);
    expect(out.record.state).toBe("extracted");
    expect(out.record.truncated).toBe(true);
    expect(out.record.pages_kept).toBe(EXTRACT_PAGE_CAP);
    expect(out.text).toContain(`Page ${EXTRACT_PAGE_CAP} text`);
    expect(out.text).not.toContain(`Page ${EXTRACT_PAGE_CAP + 1} text`);
  });

  test("a document recorded with no reader before is read on the next sync, once", () => {
    const p = project();
    put(p, "handbook.pdf", fixture("pdf-libreoffice.pdf"));
    const rows = withoutPdftotext<{ first: number; second: number; state: { state: string; extractor?: unknown } }>(p, `
      const p = ${JSON.stringify(p)};
      kb.onboard(p, "default", undefined, ${JSON.stringify(NOW)});
      const index = kb.readIndex(p, "default");
      for (const row of index.documents) { row.extraction = { state: "extractor_unavailable", extractor: { name: "pdftotext" }, detectedType: "application/pdf" }; delete row.content; delete row.content_sha256; }
      kb.writeIndex(p, "default", index);
      const first = kb.syncDocuments(p, "default", ${JSON.stringify(NOW)}).changes.filter((c) => c.change === "retried").length;
      const second = kb.syncDocuments(p, "default", ${JSON.stringify(NOW)}).changes.filter((c) => c.change === "retried").length;
      return { first, second, state: kb.readIndex(p, "default").documents[0].extraction };`);
    expect(rows.first).toBe(1);
    expect(rows.second).toBe(0);
    expect(rows.state.state).toBe("extracted");
    expect(rows.state.extractor).toEqual({ name: "builtin-pdf", version: "1" });
  });

  test("a team's own pdftotext that is missing stays missing, and the line says to install it", () => {
    const p = project();
    put(p, "handbook.pdf", fixture("pdf-libreoffice.pdf"));
    // The team's distribution configures pdftotext for PDFs: never replaced by AI-DLC's reader.
    const root = join(p, "harness-root");
    cpSync(join(DIST, "data"), join(root, "tools", "data"), { recursive: true });
    const harness = join(root, "tools", "data", "harness.json");
    const data = JSON.parse(readFileSync(harness, "utf-8")) as Record<string, unknown>;
    data.documentExtractors = { "application/pdf": { argv: ["pdftotext", "$IN", "-"] } };
    writeFileSync(harness, JSON.stringify(data));
    const out = withoutPdftotext<{ state: string; unread: unknown }>(p, `
      const p = ${JSON.stringify(p)};
      kb.onboard(p, "default", undefined, ${JSON.stringify(NOW)});
      return { state: kb.readIndex(p, "default").documents[0].extraction.state, unread: kb.unreadDocuments(p, "default") };`,
    { AIDLC_RUNTIME_HARNESS_ROOT: root, AIDLC_HARNESS_DIR: ".claude" });
    expect(out.state).toBe("extractor_unavailable");
    expect(out.unread).toEqual([{ path: "documents/handbook.pdf", reason: "no-extractor" }]);
  });

  test("the reader answers through the engine's own command, as a compiled binary runs it", () => {
    const p = project();
    const r = spawnSync(process.execPath, [join(DIST, "aidlc.ts"), "engine", "knowledge", "read-pdf", "--page-cap", String(EXTRACT_PAGE_CAP)], {
      cwd: p,
      input: fixture("pdf-libreoffice.pdf"),
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Writer token OKAPI-1180");
    expect(JSON.parse(r.stderr.trim().split("\n").at(-1)!)).toEqual({ pages: 1 });
  });
});

describe.skipIf(process.platform === "win32")("t-knowledge-pdf-fallback: pdftotext first where it is installed (POSIX stand-in)", () => {
  test("with pdftotext on PATH it reads the PDF, and a PDF AI-DLC read itself is read again by it, once", () => {
    const p = project();
    put(p, "handbook.pdf", fixture("pdf-libreoffice.pdf"));
    const saved = process.env.PATH;
    try {
      process.env.PATH = join(p, "empty-bin");
      mkdirSync(process.env.PATH, { recursive: true });
      expect(onboard(p, DEFAULT_SPACE, undefined, NOW).refused).toBeUndefined();
      const row = readIndex(p, DEFAULT_SPACE).documents[0];
      expect(row.extraction.extractor).toEqual({ name: "builtin-pdf", version: "1" });
      expect(shouldRetryExtraction(row)).toBe(false);
      process.env.PATH = stubPdftotextPath(p, 1);
      expect(shouldRetryExtraction(row)).toBe(true);
      expect(syncDocuments(p, DEFAULT_SPACE, NOW).changes.filter((c) => c.change === "retried").length).toBe(1);
      expect(readIndex(p, DEFAULT_SPACE).documents[0].extraction.extractor?.name).toBe("pdftotext");
      expect(syncDocuments(p, DEFAULT_SPACE, NOW).changes.some((c) => c.change === "retried")).toBe(false);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("t-knowledge-pdf-fallback: the reader itself", () => {
  test("two LaTeX columns read column by column, sections in order, and a word broken at a line end joined", () => {
    const { text, pages } = pdfText(fixture("pdf-latex-two-column.pdf"));
    expect(pages).toBe(2);
    const at = (s: string) => text.indexOf(s);
    expect(at("Abstract")).toBeGreaterThanOrEqual(0);
    expect(at("Abstract")).toBeLessThan(at("1 Introduction"));
    expect(at("1 Introduction")).toBeLessThan(at("2 Method"));
    expect(at("2 Method")).toBeLessThan(at("3 Results"));
    expect(text).toContain("Footnote token OTTER-9152.");
    expect(text).toContain("AMT_CENTS amount divide by 100, token TAPIR-4410");
    expect(text).not.toMatch(/[a-z]-\n[a-z]/);
  });

  test("two frames on a page read frame by frame", () => {
    const { text } = pdfText(fixture("pdf-two-frames.pdf"));
    expect(text).toContain("PANGOLIN-4730");
    expect(text.indexOf("Queue rounding cutoff depot amount rate invoice")).toBeLessThan(text.indexOf("Amount posting parcel amount account carrier"));
  });

  test("Greek and Cyrillic keep their word spaces, Japanese drawn as ActualText is read, Arabic reads in logical order", () => {
    const { text } = pdfText(fixture("pdf-libreoffice-scripts.pdf"));
    expect(text).toContain("Greek: \u039f \u03bb\u03bf\u03b3\u03b1\u03c1\u03b9\u03b1\u03c3\u03bc\u03cc\u03c2 \u03ba\u03bb\u03b5\u03af\u03bd\u03b5\u03b9 \u03c3\u03c4\u03b9\u03c2 \u03c0\u03ad\u03bd\u03c4\u03b5. \u039a\u03c9\u03b4\u03b9\u03ba\u03cc\u03c2 \u0391\u039b\u03a6\u0391-2201.");
    expect(text).toContain("Cyrillic: \u0421\u0447\u0451\u0442 \u0437\u0430\u043a\u0440\u044b\u0432\u0430\u0435\u0442\u0441\u044f \u0432 \u043f\u044f\u0442\u044c \u0447\u0430\u0441\u043e\u0432. \u041a\u043e\u0434 \u0411\u0415\u0422\u0410-3302.");
    expect(text).toContain("\u53e3\u5ea7\u306f\u4e94\u6642\u306b\u7de0\u3081\u5207\u3089\u308c\u307e\u3059\u3002");
    expect(text).toContain("\u064a\u063a\u0644\u0642 \u0627\u0644\u062d\u0633\u0627\u0628 \u0641\u064a \u0627\u0644\u0633\u0627\u0639\u0629 \u0627\u0644\u062e\u0627\u0645\u0633\u0629");
  });

  test("a page cap leaves the later pages out and says so", () => {
    const r = pdfText(fixture("pdf-latex-two-column.pdf"), 1);
    expect(r.pages).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("1 Introduction");
    expect(r.text).not.toContain("AMT_CENTS");
  });

  test("images are never inflated: a page of text with an image past the stream cap is read", () => {
    // A handbook of full-size screenshots inflates far past the caps, but its images hold no text.
    const { text } = pdfText(minimalPdf(["Screenshot page text", "Second page text"], PDF_STREAM_INFLATE_MAX + 1024));
    expect(text).toContain("Screenshot page text");
    expect(text).toContain("Second page text");
  });

  test("a file it cannot open is a PdfError in the person's terms", () => {
    expect(() => pdfText(Buffer.from("not a pdf"))).toThrow(PdfError);
    expect(() => pdfText(minimalPdf(["Old page text"], undefined, "RunLengthDecode"))).toThrow("RunLengthDecode");
    expect(() => pdfText(fixture("pdf-rc4-open-password.pdf"))).toThrow("it is protected by a password");
  });
});
