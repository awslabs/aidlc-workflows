// covers: stage:construction/functional-design
//
// Functional Design's produces_kinds give a `ui` Unit no rules.md (rules apply
// to service, spec and library Units), yet the traceability sensor required
// rules.md and a BRx.y target on every OK row for every Unit. A UI Unit could
// only pass by inventing business rules. A Unit whose kind does not produce
// rules.md traces each OK row to the Functional Design file that covers it
// (functional-spec.md, or frontend-components.md), named on its own, and that
// file must exist.
// Runs the built sensor: the kind map comes from the compiled stage graph.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject, seededRecordDir, seededStateFile } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const SENSOR = join(AIDLC_SRC, "tools", "aidlc-sensor-traceability.ts");
const projects: string[] = [];
afterEach(() => {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
});

function write(proj: string, relative: string, content: string): string {
  const path = join(seededRecordDir(proj), ...relative.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

// Two Units: a checkout service and the storefront page that calls it.
function project(): string {
  const proj = createTestProject();
  projects.push(proj);
  mkdirSync(join(seededStateFile(proj), ".."), { recursive: true });
  writeFileSync(seededStateFile(proj), "# State\n");
  write(proj, "inception/requirements-analysis/requirements.md", "# Requirements\n\n- FR1 Checkout\n- FR2 Cart page\n");
  write(proj, "inception/user-stories/stories.md", [
    "# Stories",
    "",
    "## US1.1 Pay for the cart",
    "- AC1.1.1 charges the card once",
    "",
    "## US1.2 See the cart",
    "- AC1.2.1 lists every item with its price",
    "- AC1.2.2 shows an empty state",
  ].join("\n"));
  write(proj, "inception/units-generation/unit-of-work.md", [
    "# Units",
    "",
    "| Unit ID | Directory | Purpose |",
    "|---|---|---|",
    "| U1 | checkout-service | Checkout |",
    "| U2 | cart-page | Cart page |",
  ].join("\n"));
  write(proj, "inception/units-generation/unit-of-work-dependency.md", [
    "# Dependencies",
    "",
    "```yaml",
    "units:",
    "  - name: checkout-service",
    "    kind: service",
    "    depends_on: []",
    "  - name: cart-page",
    "    kind: ui",
    "    depends_on: [checkout-service]",
    "```",
  ].join("\n"));
  write(proj, "inception/units-generation/unit-of-work-story-map.md", [
    "# Story Map",
    "",
    "| Story | Unit ID | Directory |",
    "|---|---|---|",
    "| US1.1 | U1 | checkout-service |",
    "| US1.2 | U2 | cart-page |",
  ].join("\n"));
  return proj;
}

function run(proj: string, unit: string, coverage: { id: string; status: string; target?: string }[]) {
  const file = write(proj, `construction/${unit}/functional-design/traceability.json`, JSON.stringify({
    stage: "functional-design",
    unit,
    upstream_ids: coverage.map((row) => row.id),
    coverage,
  }));
  const spawned = spawnSync(process.execPath, [SENSOR, "--stage", "functional-design", "--output-path", file], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    env: { ...process.env, AIDLC_PROJECT_DIR: proj },
  });
  return JSON.parse(spawned.stdout) as { pass: boolean; invalid_targets: string[]; orphans: string[]; reason?: string };
}

describe("t-traceability-ui-unit a UI Unit traces to its UI design, not to business rules", () => {
  test("a ui Unit with no rules.md passes when each row names the Functional Design file that covers it", () => {
    const proj = project();
    write(proj, "construction/cart-page/functional-design/functional-spec.md", "# Cart page\n");
    write(proj, "construction/cart-page/functional-design/frontend-components.md", "# Components\n");
    const out = run(proj, "cart-page", [
      { id: "AC1.2.1", status: "OK", target: "frontend-components.md" },
      { id: "AC1.2.2", status: "OK", target: "functional-spec.md" },
    ]);
    expect(out.reason).toBeUndefined();
    expect(out.invalid_targets).toEqual([]);
    expect(out.pass).toBe(true);
  });

  test("a ui Unit's row must name one of its Functional Design files, and that file must exist", () => {
    const proj = project();
    write(proj, "construction/cart-page/functional-design/functional-spec.md", "# Cart page\n");
    const out = run(proj, "cart-page", [
      { id: "AC1.2.1", status: "OK", target: "the cart list" },
      { id: "AC1.2.2", status: "OK", target: "frontend-components.md" },
      { id: "AC1.2.3", status: "OK", target: "BR1.1" },
    ]);
    expect(out.pass).toBe(false);
    expect(out.invalid_targets).toEqual([
      "AC1.2.1: target must be one of this Unit's Functional Design files, named on its own: functional-spec.md, frontend-components.md",
      "AC1.2.2: target frontend-components.md does not exist in this Unit's functional-design",
      "AC1.2.3: target must be one of this Unit's Functional Design files, named on its own: functional-spec.md, frontend-components.md",
    ]);
  });

  test("a ui Unit that already has a rules.md keeps its rows that name those rules", () => {
    const proj = project();
    write(proj, "construction/cart-page/functional-design/functional-spec.md", "# Cart page\n");
    write(proj, "construction/cart-page/functional-design/rules.md", "# Rules\n\n- BR1.1 Every item shows its price\n- BR1.2 An empty cart says so\n");
    const out = run(proj, "cart-page", [
      { id: "AC1.2.1", status: "OK", target: "BR1.1" },
      { id: "AC1.2.2", status: "OK", target: "BR1.2" },
    ]);
    expect(out.invalid_targets).toEqual([]);
    expect(out.orphans).toEqual([]);
    expect(out.pass).toBe(true);
  });

  test("a service Unit still traces to BRx.y rules in rules.md", () => {
    const proj = project();
    write(proj, "construction/checkout-service/functional-design/functional-spec.md", "# Checkout\n");
    const out = run(proj, "checkout-service", [{ id: "AC1.1.1", status: "OK", target: "functional-spec.md" }]);
    expect(out.pass).toBe(false);
    expect(out.invalid_targets).toEqual(["AC1.1.1: target must name at least one BRx.y ID"]);
    expect(out.reason).toContain("rules.md");
  });
});
