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
import { mkdirSync, writeFileSync } from "node:fs";
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
  resetAidlcEnv,
  seedAidlcMemory,
  seedStateFile,
} from "../harness/fixtures.ts";
import {
  documentsDir,
  markUnreadDocumentsSaid,
  onboard,
  unreadDocuments,
  unreadDocumentsNotice,
} from "../../core/tools/aidlc-knowledge.ts";
import { collectDoctorReport } from "../../core/tools/aidlc-utility.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LEAD = "AI-DLC's knowledge base cannot read";
// The zip signature and nothing an extractor knows: what onboard records for a spreadsheet.
const XLSX_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x01]);

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
    put("mapping.xlsx", XLSX_BYTES);
    add();
    expect(unreadDocuments(proj, DEFAULT_SPACE)).toEqual([{ path: "documents/mapping.xlsx", reason: "no-reader" }]);
    const first = unreadLine(nextDirective());
    expect(first).toContain('"mapping.xlsx"');
    expect(first).toContain(".csv");
    expect(unreadLine(nextDirective())).toBeUndefined();
    put("codes.xlsx", Buffer.concat([XLSX_BYTES, Buffer.from([0x01])]));
    const later = unreadLine(nextDirective());
    expect(later).toContain('"codes.xlsx"');
    expect(later).not.toContain('"mapping.xlsx"');
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
    put("mapping.xlsx", XLSX_BYTES);
    add();
    put("rules.md", "# Refund rules\n");
    const line = unreadLine(nextDirective()) as string;
    const row = (await doctorRow()) as string;
    for (const name of ['"mapping.xlsx"', '"rules.md"']) {
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
    put("mapping.xlsx", XLSX_BYTES);
    put("mapping-Rules.csv", "Section,Rule\n4.1,Second approver over 5000\n");
    put("sub/codes.xlsx", Buffer.concat([XLSX_BYTES, Buffer.from([0x02])]));
    put("codes.md", "| Code |\n");
    add();
    // The copy beside mapping.xlsx covers it; codes.md is in another folder, so sub/codes.xlsx is still named.
    expect(unreadDocuments(proj, DEFAULT_SPACE)).toEqual([{ path: "documents/sub/codes.xlsx", reason: "no-reader" }]);
  });
});
