// covers: function:readIntentRegistry, function:appendIntentToRegistry, function:writeIntentRegistry, function:updateIntentStatus
//
// The person edits the list of work by hand (AI-DLC's own rename and doctor
// lines send them to intents.json). What an editor commonly leaves, a trailing
// comma, a comment or a BOM, still reads as every row, and new work keeps them.
// A list nothing can read is never written over: it is kept byte for byte
// under a new name beside the new list, and the person hears once where.

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendIntentToRegistry,
  pendingPersonLines,
  readIntentRegistry,
  updateIntentStatus,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject, DEFAULT_INTENT_UUID, DEFAULT_RECORD_DIR, intentsDirOf } from "../harness/fixtures.ts";

const SESSION = "01995100-0000-7000-8000-00000000c0f2";
const REPORTS = { uuid: "01a133cc-c1f4-7a5c-93b1-43f58eeb82c3", slug: "reports", dirName: "261024-reports", scope: "feature", status: "in-flight" };

let proj = "";
afterEach(() => {
  cleanupTestProject(proj);
  proj = "";
});

const registry = () => join(intentsDirOf(proj), "intents.json");
const keptCopies = () => readdirSync(intentsDirOf(proj)).filter((name) => name.startsWith("intents.json.unreadable-"));
const uuids = () => readIntentRegistry(proj, "default").map((entry) => entry.uuid).sort();

function seededRow(): string {
  return JSON.stringify({ uuid: DEFAULT_INTENT_UUID, slug: "fixture", dirName: DEFAULT_RECORD_DIR, status: "in-flight" }, null, 2);
}

const HAND_EDITS: Array<[string, () => string]> = [
  ["a trailing comma", () => `[\n${seededRow()},\n]\n`],
  ["a comment", () => `// the list of work\n[\n${seededRow()}\n]\n`],
  ["a BOM", () => `\uFEFF[\n${seededRow()}\n]\n`],
  ["Windows line ends and a trailing comma", () => `[\n${seededRow()},\n]\n`.replace(/\n/g, "\r\n")],
];

function withSession<T>(run: () => T): T {
  const saved = { override: process.env.AIDLC_SESSION_OVERRIDE, source: process.env.AIDLC_SESSION_OVERRIDE_SOURCE };
  process.env.AIDLC_SESSION_OVERRIDE = SESSION;
  process.env.AIDLC_SESSION_OVERRIDE_SOURCE = "payload";
  try {
    return run();
  } finally {
    if (saved.override === undefined) delete process.env.AIDLC_SESSION_OVERRIDE;
    else process.env.AIDLC_SESSION_OVERRIDE = saved.override;
    if (saved.source === undefined) delete process.env.AIDLC_SESSION_OVERRIDE_SOURCE;
    else process.env.AIDLC_SESSION_OVERRIDE_SOURCE = saved.source;
  }
}

describe("a list of work edited by hand", () => {
  for (const [edit, text] of HAND_EDITS) {
    test(`with ${edit} reads every row, and new work keeps them`, () => {
      proj = createTestProject();
      writeFileSync(registry(), text(), "utf-8");
      expect(uuids()).toEqual([DEFAULT_INTENT_UUID]);
      appendIntentToRegistry(proj, REPORTS, "default");
      const written = JSON.parse(readFileSync(registry(), "utf-8")) as Array<{ uuid: string }>;
      expect(written.map((entry) => entry.uuid).sort()).toEqual([DEFAULT_INTENT_UUID, REPORTS.uuid].sort());
      expect(keptCopies()).toEqual([]);
    });
  }

  test("that nothing can read is kept byte for byte under a new name, and the new list holds the new work", () => {
    proj = createTestProject();
    const broken = `[\n  {\n    "uuid": "${DEFAULT_INTENT_UUID}",\n    "slug": "fixture"\n]\n`;
    writeFileSync(registry(), broken, "utf-8");
    appendIntentToRegistry(proj, REPORTS, "default");
    expect(JSON.parse(readFileSync(registry(), "utf-8"))).toEqual([REPORTS]);
    const kept = keptCopies();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^intents\.json\.unreadable-\d{8}T\d{6}Z(-\d+)?$/);
    expect(readFileSync(join(intentsDirOf(proj), kept[0]), "utf-8")).toBe(broken);
  });

  test("with a row left after its closing bracket is kept whole, never read as its first part", () => {
    proj = createTestProject();
    const pasted = `[\n${seededRow()}\n]\n  ${JSON.stringify(REPORTS)},\n]\n`;
    writeFileSync(registry(), pasted, "utf-8");
    appendIntentToRegistry(proj, { ...REPORTS, uuid: "01a133cc-c2a0-7b11-8a22-5d1f2e3a4b5c", dirName: "261024-search" }, "default");
    const kept = keptCopies();
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(intentsDirOf(proj), kept[0]), "utf-8")).toBe(pasted);
  });

  test("that nothing can read, a second time, keeps both copies", () => {
    proj = createTestProject();
    writeFileSync(registry(), "[ { first", "utf-8");
    appendIntentToRegistry(proj, REPORTS, "default");
    writeFileSync(registry(), "[ { second", "utf-8");
    appendIntentToRegistry(proj, { ...REPORTS, uuid: "01a133cc-c2a0-7b11-8a22-5d1f2e3a4b5c", dirName: "261024-search" }, "default");
    const kept = keptCopies().map((name) => readFileSync(join(intentsDirOf(proj), name), "utf-8")).sort();
    expect(kept).toEqual(["[ { first", "[ { second"]);
  });

  test("that nothing can read: the person hears once where it was kept", () => {
    proj = createTestProject();
    writeFileSync(registry(), "[ {", "utf-8");
    const lines = withSession(() => {
      appendIntentToRegistry(proj, REPORTS, "default");
      return pendingPersonLines(proj, SESSION).lines;
    });
    const kept = keptCopies()[0];
    expect(lines).toEqual([
      `Your list of work, aidlc/spaces/default/intents/intents.json, could not be read, so it was kept as ` +
        `aidlc/spaces/default/intents/${kept}; the new list holds only the new work.`,
    ]);
  });

  test("that nothing can read is left as it is by a status change that finds no row", () => {
    proj = createTestProject();
    writeFileSync(registry(), "[ {", "utf-8");
    expect(updateIntentStatus(proj, DEFAULT_RECORD_DIR, "complete", "default")).toBe(false);
    expect(readFileSync(registry(), "utf-8")).toBe("[ {");
    expect(keptCopies()).toEqual([]);
  });
});
