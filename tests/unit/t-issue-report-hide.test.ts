// Names no machine record holds (a company, a customer, a product) are found by
// the model and confirmed by the person; hide.ts adds them to the redaction map
// so that safe.json is cleaned and check.ts catches them in the report.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LABEL, labelKind } from "../../core/skills/aidlc-issue-report/scripts/redact.ts";

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

// The names go in local/hide-names.json (local/hide-everywhere.json with --everywhere), as the agent writes them with its
// file tool; the command holds only the folder.
function hide(out: string, names: [string, string][], ...flags: string[]) {
  mkdirSync(join(out, "local"), { recursive: true });
  const file = flags.includes("--everywhere") ? "hide-everywhere.json" : "hide-names.json";
  writeFileSync(join(out, "local", file), JSON.stringify(names.map(([kind, name]) => ({ kind, name }))));
  return bun("hide.ts", ["--out", out, ...flags]);
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
  const r = hide(out, [["customer", "Contoso Bank"], ["product", "PayFlow"]]);
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
  const r = hide(out, [["org", "Contoso"]]);
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
    hide(out, [["customer", "Bolt"], ["org", "Acme"], ["person", "Will"]]).stdout,
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
  const first = JSON.parse(hide(out, [["customer", "Bolt"], ["org", "Stage"]]).stdout);
  expect(first.notHidden).toHaveLength(2);
  const r = JSON.parse(hide(out, [["customer", "Bolt"], ["org", "Stage"]], "--everywhere").stdout);
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
  expect(JSON.parse(hide(n.out, [["customer", "Bolt"]]).stdout).notHidden).toBeUndefined();
  // Asked again in the new report, it needs no other one: its words no longer hold the name.
  expect(JSON.parse(hide(n.out, [["customer", "Bolt"]], "--everywhere").stdout).next).toBeUndefined();
});

