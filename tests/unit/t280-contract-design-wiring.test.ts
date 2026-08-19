// covers: stage:inception/contract-design
//
// PR #711 review wiring guards. The domain/contract restructure added a new
// workflow-level `contract-design` stage that produces `contract-summary`, and
// re-tautened the graph edges reviewers flagged as missing:
//
//   - leandrodamascena #2 / apackeer #2 (P1): `contract-summary` must reach the
//     downstream stages that read it — before the fix `aidlc-graph consumers
//     contract-summary` returned ONLY functional-design, so code-generation and
//     the planning/NFR/infra stages saw the boundary contract in prose but not
//     in their resolved directive. This pins the full consumer set.
//   - apackeer #5 (P2): removing the old application-design collapsed away the
//     ADR log; `decisions` is retained as a domain-design produce. This pins its
//     producer so a future "consolidate to a single components.md" edit cannot
//     silently drop the ADR contract again.
//
// Mechanism: spawns the shipped aidlc-graph CLI (dist) and asserts its
// producer/consumer projections — the same reproduction the reviewers ran.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const GRAPH = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-graph.ts",
);

function graph(...args: string[]): string[] {
  const res = spawnSync(BUN, [GRAPH, ...args], { encoding: "utf-8" });
  if ((res.status ?? -1) !== 0) {
    throw new Error(
      `aidlc-graph ${args.join(" ")} exited ${res.status}\n${res.stdout ?? ""}${res.stderr ?? ""}`,
    );
  }
  return (res.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

describe("t280 contract-design + decisions graph wiring", () => {
  test("contract-design is the sole producer of contract-summary", () => {
    expect(graph("producers", "contract-summary")).toEqual(["contract-design"]);
  });

  // The core regression: contract-summary must flow to every stage that reads a
  // cross-boundary contract, not just functional-design.
  test("contract-summary reaches all six downstream consumers", () => {
    const consumers = graph("consumers", "contract-summary");
    for (const stage of [
      "delivery-planning",
      "functional-design",
      "nfr-requirements",
      "nfr-design",
      "infrastructure-design",
      "code-generation",
    ]) {
      expect(consumers).toContain(stage);
    }
    // Exactly those six — no more, no fewer.
    expect(consumers.length).toBe(6);
  });

  // The retained ADR log (apackeer #5): domain-design still owns `decisions`.
  test("domain-design is the sole producer of the decisions (ADR) artifact", () => {
    expect(graph("producers", "decisions")).toEqual(["domain-design"]);
  });

  // The retained ADR log must reach a consumer (leandro re-review #3): units-generation
  // reads `decisions` so boundary/ownership ADRs constrain decomposition.
  test("decisions (ADR log) is consumed by units-generation", () => {
    expect(graph("consumers", "decisions")).toContain("units-generation");
  });

  // Deterministic summary-confirmation checkpoint (leandro re-review #1): contract-design
  // has a question flow, so it MUST declare `summary_confirmation: required` — otherwise
  // checkSummaryConfirmationEvidence() short-circuits and the stage can complete without
  // the human-backed consolidated-summary receipt.
  // Driven from the shared harness matrix (leandro re-review #5 / P3) so a
  // missing Codex/Cursor/Kiro/Kiro-IDE/OpenCode projection cannot pass
  // unnoticed — every shipped harness must carry the wired stage-graph.
  test("contract-design is wired with summary_confirmation across every shipped harness", () => {
    expect(HARNESS_MATRIX.length).toBeGreaterThanOrEqual(7);
    for (const harness of HARNESS_MATRIX) {
      const graphPath = join(harness.engineRoot, "tools", "data", "stage-graph.json");
      const g = JSON.parse(readFileSync(graphPath, "utf-8")) as Array<{
        slug: string;
        summary_confirmation?: string;
      }>;
      const cd = g.find((s) => s.slug === "contract-design");
      expect(cd, `${harness.name}: ${graphPath}`).toBeDefined();
      expect(cd?.summary_confirmation, `${harness.name}: summary_confirmation`).toBe("required");
    }
  });
});
