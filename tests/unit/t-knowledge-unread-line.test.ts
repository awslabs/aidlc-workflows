// covers: file:tools/aidlc-knowledge.ts, function:unreadDocuments, function:unreadDocumentsNotice, function:markUnreadDocumentsSaid, subcommand:aidlc-orchestrate:next
//
// A file the person put in the space's knowledge documents folder that was
// never added, or was added with no text the agents can read, was skipped
// without a word: only `knowledge list` and `show` named it, and work went on
// to approvals without what it holds. The engine's next step now names such
// files in one line, once per work (a file it has already named is never named
// again in that work), and doctor shows the same set every time it is asked.
// No stop and no question: the person decides whether to carry on.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_SPACE,
  FIXTURES_DIR,
  resetAidlcEnv,
  seedAidlcMemory,
  seedStateFile,
} from "../harness/fixtures.ts";
import {
  documentsDir,
  markUnreadDocumentsSaid,
  onboard,
  readIndex,
  unreadDocuments,
  unreadDocumentsNotice,
  WORD_DOCX_MIME,
  writeIndex,
} from "../../core/tools/aidlc-knowledge.ts";
import { collectDoctorReport } from "../../core/tools/aidlc-utility.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LEAD = "AI-DLC's knowledge base cannot read";
// An old Excel (.xls) file: an OLE compound file, which the knowledge base has no reader for.
const XLS_BYTES = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x01]);

let proj: string;

function put(name: string, data: string | Buffer): void {
  const path = join(documentsDir(proj, DEFAULT_SPACE), name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, data);
}

function add(): void {
  const result = onboard(proj, DEFAULT_SPACE, undefined, new Date().toISOString());
  expect(result.refused).toBeUndefined();
}

