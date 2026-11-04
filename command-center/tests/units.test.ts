import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUnits, CONSTRUCTION, unitIsDone, unitOwedOf, unitStagesOf } from "../../core/command-center/server/model/units";
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

test("a unit is done at its last owed per-unit stage in graph order, even one after code generation", () => {
  const catalog = [st("functional-design", true, 1), st("code-generation", true, 2), st("security-review", true, 3), st("build-and-test", false, 4)];
  const stages = unitStagesOf(catalog, []);
  const owed = unitOwedOf(stages, new Set());
  expect(owed).toEqual(["functional-design", "code-generation", "security-review"]);
  const events = [ev("UNIT_COMPLETED", "code-generation", "a", 1), ev("UNIT_COMPLETED", "code-generation", "b", 2), ev("UNIT_COMPLETED", "security-review", "b", 3)];
  expect(buildUnits(events, { stage: null, unit: null }, stages, owed).done).toBe(1);
});

test("a stage the plan skips is not owed, so units finish without it", () => {
  const stages = ["functional-design", "code-generation", "security-review"];
  const owed = unitOwedOf(stages, new Set(["security-review"]));
  expect(owed).toEqual(["functional-design", "code-generation"]);
  expect(buildUnits([ev("UNIT_COMPLETED", "code-generation", "a", 1)], { stage: null, unit: null }, stages, owed).done).toBe(1);
});

test("UNIT_SKIPPED settles that unit's stage: a unit that skipped its last stage is done when the one before is", () => {
  const stages = ["functional-design", "code-generation", "security-review"];
  const events = [ev("UNIT_COMPLETED", "code-generation", "a", 1), ev("UNIT_SKIPPED", "security-review", "a", 2), ev("UNIT_COMPLETED", "code-generation", "b", 3)];
  const u = buildUnits(events, { stage: null, unit: null }, stages, stages);
  expect(u.units.find((r) => r.name === "a")!.cells["security-review"]).toBe("na");
  expect(u.done).toBe(1); // a is settled; b still owes security-review
  expect(unitIsDone({ "functional-design": "na", "code-generation": "na" }, ["functional-design", "code-generation"])).toBe(true);
  expect(unitIsDone({}, [])).toBe(false);
});

test("a later start after a unit skip reopens the stage", () => {
  const stages = ["code-generation"];
  const u = buildUnits([ev("UNIT_SKIPPED", "code-generation", "a", 1), ev("UNIT_STARTED", "code-generation", "a", 2)], { stage: null, unit: null }, stages, stages);
  expect(u.units[0]!.cells["code-generation"]).toBe("running");
  expect(u.done).toBe(0);
});

test("the legacy fallback is the five canonical per-unit stages, not Build and Test or CI Pipeline", () => {
  expect(CONSTRUCTION).toEqual(["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"]);
  expect(unitStagesOf([st("build-and-test", false, 1), st("ci-pipeline", false, 2)], [])).toEqual(CONSTRUCTION);
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
