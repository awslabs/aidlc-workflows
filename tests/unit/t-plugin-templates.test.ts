// covers: file:core/tools/aidlc-plugin.ts, function:mergePluginRules, function:stripPluginRules, function:copyPluginRulesToSpace, function:rulesRecordGaps, function:pluginTemplateStripRemovals, function:readRulesRecord, function:readTemplatesRecord, function:mergePluginRulesFromRoot, function:pluginRulesRecords
//
// A plugin's memory/templates/<artifact>.md lands as a whole file in every
// space's memory/templates/, hash-proven in a record of its own,
// aidlc/plugin-templates/<plugin>.json (the file itself carries no marker, so
// the skeleton the agent fills stays clean; a record whose keys are not
// templates/<artifact>.md is not AI-DLC's and touches nothing):
// placed everywhere and idempotent; a person's file at the same path always
// wins, with the kept line said once; the plugin's own update replaces only
// its own bytes; off strips exactly the plugin's files; a new space copies the
// plugin's template and never the team's own; doctor's record gaps name a
// missing file; a CRLF checkout still proves ownership.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyPluginRulesToSpace,
  mergePluginRules,
  mergePluginRulesFromRoot,
  pluginRulesRecords,
  pluginTemplateStripRemovals,
  readRulesRecord,
  readTemplatesRecord,
  rulesRecordGaps,
  stripPluginRules,
} from "../../dist/claude/.claude/tools/aidlc-plugin.ts";

const PLAN = "templates/test-plan.md";
const PLAN_V1 = "# Test plan\n\n## Scope\n\n## Branch Coverage\n";
const PLAN_V2 = "# Test plan\n\n## Scope\n\n## Branch Coverage\n\n## Risks\n";
const OWN = "# Our own plan shape\n\n## What we check\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function project(spaces: string[] = ["default", "alpha"]): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-tpl-proj-"));
  made.push(dir);
  for (const space of spaces) {
    const memory = join(dir, "aidlc", "spaces", space, "memory");
    mkdirSync(join(memory, "templates"), { recursive: true });
    writeFileSync(join(memory, "team.md"), "# Team practices\n");
  }
  return dir;
}

function plugin(files: Record<string, string>, key = "test-pro"): { key: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "aidlc-tpl-plug-"));
  made.push(root);
  mkdirSync(join(root, ".aidlc-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".aidlc-plugin", "plugin.json"),
    `${JSON.stringify({ name: key, version: "0.1.0", aidlc: { rulesLevel: "team" } })}\n`,
  );
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, "memory", ...rel.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  return { key, root };
}

const planPath = (proj: string, space: string) => join(proj, "aidlc", "spaces", space, "memory", "templates", "test-plan.md");