// `next`, then `continue <receipt>` through any rules parts, as the agent runs
// them: the step it acts on, which is where a line for the person is said.
function nextDirective(): Record<string, unknown> {
  let args = ["next"];
  for (let hop = 0; hop < 10; hop++) {
    const r = spawnSync(BUN, [ORCHESTRATE, ...args, "--project-dir", proj], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env: { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" },
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const line = out.split("\n").find((entry) => entry.startsWith("{"));
    expect(line, out).toBeDefined();
    const directive = JSON.parse(line as string) as Record<string, unknown>;
    if (directive.kind !== "load-steering") return directive;
    args = ["continue", String(directive.receipt ?? "")];
  }
  throw new Error("the rules parts did not reach the step in 10 hops");
}

function unreadLine(directive: Record<string, unknown>): string | undefined {
  return ((directive.change_notices as string[] | undefined) ?? []).find((line) => line.startsWith(LEAD));
}

async function doctorRow(): Promise<string | undefined> {
  const report = await collectDoctorReport(proj);
  return report.checks.find((check) => check.label.includes(LEAD) || check.label.startsWith("Documents AI-DLC's knowledge base"))?.label;
}

describe("t-knowledge-unread-line: documents the agents cannot read are named once per work, and by doctor", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
  });
  afterEach(() => cleanupTestProject(proj));

  test("a file never added is named once by the next step, with the way to add it, and not by the step after", () => {
    seedStateFile(proj, "state-mid-ideation.md");
    seedAidlcMemory(proj);
    put("rules.md", "# Refund rules\n\nRefunds close after 14 days.\n");
    const first = unreadLine(nextDirective());
    expect(first).toBeDefined();
    expect(first).toContain('"rules.md"');
    expect(first).toContain('"rules.md" is not in the knowledge base yet.');
    expect(first).toContain("knowledge sync` to add it.");
    expect(first).toContain("knowledge sync");
    // Plain words: no state name from the catalog.
    expect(first).not.toMatch(/unsupported_type|extractor_unavailable|extraction_failed|no_extractable_text|invalidated/);
    expect(unreadLine(nextDirective())).toBeUndefined();
  });

  test("an added spreadsheet with no reader is named once with what to do, and a new one later is named alone", () => {
    seedStateFile(proj, "state-mid-ideation.md");
    seedAidlcMemory(proj);
    put("mapping.xls", XLS_BYTES);
    add();
    expect(unreadDocuments(proj, DEFAULT_SPACE)).toEqual([{ path: "documents/mapping.xls", reason: "no-reader" }]);
    const first = unreadLine(nextDirective());
    expect(first).toContain('"mapping.xls"');
    expect(first).toContain(".csv");
    expect(unreadLine(nextDirective())).toBeUndefined();
    put("codes.xls", Buffer.concat([XLS_BYTES, Buffer.from([0x01])]));
    const later = unreadLine(nextDirective());
    expect(later).toContain('"codes.xls"');
    expect(later).not.toContain('"mapping.xls"');
  });

  test("a Word or Excel file added before AI-DLC read them is named as one the next sync reads", () => {
    seedStateFile(proj, "state-mid-ideation.md");
    seedAidlcMemory(proj);
    put("spec.docx", readFileSync(join(FIXTURES_DIR, "documents", "spec.docx")));
    put("mapping.xlsx", readFileSync(join(FIXTURES_DIR, "documents", "mapping.xlsx")));
    add();
    // What the index held for these before AI-DLC read them: Word recognised but not read, Excel not recognised.
    const index = readIndex(proj, DEFAULT_SPACE);
    for (const entry of index.documents) {
      entry.extraction = { state: "unsupported_type", detectedType: entry.source.path.endsWith(".docx") ? WORD_DOCX_MIME : "application/octet-stream" };
      delete entry.content;
      delete entry.content_sha256;
    }
    writeIndex(proj, DEFAULT_SPACE, index);
    expect(unreadDocuments(proj, DEFAULT_SPACE).map((file) => file.reason)).toEqual(["office", "office"]);
    const line = unreadLine(nextDirective());
    expect(line).toContain("were added before AI-DLC could read Word and Excel files.");
    expect(line).toContain("knowledge sync` to add them.");
  });

  test("a PDF added when this computer had no PDF reader is named as one the next sync reads", () => {
    seedStateFile(proj, "state-mid-ideation.md");
    seedAidlcMemory(proj);
    put("handbook.pdf", readFileSync(join(FIXTURES_DIR, "documents", "pdf-libreoffice.pdf")));
    add();
    // What the index held for it before AI-DLC read a PDF itself: no pdftotext on the computer.
    const index = readIndex(proj, DEFAULT_SPACE);
    for (const entry of index.documents) {
      entry.extraction = { state: "extractor_unavailable", extractor: { name: "pdftotext" }, detectedType: "application/pdf" };
      delete entry.content;
      delete entry.content_sha256;
    }
    writeIndex(proj, DEFAULT_SPACE, index);
    expect(unreadDocuments(proj, DEFAULT_SPACE)).toEqual([{ path: "documents/handbook.pdf", reason: "pdf" }]);
    const line = unreadLine(nextDirective());
    expect(line).toContain("was added before AI-DLC could read a PDF without pdftotext.");
    expect(line).not.toContain("install");
    expect(line).toContain("knowledge sync` to add it.");
  });

  test("a folder where everything is readable says nothing, and doctor shows no row", async () => {
    seedStateFile(proj, "state-mid-ideation.md");
    seedAidlcMemory(proj);
    put("rules.md", "# Refund rules\n");
    add();
    expect(unreadDocuments(proj, DEFAULT_SPACE)).toEqual([]);
    expect(unreadLine(nextDirective())).toBeUndefined();
    expect(await doctorRow()).toBeUndefined();
  });

  test("doctor's row names the same files as the line, every time it is asked", async () => {
    seedStateFile(proj, "state-mid-ideation.md");
    seedAidlcMemory(proj);
    put("mapping.xls", XLS_BYTES);
    add();
    put("rules.md", "# Refund rules\n");
    const line = unreadLine(nextDirective()) as string;
    const row = (await doctorRow()) as string;
    for (const name of ['"mapping.xls"', '"rules.md"']) {
      expect(line).toContain(name);
      expect(row).toContain(name);
    }
    expect(await doctorRow()).toBe(row);
  });

  test("before the work exists nothing is said or kept, so the first step of the work says it", () => {
    put("rules.md", "# Refund rules\n");
    expect(unreadDocumentsNotice(proj)).toBeNull();
    seedStateFile(proj, "state-mid-ideation.md");
    const notice = unreadDocumentsNotice(proj);
    expect(notice?.line).toContain('"rules.md"');
    markUnreadDocumentsSaid(proj, notice!);
    expect(unreadDocumentsNotice(proj)).toBeNull();
  });

  test("a spreadsheet saved as .csv or .md beside it, as the line asks, is read through that copy", () => {
    seedStateFile(proj, "state-mid-ideation.md");
    put("mapping.xls", XLS_BYTES);
    put("mapping-Rules.csv", "Section,Rule\n4.1,Second approver over 5000\n");
    put("sub/codes.xls", Buffer.concat([XLS_BYTES, Buffer.from([0x02])]));
    put("codes.md", "| Code |\n");
    add();
    // The copy beside mapping.xls covers it; codes.md is in another folder, so sub/codes.xls is still named.
    expect(unreadDocuments(proj, DEFAULT_SPACE)).toEqual([{ path: "documents/sub/codes.xls", reason: "no-reader" }]);
  });
});
