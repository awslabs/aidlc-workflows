// Names no machine record holds (a company, a customer, a product) are found by
// the model and confirmed by the person; hide.ts adds them to the redaction map
// so that safe.json is cleaned and check.ts catches them in the report.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPTS = resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts");
// The AI-DLC secret rules collect.ts would have found in the project's install.
const RULES = `${import.meta.dir}/../../core/tools/aidlc-doctor-bundle.ts`; // rules-path

function bun(script: string, args: string[]) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: "utf8" });
}

function reportFolder(): string {
  const out = mkdtempSync(join(tmpdir(), "hide-test-"));
  mkdirSync(join(out, "local"));
  writeFileSync(
    join(out, "local", "redaction-map.json"),
    JSON.stringify({ entries: [{ value: "/tmp/p", label: "<project>", kind: "path" }], secretRulesFrom: RULES }),
  );
  writeFileSync(join(out, "safe.json"), JSON.stringify({ note: "intent for Contoso Bank on PayFlow" }, null, 2));
  return out;
}

test("hidden names leave safe.json and are caught in the report", () => {
  const out = reportFolder();
  const r = bun("hide.ts", ["--out", out, "--kind", "customer", "--name", "Contoso Bank", "--kind", "product", "--name", "PayFlow"]);
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain("Contoso");
  const safe = readFileSync(join(out, "safe.json"), "utf8");
  expect(safe).not.toContain("Contoso");
  expect(safe).not.toContain("PayFlow");
  expect(safe).toContain("<customer-1>");
  expect(safe).toContain("<product-1>");

  writeFileSync(join(out, "aidlc-issue-report.md"), "The run for contoso bank stopped.\n");
  const c = bun("check.ts", ["--out", out]);
  expect(c.status).toBe(1);
  expect(c.stdout).not.toContain("contoso");
  expect(JSON.parse(c.stdout).hits).toEqual([{ file: "aidlc-issue-report.md", line: 1, reason: "a name in the redaction map (write <customer-1>)" }]);
});

test("refuses a folder collect.ts did not make", () => {
  const out = mkdtempSync(join(tmpdir(), "hide-test-"));
  const r = bun("hide.ts", ["--out", out, "--kind", "org", "--name", "Contoso"]);
  expect(r.status).not.toBe(0);
});

test("without AI-DLC's secret rules the check still refuses a credential by its own rules", () => {
  const out = reportFolder();
  writeFileSync(join(out, "local", "redaction-map.json"), JSON.stringify({ entries: [{ value: "/tmp/p", label: "<project>", kind: "path" }], secretRulesFrom: null }));
  writeFileSync(join(out, "safe.json"), "{}");
  writeFileSync(join(out, "aidlc-issue-report.md"), "nothing to hide here\n");
  expect(bun("check.ts", ["--out", out]).status).toBe(0);
  writeFileSync(join(out, "aidlc-issue-report.md"), "the log said password: hunter22x\n");
  expect(JSON.parse(bun("check.ts", ["--out", out]).stdout).hits.map((h: { reason: string }) => h.reason)).toEqual(["a credential"]);
});

test("a one-word name that is also an ordinary word or part of AI-DLC's words is not hidden, and says so", () => {
  const out = reportFolder();
  writeFileSync(join(out, "local", "vocab.json"), JSON.stringify(["BOLT_FAILED", "units-generation"]));
  writeFileSync(join(out, "safe.json"), JSON.stringify({ audit: { counts: { BOLT_FAILED: 1 } } }, null, 2));
  const r = JSON.parse(bun("hide.ts", ["--out", out, "--kind", "customer", "--name", "Bolt", "--kind", "product", "--name", "Units", "--kind", "person", "--name", "Will"]).stdout);
  expect(r).toMatchObject({ ok: true, added: 0, notHidden: 3 });
  expect(readFileSync(join(out, "safe.json"), "utf8")).toContain("BOLT_FAILED");
  const map = JSON.parse(readFileSync(join(out, "local", "redaction-map.json"), "utf8"));
  expect(map.skipped.map((e: { value: string }) => e.value)).toEqual(["Bolt", "Units", "Will"]);
});

