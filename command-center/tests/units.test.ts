import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUnits, CONSTRUCTION, unitStagesOf } from "../../core/command-center/server/model/units";
import { loadCatalog } from "../../core/command-center/server/parse/stage-graph";
import type { AuditEvent, CatalogStage } from "../../core/command-center/server/types";

const st = (slug: string, perUnit: boolean, order: number): CatalogStage => ({ slug, name: slug, phase: "construction", lead: "x", order, perUnit });
const ev = (event: string, Stage: string, Unit: string, seq: number): AuditEvent => ({ ts: `2026-08-13T10:0${seq}:00Z`, event, heading: "Entry", fields: { Stage, Unit }, shard: "s", seq });

test("unit columns come from the graph's for_each stages, plus a plugin stage that recorded unit events", () => {
  const catalog = [st("functional-design", true, 1), st("security-scan", false, 2), st("code-generation", true, 3), st("build-and-test", false, 4)];
  const events = [ev("UNIT_STARTED", "security-scan", "alpha", 1), ev("UNIT_COMPLETED", "security-scan", "alpha", 2)];
  expect(unitStagesOf(catalog, events)).toEqual(["functional-design", "code-generation", "security-scan"]);
  const u = buildUnits(events, { stage: null, unit: null }, unitStagesOf(catalog, events));
  expect(u.units[0]!.cells).toEqual({ "functional-design": "todo", "code-generation": "todo", "security-scan": "done" });
});

test("without a graph, or with one that predates for_each, the core per-unit stages are used", () => {
  expect(unitStagesOf([], [])).toEqual(CONSTRUCTION);
  expect(unitStagesOf([st("code-generation", false, 1)], [])).toEqual(CONSTRUCTION);
});

test("a graph without code generation counts a unit done at its last per-unit stage", () => {
  const stages = ["design", "deliver"];
  const u = buildUnits([ev("UNIT_COMPLETED", "design", "a", 1), ev("UNIT_COMPLETED", "deliver", "a", 2), ev("UNIT_COMPLETED", "design", "b", 3)], { stage: null, unit: null }, stages);
  expect(u.done).toBe(1);
});

test("loadCatalog keeps for_each as perUnit", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-graph-"));
  await mkdir(join(root, ".claude/tools/data"), { recursive: true });
  await writeFile(join(root, ".claude/tools/data/stage-graph.json"), JSON.stringify([
    { slug: "functional-design", phase: "construction", for_each: "unit-of-work" },
    { slug: "build-and-test", phase: "construction" },
  ]));
  const { stages } = await loadCatalog(root);
  expect(stages.map((s) => [s.slug, s.perUnit])).toEqual([["functional-design", true], ["build-and-test", false]]);
});
