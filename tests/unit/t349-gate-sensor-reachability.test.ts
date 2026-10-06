// covers: stage:inception/reverse-engineering
//
// t349 - every shipped gate-sensor binding can reach its stage's output (#771).
//
// A gate-fired sensor only ever runs against the stage's declared deliverables,
// and only on a deliverable whose path its manifest `matches` glob accepts
// (aidlc-state.ts gateSensorMatchesOutput, then the dispatcher's own filter).
// Whether a binding can EVER fire is therefore decidable from the compiled
// graph alone: resolve each declared artifact through the engine's placement
// resolver and require the glob to accept at least one of them. #771 was a
// binding that could not: reverse-engineering publishes to the space-level
// CodeKB, which the record-tree glob `**/{aidlc-docs,intents}/**` never
// matched, so its declared sensors silently never ran. Gate dispatch resolves
// paths through aidlc-state.ts producesDirsForStage, which mirrors this
// resolver's placement (both key codekb stages on KNOWN_CODEKB_STAGES).
//
// Write-fired sensors (linter, type-check, traceability) are out of scope:
// they match the files an agent writes, not the stage's declared deliverables.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveArtifactInstances } from "../../core/tools/aidlc-artifact-resolution.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seededRecordDir,
} from "../harness/fixtures.ts";

interface ShippedStage {
  slug: string;
  phase: string;
  for_each?: string;
  produces?: string[];
  optional_produces?: string[];
  produces_kinds?: Record<string, string[]>;
  sensors_applicable?: { id: string; fire_on?: string; matches?: string }[];
}

const SHIPPED_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");
const project = createTestProject();

afterAll(() => cleanupTestProject(project));

function deliverablePaths(stage: ShippedStage): string[] {
  const artifacts = [...(stage.produces ?? []), ...(stage.optional_produces ?? [])];
  return artifacts.flatMap((artifact) =>
    resolveArtifactInstances(project, artifact, stage, {
      recordPath: seededRecordDir(project),
      runtimeUnits: [{ name: "unit-a", kind: null }],
      codekbRepos: ["repo-a"],
    }).map((instance) => instance.absolutePath.replace(/\\/g, "/")),
  );
}

describe("t349 gate sensor reachability", () => {
  const graph = JSON.parse(readFileSync(SHIPPED_GRAPH, "utf-8")) as ShippedStage[];
  const bindings = graph.flatMap((stage) =>
    (stage.sensors_applicable ?? [])
      .filter((sensor) => sensor.fire_on === "gate" && sensor.matches !== undefined)
      .map((sensor) => ({ stage, sensor })),
  );

  test("the shipped graph carries gate bindings, reverse-engineering's among them", () => {
    expect(bindings.length).toBeGreaterThan(0);
    expect(
      bindings
        .filter(({ stage }) => stage.slug === "reverse-engineering")
        .map(({ sensor }) => sensor.id)
        .sort(),
    ).toEqual(["required-sections", "upstream-coverage"]);
  });

  test("every gate binding's matches glob accepts at least one declared deliverable", () => {
    const unreachable = bindings
      .filter(({ stage, sensor }) => {
        const glob = new Bun.Glob(sensor.matches as string);
        return !deliverablePaths(stage).some((path) => glob.match(path));
      })
      .map(({ stage, sensor }) => `${stage.slug} -> ${sensor.id} (${sensor.matches})`);
    expect(unreachable).toEqual([]);
  });
});
