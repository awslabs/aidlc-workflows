// Names no machine record holds (a company, a customer, a product) are found by
// the model and confirmed by the person; hide.ts adds them to the redaction map
// so that safe.json is cleaned and check.ts catches them in the report.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// AI-DLC's words as collect.ts keeps them for the check (local/vocab.json).
function useWords(out: string, words: string[]) {
  writeFileSync(join(out, "local", "vocab.json"), JSON.stringify({ words }));
}

const SCRIPTS = resolve(import.meta.dir, "../../core/skills/aidlc-issue-report/scripts");
// The AI-DLC secret rules collect.ts would have found in the project's install.
const RULES = `${import.meta.dir}/../../core/tools/aidlc-doctor-bundle.ts`; // rules-path

function bun(script: string, args: string[]) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: "utf8" });
}

function reportFolder(): string {
  const out = mkdtempSync(join(tmpdir(), "hide-test-"));
  mkdirSync(join(out, "local"));
  writeFileSync(join(out, "local", "vocab.json"), JSON.stringify({ words: [] }));
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
  // The note itself is not one of the skill's sentences, which the check refuses on its own; here only the cover counts.
  expect(JSON.parse(c.stdout).hits.filter((h: { file: string }) => h.file === "aidlc-issue-report.md")).toEqual([
    { file: "aidlc-issue-report.md", line: 1, reason: "a name in the redaction map (write <customer-1>)" },
  ]);
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

test("a one-word name that is also an ordinary word or part of AI-DLC's words is not hidden, and says which and why", () => {
  const out = reportFolder();
  useWords(out, ["BOLT_FAILED", "units-generation", "acme-aidlc-plugins"]);
  writeFileSync(join(out, "safe.json"), JSON.stringify({ audit: { counts: { BOLT_FAILED: 1 } } }, null, 2));
  const r = JSON.parse(
    bun("hide.ts", ["--out", out, "--kind", "customer", "--name", "Bolt", "--kind", "org", "--name", "Acme", "--kind", "person", "--name", "Will"]).stdout,
  );
  expect(r).toMatchObject({
    ok: true,
    added: 0,
    hiddenNames: [],
    notHidden: [
      { name: 1, label: "<customer-1>", why: "ordinary-word" },
      { name: 2, label: "<org-1>", why: "aidlc-word" },
      { name: 3, label: "<person-1>", why: "ordinary-word" },
    ],
  });
  expect(r.next).toContain("--everywhere");
  expect(readFileSync(join(out, "safe.json"), "utf8")).toContain("BOLT_FAILED");
});

// A project with a Kiro tree whose AI-DLC words hold `Bolt` and `Stage`, and one intent's audit rows.
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "hide-project-"));
  const files: Record<string, string> = {
    ".kiro/tools/aidlc-state.ts": `const E = ["BOLT_FAILED", "BOLT_STARTED", "STAGE_JUMPED", "code-generation", "requirements-analysis", "Stage", "Source", "Target"];`,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const data = join(dir, ".kiro", "tools", "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "harness.json"), JSON.stringify({ name: "kiro" }));
  const sha = (t: string) => `sha256:${createHash("sha256").update(t).digest("hex")}`;
  writeFileSync(join(data, "aidlc-manifest.json"), JSON.stringify({ files: Object.fromEntries(Object.entries(files).map(([f, t]) => [f, sha(t)])) }));
  const audit = join(dir, "aidlc", "spaces", "default", "intents", "i1", "audit");
  mkdirSync(audit, { recursive: true });
  const t = (m: number) => new Date(Date.now() - (60 - m) * 60_000).toISOString();
  const row = (m: number, event: string, fields: string) => `## Row\n**Timestamp**: ${t(m)}\n**Event**: ${event}\n${fields}\n\n---\n\n`;
  writeFileSync(
    join(audit, "a.md"),
    `# AI-DLC Audit Log\n\n${row(1, "BOLT_STARTED", "**Stage**: code-generation")}${row(2, "BOLT_FAILED", "**Stage**: code-generation")}${row(3, "STAGE_JUMPED", "**Source**: requirements-analysis\n**Target**: code-generation")}`,
  );
  return dir;
}

const collectFrom = (from: string, ...more: string[]) => JSON.parse(bun("collect.ts", ["--from", from, "--no-doctor", ...more]).stdout);

test("a name the person still wants hidden goes into a new report collected out of AI-DLC's words, which passes the check", () => {
  const dir = project();
  const c = JSON.parse(bun("collect.ts", ["--project", dir, "--no-doctor", "--days", "1"]).stdout);
  expect(c.ok).toBe(true);
  const out = c.out as string;
  expect(readFileSync(join(out, "safe.json"), "utf8")).toContain("BOLT_FAILED");
  const first = JSON.parse(bun("hide.ts", ["--out", out, "--kind", "customer", "--name", "Bolt", "--kind", "org", "--name", "Stage"]).stdout);
  expect(first.notHidden).toHaveLength(2);
  const r = JSON.parse(bun("hide.ts", ["--out", out, "--everywhere", "--kind", "customer", "--name", "Bolt", "--kind", "org", "--name", "Stage"]).stdout);
  expect({ ok: r.ok, added: r.added }).toEqual({ ok: true, added: 2 });
  expect(r.next).toContain("--from");
  // Meanwhile this folder is checked without those AI-DLC words: an audit row's event holding a name is refused.
  const meanwhile = JSON.parse(bun("check.ts", ["--out", out]).stdout).hits.map((h: { field?: string }) => h.field ?? "");
  expect(meanwhile.some((f: string) => /^safe\.audit\.rows\[\d+\]\.event$/.test(f))).toBe(true);
  const n = collectFrom(out);
  expect(n.ok).toBe(true);
  expect(n.out).not.toBe(out);
  const safe = readFileSync(join(n.out, "safe.json"), "utf8");
  expect(safe).not.toMatch(/bolt|stage_jumped|"stage"/i);
  // Each event its own label: three rows, three events; the window is the earlier report's.
  const s2 = JSON.parse(safe);
  expect(new Set((s2.audit.rows as { event: string }[]).map((x) => x.event)).size).toBe(3);
  expect(s2.window.since).toBe(JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).window.since);
  expect(bun("cover.ts", ["--out", n.out]).status).toBe(0);
  expect(JSON.parse(bun("check.ts", ["--out", n.out]).stdout).hits).toEqual([]);
  // The earlier folder stays until it is discarded.
  expect(existsSync(out)).toBe(true);
  expect(JSON.parse(bun("finish.ts", ["--discard", "--out", out]).stdout).ok).toBe(true);
  expect(existsSync(out)).toBe(false);
  expect(JSON.parse(bun("hide.ts", ["--out", n.out, "--kind", "customer", "--name", "Bolt"]).stdout).notHidden).toBeUndefined();
  // Asked again in the new report, it needs no other one: its words no longer hold the name.
  expect(JSON.parse(bun("hide.ts", ["--out", n.out, "--everywhere", "--kind", "customer", "--name", "Bolt"]).stdout).next).toBeUndefined();
});