describe("a plugin's templates in every space", () => {
  test("placed everywhere, hash-recorded, said once, and idempotent", () => {
    const proj = project();
    const p = plugin({ [PLAN]: PLAN_V1 });
    const lines = mergePluginRules(proj, p);
    expect(lines).toEqual([
      "test-pro's templates are in each space's memory/templates: test-plan.md. " +
        "The required-sections sensor checks their ## headings at the gate; a file of your own at the same path is kept as yours (the plugin owns only the unedited copies it placed).",
    ]);
    for (const space of ["default", "alpha"]) expect(readFileSync(planPath(proj, space), "utf-8")).toBe(PLAN_V1);
    expect(readTemplatesRecord(proj, "test-pro")).toEqual({ [PLAN]: { sha256: sha(PLAN_V1), kept: [] } });
    expect(mergePluginRules(proj, p)).toEqual([]);
    expect(readFileSync(planPath(proj, "default"), "utf-8")).toBe(PLAN_V1);
  });

  test("a template-only plugin needs no rules.md and no level line", () => {
    const proj = project(["default"]);
    const root = mkdtempSync(join(tmpdir(), "aidlc-tpl-plug-"));
    mkdirSync(join(root, ".aidlc-plugin"), { recursive: true });
    writeFileSync(join(root, ".aidlc-plugin", "plugin.json"), `${JSON.stringify({ name: "shape-only", version: "1.0.0" })}\n`);
    mkdirSync(join(root, "memory", "templates"), { recursive: true });
    writeFileSync(join(root, "memory", "templates", "test-plan.md"), PLAN_V1);
    const lines = mergePluginRules(proj, { key: "shape-only", root });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("shape-only's templates are in each space's memory/templates: test-plan.md.");
    expect(readFileSync(planPath(proj, "default"), "utf-8")).toBe(PLAN_V1);
  });

  test("a person's file at the path wins, the kept line is said once, and their later delete lets the plugin's land", () => {
    const proj = project();
    writeFileSync(planPath(proj, "alpha"), OWN);
    const p = plugin({ [PLAN]: PLAN_V1 });
    const lines = mergePluginRules(proj, p);
    expect(lines[1]).toBe("Kept your own aidlc/spaces/alpha/memory/templates/test-plan.md; test-pro's template did not replace it.");
    expect(readFileSync(planPath(proj, "alpha"), "utf-8")).toBe(OWN);
    expect(readFileSync(planPath(proj, "default"), "utf-8")).toBe(PLAN_V1);
    expect(readTemplatesRecord(proj, "test-pro")?.[PLAN].kept).toEqual(["alpha"]);
    expect(mergePluginRules(proj, p)).toEqual([]);
    expect(readFileSync(planPath(proj, "alpha"), "utf-8")).toBe(OWN);
    rmSync(planPath(proj, "alpha"));
    // Their file is gone, so the plugin's lands there now: said once.
    expect(mergePluginRules(proj, p)).toEqual([
      "aidlc/spaces/alpha/memory/templates/test-plan.md was your own and is gone, so test-pro's template is there now; the gate checks its sections.",
    ]);
    expect(mergePluginRules(proj, p)).toEqual([]);
    expect(readFileSync(planPath(proj, "alpha"), "utf-8")).toBe(PLAN_V1);
    expect(readTemplatesRecord(proj, "test-pro")?.[PLAN].kept).toEqual([]);
  });

  test("a hand edit makes the file the person's: kept, said once, never written back", () => {
    const proj = project(["default"]);
    const p = plugin({ [PLAN]: PLAN_V1 });
    mergePluginRules(proj, p);
    writeFileSync(planPath(proj, "default"), `${PLAN_V1}\n## Our extra section\n`);
    const lines = mergePluginRules(proj, p);
    expect(lines).toEqual(["Kept your own aidlc/spaces/default/memory/templates/test-plan.md; test-pro's template did not replace it."]);
    expect(readFileSync(planPath(proj, "default"), "utf-8")).toBe(`${PLAN_V1}\n## Our extra section\n`);
    expect(mergePluginRules(proj, p)).toEqual([]);
  });

  test("the plugin's update replaces its own previous bytes only", () => {
    const proj = project();
    writeFileSync(planPath(proj, "alpha"), OWN);
    const p = plugin({ [PLAN]: PLAN_V1 });
    mergePluginRules(proj, p);
    writeFileSync(join(p.root, "memory", "templates", "test-plan.md"), PLAN_V2);
    mergePluginRules(proj, p);
    expect(readFileSync(planPath(proj, "default"), "utf-8")).toBe(PLAN_V2);
    expect(readFileSync(planPath(proj, "alpha"), "utf-8")).toBe(OWN);
    expect(readTemplatesRecord(proj, "test-pro")?.[PLAN].sha256).toBe(sha(PLAN_V2));
  });

  test("a template the plugin stopped shipping goes where its bytes prove it, and the person's stays", () => {
    const proj = project();
    writeFileSync(planPath(proj, "alpha"), OWN);
    const p = plugin({ [PLAN]: PLAN_V1, "rules.md": "- Keep testing.\n" });
    mergePluginRules(proj, p);
    rmSync(join(p.root, "memory", "templates", "test-plan.md"));
    mergePluginRules(proj, p);
    expect(existsSync(planPath(proj, "default"))).toBe(false);
    expect(readFileSync(planPath(proj, "alpha"), "utf-8")).toBe(OWN);
    expect(readTemplatesRecord(proj, "test-pro")).toBeNull();
  });

  test("off strips exactly the plugin's files and keeps the record; prune forgets it", () => {
    const proj = project();
    writeFileSync(planPath(proj, "alpha"), OWN);
    const p = plugin({ [PLAN]: PLAN_V1 });
    mergePluginRules(proj, p);
    expect(pluginTemplateStripRemovals(proj, "test-pro")).toEqual(["aidlc/spaces/default/memory/templates/test-plan.md"]);
    expect(stripPluginRules(proj, "test-pro", true)).toBe(true);
    expect(existsSync(planPath(proj, "default"))).toBe(false);
    expect(readFileSync(planPath(proj, "alpha"), "utf-8")).toBe(OWN);
    expect(readTemplatesRecord(proj, "test-pro")?.[PLAN].sha256).toBe(sha(PLAN_V1));
    // On again: the merge places the plugin's bytes back.
    expect(mergePluginRules(proj, p)).toEqual([]);
    expect(readFileSync(planPath(proj, "default"), "utf-8")).toBe(PLAN_V1);
    stripPluginRules(proj, "test-pro", false);
    expect(readRulesRecord(proj, "test-pro")).toBeNull();
    expect(readTemplatesRecord(proj, "test-pro")).toBeNull();
  });

  test("a new space copies the plugin's template and never the team's own", () => {
    const proj = project();
    writeFileSync(planPath(proj, "alpha"), OWN);
    const p = plugin({ [PLAN]: PLAN_V1 });
    mergePluginRules(proj, p);
    for (const [from, to] of [["default", "beta"], ["alpha", "gamma"]] as const) {
      const memory = join(proj, "aidlc", "spaces", to, "memory");
      mkdirSync(join(memory, "templates"), { recursive: true });
      writeFileSync(join(memory, "team.md"), "# Team practices\n");
      copyPluginRulesToSpace(proj, join(proj, "aidlc", "spaces", from, "memory"), memory);
    }
    expect(readFileSync(planPath(proj, "beta"), "utf-8")).toBe(PLAN_V1);
    // gamma waits for the next sync, which places the plugin's bytes there.
    expect(existsSync(planPath(proj, "gamma"))).toBe(false);
    expect(mergePluginRules(proj, p)).toEqual([]);
    expect(readFileSync(planPath(proj, "gamma"), "utf-8")).toBe(PLAN_V1);
  });

  test("doctor's record gaps name a missing template; a person's file at the path is no gap", () => {
    const proj = project();
    const p = plugin({ [PLAN]: PLAN_V1 });
    mergePluginRules(proj, p);
    expect(rulesRecordGaps(proj, "test-pro")).toEqual([]);
    rmSync(planPath(proj, "default"));
    writeFileSync(planPath(proj, "alpha"), OWN);
    expect(rulesRecordGaps(proj, "test-pro")).toEqual(["template missing from aidlc/spaces/default/memory/templates/test-plan.md"]);
  });

  test("two plugins shipping the same artifact's template: the second says a conflict, never 'your own'", () => {
    const proj = project(["default"]);
    const first = plugin({ [PLAN]: PLAN_V1 }, "alpha-pro");
    const second = plugin({ [PLAN]: PLAN_V2 }, "beta-pro");
    mergePluginRules(proj, first);
    const lines = mergePluginRules(proj, second);
    expect(lines).toEqual([
      "aidlc/spaces/default/memory/templates/test-plan.md is alpha-pro's; beta-pro's template for the same artifact was not applied.",
    ]);
    expect(readFileSync(planPath(proj, "default"), "utf-8")).toBe(PLAN_V1);
    expect(mergePluginRules(proj, second)).toEqual([]);
    expect(readFileSync(planPath(proj, "default"), "utf-8")).toBe(PLAN_V1);
  });

  test("a first merge where every space keeps its own says no placement line", () => {
    const proj = project();
    writeFileSync(planPath(proj, "default"), OWN);
    writeFileSync(planPath(proj, "alpha"), OWN);
    const p = plugin({ [PLAN]: PLAN_V1 });
    const lines = mergePluginRules(proj, p);
    expect(lines.some((line) => line.includes("templates are in"))).toBe(false);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toStartWith("Kept your own ");
  });

  test("a template a later plugin version adds says its own line; the recorded one says nothing again", () => {
    const proj = project(["default"]);
    const p = plugin({ [PLAN]: PLAN_V1 });
    mergePluginRules(proj, p);
    writeFileSync(join(p.root, "memory", "templates", "risk-register.md"), "# Risks\n\n## Open Risks\n");
    const lines = mergePluginRules(proj, p);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("test-pro's templates are in each space's memory/templates: risk-register.md.");
    expect(readFileSync(join(proj, "aidlc", "spaces", "default", "memory", "templates", "risk-register.md"), "utf-8"))
      .toBe("# Risks\n\n## Open Risks\n");
    // The record of its own, beside the rules record, that proves ownership.
    expect(existsSync(join(proj, "aidlc", "plugin-templates", "test-pro.json"))).toBe(true);
  });

  test("a CRLF checkout still proves the plugin's bytes: no rewrite, and off still strips it", () => {
    const proj = project(["default"]);
    const p = plugin({ [PLAN]: PLAN_V1 });
    mergePluginRules(proj, p);
    const crlf = PLAN_V1.replace(/\n/g, "\r\n");
    writeFileSync(planPath(proj, "default"), crlf);
    expect(mergePluginRules(proj, p)).toEqual([]);
    expect(readFileSync(planPath(proj, "default"), "utf-8")).toBe(crlf);
    expect(stripPluginRules(proj, "test-pro", true)).toBe(true);
    expect(existsSync(planPath(proj, "default"))).toBe(false);
  });
});

