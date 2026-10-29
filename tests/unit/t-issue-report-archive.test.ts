// The doctor export is unpacked into local/ only to read its findings, and is
// never sent: the check (lib-check.ts) sends only the report and safe.json, and
// reading a folder never follows a link out of it.

import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractArchive, walkFiles } from "../../core/skills/aidlc-issue-report/scripts/lib-archive.ts";

// The AI-DLC secret rules collect.ts would have found in the project's install.
const RULES = `${import.meta.dir}/../../core/tools/aidlc-doctor-bundle.ts`; // rules-path
const SCRIPTS = resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts");

test("an archive unpacks into the folder it is given", () => {
  const src = mkdtempSync(join(tmpdir(), "archive-src-"));
  mkdirSync(join(src, "r"));
  writeFileSync(join(src, "r", "report.json"), "{}");
  const archive = join(mkdtempSync(join(tmpdir(), "archive-out-")), "a.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", src, "r"]);
  const into = mkdtempSync(join(tmpdir(), "archive-into-"));
  extractArchive(archive, into);
  expect(walkFiles(into).map((f) => f.slice(into.length + 1))).toEqual([join("r", "report.json")]);
});

test.skipIf(process.platform === "win32")("walking a folder does not follow a link out of it", () => {
  const outside = mkdtempSync(join(tmpdir(), "archive-outside-"));
  writeFileSync(join(outside, "secret.txt"), "x");
  const dir = mkdtempSync(join(tmpdir(), "archive-walk-"));
  writeFileSync(join(dir, "a.txt"), "a");
  symlinkSync(outside, join(dir, "link"));
  expect(walkFiles(dir).map((f) => f.slice(dir.length + 1))).toEqual(["a.txt"]);
});

function reportFolder(): string {
  const out = mkdtempSync(join(tmpdir(), "archive-check-"));
  mkdirSync(join(out, "local"));
  writeFileSync(join(out, "local", "redaction-map.json"), JSON.stringify({ entries: [{ value: "/tmp/p", label: "<project>", kind: "path" }], secretRulesFrom: RULES }));
  writeFileSync(join(out, "safe.json"), "{}\n");
  writeFileSync(join(out, "aidlc-issue-report.md"), "# AI-DLC issue report\n\nNothing looked wrong.\n");
  return out;
}

const check = (out: string) => {
  const c = spawnSync(process.execPath, [join(SCRIPTS, "check.ts"), "--out", out], { encoding: "utf8" });
  return { status: c.status, result: JSON.parse(c.stdout) };
};
const named = (out: string, value: string) =>
  writeFileSync(join(out, "local", "redaction-map.json"), JSON.stringify({ entries: [{ value, label: "<customer-1>", kind: "named" }], secretRulesFrom: RULES }));

test("a folder with the report and safe.json, both clean, passes", () => {
  expect(check(reportFolder())).toEqual({ status: 0, result: { ok: true, checked: ["safe.json", "aidlc-issue-report.md"], hits: [], allowedValues: 0 } });
});

test("a folder with no report yet does not pass", () => {
  const out = reportFolder();
  rmSync(join(out, "aidlc-issue-report.md"));
  const { status, result } = check(out);
  expect(status).toBe(1);
  expect(result.missing).toBe("aidlc-issue-report.md is not written yet");
});

test("the check refuses an archive, or any file but the report and safe.json, text or not", () => {
  const out = reportFolder();
  writeFileSync(join(out, "aidlc-doctor-report.tar.gz"), "not really an archive");
  writeFileSync(join(out, "notes.txt"), Buffer.from([0xc3, 0x28, 0x41]));
  writeFileSync(join(out, "contoso-notes.md"), "nothing here\n");
  const { status, result } = check(out);
  expect(status).toBe(1);
  expect(result.refused).toEqual(["aidlc-doctor-report.tar.gz", "contoso-notes.md", "notes.txt"]);
});