test("a new report from an earlier one keeps two labels for two names and the person's tool answer; discard leaves another file's folder", () => {
  const dir = project();
  const out = JSON.parse(bun("collect.ts", ["--project", dir, "--no-doctor", "--days", "1"]).stdout).out as string;
  writeFileSync(join(out, "local", "version-kiro-cli.json"), JSON.stringify({ version: "2.37.0" }));
  expect(bun("set-version.ts", ["--out", out, "--tool", "kiro-cli"]).status).toBe(0);
  const r = JSON.parse(hide(out, [["customer", "Zenith"], ["customer", "Initech"]], "--everywhere").stdout);
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
  hide(out, [["customer", "Contoso"]]);
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

test("an install whose AI-DLC words cannot be read says so, and its doctor severities still pass the check", () => {
  const dir = project();
  rmSync(join(dir, ".kiro", "tools", "data", "aidlc-manifest.json"));
  const c = JSON.parse(bun("collect.ts", ["--project", dir, "--no-doctor", "--days", "1"]).stdout);
  expect(c.found.aidlcWords).toBe(0);
  const safe = JSON.parse(readFileSync(join(c.out, "safe.json"), "utf8"));
  expect(safe.knownGaps.some((g: string) => g.startsWith("AI-DLC's own words could not be read"))).toBe(true);
  safe.doctor = { ran: true, exit: 0, findings: [{ id: "<custom-doctor-finding-1>", severity: "warning" }, { id: "<custom-doctor-finding-2>", severity: "info" }], checksFailed: 0, note: "" };
  writeFileSync(join(c.out, "safe.json"), JSON.stringify(safe, null, 2));
  expect(bun("cover.ts", ["--out", c.out]).status).toBe(0);
  expect(readFileSync(join(c.out, "aidlc-issue-report.md"), "utf8")).toContain("AI-DLC's own words could not be read");
  expect(JSON.parse(bun("check.ts", ["--out", c.out]).stdout).hits).toEqual([]);
});

test("a line left out of the cover never holds a hidden name itself", () => {
  const out = reportFolder();
  useWords(out, []);
  writeFileSync(join(out, "safe.json"), JSON.stringify({ environment: { tools: {} } }, null, 2));
  const map = JSON.parse(readFileSync(join(out, "local", "redaction-map.json"), "utf8"));
  map.entries.push({ value: "Paths And", label: "<org-1>", kind: "named" }, { value: "Here", label: "<org-2>", kind: "named" });
  writeFileSync(join(out, "local", "redaction-map.json"), JSON.stringify(map));
  expect(bun("cover.ts", ["--out", out]).status).toBe(0);
  expect(readFileSync(join(out, "aidlc-issue-report.md"), "utf8")).toContain("- (...)");
  expect(JSON.parse(bun("check.ts", ["--out", out]).stdout).hits.filter((h: { file: string }) => h.file === "aidlc-issue-report.md")).toEqual([]);
});

test("a hidden name that is also a label kind is kept out of the cover's label counts too", () => {
  const out = reportFolder();
  useWords(out, []);
  writeFileSync(join(out, "safe.json"), JSON.stringify({ environment: { tools: {} }, trees: [{ row: "<custom-mode-1>" }] }, null, 2));
  hide(out, [["product", "Product"], ["org", "Mode"]]);
  expect(bun("cover.ts", ["--out", out]).status).toBe(0);
  const cover = readFileSync(join(out, "aidlc-issue-report.md"), "utf8");
  expect(cover.replace(/<[^>]+>/g, "")).not.toMatch(/\bproduct\b|\bmode\b/i);
  // A count line whose kind word is a hidden name is left out, as any line of the cover.
  expect(cover).not.toMatch(/^- mode: /m);
  expect(JSON.parse(bun("check.ts", ["--out", out]).stdout).hits.filter((h: { file: string }) => h.file === "aidlc-issue-report.md")).toEqual([]);
});

test("a name inside the fixed text of an AI-DLC message is said not hidden, asked about, and the text kept", () => {
  const out = reportFolder();
  const phrase = "Run the Atlas checks again before the stage";
  writeFileSync(join(out, "local", "vocab.json"), JSON.stringify({ words: [], phrases: [phrase, "Retry the Zenith step after the gate"], stages: [] }));
  writeFileSync(join(out, "safe.json"), JSON.stringify({ knownGaps: [phrase] }, null, 2));
  // Zenith's phrase is not in this report: the check reads every kept phrase, and so does this test.
  const r = JSON.parse(hide(out, [["product", "Atlas"], ["product", "Zenith"]]).stdout);
  expect({ added: r.added, why: r.notHidden.map((n: { why: string }) => n.why) }).toEqual({ added: 0, why: ["aidlc-word", "aidlc-word"] });
  const map = JSON.parse(readFileSync(join(out, "local", "redaction-map.json"), "utf8")).entries as { value: string; kind: string }[];
  expect(map.find((e) => e.value === "Atlas")?.kind).toBe("report-only");
  expect(JSON.parse(readFileSync(join(out, "safe.json"), "utf8")).knownGaps).toEqual([phrase]);
});

test("the cover's own words never carry a hidden name, so the check never refuses what cover.ts wrote", () => {
  const out = reportFolder();
  useWords(out, []);
  writeFileSync(join(out, "safe.json"), JSON.stringify({ environment: { tools: {} } }, null, 2));
  hide(out, [["product", "Hook"], ["product", "Safe"], ["product", "Run Data"], ["org", "Paths And"]]);
  expect(bun("cover.ts", ["--out", out]).status).toBe(0);
  const cover = readFileSync(join(out, "aidlc-issue-report.md"), "utf8");
  expect(cover).not.toMatch(/\bhook\b|safe\.json|run data|paths\s+and/i);
  // A name the check finds across a line end takes those lines out.
  expect(cover).toContain("(A line here held a name the person hid, so it was left out.)");
  // The labels the cover's own words got are counted too.
  expect(cover).toContain("- product: 3");
  const hits = JSON.parse(bun("check.ts", ["--out", out]).stdout).hits.filter((h: { file: string }) => h.file === "aidlc-issue-report.md");
  expect(hits).toEqual([]);
});

test("the cover's label counts are of the lines left, after a line holding the only copy of a label is taken out", () => {
  const out = reportFolder();
  useWords(out, []);
  const safe = { environment: { tools: {} }, trees: [{ row: "<custom-unit-1>" }] };
  writeFileSync(join(out, "safe.json"), JSON.stringify(safe, null, 2));
  // `Gathered` stands only on the cover's first prose line, which `Paths And` (across that line's end) takes out; this
  // leans on the cover's own wording, which the take-out then shows.
  hide(out, [["org", "Gathered"], ["org", "Paths And"]]);
  expect(bun("cover.ts", ["--out", out]).status).toBe(0);
  const cover = readFileSync(join(out, "aidlc-issue-report.md"), "utf8");
  expect(cover).toContain("(A line here held a name the person hid, so it was left out.)");
  // Each count is of the distinct numbered labels in safe.json and on the cover's lines, by redact.ts labelKind.
  const lines = cover.split("\n").filter((l) => !/^- [a-z][a-z-]*: (?:\d+|one label for every value)$/.test(l));
  const seen = new Map<string, Set<string>>();
  for (const m of `${readFileSync(join(out, "safe.json"), "utf8")}\n${lines.join("\n")}`.matchAll(LABEL)) {
    const { kind, numbered } = labelKind(m[0]);
    if (numbered) seen.set(kind, (seen.get(kind) ?? new Set<string>()).add(m[0]));
  }
  const counts = [...cover.matchAll(/^- ([a-z][a-z-]*): (\d+)$/gm)].map(([, kind, n]) => [kind, Number(n)]);
  expect(counts).toEqual([...seen].sort().map(([kind, set]) => [kind, set.size]));
  expect(counts).toContainEqual(["unit", 1]);
  expect(cover).not.toMatch(/^- org: /m);
  expect(JSON.parse(bun("check.ts", ["--out", out]).stdout).hits.filter((h: { file: string }) => h.file === "aidlc-issue-report.md")).toEqual([]);
});

test("a hidden name that is a key of a data map in safe.json is replaced too", () => {
  const out = reportFolder();
  writeFileSync(join(out, "safe.json"), JSON.stringify({ audit: { counts: { contoso: 2 } }, contoso: "field name, kept" }, null, 2));
  hide(out, [["customer", "contoso"]]);
  const safe = JSON.parse(readFileSync(join(out, "safe.json"), "utf8"));
  expect(Object.keys(safe.audit.counts)).toEqual(["<customer-1>"]);
});

test("a name the person hid that is only part of AI-DLC's words is refused in the report wherever it stands, and safe.json keeps AI-DLC's word", () => {
  const out = reportFolder();
  useWords(out, ["acme-aidlc-plugins", "BOLT_FAILED"]);
  writeFileSync(join(out, "safe.json"), JSON.stringify({ audit: { counts: { BOLT_FAILED: 1 } } }, null, 2));
  const r = JSON.parse(hide(out, [["customer", "Acme"]]).stdout);
  expect(r.ok).toBe(true);
  writeFileSync(join(out, "aidlc-issue-report.md"), "The Acme team saw the hook fail; acme-aidlc-plugins was on.\n");
  const hits = JSON.parse(bun("check.ts", ["--out", out]).stdout).hits;
  expect(hits.map((h: { line: number; reason: string }) => h.line)).toEqual([1]);
  // In the cover a name is found as the person's name is (the pattern hide.ts sorted it by), AI-DLC's word too, and a
  // name run into another word.
  writeFileSync(join(out, "aidlc-issue-report.md"), "The <customer-1> team saw it; acme-aidlc-plugins was on; AcmeProbe ran.\n");
  expect(JSON.parse(bun("check.ts", ["--out", out]).stdout).hits.length).toBeGreaterThan(0);
  writeFileSync(join(out, "aidlc-issue-report.md"), "The <customer-1> team saw it.\n");
  expect(bun("check.ts", ["--out", out]).status).toBe(0);
});

test("a name the map already hides is answered with the label it has", () => {
  const out = reportFolder();
  const r = hide(out, [["customer", "/tmp/p"]]);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout).alreadyHidden).toEqual(["<project>"]);
});