test("a new report from an earlier one keeps two labels for two names and the person's tool answer; discard leaves another file's folder", () => {
  const dir = project();
  const out = JSON.parse(bun("collect.ts", ["--project", dir, "--no-doctor", "--days", "1"]).stdout).out as string;
  expect(bun("set-version.ts", ["--out", out, "--tool", "kiro-cli", "--version", "2.37.0"]).status).toBe(0);
  const r = JSON.parse(bun("hide.ts", ["--out", out, "--everywhere", "--kind", "customer", "--name", "Zenith", "--kind", "customer", "--name", "Initech"]).stdout);
  expect(new Set(r.hiddenNames).size).toBe(r.hiddenNames.length);
  const anyway = JSON.parse(readFileSync(join(out, "local", "hide-anyway.json"), "utf8")) as { label: string }[];
  expect(new Set(anyway.map((e) => e.label)).size).toBe(anyway.length);
  const n = collectFrom(out);
  expect(JSON.parse(readFileSync(join(n.out, "safe.json"), "utf8")).environment.tools["kiro-cli"]).toEqual({ version: "2.37.0", source: "person" });
  writeFileSync(join(out, "notes.txt"), "mine");
  expect(JSON.parse(bun("finish.ts", ["--discard", "--out", out]).stdout).reason).toBe("folder-holds-other-files");
  expect(readFileSync(join(out, "notes.txt"), "utf8")).toBe("mine");
  rmSync(join(out, "notes.txt"));
  writeFileSync(join(out, ".DS_Store"), "");
  expect(JSON.parse(bun("finish.ts", ["--discard", "--out", out]).stdout).ok).toBe(true);
});