test("the check reads safe.json's decoded strings, so an escape hides nothing", () => {
  const out = reportFolder();
  named(out, 'Contoso "West"');
  writeFileSync(join(out, "safe.json"), JSON.stringify({ note: 'a run for Contoso "West"' }));
  const { status, result } = check(out);
  expect(status).toBe(1);
  expect(result.hits.some((h: { file: string; field?: string }) => h.file === "safe.json" && h.field === "safe.note")).toBe(true);
});

test("an escaped secret's name in safe.json is read with its value", () => {
  const out = reportFolder();
  writeFileSync(join(out, "safe.json"), '{"note": {"pass\\u0077ord": "hunter22x"}}');
  const { status, result } = check(out);
  expect(status).toBe(1);
  expect(result.hits.some((h: { reason: string }) => h.reason === "a credential")).toBe(true);
});

test("a JSON file with a repeated key is refused, since parsing keeps only the last value", () => {
  const out = reportFolder();
  writeFileSync(join(out, "safe.json"), '{"x": "\\u0043ontoso", "x": "safe"}');
  const { status, result } = check(out);
  expect(status).toBe(1);
  expect(result.refused).toEqual(["safe.json (a key appears twice)"]);
});

test.skipIf(process.platform === "win32")("a link or a folder in the report folder is refused, not skipped", () => {
  const out = reportFolder();
  mkdirSync(join(out, "Contoso"));
  symlinkSync(mkdtempSync(join(tmpdir(), "archive-outside-")), join(out, "elsewhere"));
  const { status, result } = check(out);
  expect(status).toBe(1);
  expect(result.refused).toEqual(["Contoso (not a file)", "elsewhere (link)"]);
});

test("a value or a key in safe.json that is not AI-DLC's, the skill's, a label or a known shape is refused", () => {
  const out = reportFolder();
  writeFileSync(join(out, "local", "vocab.json"), JSON.stringify(["complete", "STAGE_STARTED"]));
  writeFileSync(join(out, "safe.json"), JSON.stringify({ intents: [{ status: "complete" }], audit: { counts: { STAGE_STARTED: 1, "<custom-event-1>": 2 } } }));
  expect(check(out).status).toBe(0);
  for (const json of ['{"intents": [{"status": "Contoso"}]}', '{"Contoso": {}}', '{"Contoso": []}', '{"audit": {"counts": {"Contoso": 1}}}', '{"password=hunter22x": {}}']) {
    writeFileSync(join(out, "safe.json"), json);
    expect(check(out).status).toBe(1);
  }
});

test("a long number after a secret's name is checked as written, before parsing shortens it", () => {
  const out = reportFolder();
  writeFileSync(join(out, "safe.json"), '{"note": {"password": 1000000000000000000000}}');
  expect(check(out).status).toBe(1);
});

test("the report is refused where it holds a hidden name, and passes with its label", () => {
  const out = reportFolder();
  named(out, "Contoso");
  writeFileSync(join(out, "aidlc-issue-report.md"), "The Contoso team saw the gate twice.\n");
  expect(check(out).result.hits).toEqual([{ file: "aidlc-issue-report.md", line: 1, reason: "a name in the redaction map (write <customer-1>)" }]);
  writeFileSync(join(out, "aidlc-issue-report.md"), "The <customer-1> team saw the gate twice.\n");
  expect(check(out).status).toBe(0);
});

test("a number written in another form in safe.json is refused, since parsing would shorten it", () => {
  const out = reportFolder();
  writeFileSync(join(out, "safe.json"), '{"audit": {"rowsTotal": 123456789000e-3}}');
  const { status, result } = check(out);
  expect(status).toBe(1);
  expect(result.refused).toEqual(["safe.json (a number that is long or written in another form)"]);
});

test("a folder whose safe.json is missing does not pass", () => {
  const out = reportFolder();
  rmSync(join(out, "safe.json"));
  const { status, result } = check(out);
  expect(status).toBe(1);
  expect(result.missing).toBe("safe.json is missing: put back the one collect.ts wrote");
});
