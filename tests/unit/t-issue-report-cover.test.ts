// cover.ts: the cover the person reads before sending, written from safe.json alone. It says which tool the person
// named, counts each distinct label once, and passes the folder's check as written.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// AI-DLC's words as collect.ts keeps them for the check (local/vocab.json).
function useWords(out: string, words: string[]) {
  writeFileSync(join(out, "local", "vocab.json"), JSON.stringify({ words }));
}

const SCRIPTS = resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts");
// The AI-DLC install whose own rules the skill borrows (secret rules, file match, copied shards).
const RULES = `${import.meta.dir}/../../core/tools/aidlc-doctor-bundle.ts`; // rules-path

function folder(safe: object): string {
  const out = mkdtempSync(join(tmpdir(), "cover-"));
  mkdirSync(join(out, "local"));
  writeFileSync(join(out, "local", "vocab.json"), JSON.stringify({ words: [] }));
  writeFileSync(join(out, "local", "redaction-map.json"), JSON.stringify({ entries: [{ value: "/tmp/p", label: "<project>", kind: "path" }], secretRulesFrom: RULES }));
  writeFileSync(join(out, "safe.json"), JSON.stringify(safe));
  useWords(out, ["UNIT_STARTED"]);
  return out;
}
const run = (script: string, out: string) => spawnSync(process.execPath, [join(SCRIPTS, script), "--out", out], { encoding: "utf8" });

test("the cover names a tool the person named, counts each label once, and passes the check", () => {
  const out = folder({
    window: { since: "2026-10-29T00:00:00.000Z", until: "2026-10-30T00:00:00.000Z", lastAidlcActivity: null, notes: [] },
    environment: { os: "darwin 25.6.0 arm64", tools: { "kiro-ide": { version: "1.4.13", source: "person" } }, toolsUsed: ["kiro-ide"], toolsNamed: ["kiro-ide"], versionsMissing: [] },
    trees: [],
    intents: [],
    audit: { rows: [{ seq: 1, ts: null, event: "UNIT_STARTED", intent: "<intent-1>", fields: [["Unit", "<unit-1>"], ["Context", "<custom-unit-2> > <custom-unit-1>"]] }] },
    transcripts: [],
    doctor: { ran: false, findings: [], note: "skipped (--no-doctor)" },
    hooks: { drops: [] },
    knownGaps: ["<project>"],
  });
  expect(run("cover.ts", out).status).toBe(0);
  const cover = readFileSync(join(out, "aidlc-issue-report.md"), "utf8");
  expect(cover).toContain("- kiro-ide: 1.4.13 (from the person) (named by the person; no chat log showed the run in it)");
  // `<unit-1>` (the redaction map's) and `<custom-unit-1>` (a row's) are two Units.
  expect(cover).toContain("- unit: 3");
  // A label with no number stands for every value of its kind, so it has no count.
  expect(cover).toContain("- project: one label for every value");
  const check = run("check.ts", out);
  expect([check.status, JSON.parse(check.stdout).hits]).toEqual([0, []]);
});

test("a tool the person named whose chat log held only this report is not said to have no chat log read, and passes the check", () => {
  const out = folder({
    window: { since: "2026-10-29T00:00:00.000Z", until: "2026-10-30T00:00:00.000Z", lastAidlcActivity: null, notes: [] },
    environment: { os: "darwin 25.6.0 arm64", tools: { "kiro-ide": { version: null, source: "person" } }, toolsUsed: ["kiro-ide"], toolsNamed: ["kiro-ide"], versionsMissing: [] },
    trees: [],
    intents: [],
    audit: { rows: [] },
    transcripts: [{ tool: "kiro (v3: Kiro IDE)", sessions: 1, reportSessions: 1, mixedSessions: 0, events: [] }],
    doctor: { ran: false, findings: [], note: "skipped (--no-doctor)" },
    hooks: { drops: [] },
    knownGaps: [],
  });
  expect(run("cover.ts", out).status).toBe(0);
  const cover = readFileSync(join(out, "aidlc-issue-report.md"), "utf8");
  expect(cover).toContain("- kiro-ide: not found (named by the person; no chat log showed the run in it)");
  expect(cover).toContain("- kiro (v3: Kiro IDE): 0 session(s) of the run, 1 that only made this report, 0 events");
  expect(cover).not.toContain("no chat log of it was read");
  const check = run("check.ts", out);
  expect([check.status, JSON.parse(check.stdout).hits]).toEqual([0, []]);
});

test("an entry holding its own line break is one cover line, so a line taken out is the entry that held the name", () => {
  const out = folder({ environment: { tools: {} }, knownGaps: ["The first part\nand the second part", "A third\rand a fourth\u2028and a fifth"] });
  expect(run("cover.ts", out).status).toBe(0);
  const cover = readFileSync(join(out, "aidlc-issue-report.md"), "utf8");
  expect(cover).toContain("- The first part and the second part");
  expect(cover).toContain("- A third and a fourth and a fifth");
});
