// covers: file:core/tools/aidlc-plugin.ts, function:mergePluginRules, function:stripPluginRules, function:copyPluginRulesToSpace, function:rulesRecordGaps, function:pluginTemplateStripRemovals, function:readRulesRecord
//
// A plugin's memory/templates/<artifact>.md lands as a whole file in every
// space's memory/templates/, hash-proven in the plugin's rules record (the
// file itself carries no marker, so the skeleton the agent fills stays clean):
// placed everywhere and idempotent; a person's file at the same path always
// wins, with the kept line said once; the plugin's own update replaces only
// its own bytes; off strips exactly the plugin's files; a new space copies the
// plugin's template and never the team's own; doctor's record gaps name a
// missing file; a CRLF checkout still proves ownership.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyPluginRulesToSpace,
  mergePluginRules,
  pluginTemplateStripRemovals,
  readRulesRecord,
  rulesRecordGaps,
  stripPluginRules,
} from "../../dist/claude/.claude/tools/aidlc-plugin.ts";

const PLAN = "templates/test-plan.md";
const PLAN_V1 = "# Test plan\n\n## Scope\n\n## Branch Coverage\n";
const PLAN_V2 = "# Test plan\n\n## Scope\n\n## Branch Coverage\n\n## Risks\n";
const OWN = "# Our own plan shape\n\n## What we check\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function project(spaces: string[] = ["default", "alpha"]): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-tpl-proj-"));
  for (const space of spaces) {
    const memory = join(dir, "aidlc", "spaces", space, "memory");
    mkdirSync(join(memory, "templates"), { recursive: true });
    writeFileSync(join(memory, "team.md"), "# Team practices\n");
  }
  return dir;
}

function plugin(files: Record<string, string>, key = "test-pro"): { key: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "aidlc-tpl-plug-"));
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
        "The required-sections sensor checks their ## headings at the gate; a file of your own at the same path is kept as yours.",
    ]);
    for (const space of ["default", "alpha"]) expect(readFileSync(planPath(proj, space), "utf-8")).toBe(PLAN_V1);
    expect(readRulesRecord(proj, "test-pro")?.templates).toEqual({ [PLAN]: { sha256: sha(PLAN_V1), kept: [] } });
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
    expect(readRulesRecord(proj, "test-pro")?.templates?.[PLAN].kept).toEqual(["alpha"]);
    expect(mergePluginRules(proj, p)).toEqual([]);
    expect(readFileSync(planPath(proj, "alpha"), "utf-8")).toBe(OWN);
    rmSync(planPath(proj, "alpha"));
    expect(mergePluginRules(proj, p)).toEqual([]);
    expect(readFileSync(planPath(proj, "alpha"), "utf-8")).toBe(PLAN_V1);
    expect(readRulesRecord(proj, "test-pro")?.templates?.[PLAN].kept).toEqual([]);
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
    expect(readRulesRecord(proj, "test-pro")?.templates?.[PLAN].sha256).toBe(sha(PLAN_V2));
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
    expect(readRulesRecord(proj, "test-pro")?.templates).toBeUndefined();
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
    expect(readRulesRecord(proj, "test-pro")?.templates?.[PLAN].sha256).toBe(sha(PLAN_V1));
    // On again: the merge places the plugin's bytes back.
    expect(mergePluginRules(proj, p)).toEqual([]);
    expect(readFileSync(planPath(proj, "default"), "utf-8")).toBe(PLAN_V1);
    stripPluginRules(proj, "test-pro", false);
    expect(readRulesRecord(proj, "test-pro")).toBeNull();
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