test("a hidden name that is a key of a data map in safe.json is replaced too", () => {
  const out = reportFolder();
  writeFileSync(join(out, "safe.json"), JSON.stringify({ audit: { counts: { contoso: 2 } }, contoso: "field name, kept" }, null, 2));
  bun("hide.ts", ["--out", out, "--kind", "customer", "--name", "contoso"]);
  const safe = JSON.parse(readFileSync(join(out, "safe.json"), "utf8"));
  expect(Object.keys(safe.audit.counts)).toEqual(["<customer-1>"]);
});

test("a name the person hid that is only part of AI-DLC's words is refused in the report, and safe.json keeps AI-DLC's word", () => {
  const out = reportFolder();
  writeFileSync(join(out, "local", "vocab.json"), JSON.stringify(["acme-aidlc-plugins", "BOLT_FAILED"]));
  writeFileSync(join(out, "safe.json"), JSON.stringify({ audit: { counts: { BOLT_FAILED: 1 } } }, null, 2));
  const r = JSON.parse(bun("hide.ts", ["--out", out, "--kind", "customer", "--name", "Acme"]).stdout);
  expect(r.ok).toBe(true);
  writeFileSync(join(out, "aidlc-issue-report.md"), "The Acme team saw the hook fail; acme-aidlc-plugins was on.\n");
  const hits = JSON.parse(bun("check.ts", ["--out", out]).stdout).hits;
  expect(hits.map((h: { line: number; reason: string }) => h.line)).toEqual([1]);
  writeFileSync(join(out, "aidlc-issue-report.md"), "The <customer-1> team saw it; acme-aidlc-plugins was on.\n");
  expect(bun("check.ts", ["--out", out]).status).toBe(0);
});

test("a name the map already hides is answered with the label it has", () => {
  const out = reportFolder();
  const r = bun("hide.ts", ["--out", out, "--kind", "customer", "--name", "/tmp/p"]);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).alreadyHidden).toEqual(["<project>"]);
});

test("a name given twice in one call is added once and not called already hidden", () => {
  const out = reportFolder();
  const r = bun("hide.ts", ["--out", out, "--kind", "customer", "--name", "Contoso", "--kind", "customer", "--name", "CONTOSO"]);
  expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, added: 1 });
  expect(JSON.parse(r.stdout).alreadyHidden).toBeUndefined();
});

test("every script that takes a report folder refuses a file or a missing --out instead of failing", () => {
  const out = reportFolder();
  const file = join(out, "safe.json");
  for (const [script, args] of [
    ["check.ts", []],
    ["check.ts", ["--out", file]],
    ["allow.ts", ["--out", file, "--value", "two words"]],
    ["hide.ts", ["--out", file, "--name", "Contoso"]],
    ["set-version.ts", ["--out", file, "--tool", "claude", "--version", "1.2.3"]],
    ["finish.ts", ["--out", file, "--no-open"]],
  ] as const) {
    const r = bun(script, [...args]);
    expect([script, ...args, r.status, JSON.parse(r.stdout).ok]).toEqual([script, ...args, 2, false]);
  }
});

test("collect.ts refuses an --out that names a file", () => {
  const out = reportFolder();
  const project = mkdtempSync(join(tmpdir(), "hide-project-"));
  mkdirSync(join(project, "aidlc", "spaces", "default"), { recursive: true });
  const r = bun("collect.ts", ["--project", project, "--out", join(out, "safe.json"), "--no-doctor"]);
  expect(r.status).toBe(2);
  expect(JSON.parse(r.stdout).reason).toBe("out-not-a-folder");
});

test("a name kept as one of AI-DLC's words is not said to be hidden", () => {
  const out = reportFolder();
  const map = join(out, "local", "redaction-map.json");
  const dict = JSON.parse(readFileSync(map, "utf8"));
  dict.entries.push({ value: "Acme", label: "<customer-1>", kind: "report-only" });
  writeFileSync(map, JSON.stringify(dict));
  expect(JSON.parse(bun("hide.ts", ["--out", out, "--kind", "customer", "--name", "Acme"]).stdout).alreadyHidden).toBeUndefined();
});

test("check.ts says a stray folder is not a report folder, not that it was finished", () => {
  const dir = mkdtempSync(join(tmpdir(), "stray-"));
  writeFileSync(join(dir, "aidlc-issue-report.md"), "# notes");
  const r = bun("check.ts", ["--out", dir]);
  expect(JSON.parse(r.stdout).reason).toContain("is not a report folder made by collect.ts");
});