test("a name given twice in one call is added once and not called already hidden", () => {
  const out = reportFolder();
  const r = hide(out, [["customer", "Contoso"], ["customer", "CONTOSO"]]);
  expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, added: 1 });
  expect(JSON.parse(r.stdout).alreadyHidden).toBeUndefined();
});

test("every script that takes a report folder refuses a file or a missing --out instead of failing", () => {
  const out = reportFolder();
  const file = join(out, "safe.json");
  for (const [script, args] of [
    ["check.ts", []],
    ["check.ts", ["--out", file]],
    ["hide.ts", ["--out", file]],
    ["set-version.ts", ["--out", file, "--tool", "claude"]],
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
  expect(JSON.parse(hide(out, [["customer", "Acme"]]).stdout).alreadyHidden).toBeUndefined();
});

test("check.ts says a stray folder is not a report folder, not that it was finished", () => {
  const dir = mkdtempSync(join(tmpdir(), "stray-"));
  writeFileSync(join(dir, "aidlc-issue-report.md"), "# notes");
  const r = bun("check.ts", ["--out", dir]);
  expect(JSON.parse(r.stdout).reason).toContain("is not a report folder made by collect.ts");
});

test("a name with shell syntax in it is read from the names file, hidden, and the file is gone after", () => {
  const out = reportFolder();
  writeFileSync(join(out, "safe.json"), JSON.stringify({ note: "intent for Marks & Spencer's O'Brien team" }, null, 2));
  const r = hide(out, [["customer", "Marks & Spencer's"], ["person", "O'Brien"]]);
  expect([r.status, JSON.parse(r.stdout).ok]).toEqual([0, true]);
  const safe = readFileSync(join(out, "safe.json"), "utf8");
  expect(safe).not.toContain("Spencer");
  expect(safe).not.toContain("Brien");
  expect(existsSync(join(out, "local", "hide-names.json"))).toBe(false);
});

test("without a names file hide.ts hides nothing and says where the names go", () => {
  const out = reportFolder();
  const r = bun("hide.ts", ["--out", out]);
  expect([r.status, JSON.parse(r.stdout).ok, JSON.parse(r.stdout).file]).toEqual([2, false, join(out, "local", "hide-names.json")]);
  expect(readFileSync(join(out, "safe.json"), "utf8")).toContain("Contoso Bank");
});

test("a names file with a byte-order mark is read; wrong entries are named by their place and the file is kept to correct", () => {
  const out = reportFolder();
  const names = join(out, "local", "hide-names.json");
  const list = (kind: string) => [{ kind: "customer", name: "Contoso Bank" }, { kind, name: "Initech" }, { kind: "org", name: "X" }];
  writeFileSync(names, `\uFEFF${JSON.stringify(list("company"))}`);
  const r = JSON.parse(bun("hide.ts", ["--out", out]).stdout);
  expect([r.ok, r.entries]).toEqual([false, [2, 3]]);
  expect(existsSync(names)).toBe(true);
  expect(readFileSync(join(out, "safe.json"), "utf8")).toContain("Contoso Bank");
  writeFileSync(names, `\uFEFF${JSON.stringify(list("org").slice(0, 2))}`);
  expect(JSON.parse(bun("hide.ts", ["--out", out]).stdout).ok).toBe(true);
  expect(readFileSync(join(out, "safe.json"), "utf8")).not.toContain("Contoso");
});

test("the next step for a name not hidden says to write it to the file for hiding everywhere", () => {
  const out = reportFolder();
  useWords(out, ["BOLT_FAILED"]);
  writeFileSync(join(out, "safe.json"), JSON.stringify({ audit: { counts: { BOLT_FAILED: 1 } } }, null, 2));
  expect(JSON.parse(hide(out, [["customer", "Bolt"]]).stdout).next).toContain("local/hide-everywhere.json");
});

test("an empty names file hides nothing and is removed, so the check no longer waits on it", () => {
  const out = reportFolder();
  const r = hide(out, []);
  expect([r.status, JSON.parse(r.stdout)]).toEqual([0, { ok: true, added: 0 }]);
  expect(existsSync(join(out, "local", "hide-names.json"))).toBe(false);
});

test("a new report is not collected from one whose answer still waits, so the answer is not dropped", () => {
  const dir = project();
  const out = JSON.parse(bun("collect.ts", ["--project", dir, "--no-doctor", "--days", "1"]).stdout).out as string;
  writeFileSync(join(out, "local", "hide-names.json"), JSON.stringify([{ kind: "customer", name: "Zenith" }]));
  const r = collectFrom(out);
  expect([r.ok, r.reason, r.pending]).toEqual([false, "answers-waiting", [{ file: "local/hide-names.json", run: "hide.ts --out <out>" }]]);
});

test("a yes to hiding a name everywhere waits in its own file, so the check names the command with --everywhere", () => {
  const out = reportFolder();
  useWords(out, ["BOLT_FAILED"]);
  writeFileSync(join(out, "safe.json"), JSON.stringify({ audit: { counts: { BOLT_FAILED: 1 } } }, null, 2));
  expect(JSON.parse(hide(out, [["customer", "Bolt"]]).stdout).notHidden).toHaveLength(1);
  writeFileSync(join(out, "local", "hide-everywhere.json"), JSON.stringify([{ kind: "customer", name: "Bolt" }]));
  const check = JSON.parse(bun("check.ts", ["--out", out]).stdout);
  expect(check.pending).toEqual([{ file: "local/hide-everywhere.json", run: "hide.ts --out <out> --everywhere" }]);
  const r = JSON.parse(bun("hide.ts", ["--out", out, "--everywhere"]).stdout);
  expect([r.ok, r.added, existsSync(join(out, "local", "hide-everywhere.json"))]).toEqual([true, 1, false]);
});
