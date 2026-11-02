// cover.ts: the cover the person reads before sending, written from safe.json alone. It says which tool the person
// named, counts each distinct label once, and passes the folder's check as written.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPTS = resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts");
// The AI-DLC install whose own rules the skill borrows (secret rules, file match, copied shards).
const RULES = `${import.meta.dir}/../../core/tools/aidlc-doctor-bundle.ts`; // rules-path

function folder(safe: object): string {
  const out = mkdtempSync(join(tmpdir(), "cover-"));
  mkdirSync(join(out, "local"));
  writeFileSync(join(out, "local", "redaction-map.json"), JSON.stringify({ entries: [{ value: "/tmp/p", label: "<project>", kind: "path" }], secretRulesFrom: RULES }));
  writeFileSync(join(out, "safe.json"), JSON.stringify(safe));
  // AI-DLC's words as collect.ts keeps them for the check.
  writeFileSync(join(out, "local", "vocab.json"), JSON.stringify(["UNIT_STARTED", "code-generation", "construction"]));
  writeFileSync(join(out, "local", "vocab-kinds.json"), JSON.stringify({ stages: ["code-generation"], phases: ["construction"] }));
  return out;
}
const run = (script: string, out: string) => spawnSync(process.execPath, [join(SCRIPTS, script), "--out", out], { encoding: "utf8" });

test("the cover names a tool the person named, counts each label once, and passes the check", () => {
  const out = folder({
    window: { since: "2026-10-29T00:00:00.000Z", until: "2026-10-30T00:00:00.000Z", lastAidlcActivity: null, notes: [] },
    environment: { os: "darwin 25.6.0 arm64", tools: { "kiro-ide": { version: "1.4.13", source: "person" } }, toolsUsed: ["kiro-ide"], toolsNamed: ["kiro-ide"], versionsMissing: [] },
    trees: [],
    intents: [],
    audit: { rows: [{ seq: 1, ts: null, event: "UNIT_STARTED", intent: "<intent-1>", fields: [["Unit", "<unit-1>"], ["Context", "construction > <custom-unit-1> > code-generation"]] }] },
    transcripts: [],
    doctor: { ran: false, findings: [], note: "skipped" },
    hooks: { drops: [] },
    knownGaps: [],
  });
  expect(run("cover.ts", out).status).toBe(0);
  const cover = readFileSync(join(out, "aidlc-issue-report.md"), "utf8");
  expect(cover).toContain("- kiro-ide: 1.4.13 (from the person) (named by the person; no chat log of it was read)");
  // `<unit-1>` (the redaction map's) and `<custom-unit-1>` (a row's) are two Units.
  expect(cover).toContain("- unit: 2");
  const check = run("check.ts", out);
  expect([check.status, JSON.parse(check.stdout).hits]).toEqual([0, []]);
});