test("a report whose project moved is collected from only with the project's folder now", () => {
  const dir = project();
  const out = JSON.parse(bun("collect.ts", ["--project", dir, "--no-doctor", "--days", "1"]).stdout).out as string;
  bun("hide.ts", ["--out", out, "--kind", "customer", "--name", "Contoso"]);
  renameSync(dir, `${dir}-moved`);
  const moved = out.replace(dir, `${dir}-moved`);
  expect(collectFrom(moved).reason).toBe("project-not-found");
  const n = collectFrom(moved, "--project", `${dir}-moved`);
  expect(n.ok).toBe(true);
  expect(JSON.parse(readFileSync(join(n.out, "safe.json"), "utf8")).audit.rows).toHaveLength(3);
  // The names the person hid go along.
  const map = JSON.parse(readFileSync(join(n.out, "local", "redaction-map.json"), "utf8")).entries as { value: string }[];
  expect(map.some((e) => e.value === "Contoso")).toBe(true);
  // The old project path stays hidden too.
  expect(map.some((e) => e.value === dir)).toBe(true);
});

test("a hidden name that is also a label kind is kept out of the cover's label counts too", () => {
  const out = reportFolder();
  useWords(out, []);
  writeFileSync(join(out, "safe.json"), JSON.stringify({ environment: { tools: {} }, trees: [{ row: "<custom-mode-1>" }] }, null, 2));
  bun("hide.ts", ["--out", out, "--kind", "product", "--name", "Product", "--kind", "org", "--name", "Mode"]);
  expect(bun("cover.ts", ["--out", out]).status).toBe(0);
  const cover = readFileSync(join(out, "aidlc-issue-report.md"), "utf8");
  expect(cover.replace(/<[^>]+>/g, "")).not.toMatch(/\bproduct\b|\bmode\b/i);
  // A label that hiding put into a count line is counted too.
  expect(cover).toMatch(/^- org: 1$/m);
  expect(JSON.parse(bun("check.ts", ["--out", out]).stdout).hits.filter((h: { file: string }) => h.file === "aidlc-issue-report.md")).toEqual([]);
});

test("a name inside the fixed text of an AI-DLC message is said not hidden, asked about, and the text kept", () => {
  const out = reportFolder();
  const phrase = "Run the Atlas checks again before the stage";
  writeFileSync(join(out, "local", "vocab.json"), JSON.stringify({ words: [], phrases: [phrase, "Retry the Zenith step after the gate"], stages: [] }));
  writeFileSync(join(out, "safe.json"), JSON.stringify({ knownGaps: [phrase] }, null, 2));
  // Zenith's phrase is not in this report: the check reads every kept phrase, and so does this test.
  const r = JSON.parse(bun("hide.ts", ["--out", out, "--kind", "product", "--name", "Atlas", "--kind", "product", "--name", "Zenith"]).stdout);
  expect({ added: r.added, why: r.notHidden.map((n: { why: string }) => n.why) }).toEqual({ added: 0, why: ["aidlc-word", "aidlc-word"] });
  const map = JSON.parse(readFileSync(join(out, "local", "redaction-map.json"), "utf8")).entries as { value: string; kind: string }[];
  expect(map.find((e) => e.value === "Atlas")?.kind).toBe("report-only");
  expect(JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).knownGaps).toEqual([phrase]);
});

test("the cover's own words never carry a hidden name, so the check never refuses what cover.ts wrote", () => {
  const out = reportFolder();
  useWords(out, []);
  writeFileSync(join(out, "safe.json"), JSON.stringify({ environment: { tools: {} } }, null, 2));
  bun("hide.ts", ["--out", out, "--kind", "product", "--name", "Hook", "--kind", "product", "--name", "Safe", "--kind", "product", "--name", "Run Data"]);
  expect(bun("cover.ts", ["--out", out]).status).toBe(0);
  const cover = readFileSync(join(out, "aidlc-issue-report.md"), "utf8");
  expect(cover).not.toMatch(/\bhook\b|safe\.json|run data/i);
  // The labels the cover's own words got are counted too.
  expect(cover).toContain("- product: 3");
  const hits = JSON.parse(bun("check.ts", ["--out", out]).stdout).hits.filter((h: { file: string }) => h.file === "aidlc-issue-report.md");
  expect(hits).toEqual([]);
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
  useWords(out, ["acme-aidlc-plugins", "BOLT_FAILED"]);
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