describe("review fixes: what a templates record may name, and whose file is whose", () => {
  test("a record key that walks out of memory/templates makes the record not AI-DLC's: off touches nothing", () => {
    const proj = project(["default"]);
    const p = plugin({ [PLAN]: PLAN_V1 });
    mergePluginRules(proj, p);
    const note = join(proj, "aidlc", "spaces", "default", "OUR-NOTES.md");
    writeFileSync(note, PLAN_V1);
    const recordPath = join(proj, "aidlc", "plugin-templates", "test-pro.json");
    const record = JSON.parse(readFileSync(recordPath, "utf-8"));
    record.templates["templates/../../OUR-NOTES.md"] = { sha256: sha(PLAN_V1), kept: [] };
    writeFileSync(recordPath, JSON.stringify(record));
    expect(readTemplatesRecord(proj, "test-pro")).toBeNull();
    stripPluginRules(proj, "test-pro", true);
    expect(existsSync(note)).toBe(true);
    expect(pluginTemplateStripRemovals(proj, "test-pro")).toEqual([]);
  });

  test("a file the person placed before the plugin's first merge stays theirs, even with the plugin's bytes", () => {
    const proj = project(["default"]);
    writeFileSync(planPath(proj, "default"), PLAN_V1);
    const p = plugin({ [PLAN]: PLAN_V1 });
    const lines = mergePluginRules(proj, p);
    expect(lines).toEqual(["Kept your own aidlc/spaces/default/memory/templates/test-plan.md; test-pro's template did not replace it."]);
    expect(readTemplatesRecord(proj, "test-pro")?.[PLAN].kept).toEqual(["default"]);
    expect(stripPluginRules(proj, "test-pro", true)).toBe(false);
    expect(existsSync(planPath(proj, "default"))).toBe(true);
    // The plugin's update never replaces it either.
    mergePluginRules(proj, plugin({ [PLAN]: PLAN_V2 }));
    expect(readFileSync(planPath(proj, "default"), "utf-8")).toBe(PLAN_V1);
  });

  test("a hand edit that lands on the next version's exact bytes stays the person's: kept, said once, and off leaves it", () => {
    const proj = project(["default"]);
    const p = plugin({ [PLAN]: PLAN_V1 });
    mergePluginRules(proj, p);
    // The person edits the plugin's copy into what v2 will ship.
    writeFileSync(planPath(proj, "default"), PLAN_V2);
    writeFileSync(join(p.root, "memory", "templates", "test-plan.md"), PLAN_V2);
    const lines = mergePluginRules(proj, p);
    expect(lines).toEqual(["Kept your own aidlc/spaces/default/memory/templates/test-plan.md; test-pro's template did not replace it."]);
    expect(readTemplatesRecord(proj, "test-pro")?.[PLAN].kept).toEqual(["default"]);
    expect(mergePluginRules(proj, p)).toEqual([]);
    stripPluginRules(proj, "test-pro", true);
    expect(readFileSync(planPath(proj, "default"), "utf-8")).toBe(PLAN_V2);
  });

  test("a template-only first version leaves no level choice behind: a later version's declared level applies, and is said", () => {
    const proj = project(["default"]);
    const root = mkdtempSync(join(tmpdir(), "aidlc-tpl-plug-"));
    made.push(root);
    const manifest = join(root, ".aidlc-plugin", "plugin.json");
    mkdirSync(join(root, ".aidlc-plugin"), { recursive: true });
    mkdirSync(join(root, "memory", "templates"), { recursive: true });
    writeFileSync(manifest, `${JSON.stringify({ name: "test-pro", version: "0.1.0" })}\n`);
    writeFileSync(join(root, "memory", "templates", "test-plan.md"), PLAN_V1);
    mergePluginRules(proj, { key: "test-pro", root });
    expect(readRulesRecord(proj, "test-pro")?.chosen).toBeUndefined();
    writeFileSync(manifest, `${JSON.stringify({ name: "test-pro", version: "0.2.0", aidlc: { rulesLevel: "team" } })}\n`);
    writeFileSync(join(root, "memory", "rules.md"), "- Run the integration plan before merge.\n");
    const lines = mergePluginRules(proj, { key: "test-pro", root });
    const team = readFileSync(join(proj, "aidlc", "spaces", "default", "memory", "team.md"), "utf-8");
    expect(team).toContain("Run the integration plan before merge.");
    expect(readRulesRecord(proj, "test-pro")?.level).toBe("team");
    expect(lines[0]).toStartWith("test-pro's rules are in team.md");
  });

  test("a level the person chose stays theirs when rules arrive later", () => {
    const proj = project(["default"]);
    const p = plugin({ [PLAN]: PLAN_V1 });
    mergePluginRules(proj, p, "org");
    expect(readRulesRecord(proj, "test-pro")).toMatchObject({ level: "org", chosen: true });
    writeFileSync(join(p.root, "memory", "rules.md"), "- A rule.\n");
    mergePluginRules(proj, p);
    expect(readRulesRecord(proj, "test-pro")?.level).toBe("org");
  });

  test("a template-only plugin with no rules record still has its template copied to a new space and checked by doctor", () => {
    const proj = project(["default"]);
    mergePluginRules(proj, plugin({ [PLAN]: PLAN_V1 }));
    rmSync(join(proj, "aidlc", "plugin-rules", "test-pro.json"), { force: true });
    expect(pluginRulesRecords(proj)).toEqual(["test-pro"]);
    const beta = join(proj, "aidlc", "spaces", "beta", "memory");
    mkdirSync(join(beta, "templates"), { recursive: true });
    copyPluginRulesToSpace(proj, join(proj, "aidlc", "spaces", "default", "memory"), beta);
    expect(readFileSync(join(beta, "templates", "test-plan.md"), "utf-8")).toBe(PLAN_V1);
    rmSync(planPath(proj, "default"));
    expect(rulesRecordGaps(proj, "test-pro")).toEqual(["template missing from aidlc/spaces/default/memory/templates/test-plan.md"]);
  });

  test("a version that drops memory/ entirely takes its earlier templates out through the live root path", () => {
    const proj = project(["default"]);
    const p = plugin({ [PLAN]: PLAN_V1 });
    mergePluginRules(proj, p);
    rmSync(join(p.root, "memory"), { recursive: true, force: true });
    mergePluginRulesFromRoot(proj, ".claude", p.root, () => true);
    expect(existsSync(planPath(proj, "default"))).toBe(false);
    expect(readTemplatesRecord(proj, "test-pro")).toBeNull();
  });
});
